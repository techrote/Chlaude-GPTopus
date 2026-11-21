/**
 * Cross-session, cross-process best-effort accounting for the dedicated FREE API key.
 *
 * These are LOCAL guardrails, not OpenAI's authoritative complimentary-token
 * counter. Only daily-astrafree and daily-terrafree calls using the free
 * key are counted here. The straight API key is never included. Requests
 * made from other clients and changes to eligibility are not visible.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Models documented by OpenAI as eligible for its two *shared* daily groups.
// Do not include gpt-6.2-sol/astra, which are absent from these lists.
const PREMIUM_MODELS = new Set([
  'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
  'gpt-5.6-sol', 'gpt-5.5-2026-04-23', 'gpt-5.4-2026-03-05',
  'gpt-5.2-2025-12-11', 'gpt-5.1-2025-11-13', 'gpt-5.1-codex',
  'gpt-5-codex', 'gpt-5-2025-08-07', 'gpt-5-chat-latest',
  'gpt-4.1-2025-04-14', 'gpt-4o-2024-05-13', 'gpt-4o-2024-08-06',
  'gpt-4o-2024-11-20', 'o3-2025-04-16', 'o1-2024-12-17',
]);
const TERRA_MODELS = new Set([
  'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-mini-2026-03-17',
  'gpt-5.4-nano-2026-03-17', 'gpt-5.1-codex-mini',
  'gpt-5-mini-2025-08-07', 'gpt-5-nano-2025-08-07',
  'gpt-4.1-mini-2025-04-14', 'gpt-4.1-nano-2025-04-14',
  'gpt-4o-mini-2024-07-18', 'o4-mini-2025-04-16',
  'o1-mini-2024-09-12', 'codex-mini-latest',
]);

const DEFAULT_LIMITS = Object.freeze({ premium: 250_000, terra: 2_500_000 });
const DAILY_GUARDED_AGENTS = Object.freeze({ 'daily-astrafree': 'premium', 'daily-terrafree': 'terra' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const utcDay = (instant = new Date()) => new Date(instant).toISOString().slice(0, 10);
export const utcMonth = (instant = new Date()) => utcDay(instant).slice(0, 7);

export function groupForModel(model) {
  if (PREMIUM_MODELS.has(model)) return 'premium';
  if (TERRA_MODELS.has(model)) return 'terra';
  return null;
}

function positiveInteger(raw, fallback, maximum = 100_000_000) {
  const n = Number(raw);
  return raw !== undefined && raw !== null && String(raw).trim() !== '' && Number.isInteger(n) && n >= 0 && n <= maximum ? n : fallback;
}

export function settings(env = process.env) {
  const overrunPercent = positiveInteger(env.OPENAI_WORKER_DAILY_OVERRUN_PERCENT, 10, 100);
  const reserveTokens = positiveInteger(env.OPENAI_WORKER_DAILY_RESERVE_TOKENS, 12_000, 100_000);
  const maxInflight = positiveInteger(env.OPENAI_WORKER_DAILY_MAX_INFLIGHT, 16, 128);
  const premium = positiveInteger(env.OPENAI_WORKER_PREMIUM_DAILY_TOKENS, DEFAULT_LIMITS.premium, 100_000_000);
  const terra = positiveInteger(env.OPENAI_WORKER_TERRA_DAILY_TOKENS, DEFAULT_LIMITS.terra, 100_000_000);
  const allowanceRaw = Number(env.OPENAI_WORKER_MONTHLY_ALLOWANCE_USD);
  return {
    limits: { premium, terra }, overrunPercent, reserveTokens, maxInflight,
    monthlyAllowanceUsd: env.OPENAI_WORKER_MONTHLY_ALLOWANCE_USD?.trim() && Number.isFinite(allowanceRaw) && allowanceRaw > 0 ? allowanceRaw : null,
  };
}

export function usagePath(env = process.env) {
  const base = env.OPENAI_WORKER_USAGE_DIR || (process.platform === 'win32'
    ? join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ClaudeOpenAIWorkers')
    : join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'claude-openai-workers'));
  return join(base, 'free-usage-ledger.json');
}

function blankLedger() { return { version: 1, days: {}, pending: {}, processed: {} }; }
function loadLedger(path) {
  if (!existsSync(path)) return blankLedger();
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Token usage ledger is unreadable at ${path}. Repair it manually; accounting cannot safely reset itself.`); }
  if (doc?.version !== 1 || !doc.days || !doc.pending || !doc.processed || Array.isArray(doc.pending)) {
    throw new Error('Unsupported or invalid token usage ledger; refusing to reset prior daily totals.');
  }
  return doc;
}
function saveLedger(path, doc) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}
function prune(doc, day) {
  const cutoff = new Date(`${day}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 14);
  const earliest = utcDay(cutoff);
  for (const key of Object.keys(doc.days)) if (key < earliest) delete doc.days[key];
  for (const [id, key] of Object.entries(doc.processed)) if (key < earliest) delete doc.processed[id];
  // Only prune pending entries older than retention; recent unknown responses
  // retain their conservative reservations for manual inspection.
  for (const [ticket, item] of Object.entries(doc.pending)) {
    if (item.day < earliest) delete doc.pending[ticket];
  }
}
async function withLedger(fn, options = {}) {
  const env = options.env ?? process.env;
  const path = options.path ?? usagePath(env);
  const lockDir = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let locked = false;
  for (let tries = 0; tries < 120; ++tries) {
    try { mkdirSync(lockDir); locked = true; break; }
    catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      // Recover from abrupt process exit while holding a very short file lock.
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 30_000) rmSync(lockDir, { recursive: true, force: true });
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await delay(25);
    }
  }
  if (!locked) throw new Error('Token usage ledger is busy; try again.');
  try {
    const doc = loadLedger(path);
    const result = fn(doc);
    if (result?.dirty) {
      prune(doc, utcDay(options.now ?? new Date()));
      saveLedger(path, doc);
    }
    return result?.value;
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function dayStats(doc, day, group) {
  return doc.days[day]?.groups?.[group] ?? { tokens: 0, estimatedUsd: 0, requests: 0 };
}
function pendingFor(doc, day, group) {
  return Object.values(doc.pending).filter(p => p.day === day && p.group === group);
}
function finiteNonnegative(value) { return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0; }

export async function reserveRequest({ workerType, model }, options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const cfg = settings(env);
  const quotaGroup = DAILY_GUARDED_AGENTS[workerType];
  if (!quotaGroup) throw new Error('The free-key daily ledger only accepts daily-astrafree and daily-terrafree.');
  const group = groupForModel(model);
  const day = utcDay(now);
  if (quotaGroup !== group) {
    throw new Error(`${workerType} requires a model in the ${quotaGroup} complimentary-token group; got ${model}.`);
  }
  return withLedger(doc => {
    const used = dayStats(doc, day, group).tokens;
    const pending = pendingFor(doc, day, group);
    const reserved = pending.reduce((sum, p) => sum + (p.reservedTokens ?? 0), 0);
    const limit = Math.floor(cfg.limits[group] * (1 + cfg.overrunPercent / 100));
    if (used + reserved >= limit || pending.length >= cfg.maxInflight) {
      throw new Error(`UTC ${day}: ${workerType} paused at its soft daily allowance: ` +
        `${used.toLocaleString('en-US')} used + ${reserved.toLocaleString('en-US')} reserved / ` +
        `${limit.toLocaleString('en-US')} tokens (${cfg.overrunPercent}% headroom). ` +
        'This local free-key group allowance resets at 00:00 UTC.');
    }
    const ticket = randomUUID();
    doc.pending[ticket] = {
      workerType: workerType || 'unattributed', model, group, day, createdAt: new Date(now).toISOString(),
      reservedTokens: cfg.reserveTokens, responseId: null,
    };
    return { dirty: true, value: ticket };
  }, options);
}

export async function releaseRequest(ticket, options = {}) {
  return withLedger(doc => {
    if (doc.pending[ticket]) { delete doc.pending[ticket]; return { dirty: true, value: true }; }
    return { dirty: false, value: false };
  }, options);
}

function completed(status) { return ['completed', 'failed', 'cancelled', 'incomplete'].includes(status); }
function settle(doc, ticket, response) {
  const pending = doc.pending[ticket];
  if (!pending) return false;
  const id = response?.id;
  if (typeof id !== 'string' || !id.startsWith('resp_')) throw new Error('OpenAI response has no verifiable ID for accounting.');
  if (!completed(response.status)) {
    pending.responseId = id;
    return true;
  }
  if (!doc.processed[id]) {
    const input = finiteNonnegative(response?.usage?.input);
    const output = finiteNonnegative(response?.usage?.output);
    // Completed responses normally include usage. If missing, conservatively
    // charge the reserved estimate instead of mistakenly recording zero.
    const measured = finiteNonnegative(response?.usage?.total) || input + output;
    const total = measured || (response?.usage ? 0 : pending.reservedTokens);
    const usd = finiteNonnegative(response?.estimatedUsd);
    const day = doc.days[pending.day] ??= { groups: {}, workers: {}, totalEstimatedUsd: 0 };
    const stats = day.groups[pending.group ?? 'other'] ??= { tokens: 0, estimatedUsd: 0, requests: 0 };
    const agent = day.workers[pending.workerType] ??= { tokens: 0, estimatedUsd: 0, requests: 0 };
    stats.tokens += total;
    stats.estimatedUsd += usd;
    stats.requests++;
    agent.tokens += total;
    agent.estimatedUsd += usd;
    agent.requests++;
    day.totalEstimatedUsd += usd;
    doc.processed[id] = pending.day;
  }
  delete doc.pending[ticket];
  return true;
}

/** Attach/update a response; idempotent across polling, retries and process restarts. */
export async function accountResponse(ticket, response, options = {}) {
  return withLedger(doc => ({ dirty: settle(doc, ticket, response), value: true }), options);
}

