/**
 * NVIDIA Build free-tier etiquette: a per-model concurrency cap and a daily active-hours budget, shared by every bridge
 * process through <state>/nvidia-usage.json:
 *   { version: 1, days: { 'YYYY-MM-DD': { <model>: seconds } }, leases: { <leaseId>: { model, pid, startedAt, expires } } }
 * A lease is held while a request streams; its heartbeat renews it and accrues active seconds to the current UTC day.
 * Stale leases (expired, or owned by a process that no longer exists) are dropped. There are no token caps.
 *
 * Settings (bridge environment):
 *   OAI_NVIDIA_CONCURRENCY    in-flight streams per model, default 1 (1..8)
 *   OAI_NVIDIA_HOURS_PER_DAY  active hours per model per UTC day, default 16
 *   OAI_NVIDIA_ROTATE         1 = when a model is over budget, substitute the least-used NVIDIA model under budget
 *   OAI_NVIDIA_ROTATE_HOURS   per-model budget while rotating, default 9
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { usagePath, utcDay } from './usage.mjs';
import { WORKER_TYPES, workerSettings } from './workers.mjs';

export const LEASE_MS = 120_000;
const HEARTBEAT_MS = 30_000;
const DAYS_KEPT = 14;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const nvidiaUsagePath = (env = process.env) => join(dirname(usagePath(env)), 'nvidia-usage.json');

function number(raw, fallback, min, max) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
export function rotationPolicy(env = process.env) {
  const rotate = ['1', 'true', 'yes', 'on'].includes(String(env.OAI_NVIDIA_ROTATE ?? '').trim().toLowerCase());
  const hoursPerDay = number(env.OAI_NVIDIA_HOURS_PER_DAY, 16, 0.01, 24);
  const rotateHours = number(env.OAI_NVIDIA_ROTATE_HOURS, 9, 0.01, 24);
  return { concurrency: Math.round(number(env.OAI_NVIDIA_CONCURRENCY, 1, 1, 8)), hoursPerDay, rotate, rotateHours,
    budgetSeconds: Math.round((rotate ? rotateHours : hoursPerDay) * 3600) };
}
/** Rotation pool: the configured models of the NVIDIA workers that accept tools. */
export function rotationPool(env = process.env) {
  const out = [];
  for (const [name, spec] of Object.entries(WORKER_TYPES)) {
    if (spec.provider !== 'nvidia' || spec.tools === false) continue;
    const model = workerSettings(name, env).model;
    if (!out.includes(model)) out.push(model);
  }
  return out;
}

/** The NVIDIA worker whose configured model is `model` (so a rotation substitute gets its own thinking controls), or null. */
export function workerForModel(model, env = process.env) {
  for (const [name, spec] of Object.entries(WORKER_TYPES)) if (spec.provider === 'nvidia' && workerSettings(name, env).model === model) return name;
  return null;
}

