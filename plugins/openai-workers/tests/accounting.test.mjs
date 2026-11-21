import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { normalize, estimateUsageUsd, keyProfileForWorker, createTurn, request, mayHaveIncurredUsage } from '../bridge/openai.mjs';
import { reserveRequest, releaseRequest, markRequestAmbiguous, quoteRequest, accountResponse,
  accountByResponseId, usageSnapshot, usagePath, requestRecord } from '../bridge/usage.mjs';
import { dispatch } from '../bridge/server.mjs';
const usageUrl = new URL('../bridge/usage.mjs', import.meta.url).href;
const free = { workerType: 'daily-astrafree', model: 'gpt-6-astra' };
const paid = { workerType: 'sol', model: 'gpt-6.2-sol', profile: 'standard' };
function fixture(t, env = {}, now = '2026-11-21T01:00:00Z') {
  const dir = mkdtempSync(join(tmpdir(), 'ultra-accounting-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { env: { OPENAI_WORKER_USAGE_DIR: dir, OPENAI_WORKER_DAILY_RESERVE_TOKENS: '10', ...env }, now: new Date(now) };
}
const final = (id, tokens = 25, usd = 0.01) => ({ id, status: 'completed', usage: { input: tokens, output: 0, total: tokens }, estimatedUsd: usd });
function nodeProcess(source, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject); child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}

test('normalization never invents verified zero usage or zero unknown prices', () => {
  for (const usage of [undefined, {}, { output_tokens: 2 }, { input_tokens: -1, output_tokens: 3 },
    { input_tokens: 3, output_tokens: 2, total_tokens: 1 }, { input_tokens: 2, output_tokens: 0, input_tokens_details: { cached_tokens: 4 } }]) {
    const normalized = normalize({ id: 'resp_unknown', status: 'completed', model: 'gpt-6.2-sol', usage });
    assert.equal(normalized.usage, null); assert.equal(normalized.estimatedUsd, null); assert.equal(normalized.usageStatus, 'unknown');
  }
  const zero = normalize({ id: 'resp_zero', status: 'completed', model: 'gpt-6.2-sol', usage: { input_tokens: 0, output_tokens: 0 } });
  assert.equal(zero.usageStatus, 'verified'); assert.equal(zero.estimatedUsd, 0);
  const unknown = normalize({ id: 'resp_unknown', status: 'completed', model: 'gpt-future', usage: { input_tokens: 20, output_tokens: 5 } });
  assert.equal(unknown.usage.total, 25); assert.equal(unknown.estimatedUsd, null);
  assert.equal(estimateUsageUsd('gpt-6.2-sol', { input: 2, output: 3 }, 'unverified-tier'), null);
});

test('unknown named worker and mismatched key route fail before transport', async () => {
  assert.throws(() => keyProfileForWorker('daily-astra-free'), /Unknown worker/);
  let calls = 0;
  await assert.rejects(createTurn({ worker_type: 'daily-astrafree', model: 'gpt-6-astra', instructions: 'x', input: 'x', tools: [] },
    { profile: 'standard', key: 'test', fetchFn: async () => { calls++; } }), /key-profile mismatch/);
  assert.equal(calls, 0);
});

test('transport ambiguity covers network, malformed accepted JSON and server failure', async () => {
  for (const fetchFn of [
    async () => { throw new Error('dropped connection'); },
    async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }),
    async () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'temporarily unavailable' } }) }),
  ]) {
    await assert.rejects(request('POST', '/responses', {}, { key: 'private', fetchFn }), error => mayHaveIncurredUsage(error));
  }
  await assert.rejects(request('POST', '/responses', {}, { key: 'private', fetchFn: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'private invalid key' } }) }) }), error => {
    assert.equal(error.message.includes('private'), false); return !mayHaveIncurredUsage(error);
  });
  assert.equal(mayHaveIncurredUsage(new Error('unclassified transport failure')), true);
});

