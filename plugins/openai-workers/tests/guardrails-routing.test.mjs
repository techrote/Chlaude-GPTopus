import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from '../hooks/register.js';
import { newRun } from '../hooks/step.js';
import { guardrails, describeGuardrails, budgetPhase, tooLarge, capOutputs, compactedInput, classifyError, freeToPaidEnabled, WRAP_UP_STEPS } from '../bridge/policy.mjs';
import { reserveRequest, accountResponse, usageSnapshot, billingPeriod, periodResetAt } from '../bridge/usage.mjs';
import { dispatch } from '../bridge/server.mjs';

function makeEngine(responses, agent, config = {}, messages = [{ role: 'user', text: 'Do the task' }]) {
  const handlers = new Map();
  register((event, filter, handler) => {
    if (typeof filter === 'function') handler = filter;
    handlers.set(event === 'command.run' && filter?.command ? `command.run:${filter.command}` : event, handler);
    return { catch() { return this; } };
  });
  let state = {};
  const sent = [], registered = [];
  const context = {
    agent: { list: async () => [{ id: 'ag_1', type: agent, status: 'running' }], register: async x => { registered.push(x); } },
    session: { cwd: async () => '/tmp', messages: async args => args.as === 'api' ? [] : messages },
    fs: { read: async () => '' },
    state: { get: async () => ({ value: state.run }), set: async (_, s) => { state.run = s; } },
    env: { get: async name => config[name] },
    mcp: { call: async (_server, name, args) => {
      sent.push({ name, args });
      const next = responses.shift();
      if (next?.__error) return { isError: true, content: [{ type: 'text', text: next.__error }] };
      return { content: [{ type: 'text', text: JSON.stringify(next) }] };
    } },
    command: { register: async () => {} }, tool: { register: async () => {} },
  };
  return { handlers, context, sent, registered, setState: s => { state.run = s; }, getState: () => state.run };
}
async function step(fake, index = 0) {
  const gen = fake.handlers.get('turn.step')(fake.context, { agentId: 'ag_1', turnId: 't1', index }, async function* () { throw new Error('must not fall back to Anthropic'); });
  let r = await gen.next();
  while (!r.done) r = await gen.next();
  return r.value;
}
const done = (id, text = 'ok', usd = 0.01) => ({ id, status: 'completed', text, estimatedUsd: usd, usage: { input: 10, output: 5, total: 15 } });
const statusLine = answer => JSON.parse(/OAI-STATUS (\{.*\})/.exec(answer)[1]);

test('guardrails: no default USD cap; caps come only from named env vars and report their source', () => {
  const none = guardrails({}, 'sol6-2', { key: 'standard' });
  assert.equal(none.maxUsd, Infinity);
  assert.equal(none.maxSteps, 40);
  assert.match(describeGuardrails(none), /no per-task USD cap/);
  const set = guardrails({ OPENAI_WORKER_MAX_USD: '1', OPENAI_WORKER_ASTRA6_2_MAX_STEPS: '99' }, 'astra6-2', { key: 'standard' });
  assert.equal(set.maxUsd, 1); assert.equal(set.maxSteps, 99);
  assert.deepEqual(set.sources.map(s => s.name), ['OPENAI_WORKER_ASTRA6_2_MAX_STEPS', 'OPENAI_WORKER_MAX_USD']);
  assert.match(describeGuardrails(set), /OPENAI_WORKER_MAX_USD=1 \[all workers\]/);
  assert.equal(guardrails({ OPENAI_WORKER_MAX_USD: '1' }, 'kimik3-1pro', { provider: 'nvidia' }).maxUsd, Infinity);
});

test('budgetPhase: ok -> wrap_up (grace steps) -> stop, relative to a resume window', () => {
  const g = { maxSteps: 5, maxUsd: Infinity };
  assert.equal(budgetPhase({ steps: 4, estimatedUsd: 0 }, g).phase, 'ok');
  const first = budgetPhase({ steps: 5, estimatedUsd: 0 }, g);
  assert.deepEqual([first.phase, first.reason, first.first], ['wrap_up', 'step_cap', true]);
  assert.equal(budgetPhase({ steps: 6, estimatedUsd: 0, wrapUpSteps: 1 }, g).first, false);
  assert.equal(budgetPhase({ steps: 8, estimatedUsd: 0, wrapUpSteps: WRAP_UP_STEPS }, g).phase, 'stop');
  assert.equal(budgetPhase({ steps: 8, estimatedUsd: 0, stepBase: 8, wrapUpSteps: 0 }, g).phase, 'ok');
  assert.equal(budgetPhase({ steps: 1, estimatedUsd: 1.5 }, { maxSteps: 99, maxUsd: 1 }).reason, 'task_budget');
});

