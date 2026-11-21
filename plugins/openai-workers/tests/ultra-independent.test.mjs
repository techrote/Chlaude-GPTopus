// Independent adversarial review of broker/review/action code. The author of
// these tests did not implement those modules. All work is deterministic/local.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionStore } from '../ultra/store.mjs';
import { RecruitmentBroker } from '../ultra/broker.mjs';
import { ReviewController } from '../ultra/review.mjs';
import { ActionGate } from '../ultra/actions.mjs';
import { resolveConfig } from '../ultra/config.mjs';
import { UltraRuntime } from '../ultra/runtime.mjs';
import { UltraService, writeOwnerConfig } from '../ultra/service.mjs';
import { NativeController } from '../ultra/native-controller.mjs';
import { invoke as invokeDesktop, handleMessage as handleDesktopMessage } from '../bridge/desktop-server.mjs';
import { dispatch as dispatchNative } from '../bridge/server.mjs';
import { register } from '../hooks/register.js';

const risk = { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 0.95, reversibility: 'reversible', testsAvailable: true };
const proposal = (worker = 'luna', extra = {}) => ({ worker, task: 'Bounded synthetic engineering task', risk, budget: { tokens: 1000, usd: 0.05 }, ...extra });
async function fixture(t, config = {}, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ultra-independent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ExecutionStore(join(directory, 'ledger.json'));
  const broker = new RecruitmentBroker(store, { config: { enabled: true, ...config }, ...options });
  const mission = await broker.createMission({ task: 'Independent adversarial fixture', orchestrator: { model: 'opus', trusted: true, source: 'synthetic-host' } });
  return { store, broker, mission, review: new ReviewController(broker), actions: new ActionGate(broker) };
}
async function completeAuthor(f, extra = {}) {
  const r = await f.broker.request(f.mission.id, 'root', proposal('luna', extra), 'author');
  const n = await f.broker.claim(f.mission.id);
  assert.equal(n.id, r.nodeId);
  await f.broker.finish(f.mission.id, n.id, { lease: n.lease.token, result: 'safe implementation', usage: { tokens: 20, usd: 0.001 } });
  return n.id;
}

test('independent: native orchestrator cannot impersonate a mandatory HELICOP authority', async t => {
  const f = await fixture(t);
  const p = await f.broker.request(f.mission.id, 'root', proposal('sol', { mode: 'REPLICATOR' }), 'parent-sol');
  const child = await f.broker.request(f.mission.id, p.nodeId, proposal('sol'), 'peer');
  assert.equal(child.status, 'pending');
  await assert.rejects(() => f.broker.decide(f.mission.id, child.id, { decision: 'APPROVE', rationale: 'I am the main orchestrator' },
    { trusted: true, source: 'native-host', authority: 'helicop-sol' }), /authority|principal|impersonat|configured|independent/i);
});

test('independent: undefined optional audit metadata survives JSON persistence without corrupting the chain', async t => {
  const f = await fixture(t);
  await f.store.transaction((state, event) => event('synthetic.optional', f.mission.id, { optional: undefined, nested: { omitted: undefined }, array: [undefined, 'retained'] }));
  const persisted = await f.store.snapshot();
  assert.equal(persisted.events.at(-1).type, 'synthetic.optional');
  assert.deepEqual(persisted.events.at(-1).data, { nested: {}, array: [null, 'retained'] });
});

test('independent: dynamic policy gates added during approval wait require their own decision', async t => {
  const rules = [...resolveConfig().helicop.rules, { id: 'population-gate', enabled: true, authority: 'helicop-astra', mandatory: true, veto: true, priority: 100,
    when: { parentFamilies: ['sol'], childFamilies: ['sol'], minimumAgents: 3 } }];
  const f = await fixture(t, { helicop: { rules } });
  const p = await f.broker.request(f.mission.id, 'root', proposal('sol', { mode: 'REPLICATOR' }), 'parent-sol');
  const child = await f.broker.request(f.mission.id, p.nodeId, proposal('sol'), 'peer');
  assert.equal(child.evaluation.requiredApprovals.some(a => a.authority === 'helicop-astra'), false);
  const supervisor = await f.broker.appointSupervisor(f.mission.id, child.id, 'helicop-sol');
  await f.broker.request(f.mission.id, 'root', proposal('luna'), 'another-agent');
  const running = await f.broker.claim(f.mission.id, 'supervisor-process', { pool: 'review' });
  assert.equal(running.id, supervisor.id);
  await f.broker.finish(f.mission.id, running.id, { lease: running.lease.token, result: { decision: 'APPROVE', rationale: 'Synthetic bounded approval' }, usage: { tokens: 20, usd: 0.001 } });
  const after = await f.broker.decide(f.mission.id, child.id, { decision: 'APPROVE', rationale: 'Synthetic bounded approval' }, { trusted: true, source: 'supervisor', nodeId: supervisor.id, authority: 'helicop-sol' });
  assert.equal(after.status, 'pending');
  assert.equal(after.nodeId, null);
  assert.equal(after.evaluation.requiredApprovals.some(a => a.authority === 'helicop-astra'), true);
});

