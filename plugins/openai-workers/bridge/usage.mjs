/**
 * Durable, cross-process LOCAL usage estimates for the two fixed API keys.
 * Free daily groups remain separate from paid usage. Nothing here is an
 * authoritative OpenAI bill, eligibility check, or account-wide token counter.
 */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync,
  statSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { estimateUsageUsd, keyProfileForWorker } from './openai.mjs';

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
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const tokenCount = value => nonnegative(value) && Number.isSafeInteger(value);
export const utcDay = (instant = new Date()) => new Date(instant).toISOString().slice(0, 10);
export const utcMonth = (instant = new Date()) => utcDay(instant).slice(0, 7);
export function groupForModel(model) { return PREMIUM_MODELS.has(model) ? 'premium' : TERRA_MODELS.has(model) ? 'terra' : null; }

function integer(raw, fallback, minimum = 0, maximum = 100_000_000) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < minimum || n > maximum) throw new Error('Invalid usage policy integer.');
  return n;
}
function optionalDollars(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invalid local monthly spending limit.');
  return n;
}
export function settings(env = process.env) {
  const allowance = Number(env.OPENAI_WORKER_MONTHLY_ALLOWANCE_USD);
  return {
    limits: { premium: integer(env.OPENAI_WORKER_PREMIUM_DAILY_TOKENS, DEFAULT_LIMITS.premium),
      terra: integer(env.OPENAI_WORKER_TERRA_DAILY_TOKENS, DEFAULT_LIMITS.terra) },
    overrunPercent: integer(env.OPENAI_WORKER_DAILY_OVERRUN_PERCENT, 10, 0, 100),
    reserveTokens: integer(env.OPENAI_WORKER_DAILY_RESERVE_TOKENS, 12_000, 1, 10_000_000),
    maxInflight: integer(env.OPENAI_WORKER_DAILY_MAX_INFLIGHT, 16, 1, 128),
    monthlyAllowanceUsd: env.OPENAI_WORKER_MONTHLY_ALLOWANCE_USD && Number.isFinite(allowance) && allowance > 0 ? allowance : null,
    monthlyLimitUsd: optionalDollars(env.OPENAI_WORKER_MONTHLY_LIMIT_USD),
  };
}
export function usagePath(env = process.env) {
  const base = env.OPENAI_WORKER_USAGE_DIR || (process.platform === 'win32'
    ? join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ClaudeOpenAIWorkers')
    : join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'claude-openai-workers'));
  // Keep the historical filename so every interface reads the same ledger.
  return join(base, 'free-usage-ledger.json');
}
const blankStats = () => ({ tokens: 0, estimatedUsd: 0, requests: 0, unknownPriceRequests: 0 });
const blankMonth = () => ({ free: blankStats(), standard: blankStats() });
const blankLedger = () => ({ version: 2, days: {}, months: {}, pending: {}, processed: {}, requests: {}, releases: {}, reconciliations: [], baselines: {} });
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_SCOPE_MONTHS = 60;
export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
/** Stable serialisation (sorted keys) so digests do not depend on insertion order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** Contiguous UTC months first..last inclusive, newest MAX_SCOPE_MONTHS at most. */
function monthRange(first, last) {
  const out = []; let [y, m] = first.split('-').map(Number); const [ly, lm] = last.split('-').map(Number);
  while ((y < ly || (y === ly && m <= lm)) && out.length < 10_000) { out.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
  return out.slice(-MAX_SCOPE_MONTHS);
}
const v1EvidenceName = digest => `free-usage-ledger.v1-${digest}.json`;
function validateMap(value, label) {
  if (!object(value)) throw new Error(`Invalid token usage ledger ${label}; refusing to reset prior totals.`);
}
function validateStats(stats) {
  if (!object(stats) || !tokenCount(stats.tokens) || !nonnegative(stats.estimatedUsd) || !tokenCount(stats.requests)) {
    throw new Error('Invalid token usage ledger totals; refusing unsafe admission.');
  }
}
function loadLedger(path, now = new Date()) {
  if (!existsSync(path)) return { doc: blankLedger(), v1: null, legacy: false };
  let doc, raw, v1 = null;
  try { raw = readFileSync(path); doc = JSON.parse(raw.toString('utf8')); }
  catch { throw new Error(`Token usage ledger is unreadable at ${path}. Repair it manually; accounting cannot safely reset itself.`); }
  if (![1, 2].includes(doc?.version)) throw new Error('Unsupported token usage ledger version.');
  for (const key of ['days', 'pending', 'processed']) validateMap(doc[key], key);
  for (const [day, entry] of Object.entries(doc.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !object(entry) || !object(entry.groups) || !object(entry.workers) || !nonnegative(entry.totalEstimatedUsd)) {
      throw new Error('Invalid token usage ledger day record.');
    }
    for (const stats of [...Object.values(entry.groups), ...Object.values(entry.workers)]) validateStats(stats);
  }
  if (doc.version === 1) {
    // Preserve every available old entry. A v1 file may already have lost days;
    // migration cannot reconstruct those bills and makes that explicit.
    doc.version = 2; doc.months = {}; doc.requests = {}; doc.releases = {}; doc.reconciliations = []; doc.baselines = {};
    for (const [day, entry] of Object.entries(doc.days)) {
      const month = doc.months[day.slice(0, 7)] ??= blankMonth();
      month.free.estimatedUsd += entry.totalEstimatedUsd;
      for (const stats of Object.values(entry.groups)) {
        month.free.tokens += stats.tokens; month.free.requests += stats.requests;
      }
    }
    // Evidence + scope of the unknown period. v1 never tracked the standard
    // key, and its free-key history may already have been pruned, so the unknown
    // period runs from the oldest surviving v1 day to this migration instant.
    const migratedAt = new Date(now).toISOString(), migrationMonth = migratedAt.slice(0, 7);
    const dayKeys = Object.keys(doc.days).sort(), months = Object.keys(doc.months).sort();
    const earliest = dayKeys[0] ?? `${migrationMonth}-01`;
    const latest = [migrationMonth, months.at(-1) ?? migrationMonth].sort().at(-1);
    const digest = sha256Hex(raw);
    doc.migration = { from: 1, historicalTotalsMayBeIncomplete: true, migratedAt,
      evidence: { file: v1EvidenceName(digest), sha256: digest, bytes: raw.length },
      unknownPeriod: { start: `${earliest}T00:00:00.000Z`, end: migratedAt, standardKeyTracked: false },
      affectedMonths: monthRange(earliest.slice(0, 7), latest),
      v1FreeTotals: Object.fromEntries(months.map(k => [k, { tokens: doc.months[k].free.tokens, estimatedUsd: doc.months[k].free.estimatedUsd, requests: doc.months[k].free.requests }])),
      v1Pending: Object.keys(doc.pending).length, v1Processed: Object.keys(doc.processed).length };
    v1 = { raw, file: doc.migration.evidence.file };
    for (const entry of Object.values(doc.pending)) {
      Object.assign(entry, { profile: 'free', status: 'pending', reservedUsd: null, inputBoundVerified: false });
    }
    for (const [id, day] of Object.entries(doc.processed)) doc.processed[id] = { day, profile: 'free', legacy: true };
  }
  for (const key of ['months', 'requests', 'releases']) validateMap(doc[key], key);
  doc.reconciliations ??= []; doc.baselines ??= {};
  if (!Array.isArray(doc.reconciliations)) throw new Error('Invalid token usage ledger reconciliation audit list; refusing unsafe admission.');
  validateMap(doc.baselines, 'baselines');
  for (const [month, b] of Object.entries(doc.baselines)) {
    if (!MONTH_KEY.test(month) || !object(b) || !nonnegative(b.baselineUsd) || !nonnegative(b.localAtReconciliationUsd)) throw new Error('Invalid token usage ledger reconciliation baseline; refusing unsafe admission.');
  }
  for (const entry of Object.values(doc.months)) {
    validateMap(entry, 'month'); validateStats(entry.free); validateStats(entry.standard);
  }
  for (const entry of Object.values(doc.pending)) {
    if (!object(entry) || !['free', 'standard'].includes(entry.profile) || !tokenCount(entry.reservedTokens) || entry.reservedTokens < 1 ||
      (entry.reservedUsd !== null && !nonnegative(entry.reservedUsd)) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day)) {
      throw new Error('Invalid token usage reservation; refusing unsafe admission.');
    }
  }
  return { doc, v1, legacy: normalizeLegacyMigration(doc, now) };
}
/** A migration record written by the first v2 revision carries only the flag. It
 * has no evidence copy and no known migration instant, so every month already
 * present, plus the month in which it is first observed, is treated as unknown. */