test('a paid worker is NOT stopped at the old hidden $4 default', async () => {
  const fake = makeEngine([done('resp_aaaa1')], 'oai:sol6-2');
  fake.setState({ ...newRun(), steps: 3, estimatedUsd: 9, responseId: 'resp_prev1' });
  const out = await step(fake);
  assert.ok(fake.sent.some(s => s.name === 'create'), 'the request was sent');
  assert.doesNotMatch(out.answer, /guardrail/);
});

test('hitting a configured budget gives a wrap-up turn first, then stops with a machine-readable, resumable status', async () => {
  const config = { OPENAI_WORKER_MAX_USD: '1' };
  const fake = makeEngine([done('resp_wrap01', 'Committed. Summary.')], 'oai:sol6-2', config);
  fake.setState({ ...newRun(), steps: 8, estimatedUsd: 1.035, responseId: 'resp_prev1', pending: [] });
  await step(fake);
  const create = fake.sent.find(s => s.name === 'create').args;
  assert.match(JSON.stringify(create.input), /Wrap up NOW/);
  assert.equal(fake.getState().wrapUpSteps, 1);
  // Grace used up: no request, structured stop, state kept for resume.
  const stopped = makeEngine([], 'oai:sol6-2', config);
  stopped.setState({ ...newRun(), steps: 11, estimatedUsd: 1.2, responseId: 'resp_prev1', wrapUpSteps: WRAP_UP_STEPS, pending: ['call_1'] });
  const out = await step(stopped);
  assert.equal(stopped.sent.length, 0);
  assert.match(out.answer, /reached its guardrail/);
  const rec = statusLine(out.answer);
  assert.deepEqual([rec.status, rec.reason, rec.resumable], ['stopped', 'task_budget', true]);
  assert.equal(rec.caps.at(-1).name, 'OPENAI_WORKER_MAX_USD');
  assert.deepEqual(stopped.getState().pending, ['call_1'], 'pending tool calls survive so a resume answers them');
});

test('a new message resumes a stopped worker on the same conversation with a fresh budget window', async () => {
  const messages = [{ role: 'user', text: 'Do the task' }, { role: 'user', text: 'Continue please' }];
  const fake = makeEngine([done('resp_resume1', 'Resumed.')], 'oai:sol6-2', { OPENAI_WORKER_MAX_STEPS: '5' }, messages);
  fake.setState({ ...newRun(), steps: 9, estimatedUsd: 0.5, responseId: 'resp_prev1', wrapUpSteps: WRAP_UP_STEPS, finished: true, seenPrompts: 1, pending: [] });
  const out = await step(fake);
  assert.equal(fake.sent.find(s => s.name === 'create').args.previous_response_id, 'resp_prev1');
  assert.equal(out.answer, 'Resumed.');
  assert.equal(fake.getState().stepBase, 9);
});

test('free pool spent: astra6free continues on paid astra6-2 and the result says so', async () => {
  const quota = { __error: 'OpenAI bridge create: UTC 2026-11-27: astra6free paused at its soft daily allowance: 275000 used + 0 reserved + 40000 requested / 275000 tokens' };
  const fake = makeEngine([quota, done('resp_paid001', 'Finished on paid.')], 'oai:astra6free', {});
  const out = await step(fake);
  const creates = fake.sent.filter(s => s.name === 'create');
  assert.deepEqual(creates.map(c => c.args.worker_type), ['astra6free', 'astra6-2']);
  assert.equal('previous_response_id' in creates[1].args && creates[1].args.previous_response_id !== undefined, false);
  assert.match(out.answer, /routed astra6free -> astra6-2/);
  assert.equal(fake.getState().route, 'astra6-2');
});

test('oai:astra entry point starts on the free pool; with switching disabled the quota stop is structured', async () => {
  const fake = makeEngine([done('resp_entry01')], 'oai:astra', {});
  await step(fake);
  assert.equal(fake.sent.find(s => s.name === 'create').args.worker_type, 'astra6free');
  const quota = { __error: 'OpenAI bridge create: astra6free paused at its soft daily allowance: 1 used + 0 reserved + 1 requested / 1 tokens' };
  const off = makeEngine([quota], 'oai:astra', { OPENAI_WORKER_FREE_TO_PAID_DISABLE: '1' });
  const out = await step(off);
  assert.equal(off.sent.filter(s => s.name === 'create').length, 1);
  const rec = statusLine(out.answer);
  assert.deepEqual([rec.status, rec.reason, rec.resumable], ['failed', 'quota_free_daily', true]);
  assert.equal(freeToPaidEnabled({ OPENAI_WORKER_FREE_TO_PAID_DISABLE: '1' }), false);
  assert.ok(makeEngine([], 'x').registered.length === 0);
});

