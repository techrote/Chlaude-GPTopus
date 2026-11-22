/**
 * Owner-authorised reconciliation of the local usage ledger's unknown history.
 *
 * A v1 -> v2 ledger upgrade cannot know what the standard key spent (v1 never
 * tracked it) or what pruned free-key days cost. Rather than trusting an
 * environment variable or a stale number, the owner supplies authoritative
 * month-to-date USD (for example from the OpenAI billing dashboard) at an
 * interactive terminal, bound to a digest of the exact status the owner saw.
 *
 * What the consent gate is: a TTY check (stdin and stdout must report isTTY) plus a typed
 * phrase derived from the exact proposal. It stops piped, redirected, scripted and
 * accidental invocations and any MCP/Desktop/hook path. It is NOT authentication: a process
 * of the same user that can allocate a pseudo-terminal (winpty, script, python pty, ssh -tt, a
 * terminal tool) can read the printed phrase and type it back, and `options.io` below is a
 * test/embedding seam that accepts any object reporting isTTY. The ledger is plain unauthenticated
 * JSON, so such a process could equally edit it directly; this gate is a guard against
 * accidents and non-interactive automation, not a security boundary.
 *
 * This module is deliberately NOT part of the Desktop bundle and is imported
 * by no MCP tool: only scripts/reconcile-usage.mjs reaches it. Reconciliation
 * only ever RAISES what the guard assumes (committed = max(local, baseline +
 * local growth since reconciliation)); it never lowers a total, resets a
 * counter, or removes a pending/ambiguous reservation.
 */
import { readFileSync } from 'node:fs';
import { ledgerTransaction, monthlyLimitFromEnv, migrationSummary, committedMonthlyUsd, unreconciledMonth, preserveEvidence,
  sha256Hex, canonicalJson, utcDay, utcMonth } from './usage.mjs';

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_USD = 10_000_000;
const MAX_ENTRIES = 60;
/** A dashboard reading older than this many UTC days must be repeated, not attested. */
export const MAX_AS_OF_AGE_DAYS = 3;
export class ReconcileRefusal extends Error {
  constructor(message, code) { super(message); this.name = 'ReconcileRefusal'; this.code = code; }
}
const refuse = (code, message) => { throw new ReconcileRefusal(message, code); };

