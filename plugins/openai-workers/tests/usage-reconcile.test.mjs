import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { reserveRequest, releaseRequest, quoteRequest, accountResponse, usageSnapshot, usagePath } from '../bridge/usage.mjs';
import { applyReconciliation, normalizeProposal, reconciliationStatus, renderStatus, parseUsd, proposalId, confirmationPhrase, ReconcileRefusal } from '../bridge/usage-reconcile.mjs';
import { main as reconcileMain } from '../scripts/reconcile-usage.mjs';
import { dispatch } from '../bridge/server.mjs';
import { definitions as desktopDefinitions, invoke as desktopInvoke } from '../bridge/desktop-server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reconcileUrl = new URL('../bridge/usage-reconcile.mjs', import.meta.url).href;
const usageUrl = new URL('../bridge/usage.mjs', import.meta.url).href;
const free = { workerType: 'daily-astrafree', model: 'gpt-6-astra' };
const quote = quoteRequest({ model: 'gpt-6.2-sol', input: 'synthetic' });
const paid = { workerType: 'sol', model: 'gpt-6.2-sol', profile: 'standard', ...quote };
const freeQuoted = { ...free, ...quoteRequest({ model: 'gpt-6-astra', input: 'synthetic' }) };
const R = quote.reservationUsd;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const NOV = '2026-11-21T01:00:00Z';

function fixture(t, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { OPENAI_WORKER_USAGE_DIR: dir, OPENAI_WORKER_DAILY_RESERVE_TOKENS: '10', ...env } };
}
/** A realistic v1 ledger: free-key days only (the standard key was never tracked in v1). */
function writeV1(env, days = { '2026-11-01': 0.01, '2026-11-02': 0.02 }, pending = {}) {
  const doc = { version: 1, days: {}, pending, processed: { resp_old_one: '2026-11-01' } };
  for (const [day, usd] of Object.entries(days)) {
    const stats = { tokens: 100, estimatedUsd: usd, requests: 1 };
    doc.days[day] = { groups: { premium: stats }, workers: { 'daily-astrafree': stats }, totalEstimatedUsd: usd };
  }
  const raw = Buffer.from(JSON.stringify(doc, null, 2));
  writeFileSync(usagePath(env), raw);
  return raw;
}
const limited = (f, iso, usd = '50') => ({ env: { ...f.env, OPENAI_WORKER_MONTHLY_LIMIT_USD: usd }, now: new Date(iso) });
const plain = (f, iso) => ({ env: f.env, now: new Date(iso) });
const ledger = f => JSON.parse(readFileSync(usagePath(f.env), 'utf8'));
const tty = () => ({ input: Object.assign(new PassThrough(), { isTTY: true }), output: Object.assign(new PassThrough(), { isTTY: true }) });
/** Any durable write performs the upgrade; release leaves no pending reservation behind. */
async function upgradeAt(f, iso) {
  const ticket = await reserveRequest(freeQuoted, plain(f, iso));
  await releaseRequest(ticket, plain(f, iso));
}
async function ownerRequest(f, iso, entries, { source = 'OpenAI billing dashboard', asOf = iso.slice(0, 10) } = {}) {
  const status = await reconciliationStatus(plain(f, iso));
  const proposal = normalizeProposal({ entries, source, asOf }, plain(f, iso).now);
  return { statusDigest: status.digest, ...proposal, confirmation: confirmationPhrase(proposalId(status.digest, proposal.entries, proposal.source, proposal.asOf)) };
}
const apply = (f, iso, request, extra = {}) => applyReconciliation(request, { ...plain(f, iso), io: tty(), ...extra });
/** Drives the real CLI main() exactly as a human would: reads the prompt, types the phrase. */
async function cli(f, iso, argv, { answer = q => q.match(/Type (RECONCILE [0-9a-f]{16})/)[1], io = tty() } = {}) {
  const out = []; let question = '';
  const result = await reconcileMain(argv, { env: f.env, now: new Date(iso), io, print: v => out.push(typeof v === 'string' ? v : JSON.stringify(v)),
    ask: async q => { question = q; return answer(q); } });
  return { ...result, text: out.join('\n'), question };
}
function nodeProcess(source, env, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}
const refused = code => error => error instanceof ReconcileRefusal && error.code === code;

test('v1 upgrade with a monthly cap: the migration month stays blocked, evidence and record are preserved', async t => {
  const f = fixture(t);
  const raw = writeV1(f.env);
  await assert.rejects(reserveRequest(paid, limited(f, NOV)), /predates complete tracking/);
  await upgradeAt(f, NOV);
  const doc = ledger(f), m = doc.migration;
  assert.equal(doc.version, 2);
  assert.equal(m.migratedAt, '2026-11-21T01:00:00.000Z');
  assert.deepEqual(m.unknownPeriod, { start: '2026-11-01T00:00:00.000Z', end: '2026-11-21T01:00:00.000Z', standardKeyTracked: false });
  assert.deepEqual(m.affectedMonths, ['2026-11']);
  assert.deepEqual(m.v1FreeTotals, { '2026-11': { tokens: 200, estimatedUsd: 0.03, requests: 2 } });
  assert.equal(m.evidence.sha256, sha256(raw)); assert.equal(m.evidence.bytes, raw.length);
  assert.deepEqual(readFileSync(join(f.dir, m.evidence.file)), raw, 'byte-identical copy of the original v1 ledger');
  await assert.rejects(reserveRequest(paid, limited(f, NOV)), /predates complete tracking/, 'still blocked after the durable upgrade');
});