test('independent: native orchestrator cannot satisfy a human execution gate by naming user authority', async t => {
  const f = await fixture(t, { permissions: { tools: ['Write'] } });
  const r = await f.broker.request(f.mission.id, 'root', proposal(), 'author');
  const a = await f.actions.propose(f.mission.id, r.nodeId, { kind: 'delete', description: 'Synthetic consequential action; nothing is actually executed', target: 'valuable-data' });
  await assert.rejects(() => f.actions.decide(f.mission.id, a.id, { approved: true, actionHash: a.hash, rationale: 'Caller supplied user name' },
    { trusted: true, source: 'native-host', authority: 'user' }), /authority|principal|user|human|configured|independent/i);
});

test('independent: review reports cannot overwrite provenance or become two independent opinions', async t => {
  const f = await fixture(t);
  const authorId = await completeAuthor(f);
  const w = await f.review.start(f.mission.id, { authorId, source: { content: 'function safe() {}', tests: [{ name: 'synthetic test', passed: true }] }, risk: { ...risk, impact: 'high' } });
  const assignments = await f.review.assign(f.mission.id, w.id);
  assert.equal(assignments.length, 2);
  const n = await f.broker.claim(f.mission.id, 'review-process', { pool: 'review' });
  await f.broker.finish(f.mission.id, n.id, { lease: n.lease.token, result: { findings: [], coverage: [] }, usage: { tokens: 20, usd: 0.001 } });
  const report = { findings: [], coverage: [{ area: 'all', status: 'examined' }], nodeId: 'spoofed-independent-reviewer', role: 'second_opinion', id: 'spoofed-report' };
  let accepted;
  try { accepted = await f.review.submit(f.mission.id, w.id, n.id, w.source.hash, report); }
  catch (error) { assert.match(error.message, /field|report|provenance|unknown|invalid/i); return; }
  assert.equal(accepted.reviews.at(-1).nodeId, n.id, 'model report must not overwrite the ledger principal');
  assert.equal(accepted.reviews.at(-1).role, n.role, 'model report must not overwrite the assigned role');
  assert.equal(accepted.status, 'review', 'one primary response cannot replace the second independent allocation');
  await assert.rejects(() => f.review.submit(f.mission.id, w.id, n.id, w.source.hash, { ...report, nodeId: 'another-spoof' }), /already|duplicate/i);
});

test('independent: destructive low-complexity work uses effective impact and owner review configuration', async t => {
  const f = await fixture(t, { review: { primary: 'sol', maxRounds: 4 } });
  const authorId = await completeAuthor(f);
  const w = await f.review.start(f.mission.id, { authorId, source: { content: 'cleanup candidate' }, risk: { ...risk, destructive: true } });
  assert.equal(w.policy.secondOpinion, true);
  assert.equal(w.policy.gapReview, true);
  assert.equal(w.policy.reviewer, 'sol');
  assert.equal(w.policy.maxRounds, 4);
});

test('independent: changed verification evidence invalidates an otherwise identical source', async t => {
  const f = await fixture(t);
  const authorId = await completeAuthor(f);
  const w = await f.review.start(f.mission.id, { authorId, source: { content: 'same implementation', tests: [{ name: 'suite', passed: true, digest: 'old-evidence' }] }, risk });
  const changed = await f.review.invalidate(f.mission.id, w.id, { content: 'same implementation', tests: [{ name: 'suite', passed: false, digest: 'new-evidence' }] });
  assert.equal(changed.status, 'held');
  assert.notEqual(changed.source.hash, w.source.hash);
});