test('the astra entry point is registered at session start', async () => {
  const fake = makeEngine([], 'oai:astra');
  await fake.handlers.get('session.start')(fake.context, {}, async e => e);
  const astra = fake.registered.find(a => a.name === 'astra');
  assert.ok(astra);
  assert.match(astra.description, /never substitute a Claude agent/i);
});

test('provider "request too large" (TPM) compacts into a fresh smaller request instead of ending the task', async () => {
  const big = { id: 'resp_big0001', status: 'failed', reason: 'Request too large for gpt-6-astra on tokens per min (TPM): Limit 30000, Requested 56376.', usage: null };
  const fake = makeEngine([big, done('resp_small01', 'Done after compaction.')], 'oai:astra6free', {});
  const out = await step(fake);
  fake.sent.filter(s => s.name === 'create');
  const creates = fake.sent.filter(s => s.name === 'create');
  assert.equal(creates.length, 2);
  assert.equal(creates[1].args.previous_response_id, undefined);
  assert.match(String(creates[1].args.input), /Context compacted/);
  assert.equal(out.answer, 'Done after compaction.');
  assert.equal(fake.getState().compactions, 1);
});

test('failed unbilled responses carry a machine-readable status', async () => {
  const fake = makeEngine([{ id: 'resp_fail001', status: 'failed', reason: 'upstream exploded' }], 'oai:sol6-2', {});
  const out = await step(fake);
  assert.match(out.answer, /request failed: upstream exploded/);
  assert.deepEqual([statusLine(out.answer).status, statusLine(out.answer).reason], ['failed', 'api_error']);
});

test('policy helpers: tooLarge, capOutputs, compactedInput, classifyError', () => {
  assert.deepEqual(tooLarge({ status: 'failed', reason: 'Request too large ... tokens per min (TPM): Limit 30000, Requested 56376' }), { limit: 30000, requested: 56376 });
  assert.equal(tooLarge({ status: 'failed', reason: 'rate limit reached' }), null);
  const capped = capOutputs([{ type: 'function_call_output', call_id: 'c', output: 'x'.repeat(100000) }], 1000);
  assert.ok(capped[0].output.length < 1300 && /omitted by the bridge/.test(capped[0].output));
  const compact = compactedInput({ prompts: ['task'], results: [{ text: 'y'.repeat(9000) }], perResult: 500 });
  assert.ok(compact.length < 1500 && compact.startsWith('task'));
  assert.equal(classifyError(new Error('x used paused at its soft daily allowance')), 'quota_free_daily');
  assert.equal(classifyError(new Error('boom')), 'api_error');
});

// ---- ledger: soft monthly cap, period, free-pool queue and reservations, tree attribution ----
const fixture = (t, env = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'oai-soft-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { env: { OPENAI_WORKER_USAGE_DIR: dir, OPENAI_WORKER_DAILY_RESERVE_TOKENS: '10', ...env }, now: new Date('2026-11-28T10:00:00Z') };
};
const paid = { workerType: 'sol6-2', model: 'gpt-6.2-sol', profile: 'standard', inputBoundVerified: true, reservationTokens: 100, reservationUsd: 0.5 };
const resp = (id, usd) => ({ id, status: 'completed', usage: { input: 50, output: 50, total: 100 }, estimatedUsd: usd });

test('monthly limit is soft by default: crossing it warns (actual spend only) and never refuses; enforce opts in', async t => {
  const opts = fixture(t, { OPENAI_WORKER_MONTHLY_LIMIT_USD: '1' });
  const first = await reserveRequest({ ...paid, reservationUsd: 0.4 }, opts);
  // Big reservation outstanding but no spend yet: no warning.
  const w0 = []; await reserveRequest({ ...paid, reservationUsd: 5 }, { ...opts, warnings: w0 });
  assert.equal(w0.length, 0, 'reservations are not spend');
  await accountResponse(first, resp('resp_spend001', 1.2), opts);
  const w1 = [];
  const ticket = await reserveRequest({ ...paid, reservationUsd: 0.4 }, { ...opts, warnings: w1 });
  assert.ok(ticket, 'admitted past the soft limit');
  assert.equal(w1[0].code, 'monthly_soft_limit');
  assert.ok(w1[0].committedUsd >= 1.2 && w1[0].reservedUsd >= 5 && w1[0].limitUsd === 1);
  const snap = await usageSnapshot(opts);
  assert.equal(snap.monthlyEnforced, false); assert.equal(snap.monthlyWarning.limitUsd, 1);
  const hard = { ...opts, env: { ...opts.env, OPENAI_WORKER_MONTHLY_ENFORCE: '1' } };
  await assert.rejects(reserveRequest({ ...paid, reservationUsd: 0.4 }, hard), /monthly spending limit/);
});

