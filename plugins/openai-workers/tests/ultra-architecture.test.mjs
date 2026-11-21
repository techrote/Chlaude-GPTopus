// Independent architecture regressions. This test author implemented none of ULTRA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionStore } from '../ultra/store.mjs';
import { RecruitmentBroker } from '../ultra/broker.mjs';
import { UltraRuntime } from '../ultra/runtime.mjs';
import { ReviewController } from '../ultra/review.mjs';
import { ActionGate } from '../ultra/actions.mjs';

const risk = { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 0.95, reversibility: 'reversible', testsAvailable: true };
const proposal = (worker = 'luna', extra = {}) => ({ worker, task: 'Independent synthetic architecture fixture', risk, budget: { tokens: 20000, usd: 1 }, ...extra });
async function fixture(t, config = {}, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ultra-architecture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ExecutionStore(join(directory, 'ledger.json'));
  const broker = new RecruitmentBroker(store, { config: { enabled: true, ...config }, ...options });
  const mission = await broker.createMission({ task: 'Architecture acceptance fixture', orchestrator: { model: 'opus', trusted: true, source: 'synthetic-host' } });
  return { directory, store, broker, mission, reviews: new ReviewController(broker), actions: new ActionGate(broker) };
}
async function complete(f, nodeId, result = 'synthetic completion', usage = { tokens: 50, usd: 0.001 }) {
  const n = await f.broker.claim(f.mission.id, 'architecture-test', { nodeId });
  assert.ok(n, `Expected allocated agent ${nodeId} to be claimable`);
  return f.broker.finish(f.mission.id, n.id, { lease: n.lease.token, result, usage });
}
const passedReview = () => ({ findings: [], coverage: [{ area: 'synthetic source', status: 'examined', notes: 'Deterministic fixture inspection' }] });
async function reviewRequiringFix(f, workflowId, message = 'Consequential synthetic defect') {
  const assignment = (await f.reviews.assign(f.mission.id, workflowId))[0];
  await complete(f, assignment.nodeId);
  return f.reviews.submit(f.mission.id, workflowId, assignment.nodeId, assignment.sourceHash, {
    findings: [{ severity: 'high', area: 'synthetic source', message }], coverage: passedReview().coverage,
  });
}
async function revised(f, workflowId, source) {
  const allocation = (await f.reviews.assign(f.mission.id, workflowId))[0];
  await complete(f, allocation.nodeId);
  return f.reviews.revisedSource(f.mission.id, workflowId, allocation.nodeId, source);
}

test('architecture: mission wall-clock expiry blocks a new API POST from an already allocated agent', async t => {
  let now = 100;
  const f = await fixture(t, { mission: { maxWallMs: 10 } }, { now: () => now });
  await f.broker.request(f.mission.id, 'root', proposal(), 'allocated-before-deadline');
  now = 111;
  let calls = 0;
  const backend = async () => { calls++; return { id: 'resp_arch_expiry', status: 'completed', text: 'late', usage: { total: 50 }, estimatedUsd: 0.001, calls: [] }; };
  backend.offline = true;
  try { await new UltraRuntime(f.broker, { backend }).tick(f.mission.id); } catch (error) { assert.match(error.message, /wall|expired|deadline|budget/i); }
  assert.equal(calls, 0, 'An allocation made before expiry cannot authorise later API spending');
});

test('architecture: an incurred peer overrun stops already allocated peers from issuing new API POSTs', async t => {
  const f = await fixture(t, { mission: { maxUsd: 2 } });
  const first = await f.broker.request(f.mission.id, 'root', proposal(), 'peer-one');
  await f.broker.request(f.mission.id, 'root', proposal(), 'peer-two');
  await complete(f, first.nodeId, 'verified provider overrun', { tokens: 50, usd: 2 });
  let calls = 0;
  const backend = async () => { calls++; return { id: 'resp_arch_peer', status: 'completed', text: 'extra', usage: { total: 50 }, estimatedUsd: 0.001, calls: [] }; };
  backend.offline = true;
  try { await new UltraRuntime(f.broker, { backend }).tick(f.mission.id); } catch (error) { assert.match(error.message, /budget|ceiling|limit/i); }
  assert.equal(calls, 0, 'Shared mission spending guards must be checked again at the actual API boundary');
});

test('architecture: a stricter worker recruitment default survives a more permissive parent', async t => {
  const f = await fixture(t, { recruitment: { mode: 'SKYNET' }, workers: { luna: { mode: 'SWARM' } } });
  const parent = await f.broker.request(f.mission.id, 'root', proposal('sol', { mode: 'SKYNET' }), 'skynet-parent');
  const child = await f.broker.request(f.mission.id, parent.nodeId, proposal('luna'), 'swarm-child');
  assert.equal(child.evaluation.mode, 'SWARM');
  assert.equal(child.evaluation.effectivePermissions.recruit.higher, false);
  assert.equal(child.evaluation.effectivePermissions.recruit.equal, false);
});