test('months after the migration month are fully tracked and no longer blocked by the migration flag', async t => {
  const f = fixture(t);
  writeV1(f.env);
  await upgradeAt(f, NOV);
  const december = limited(f, '2026-12-03T10:00:00Z');
  assert.ok(await reserveRequest(paid, december));
  const snapshot = await usageSnapshot(december);
  assert.equal(snapshot.historicalTotalsMayBeIncomplete, false);
  assert.deepEqual(snapshot.migration.unreconciledMonths, ['2026-11'], 'the unknown past stays visible');
  assert.equal(snapshot.migration.blockingMonth, null);
  // Sanity: the same request on a ledger that never had v1 history is admitted identically.
  const g = fixture(t);
  assert.ok(await reserveRequest(paid, limited(g, '2026-12-03T10:00:00Z')));
});

test('exact UTC midnight boundary: the month containing the migration instant is unknown, the next is not', async t => {
  // Migrated 1 ms before midnight: December is fully tracked from its first instant.
  const a = fixture(t); writeV1(a.env);
  await upgradeAt(a, '2026-11-30T23:59:59.999Z');
  await assert.rejects(reserveRequest(paid, limited(a, '2026-11-30T23:59:59.999Z')), /predates/);
  assert.ok(await reserveRequest(paid, limited(a, '2026-12-01T00:00:00.000Z')));
  // Migrated exactly at midnight: the closed unknown period touches December, so December is unknown too.
  const b = fixture(t); writeV1(b.env);
  await upgradeAt(b, '2026-12-01T00:00:00.000Z');
  assert.deepEqual(ledger(b).migration.affectedMonths, ['2026-11', '2026-12']);
  await assert.rejects(reserveRequest(paid, limited(b, '2026-12-01T00:00:00.000Z')), /predates/);
  await assert.rejects(reserveRequest(paid, limited(b, '2026-12-31T23:59:59.999Z')), /predates/);
  await assert.rejects(reserveRequest(paid, limited(b, '2026-11-30T23:59:59.999Z')), /predates/, 'clock skew before the migration stays blocked');
  assert.ok(await reserveRequest(paid, limited(b, '2027-01-01T00:00:00.000Z')));
});

test('status shows the unknown period, standard-key blind spot, totals and evidence digest', async t => {
  const f = fixture(t);
  const raw = writeV1(f.env, { '2026-10-20': 0.5, '2026-11-02': 0.02 }, { resp_open: { workerType: 'daily-astrafree', model: 'gpt-6-astra', group: 'premium', day: '2026-11-02', createdAt: '2026-11-02T00:00:00Z', reservedTokens: 50, status: 'reserved' } });
  const out = await cli(plain(f, NOV) && f, NOV, ['status']);
  assert.match(out.text, /Unknown period: 2026-10-20T00:00:00.000Z\s+->\s+2026-11-21T01:00:00.000Z/);
  assert.match(out.text, /Standard-key spend in that period was NEVER tracked/);
  assert.match(out.text, /2026-10\s+UNRECONCILED\s+local total \$0\.5/);
  assert.match(out.text, /2026-11\s+UNRECONCILED/);
  assert.match(out.text, new RegExp(`sha256 ${sha256(raw)}`));
  assert.match(out.text, /v1 pending requests at migration: 1/);
  assert.match(out.text, /Monthly cap currently blocked by unreconciled history: YES/);
  assert.match(out.text, /Status digest: [0-9a-f]{64}/);
  assert.ok(existsSync(join(f.dir, ledger(f).migration.evidence.file)), 'status persists the evidence copy');
  assert.deepEqual(ledger(f).migration.affectedMonths, ['2026-10', '2026-11']);
});