test('full month survives pruning of daily detail and dedup tombstones survive restart', async t => {
  const opts = fixture(t, {}, '2026-11-01T01:00:00Z');
  for (const [day, id] of [['2026-11-01', 'resp_month_a'], ['2026-11-20', 'resp_month_b'], ['2026-11-30', 'resp_month_c']]) {
    const at = { ...opts, now: new Date(`${day}T01:00:00Z`) };
    await accountResponse(await reserveRequest(free, at), final(id, 25, 0.5), at);
  }
  assert.equal((await usageSnapshot({ ...opts, now: new Date('2026-11-30T01:00:00Z') })).monthlyEstimatedUsd, 1.5);
  const muchLater = { ...opts, now: new Date('2027-03-01T00:00:00Z') };
  await accountResponse(await reserveRequest(free, muchLater), final('resp_month_a', 25, 0.5), muchLater);
  assert.equal((await usageSnapshot(muchLater)).monthlyEstimatedUsd, 0, 'Old response ID must not be billed twice after retention cutoff');
  const doc = JSON.parse(readFileSync(usagePath(opts.env), 'utf8'));
  assert.equal(doc.months['2026-11'].free.estimatedUsd, 1.5);
  assert.equal(doc.days['2026-11-01'], undefined, 'Only redundant daily detail is pruned');
});

test('standard accounting shares storage without consuming free daily allowances', async t => {
  const opts = fixture(t);
  await accountResponse(await reserveRequest(paid, opts), final('resp_paid_use', 100, 0.1), opts);
  await accountResponse(await reserveRequest(free, opts), final('resp_free_use', 200, 0.2), opts);
  const result = await usageSnapshot(opts);
  assert.equal(result.groups.premium.usedTokens, 200);
  assert.equal(result.profiles.standard.tokens, 100);
  assert.equal(result.monthlyEstimatedUsd, 0.2);
  assert.equal(result.allKeysMonthlyEstimatedUsd, 0.3);
  await assert.rejects(reserveRequest({ ...free, profile: 'standard' }, opts), /mismatch/);
});

test('missing terminal usage survives restart and can later reconcile exact measured usage', async t => {
  const opts = fixture(t);
  const ticket = await reserveRequest(free, opts);
  const normalized = normalize({ id: 'resp_lost_usage', model: 'gpt-6-astra', status: 'cancelled' });
  await accountResponse(ticket, normalized, opts);
  const child = await nodeProcess(`import { usageSnapshot } from ${JSON.stringify(usageUrl)}; console.log(JSON.stringify(await usageSnapshot({now:new Date('2026-11-21T01:00:00Z')})));`, opts.env);
  assert.equal(child.code, 0, child.stderr);
  const snapshot = JSON.parse(child.stdout);
  assert.equal(snapshot.groups.premium.reservedTokens, 10); assert.equal(snapshot.profiles.free.unknownUsageRequests, 1);
  await assert.rejects(releaseRequest(ticket, opts), /cannot be released/);
  await accountByResponseId(final('resp_lost_usage', 17, 0.003), opts);
  const known = await usageSnapshot(opts);
  assert.equal(known.groups.premium.reservedTokens, 0); assert.equal(known.groups.premium.usedTokens, 17);
});

test('ambiguous reservations never expire into free budget', async t => {
  const opts = fixture(t);
  const ticket = await reserveRequest(free, opts);
  await markRequestAmbiguous(ticket, opts);
  await assert.rejects(releaseRequest(ticket, opts), /cannot be released/);
  const later = { ...opts, now: new Date('2027-06-01T00:00:00Z') };
  await reserveRequest({ workerType: 'daily-terrafree', model: 'gpt-5.6-terra' }, later);
  const pending = await requestRecord(ticket, later);
  assert.equal(pending.status, 'ambiguous'); assert.equal(pending.reservedTokens, 10);
});

test('unknown prices and incomplete input bounds block configured spending guards', async t => {
  const opts = fixture(t, { OPENAI_WORKER_MONTHLY_LIMIT_USD: '5' });
  await assert.rejects(reserveRequest({ ...paid, model: 'gpt-unpriced', reservationUsd: 0 }, opts), /known price/);
  await assert.rejects(reserveRequest({ ...paid, inputBoundVerified: false }, opts), /complete input bound/);
  assert.equal(quoteRequest({ model: 'gpt-unpriced', input: 'test' }, opts).reservationUsd, null);
  const continued = quoteRequest({ model: paid.model, previous_response_id: 'resp_prev', input: 'continue' }, opts);
  assert.equal(continued.inputBoundVerified, false);
  assert.equal(quoteRequest({ model: paid.model, previous_response_id: 'resp_prev', inputTokenUpperBound: 12000 }, opts).inputBoundVerified, true);
});