test('architecture: a passing smoke test cannot mask a failed required test on the same source', async t => {
  const f = await fixture(t, { review: { secondOpinionImpacts: [], gapInspectionImpacts: [] } });
  const author = await f.broker.request(f.mission.id, 'root', proposal('luna', { risk: { ...risk, impact: 'high' } }), 'author');
  await complete(f, author.nodeId);
  const flow = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'function cleanup() { /* synthetic */ }' }, risk: { ...risk, impact: 'high' } });
  const primary = (await f.reviews.assign(f.mission.id, flow.id))[0];
  await complete(f, primary.nodeId);
  await f.reviews.submit(f.mission.id, flow.id, primary.nodeId, flow.source.hash, passedReview());
  await f.reviews.recordTest(f.mission.id, flow.id, { sourceHash: flow.source.hash, name: 'smoke', passed: true, details: 'Syntax fixture passed' }, { trusted: true, source: 'test-runner' });
  await f.reviews.recordTest(f.mission.id, flow.id, { sourceHash: flow.source.hash, name: 'protected-files', passed: false, details: 'Protected file fixture failed' }, { trusted: true, source: 'test-runner' });
  const judge = (await f.reviews.assign(f.mission.id, flow.id))[0];
  await complete(f, judge.nodeId);
  const verdict = await f.reviews.submit(f.mission.id, flow.id, judge.nodeId, flow.source.hash, passedReview());
  assert.notEqual(verdict.status, 'code_approved', 'Known failing verification must be surfaced and resolved before acceptance');
});

test('architecture: an execution gate cannot relabel deletion as an existing read capability', async t => {
  const f = await fixture(t, { permissions: { tools: ['read_file'] } });
  const worker = await f.broker.request(f.mission.id, 'root', proposal(), 'read-only-implementation');
  const action = { kind: 'delete', description: 'Synthetic explicit deletion proposal', path: 'valuable.txt' };
  const request = await f.actions.propose(f.mission.id, worker.nodeId, action);
  await f.actions.decide(f.mission.id, request.id, { approved: true, actionHash: request.hash, rationale: 'Synthetic human approval' }, { trusted: true, source: 'local-user', authority: 'user' });
  await assert.rejects(() => f.actions.consume(f.mission.id, request.id, action, { nodeId: worker.nodeId, capability: 'read_file' }), /capabil|permission|delete|kind|execution/i);
});

test('architecture: a free author cannot move paid review recruitment to root to evade policy C', async t => {
  const f = await fixture(t, { freeToPaid: { policy: 'C' }, review: { secondOpinionImpacts: [], gapInspectionImpacts: [] } });
  const author = await f.broker.request(f.mission.id, 'root', proposal('daily-astrafree'), 'free-author');
  await complete(f, author.nodeId);
  const flow = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'Synthetic free-key authored source' }, risk });
  const assignments = await f.reviews.assign(f.mission.id, flow.id);
  const m = await f.store.snapshot(f.mission.id);
  assert.equal(assignments.filter(a => a.nodeId && m.nodes[a.nodeId].keyProfile === 'standard').length, 0, 'A controller-mediated paid review still requires the originating free-to-paid authority');
  assert.ok(assignments.some(a => m.requests[a.requestId].evaluation.requiredApprovals.some(q => q.authority === 'user')));
});

test('architecture: an author cannot omit the configured Policy C reviewer-selection gate', async t => {
  const f = await fixture(t, { review: { selection: 'C' } });
  const author = await f.broker.request(f.mission.id, 'root', proposal('luna'), 'review-selection-author');
  const review = await f.broker.request(f.mission.id, author.nodeId, proposal('astra', { role: 'reviewer' }), 'author-recommended-reviewer');
  assert.equal(review.status, 'pending');
  assert.ok(review.evaluation.requiredApprovals.some(a => a.authority === 'helicop-sol' || a.authority === 'helicop-astra'), 'Stored reviewer-selection policy must require an authorised HELICOP regardless of omitted caller metadata');
});