test('independent: one rejected request cannot generate unbounded revised sibling proposals', async t => {
  const f = await fixture(t, { helicop: { denial: 'revise', maxRevisions: 1 }, mission: { maxRetries: 1 } });
  const p = await f.broker.request(f.mission.id, 'root', proposal('luna'), 'parent');
  const denied = await f.broker.request(f.mission.id, p.nodeId, proposal('astra'), 'denied-upward');
  assert.equal(denied.status, 'rejected');
  await f.broker.revise(f.mission.id, denied.id, p.nodeId, { task: 'Still prohibited revised proposal' }, 'revision-1');
  await assert.rejects(() => f.broker.revise(f.mission.id, denied.id, p.nodeId, { task: 'Another sibling bypassing retry count' }, 'revision-2'), /revis|retry|limit|consum/i);
});

test('independent: execution approval cannot be consumed after mission cancellation', async t => {
  const f = await fixture(t, { permissions: { tools: ['Write'] } });
  const r = await f.broker.request(f.mission.id, 'root', proposal(), 'author');
  const action = { kind: 'write', description: 'Synthetic action bound to an active allocation', path: 'file.txt', content: 'proposal' };
  const a = await f.actions.propose(f.mission.id, r.nodeId, action);
  await f.actions.decide(f.mission.id, a.id, { approved: true, actionHash: a.hash, rationale: 'Synthetic owner approval' }, { trusted: true, source: 'local-user', authority: 'user' });
  await f.broker.cancel(f.mission.id);
  await assert.rejects(() => f.actions.consume(f.mission.id, a.id, action, { nodeId: r.nodeId, capability: 'Write' }), /cancel|active|mission|agent|stale|approval/i);
});

test('independent: risk-required second opinions cannot be disabled by workflow-local policy arguments', async t => {
  const f = await fixture(t);
  const authorId = await completeAuthor(f);
  let flow;
  try { flow = await f.review.start(f.mission.id, { authorId, source: { content: 'high-impact work' }, risk: { ...risk, impact: 'high' }, policy: { secondOpinion: false, gapReview: false } }); }
  catch (error) { assert.match(error.message, /policy|authori|review|required|scope|override/i); return; }
  assert.equal(flow.policy.secondOpinion, true);
  assert.equal(flow.policy.gapReview, true);
});

test('independent: child completion before cooperative wait cannot strand the parent', async t => {
  const f = await fixture(t);
  const p = await f.broker.request(f.mission.id, 'root', proposal('sol'), 'parent');
  const runningParent = await f.broker.claim(f.mission.id, 'parent-process', { pool: 'core' });
  assert.equal(runningParent.id, p.nodeId);
  const c = await f.broker.request(f.mission.id, p.nodeId, proposal('luna'), 'child');
  const child = await f.broker.claim(f.mission.id, 'child-process', { pool: 'core' });
  assert.equal(child.id, c.nodeId);
  await f.broker.finish(f.mission.id, child.id, { lease: child.lease.token, result: 'completed before parent waits', usage: { tokens: 20, usd: 0.001 } });
  const parent = await f.broker.waitFor(f.mission.id, runningParent.id, [child.id], runningParent.lease.token);
  assert.notEqual(parent.status, 'waiting', 'completed children must immediately make their parent runnable');
});

test('independent: cancelling a waited-for child releases its parent without replaying work', async t => {
  const f = await fixture(t);
  const p = await f.broker.request(f.mission.id, 'root', proposal('sol'), 'parent');
  const runningParent = await f.broker.claim(f.mission.id, 'parent-process', { pool: 'core' });
  const c = await f.broker.request(f.mission.id, p.nodeId, proposal('luna'), 'child');
  await f.broker.waitFor(f.mission.id, runningParent.id, [c.nodeId], runningParent.lease.token);
  await f.broker.cancel(f.mission.id, c.nodeId);
  const m = await f.store.snapshot(f.mission.id);
  assert.equal(m.nodes[c.nodeId].status, 'cancelled');
  assert.notEqual(m.nodes[p.nodeId].status, 'waiting');
});

test('independent: known API overrun stays in mission accounting even when the worker is blocked', async t => {
  const f = await fixture(t);
  const r = await f.broker.request(f.mission.id, 'root', proposal('luna', { budget: { tokens: 20000, usd: 1 } }), 'overrun');
  let calls = 0;
  const backend = async () => { calls++; return { id: 'resp_independent_overrun', status: 'completed', text: 'Already incurred response', usage: { total: 50 }, estimatedUsd: 2, calls: [] }; };
  backend.offline = true;
  await new UltraRuntime(f.broker, { backend }).tick(f.mission.id);
  const m = await f.store.snapshot(f.mission.id);
  assert.equal(calls, 1);
  assert.equal(m.nodes[r.nodeId].status, 'blocked');
  assert.ok(m.nodes[r.nodeId].usage.usd >= 2, 'known cost cannot disappear behind a smaller original reservation');
  assert.ok((await f.broker.diagnostics(f.mission.id)).estimated.usd >= 2);
});