// Leases this process still holds. A lease file entry with this process's pid that is NOT here was left behind by a
// release whose write failed (busy lock); it is dropped at once instead of blocking the model until it expires.
const liveLeases = new Set();
const alive = pid => { if (pid === process.pid) return true; try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
function withLock(env, fn) {
  const file = nvidiaUsagePath(env), lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + 3000;
  let fd = null;
  while (fd === null) {
    try { fd = openSync(lock, 'wx'); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) { rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error('NVIDIA usage file is busy.');
      sleepSync(10);
    }
  }
  try {
    let state;
    try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { state = null; }
    if (!state || typeof state !== 'object') state = { version: 1, days: {}, leases: {} };
    state.days ??= {}; state.leases ??= {};
    const result = fn(state);
    const keep = Object.keys(state.days).sort().slice(-DAYS_KEPT);
    state.days = Object.fromEntries(keep.map(d => [d, state.days[d]]));
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
    return result;
  } finally { try { closeSync(fd); } catch {} try { rmSync(lock, { force: true }); } catch {} }
}
function dropStale(state, now) {
  for (const [id, lease] of Object.entries(state.leases)) {
    if (!(lease.expires > now) || !alive(lease.pid) || (lease.pid === process.pid && !liveLeases.has(id))) delete state.leases[id];
  }
}
const usedSeconds = (state, model, day) => Number(state.days?.[day]?.[model] ?? 0);

/** Read-only view for health/usage. */
export function rotationSnapshot(env = process.env, now = Date.now()) {
  let state;
  try { state = JSON.parse(readFileSync(nvidiaUsagePath(env), 'utf8')); } catch { state = { days: {}, leases: {} }; }
  const day = utcDay(now), policy = rotationPolicy(env);
  const models = Object.fromEntries(rotationPool(env).map(model => [model, {
    activeSeconds: Math.round(usedSeconds(state, model, day)),
    inflight: Object.values(state.leases ?? {}).filter(l => l.model === model && l.expires > now).length,
  }]));
  return { day, policy, models };
}

/**
 * Pick the model to run for a request. Returns { model, substitutedFrom? } or throws when over budget without rotation.
 * Never substitutes outside the NVIDIA pool.
 */
export function chooseModel(model, env = process.env, now = Date.now()) {
  const policy = rotationPolicy(env);
  return withLock(env, state => {
    const day = utcDay(now);
    if (usedSeconds(state, model, day) < policy.budgetSeconds) return { model };
    const hours = (policy.budgetSeconds / 3600).toFixed(1);
    if (!policy.rotate) throw new Error(`NVIDIA model ${model} has used its ${hours} h active budget for today (UTC). Set OAI_NVIDIA_ROTATE=1 to rotate to another NVIDIA model, raise OAI_NVIDIA_HOURS_PER_DAY, or wait for the UTC rollover.`);
    const candidates = rotationPool(env).filter(m => m !== model && usedSeconds(state, m, day) < policy.budgetSeconds)
      .sort((a, b) => usedSeconds(state, a, day) - usedSeconds(state, b, day));
    if (!candidates.length) throw new Error(`Every NVIDIA model in the rotation pool has used its ${hours} h active budget for today (UTC).`);
    return { model: candidates[0], substitutedFrom: model };
  });
}

/**
 * Wait (until signal aborts) for a concurrency slot on model, then hold a lease. Returns { release(), id }.
 * release() removes the lease and accrues the remaining active seconds.
 */
export async function acquireLease(model, env = process.env, { signal, pollMs = 500, now = () => Date.now() } = {}) {
  const policy = rotationPolicy(env);
  const id = `${process.pid}-${randomBytes(4).toString('hex')}`;
  liveLeases.add(id);
  try {
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled while waiting for an NVIDIA concurrency slot.'), { name: 'AbortError' });
      const got = withLock(env, state => {
        const t = now();
        dropStale(state, t);
        const inflight = Object.values(state.leases).filter(l => l.model === model).length;
        if (inflight >= policy.concurrency) return false;
        state.leases[id] = { model, pid: process.pid, startedAt: t, accruedTo: t, expires: t + LEASE_MS };
        return true;
      });
      if (got) break;
      await pause(pollMs);
    }
  } catch (error) { liveLeases.delete(id); throw error; }
  const accrue = (drop) => withLock(env, state => {
    const t = now(), lease = state.leases[id];
    if (lease) {
      const day = utcDay(t);
      state.days[day] ??= {};
      state.days[day][model] = Number(state.days[day][model] ?? 0) + Math.max(0, (t - lease.accruedTo) / 1000);
      lease.accruedTo = t; lease.expires = t + LEASE_MS;
      if (drop) delete state.leases[id];
    }
  });
  const timer = setInterval(() => { try { accrue(false); } catch {} }, HEARTBEAT_MS);
  timer.unref?.();
  let released = false;
  return { id, model, heartbeat: () => accrue(false), release() {
    if (released) return; released = true; clearInterval(timer);
    liveLeases.delete(id); // from now on any write by this process drops the entry, even if the writes below fail
    const attempt = n => { try { accrue(true); } catch { if (n < 5) setTimeout(() => attempt(n + 1), 250 * (n + 1)).unref?.(); } };
    attempt(0);
  } };
}