function normalizeLegacyMigration(doc, now) {
  const m = doc.migration; if (!m || m.historicalTotalsMayBeIncomplete !== true || Array.isArray(m.affectedMonths)) return false;
  const observed = new Date(now).toISOString(), keys = Object.keys(doc.months).filter(k => MONTH_KEY.test(k)).sort();
  const latest = [observed.slice(0, 7), keys.at(-1) ?? observed.slice(0, 7)].sort().at(-1);
  doc.migration = { ...m, legacyRecord: true, migratedAt: null, evidence: null, v1FreeTotals: null,
    unknownPeriod: { start: null, end: observed, standardKeyTracked: false },
    affectedMonths: monthRange(keys[0] ?? observed.slice(0, 7), latest) };
  return true;
}
/** Durable write: temp file, fsync, atomic rename (used for the ledger and evidence copies). */
export function durableWrite(path, data) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(tmp, path);
    // Directory fsync is supported on POSIX; Windows provides rename durability
    // differently and does not permit opening a directory this way.
    if (process.platform !== 'win32') { const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(tmp)) rmSync(tmp, { force: true }); }
}
function saveLedger(path, doc) { durableWrite(path, JSON.stringify(doc, null, 2)); }
/** Keep an exact, content-addressed copy of bytes about to be superseded. Idempotent. */
export function preserveEvidence(path, file, bytes) {
  const target = join(dirname(path), file);
  try { if (sha256Hex(readFileSync(target)) === sha256Hex(bytes)) return target; } catch { /* absent or unreadable: rewrite below */ }
  durableWrite(target, bytes); return target;
}
function prune(doc, day) {
  const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 62);
  const oldest = utcDay(date);
  for (const key of Object.keys(doc.days)) if (key < oldest) delete doc.days[key];
  // Monthly aggregates, response tombstones, request IDs and unresolved
  // reservations are intentionally retained. Age never proves zero usage.
}
function ownerAt(path) { try { return JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')); } catch { return null; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (err) { return err.code !== 'ESRCH'; } }
function canRecover(path, owner) {
  if (owner) return owner.host === hostname() && Number.isSafeInteger(owner.pid) && !alive(owner.pid);
  try { return Date.now() - statSync(path).mtimeMs > 30_000; } catch { return false; }
}
/** Serialised, crash-safe ledger transaction. fn(doc, meta) may return { dirty, value }.
 * options.persistMigration forces a v1 upgrade (and its evidence copy) to be written;
 * options.beforeLedgerWrite(stage) is a test seam invoked after evidence is durable and
 * before the ledger is replaced. No MCP/desktop surface passes either. */
export async function ledgerTransaction(fn, options = {}) { return withLedger(fn, options); }
async function withLedger(fn, options = {}) {
  const path = options.path ?? usagePath(options.env ?? process.env);
  const lock = `${path}.lock`, reaper = `${path}.recovery`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomUUID(); let locked = false;
  for (let tries = 0; tries < 160; tries++) {
    if (!existsSync(reaper)) {
      try {
        mkdirSync(lock, { mode: 0o700 });
        writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token, pid: process.pid, host: hostname() }), { mode: 0o600 });
        locked = true; break;
      } catch (err) { if (err.code !== 'EEXIST') throw err; }
      const owner = ownerAt(lock);
      if (canRecover(lock, owner)) {
        // Serialize dead-owner reclamation. Recheck under the recovery mutex
        // so two contenders cannot delete a newly acquired live lock.
        let reaping = false;
        try {
          mkdirSync(reaper, { mode: 0o700 }); reaping = true;
          const current = ownerAt(lock);
          if (canRecover(lock, current)) rmSync(lock, { recursive: true, force: true });
        } catch (err) { if (err.code !== 'EEXIST' && err.code !== 'ENOENT') throw err; }
        finally { if (reaping) rmSync(reaper, { recursive: true, force: true }); }
      }
    }
    await delay(25);
  }
  if (!locked) throw new Error('Token usage ledger is busy or recovery was interrupted; inspect lock ownership before recovery.');
  try {
    const now = options.now ?? new Date(), { doc, v1, legacy } = loadLedger(path, now), result = fn(doc, { path, migrated: Boolean(v1), now });
    if (result?.dirty || ((v1 || legacy) && options.persistMigration)) {
      prune(doc, utcDay(now));
      // Original v1 bytes become durable BEFORE the first v2 overwrite.
      if (v1) { preserveEvidence(path, v1.file, v1.raw); options.beforeLedgerWrite?.('v1-evidence-preserved'); }
      saveLedger(path, doc);
    }
    return result?.value;
  } finally {
    if (ownerAt(lock)?.token === token) rmSync(lock, { recursive: true, force: true });
  }
}
function dayStats(doc, day, group) { return doc.days[day]?.groups?.[group] ?? blankStats(); }
function pendingFor(doc, day, group) { return Object.values(doc.pending).filter(p => p.day === day && p.group === group); }
function sumPending(items, field) { return items.reduce((n, p) => n + (p[field] ?? 0), 0); }