test('independent: cancellation while API awaits prevents subsequent filesystem tool effects', async t => {
  const f = await fixture(t, { desktop: { profile: 'C', enableExecutionBridge: true }, permissions: { tools: ['read_file', 'stage_write'] } });
  const r = await f.broker.request(f.mission.id, 'root', proposal('luna', { budget: { tokens: 20000, usd: 1 } }), 'cancel-before-tools');
  let effects = 0;
  const backend = async () => {
    await f.broker.cancel(f.mission.id, r.nodeId);
    return { id: 'resp_independent_cancel', status: 'completed', text: '', usage: { total: 50 }, estimatedUsd: 0.001,
      calls: [{ name: 'create_stage', call_id: 'call_after_cancel', args: { files: [{ rootId: '0', path: 'source.txt' }] } }] };
  };
  backend.offline = true;
  await new UltraRuntime(f.broker, { backend, boundaryFactory: () => ({ createStage: async () => { effects++; return { id: 'stage' }; } }) }).tick(f.mission.id);
  assert.equal(effects, 0, 'revoked allocation cannot execute a model tool returned after cancellation');
});

test('independent: a completed polled response enters a non-replayable phase before staged side effects', async t => {
  const f = await fixture(t, { desktop: { profile: 'C', enableExecutionBridge: true }, permissions: { tools: ['read_file', 'stage_write'] } });
  const r = await f.broker.request(f.mission.id, 'root', proposal('luna', { budget: { tokens: 20000, usd: 1 } }), 'poll-tools');
  const backend = async name => name === 'create'
    ? { id: 'resp_independent_poll', status: 'in_progress' }
    : { id: 'resp_independent_poll', status: 'completed', text: '', usage: { total: 50 }, estimatedUsd: 0.001,
      calls: [{ name: 'create_stage', call_id: 'call_stage', args: { files: [{ rootId: '0', path: 'source.txt' }] } }] };
  backend.offline = true;
  let recordedPhase = null;
  const runtime = new UltraRuntime(f.broker, { backend, boundaryFactory: () => ({ createStage: async () => {
    recordedPhase = (await f.store.snapshot(f.mission.id)).nodes[r.nodeId].runtime.phase;
    return { id: 'synthetic-stage' };
  } }) });
  await runtime.tick(f.mission.id);
  assert.equal((await f.store.snapshot(f.mission.id)).nodes[r.nodeId].runtime.phase, 'poll');
  await runtime.tick(f.mission.id);
  assert.notEqual(recordedPhase, null, 'fixture must reach its authorised staged operation');
  assert.notEqual(recordedPhase, 'poll', 'restart must not replay a completed response after its first side effect');
});

test('independent: paid HELICOP bootstrap cannot bypass a pending explicit free-to-paid approval', async t => {
  const rules = [{ id: 'free-parent-sol', authority: 'helicop-sol', enabled: true, when: { parentFamilies: ['astra'], childFamilies: ['sol'] }, mandatory: true, veto: true, priority: 50 }];
  const f = await fixture(t, { freeToPaid: { policy: 'C' }, helicop: { rules } });
  const p = await f.broker.request(f.mission.id, 'root', proposal('daily-astrafree'), 'free-parent');
  const r = await f.broker.request(f.mission.id, p.nodeId, proposal('sol'), 'paid-child');
  assert.equal(r.status, 'pending');
  assert.ok(r.evaluation.requiredApprovals.some(a => a.authority === 'user'));
  const backend = async () => { throw new Error('This admission-only fixture must not call the transport'); };
  backend.offline = true;
  await new UltraRuntime(f.broker, { backend }).approvals(f.mission.id);
  const m = await f.store.snapshot(f.mission.id);
  assert.equal(Object.values(m.nodes).filter(n => n.supervises === r.id && n.keyProfile === 'standard').length, 0,
    'a request for permission to spend paid credits must not itself spend paid credits without the required authority');
});

