// PRESEND-01: a native API request refused BEFORE any POST must not wedge the agent.
//
// Everything runs through the production path: signed ultra_native_* requests into
// the real bridge dispatcher, the real NativeController, the real broker/ledger and
// the real local spending guard (bridge/usage.mjs). Only the OpenAI HTTPS call is a
// recording double, so `transport.calls.create` counts actual POSTs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { usagePath } from '../bridge/usage.mjs';
import { createTurn, mayHaveIncurredUsage } from '../bridge/openai.mjs';
import { bridgeHost, recordingTransport } from './bridge-host.mjs';

const NOW = new Date('2026-11-21T01:00:00Z');
const SPEND = { OPENAI_WORKER_MONTHLY_LIMIT_USD: '50' };

/** A realistic v1 ledger: the first v2 write migrates it and leaves the migration month unreconciled. */
async function writeV1(env) {
  const doc = { version: 1, days: { '2026-11-01': { groups: { premium: { tokens: 100, estimatedUsd: 0.01, requests: 1 } }, workers: { 'daily-astrafree': { tokens: 100, estimatedUsd: 0.01, requests: 1 } }, totalEstimatedUsd: 0.01 } }, pending: {}, processed: {} };
  await mkdir(dirname(usagePath(env)), { recursive: true });
  await writeFile(usagePath(env), JSON.stringify(doc, null, 2));
}
const create = (h, key, extra = {}) => h.call('ultra_native_create', { ...h.s.common, hostAgentId: h.s.hostAgentId, requestKey: key, input: 'a bounded step', max_output_tokens: 1000, ...extra });
const finish = (h, failed = true) => h.call('ultra_native_finish', { ...h.s.common, hostAgentId: h.s.hostAgentId, answer: 'stopping', failed });
const nodeOf = async h => (await h.ledger()).missions[h.s.missionId].nodes[h.s.nodeId];

async function started(t, { transport = recordingTransport(), v1 = true, env = SPEND } = {}) {
  const h = await bridgeHost(t, { transport, now: NOW, env });
  if (v1) await writeV1(h.env);
  h.s = await h.session();
  assert.equal(h.s.admitted.allowed, true, JSON.stringify(h.s.admitted));
  return h;
}

test('PRESEND-01: a request refused by the local spending guard before any POST releases the step so the agent can retry', async t => {
  const transport = recordingTransport(), h = await started(t, { transport });
  await assert.rejects(() => create(h, 'step-1'), /Local spending guard blocked/);
  assert.equal(transport.calls.create.length, 0, 'the guard refused before any POST');
  const refused = await nodeOf(h);
  assert.deepEqual(Object.keys(refused.native.steps), [], `the refused step must not stay in "sending": ${JSON.stringify(refused.native.steps)}`);
  assert.match(refused.native.lastError, /Local spending guard blocked/, 'the real cause stays visible to the owner');
  const events = (await h.ledger()).events.filter(e => e.missionId === h.s.missionId).map(e => e.type);
  assert.ok(events.includes('native.api_released') && !events.includes('native.api_held'), `the refusal is recorded as released, not held: ${events.filter(e => e.startsWith('native.api')).join(',')}`);

  // The same agent is not wedged: it can retry the SAME step key once the owner has lifted the cause...
  delete h.env.OPENAI_WORKER_MONTHLY_LIMIT_USD;
  const retried = await create(h, 'step-1');
  assert.equal(retried.status, 'completed');
  assert.equal(transport.calls.create.length, 1, 'exactly one POST for the whole story');
  assert.equal((await nodeOf(h)).native.steps['step-1'].phase, 'complete');
});

test('PRESEND-01: a refusal does not consume the agent: a new step key works and the agent can also simply be finished with verified zero usage', async t => {
  const transport = recordingTransport(), h = await started(t, { transport });
  await assert.rejects(() => create(h, 'step-1'), /Local spending guard blocked/);
  delete h.env.OPENAI_WORKER_MONTHLY_LIMIT_USD;
  assert.equal((await create(h, 'step-2')).status, 'completed', 'a different step key is not blocked by the refused one');

  const second = await bridgeHost(t, { transport: recordingTransport(), now: NOW, env: SPEND }); await writeV1(second.env); second.s = await second.session('finish-session');
  await assert.rejects(() => create(second, 'step-1'), /Local spending guard blocked/);
  await finish(second);
  const node = await nodeOf(second);
  assert.equal(node.usageStatus, 'verified', 'nothing was ever sent, so the usage is a verified zero rather than unknown');
  assert.deepEqual(node.reservation, { tokens: 0, usd: 0 }, 'the allocation reservation is released instead of counting against mission budgets forever');
});