const localMonthUsd = month => month.free.estimatedUsd + month.standard.estimatedUsd;
/** Spend the monthly guard must assume for a month: never below the local estimate,
 * and, once the owner reconciled the month, never below the authoritative baseline
 * plus everything this ledger recorded after that reconciliation. */
export function committedMonthlyUsd(doc, monthKey) {
  const local = localMonthUsd(doc.months[monthKey] ?? blankMonth()), b = doc.baselines?.[monthKey];
  return b ? Math.max(local, b.baselineUsd + Math.max(0, local - b.localAtReconciliationUsd)) : local;
}
/** Months that predate complete tracking: the migration month and everything earlier,
 * until the owner reconciles that specific month. Later months are fully tracked. */
export function unreconciledMonth(doc, monthKey) {
  const m = doc.migration;
  if (!m || m.historicalTotalsMayBeIncomplete !== true || !Array.isArray(m.affectedMonths) || !m.affectedMonths.length) return null;
  if (monthKey > m.affectedMonths.at(-1) || doc.baselines?.[monthKey]) return null;
  return { month: monthKey, reconcilable: m.affectedMonths.includes(monthKey), migratedAt: m.migratedAt, legacyRecord: m.legacyRecord === true };
}
/** Owner-facing description of the unknown period; null when there was no v1 migration. */
export function migrationSummary(doc, monthKey) {
  const m = doc.migration; if (!m || m.historicalTotalsMayBeIncomplete !== true || !Array.isArray(m.affectedMonths)) return null;
  return { from: m.from, migratedAt: m.migratedAt, legacyRecord: m.legacyRecord === true, evidence: m.evidence, unknownPeriod: m.unknownPeriod,
    affectedMonths: m.affectedMonths, v1FreeTotals: m.v1FreeTotals, v1Pending: m.v1Pending ?? null, v1Processed: m.v1Processed ?? null,
    reconciledMonths: m.affectedMonths.filter(k => doc.baselines[k]), unreconciledMonths: m.affectedMonths.filter(k => !doc.baselines[k]),
    blockingMonth: unreconciledMonth(doc, monthKey) ? monthKey : null };
}
/** Conservative byte-count estimate for a complete new prompt; continued
 * Responses require an explicit bound including the server-side history. */