test('independent: default C runtime creates a durable stage without a test-only boundary factory', async t => {
  const project = await mkdtemp(join(await realpath(tmpdir()), 'ultra-runtime-project-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(join(project, 'source.txt'), 'authorised source');
  const f = await fixture(t, { desktop: { profile: 'C', enableExecutionBridge: true }, permissions: { roots: [project], tools: ['read_file', 'stage_write'] } });
  const r = await f.broker.request(f.mission.id, 'root', proposal('luna', { budget: { tokens: 20000, usd: 1 } }), 'actual-stage');
  const backend = async () => ({ id: 'resp_independent_actual_stage', status: 'completed', text: '', usage: { total: 50 }, estimatedUsd: 0.001,
    calls: [{ name: 'create_stage', call_id: 'call_actual_stage', args: { files: [{ rootId: '0', path: 'source.txt' }] } }] });
  backend.offline = true;
  const result = await new UltraRuntime(f.broker, { backend }).tick(f.mission.id);
  assert.equal(result[0].status, 'queued', result[0].reason);
  const m = await f.store.snapshot(f.mission.id);
  const staged = JSON.parse(m.nodes[r.nodeId].runtime.outputs[0].output);
  assert.equal(staged.files[0].path, 'source.txt');
  assert.equal(staged.owner, r.nodeId);
});

test('independent: public Chat recruitment cannot reuse a trusted native mission identity', async t => {
  const f = await fixture(t);
  const native = await f.broker.createMission({ id: 'native-confusion-fixture', task: 'Trusted native mission', orchestrator: { model: 'opus', trusted: true, source: 'native-host' } });
  const backend = async () => { throw new Error('No API call expected'); }; backend.offline = true;
  const service = new UltraService({ config: f.broker.config, store: f.store, backend });
  await assert.rejects(() => service.invoke('ultra_recruit', { mission_id: native.id, worker: 'astra', task: 'Attempt public authority laundering', risk, request_key: 'launder-native' }), /native|surface|channel|public|mission|authority/i);
});

test('independent: workflow caller cannot downgrade the author admission risk floor', async t => {
  const f = await fixture(t);
  const authorId = await completeAuthor(f, { risk: { ...risk, destructive: true, impact: 'high' } });
  const flow = await f.review.start(f.mission.id, { authorId, source: { content: 'high-impact author work' }, risk });
  assert.equal(flow.policy.secondOpinion, true);
  assert.equal(flow.policy.gapReview, true);
});

async function nativeFixture(t, options = {}) {
  const f = await fixture(t, options.config);
  const controller = new NativeController(f.broker, options);
  const transport = { trustedHostChannel: true };
  const init = await controller.handle('ultra_native_init', { sessionId: 'independent-native', model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false }, transport);
  const common = { sessionId: 'independent-native', capability: init.capability };
  const admitted = await controller.handle('ultra_native_admit', { ...common, toolUseId: 'spawn-1', primaryModel: 'opus', subagentType: 'openai-workers:luna',
    prompt: JSON.stringify({ task: 'Independent native fixture', ultra: { risk, budget: { tokens: 20000, usd: 1 } } }) }, transport);
  assert.equal(admitted.allowed, true);
  await controller.handle('ultra_native_bind', { ...common, toolUseId: 'spawn-1', hostAgentId: 'native-agent-1', nodeId: admitted.nodeId }, transport);
  return { ...f, controller, transport, common, nativeMissionId: init.missionId, nodeId: admitted.nodeId };
}

test('independent: native provider overrun remains durably counted when admission is stopped', async t => {
  let calls = 0;
  const backend = async () => { calls++; return { id: 'resp_native_overrun', status: 'completed', model: 'gpt-6-luna', text: 'incurred', usage: { total: 50 }, estimatedUsd: 2 }; }; backend.offline = true;
  const f = await nativeFixture(t, { backend });
  try { await f.controller.handle('ultra_native_create', { ...f.common, hostAgentId: 'native-agent-1', requestKey: 'step-1', input: 'test', max_output_tokens: 1000 }, f.transport); } catch { /* Stopping is expected, forgetting cost is not. */ }
  assert.equal(calls, 1);
  const n = (await f.store.snapshot(f.nativeMissionId)).nodes[f.nodeId];
  assert.ok(n.usage.usd >= 2 || n.native.usage.usd >= 2, 'native known usage cannot be rolled back with an exhausted-allocation error');
  assert.ok((await f.broker.diagnostics(f.nativeMissionId)).estimated.usd >= 2);
});

test('independent: native requests enforce the same per-key API count limit as the shared runtime', async t => {
  let calls = 0;
  const backend = async () => { calls++; return { id: `resp_native_count_${calls}`, status: 'completed', model: 'gpt-6-luna', text: 'done', usage: { total: 50 }, estimatedUsd: 0.001 }; }; backend.offline = true;
  const f = await nativeFixture(t, { backend, config: { mission: { perKey: { standard: { maxTokens: null, maxUsd: null, maxRequests: 1 } } } } });
  await f.controller.handle('ultra_native_create', { ...f.common, hostAgentId: 'native-agent-1', requestKey: 'step-1', input: 'test', max_output_tokens: 1000 }, f.transport);
  await assert.rejects(() => f.controller.handle('ultra_native_create', { ...f.common, hostAgentId: 'native-agent-1', requestKey: 'step-2', previous_response_id: 'resp_native_count_1', input: 'continue', max_output_tokens: 1000 }, f.transport), /request|limit|ceiling|key/i);
  assert.equal(calls, 1);
});

test('independent: native tool intent revalidates a cancelled allocation instead of using a stale snapshot', async t => {
  let effects = 0;
  const backend = async () => { throw new Error('No API call expected'); }; backend.offline = true;
  const f = await nativeFixture(t, { backend, config: { desktop: { profile: 'B' }, permissions: { tools: ['read_file'] } }, boundaryFactory: () => ({ readFile: async () => { effects++; return { content: 'private source' }; } }) });
  const stale = await f.store.snapshot(f.nativeMissionId);
  await f.broker.cancel(f.nativeMissionId, f.nodeId);
  await assert.rejects(() => f.controller.tool(stale, { hostAgentId: 'native-agent-1', toolUseId: 'read-after-cancel', tool: 'mcp__openai-workers__ultra_read_file', input: { rootId: '0', path: 'source.txt' } }), /cancel|lease|running|active|stale/i);
  assert.equal(effects, 0);
});

test('independent: enabled Desktop governance cannot be bypassed through legacy or private direct MCP calls', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ultra-desktop-gates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { OPENAI_ULTRA_STATE_DIR: directory };
  await writeOwnerConfig(resolveConfig({ enabled: true }), env);
  let calls = 0;
  const backend = async () => { calls++; return { id: 'resp_unexpected', status: 'completed', text: 'unexpected' }; };
  await assert.rejects(() => invokeDesktop('ask_openai_worker', { worker: 'astra', task: 'Bypass governed recruitment' }, backend, env), /ULTRA|govern|authority/i);
  const output = [];
  await handleDesktopMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ultra_native_init', arguments: { sessionId: 'spoof', model: 'opus', version: '2.1.326' } } }, chunk => output.push(JSON.parse(chunk)), backend, env);
  assert.equal(output[0].result.isError, true);
  assert.match(output[0].result.content[0].text, /private|native|not available/i);
  assert.equal(calls, 0, 'neither bypass may reach the transport');
});

test('independent: native agent cannot start a second provider request while its first step is unsettled', async t => {
  let calls = 0, release;
  const response = count => ({ id: `resp_native_serial_${count}`, status: 'completed', model: 'gpt-6-luna', text: 'done', usage: { total: 50 }, estimatedUsd: 0.001 });
  const backend = async () => {
    const count = ++calls;
    if (count === 1) return new Promise(resolve => { release = () => resolve(response(count)); });
    return response(count);
  };
  backend.offline = true;
  const f = await nativeFixture(t, { backend });
  const first = f.controller.handle('ultra_native_create', { ...f.common, hostAgentId: 'native-agent-1', requestKey: 'step-1', input: 'first', max_output_tokens: 1000 }, f.transport);
  for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(typeof release, 'function', 'first request must reach the controlled provider');
  let second;
  try { second = await Promise.allSettled([f.controller.handle('ultra_native_create', { ...f.common, hostAgentId: 'native-agent-1', requestKey: 'step-2', input: 'concurrent', max_output_tokens: 1000 }, f.transport)]); }
  finally { release(); await first; }
  assert.equal(second[0].status, 'rejected', 'an unsettled per-agent model step must retain its reservation and block competing continuation');
  assert.equal(calls, 1);
});

test('independent: failed host bootstrap cannot fall back to an ungoverned native API request', async () => {
  const handlers = new Map(), calls = [];
  register((name, filter, handler) => {
    if (!filter?.tool) handlers.set(name, typeof filter === 'function' ? filter : handler);
    return { catch() { return this; } };
  });
  const context = {
    env: { get: async name => { if (name === 'OPENAI_ULTRA_ENABLED') throw new Error('Synthetic host environment read failure'); } },
    agent: { list: async () => [{ id: 'bootstrap-agent', type: 'openai-workers:luna', status: 'running' }] },
    session: { cwd: async () => '/tmp', info: async () => ({ dataRules: [] }), messages: async options => options?.as === 'api' ? [] : [{ role: 'user', text: 'Synthetic source inspection' }] },
    fs: { read: async () => '' },
    state: { get: async () => ({ value: null }), set: async () => {} },
    mcp: { call: async (_server, name) => { calls.push(name); return { content: [{ type: 'text', text: JSON.stringify({ id: 'resp_bootstrap', status: 'completed', text: 'uncontrolled response', usage: { total: 1 }, estimatedUsd: 0.001 }) }] }; } },
  };
  try { await handlers.get('session.start')(context, {}, async value => value); } catch { /* The real host skips a failed initialization hook. */ }
  const next = async function* () { throw new Error('Unexpected model fallback'); };
  const iterator = handlers.get('turn.step')(context, { agentId: 'bootstrap-agent', turnId: 'bootstrap-turn', index: 0, effort: 'max' }, next);
  let output = await iterator.next();
  while (!output.done) output = await iterator.next();
  assert.equal(calls.includes('create'), false, 'unknown host bootstrap state cannot choose the legacy ungoverned API path');
});

test('independent: native project reads protect configured owner policy outside the default state directory', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ultra-native-control-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { OPENAI_ULTRA_ENABLED: '1', OPENAI_ULTRA_STATE_DIR: join(directory, 'state'), OPENAI_ULTRA_CONFIG: join(directory, 'owner-policy.json') };
  await writeOwnerConfig(resolveConfig({ enabled: true, desktop: { profile: 'B', roots: [directory] }, permissions: { roots: [directory], tools: ['read_file'] } }), env);
  const options = { env };
  const initialized = await dispatchNative('ultra_native_init', { sessionId: 'control-path-test', model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false }, options);
  const common = { sessionId: 'control-path-test', capability: initialized.capability };
  const admitted = await dispatchNative('ultra_native_admit', { ...common, toolUseId: 'control-spawn', primaryModel: 'opus', subagentType: 'openai-workers:luna',
    prompt: JSON.stringify({ task: 'Synthetic read-only project inspection', ultra: { risk, budget: { tokens: 1000, usd: 0.05 } } }) }, options);
  assert.equal(admitted.allowed, true);
  await dispatchNative('ultra_native_bind', { ...common, hostAgentId: 'control-agent', nodeId: admitted.nodeId, toolUseId: 'control-spawn' }, options);
  await assert.rejects(() => dispatchNative('ultra_native_tool', { ...common, hostAgentId: 'control-agent', toolUseId: 'control-read',
    tool: 'mcp__openai-workers__ultra_read_file', input: { rootId: '0', path: 'owner-policy.json' } }, options), /control|protect|secret/i);
});