test('architecture: restricted orchestrator authority survives recruitment through a lower-tier intermediary', async t => {
  for (const [model, trusted, authority] of [['haiku', true, 'helicop-sol'], ['sonnet', true, 'helicop-sol'], ['unknown', false, 'user']]) {
    const f = await fixture(t, { recruitment: { mode: 'SKYNET' } });
    const m = await f.broker.createMission({ task: `Restricted ${model} delegation fixture`, orchestrator: { model, trusted, source: 'synthetic-host' } });
    const parent = await f.broker.request(m.id, 'root', proposal('luna', { mode: 'SKYNET' }), `intermediary-${model}`);
    assert.ok(parent.nodeId, 'Routine recruitment should remain available to the restricted orchestrator');
    const restricted = await f.broker.request(m.id, parent.nodeId, proposal('sol'), `restricted-${model}`);
    assert.equal(restricted.status, 'pending', `${model} cannot bypass its restricted-family gate by asking Luna to recruit Sol`);
    assert.ok(restricted.evaluation.requiredApprovals.some(a => a.authority === authority), 'The root mission authority remains binding through every generation');
  }
});

test('architecture: changing evidence metadata alone cannot reset no-progress detection', async t => {
  const f = await fixture(t);
  const author = await f.broker.request(f.mission.id, 'root', proposal(), 'no-progress-author');
  await complete(f, author.nodeId);
  const flow = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'unchanged implementation', evidence: 'attempt one' }, risk });
  await reviewRequiringFix(f, flow.id);
  const result = await revised(f, flow.id, { content: 'unchanged implementation', evidence: 'attempt two' });
  assert.equal(result.status, 'held', 'Evidence provenance must change review freshness without pretending unchanged implementation has progressed');
  assert.match(result.reason, /no.*(?:meaningful|progress)|unchanged/i);
});

test('architecture: metadata changes cannot conceal implementation oscillation', async t => {
  const f = await fixture(t);
  const author = await f.broker.request(f.mission.id, 'root', proposal(), 'oscillation-author');
  await complete(f, author.nodeId);
  const flow = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'implementation A', evidence: 'first observation' }, risk });
  await reviewRequiringFix(f, flow.id, 'Defect in A');
  await revised(f, flow.id, { content: 'implementation B', evidence: 'second observation' });
  await reviewRequiringFix(f, flow.id, 'Defect in B');
  const result = await revised(f, flow.id, { content: 'implementation A', evidence: 'third observation' });
  assert.equal(result.status, 'held', 'A new evidence hash cannot conceal returning to previously rejected code');
  assert.match(result.reason, /oscillation/i);
});

test('architecture: configured repeated-defect threshold controls the actual review workflow', async t => {
  const f = await fixture(t, { review: { maxRounds: 4, repeatedDefectLimit: 3 } });
  const author = await f.broker.request(f.mission.id, 'root', proposal(), 'repeat-author');
  await complete(f, author.nodeId);
  const flow = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'implementation v1' }, risk });
  await reviewRequiringFix(f, flow.id, 'Same defect');
  await revised(f, flow.id, { content: 'implementation v2' });
  const second = await reviewRequiringFix(f, flow.id, 'Same defect');
  assert.equal(second.status, 'rework', 'An explicit threshold of three permits the second defect recurrence within round and budget limits');
  await revised(f, flow.id, { content: 'implementation v3' });
  const third = await reviewRequiringFix(f, flow.id, 'Same defect');
  assert.equal(third.status, 'held');
  assert.match(third.reason, /repeated/i);
});

test('architecture: configured no-progress threshold allows only its bounded number of rework attempts', async t => {
  const f = await fixture(t, { review: { noProgressLimit: 2 } });
  const author = await f.broker.request(f.mission.id, 'root', proposal(), 'bounded-no-progress-author');
  await complete(f, author.nodeId);
  const flow = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'unchanged implementation' }, risk });
  await reviewRequiringFix(f, flow.id);
  const first = await revised(f, flow.id, { content: 'unchanged implementation', evidence: 'attempt one' });
  assert.equal(first.status, 'rework');
  const second = await revised(f, flow.id, { content: 'unchanged implementation', evidence: 'attempt two' });
  assert.equal(second.status, 'held');
  assert.match(second.reason, /no meaningful source change/i);
});