export function quoteRequest(args, options = {}) {
  const cfg = settings(options.env ?? process.env);
  const output = Math.min(32000, Math.max(1024, Number(args.max_output_tokens) || 16000));
  const supplied = args.inputTokenUpperBound;
  if (supplied !== undefined && (!tokenCount(supplied) || supplied > 100_000_000)) throw new Error('Invalid input token upper bound.');
  const bytes = Buffer.byteLength(JSON.stringify({ input: args.input ?? '', instructions: args.instructions ?? '', tools: args.tools ?? [] }), 'utf8');
  const input = supplied ?? bytes + 1024;
  const inputBoundVerified = !args.previous_response_id || supplied !== undefined;
  const reservationTokens = Math.max(cfg.reserveTokens, Math.ceil(input + output));
  // The maximum output price across requested/default service tiers is used
  // for reservations. No cache discount is assumed before evidence arrives.
  const reservationUsd = estimateUsageUsd(args.model, { input, output, cached: 0 }, 'priority');
  return { reservationTokens, reservationUsd, inputBoundVerified, inputTokens: input, outputTokens: output,
    priceStatus: reservationUsd === null ? 'unknown' : 'estimated', authoritativeBilling: false };
}

export async function reserveRequest(args, options = {}) {
  const { workerType, model } = args;
  const env = options.env ?? process.env, now = options.now ?? new Date(), cfg = settings(env);
  const expectedProfile = keyProfileForWorker(workerType);
  if (expectedProfile === 'standard' && args.profile !== 'standard') throw new Error('The free-key daily ledger only accepts daily-astrafree and daily-terrafree; paid tracking requires explicit profile: standard.');
  const profile = args.profile ?? expectedProfile;
  if (profile !== expectedProfile || !['free', 'standard'].includes(profile)) throw new Error('Worker/key profile mismatch.');
  const group = profile === 'free' ? groupForModel(model) : 'standard';
  if (profile === 'free' && DAILY_GUARDED_AGENTS[workerType] !== group) throw new Error(`${workerType} requires a model in the ${DAILY_GUARDED_AGENTS[workerType]} complimentary-token group; got ${model}.`);
  const day = utcDay(now), monthKey = day.slice(0, 7);
  const reservedTokens = args.reservationTokens ?? cfg.reserveTokens;
  if (!tokenCount(reservedTokens) || reservedTokens < cfg.reserveTokens) throw new Error('Invalid or insufficient request token reservation.');
  const fallbackUsd = estimateUsageUsd(model, { input: 0, output: reservedTokens }, args.serviceTier ?? 'priority');
  const reservedUsd = args.reservationUsd === undefined ? fallbackUsd : args.reservationUsd;
  if (reservedUsd !== null && !nonnegative(reservedUsd)) throw new Error('Invalid request dollar reservation.');
  const requestId = args.requestId;
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(requestId))) throw new Error('Invalid accounting request ID.');
  const identity = JSON.stringify({ workerType, model, profile, group, reservedTokens, reservedUsd, serviceTier: args.serviceTier ?? null });
  return withLedger(doc => {
    if (requestId && doc.requests[requestId]) {
      const old = doc.requests[requestId];
      if (old.identity !== identity) throw new Error('Accounting request ID reused for a different request.');
      // Reservation reuse is not transport replay permission. Callers must
      // reconcile pending/settled requests rather than blindly POST again.
      throw new Error(`Accounting request already reserved: ${old.ticket}; reconcile before retrying.`);
    }
    const pending = pendingFor(doc, day, group), used = dayStats(doc, day, group).tokens;
    const reserved = sumPending(pending, 'reservedTokens');
    const limit = profile === 'free' ? Math.floor(cfg.limits[group] * (1 + cfg.overrunPercent / 100)) : Infinity;
    if (used + reserved + reservedTokens > limit || Object.values(doc.pending).filter(p => p.profile === profile).length >= cfg.maxInflight) {
      throw new Error(`UTC ${day}: ${workerType} paused at its soft daily allowance: ${used} used + ${reserved} reserved + ${reservedTokens} requested / ${limit} tokens (${cfg.overrunPercent}% headroom). This local free-key group allowance resets at 00:00 UTC.`);
    }
    const month = doc.months[monthKey] ?? blankMonth();
    if (cfg.monthlyLimitUsd !== null) {
      const outstanding = Object.values(doc.pending);
      const unreconciled = unreconciledMonth(doc, monthKey);
      if (unreconciled) {
        throw new Error(`Local spending guard blocked: historical usage for UTC month ${monthKey} predates complete tracking (v1 ledger migration${unreconciled.migratedAt ? ` at ${unreconciled.migratedAt}` : ''}) and has not been reconciled by the owner. Run scripts/reconcile-usage.mjs status in a local terminal.`);
      }
      if (fallbackUsd === null || reservedUsd === null || args.inputBoundVerified !== true || outstanding.some(p => p.reservedUsd === null || p.inputBoundVerified === false) ||
        month.free.unknownPriceRequests || month.standard.unknownPriceRequests) {
        throw new Error('Local spending guard requires known price, complete input bound and reconciled historical usage; request blocked.');
      }
      const committed = committedMonthlyUsd(doc, monthKey);
      // Outstanding requests from earlier months still carry potential cost.
      if (committed + sumPending(outstanding, 'reservedUsd') + reservedUsd > cfg.monthlyLimitUsd) throw new Error('Local monthly spending limit including new and outstanding reservations would be exceeded.');
    }
    const ticket = randomUUID();
    doc.pending[ticket] = { workerType, model, profile, group, day, createdAt: new Date(now).toISOString(),
      reservedTokens, reservedUsd, inputBoundVerified: args.inputBoundVerified ?? false,
      serviceTier: args.serviceTier ?? null, responseId: null, requestId: requestId ?? null, status: 'reserved' };
    if (requestId) doc.requests[requestId] = { identity, ticket, day };
    return { dirty: true, value: ticket };
  }, options);
}