test('monthly allowance is informational and a separate zero limit is enforceable', async t => {
  const opts = fixture(t, { OPENAI_WORKER_MONTHLY_ALLOWANCE_USD: '0.001' });
  await accountResponse(await reserveRequest(paid, opts), final('resp_allowance', 1000, 2), opts);
  assert.equal((await usageSnapshot(opts)).allKeysMonthlyEstimatedUsd, 2);
  await assert.rejects(reserveRequest({ ...paid, inputBoundVerified: true }, { ...opts, env: { ...opts.env, OPENAI_WORKER_MONTHLY_LIMIT_USD: '0' } }), /spending limit/);
});

test('both key profiles share a monthly ceiling including the new reservation', async t => {
  const opts = fixture(t, { OPENAI_WORKER_MONTHLY_LIMIT_USD: '0.015' });
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserveRequest({ ...(i % 2 ? free : paid), reservationUsd: 0.01, inputBoundVerified: true }, opts)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await usageSnapshot(opts)).monthlyReservedUsd, 0.01);
});

test('request ID reuse cannot create duplicate reservations or change key/model', async t => {
  const opts = fixture(t);
  const ticket = await reserveRequest({ ...paid, requestId: 'mission-1.step-1' }, opts);
  await assert.rejects(reserveRequest({ ...paid, requestId: 'mission-1.step-1' }, opts), /already reserved/);
  await assert.rejects(reserveRequest({ ...free, requestId: 'mission-1.step-1' }, opts), /different request/);
  await accountResponse(ticket, final('resp_idempotent'), opts);
  await assert.rejects(reserveRequest({ ...paid, requestId: 'mission-1.step-1' }, opts), /already reserved/);
  assert.equal((await usageSnapshot(opts)).profiles.standard.requests, 1);
});

test('duplicate response IDs never double-account or cross key identities', async t => {
  const opts = fixture(t);
  await accountResponse(await reserveRequest(free, opts), final('resp_dup_account'), opts);
  await accountResponse(await reserveRequest(free, opts), final('resp_dup_account'), opts);
  assert.equal((await usageSnapshot(opts)).groups.premium.usedTokens, 25);
  const ticket = await reserveRequest(paid, opts);
  await assert.rejects(accountResponse(ticket, final('resp_dup_account'), opts), /across worker or key/);
  assert.equal((await usageSnapshot(opts)).profiles.standard.reservedTokens, 10);
});

test('unknown response cost remains unknown and blocks later guarded admission', async t => {
  const opts = fixture(t);
  await accountResponse(await reserveRequest(paid, opts), { ...final('resp_unknown_cost'), estimatedUsd: null }, opts);
  const snapshot = await usageSnapshot(opts);
  assert.equal(snapshot.profiles.standard.unknownPriceRequests, 1);
  await assert.rejects(reserveRequest(paid, { ...opts, env: { ...opts.env, OPENAI_WORKER_MONTHLY_LIMIT_USD: '10' } }), /known price/);
});

test('model substitution and inconsistent measured counts retain reservation', async t => {
  const opts = fixture(t);
  const ticket = await reserveRequest(paid, opts);
  await assert.rejects(accountResponse(ticket, { ...final('resp_wrong_model'), model: 'gpt-6.2-astra' }, opts), /differs/);
  await accountResponse(ticket, { ...final('resp_wrong_model'), usage: { input: 10, output: 10, total: 1 } }, opts);
  assert.equal((await requestRecord(ticket, opts)).status, 'usage_unknown');
});

test('v1 migration preserves available monthly data and admits incomplete history explicitly', async t => {
  const opts = fixture(t);
  const stats = { tokens: 100, estimatedUsd: 0.01, requests: 1 };
  writeFileSync(usagePath(opts.env), JSON.stringify({ version: 1, days: { '2026-11-01': { groups: { premium: stats }, workers: { 'daily-astrafree': stats }, totalEstimatedUsd: 0.01 } }, pending: {}, processed: { resp_migrated: '2026-11-01' } }));
  const snapshot = await usageSnapshot(opts);
  assert.equal(snapshot.monthlyEstimatedUsd, 0.01); assert.equal(snapshot.historicalTotalsMayBeIncomplete, true);
  await assert.rejects(reserveRequest(paid, { ...opts, env: { ...opts.env, OPENAI_WORKER_MONTHLY_LIMIT_USD: '10' } }), /historical usage/);
  await reserveRequest(free, opts);
  assert.equal(JSON.parse(readFileSync(usagePath(opts.env), 'utf8')).version, 2);
});