test('PRESEND-01: every definitive pre-send refusal releases the step: monthly limit, free daily allowance and ledger admission', async t => {
  const cases = {
    'local monthly spending limit': { worker: 'luna', env: { OPENAI_WORKER_MONTHLY_LIMIT_USD: '0.0000001' }, message: /Local monthly spending limit/ },
    'free-key daily allowance': { worker: 'daily-astrafree', env: { OPENAI_WORKER_PREMIUM_DAILY_TOKENS: '100', OPENAI_WORKER_DAILY_RESERVE_TOKENS: '10' }, message: /soft daily allowance/ },
  };
  for (const [label, { worker, env, message }] of Object.entries(cases)) {
    const transport = recordingTransport(), h = await bridgeHost(t, { transport, now: NOW, env });
    h.s = await h.session('host-session', { worker });
    assert.equal(h.s.admitted.allowed, true, `${label}: ${JSON.stringify(h.s.admitted)}`);
    await assert.rejects(() => create(h, 'step-1'), message, label);
    assert.equal(transport.calls.create.length, 0, `${label}: refused before any POST`);
    const node = await nodeOf(h);
    assert.deepEqual(Object.keys(node.native.steps), [], `${label}: step released`);
    assert.deepEqual((await h.ledger()).missions[h.s.missionId].apiRequests, [], `${label}: a request that never left does not count against request limits`);
    for (const name of Object.keys(env)) delete h.env[name];
    assert.equal((await create(h, 'step-1')).status, 'completed', `${label}: the same agent retries once the cause is lifted`);
    assert.equal(transport.calls.create.length, 1, label);
  }
});

test('PRESEND-01: an HTTP rejection (4xx, usage provably not incurred) releases the step; a transport failure keeps holding it', async t => {
  const reject = (disposition, message) => ({ create: async () => { const error = new Error(message); if (disposition) error.usageDisposition = disposition; throw error; } });

  const rejected = recordingTransport(reject('rejected', 'OpenAI HTTP 400: invalid request')), a = await started(t, { transport: rejected, v1: false, env: {} });
  await assert.rejects(() => create(a, 'step-1'), /HTTP 400/);
  assert.equal(rejected.calls.create.length, 1);
  assert.deepEqual(Object.keys((await nodeOf(a)).native.steps), [], 'a definitive rejection frees the agent');

  const notStarted = recordingTransport(reject('not_started', 'Missing standard OpenAI key.')), b = await started(t, { transport: notStarted, v1: false, env: {} });
  await assert.rejects(() => create(b, 'step-1'), /Missing standard/);
  assert.deepEqual(Object.keys((await nodeOf(b)).native.steps), [], 'a request that never left is released');

  // AMBIGUOUS: the POST may have been accepted. It must keep holding, whatever the error text says.
  for (const [label, behaviour] of Object.entries({ 'network failure tagged ambiguous': reject('ambiguous', 'OpenAI request failed: network error'), 'untagged error': reject(undefined, 'Something odd happened after the send'),
    'server error after the send': reject('ambiguous', 'OpenAI HTTP 502: bad gateway') })) {
    const transport = recordingTransport(behaviour), h = await started(t, { transport, v1: false, env: {} });
    await assert.rejects(() => create(h, 'step-1'));
    assert.equal(transport.calls.create.length, 1, label);
    assert.equal((await nodeOf(h)).native.steps['step-1'].phase, 'sending', `${label}: an ambiguous POST is held, never silently released`);
    await assert.rejects(() => create(h, 'step-1'), /Ambiguous native API POST is held/, `${label}: same key`);
    await assert.rejects(() => create(h, 'step-2'), /unsettled/, `${label}: new key`);
    assert.equal(transport.calls.create.length, 1, `${label}: nothing was replayed`);
    await finish(h);
    assert.equal((await nodeOf(h)).usageStatus, 'unknown', `${label}: usage stays unknown and the reservation is retained`);
  }
});