test('independent: supervisory command respects fresh host organization data restrictions', async () => {
  const handlers = new Map(), calls = [];
  register((name, filter, handler) => {
    if (!filter?.tool) handlers.set(`${name}${filter?.command ? `:${filter.command}` : ''}`, typeof filter === 'function' ? filter : handler);
    return { catch() { return this; } };
  });
  let restrictions = [];
  const context = {
    env: { get: async name => name === 'OPENAI_ULTRA_ENABLED' ? '1' : undefined },
    session: { version: async () => ({ version: '2.1.326' }), model: async () => 'opus', id: async () => 'supervisory-restriction-test',
      info: async () => ({ platform: 'linux', isHosted: false, dataRules: restrictions }) },
    tool: { register: async () => {} }, agent: { register: async () => {} }, command: { register: async () => {} },
    mcp: { call: async (_server, name) => { calls.push(name); return { content: [{ type: 'text', text: JSON.stringify(name === 'ultra_native_init' ? { capability: 'a'.repeat(64), missionId: 'synthetic-mission' } : { status: 'synthetic-complete' }) }] }; } },
  };
  await handlers.get('session.start')(context, {}, async value => value);
  restrictions = ['zdr'];
  await handlers.get('command.run:ultra')(context, { args: 'supervise', origin: { kind: 'composer' } });
  assert.equal(calls.includes('ultra_native_supervise'), false, 'an explicit owner command cannot override active host organization data rules');
});