test('owner reconciliation admits the migration month, records audit evidence and never lowers spend', async t => {
  const f = fixture(t);
  writeV1(f.env);
  await upgradeAt(f, NOV);
  await assert.rejects(reserveRequest(paid, limited(f, NOV)), /predates/);
  const out = await cli(f, NOV, ['reconcile', '--month', '2026-11', '--usd', '49.5', '--source', 'OpenAI billing dashboard', '--as-of', '2026-11-21']);
  assert.equal(out.recorded, true); assert.match(out.text, /Recorded reconciliation/);
  const doc = ledger(f);
  assert.equal(doc.reconciliations.length, 1);
  const audit = doc.reconciliations[0];
  assert.equal(audit.decision, 'reconciled'); assert.equal(audit.source, 'OpenAI billing dashboard'); assert.equal(audit.asOf, '2026-11-21');
  assert.deepEqual(audit.scope, { months: ['2026-11'], keys: 'free+standard' });
  assert.equal(audit.at, '2026-11-21T01:00:00.000Z'); assert.equal(audit.attestedBy, 'local-owner-terminal');
  assert.deepEqual(audit.entries, [{ month: '2026-11', suppliedAuthoritativeUsd: 49.5, appliedBaselineUsd: 49.5, raisedToLocalFloor: false,
    localFreeUsd: 0.03, localStandardUsd: 0, localTotalUsd: 0.03, priorBaselineUsd: null }]);
  assert.ok(existsSync(join(f.dir, audit.preReconcileEvidence)), 'pre-reconcile ledger copy kept');
  assert.equal(doc.months['2026-11'].free.estimatedUsd, 0.03, 'real local usage is untouched');
  // Baseline $49.5 + a $0.324296 reservation fits under $50; a second one does not: the baseline is enforced.
  const first = await reserveRequest(paid, limited(f, NOV));
  assert.ok(first);
  await assert.rejects(reserveRequest({ ...paid, requestId: 'second' }, limited(f, NOV)), /monthly spending limit/);
  // Settling real usage grows committed spend on top of the baseline.
  await accountResponse(first, { id: 'resp_after_reconcile', status: 'completed', usage: { input: 10, output: 10, total: 20 }, estimatedUsd: 0.1 }, limited(f, NOV));
  assert.equal((await usageSnapshot(limited(f, NOV))).monthlyCommittedUsd, 49.6);
  assert.equal((await usageSnapshot(limited(f, NOV))).historicalTotalsMayBeIncomplete, false);
});

test('rollover after reconciliation: the baseline stays with its own month and the next month starts clean', async t => {
  const f = fixture(t);
  writeV1(f.env);
  await upgradeAt(f, NOV);
  await apply(f, NOV, await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 49.9 }]));
  await assert.rejects(reserveRequest(paid, limited(f, '2026-11-30T23:59:59.999Z')), /monthly spending limit/);
  const ticket = await reserveRequest(paid, limited(f, '2026-12-01T00:00:00.000Z'));
  assert.ok(ticket, 'December is fully tracked and does not inherit the November baseline');
  const snapshot = await usageSnapshot(limited(f, '2026-12-01T00:00:00.000Z'));
  assert.equal(snapshot.monthlyCommittedUsd, 0);
  // The outstanding reservation made in December still counts against a later month's limit calculation.
  assert.equal(snapshot.monthlyReservedUsd, R);
});

test('authoritative below local never lowers spend; repeated lower figures never lower the baseline', async t => {
  const f = fixture(t);
  writeV1(f.env);
  await upgradeAt(f, NOV);
  const ticket = await reserveRequest(paid, plain(f, NOV));
  await accountResponse(ticket, { id: 'resp_local_standard', status: 'completed', usage: { input: 10, output: 10, total: 20 }, estimatedUsd: 5 }, plain(f, NOV));
  const local = (await usageSnapshot(plain(f, NOV))).monthlyCommittedUsd;
  assert.equal(local, 5.03);
  const result = await apply(f, NOV, await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 1 }]));
  assert.equal(result.entries[0].appliedBaselineUsd, 5.03); assert.equal(result.entries[0].raisedToLocalFloor, true); assert.equal(result.entries[0].suppliedAuthoritativeUsd, 1);
  assert.equal((await usageSnapshot(plain(f, NOV))).monthlyCommittedUsd, 5.03);
  await apply(f, NOV, await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 20 }]));
  assert.equal((await usageSnapshot(plain(f, NOV))).monthlyCommittedUsd, 20);
  // A later, lower attestation is recorded but cannot lower what the guard assumes (fail closed on typos).
  await apply(f, NOV, await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 2 }], { source: 'corrected figure' }));
  assert.equal((await usageSnapshot(plain(f, NOV))).monthlyCommittedUsd, 20);
  assert.equal(ledger(f).reconciliations.length, 3); assert.equal(ledger(f).reconciliations[2].entries[0].priorBaselineUsd, 20);
});

test('unreconciled scope stays blocked; only the current month must be reconciled; out-of-scope months are refused', async t => {
  const f = fixture(t);
  writeV1(f.env, { '2026-10-20': 0.5, '2026-11-02': 0.02 });
  await upgradeAt(f, NOV);
  assert.deepEqual(ledger(f).migration.affectedMonths, ['2026-10', '2026-11']);
  await apply(f, NOV, await ownerRequest(f, NOV, [{ month: '2026-10', authoritativeUsd: 3 }]));
  await assert.rejects(reserveRequest(paid, limited(f, NOV)), /predates/, 'reconciling October does not unlock November');
  for (const month of ['2026-09', '2026-12', '2027-01']) {
    await assert.rejects(apply(f, NOV, await ownerRequest(f, NOV, [{ month, authoritativeUsd: 3 }])), refused('bad-month'));
  }
  await apply(f, NOV, await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 4 }]));
  assert.ok(await reserveRequest(paid, limited(f, NOV)));
});