test('PRESEND-01: a failure AFTER the provider answered is ambiguous and is never released for replay', async t => {
  // Unverifiable usage/price: the response was received and recorded, so the step must stay held with its reservation.
  const transport = recordingTransport({ create: async (args, _options, completed) => completed(args, { estimatedUsd: null, priceStatus: 'unknown' }) });
  const h = await started(t, { transport, v1: false, env: {} });
  await assert.rejects(() => create(h, 'step-1'), /unverified/);
  assert.equal(transport.calls.create.length, 1);
  const step = (await nodeOf(h)).native.steps['step-1'];
  assert.ok(step?.response, 'the received response is preserved for reconciliation');
  assert.notEqual(step.phase, 'complete');
  await assert.rejects(() => create(h, 'step-1'), /replayed|Unverified|Ambiguous/i, 'the same step is never re-sent');
  assert.equal(transport.calls.create.length, 1, 'no second POST');
  await finish(h);
  assert.equal((await nodeOf(h)).usageStatus, 'unknown', 'the reservation is retained');
});

test('PRESEND-01: a lookalike message never decides disposition; only the bridge-set tag does', async t => {
  const transport = recordingTransport({ create: async () => { throw new Error('Local spending guard blocked: but this was thrown by the transport, after the send'); } });
  const h = await started(t, { transport, v1: false, env: {} });
  await assert.rejects(() => create(h, 'step-1'));
  assert.equal((await nodeOf(h)).native.steps['step-1'].phase, 'sending', 'message text never decides disposition');
  assert.equal((await h.ledger()).events.filter(e => e.type === 'native.api_released').length, 0);
});

test('PRESEND-01: a controller with no transport refuses before it reserves a step', async t => {
  const f = await bridgeHost(t, { transport: recordingTransport() });
  const { NativeController } = await import('../ultra/native-controller.mjs'), { ExecutionStore } = await import('../ultra/store.mjs'), { RecruitmentBroker } = await import('../ultra/broker.mjs');
  const store = new ExecutionStore(`${f.dir}/own-ledger.json`), broker = new RecruitmentBroker(store, { config: { enabled: true } });
  const controller = new NativeController(broker, { live: true });
  const common = { toolUseId: 'spawn-1' };
  const init = await controller.handle('ultra_native_init', { sessionId: 'no-transport', model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false, surfaces: ['terminal'] }, { trustedHostChannel: true });
  const base = { sessionId: 'no-transport', capability: init.capability };
  const admitted = await controller.handle('ultra_native_admit', { ...base, ...common, primaryModel: 'opus', subagentType: 'openai-workers:luna', prompt: JSON.stringify({ task: 'x', ultra: { role: 'implementation', risk: { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 0.95, rationale: 'f' }, budget: { tokens: 40000, usd: 4 } } }) }, { trustedHostChannel: true });
  await controller.handle('ultra_native_bind', { ...base, ...common, hostAgentId: 'a1', nodeId: admitted.nodeId, bindingTicket: admitted.bindingTicket, hostWorker: 'luna' }, { trustedHostChannel: true });
  await assert.rejects(() => controller.handle('ultra_native_create', { ...base, hostAgentId: 'a1', requestKey: 'k1', input: 'x', max_output_tokens: 1000 }, { trustedHostChannel: true }), /transport is unavailable/);
  assert.deepEqual(Object.keys((await store.snapshot(init.missionId)).nodes[admitted.nodeId].native.steps), [], 'no step was reserved');
});

test('PRESEND-01: local validation inside createTurn is classified as "never sent" (and a missing key already was)', async () => {
  const failure = await createTurn({ worker_type: 'sol', model: 'not a model', instructions: 'x', tools: [], input: 'x' }, { profile: 'standard' }).catch(error => error);
  assert.match(failure.message, /Invalid model name/);
  assert.equal(failure.usageDisposition, 'not_started');
  assert.equal(mayHaveIncurredUsage(failure), false);
  const mismatch = await createTurn({ worker_type: 'sol', model: 'gpt-6.2-sol', instructions: 'x', tools: [], input: 'x' }, { profile: 'free' }).catch(error => error);
  assert.match(mismatch.message, /key-profile mismatch/);
  assert.equal(mismatch.usageDisposition, 'not_started');
  const noKey = await createTurn({ worker_type: 'sol', model: 'gpt-6.2-sol', instructions: 'x', tools: [], input: 'x' }, { profile: 'standard', env: { LOCALAPPDATA: '' }, fetchFn: async () => { throw new Error('must not be reached'); } }).catch(error => error);
  assert.equal(noKey.usageDisposition, 'not_started');
});