test('architecture: informed second opinions and author-context gap reuse change actual allocations and provider input', async t => {
  const f = await fixture(t, { review: { secondOpinionImpacts: ['low'], gapInspectionImpacts: ['low'], blindSecondOpinion: false, freshGapInspector: false } });
  const author = await f.broker.request(f.mission.id, 'root', proposal(), 'reused-author');
  const calls = [];
  const backend = async (method, args) => {
    assert.equal(method, 'create'); calls.push(args);
    return { id: calls.length === 1 ? 'resp_arch_author_context' : 'resp_arch_gap_context', status: 'completed', text: calls.length === 1 ? 'synthetic source' : JSON.stringify(passedReview()), usage: { total: 50 }, estimatedUsd: 0.001, calls: [] };
  };
  backend.offline = true;
  const runtime = new UltraRuntime(f.broker, { backend });
  await runtime.tick(f.mission.id);
  const flow = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'synthetic source' }, risk });
  const initial = await f.reviews.assign(f.mission.id, flow.id);
  assert.deepEqual(initial.map(a => a.role), ['reviewer'], 'An informed second opinion must wait for the primary conclusions');
  await complete(f, initial[0].nodeId);
  await f.reviews.submit(f.mission.id, flow.id, initial[0].nodeId, flow.source.hash, { ...passedReview(), summary: 'Primary review evidence marker' });
  const second = (await f.reviews.assign(f.mission.id, flow.id)).find(a => a.role === 'second_opinion');
  let m = await f.store.snapshot(f.mission.id);
  assert.equal(JSON.parse(m.nodes[second.nodeId].task).priorReviews[0].summary, 'Primary review evidence marker');
  await complete(f, second.nodeId);
  await f.reviews.submit(f.mission.id, flow.id, second.nodeId, flow.source.hash, passedReview());
  const gap = (await f.reviews.assign(f.mission.id, flow.id))[0];
  m = await f.store.snapshot(f.mission.id);
  const gapNode = m.nodes[gap.nodeId];
  assert.notEqual(gap.nodeId, author.nodeId, 'Role-specific accounting and capabilities require a separate Review allocation');
  assert.equal(gapNode.worker, 'luna');
  assert.equal(gapNode.pool, 'review');
  assert.equal(gapNode.runtime.reusedAuthorId, author.nodeId);
  assert.deepEqual(gapNode.permissions.tools, []);
  await runtime.tick(f.mission.id);
  assert.equal(calls[1].previous_response_id, 'resp_arch_author_context', 'The configured reuse must continue the actual provider conversation');
  assert.deepEqual(calls[1].tools, [], 'Reused author context cannot restore its implementation tools');
  m = await f.store.snapshot(f.mission.id);
  assert.equal(m.workflows[flow.id].status, 'adjudication', 'A successful gap inspection still needs senior adjudication');
});

test('architecture: risk-based approval and always-approval have distinct isolated-test behavior', async t => {
  for (const [defaultApproval, expected] of [['risk-based', 'approved'], ['always', 'pending']]) {
    const f = await fixture(t, { permissions: { tools: ['run_test'] }, execution: { defaultApproval } });
    const worker = await f.broker.request(f.mission.id, 'root', proposal(), `testing-${defaultApproval}`);
    const testAction = await f.actions.propose(f.mission.id, worker.nodeId, { kind: 'test', description: 'Exact synthetic isolated test', isolated: true, risk });
    assert.equal(testAction.status, expected);
    const command = await f.actions.propose(f.mission.id, worker.nodeId, { kind: 'command', description: 'Exact synthetic command', isolated: true, risk });
    assert.equal(command.status, 'pending', 'Low-risk labels cannot automatically authorise a general command');
  }
});

test('architecture: a revised controller request retains its spending authority and workflow assignment', async t => {
  const f = await fixture(t, { freeToPaid: { policy: 'C' } });
  const author = await f.broker.request(f.mission.id, 'root', proposal('daily-astrafree'), 'revision-free-author');
  await complete(f, author.nodeId);
  const flow = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'source authored using the free key' }, risk });
  const assignment = (await f.reviews.assign(f.mission.id, flow.id))[0];
  await f.broker.decide(f.mission.id, assignment.requestId, { decision: 'REJECT', rationale: 'Synthetic owner asks for revised scope' }, { trusted: true, source: 'local-user', authority: 'user' });
  const revisedRequest = await f.broker.revise(f.mission.id, assignment.requestId, 'root', { budget: { tokens: 16000, usd: 1 } }, 'revised-paid-review');
  assert.equal(revisedRequest.status, 'pending', 'Revision cannot silently discard the originating free-to-paid gate');
  assert.equal(revisedRequest.originId, author.nodeId);
  assert.ok(revisedRequest.evaluation.requiredApprovals.some(a => a.authority === 'user'));
  const approved = await f.broker.decide(f.mission.id, revisedRequest.id, { decision: 'APPROVE', rationale: 'Owner approves revised review allocation' }, { trusted: true, source: 'local-user', authority: 'user' });
  await complete(f, approved.nodeId);
  const result = await f.reviews.submit(f.mission.id, flow.id, approved.nodeId, flow.source.hash, passedReview());
  assert.equal(result.status, 'adjudication', 'A revised allocation must stay attached to the source-bound workflow it was recruited for');
});