/** Record an already-registered response by ID, e.g. on poll after a restart. */
export async function accountByResponseId(response, options = {}) {
  return withLedger(doc => {
    const entry = Object.entries(doc.pending).find(([, p]) => p.responseId === response?.id);
    if (!entry) return { dirty: false, value: false };
    return { dirty: settle(doc, entry[0], response), value: true };
  }, options);
}

/** Snapshot includes *reserved* tokens from concurrent workers, not just completed calls. */
export async function usageSnapshot(options = {}) {
  const cfg = settings(options.env ?? process.env);
  const now = options.now ?? new Date();
  const today = utcDay(now);
  const month = utcMonth(now);
  return withLedger(doc => {
    const groups = {};
    for (const group of ['premium', 'terra']) {
      const used = dayStats(doc, today, group);
      const pending = pendingFor(doc, today, group);
      const reserved = pending.reduce((sum, p) => sum + (p.reservedTokens || 0), 0);
      const nominal = cfg.limits[group];
      groups[group] = {
        usedTokens: used.tokens, reservedTokens: reserved, pendingRequests: pending.length,
        dailyTargetTokens: nominal, softLimitTokens: Math.floor(nominal * (1 + cfg.overrunPercent / 100)),
        remainingToSoftLimit: Math.max(0, Math.floor(nominal * (1 + cfg.overrunPercent / 100)) - used.tokens - reserved),
      };
    }
    const monthlyEstimatedUsd = Object.entries(doc.days).filter(([key]) => key.startsWith(month))
      .reduce((sum, [, d]) => sum + finiteNonnegative(d.totalEstimatedUsd), 0);
    return { dirty: false, value: {
      utcDay: today, resetAtUtc: `${utcDay(new Date(new Date(`${today}T00:00:00Z`).getTime() + 86400000))}T00:00:00Z`,
      groups, overrunPercent: cfg.overrunPercent, monthlyEstimatedUsd: Number(monthlyEstimatedUsd.toFixed(5)),
      monthlyAllowanceUsd: cfg.monthlyAllowanceUsd,
      pendingResponseIds: Object.values(doc.pending).filter(p => Boolean(p.responseId)).map(p => p.responseId).slice(0, 50),
      reminder: 'Local free-key workers only. Calls using the straight API key and other clients are not counted. Complimentary eligibility and actual billing require verification in the OpenAI dashboard.',
    } };
  }, options);
}