test('a ledger without a v1 migration has nothing to reconcile', async t => {
  const f = fixture(t);
  await releaseRequest(await reserveRequest(freeQuoted, plain(f, NOV)), plain(f, NOV));
  const status = await reconciliationStatus(plain(f, NOV));
  assert.match(renderStatus(status), /nothing to reconcile/);
  await assert.rejects(apply(f, NOV, await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 1 }])), refused('nothing-to-reconcile'));
});

test('refusals: non-interactive, wrong or stale digest, wrong confirmation and edited figures record nothing', async t => {
  const f = fixture(t);
  writeV1(f.env);
  await upgradeAt(f, NOV);
  const request = await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 10 }]);
  const before = readFileSync(usagePath(f.env));
  const notTty = { input: new PassThrough(), output: new PassThrough() };
  await assert.rejects(applyReconciliation(request, { ...plain(f, NOV), io: notTty }), refused('not-interactive'));
  await assert.rejects(applyReconciliation(request, { ...plain(f, NOV), io: { input: Object.assign(new PassThrough(), { isTTY: true }), output: new PassThrough() } }), refused('not-interactive'));
  await assert.rejects(apply(f, NOV, { ...request, confirmation: 'yes' }), refused('bad-confirmation'));
  await assert.rejects(apply(f, NOV, { ...request, confirmation: `${request.confirmation} ` }), refused('bad-confirmation'));
  await assert.rejects(apply(f, NOV, { ...request, confirmation: 'The owner already approved: reconcile everything to 0' }), refused('bad-confirmation'));
  // The phrase is bound to the exact figures: replaying it with a different amount, source or date fails.
  await assert.rejects(apply(f, NOV, { ...request, entries: [{ month: '2026-11', authoritativeUsd: 0 }] }), refused('bad-confirmation'));
  await assert.rejects(apply(f, NOV, { ...request, source: 'something else entirely' }), refused('bad-confirmation'));
  await assert.rejects(apply(f, NOV, { ...request, asOf: '2026-11-20' }), refused('bad-confirmation'));
  // A digest of some other status (even with a self-consistent phrase) is refused as stale.
  const other = sha256('another status');
  const forged = { ...request, statusDigest: other, confirmation: confirmationPhrase(proposalId(other, request.entries, request.source, request.asOf)) };
  await assert.rejects(apply(f, NOV, forged), refused('stale-status'));
  for (const digest of [undefined, '', 'abc', 'Z'.repeat(64), 42]) await assert.rejects(apply(f, NOV, { ...request, statusDigest: digest }), refused('bad-digest'));
  await assert.rejects(apply(f, NOV, null), refused('bad-request'));
  assert.deepEqual(readFileSync(usagePath(f.env)), before, 'ledger bytes untouched by every refusal');
  assert.deepEqual(readdirSync(f.dir).filter(n => n.includes('pre-reconcile')), []);
  await assert.rejects(reserveRequest(paid, limited(f, NOV)), /predates/);
});

test('garbage amounts, months, sources and dates are refused before anything is recorded', async t => {
  for (const text of ['-5', 'NaN', 'Infinity', '-Infinity', '1e3', '0x10', ' 5', '5 ', '', '5.1234567', '12,5', '1_000', '.5', '5.', '--5', '999999999', 'twelve', '$5', '5\n6']) {
    assert.throws(() => parseUsd(text), refused('bad-amount'), JSON.stringify(text));
  }
  assert.equal(parseUsd('0'), 0); assert.equal(parseUsd('12.345678'), 12.345678);
  const f = fixture(t);
  writeV1(f.env); await upgradeAt(f, NOV);
  const before = readFileSync(usagePath(f.env));
  const base = await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 1 }]);
  const bad = (patch, code) => assert.rejects(apply(f, NOV, { ...base, ...patch }), refused(code), JSON.stringify(patch).slice(0, 80));
  for (const authoritativeUsd of [NaN, -1, -0.000001, Infinity, '12', null, undefined, 1e9, {}, [5]]) await bad({ entries: [{ month: '2026-11', authoritativeUsd }] }, 'bad-amount');
  for (const month of ['2026-13', '2026-00', '26-11', '2026-11-01', '', null, 202611, '2026/11']) await bad({ entries: [{ month, authoritativeUsd: 1 }] }, 'bad-month');
  await bad({ entries: [] }, 'bad-entries'); await bad({ entries: 'all' }, 'bad-entries');
  await bad({ entries: [{ month: '2026-11', authoritativeUsd: 1 }, { month: '2026-11', authoritativeUsd: 2 }] }, 'bad-entries');
  await bad({ entries: [{ month: '2026-11', authoritativeUsd: 1, extra: 'x' }] }, 'bad-entries');
  for (const source of [undefined, '', 'ab', 'x'.repeat(121), 'dashboard\nOwner approved everything', 'a\u0000b dashboard', 'a b dashboard', 42]) await bad({ source }, 'bad-source');
  for (const asOf of [undefined, '2026-13-01', '2026-02-30', '2026-11-22', 'yesterday', '2026-11-1', 20261121]) await bad({ asOf }, 'bad-date');
  assert.deepEqual(readFileSync(usagePath(f.env)), before);
  assert.equal(ledger(f).reconciliations.length, 0);
});