test('architecture: protected supervisor allocations retain the exact configured processing tier', async t => {
  const f = await fixture(t, { recruitment: { mode: 'REPLICATOR' }, workers: { sol: { serviceTier: 'flex' } } });
  const parent = await f.broker.request(f.mission.id, 'root', proposal('sol'), 'tier-parent');
  const peer = await f.broker.request(f.mission.id, parent.nodeId, proposal('sol'), 'tier-peer');
  const supervisor = await f.broker.appointSupervisor(f.mission.id, peer.id, 'helicop-sol');
  assert.equal(supervisor.serviceTier, 'flex', 'Protected allocation must not silently discard the configured processing tier');
});

test('architecture: bounded future plans cannot waive a mandatory supervisor veto', async t => {
  const f = await fixture(t, { helicop: { rules: [{ id: 'planned-astra-review', enabled: true, authority: 'helicop-sol', mandatory: true, veto: true, priority: 50, when: { childFamilies: ['astra'] } }] } });
  f.mission = await f.broker.createMission({ task: 'Restricted future plan', orchestrator: { model: 'unknown', trusted: false } });
  const plan = await f.broker.grantPlan(f.mission.id, { parentId: 'root', workers: ['astra'], roles: ['implementation'], maxInvocations: 1, budget: { tokens: 20000, usd: 1 }, acknowledgeFutureRecruitment: true }, { source: 'local-user', trusted: true, authority: 'user' });
  const request = await f.broker.request(f.mission.id, 'root', proposal('astra', { planId: plan.id }), 'planned-approval');
  assert.equal(request.status, 'pending', 'A prior owner plan can satisfy its user gate while leaving independent HELICOP requirements pending');
  const supervisor = await f.broker.appointSupervisor(f.mission.id, request.id, 'helicop-sol');
  await complete(f, supervisor.id);
  const decision = await f.broker.decide(f.mission.id, request.id, { decision: 'REJECT', rationale: 'Independent supervisor veto' }, { source: 'supervisor', trusted: true, authority: 'helicop-sol', nodeId: supervisor.id });
  assert.equal(decision.status, 'rejected');
  assert.equal(decision.nodeId, null);
});

test('architecture: future-plan budgets are atomic across concurrent requests and expire without replay', async t => {
  let now = 100;
  const f = await fixture(t, {}, { now: () => now });
  const grant = { parentId: 'root', workers: ['luna'], roles: ['implementation'], maxInvocations: 2, budget: { tokens: 30000, usd: 1 }, ttlMs: 10, acknowledgeFutureRecruitment: true };
  const user = { source: 'local-user', trusted: true, authority: 'user' };
  const plan = await f.broker.grantPlan(f.mission.id, grant, user);
  const attempts = await Promise.allSettled(['plan-one', 'plan-two'].map(key => f.broker.request(f.mission.id, 'root', proposal('luna', { planId: plan.id }), key)));
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1, 'Concurrent users cannot independently spend the same plan budget');
  const accepted = attempts.find(a => a.status === 'fulfilled').value;
  const successfulKey = attempts[0].status === 'fulfilled' ? 'plan-one' : 'plan-two';
  assert.equal((await f.broker.request(f.mission.id, 'root', proposal('luna', { planId: plan.id }), successfulKey)).id, accepted.id);
  const fresh = await f.broker.grantPlan(f.mission.id, grant, user);
  now = 111;
  await assert.rejects(() => f.broker.request(f.mission.id, 'root', proposal('luna', { planId: fresh.id }), 'expired-plan'), /expired/);
  const m = await f.store.snapshot(f.mission.id);
  assert.equal(m.plans[plan.id].remaining, 1);
  assert.deepEqual(m.plans[plan.id].remainingBudget, { tokens: 10000, usd: 0 });
});