/** Release only when transport was never started or definitively rejected.
 * Never use this operation for timeout, cancellation or ambiguous 5xx results. */
export async function releaseRequest(ticket, options = {}) {
  return withLedger(doc => {
    const pending = doc.pending[ticket];
    if (!pending) return { dirty: false, value: false };
    if (pending.responseId || pending.status !== 'reserved') throw new Error('Accepted or ambiguous request cannot be released without usage reconciliation.');
    doc.releases[ticket] = { day: pending.day, reason: options.reason ?? 'caller-proved-not-started-or-rejected', requestId: pending.requestId };
    delete doc.pending[ticket]; return { dirty: true, value: true };
  }, options);
}
export async function markRequestAmbiguous(ticket, options = {}) {
  return withLedger(doc => {
    const pending = doc.pending[ticket]; if (!pending) return { dirty: false, value: false };
    pending.status = 'ambiguous'; return { dirty: true, value: true };
  }, options);
}
const completed = status => ['completed', 'failed', 'cancelled', 'incomplete'].includes(status);
function measuredUsage(response) {
  const usage = response?.usage;
  if (response?.usageStatus === 'unknown' || !object(usage) || !tokenCount(usage.input) || !tokenCount(usage.output)) return null;
  const total = usage.input + usage.output;
  if (usage.total !== undefined && (!tokenCount(usage.total) || usage.total !== total)) return null;
  if (usage.cached !== undefined && (!tokenCount(usage.cached) || usage.cached > usage.input)) return null;
  return { input: usage.input, output: usage.output, cached: usage.cached ?? 0, total };
}
function addStats(stats, tokens, usd) {
  stats.tokens += tokens; stats.requests++;
  if (usd === null) stats.unknownPriceRequests = (stats.unknownPriceRequests ?? 0) + 1;
  else stats.estimatedUsd += usd;
}
function settle(doc, ticket, response) {
  const pending = doc.pending[ticket]; if (!pending) return false;
  const id = response?.id;
  if (typeof id !== 'string' || !/^resp_[a-zA-Z0-9_-]{4,128}$/.test(id)) throw new Error('OpenAI response has no verifiable ID for accounting.');
  if (pending.responseId && pending.responseId !== id) throw new Error('Response ID does not match the reserved request.');
  if (response.model && response.model !== pending.model) throw new Error('Response model differs from the reserved model; usage requires reconciliation.');
  pending.responseId = id;
  const previous = doc.processed[id];
  if (previous) {
    if (previous.profile !== pending.profile || (!previous.legacy && (previous.model !== pending.model || previous.workerType !== pending.workerType))) throw new Error('Response ID reused across worker or key identities.');
    delete doc.pending[ticket]; return true;
  }
  if (!completed(response.status)) { pending.status = 'accepted'; return true; }
  const usage = measuredUsage(response);
  if (!usage) { pending.status = 'usage_unknown'; pending.terminalStatus = response.status; return true; }
  const calculated = estimateUsageUsd(pending.model, usage, response.serviceTier ?? pending.serviceTier);
  const usd = calculated === null || response.estimatedUsd === null ? null : nonnegative(response.estimatedUsd) ? Math.max(calculated, response.estimatedUsd) : calculated;
  const day = doc.days[pending.day] ??= { groups: {}, workers: {}, totalEstimatedUsd: 0 };
  const stats = day.groups[pending.group] ??= blankStats();
  const agent = day.workers[pending.workerType] ??= blankStats();
  const month = doc.months[pending.day.slice(0, 7)] ??= blankMonth();
  addStats(stats, usage.total, usd); addStats(agent, usage.total, usd); addStats(month[pending.profile], usage.total, usd);
  day.totalEstimatedUsd += usd ?? 0;
  doc.processed[id] = { day: pending.day, workerType: pending.workerType, model: pending.model, profile: pending.profile,
    tokens: usage.total, contextTokenUpperBound: Math.max(usage.total, pending.reservedTokens), estimatedUsd: usd, serviceTier: response.serviceTier ?? pending.serviceTier, usageStatus: 'verified' };
  delete doc.pending[ticket]; return true;
}
export async function accountResponse(ticket, response, options = {}) {
  return withLedger(doc => { const dirty = settle(doc, ticket, response); return { dirty, value: dirty }; }, options);
}
export async function accountByResponseId(response, options = {}) {
  return withLedger(doc => {
    const matches = Object.entries(doc.pending).filter(([, p]) => p.responseId === response?.id);
    if (!matches.length) return { dirty: false, value: false };
    for (const [ticket] of matches) settle(doc, ticket, response);
    return { dirty: true, value: true };
  }, options);
}
/** Resolve a response's immutable worker/key binding before polling or continuing. */
export async function responseRecord(id, options = {}) {
  if (typeof id !== 'string' || !/^resp_[a-zA-Z0-9_-]{4,128}$/.test(id)) throw new Error('Invalid response ID.');
  return withLedger(doc => {
    const pending = Object.entries(doc.pending).find(([, p]) => p.responseId === id);
    if (pending) return { dirty: false, value: { ...structuredClone(pending[1]), ticket: pending[0], settled: false,
      contextTokenUpperBound: pending[1].inputBoundVerified ? pending[1].reservedTokens : null } };
    const done = doc.processed[id];
    return { dirty: false, value: done ? { ...structuredClone(done), settled: true, status: 'settled' } : null };
  }, options);
}
export async function requestRecord(ticket, options = {}) {
  return withLedger(doc => ({ dirty: false, value: doc.pending[ticket] ? structuredClone(doc.pending[ticket]) : null }), options);
}
export async function usageSnapshot(options = {}) {
  const cfg = settings(options.env ?? process.env), now = options.now ?? new Date(), today = utcDay(now), monthKey = utcMonth(now);
  return withLedger(doc => {
    const groups = {};
    for (const group of ['premium', 'terra']) {
      const used = dayStats(doc, today, group), pending = pendingFor(doc, today, group), reserved = sumPending(pending, 'reservedTokens');
      const nominal = cfg.limits[group], limit = Math.floor(nominal * (1 + cfg.overrunPercent / 100));
      groups[group] = { usedTokens: used.tokens, reservedTokens: reserved, pendingRequests: pending.length,
        dailyTargetTokens: nominal, softLimitTokens: limit, remainingToSoftLimit: Math.max(0, limit - used.tokens - reserved) };
    }
    const month = doc.months[monthKey] ?? blankMonth(), outstanding = Object.values(doc.pending);
    const profiles = {};
    for (const profile of ['free', 'standard']) {
      const pending = outstanding.filter(p => p.profile === profile);
      profiles[profile] = { ...month[profile], reservedTokens: sumPending(pending, 'reservedTokens'), reservedUsd: sumPending(pending, 'reservedUsd'),
        pendingRequests: pending.length, unknownPriceReservations: pending.filter(p => p.reservedUsd === null).length,
        unknownUsageRequests: pending.filter(p => ['usage_unknown', 'ambiguous'].includes(p.status)).length };
    }
    const allEstimated = month.free.estimatedUsd + month.standard.estimatedUsd;
    return { dirty: false, value: {
      ledgerVersion: 2, utcDay: today, resetAtUtc: `${utcDay(new Date(new Date(`${today}T00:00:00Z`).getTime() + 86400000))}T00:00:00Z`,
      groups, profiles, overrunPercent: cfg.overrunPercent, monthlyEstimatedUsd: Number(month.free.estimatedUsd.toFixed(7)),
      allKeysMonthlyEstimatedUsd: Number(allEstimated.toFixed(7)), monthlyAllowanceUsd: cfg.monthlyAllowanceUsd,
      monthlyLimitUsd: cfg.monthlyLimitUsd, monthlyReservedUsd: sumPending(outstanding, 'reservedUsd'),
      // True only while the CURRENT UTC month's local totals are unreconciled-unknown (see migration for the full scope).
      historicalTotalsMayBeIncomplete: unreconciledMonth(doc, monthKey) !== null, migration: migrationSummary(doc, monthKey),
      monthlyCommittedUsd: Number(committedMonthlyUsd(doc, monthKey).toFixed(7)),
      pendingResponseIds: [...new Set(outstanding.filter(p => p.profile === 'free' && p.responseId).map(p => p.responseId))].slice(0, 50),
      pendingResponses: outstanding.filter(p => p.responseId).map(p => ({ id: p.responseId, profile: p.profile, workerType: p.workerType, status: p.status })).slice(0, 100),
      unresolvedRequests: outstanding.filter(p => ['usage_unknown', 'ambiguous'].includes(p.status)).map(p => ({ requestId: p.requestId, responseId: p.responseId, day: p.day, profile: p.profile, status: p.status })),
      reminder: 'Local estimates for participating clients only, never authoritative OpenAI billing. Free daily groups exclude standard-key usage. The monthly allowance reference is informational; only the separately configured monthly limit enforces admission. Reconciling unknown pre-upgrade history is an owner-only local terminal action that no worker tool can perform.',
    } };
  }, options);
}
