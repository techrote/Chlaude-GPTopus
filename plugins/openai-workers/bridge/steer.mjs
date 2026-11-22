/**
 * Steering: operator tips for running OpenAI workers.
 *
 * A small file store shared by the bridge (one per Claude Code session), the
 * /oai:s mod command (through the bridge) and the local config panel:
 *   <state>/steer/runs/<agentId>.json   live run registry (callsign, worker, step, ...)
 *   <state>/steer/inbox/<agentId>/*.json queued tips, removed when delivered
 *   <state>/steer/log.jsonl              sent / delivered / reply events for the console
 *   <state>/steer/counter.json           daily callsign counter
 * Tips are user-authored text delivered verbatim; nothing here grants a worker
 * any new capability. No API key ever reaches this store.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, appendFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { usagePath } from './usage.mjs';
import { redact } from './trace.mjs';

export const MAX_TIP = 8000;
export const RUN_STALE_MS = 6 * 60 * 60 * 1000;
export const PAUSE_CAP_MS = 120_000;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export const steerDir = (env = process.env) => env.OAI_STEER_DIR || join(dirname(usagePath(env)), 'steer');
const paths = env => { const root = steerDir(env); return { root, runs: join(root, 'runs'), inbox: join(root, 'inbox'), log: join(root, 'log.jsonl'), counter: join(root, 'counter.json') }; };
const safe = id => { if (!SAFE_ID.test(String(id ?? ''))) throw new Error('Invalid run id'); return String(id); };
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, file);
}

export function appendLog(record, env = process.env) {
  const p = paths(env);
  try { mkdirSync(p.root, { recursive: true }); appendFileSync(p.log, `${JSON.stringify(redact({ at: new Date().toISOString(), ...record }, env))}\n`, { mode: 0o600 }); }
  catch { /* the console log is best effort */ }
}
export function readLog(env = process.env, limit = 200) {
  try {
    const lines = readFileSync(paths(env).log, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Daily callsign: first letter of the worker + a counter, e.g. T3. */
export function nextCallsign(worker, env = process.env, now = new Date()) {
  const p = paths(env), day = new Date(now).toISOString().slice(0, 10);
  const c = readJson(p.counter, {});
  const n = c.day === day ? (c.n ?? 0) + 1 : 1;
  writeJson(p.counter, { day, n });
  return `${String(worker ?? 'W').replace(/[^a-z]/gi, '').charAt(0).toUpperCase() || 'W'}${n}`;
}

export function getRun(agentId, env = process.env) { return readJson(join(paths(env).runs, `${safe(agentId)}.json`), null); }
/** Create or update a run; assigns a callsign the first time. */
export function upsertRun(agentId, patch = {}, env = process.env) {
  const id = safe(agentId), prev = getRun(id, env);
  const now = new Date().toISOString();
  const run = { agentId: id, callsign: prev?.callsign ?? patch.callsign ?? nextCallsign(patch.worker ?? prev?.worker, env), startedAt: prev?.startedAt ?? now,
    pinned: [], ...prev, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), updatedAt: now };
  writeJson(join(paths(env).runs, `${id}.json`), run);
  return run;
}
export function listRuns(env = process.env, { now = Date.now(), includeEnded = true } = {}) {
  const dir = paths(env).runs;
  let names = [];
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return []; }
  const runs = [];
  for (const name of names) {
    const run = readJson(join(dir, name), null);
    if (!run) continue;
    if (now - Date.parse(run.updatedAt ?? 0) > RUN_STALE_MS) { try { rmSync(join(dir, name)); } catch {} continue; }
    if (!includeEnded && run.status === 'ended') continue;
    runs.push(run);
  }
  return runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/** Parse "/oai:s" arguments: [target] [!][+] [?ack ?assess ?conseq] text */
export function parseSteer(args, workers = []) {
  let rest = String(args ?? '').trim();
  const out = { target: '', text: '', hard: false, pin: false, ack: false, assess: false, conseq: false };
  const first = /^(\S+)\s*/.exec(rest)?.[1] ?? '';
  if (first === '*' || /^[A-Z]\d{1,4}$/i.test(first) || workers.includes(first)) { out.target = first; rest = rest.slice(first.length).trim(); }
  for (;;) {
    const m = /^(!|\+|\?ack\b|\?assess\b|\?conseq\b)\s*/i.exec(rest);
    if (!m) break;
    const tok = m[1].toLowerCase();
    if (tok === '!') out.hard = true; else if (tok === '+') out.pin = true; else out[tok.slice(1)] = true;
    rest = rest.slice(m[0].length);
  }
  out.text = rest.trim();
  return out;
}

/** Which live runs a target names. Empty target: the only live run. */
export function resolveTarget(target, runs) {
  const live = runs.filter(r => r.status !== 'ended');
  if (target === '*') return live;
  if (!target) return live.length === 1 ? live : [];
  const byCall = live.filter(r => r.callsign?.toLowerCase() === target.toLowerCase());
  if (byCall.length) return byCall;
  const byWorker = live.filter(r => r.worker === target);
  return byWorker.length ? [byWorker[0]] : [];
}

export function enqueueTip(agentId, tip, env = process.env) {
  const id = safe(agentId);
  const text = String(tip.text ?? '').slice(0, MAX_TIP);
  if (!text.trim()) throw new Error('Empty tip');
  const rec = { id: `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`, text, from: tip.from ?? 'operator',
    hard: !!tip.hard, pin: !!tip.pin, ack: !!tip.ack, assess: !!tip.assess, conseq: !!tip.conseq, at: new Date().toISOString() };
  writeJson(join(paths(env).inbox, id, `${rec.id}.json`), rec);
  const run = getRun(id, env);
  appendLog({ kind: 'sent', tipId: rec.id, agentId: id, callsign: run?.callsign, worker: run?.worker, text, flags: flagList(rec) }, env);
  return rec;
}
const flagList = t => ['hard', 'pin', 'ack', 'assess', 'conseq'].filter(k => t[k]);
export function pendingTips(agentId, env = process.env) {
  const dir = join(paths(env).inbox, safe(agentId));
  let names = [];
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')).sort(); } catch { return []; }
  return names.map(n => readJson(join(dir, n), null)).filter(Boolean);
}
export const hasHardTip = (agentId, env = process.env) => pendingTips(agentId, env).some(t => t.hard);
/** Remove queued tips, remember pinned ones on the run, log delivery. */
export function takeTips(agentId, step, env = process.env) {
  const id = safe(agentId), tips = pendingTips(id, env);
  if (!tips.length) return [];
  for (const t of tips) { try { rmSync(join(paths(env).inbox, id, `${t.id}.json`)); } catch {} }
  const run = getRun(id, env);
  const pins = tips.filter(t => t.pin).map(t => ({ id: t.id, text: t.text }));
  if (run && pins.length) upsertRun(id, { pinned: [...(run.pinned ?? []), ...pins].slice(-12) }, env);
  for (const t of tips) appendLog({ kind: 'delivered', tipId: t.id, agentId: id, callsign: run?.callsign, worker: run?.worker, step }, env);
  return tips;
}

const ASK = {
  ack: 'Begin your next message with one line acknowledging this operator tip.',
  assess: 'Before continuing, state in one or two sentences how you understood this operator tip.',
  conseq: 'Before continuing, state in one or two sentences how this tip changes your approach or next actions.',
};
/** The exact user message a worker receives for one tip: the operator's text, plus only the requests they switched on. */
export function tipMessage(tip) {
  const asks = ['ack', 'assess', 'conseq'].filter(k => tip[k]).map(k => ASK[k]);
  return [`[Operator steering message${tip.pin ? ', pinned for the rest of this task' : ''}]`, tip.text, ...(asks.length ? ['', ...asks] : [])].join('\n');
}
export const pinnedMessage = pins => pins.length ? `[Pinned operator instructions, still in force]\n${pins.map(p => `- ${p.text}`).join('\n')}` : '';

/** Pause settings: OAI_STEER_PAUSE_SECONDS (0 = off) after any tool in OAI_STEER_PAUSE_TOOLS (default Edit,Write,Bash). */
export function pausePolicy(env = process.env) {
  const s = Number(env.OAI_STEER_PAUSE_SECONDS);
  const ms = Number.isFinite(s) && s > 0 ? Math.min(PAUSE_CAP_MS, Math.round(s * 1000)) : 0;
  const tools = String(env.OAI_STEER_PAUSE_TOOLS ?? 'Edit,Write,Bash').split(',').map(t => t.trim()).filter(Boolean);
  return { ms, tools };
}
/** Wait up to ms for a tip to arrive; returns early when one does. */
export async function waitForTip(agentId, ms, env = process.env, signal) {
  const end = Date.now() + Math.min(PAUSE_CAP_MS, Math.max(0, ms));
  while (Date.now() < end) {
    if (signal?.aborted || pendingTips(agentId, env).length) return true;
    await new Promise(r => setTimeout(r, Math.min(250, end - Date.now())));
  }
  return pendingTips(agentId, env).length > 0;
}

/** For the panel: a cheap change stamp of the whole store. */
export function storeStamp(env = process.env) {
  const p = paths(env);
  const m = f => { try { return statSync(f).mtimeMs; } catch { return 0; } };
  let stamp = `${m(p.log)}:${m(p.runs)}`;
  try { for (const n of readdirSync(p.runs)) stamp += `:${m(join(p.runs, n))}`; } catch {}
  return stamp;
}
export const storeExists = env => existsSync(paths(env).root);