test('architecture: advisory consultation still requires a separate trusted final decision and preserves mandatory vetoes', async t => {
  for (const mandatory of [false, true]) {
    const config = { authority: { profiles: { sonnet: { final: false } } }, ...(mandatory ? { helicop: { rules: [{ id: 'mandatory-sol', enabled: true, authority: 'helicop-sol', mandatory: true, veto: true, priority: 50, when: { childFamilies: ['sol'] } }] } } : {}) };
    const f = await fixture(t, config);
    f.mission = await f.broker.createMission({ task: 'Configured advisory consultation', orchestrator: { model: 'sonnet', trusted: true, source: 'synthetic-host' } });
    const request = await f.broker.request(f.mission.id, 'root', proposal('sol'), 'advisory-recruitment');
    const afterFinal = await f.broker.decide(f.mission.id, request.id, { decision: 'APPROVE', rationale: 'Separate trusted final decision' }, { source: 'native-host', trusted: true, authority: 'trusted-orchestrator' });
    assert.equal(afterFinal.status, 'pending', 'A final authority cannot skip the required consultation');
    const supervisor = await f.broker.appointSupervisor(f.mission.id, request.id, 'helicop-sol');
    await complete(f, supervisor.id);
    const result = await f.broker.decide(f.mission.id, request.id, { decision: 'REJECT', rationale: 'Supervisor recommends rejection' }, { source: 'supervisor', trusted: true, authority: 'helicop-sol', nodeId: supervisor.id });
    assert.equal(result.status, mandatory ? 'rejected' : 'queued', 'An explicitly advisory opinion cannot waive a separate mandatory requirement from the same supervisor');
    const m = await f.store.snapshot(f.mission.id);
    assert.equal(m.approvals[result.approvals.at(-1)].decision, 'REJECT', 'The original advisory conclusion must remain auditable');
  }
});

test('architecture: a higher-tier child can inherit SWARM without invalidating its parent SKYNET request', async t => {
  const f = await fixture(t, { recruitment: { mode: 'SKYNET' }, workers: { astra: { mode: 'SWARM' } } });
  const parent = await f.broker.request(f.mission.id, 'root', proposal('sol'), 'skynet-sol');
  const child = await f.broker.request(f.mission.id, parent.nodeId, proposal('astra'), 'bounded-astra');
  assert.equal(child.status, 'pending', 'The valid parent edge should reach its HELICOP gate');
  assert.equal(child.evaluation.mode, 'SWARM');
  assert.deepEqual(child.evaluation.effectivePermissions.recruit, { lower: true, equal: false, higher: false });
});

test('architecture: a mandatory modification remains actionable when the same supervisor also supplies consultation', async t => {
  const f = await fixture(t, { authority: { profiles: { sonnet: { final: false } } }, helicop: { rules: [{ id: 'mandatory-sol-modification', enabled: true, authority: 'helicop-sol', mandatory: true, veto: true, priority: 50, when: { childFamilies: ['sol'] } }] } });
  f.mission = await f.broker.createMission({ task: 'Advisory and mandatory supervisor roles', orchestrator: { model: 'sonnet', trusted: true, source: 'synthetic-host' } });
  const request = await f.broker.request(f.mission.id, 'root', proposal('sol'), 'combined-modification');
  const supervisor = await f.broker.appointSupervisor(f.mission.id, request.id, 'helicop-sol');
  await complete(f, supervisor.id);
  // The separate trusted final decision is itself a blocking gate (its REJECT would outrank a MODIFY), so the verdict is
  // only settled once it has answered; approval verdicts are independent of arrival order.
  const early = await f.broker.decide(f.mission.id, request.id, { decision: 'APPROVE', rationale: 'Separate trusted final decision' }, { source: 'native-host', trusted: true, authority: 'trusted-orchestrator' });
  assert.equal(early.status, 'pending', 'an unanswered mandatory Sol gate still holds the request');
  const result = await f.broker.decide(f.mission.id, request.id, { decision: 'MODIFY', rationale: 'The required gate needs a reduced scope', modification: { budget: { tokens: 10000, usd: 0.5 } } }, { source: 'supervisor', trusted: true, authority: 'helicop-sol', nodeId: supervisor.id });
  assert.equal(result.status, 'modify', 'Mandatory MODIFY must expose bounded revision instead of leaving an already-voted request stuck pending');
  assert.equal(result.nodeId, null);
});

test('architecture: the final code judge receives trusted source-bound test evidence', async t => {
  const f = await fixture(t, { review: { secondOpinionImpacts: [], gapInspectionImpacts: [] } });
  const highRisk = { ...risk, impact: 'high' };
  const author = await f.broker.request(f.mission.id, 'root', proposal('luna', { risk: highRisk }), 'evidence-author');
  await complete(f, author.nodeId);
  const flow = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'reviewed source' }, risk: highRisk });
  const reviewer = (await f.reviews.assign(f.mission.id, flow.id))[0];
  await complete(f, reviewer.nodeId);
  await f.reviews.submit(f.mission.id, flow.id, reviewer.nodeId, flow.source.hash, passedReview());
  const marker = 'Trusted boundary verification evidence 6b54de';
  await f.reviews.recordTest(f.mission.id, flow.id, { name: 'independent-boundary-test', sourceHash: flow.source.hash, passed: true, details: marker }, { trusted: true, source: 'test-runner' });
  const judge = (await f.reviews.assign(f.mission.id, flow.id))[0];
  const m = await f.store.snapshot(f.mission.id);
  assert.ok(m.nodes[judge.nodeId].task.includes(marker), 'Test evidence stored by a trusted runner must reach the actual adjudicator, not only an internal pass/fail counter');
});