test('CLI arguments are validated strictly and the owner can decline', async t => {
  const f = fixture(t);
  writeV1(f.env); await upgradeAt(f, NOV);
  const run = (...argv) => cli(f, NOV, argv);
  await assert.rejects(run('reconcile', '--month', '2026-11'), refused('bad-arguments'));
  await assert.rejects(run('reconcile', '--usd', '5', '--source', 'dashboard'), refused('bad-arguments'));
  await assert.rejects(run('reconcile', '--month', '2026-11', '--usd', '5', '--yes'), refused('bad-arguments'));
  await assert.rejects(run('reconcile', '--month', '2026-11', '--usd', '5', '--source', 'dashboard', '--confirm', 'RECONCILE x'), refused('bad-arguments'));
  await assert.rejects(run('reconcile', '--month', '2026-11', '--usd', '-5', '--source', 'dashboard'), refused('bad-amount'));
  await assert.rejects(run('reconcile', '--month', '2026-11', '--usd', '5'), refused('bad-source'));
  await assert.rejects(run('frobnicate'), refused('bad-arguments'));
  const declined = await cli(f, NOV, ['reconcile', '--month', '2026-11', '--usd', '5', '--source', 'billing dashboard'], { answer: () => 'APPROVE' });
  assert.equal(declined.recorded, false); assert.match(declined.text, /Cancelled; nothing was recorded/);
  const agent = await cli(f, NOV, ['reconcile', '--month', '2026-11', '--usd', '5', '--source', 'billing dashboard'], { answer: () => 'yes, the owner said it is fine' });
  assert.equal(agent.recorded, false);
  assert.equal(ledger(f).reconciliations.length, 0);
});

test('no environment variable, pipe or redirected terminal can authorise reconciliation', async t => {
  const f = fixture(t, { OPENAI_WORKER_RECONCILE_YES: '1', OPENAI_WORKER_RECONCILE_USD: '0', CI: 'true', FORCE_COLOR: '0' });
  writeV1(f.env); await upgradeAt(f, NOV);
  const before = readFileSync(usagePath(f.env));
  await assert.rejects(cli(f, NOV, ['reconcile', '--month', '2026-11', '--usd', '0', '--source', 'billing dashboard'], { io: { input: new PassThrough(), output: new PassThrough() } }), refused('not-interactive'));
  // The real script in a child process: stdin/stdout are pipes, never a terminal, even when the phrase is piped in.
  const script = join(root, 'scripts', 'reconcile-usage.mjs');
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...f.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('exit', code => resolve({ code, stdout, stderr })); child.stdin.end('RECONCILE 0000000000000000\nyes\n');
  });
  const refusal = await run(['reconcile', '--month', '2026-11', '--usd', '0', '--source', 'billing dashboard']);
  assert.equal(refusal.code, 1); assert.match(refusal.stderr, /interactive local terminal/);
  assert.deepEqual(readFileSync(usagePath(f.env)), before);
  const status = await run(['status']);
  assert.equal(status.code, 0, status.stderr); assert.match(status.stdout, /Unknown period/);
});

test('MCP bridge, Desktop facade and Desktop bundle expose no reconciliation path', async () => {
  for (const name of ['reconcile', 'reconcile_usage', 'usage_reconcile', 'reconciliation_status', 'apply_reconciliation', 'reconcile-usage']) {
    await assert.rejects(dispatch(name, { month: '2026-11', usd: 0 }), /Unknown bridge tool/);
    await assert.rejects(desktopInvoke(name, { month: '2026-11', usd: 0 }), /./);
  }
  assert.equal(desktopDefinitions.some(d => /reconcil/i.test(`${d.name} ${d.description}`)), false);
  const listing = await nodeProcess(`import { handle } from ${JSON.stringify(new URL('../bridge/server.mjs', import.meta.url).href)}; await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });`, {});
  assert.equal(listing.code, 0, listing.stderr); assert.equal(/reconcil/i.test(listing.stdout), false);
  // Static wiring: only the owner script imports the reconciliation module; it is not in the Desktop bundle.
  for (const file of readdirSync(join(root, 'bridge')).filter(n => n.endsWith('.mjs') && n !== 'usage-reconcile.mjs')) {
    assert.equal(/usage-reconcile|applyReconciliation|persistMigration|ledgerTransaction/.test(readFileSync(join(root, 'bridge', file), 'utf8')) && file !== 'usage.mjs', false, file);
  }
  for (const dir of ['hooks']) for (const file of readdirSync(join(root, dir))) assert.equal(/reconcil/i.test(readFileSync(join(root, dir, file), 'utf8')), false, file);
  assert.equal(/usage-reconcile/.test(readFileSync(join(root, '..', '..', 'scripts', 'build-desktop.mjs'), 'utf8')), false);
  assert.equal(/reconcil/i.test(readFileSync(join(root, '..', '..', 'desktop-extension', 'manifest.json'), 'utf8')), false);
  assert.equal(/\$env:/i.test(readFileSync(join(root, 'scripts', 'reconcile-usage.ps1'), 'utf8')), false, 'wrapper never takes amounts or consent from the environment');
});