test('independent: runtime refuses substituted provider models while preserving incurred usage', async t => {
  const f = await fixture(t);
  const r = await f.broker.request(f.mission.id, 'root', proposal('luna', { budget: { tokens: 20000, usd: 1 } }), 'model-substitution');
  const backend = async () => ({ id: 'resp_substituted_model', status: 'completed', model: 'unclassified-unapproved-model', text: 'Output from the wrong provider model', usage: { total: 50 }, estimatedUsd: 0.001, calls: [] });
  backend.offline = true;
  await new UltraRuntime(f.broker, { backend }).tick(f.mission.id);
  const n = (await f.store.snapshot(f.mission.id)).nodes[r.nodeId];
  assert.equal(n.status, 'blocked', 'provider model substitution cannot silently satisfy approved work');
  assert.equal(n.usage.tokens, 50, 'rejecting substituted results must not erase billed usage');
});

test('independent: protected native primary cannot use shell or an unrestricted Claude intermediary', async t => {
  const f = await fixture(t), controller = new NativeController(f.broker);
  const handlers = new Map();
  register((name, filter, handler) => { if (!filter?.tool) handlers.set(name, typeof filter === 'function' ? filter : handler); return { catch() { return this; } }; });
  const context = {
    env: { get: async name => name === 'OPENAI_ULTRA_ENABLED' ? '1' : undefined },
    session: { version: async () => ({ version: '2.1.326' }), model: async () => 'haiku', id: async () => 'primary-guard-test', info: async () => ({ platform: 'linux', isHosted: false, dataRules: [] }) },
    agent: { register: async () => {}, list: async () => [] }, tool: { register: async () => {} }, command: { register: async () => {} },
    mcp: { call: async (_server, name, args) => ({ content: [{ type: 'text', text: JSON.stringify(await controller.handle(name, args, { trustedHostChannel: true })) }] }) },
  };
  await handlers.get('session.start')(context, {}, async value => value);
  for (const tool of ['Bash', 'Read', 'Edit', 'Write', 'mcp__other__execute']) {
    let decision;
    try { decision = await handlers.get('tool.check')(context, { tool, input: {}, tool_use_id: `blocked-${tool}` }, async () => ({ decision: 'allow' })); }
    catch (error) { assert.match(error.message, /tool|scope|bound|root|principal|protect|allocat/i); continue; }
    assert.equal(decision.decision, 'deny', `Primary ${tool} must not bypass the governed boundary`);
  }
  let spawns = 0;
  const rejected = await handlers.get('agent.spawn')(context, { subagentType: 'general-purpose', tool_use_id: 'unrestricted-intermediary', prompt: 'Synthetic attempted authority laundering' }, async value => { spawns++; return { ...value, agentId: 'uncontrolled-child' }; });
  assert.ok(rejected.deny, 'a primary cannot create an unrestricted Claude intermediary');
  assert.equal(spawns, 0);
});