test('architecture: in-flight reviews cannot revive a workflow invalidated by a new higher-risk classification', async t => {
  const f = await fixture(t);
  const author = await f.broker.request(f.mission.id, 'root', proposal(), 'risk-changed-author');
  await complete(f, author.nodeId);
  const flow = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'source with newly discovered consequences' }, risk });
  const oldReview = (await f.reviews.assign(f.mission.id, flow.id))[0];
  await f.broker.overrideRisk(f.mission.id, author.nodeId, { ...risk, impact: 'high' }, { rationale: 'Owner discovered destructive consequences', ttlMs: 60000 }, { trusted: true, source: 'local-user', authority: 'user' });
  await complete(f, oldReview.nodeId);
  await assert.rejects(() => f.reviews.submit(f.mission.id, flow.id, oldReview.nodeId, flow.source.hash, passedReview()), /risk|stale|classif|held|changed/i);
  const m = await f.store.snapshot(f.mission.id);
  assert.equal(m.workflows[flow.id].status, 'held');
});

test('architecture: scoped risk override is authenticated, expires at execution and leaves resources unchanged', async t => {
  let now = 100;
  const f = await fixture(t, { permissions: { tools: ['delete'] } }, { now: () => now });
  const author = await f.broker.request(f.mission.id, 'root', proposal('luna', { risk: { ...risk, impact: 'high' } }), 'risk-override-author');
  await complete(f, author.nodeId);
  const before = (await f.store.snapshot(f.mission.id)).nodes[author.nodeId];
  const grant = { rationale: 'Owner reviewed the exact synthetic task and narrowed its consequence', ttlMs: 10 };
  await assert.rejects(() => f.broker.overrideRisk(f.mission.id, author.nodeId, risk, grant, { trusted: true, source: 'worker', authority: 'user' }), /authority/i);
  const override = await f.broker.overrideRisk(f.mission.id, author.nodeId, risk, grant, { trusted: true, source: 'local-user', authority: 'user' });
  assert.equal(override.nodeId, author.nodeId);
  assert.equal(override.original.effectiveImpact, 'high');
  assert.equal(override.assessment.effectiveImpact, 'low');
  const flow = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'source bound to an expiring risk grant' } });
  assert.equal(flow.assessment.effectiveImpact, 'low');
  for (const role of ['reviewer', 'judge']) {
    const assignment = (await f.reviews.assign(f.mission.id, flow.id))[0];
    assert.equal(assignment.role, role);
    await complete(f, assignment.nodeId);
    await f.reviews.submit(f.mission.id, flow.id, assignment.nodeId, flow.source.hash, passedReview());
  }
  const action = { kind: 'delete', description: 'Synthetic consequential action, never executed', workflowId: flow.id, sourceHash: flow.source.hash, path: 'synthetic-only.txt' };
  const proposed = await f.actions.propose(f.mission.id, author.nodeId, action);
  await f.actions.decide(f.mission.id, proposed.id, { approved: true, actionHash: proposed.hash, rationale: 'Synthetic exact action authority' }, { source: 'local-user', trusted: true, authority: 'user' });
  now = 111;
  await assert.rejects(() => f.actions.consume(f.mission.id, proposed.id, action, { nodeId: author.nodeId, capability: 'delete' }), /risk.*(?:expired|changed)|fresh review/i);
  const fresh = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'same source after grant expiry' } });
  assert.equal(fresh.assessment.effectiveImpact, 'high');
  assert.equal(fresh.policy.secondOpinion, true);
  assert.equal(fresh.policy.gapReview, true);
  const after = (await f.store.snapshot(f.mission.id)).nodes[author.nodeId];
  for (const field of ['permissions', 'allocation', 'usage', 'reservation']) assert.deepEqual(after[field], before[field], `Risk authority cannot mutate ${field}`);
});

test('architecture: per-assignment Policy B choice is pinned by trusted root and cannot downgrade mission C', async t => {
  const f = await fixture(t);
  const choice = { reviewerPolicy: { selection: 'B', primary: 'sol' } };
  const author = await f.broker.request(f.mission.id, 'root', proposal(), 'task-reviewer-author', choice);
  await assert.rejects(() => f.broker.request(f.mission.id, author.nodeId, proposal('daily-terrafree'), 'worker-reviewer-override', choice), /trusted root|reviewer/i);
  await complete(f, author.nodeId);
  const flow = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'source with preassigned reviewer' }, risk });
  assert.equal(flow.policy.reviewer, 'sol');
  const actual = (await f.reviews.assign(f.mission.id, flow.id))[0];
  assert.equal(actual.worker, 'sol');
  const unknown = await f.broker.createMission({ task: 'Unverified reviewer selection', orchestrator: { model: 'unknown', trusted: false } });
  await assert.rejects(() => f.broker.request(unknown.id, 'root', proposal(), 'unverified-reviewer-override', choice), /trusted root|reviewer/i);
  const c = await fixture(t, { review: { selection: 'C' } });
  await assert.rejects(() => c.broker.request(c.mission.id, 'root', proposal(), 'mandatory-c-override', choice), /mission Policy C|bypass/i);
});