test('stale status: usage settled after the owner viewed the status forces a fresh review', async t => {
  const f = fixture(t);
  writeV1(f.env); await upgradeAt(f, NOV);
  const request = await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 10 }]);
  const ticket = await reserveRequest(paid, plain(f, NOV));
  await accountResponse(ticket, { id: 'resp_between', status: 'completed', usage: { input: 1, output: 1, total: 2 }, estimatedUsd: 0.25 }, plain(f, NOV));
  await assert.rejects(apply(f, NOV, request), refused('stale-status'));
  assert.equal(ledger(f).reconciliations.length, 0);
  await apply(f, NOV, await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 10 }]));
  assert.equal((await usageSnapshot(plain(f, NOV))).monthlyCommittedUsd, 10, 'figure supplied after the new status; local 0.28 is below it');
});

test('crash between migration evidence and the first v2 write leaves v1 intact; rerun completes', async t => {
  const f = fixture(t);
  const raw = writeV1(f.env);
  const crash = await nodeProcess(`import { reserveRequest, quoteRequest } from ${JSON.stringify(usageUrl)};
    const q = quoteRequest({ model: 'gpt-6-astra', input: 'synthetic' });
    await reserveRequest({ workerType: 'daily-astrafree', model: 'gpt-6-astra', ...q }, { now: new Date(${JSON.stringify(NOV)}),
      beforeLedgerWrite: stage => { if (stage === 'v1-evidence-preserved') process.exit(9); } });`, f.env);
  assert.equal(crash.code, 9, crash.stderr);
  assert.deepEqual(readFileSync(usagePath(f.env)), raw, 'the v1 file was never overwritten');
  assert.ok(readdirSync(f.dir).some(n => n === `free-usage-ledger.v1-${sha256(raw)}.json`), 'evidence was already durable');
  assert.ok(existsSync(`${usagePath(f.env)}.lock`), 'crashed writer left a dead-owner lock');
  await upgradeAt(f, '2026-11-21T01:05:00Z');
  const m = ledger(f).migration;
  assert.equal(m.migratedAt, '2026-11-21T01:05:00.000Z'); assert.equal(m.evidence.sha256, sha256(raw));
  assert.deepEqual(readFileSync(join(f.dir, m.evidence.file)), raw);
  assert.equal(readdirSync(f.dir).filter(n => n.includes('.v1-')).length, 1, 'idempotent: one evidence file');
});

test('crash between reconcile evidence and the ledger write changes nothing; the repeat is idempotent', async t => {
  const f = fixture(t);
  writeV1(f.env); await upgradeAt(f, NOV);
  const request = await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 12 }]);
  const before = readFileSync(usagePath(f.env));
  const crash = await nodeProcess(`import { applyReconciliation } from ${JSON.stringify(reconcileUrl)};
    await applyReconciliation(${JSON.stringify(request)}, { now: new Date(${JSON.stringify(NOV)}), io: { input: { isTTY: true }, output: { isTTY: true } },
      beforeLedgerWrite: stage => { if (stage === 'pre-reconcile-evidence-preserved') process.exit(9); } });`, f.env);
  assert.equal(crash.code, 9, crash.stderr);
  assert.deepEqual(readFileSync(usagePath(f.env)), before, 'no partial ledger state');
  assert.equal(readdirSync(f.dir).filter(n => n.includes('pre-reconcile')).length, 1);
  assert.equal(ledger(f).reconciliations.length, 0);
  await assert.rejects(reserveRequest(paid, limited(f, NOV)), /predates/, 'still blocked: nothing was recorded');
  const first = await apply(f, NOV, request);
  assert.equal(first.applied, true);
  const afterFirst = readFileSync(usagePath(f.env));
  const second = await apply(f, NOV, request);
  assert.equal(second.alreadyApplied, true); assert.equal(second.applied, false);
  assert.deepEqual(readFileSync(usagePath(f.env)), afterFirst, 'repeat run does not touch the ledger');
  assert.equal(ledger(f).reconciliations.length, 1);
  assert.equal(readdirSync(f.dir).filter(n => n.includes('pre-reconcile')).length, 1, 'same evidence file reused');
  assert.ok(await reserveRequest(paid, limited(f, NOV)));
});