/** Strict decimal parser for owner-typed amounts: digits with an optional dot and up to six decimals. */
export function parseUsd(text) {
  if (typeof text !== 'string' || !/^\d{1,8}(\.\d{1,6})?$/.test(text)) refuse('bad-amount', `Invalid USD amount ${JSON.stringify(String(text).slice(0, 40))}; use plain digits such as 12.34.`);
  const value = Number(text);
  if (!Number.isFinite(value) || value > MAX_USD) refuse('bad-amount', 'USD amount out of range.');
  return value;
}
function normalizeEntries(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_ENTRIES) refuse('bad-entries', 'Supply between 1 and 60 month entries.');
  const seen = new Set();
  return entries.map(entry => {
    const keys = entry && typeof entry === 'object' ? Object.keys(entry).sort().join(',') : '';
    if (keys !== 'authoritativeUsd,month') refuse('bad-entries', 'Each entry must contain exactly month and authoritativeUsd.');
    if (typeof entry.month !== 'string' || !MONTH_KEY.test(entry.month)) refuse('bad-month', `Invalid month ${JSON.stringify(String(entry.month).slice(0, 20))}; use YYYY-MM.`);
    if (seen.has(entry.month)) refuse('bad-entries', `Month ${entry.month} appears more than once.`);
    seen.add(entry.month);
    const usd = entry.authoritativeUsd;
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 || usd > MAX_USD) refuse('bad-amount', 'authoritativeUsd must be a finite number between 0 and 10,000,000.');
    return { month: entry.month, authoritativeUsd: usd };
  }).sort((a, b) => a.month.localeCompare(b.month));
}
function normalizeSource(source) {
  if (typeof source !== 'string') refuse('bad-source', 'A source description is required, for example "OpenAI billing dashboard".');
  const text = source.trim();
  if (text.length < 3 || text.length > 120 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) refuse('bad-source', 'Source must be 3-120 printable characters on one line.');
  return text;
}
function normalizeAsOf(asOf, now) {
  if (typeof asOf !== 'string' || !DAY_KEY.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`)) || new Date(`${asOf}T00:00:00Z`).toISOString().slice(0, 10) !== asOf) refuse('bad-date', 'as-of must be a real UTC date YYYY-MM-DD.');
  const today = utcDay(now);
  if (asOf > today) refuse('bad-date', 'as-of cannot be in the future.');
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000;
  if (age > MAX_AS_OF_AGE_DAYS) refuse('stale-as-of', `as-of ${asOf} is ${age} days old (limit ${MAX_AS_OF_AGE_DAYS}). Read a fresh figure from the billing dashboard and use today's date: spend after the as-of date is not in a stale figure.`);
  return asOf;
}
/** The figure must have been read no earlier than the day the unknown period ended: spend between the
 * reading and that day was never tracked locally, so an older reading would silently omit it. */
export function assertAsOfCoversUnknownPeriod(status, asOf) {
  const end = status.scope.migration?.unknownPeriod?.end;
  if (typeof end === 'string' && asOf < end.slice(0, 10)) refuse('stale-as-of', `as-of ${asOf} is before the unknown period ended (${end.slice(0, 10)}); spend between your reading and then was never tracked locally. Read a fresh figure and use today's date.`);
}
/** Locally tracked spend (both keys) on UTC days strictly after `asOf` within a month: it happened after the
 * figure was read, so the figure cannot contain it. The as-of day itself is taken to be inside the figure. */
function localSpendAfter(doc, month, asOf) {
  let usd = 0;
  for (const [day, entry] of Object.entries(doc.days)) if (day > asOf && day.startsWith(`${month}-`)) usd += entry.totalEstimatedUsd;
  return Number(usd.toFixed(7));
}
/** Read-only preview for the CLI prompt: what applyReconciliation will add for a dated figure. */
export async function previewLocalSpendAfterAsOf(entries, asOf, options = {}) {
  return ledgerTransaction(doc => ({ dirty: false, value: Object.fromEntries(entries.map(e => [e.month, localSpendAfter(doc, e.month, asOf)])) }), options);
}

function monthView(doc, month) {
  const m = doc.months[month], free = m?.free, standard = m?.standard, b = doc.baselines[month] ?? null;
  const localFreeUsd = free?.estimatedUsd ?? 0, localStandardUsd = standard?.estimatedUsd ?? 0;
  return { localFreeUsd, localStandardUsd, localTotalUsd: localFreeUsd + localStandardUsd,
    freeTokens: free?.tokens ?? 0, freeRequests: free?.requests ?? 0, standardTokens: standard?.tokens ?? 0, standardRequests: standard?.requests ?? 0,
    unknownPriceRequests: (free?.unknownPriceRequests ?? 0) + (standard?.unknownPriceRequests ?? 0),
    reconciled: Boolean(b), baselineUsd: b?.baselineUsd ?? null, localAtReconciliationUsd: b?.localAtReconciliationUsd ?? null,
    committedUsd: committedMonthlyUsd(doc, month) };
}
function auditChainIntact(list) {
  let prev = null;
  for (const [i, e] of list.entries()) {
    const { hash, ...body } = e;
    if (e.seq !== i + 1 || e.prevHash !== prev || hash !== sha256Hex(canonicalJson(body))) return false;
    prev = hash;
  }
  return true;
}
/** The digest covers everything the owner is shown that bears on the decision, and nothing time-dependent. */
export function buildStatus(doc, now = new Date(), context = {}) {
  const summary = migrationSummary(doc, utcMonth(now));
  const { blockingMonth: _timeDependent, ...stable } = summary ?? {};
  const migration = summary ? stable : null, months = {};
  for (const month of migration?.affectedMonths ?? []) months[month] = monthView(doc, month);
  const scope = { ledgerVersion: doc.version, migration, months,
    auditCount: doc.reconciliations.length, auditHead: doc.reconciliations.at(-1)?.hash ?? null };
  const outstanding = Object.values(doc.pending);
  return { digest: sha256Hex(canonicalJson(scope)), scope,
    live: { currentUtcMonth: utcMonth(now), blockingNow: unreconciledMonth(doc, utcMonth(now)) !== null,
      // Display-only (never in the digest): which ledger this terminal resolved and whether a cap is configured here.
      ledgerPath: context.path ?? null, monthlyLimitUsd: context.monthlyLimitUsd ?? null,
      auditChainIntact: auditChainIntact(doc.reconciliations),
      outstandingReservations: outstanding.length, unknownPriceReservations: outstanding.filter(p => p.reservedUsd === null).length,
      unresolvedRequests: outstanding.filter(p => ['usage_unknown', 'ambiguous'].includes(p.status)).length } };
}
/** Read-only for the ledger contents; persists the v1 upgrade (and its evidence copy) so the digest is stable. */
export async function reconciliationStatus(options = {}) {
  const monthlyLimitUsd = monthlyLimitFromEnv(options.env ?? process.env);
  return ledgerTransaction((doc, meta) => ({ dirty: false, value: buildStatus(doc, options.now ?? new Date(), { path: meta?.path, monthlyLimitUsd }) }), { ...options, persistMigration: true });
}
/** Validate and canonicalise the owner-supplied figures (used by the CLI before it prompts, and again under the lock). */
export function normalizeProposal({ entries, source, asOf }, now = new Date()) {
  return { entries: normalizeEntries(entries), source: normalizeSource(source), asOf: normalizeAsOf(asOf, now) };
}
export const proposalId = (statusDigest, entries, source, asOf) => sha256Hex(canonicalJson({ statusDigest, entries, source, asOf }));
export const confirmationPhrase = id => `RECONCILE ${id.slice(0, 16)}`;

export const formatUsd = n => `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.00')}`;
export function renderStatus(status) {
  const { scope, live } = status, m = scope.migration, lines = [];
  lines.push('Local usage ledger reconciliation status', `Status digest: ${status.digest}`,
    `Ledger file: ${live.ledgerPath ?? 'unknown'} (resolved from OPENAI_WORKER_USAGE_DIR or the per-user default in THIS terminal; the bridge must use the same one)`);
  if (!m) { lines.push('No v1 ledger migration is recorded: nothing to reconcile.'); return lines.join('\n'); }
  lines.push(`Migrated from ledger v${m.from} at: ${m.migratedAt ?? 'UNKNOWN (record predates evidence preservation)'}`,
    `Unknown period: ${m.unknownPeriod.start ?? 'UNKNOWN start'}  ->  ${m.unknownPeriod.end}${m.legacyRecord ? ' (first observation, not the true migration time)' : ''}`,
    'Standard-key spend in that period was NEVER tracked locally (the local figure for it is zero by construction).',
    m.evidence ? `Original v1 ledger preserved: ${m.evidence.file} (${m.evidence.bytes} bytes, sha256 ${m.evidence.sha256})` : 'Original v1 ledger: no evidence copy exists for this legacy record.',
    `v1 pending requests at migration: ${m.v1Pending ?? 'unknown'}`, '', 'Affected months:');
  for (const [month, v] of Object.entries(scope.months)) {
    const v1 = m.v1FreeTotals?.[month];
    lines.push(`  ${month}  ${v.reconciled ? 'RECONCILED' : 'UNRECONCILED'}  local total ${formatUsd(v.localTotalUsd)} (free ${formatUsd(v.localFreeUsd)}, standard ${formatUsd(v.localStandardUsd)})` +
      `${v1 ? `; v1 free total ${formatUsd(v1.estimatedUsd)} over ${v1.requests} requests` : ''}` +
      `${v.reconciled ? `; baseline ${formatUsd(v.baselineUsd)} at local ${formatUsd(v.localAtReconciliationUsd)}; guard assumes ${formatUsd(v.committedUsd)}` : ''}` +
      `${v.unknownPriceRequests ? `; ${v.unknownPriceRequests} unknown-price requests (still block the cap)` : ''}`);
  }
  const capLine = live.monthlyLimitUsd == null
    ? `Monthly spend limit: NOT set in this terminal (OPENAI_WORKER_MONTHLY_LIMIT_USD); without it nothing is blocked on cost. Unreconciled history would ${live.blockingNow ? 'block the current month' : 'not affect the current month'} if a limit were set.`
    : `Monthly spend limit: ${formatUsd(live.monthlyLimitUsd)} (local estimate, both keys). Requests in the current month are blocked by unreconciled history: ${live.blockingNow ? 'YES' : 'no'}.`;
  lines.push('', `Current UTC month: ${live.currentUtcMonth}.`, capLine,
    `Outstanding reservations: ${live.outstandingReservations} (${live.unknownPriceReservations} unknown-price, ${live.unresolvedRequests} unresolved); reconciliation never clears these.`,
    `Reconciliations recorded: ${scope.auditCount}; audit chain ${live.auditChainIntact ? 'intact' : 'BROKEN (ledger was edited)'}.`);
  return lines.join('\n');
}

/**
 * Apply an owner reconciliation. Every precondition is re-verified under the ledger lock.
 * request: { statusDigest, entries:[{month, authoritativeUsd}], source, asOf, confirmation }
 * options: { io, env, now, beforeLedgerWrite }
 */
export async function applyReconciliation(request, options = {}) {
  const now = options.now ?? new Date(), io = options.io ?? { input: process.stdin, output: process.stdout };
  if (io?.input?.isTTY !== true || io?.output?.isTTY !== true) refuse('not-interactive', 'Reconciliation requires an interactive local terminal (stdin and stdout must be a TTY); piped, redirected and non-interactive invocations are refused.');
  if (!request || typeof request !== 'object') refuse('bad-request', 'Missing reconciliation request.');
  if (typeof request.statusDigest !== 'string' || !/^[0-9a-f]{64}$/.test(request.statusDigest)) refuse('bad-digest', 'statusDigest must be the 64-hex digest of the displayed status.');
  const { entries, source, asOf } = normalizeProposal(request, now);
  const id = proposalId(request.statusDigest, entries, source, asOf);
  if (request.confirmation !== confirmationPhrase(id)) refuse('bad-confirmation', 'Confirmation does not match the digest of this exact proposal; nothing was recorded.');
  return ledgerTransaction((doc, meta) => {
    if (doc.reconciliations.some(r => r.id === id)) return { dirty: false, value: { applied: false, alreadyApplied: true, id } };
    const status = buildStatus(doc, now);
    if (status.digest !== request.statusDigest) refuse('stale-status', 'The ledger changed since the status was displayed (new usage or another reconciliation); review the new status and repeat.');
    const affected = status.scope.migration?.affectedMonths;
    if (!affected) refuse('nothing-to-reconcile', 'No unknown historical usage is recorded for this ledger.');
    for (const e of entries) if (!affected.includes(e.month)) refuse('bad-month', `Month ${e.month} is not in the unknown scope (${affected.join(', ')}).`);
    assertAsOfCoversUnknownPeriod(status, asOf);
    const applied = entries.map(e => {
      const view = status.scope.months[e.month], prior = doc.baselines[e.month] ?? null;
      // The figure plus locally tracked spend after its as-of date, and never below what the guard already
      // assumes, so a lower or stale figure cannot reduce committed spend.
      const localAfterAsOfUsd = localSpendAfter(doc, e.month, asOf), dated = Number((e.authoritativeUsd + localAfterAsOfUsd).toFixed(7));
      const baselineUsd = Math.max(dated, view.committedUsd);
      return { month: e.month, suppliedAuthoritativeUsd: e.authoritativeUsd, localAfterAsOfUsd, appliedBaselineUsd: baselineUsd, raisedToLocalFloor: baselineUsd > dated,
        localFreeUsd: view.localFreeUsd, localStandardUsd: view.localStandardUsd, localTotalUsd: view.localTotalUsd,
        priorBaselineUsd: prior?.baselineUsd ?? null };
    });
    // 1. Evidence: exact copy of the ledger being superseded, durable before the replacement.
    const raw = readFileSync(meta.path);
    preserveEvidence(meta.path, `free-usage-ledger.pre-reconcile-${sha256Hex(raw).slice(0, 32)}.json`, raw);
    options.beforeLedgerWrite?.('pre-reconcile-evidence-preserved');
    // 2. One atomic ledger replacement: baselines and the append-only audit record together.
    const prev = doc.reconciliations.at(-1)?.hash ?? null;
    const body = { id, seq: doc.reconciliations.length + 1, at: new Date(now).toISOString(), asOf, decision: 'reconciled', attestedBy: 'tty-session-unverified',
      source, scope: { months: entries.map(e => e.month), keys: 'free+standard' }, statusDigest: status.digest, entries: applied,
      preReconcileEvidence: `free-usage-ledger.pre-reconcile-${sha256Hex(raw).slice(0, 32)}.json`, prevHash: prev };
    doc.reconciliations.push({ ...body, hash: sha256Hex(canonicalJson(body)) });
    for (const a of applied) doc.baselines[a.month] = { baselineUsd: a.appliedBaselineUsd, localAtReconciliationUsd: a.localTotalUsd, reconciliationId: id, at: body.at };
    return { dirty: true, value: { applied: true, alreadyApplied: false, id, entries: applied } };
  }, { ...options, persistMigration: true });
}