test('monthly period resets at 01:00 UTC on the 27th by default and the anchor is configurable', () => {
  assert.equal(billingPeriod(new Date('2026-11-27T00:59:59Z'), {}), '2026-10');
  assert.equal(billingPeriod(new Date('2026-11-27T01:00:00Z'), {}), '2026-11');
  assert.equal(billingPeriod(new Date('2027-01-05T12:00:00Z'), {}), '2026-12');
  assert.equal(periodResetAt(new Date('2026-11-28T00:00:00Z'), {}), '2026-12-27T01:00:00.000Z');
  assert.equal(billingPeriod(new Date('2026-11-10T00:00:00Z'), { OPENAI_WORKER_MONTHLY_RESET_DAY: '1', OPENAI_WORKER_MONTHLY_RESET_HOUR_UTC: '0' }), '2026-11');
});

test('free reservations use a realistic size, so several workers fit the pool; reserved-only shortage is distinguishable', async t => {
  const opts = fixture(t, { OPENAI_WORKER_PREMIUM_DAILY_TOKENS: '250000', OPENAI_WORKER_DAILY_RESERVE_TOKENS: '1000' });
  const free = n => ({ workerType: 'astra6free', model: 'gpt-6-astra', profile: 'free', requestId: `r${n}`, reservationTokens: 144_000, inputTokens: 128_000, outputTokens: 16_000, realisticTokens: 20_000, inputBoundVerified: true });
  for (let n = 0; n < 6; n++) assert.ok(await reserveRequest(free(n), opts), `worker ${n} admitted`);
  const snap = await usageSnapshot(opts);
  assert.equal(snap.groups.premium.reservedTokens, 120_000);
  assert.ok(snap.freeCapacity.premium.concurrentWorkers >= 1);
  const big = { ...free(99), realisticTokens: 200_000, reservationTokens: 200_000, inputTokens: 100_000, outputTokens: 100_000 };
  await assert.rejects(reserveRequest(big, opts), e => e.quotaReason === 'free_daily_reserved' || /soft daily allowance/.test(e.message));
});

test('tree attribution: per-root totals equal the sum over nodes', async t => {
  const opts = fixture(t);
  const a = await reserveRequest({ ...paid, rootId: 'root1' }, opts), b = await reserveRequest({ ...paid, rootId: 'root1', parentId: 'ag_1' }, opts);
  await accountResponse(a, resp('resp_tree0001', 0.25), opts); await accountResponse(b, resp('resp_tree0002', 0.5), opts);
  const tree = (await usageSnapshot(opts)).trees.root1;
  assert.equal(tree.tokens, 200); assert.equal(tree.requests, 2); assert.equal(Number(tree.estimatedUsd.toFixed(2)), 0.75);
  const sum = Object.values(tree.nodes).reduce((n, x) => n + x.tokens, 0);
  assert.equal(sum, tree.tokens);
});

test('bridge create: a soft-limit warning rides on the response; no refusal', async t => {
  const opts = fixture(t, { OPENAI_WORKER_MONTHLY_LIMIT_USD: '0.001', OPENAI_API_KEY: 'sk-test-not-real' });
  const transport = { create: async () => ({ id: 'resp_bridge01', status: 'completed', model: 'gpt-6.2-sol', text: 'hi', usage: { input: 10, output: 5, total: 15 }, estimatedUsd: 0.05 }) };
  const args = { worker_type: 'sol6-2', model: 'gpt-6.2-sol', input: 'hello', instructions: 'be brief', tools: [] };
  const first = await dispatch('create', args, { ...opts, transport });
  assert.equal(first.status, 'completed');
  const second = await dispatch('create', { ...args, input: 'again' }, { ...opts, transport });
  assert.equal(second.monthlyWarning.code, 'monthly_soft_limit');
  assert.equal(second.status, 'completed');
});