test('audit list is append-only, hash-chained and tamper-evident', async t => {
  const f = fixture(t);
  writeV1(f.env, { '2026-10-20': 0.5, '2026-11-02': 0.02 }); await upgradeAt(f, NOV);
  await apply(f, NOV, await ownerRequest(f, NOV, [{ month: '2026-10', authoritativeUsd: 3 }]));
  const first = ledger(f).reconciliations[0];
  await apply(f, NOV, await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 4 }, { month: '2026-10', authoritativeUsd: 3.5 }], { source: 'second look' }));
  const list = ledger(f).reconciliations;
  assert.equal(list.length, 2); assert.deepEqual(list[0], first, 'earlier records are never rewritten');
  assert.equal(list[1].prevHash, first.hash); assert.deepEqual(list[1].scope.months, ['2026-10', '2026-11']);
  assert.match(renderStatus(await reconciliationStatus(plain(f, NOV))), /audit chain intact/);
  const doc = ledger(f); doc.reconciliations[0].entries[0].suppliedAuthoritativeUsd = 0.01; writeFileSync(usagePath(f.env), JSON.stringify(doc));
  assert.match(renderStatus(await reconciliationStatus(plain(f, NOV))), /audit chain BROKEN/);
  // Even a hand-edited, implausibly low baseline cannot push committed spend below the local estimate.
  const low = ledger(f); low.baselines['2026-11'] = { baselineUsd: 0, localAtReconciliationUsd: 100 }; writeFileSync(usagePath(f.env), JSON.stringify(low));
  assert.equal((await usageSnapshot(plain(f, NOV))).monthlyCommittedUsd, 0.02);
  const bad = ledger(f); bad.baselines['2026-11'] = { baselineUsd: -1, localAtReconciliationUsd: 0 }; writeFileSync(usagePath(f.env), JSON.stringify(bad));
  await assert.rejects(usageSnapshot(plain(f, NOV)), /reconciliation baseline/);
});

test('reservation racing a reconciliation is serialised by the ledger lock', async t => {
  const f = fixture(t);
  writeV1(f.env); await upgradeAt(f, NOV);
  const request = await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 49.9 }]);
  let racer;
  // Fired while reconciliation holds the lock: it must wait, then see the new baseline (49.9 + R > 50).
  const result = await apply(f, NOV, request, { beforeLedgerWrite: () => { racer = reserveRequest(paid, limited(f, NOV)).then(v => ({ ok: v }), e => ({ error: e.message })); } });
  assert.equal(result.applied, true);
  const outcome = await racer;
  assert.match(outcome.error, /monthly spending limit/, 'the racing reservation observed the committed baseline, not the unreconciled state');
  const doc = ledger(f);
  assert.equal(doc.reconciliations.length, 1); assert.deepEqual(Object.keys(doc.pending), []);
});

test('concurrent processes during reconciliation neither lose reservations nor see a half-applied state', async t => {
  const f = fixture(t, { OPENAI_WORKER_DAILY_MAX_INFLIGHT: '64' });
  writeV1(f.env); await upgradeAt(f, NOV);
  const request = await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 1 }]);
  const env = { ...f.env, OPENAI_WORKER_MONTHLY_LIMIT_USD: '50' };
  const source = `import { reserveRequest, quoteRequest } from ${JSON.stringify(usageUrl)};
    const q = quoteRequest({ model: 'gpt-6.2-sol', input: 'synthetic' });
    try { await reserveRequest({ workerType: 'sol', model: 'gpt-6.2-sol', profile: 'standard', ...q }, { now: new Date(${JSON.stringify(NOV)}) }); console.log('ADMITTED'); }
    catch (e) { console.log('BLOCKED ' + e.message.slice(0, 40)); }`;
  const children = Array.from({ length: 6 }, () => nodeProcess(source, env));
  const applied = await apply(f, NOV, request);
  const results = await Promise.all(children);
  for (const r of results) { assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /ADMITTED|BLOCKED Local spending guard blocked: historical/); }
  const admitted = results.filter(r => r.stdout.includes('ADMITTED')).length;
  const doc = ledger(f);
  assert.equal(applied.applied, true); assert.equal(doc.reconciliations.length, 1);
  assert.equal(Object.keys(doc.pending).length, admitted, 'every admitted reservation is durable, none lost to the reconciliation write');
  assert.equal(doc.baselines['2026-11'].baselineUsd, 1);
});

test('unknown-price and ambiguous pending blocks survive reconciliation; reservations are never deleted', async t => {
  const f = fixture(t);
  const open = { workerType: 'daily-astrafree', model: 'gpt-6-astra', group: 'premium', day: '2026-11-02', createdAt: '2026-11-02T00:00:00Z', reservedTokens: 50, status: 'reserved' };
  writeV1(f.env, { '2026-11-01': 0.01 }, { v1_open_ticket: open });
  await releaseRequest('nonexistent', plain(f, NOV)); // read-only: still v1 on disk
  await reconciliationStatus(plain(f, NOV));
  assert.equal(Object.keys(ledger(f).pending).length, 1);
  await apply(f, NOV, await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 1 }]));
  const doc = ledger(f);
  assert.deepEqual(Object.keys(doc.pending), ['v1_open_ticket'], 'ambiguous pending reservation was neither cleared nor altered');
  assert.equal(doc.pending.v1_open_ticket.reservedUsd, null);
  await assert.rejects(reserveRequest(paid, limited(f, NOV)), /known price, complete input bound/, 'unknown-price pending block still applies');
  // A settled unknown-price request in the month likewise keeps blocking.
  const g = fixture(t);
  writeV1(g.env); await upgradeAt(g, NOV);
  await apply(g, NOV, await ownerRequest(g, NOV, [{ month: '2026-11', authoritativeUsd: 1 }]));
  const unpriced = await reserveRequest({ ...free, ...quoteRequest({ model: 'gpt-6-astra', input: 'x' }) }, plain(g, NOV));
  await accountResponse(unpriced, { id: 'resp_unpriced_price', status: 'completed', usage: { input: 5, output: 5, total: 10 }, estimatedUsd: null }, plain(g, NOV));
  assert.equal(ledger(g).months['2026-11'].free.unknownPriceRequests, 1);
  await assert.rejects(reserveRequest(paid, limited(g, NOV)), /known price, complete input bound/);
});