test('independent: Code Mode REPL has exact guarded registrations because wildcard host hooks omit it', () => {
  const registrations = [];
  register((event, filter, handler) => {
    const entry = { event, filter: typeof filter === 'function' ? null : filter, handler: typeof filter === 'function' ? filter : handler };
    registrations.push(entry);
    return { catch(handler) { entry.fallback = handler; return this; } };
  });
  for (const event of ['tool.check', 'tool.run']) {
    const guard = registrations.find(r => r.event === event && r.filter?.tool === 'REPL');
    assert.ok(guard, `${event} needs an exact REPL matcher under the supported host declaration contract`);
    assert.equal(typeof guard.fallback, 'function', 'the exact guard must also fail closed on host timeout or exception');
  }
});

test('independent: effective root host model outranks configured alias and survives descendant admission', async t => {
  const f = await nativeFixture(t, { config: { recruitment: { mode: 'SKYNET' } } });
  const prompt = JSON.stringify({ task: 'Bounded Sol recruitment after actual Haiku turn', ultra: { risk, budget: { tokens: 1000, usd: 0.05 } } });
  const rootRequest = await f.controller.handle('ultra_native_admit', { ...f.common, toolUseId: 'effective-haiku-root', parentModel: 'haiku', primaryModel: 'opus', subagentType: 'openai-workers:sol', prompt }, f.transport);
  assert.equal(rootRequest.allowed, false, 'pinned effective Haiku model cannot inherit a configured Opus label');
  assert.ok(rootRequest.requiredApprovals.some(a => a.authority === 'helicop-sol'));
  const childRequest = await f.controller.handle('ultra_native_admit', { ...f.common, toolUseId: 'effective-haiku-descendant', parentAgentId: 'native-agent-1', parentModel: 'opus', primaryModel: 'opus', subagentType: 'openai-workers:sol', prompt }, f.transport);
  assert.equal(childRequest.allowed, false, 'descendant placeholder/configured model cannot upgrade the recorded root authority');
  assert.ok(childRequest.requiredApprovals.some(a => a.authority === 'helicop-sol'));
});