test('architecture: late trusted tests trigger bounded fresh adjudication and stale approvals remain unusable', async t => {
  const f = await fixture(t, { mission: { maxRetries: 1 }, review: { secondOpinionImpacts: [], gapInspectionImpacts: [] } });
  const highRisk = { ...risk, impact: 'high' };
  const author = await f.broker.request(f.mission.id, 'root', proposal('luna', { risk: highRisk }), 'late-tests-author');
  await complete(f, author.nodeId);
  // High-impact work must designate its required tests up front; the evidence for them arrives late.
  const flow = await f.reviews.start(f.mission.id, { authorId: author.nodeId, source: { content: 'source awaiting independent test evidence' }, risk: highRisk,
    testPlan: { entries: [{ id: 'late-independent-test', description: 'Independent test supplied after the first adjudication' }] }, principal: { trusted: true, source: 'local-user', authority: 'user' } });
  let oldJudge;
  for (const role of ['reviewer', 'judge']) {
    const assignment = (await f.reviews.assign(f.mission.id, flow.id))[0];
    assert.equal(assignment.role, role);
    await complete(f, assignment.nodeId);
    await f.reviews.submit(f.mission.id, flow.id, assignment.nodeId, flow.source.hash, passedReview());
    if (role === 'judge') oldJudge = assignment;
  }
  assert.equal((await f.store.snapshot(f.mission.id)).workflows[flow.id].status, 'held');
  const planHash = (await f.store.snapshot(f.mission.id)).workflows[flow.id].requiredTests.planHash;
  const executed = passed => ({ name: 'late-independent-test', testId: 'late-independent-test', sourceHash: flow.source.hash, planHash, passed,
    attestation: { runnerId: 'ci-runner-1', commandDigest: 'a'.repeat(64), exitCode: passed ? 0 : 1, sourceHash: flow.source.hash, qualification: 'trusted-executor' } });
  const evidence = { ...executed(true), details: 'Late trusted test evidence' };
  const runner = { trusted: true, source: 'test-runner' };
  await f.reviews.recordTest(f.mission.id, flow.id, evidence, runner);
  const judge = (await f.reviews.assign(f.mission.id, flow.id))[0];
  assert.equal(judge.role, 'judge');
  assert.notEqual(judge.nodeId, oldJudge.nodeId);
  await assert.rejects(() => f.reviews.submit(f.mission.id, flow.id, oldJudge.nodeId, flow.source.hash, passedReview()), /superseded|newer|already/i);
  await complete(f, judge.nodeId);
  const accepted = await f.reviews.submit(f.mission.id, flow.id, judge.nodeId, flow.source.hash, passedReview());
  assert.equal(accepted.status, 'code_approved');
  const action = await f.actions.propose(f.mission.id, author.nodeId, { kind: 'delete', description: 'Synthetic action on reviewed source', workflowId: flow.id, sourceHash: flow.source.hash });
  await f.reviews.recordTest(f.mission.id, flow.id, { ...executed(false), details: 'Independent test now fails' }, runner);
  await f.reviews.recordTest(f.mission.id, flow.id, { ...evidence, details: 'Retried test passes' }, runner);
  const m = await f.store.snapshot(f.mission.id);
  assert.equal(m.actions[action.id].status, 'stale');
  assert.equal(m.workflows[flow.id].status, 'held', 'Configured retry count bounds repeated fresh adjudication');
  assert.equal(m.workflows[flow.id].approval, null);
});

test('architecture: altered snapshot authority fails integrity checks even if the audit events are intact', async t => {
  const f = await fixture(t);
  const author = await f.broker.request(f.mission.id, 'root', proposal(), 'snapshot-integrity-author');
  const stored = JSON.parse(await readFile(f.store.path, 'utf8'));
  stored.missions[f.mission.id].nodes[author.nodeId].permissions.tools = ['delete'];
  await writeFile(f.store.path, JSON.stringify(stored));
  await assert.rejects(() => f.store.snapshot(f.mission.id), /snapshot.*corrupt|integrity checksum/i);
});