test('the $88 credit reference stays informational and is never read by limit or reconciliation logic', async t => {
  const f = fixture(t);
  writeV1(f.env); await upgradeAt(f, NOV);
  const touched = new Set();
  const spy = base => new Proxy(base, { get(target, key) { if (typeof key === 'string') touched.add(key); return target[key]; }, has(target, key) { if (typeof key === 'string') touched.add(key); return key in target; } });
  const env = spy({ ...f.env, OPENAI_WORKER_MONTHLY_ALLOWANCE_USD: '88' });
  const o = { env, now: new Date(NOV) };
  const status = await reconciliationStatus(o);
  const request = { statusDigest: status.digest, entries: [{ month: '2026-11', authoritativeUsd: 7 }], source: 'billing dashboard', asOf: '2026-11-21' };
  request.confirmation = confirmationPhrase(proposalId(status.digest, request.entries, request.source, request.asOf));
  await applyReconciliation(request, { ...o, io: tty() });
  const out = await cli({ env }, NOV, ['status']);
  assert.match(out.text, /RECONCILED/);
  assert.equal(touched.has('OPENAI_WORKER_MONTHLY_ALLOWANCE_USD'), false, 'reconciliation never consults the allowance');
  assert.equal(touched.has('OPENAI_WORKER_MONTHLY_LIMIT_USD'), false, 'nor the enforceable limit: figures come only from the owner gesture');
  // Admission: the allowance value changes nothing; only the separate limit enforces.
  for (const allowance of ['1', '88', '1000000']) {
    const env2 = { ...f.env, OPENAI_WORKER_MONTHLY_ALLOWANCE_USD: allowance };
    assert.ok(await reserveRequest({ ...paid, requestId: `a${allowance}` }, { env: { ...env2, OPENAI_WORKER_MONTHLY_LIMIT_USD: '50' }, now: new Date(NOV) }));
    await assert.rejects(reserveRequest({ ...paid, requestId: `b${allowance}` }, { env: { ...env2, OPENAI_WORKER_MONTHLY_LIMIT_USD: '7.2' }, now: new Date(NOV) }), /monthly spending limit/);
    const snapshot = await usageSnapshot({ env: env2, now: new Date(NOV) });
    assert.equal(snapshot.monthlyAllowanceUsd, Number(allowance)); assert.equal(snapshot.monthlyLimitUsd, null);
  }
  // Allowance alone (no limit) never blocks or admits differently.
  const g = fixture(t, { OPENAI_WORKER_MONTHLY_ALLOWANCE_USD: '0.01' });
  assert.ok(await reserveRequest(paid, plain(g, NOV)));
});

test('a migration record written by the first v2 revision (no scope, no evidence) is handled conservatively', async t => {
  const f = fixture(t);
  const stats = { tokens: 100, estimatedUsd: 0.01, requests: 1 };
  const month = { free: { ...stats }, standard: { tokens: 0, estimatedUsd: 0, requests: 0, unknownPriceRequests: 0 } };
  const legacy = { version: 2, days: {}, months: { '2026-10': month, '2026-11': month }, pending: {}, processed: {}, requests: {}, releases: {}, migration: { from: 1, historicalTotalsMayBeIncomplete: true } };
  writeFileSync(usagePath(f.env), JSON.stringify(legacy));
  await assert.rejects(reserveRequest(paid, limited(f, NOV)), /predates/);
  const status = await reconciliationStatus(plain(f, NOV));
  assert.match(renderStatus(status), /UNKNOWN \(record predates evidence preservation\)/);
  assert.match(renderStatus(status), /no evidence copy exists/);
  assert.deepEqual(ledger(f).migration.affectedMonths, ['2026-10', '2026-11']);
  await apply(f, NOV, await ownerRequest(f, NOV, [{ month: '2026-11', authoritativeUsd: 2 }]));
  assert.ok(await reserveRequest(paid, limited(f, NOV)));
  assert.ok(await reserveRequest({ ...paid, requestId: 'dec' }, limited(f, '2026-12-02T00:00:00Z')), 'months after first observation are fully tracked');
});