test('multi-process admission is atomic and cannot over-reserve a daily group', async t => {
  const opts = fixture(t, { OPENAI_WORKER_PREMIUM_DAILY_TOKENS: '100', OPENAI_WORKER_DAILY_OVERRUN_PERCENT: '0', OPENAI_WORKER_DAILY_RESERVE_TOKENS: '40' });
  const source = `import { reserveRequest } from ${JSON.stringify(usageUrl)}; try { console.log(await reserveRequest(${JSON.stringify(free)}, {now:new Date('2026-11-21T01:00:00Z')})); } catch(e) { console.log('BLOCKED'); }`;
  const children = await Promise.all(Array.from({ length: 10 }, () => nodeProcess(source, opts.env)));
  for (const result of children) assert.equal(result.code, 0, result.stderr);
  assert.equal(children.filter(x => !x.stdout.includes('BLOCKED')).length, 2);
  assert.equal((await usageSnapshot(opts)).groups.premium.reservedTokens, 80);
});

test('dead process lock is recovered but elapsed time never steals a live owner lock', async t => {
  const opts = fixture(t);
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(dead.status, 0);
  const lock = `${usagePath(opts.env)}.lock`;
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'dead-owner', pid: dead.pid, host: hostname() }));
  const ticket = await reserveRequest(free, opts);
  assert.ok(ticket);
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token: 'live-owner', pid: process.pid, host: hostname() }));
  utimesSync(lock, new Date(0), new Date(0));
  const pending = reserveRequest(free, opts);
  // Release the synthetic live lock while acquisition is waiting. Success
  // before this removal would demonstrate unsafe time-based lock stealing.
  const early = await Promise.race([pending.then(() => 'acquired'), new Promise(resolve => setTimeout(() => resolve('blocked'), 100))]);
  assert.equal(early, 'blocked');
  rmSync(lock, { recursive: true }); await pending;
});

test('corrupt numeric totals and invalid config fail closed', async t => {
  const opts = fixture(t);
  await reserveRequest(free, opts);
  const path = usagePath(opts.env), doc = JSON.parse(readFileSync(path, 'utf8'));
  doc.months['2026-11'] = { free: { tokens: -1, requests: 0, estimatedUsd: 0 }, standard: { tokens: 0, requests: 0, estimatedUsd: 0 } };
  writeFileSync(path, JSON.stringify(doc));
  await assert.rejects(reserveRequest(free, opts), /Invalid token usage ledger totals/);
  await assert.rejects(reserveRequest(free, { ...opts, env: { ...opts.env, OPENAI_WORKER_MONTHLY_LIMIT_USD: 'banana' } }), /Invalid local monthly spending limit/);
});

const paidArgs = { worker_type: 'sol', model: 'gpt-6.2-sol', input: 'inspect', instructions: 'report', tools: [], max_output_tokens: 1024 };
test('actual bridge rejects caller model/tier/worker overrides before backend invocation', async t => {
  const opts = fixture(t);
  let calls = 0;
  opts.transport = { create: async args => { calls++; return { ...final(`resp_route_${calls}`), model: args.model }; } };
  await assert.rejects(dispatch('create', { ...paidArgs, model: 'gpt-6.2-astra' }, opts), /substitution/);
  await assert.rejects(dispatch('create', { ...paidArgs, service_tier: 'priority' }, opts), /substitution/);
  await assert.rejects(dispatch('create', { ...paidArgs, worker_type: undefined }, opts), /Unknown worker/);
  assert.equal(calls, 0);
  const configured = { ...opts, env: { ...opts.env, OPENAI_WORKER_SOL_MODEL: 'gpt-6.1-sol', OPENAI_WORKER_SOL_SERVICE_TIER: 'flex' } };
  await dispatch('create', { ...paidArgs, model: 'gpt-6.1-sol' }, configured);
  assert.equal(calls, 1);
});

