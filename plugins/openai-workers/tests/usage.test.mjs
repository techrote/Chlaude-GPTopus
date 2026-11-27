import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { groupForModel, settings, usagePath, reserveRequest, releaseRequest,
  accountResponse, accountByResponseId, usageSnapshot } from '../bridge/usage.mjs';

function fixture(t, extra = {}, now = '2026-11-21T01:00:00Z') {
  const directory = mkdtempSync(join(tmpdir(), 'claude-openai-usage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { OPENAI_WORKER_USAGE_DIR: directory, OPENAI_WORKER_MONTHLY_RESET_DAY: '1', OPENAI_WORKER_MONTHLY_RESET_HOUR_UTC: '0', ...extra };
  return { env, now: new Date(now) };
}
function response(id, input = 20, output = 5, extra = {}) {
  return { id, status: 'completed', usage: { input, output, total: input + output }, estimatedUsd: 0.02, ...extra };
}

test('documented complementary token groups are SHARED and do not include new 6.2 models', () => {
  assert.equal(groupForModel('gpt-6.1-sol'), 'premium');
  assert.equal(groupForModel('gpt-6-astra'), 'premium');
  assert.equal(groupForModel('gpt-6-luna'), 'premium');
  assert.equal(groupForModel('gpt-5.6-terra'), 'terra');
  assert.equal(groupForModel('gpt-6.2-sol'), null);
  assert.equal(groupForModel('gpt-6.2-astra'), null);
  assert.equal(settings({}).overrunPercent, 10);
  assert.deepEqual(settings({}).limits, { premium: 250000, terra: 2500000 });
});

test('free-key ledger does not include sol6-1flex or any straight API key worker', async t => {
  const opts = fixture(t, { OPENAI_WORKER_PREMIUM_DAILY_TOKENS: '100', OPENAI_WORKER_DAILY_RESERVE_TOKENS: '10' });
  await assert.rejects(reserveRequest({ workerType: 'sol6-1flex', model: 'gpt-6.1-sol' }, opts), /only accepts astra6free/);
  const astra = await reserveRequest({ workerType: 'astra6free', model: 'gpt-6-astra' }, opts);
  await accountResponse(astra, { id: 'resp_astra01', status: 'in_progress' }, opts);
  let s = await usageSnapshot(opts);
  assert.equal(s.groups.premium.reservedTokens, 10);
  assert.equal(s.groups.premium.usedTokens, 0);
  await accountByResponseId(response('resp_astra01', 80, 30), opts);
  await accountByResponseId(response('resp_astra01', 80, 30), opts);
  s = await usageSnapshot(opts);
  assert.equal(s.groups.premium.usedTokens, 110);
  assert.equal(s.groups.premium.reservedTokens, 0);
  await assert.rejects(reserveRequest({ workerType: 'astra6free', model: 'gpt-6-astra' }, opts), /paused at its soft daily allowance/);
});

test('Terra allowance is independent from premium and 10% overrun is configurable', async t => {
  const opts = fixture(t, {
    OPENAI_WORKER_PREMIUM_DAILY_TOKENS: '100',
    OPENAI_WORKER_TERRA_DAILY_TOKENS: '100',
    OPENAI_WORKER_DAILY_RESERVE_TOKENS: '10',
    OPENAI_WORKER_DAILY_OVERRUN_PERCENT: '10',
  });
  const astra = await reserveRequest({ workerType: 'astra6free', model: 'gpt-6-astra' }, opts);
  await accountResponse(astra, response('resp_astra01', 98, 5), opts);
  const terra = await reserveRequest({ workerType: 'terra5-6free', model: 'gpt-5.6-terra' }, opts);
  await accountResponse(terra, response('resp_terra001', 70, 42), opts);
  const s = await usageSnapshot(opts);
  assert.equal(s.groups.premium.usedTokens, 103);
  assert.equal(s.groups.terra.usedTokens, 112);
  await assert.rejects(reserveRequest({ workerType: 'terra5-6free', model: 'gpt-5.6-terra' }, opts), /paused/);
  // The proposed reservation is now included; only seven tokens remain.
  await assert.rejects(reserveRequest({ workerType: 'astra6free', model: 'gpt-6-astra' }, opts), /paused/);
});

test('per-model-group mismatch fails before any API call', async t => {
  const opts = fixture(t);
  await assert.rejects(reserveRequest({ workerType: 'terra5-6free', model: 'gpt-6-astra' }, opts), /requires a model in the terra/);
  await assert.rejects(reserveRequest({ workerType: 'astra6free', model: 'gpt-6.2-astra' }, opts), /requires a model in the premium/);
  assert.equal((await usageSnapshot(opts)).groups.premium.usedTokens, 0);
});

test('shared reservations reduce high-concurrency overrun and can be released on API failure', async t => {
  const opts = fixture(t, {
    OPENAI_WORKER_PREMIUM_DAILY_TOKENS: '100',
    OPENAI_WORKER_DAILY_RESERVE_TOKENS: '40',
  });
  const results = await Promise.allSettled(Array.from({ length: 20 }, () =>
    reserveRequest({ workerType: 'astra6free', model: 'gpt-6-astra' }, opts)));
  const permitted = results.filter(x => x.status === 'fulfilled').map(x => x.value);
  assert.equal(permitted.length, 2); // Third 40-token reservation would exceed 110.
  assert.equal((await usageSnapshot(opts)).groups.premium.reservedTokens, 80);
  await releaseRequest(permitted[0], opts);
  const s = await usageSnapshot(opts);
  assert.equal(s.groups.premium.reservedTokens, 40);
  assert.equal(s.groups.premium.pendingRequests, 1);
});

test('UTC midnight resets admission but late-completing requests are attributed to original day', async t => {
  const yesterday = fixture(t, { OPENAI_WORKER_PREMIUM_DAILY_TOKENS: '40', OPENAI_WORKER_DAILY_RESERVE_TOKENS: '10' }, '2026-11-21T23:59:30Z');
  const ticket = await reserveRequest({ workerType: 'astra6free', model: 'gpt-6-astra' }, yesterday);
  await accountResponse(ticket, { id: 'resp_late0001', status: 'in_progress' }, yesterday);
  const tomorrow = { ...yesterday, now: new Date('2026-11-22T00:02:00Z') };
  await accountByResponseId(response('resp_late0001', 38, 5), tomorrow);
  assert.equal((await usageSnapshot(yesterday)).groups.premium.usedTokens, 43);
  assert.equal((await usageSnapshot(tomorrow)).groups.premium.usedTokens, 0);
  assert.equal((await usageSnapshot(tomorrow)).resetAtUtc, '2026-11-23T00:00:00Z');
  const next = await reserveRequest({ workerType: 'astra6free', model: 'gpt-6-astra' }, tomorrow);
  await releaseRequest(next, tomorrow);
});

test('local ledger persists across Node processes and tracks undiscounted monthly estimate', async t => {
  const opts = fixture(t, { OPENAI_WORKER_MONTHLY_ALLOWANCE_USD: '88' });
  const ticket = await reserveRequest({ workerType: 'terra5-6free', model: 'gpt-5.6-terra' }, opts);
  await accountResponse(ticket, response('resp_month01', 100, 50, { estimatedUsd: 0.0045 }), opts);
  const moduleUrl = new URL('../bridge/usage.mjs', import.meta.url).href;
  const node = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {usageSnapshot} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await usageSnapshot({now: new Date('2026-11-21T01:00:00Z')})));`],
    { encoding: 'utf8', env: { ...process.env, ...opts.env }, timeout: 5000 });
  assert.equal(node.status, 0, node.stderr);
  const info = JSON.parse(node.stdout);
  assert.equal(info.groups.terra.usedTokens, 150);
  assert.equal(info.monthlyEstimatedUsd, 0.0045);
  assert.equal(info.monthlyAllowanceUsd, 88);
  assert.equal(info.groups.premium.usedTokens, 0);
});

test('corrupt usage file refuses to reset counts to zero', async t => {
  const opts = fixture(t);
  writeFileSync(usagePath(opts.env), '{broken json');
  await assert.rejects(reserveRequest({ workerType: 'terra5-6free', model: 'gpt-5.6-terra' }, opts), /ledger is unreadable/);
  assert.equal(readFileSync(usagePath(opts.env), 'utf8'), '{broken json');
});


test('missing final usage retains an unverified reservation rather than becoming verified zero', async t => {
  const opts = fixture(t, { OPENAI_WORKER_DAILY_RESERVE_TOKENS: '1234' });
  const ticket = await reserveRequest({ workerType: 'astra6free', model: 'gpt-6-astra' }, opts);
  await accountResponse(ticket, { id: 'resp_no_usage', status: 'incomplete', estimatedUsd: 0 }, opts);
  const snapshot = await usageSnapshot(opts);
  assert.equal(snapshot.groups.premium.usedTokens, 0);
  assert.equal(snapshot.groups.premium.reservedTokens, 1234);
  assert.equal(snapshot.profiles.free.unknownUsageRequests, 1);
});

test('release tombstones are bounded by the same retention horizon as daily detail, while request IDs are kept', async t => {
  const f = fixture(t, { OPENAI_WORKER_DAILY_RESERVE_TOKENS: '10' }, '2026-09-01T01:00:00Z');
  const args = { workerType: 'astra6free', model: 'gpt-6-astra' };
  const old = await reserveRequest({ ...args, requestId: 'req-old-release' }, f);
  assert.equal(await releaseRequest(old, f), true);
  let doc = JSON.parse(readFileSync(usagePath(f.env), 'utf8'));
  assert.equal(Object.keys(doc.releases).length, 1, 'tombstone is written on release');
  const later = { env: f.env, now: new Date('2026-11-21T01:00:00Z') }; // 81 days on
  const fresh = await reserveRequest({ ...args, requestId: 'req-new-release' }, later);
  assert.equal(await releaseRequest(fresh, later), true);
  doc = JSON.parse(readFileSync(usagePath(f.env), 'utf8'));
  assert.deepEqual(Object.values(doc.releases).map(r => r.requestId), ['req-new-release'], 'only the stale tombstone is dropped');
  assert.ok(doc.requests['req-old-release'], 'request IDs are never aged out: replay protection is permanent');
});