test('actual bridge binds polling, cancellation and continuation to durable worker identity', async t => {
  const opts = fixture(t);
  const routes = [];
  opts.transport = {
    create: async (args, route) => { routes.push(route.profile); return { ...final('resp_bound_owner'), model: args.model }; },
    poll: async (id, route) => { routes.push(route.profile); return { ...final(id), model: paidArgs.model }; },
    cancel: async (id, route) => { routes.push(route.profile); return { ...final(id), model: paidArgs.model }; },
  };
  await dispatch('create', paidArgs, opts);
  await assert.rejects(dispatch('poll', { worker_type: 'daily-astrafree', id: 'resp_bound_owner' }, opts), /identity mismatch/);
  await assert.rejects(dispatch('cancel', { worker_type: 'astra', id: 'resp_bound_owner' }, opts), /identity mismatch/);
  await assert.rejects(dispatch('create', { ...paidArgs, worker_type: 'astra', model: 'gpt-6.2-astra', previous_response_id: 'resp_bound_owner' }, opts), /identity mismatch/);
  await assert.rejects(dispatch('poll', { worker_type: 'sol', id: 'resp_untracked' }, opts), /ownership is unknown/);
  await dispatch('poll', { worker_type: 'sol', id: 'resp_bound_owner' }, opts);
  await dispatch('cancel', { worker_type: 'sol', id: 'resp_bound_owner' }, opts);
  assert.deepEqual(routes, ['standard', 'standard', 'standard']);
});

test('actual bridge derives continuation reservation from stored history, ignoring caller underestimates', async t => {
  const opts = fixture(t);
  let count = 0;
  opts.transport = { create: async args => {
    count++;
    return count === 1 ? { ...final('resp_history_one', 7000), model: args.model } : { id: 'resp_history_two', status: 'in_progress' };
  } };
  await dispatch('create', paidArgs, opts);
  await dispatch('create', { ...paidArgs, previous_response_id: 'resp_history_one', inputTokenUpperBound: 0 }, opts);
  const current = await usageSnapshot(opts);
  assert.ok(current.profiles.standard.reservedTokens > 7000);
  assert.equal(current.profiles.standard.pendingRequests, 1);
  await assert.rejects(dispatch('create', { ...paidArgs, previous_response_id: 'resp_history_two' }, opts), /verified complete history bound/);
});

test('actual bridge retains ambiguous reservations but releases proved rejected requests', async t => {
  const opts = fixture(t);
  opts.transport = { create: async () => { const error = new Error('HTTP 503'); error.usageDisposition = 'ambiguous'; throw error; } };
  await assert.rejects(dispatch('create', paidArgs, opts), /503/);
  let snapshot = await usageSnapshot(opts);
  assert.equal(snapshot.profiles.standard.unknownUsageRequests, 1);
  const reserved = snapshot.profiles.standard.reservedTokens;
  opts.transport = { create: async () => { const error = new Error('HTTP 401'); error.usageDisposition = 'rejected'; throw error; } };
  await assert.rejects(dispatch('create', paidArgs, opts), /401/);
  snapshot = await usageSnapshot(opts);
  assert.equal(snapshot.profiles.standard.reservedTokens, reserved);
  assert.equal(snapshot.profiles.standard.pendingRequests, 1);
});

test('actual bridge reconciles both fixed profiles and never substitutes a key on restart', async t => {
  const opts = fixture(t);
  const models = new Map();
  opts.transport = { create: async args => { const id = `resp_reconcile_${args.worker_type}`; models.set(id, args.model); return { id, status: 'in_progress' }; } };
  await dispatch('create', paidArgs, opts);
  await dispatch('create', { ...paidArgs, worker_type: 'daily-astrafree', model: 'gpt-6-astra' }, opts);
  const profiles = [];
  opts.transport = { poll: async (id, route) => { profiles.push(route.profile); return { ...final(id), model: models.get(id) }; } };
  const snapshot = await dispatch('usage', {}, opts);
  assert.deepEqual(profiles.sort(), ['free', 'standard']);
  assert.equal(snapshot.profiles.free.pendingRequests, 0); assert.equal(snapshot.profiles.standard.pendingRequests, 0);
  assert.equal(snapshot.profiles.free.tokens, 25); assert.equal(snapshot.profiles.standard.tokens, 25);
});
