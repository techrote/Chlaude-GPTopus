import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ExecutionStore } from '../ultra/store.mjs';
import { RecruitmentBroker } from '../ultra/broker.mjs';
import { ReviewController } from '../ultra/review.mjs';
import { ActionGate } from '../ultra/actions.mjs';
import { DEFAULT_CONFIG, resolveConfig, validateConfig } from '../ultra/config.mjs';

// These tests drive the real ReviewController, ActionGate and RecruitmentBroker over a real execution ledger. Review agents are
// represented by genuine broker allocations that are claimed and finished; only the model output (the report) is synthetic.
const BASE_RISK = { complexity: 'low', verifiability: 'high', confidence: 1, rationale: 'Synthetic fixture.', blastRadius: 'local', reversibility: 'reversible', testsAvailable: true, independentEvidence: true };
const HIGH = { ...BASE_RISK, impact: 'high', destructive: true };
const LOW = { ...BASE_RISK, impact: 'low' };
const CRITICAL = { ...BASE_RISK, impact: 'critical', destructive: true };
const owner = { trusted: true, source: 'local-user', authority: 'user' };
const runner = { trusted: true, source: 'test-runner' };
const sha = text => createHash('sha256').update(text).digest('hex');
const CMD = sha('node --test scope');
const source = (content = 'function plan(p) { return []; }\n') => ({ id: 'cleanup.js', content, tests: ['author claims: all tests pass'] });
const UNIT = { id: 'unit:path-scope', description: 'Path scoping unit tests' };
const REGRESSION = { id: 'regression:junction', description: 'Junction traversal regression' };
const MANUAL = { id: 'manual:windows-ui', description: 'Manual Windows UI pass', executable: false };

async function fixture(t, { review = {}, mission: missionConfig = {}, risk = HIGH, authorRisk = risk, orchestrator = 'opus', plan, principal, tools = [] } = {}) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ultra-required-tests-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-11-21T12:00:00Z');
  const store = new ExecutionStore(path.join(dir, 'ledger.json'), { now: () => now });
  const broker = new RecruitmentBroker(store, { config: { enabled: true, review, mission: missionConfig, risk: { uncertainAuthority: 'user' }, ...(tools.length && { permissions: { tools } }) }, now: () => now });
  const mission = await broker.createMission({ id: 'required_tests', task: 'Synthetic required-test manifest', orchestrator: { model: orchestrator, trusted: true, source: 'test-host' } });
  const ctx = { store, broker, mid: mission.id, reviews: new ReviewController(broker), actions: new ActionGate(broker), risk };
  const request = await broker.request(ctx.mid, 'root', { worker: 'luna6', role: 'implementation', task: 'Author the synthetic change', risk: authorRisk, ...(tools.length && { permissions: { tools } }) }, 'author');
  ctx.author = request.nodeId; await complete(ctx, ctx.author);
  now += 1000;
  ctx.workflow = await ctx.reviews.start(ctx.mid, { authorId: ctx.author, source: source(), risk, ...(plan ? { testPlan: plan, principal: principal ?? owner } : {}) });
  ctx.wid = ctx.workflow.id;
  return ctx;
}
async function complete(ctx, nodeId) {
  const node = await ctx.broker.claim(ctx.mid, 'required-tests-fixture', { nodeId });
  assert.ok(node, `agent ${nodeId} must be claimable`);
  await ctx.broker.finish(ctx.mid, nodeId, { result: { text: 'fixture' }, usage: { tokens: 10, usd: 0.0001 }, lease: node.lease.token });
}
const get = async ctx => (await ctx.store.snapshot(ctx.mid)).workflows[ctx.wid];
const mission = ctx => ctx.store.snapshot(ctx.mid);
async function stage(ctx, extra = () => ({})) {
  const assigned = await ctx.reviews.assign(ctx.mid, ctx.wid);
  for (const a of assigned) {
    let nodeId = a.nodeId;
    if (!nodeId) { // uncertain-risk allocations need the configured (owner) authority before they exist
      await ctx.broker.decide(ctx.mid, a.requestId, { decision: 'APPROVE', rationale: 'Owner approves this synthetic review allocation.' }, owner);
      nodeId = (await mission(ctx)).requests[a.requestId].nodeId;
    }
    assert.ok(nodeId, `${a.role} allocation must be admitted`);
    await complete(ctx, nodeId);
    await ctx.reviews.submit(ctx.mid, ctx.wid, nodeId, a.sourceHash, { findings: [], coverage: [{ area: 'all', status: 'examined' }], ...extra(a.role) });
  }
  return get(ctx);
}
async function toAdjudication(ctx, extra) {
  let w = await get(ctx);
  for (let i = 0; i < 5 && w.status !== 'adjudication'; i++) w = await stage(ctx, extra);
  assert.equal(w.status, 'adjudication'); return w;
}
const judge = (ctx, extra) => stage(ctx, role => role === 'judge' ? (extra?.(role) ?? {}) : {});
const attest = (w, passed = true, extra = {}) => ({ runnerId: 'ci-runner-1', commandDigest: CMD, exitCode: passed ? 0 : 1, sourceHash: w.source.hash, qualification: 'trusted-executor', ...extra });
async function ran(ctx, id, passed = true, extra = {}) {
  const w = await get(ctx);
  return ctx.reviews.recordTest(ctx.mid, ctx.wid, { name: id, testId: id, passed, details: `${id} ${passed ? 'passed' : 'failed'}`, sourceHash: w.source.hash, planHash: w.requiredTests.planHash, attestation: attest(w, passed), ...extra }, runner);
}
async function ownerRecord(ctx, id, passed = true, extra = {}) {
  const w = await get(ctx);
  return ctx.reviews.recordTest(ctx.mid, ctx.wid, { name: id, testId: id, passed, details: 'recorded by owner', sourceHash: w.source.hash, planHash: w.requiredTests.planHash, ...extra }, owner);
}
const PLAN = { entries: [UNIT, REGRESSION] };

// ---- Reproduction of the reviewed defect (uses only the pre-existing API, so it also runs against the unfixed source) ----
test('reproduction: one unrelated passing smoke test must not satisfy requireTests for high-impact work', async t => {
  const ctx = await fixture(t);
  await toAdjudication(ctx);
  await ctx.reviews.recordTest(ctx.mid, ctx.wid, { name: 'smoke: server starts', passed: true, details: 'unrelated smoke test', sourceHash: (await get(ctx)).source.hash }, runner);
  const w = await judge(ctx);
  assert.notEqual(w.status, 'code_approved', 'a smoke test must not stand in for designated verification');
  assert.equal(w.status, 'held');
  assert.match(w.reason, /Required independent test evidence is missing or failing/);
});

// ---- Owner-policy manifest, all evidence orders ----
test('missing designated tests hold the workflow with the explicit list of missing ids; unrelated passes do not count', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT, REGRESSION] } });
  await toAdjudication(ctx);
  await ran(ctx, UNIT.id); await ran(ctx, 'smoke: server starts');
  const w = await judge(ctx);
  assert.equal(w.status, 'held');
  assert.match(w.reason, /missing \[regression:junction\]/);
  assert.doesNotMatch(w.reason, /unit:path-scope/);
  assert.deepEqual(w.requiredTests.satisfied, [UNIT.id]); assert.deepEqual(w.requiredTests.missing, [REGRESSION.id]);
  assert.deepEqual(w.requiredTests.unrelated, ['smoke: server starts']); assert.equal(w.requiredTests.state, 'missing');
  assert.equal(w.approval ?? null, null);
});

test('recording the last designated test re-adjudicates once and approval carries the plan it rested on', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT, REGRESSION] } });
  await toAdjudication(ctx);
  await ran(ctx, UNIT.id);
  assert.equal((await judge(ctx)).status, 'held');
  await ran(ctx, REGRESSION.id);
  let w = await get(ctx);
  assert.equal(w.status, 'adjudication'); assert.equal(w.judgementGeneration, 1); assert.equal((await mission(ctx)).retryCount, 1);
  w = await judge(ctx);
  assert.equal(w.status, 'code_approved');
  assert.equal(w.approval.planHash, w.requiredTests.planHash); assert.equal(w.approval.sourceHash, w.source.hash);
  assert.deepEqual(w.approval.requiredTests.tests.map(x => [x.id, x.state]), [[REGRESSION.id, 'satisfied'], [UNIT.id, 'satisfied']]);
  assert.equal(w.requiredTests.state, 'satisfied');
});

test('evidence recorded before the judge, in any order, approves directly and never double counts', async t => {
  for (const order of [[UNIT.id, REGRESSION.id], [REGRESSION.id, UNIT.id]]) {
    const ctx = await fixture(t, { review: { requiredTests: [UNIT, REGRESSION] } });
    await toAdjudication(ctx);
    for (const id of order) await ran(ctx, id);
    await ran(ctx, order[0]); // consistent duplicate is harmless
    const w = await judge(ctx);
    assert.equal(w.status, 'code_approved', order.join(','));
    assert.equal(w.requiredTests.state, 'satisfied');
  }
});

test('approval is revoked and actions go stale when a designated test is later contradicted', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  await toAdjudication(ctx); await ran(ctx, UNIT.id);
  assert.equal((await judge(ctx)).status, 'code_approved');
  const w0 = await get(ctx);
  const action = await ctx.actions.propose(ctx.mid, ctx.author, { kind: 'write', description: 'Apply the approved patch', workflowId: ctx.wid, sourceHash: w0.source.hash });
  await ran(ctx, UNIT.id, false);
  const w = await get(ctx);
  assert.equal(w.status, 'held'); assert.equal(w.approval, null); assert.equal(w.requiredTests.state, 'contradictory');
  assert.deepEqual(w.requiredTests.contradictory, [UNIT.id]);
  assert.equal((await mission(ctx)).actions[action.id].status, 'stale');
});

test('a failing designated test holds; a later pass is a contradiction, not latest-wins', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  await toAdjudication(ctx);
  await ran(ctx, UNIT.id, false);
  let w = await judge(ctx);
  assert.equal(w.status, 'held'); assert.match(w.reason, /failing \[unit:path-scope\]/); assert.equal(w.requiredTests.state, 'failing');
  await ran(ctx, UNIT.id, true); // re-run passes but does not name what it supersedes
  w = await get(ctx);
  assert.equal(w.status, 'held'); assert.equal(w.requiredTests.state, 'contradictory'); assert.match(w.reason, /contradictory \[unit:path-scope\]/);
});

test('explicit superseding re-run needs named ids, a reason and an eligible principal, and is scoped to the same test/source/plan', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT, REGRESSION] } });
  await toAdjudication(ctx);
  const failed = await ran(ctx, UNIT.id, false), other = await ran(ctx, REGRESSION.id, true);
  const w = await get(ctx);
  const base = { name: UNIT.id, testId: UNIT.id, passed: true, details: 're-run', sourceHash: w.source.hash, planHash: w.requiredTests.planHash, attestation: attest(w) };
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, { ...base, supersedes: [failed.id] }, runner), /needs a reason/);
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, { ...base, supersedes: [other.id], reason: 'wrong test' }, runner), /same test, source and plan/);
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, { ...base, attestation: undefined, supersedes: [failed.id], reason: 'unattested' }, runner), /executor attestation or the local owner/);
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, { ...base, supersedes: [], reason: 'x' }, runner), /bounded list/);
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, { ...base, reason: 'reason without supersedes' }, runner), /only meaningful for superseding/);
  await ctx.reviews.recordTest(ctx.mid, ctx.wid, { ...base, supersedes: [failed.id], reason: 'Infrastructure flake confirmed; clean re-run on the same source' }, runner);
  const after = await get(ctx);
  assert.deepEqual(after.requiredTests.satisfied.sort(), [REGRESSION.id, UNIT.id]);
  assert.equal(after.tests.find(x => x.id === failed.id).passed, false, 'the superseded failure stays in the ledger');
});

test('a superseding record from an ineligible class cannot hide a failure', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } }); // owner-attested is not accepted at high impact
  await toAdjudication(ctx);
  const failed = await ran(ctx, UNIT.id, false);
  await ownerRecord(ctx, UNIT.id, true, { supersedes: [failed.id], reason: 'owner says it is fine' });
  const w = await get(ctx);
  assert.equal(w.requiredTests.state, 'failing'); assert.equal((await judge(ctx)).status, 'held');
});

// ---- Source and plan binding ----
test('stale-source evidence is refused at record time and ignored after the source changes', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  const old = await get(ctx);
  await ran(ctx, UNIT.id);
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, { name: UNIT.id, passed: true, details: 'x', sourceHash: sha('some other source'), planHash: old.requiredTests.planHash, attestation: attest(old) }, runner), /stale source/);
  await ctx.reviews.invalidate(ctx.mid, ctx.wid, source('function plan(p) { return p; }\n'));
  const w = await get(ctx);
  assert.notEqual(w.source.hash, old.source.hash); assert.equal(w.status, 'held');
  assert.deepEqual(w.requiredTests.missing, [UNIT.id], 'old-source evidence is ignored for the new source');
  assert.notEqual(w.requiredTests.planHash, old.requiredTests.planHash, 'the plan is re-bound to the exact new source');
});

test('evidence must name the current plan; evidence recorded before the plan existed is ignored', async t => {
  const ctx = await fixture(t); // no owner policy, no plan yet
  const early = await get(ctx);
  await ctx.reviews.recordTest(ctx.mid, ctx.wid, { name: UNIT.id, passed: true, details: 'ran before any plan was registered', sourceHash: early.source.hash, attestation: attest(early) }, runner);
  await ctx.reviews.addRequiredTests(ctx.mid, ctx.wid, [UNIT], owner);
  let w = await get(ctx);
  assert.deepEqual(w.requiredTests.missing, [UNIT.id], 'pre-plan evidence is not bound to the plan');
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, { name: UNIT.id, passed: true, details: 'x', sourceHash: w.source.hash, attestation: attest(w) }, runner), /must name the verification plan/);
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, { name: UNIT.id, passed: true, details: 'x', sourceHash: w.source.hash, planHash: sha('another plan'), attestation: attest(w) }, runner), /different verification plan/);
  await ran(ctx, UNIT.id);
  w = await get(ctx); assert.equal(w.requiredTests.state, 'satisfied');
});

test('rework keeps every designated test, rebinds them to the new source and demands fresh evidence', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  await ran(ctx, UNIT.id);
  const findingOnce = role => role === 'reviewer' ? { findings: [{ id: 'f', severity: 'high', message: 'Traversal not handled', area: 'scope' }] } : {};
  let w = await stage(ctx, findingOnce);
  assert.equal(w.status, 'rework');
  const [assignment] = await ctx.reviews.assign(ctx.mid, ctx.wid);
  assert.equal(assignment.role, 'reworker'); await complete(ctx, assignment.nodeId);
  const first = w.source.hash;
  w = await ctx.reviews.revisedSource(ctx.mid, ctx.wid, assignment.nodeId, source('function plan(p) { return p.filter(Boolean); }\n'));
  assert.equal(w.status, 'review'); assert.notEqual(w.source.hash, first);
  assert.deepEqual(w.requiredTests.missing, [UNIT.id], 'the old-source pass does not carry over');
  assert.deepEqual(w.testPlan.policyEntries.map(e => e.id), [UNIT.id]);
  await toAdjudication(ctx);
  assert.equal((await judge(ctx)).status, 'held');
  await ran(ctx, UNIT.id);
  assert.equal((await judge(ctx)).status, 'code_approved');
});

// ---- Provenance classes ----
test('owner-attested evidence satisfies low tiers but never high impact by default; the owner can opt in per tier', async t => {
  const highDefault = await fixture(t, { review: { requiredTests: [UNIT] } });
  await toAdjudication(highDefault); await ownerRecord(highDefault, UNIT.id);
  let w = await judge(highDefault);
  assert.equal(w.status, 'held'); assert.equal(w.requiredTests.tests[0].state, 'missing'); assert.match(w.requiredTests.tests[0].detail, /independent execution/);
  const optIn = await fixture(t, { review: { requiredTests: [UNIT], ownerAttestedImpacts: ['low', 'medium', 'high'] } });
  await toAdjudication(optIn); await ownerRecord(optIn, UNIT.id);
  assert.equal((await judge(optIn)).status, 'code_approved');
  const medium = await fixture(t, { authorRisk: LOW, risk: { ...BASE_RISK, impact: 'medium', verifiability: 'low' }, review: { requiredTests: [UNIT] } });
  await toAdjudication(medium); await ownerRecord(medium, UNIT.id);
  w = await judge(medium);
  assert.equal(w.assessment.effectiveImpact, 'medium'); assert.equal(w.status, 'code_approved');
  assert.equal(w.tests[0].provenance, 'owner-attested');
});

test('provenance is derived by the controller: runners without attestation never count, malformed attestations are refused', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  const w = await get(ctx), good = { name: UNIT.id, testId: UNIT.id, passed: true, details: 'ok', sourceHash: w.source.hash, planHash: w.requiredTests.planHash };
  const rejects = (extra, pattern, principal = runner) => assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, { ...good, ...extra }, principal), pattern);
  await rejects({ provenance: 'executed' }, /cannot override trusted provenance/);
  await rejects({ attestation: attest(w, true, { sourceHash: sha('other') }) }, /different source/);
  await rejects({ attestation: attest(w, false) }, /contradicts the executor exit code/);
  await rejects({ attestation: attest(w, true, { commandDigest: 'not-a-digest' }) }, /command digest/);
  await rejects({ attestation: attest(w, true, { qualification: 'self-declared' }) }, /trusted-executor/);
  await rejects({ attestation: attest(w, true, { runnerId: '' }) }, /runner id/);
  await rejects({ attestation: attest(w, true, { exitCode: '0' }) }, /integer exit code/);
  await rejects({ attestation: { ...attest(w), extra: 1 } }, /malformed/);
  await rejects({ attestation: attest(w) }, /Owner test records|cannot carry executor attestation/, owner);
  await ctx.reviews.recordTest(ctx.mid, ctx.wid, good, runner); // accepted but only as an unattested record
  const after = await get(ctx);
  assert.equal(after.tests.at(-1).provenance, 'unattested-runner'); assert.equal(after.requiredTests.state, 'missing');
  await ran(ctx, UNIT.id);
  assert.equal((await get(ctx)).requiredTests.state, 'satisfied');
  assert.equal((await get(ctx)).tests.at(-1).provenance, 'executed');
});

test('untrusted or wrong-class principals cannot record, waive, add or change anything', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  const w = await get(ctx);
  const evidence = { name: UNIT.id, testId: UNIT.id, passed: true, details: 'ok', sourceHash: w.source.hash, planHash: w.requiredTests.planHash, attestation: attest(w) };
  const author = { trusted: true, source: 'supervisor', authority: 'helicop-sol', nodeId: ctx.author };
  for (const principal of [undefined, { source: 'test-runner' }, { trusted: false, source: 'test-runner' }, author, { trusted: true, source: 'judge' }, { trusted: true, source: 'native-host', authority: 'trusted-orchestrator' }])
    await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, evidence, principal), /trusted runner or explicit owner/);
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, evidence, { trusted: true, source: 'local-user', authority: 'helicop-sol' }), /local user/);
  for (const principal of [undefined, runner, author, { trusted: false, source: 'local-user', authority: 'user' }]) {
    await assert.rejects(ctx.reviews.addRequiredTests(ctx.mid, ctx.wid, [REGRESSION], principal), /verification plan needs/);
    await assert.rejects(ctx.reviews.changeRequiredTests(ctx.mid, ctx.wid, { remove: [REGRESSION.id], reason: 'x' }, principal), /trusted local owner/);
    await assert.rejects(ctx.reviews.waiveTest(ctx.mid, ctx.wid, { testId: MANUAL.id, rationale: 'x', sourceHash: w.source.hash, planHash: w.requiredTests.planHash }, principal), /trusted local owner/);
  }
  assert.deepEqual((await get(ctx)).tests, []);
});

test('a required test can pin the exact command; a different executed command is refused', async t => {
  const pinned = { ...UNIT, commandDigest: CMD };
  const ctx = await fixture(t, { review: { requiredTests: [pinned] } });
  const w = await get(ctx);
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, { name: UNIT.id, passed: true, details: 'ran `true`', sourceHash: w.source.hash, planHash: w.requiredTests.planHash, attestation: attest(w, true, { commandDigest: sha('true') }) }, runner), /differs from the required test command/);
  await ran(ctx, UNIT.id);
  assert.equal((await get(ctx)).requiredTests.state, 'satisfied');
});

// ---- Plans registered by a trusted principal; agents may add but never remove ----
test('plan registration needs a trusted owner or full trusted orchestrator and unions with owner policy', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  const again = () => ctx.reviews.start(ctx.mid, { authorId: ctx.author, source: source('function plan() { return 1; }\n'), risk: HIGH, testPlan: { entries: [REGRESSION] }, principal: undefined });
  await assert.rejects(again(), /verification plan needs/);
  await assert.rejects(ctx.reviews.start(ctx.mid, { authorId: ctx.author, source: source('x\n'), risk: HIGH, testPlan: { entries: [REGRESSION] }, principal: runner }), /verification plan needs/);
  await assert.rejects(ctx.reviews.start(ctx.mid, { authorId: ctx.author, source: source('x\n'), risk: HIGH, testPlan: { entries: [{ ...UNIT, description: 'weaker' }] }, principal: owner }), /already defined differently/);
  const native = { trusted: true, source: 'native-host', authority: 'trusted-orchestrator' };
  const w = await ctx.reviews.start(ctx.mid, { authorId: ctx.author, source: source('function plan() { return 2; }\n'), risk: HIGH, testPlan: { id: 'plan-42', entries: [REGRESSION, UNIT] }, principal: native });
  assert.deepEqual(w.requiredTests.tests.map(x => [x.id, x.origin]), [[REGRESSION.id, 'plan:native-host'], [UNIT.id, 'owner-policy']]);
  assert.equal(w.requiredTests.planId, 'plan-42');
  // A trusted but non-full orchestrator (Sonnet) cannot register verification plans on the owner's behalf.
  const routine = await fixture(t, { orchestrator: 'sonnet' });
  await assert.rejects(routine.reviews.start(routine.mid, { authorId: routine.author, source: source('function plan() { return 9; }\n'), risk: HIGH, testPlan: { entries: [UNIT] }, principal: native }), /verification plan needs/);
});

test('reviewers can only add executable requirements; changing or removing one is not an agent operation', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  await ran(ctx, UNIT.id);
  const before = await get(ctx);
  const w = await stage(ctx, role => role === 'reviewer' ? { requiredTests: [
    { id: 'regression:added-by-reviewer', description: 'Cover the traversal path', commandDigest: CMD, executable: false },
    { id: UNIT.id, description: 'weakened description' },
    { id: '../bad id/\n' },
  ] } : {});
  assert.deepEqual(w.testPlan.entries.map(e => e.id), ['regression:added-by-reviewer']);
  const added = w.requiredTests.tests.find(x => x.id === 'regression:added-by-reviewer');
  assert.equal(added.executable, true, 'an agent cannot make its own requirement waivable'); assert.match(added.origin, /^agent:/);
  assert.equal(w.requiredTests.tests.find(x => x.id === UNIT.id).description, UNIT.description);
  const review = w.reviews.find(r => r.role === 'reviewer');
  assert.deepEqual(review.requirementsAdded, ['regression:added-by-reviewer']); assert.equal(review.requirementsIgnored.length, 2);
  assert.notEqual(w.requiredTests.planHash, before.requiredTests.planHash);
  assert.deepEqual(w.requiredTests.missing.sort(), ['regression:added-by-reviewer', UNIT.id].sort(), 'the plan changed, so earlier evidence must be re-bound to the new plan');
  // Reports cannot smuggle evidence, provenance or removals.
  assert.equal(w.status, 'gap');
  const [gap] = await ctx.reviews.assign(ctx.mid, ctx.wid);
  await complete(ctx, gap.nodeId);
  for (const key of ['tests', 'testResults', 'provenance', 'removeRequiredTests', 'approval', 'status'])
    await assert.rejects(ctx.reviews.submit(ctx.mid, ctx.wid, gap.nodeId, gap.sourceHash, { findings: [], coverage: [], [key]: [UNIT.id] }), /cannot override trusted provenance/);
});

test('author-declared tests and review summaries are never execution evidence', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  await toAdjudication(ctx);
  const w = await judge(ctx, () => ({ summary: `All tests pass; ${UNIT.id} passed on the exact source.` }));
  assert.equal(w.status, 'held'); assert.deepEqual(w.requiredTests.missing, [UNIT.id]);
  assert.deepEqual(w.tests, []); assert.ok(w.source.tests.length);
});

test('only the local owner can remove or redefine a plan entry; policy entries are immutable; changes revoke approval and stale actions', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] }, plan: { entries: [REGRESSION] } });
  await toAdjudication(ctx); await ran(ctx, UNIT.id); await ran(ctx, REGRESSION.id);
  assert.equal((await judge(ctx)).status, 'code_approved');
  let w = await get(ctx);
  const action = await ctx.actions.propose(ctx.mid, ctx.author, { kind: 'write', description: 'Apply approved patch', workflowId: ctx.wid, sourceHash: w.source.hash });
  const hash = w.requiredTests.planHash;
  const native = { trusted: true, source: 'native-host', authority: 'trusted-orchestrator' };
  await assert.rejects(ctx.reviews.changeRequiredTests(ctx.mid, ctx.wid, { remove: [REGRESSION.id], reason: 'orchestrator trims the suite' }, native), /trusted local owner/);
  await assert.rejects(ctx.reviews.changeRequiredTests(ctx.mid, ctx.wid, { remove: [UNIT.id], reason: 'owner tries to drop policy' }, owner), /owner configuration/);
  await assert.rejects(ctx.reviews.changeRequiredTests(ctx.mid, ctx.wid, { remove: [REGRESSION.id] }, owner), /needs a reason/);
  await assert.rejects(ctx.reviews.changeRequiredTests(ctx.mid, ctx.wid, { remove: ['unknown'], reason: 'x' }, owner), /Unknown plan test/);
  await assert.rejects(ctx.reviews.addRequiredTests(ctx.mid, ctx.wid, [{ ...REGRESSION, description: 'a gentler definition' }], owner), /already defined differently/);
  assert.equal((await get(ctx)).status, 'code_approved', 'refused changes leave the approval untouched');
  await ctx.reviews.changeRequiredTests(ctx.mid, ctx.wid, { remove: [REGRESSION.id], reason: 'Covered by the unit suite after review' }, owner);
  w = await get(ctx);
  assert.notEqual(w.requiredTests.planHash, hash);
  assert.notEqual(w.status, 'code_approved'); assert.equal(w.approval, null);
  assert.equal((await mission(ctx)).actions[action.id].status, 'stale');
  assert.equal(w.testPlan.history.at(-1).kind, 'changed'); assert.equal(w.testPlan.history.at(-1).reason, 'Covered by the unit suite after review');
  assert.deepEqual(w.requiredTests.missing, [UNIT.id], 'evidence under the old plan must be re-bound to the new one');
  await ran(ctx, UNIT.id);
  w = await get(ctx); assert.equal(w.status, 'adjudication');
  assert.equal((await judge(ctx)).status, 'code_approved');
});

test('adding a requirement after approval revokes the approval', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  await toAdjudication(ctx); await ran(ctx, UNIT.id);
  assert.equal((await judge(ctx)).status, 'code_approved');
  await ctx.reviews.addRequiredTests(ctx.mid, ctx.wid, [REGRESSION], owner);
  const w = await get(ctx);
  assert.equal(w.status, 'held'); assert.equal(w.approval, null); assert.match(w.reason, /missing \[regression:junction, unit:path-scope\]/);
  await assert.rejects(ctx.actions.propose(ctx.mid, ctx.author, { kind: 'write', description: 'Apply', workflowId: ctx.wid, sourceHash: w.source.hash }), /lacks independent code approval/);
});

// ---- Non-executable tests and waivers ----
test('a non-executable test needs an explicit owner waiver with rationale, shown in the approval record', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT, MANUAL] } });
  await toAdjudication(ctx); await ran(ctx, UNIT.id);
  let w = await get(ctx);
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, { name: MANUAL.id, passed: true, details: 'claimed', sourceHash: w.source.hash, planHash: w.requiredTests.planHash, attestation: attest(w) }, runner), /non-executable required test/);
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, { name: MANUAL.id, passed: true, details: 'claimed', sourceHash: w.source.hash, planHash: w.requiredTests.planHash }, owner), /non-executable required test/);
  w = await judge(ctx);
  assert.equal(w.status, 'held'); assert.match(w.reason, /missing \[manual:windows-ui\]/); assert.match(w.requiredTests.tests.find(x => x.id === MANUAL.id).detail, /waiver/);
  const waiver = id => ({ testId: id, rationale: 'Needs a physical Windows machine; owner verified manually on the release candidate', sourceHash: w.source.hash, planHash: w.requiredTests.planHash });
  await assert.rejects(ctx.reviews.waiveTest(ctx.mid, ctx.wid, { ...waiver(MANUAL.id), rationale: '  ' }, owner), /needs a rationale/);
  await assert.rejects(ctx.reviews.waiveTest(ctx.mid, ctx.wid, waiver(UNIT.id), owner), /Only a non-executable required test can be waived/);
  await assert.rejects(ctx.reviews.waiveTest(ctx.mid, ctx.wid, waiver('not-designated'), owner), /Only a non-executable/);
  await assert.rejects(ctx.reviews.waiveTest(ctx.mid, ctx.wid, { ...waiver(MANUAL.id), planHash: sha('stale plan') }, owner), /different source or verification plan/);
  await assert.rejects(ctx.reviews.waiveTest(ctx.mid, ctx.wid, waiver(MANUAL.id), runner), /trusted local owner/);
  await ctx.reviews.waiveTest(ctx.mid, ctx.wid, waiver(MANUAL.id), owner);
  await assert.rejects(ctx.reviews.waiveTest(ctx.mid, ctx.wid, waiver(MANUAL.id), owner), /already waived/);
  w = await get(ctx);
  assert.equal(w.status, 'adjudication'); assert.equal(w.requiredTests.state, 'waived');
  w = await judge(ctx);
  assert.equal(w.status, 'code_approved');
  assert.equal(w.approval.waivers.length, 1); assert.match(w.approval.waivers[0].rationale, /physical Windows machine/); assert.equal(w.approval.waivers[0].principal.source, 'local-user');
  assert.deepEqual(w.approval.requiredTests.tests.find(x => x.id === MANUAL.id), { id: MANUAL.id, state: 'waived', executable: false, evidenceIds: [], waiverId: w.approval.waivers[0].id });
});

test('waivers are bound to source and plan, and refused for critical impact unless the owner allows them', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [MANUAL] } });
  let w = await get(ctx);
  await ctx.reviews.waiveTest(ctx.mid, ctx.wid, { testId: MANUAL.id, rationale: 'owner verified', sourceHash: w.source.hash, planHash: w.requiredTests.planHash }, owner);
  assert.equal((await get(ctx)).requiredTests.state, 'waived');
  await ctx.reviews.addRequiredTests(ctx.mid, ctx.wid, [UNIT], owner);
  assert.equal((await get(ctx)).requiredTests.tests.find(x => x.id === MANUAL.id).state, 'missing', 'a plan change voids earlier waivers');
  w = await get(ctx);
  await ctx.reviews.waiveTest(ctx.mid, ctx.wid, { testId: MANUAL.id, rationale: 're-waived for the new plan', sourceHash: w.source.hash, planHash: w.requiredTests.planHash }, owner);
  await ctx.reviews.invalidate(ctx.mid, ctx.wid, source('function plan() { return 3; }\n'));
  assert.equal((await get(ctx)).requiredTests.tests.find(x => x.id === MANUAL.id).state, 'missing', 'a source change voids earlier waivers');

  const critical = await fixture(t, { risk: CRITICAL, review: { requiredTests: [MANUAL] } });
  w = await get(critical); assert.equal(w.assessment.effectiveImpact, 'critical');
  const request = { testId: MANUAL.id, rationale: 'owner verified', sourceHash: w.source.hash, planHash: w.requiredTests.planHash };
  await assert.rejects(critical.reviews.waiveTest(critical.mid, critical.wid, request, owner), /critical-impact/);
  const allowed = await fixture(t, { risk: CRITICAL, review: { requiredTests: [MANUAL], allowCriticalWaivers: true } });
  w = await get(allowed);
  await allowed.reviews.waiveTest(allowed.mid, allowed.wid, { ...request, sourceHash: w.source.hash, planHash: w.requiredTests.planHash }, owner);
  assert.equal((await get(allowed)).requiredTests.state, 'waived');
});

// ---- Tiers, defaults and compatibility ----
test('high-impact work that designates no tests is held with an explicit reason; the old wording remains only for the weakest tier', async t => {
  const high = await fixture(t);
  await toAdjudication(high); await ran(high, 'anything', true);
  let w = await judge(high);
  assert.equal(w.status, 'held'); assert.equal(w.requiredTests.state, 'unplanned'); assert.match(w.reason, /no required tests are designated/);
  // Uncertain low-impact work still demands tests but not a plan by default: "some passing evidence".
  const uncertain = await fixture(t, { authorRisk: LOW, risk: { ...LOW, verifiability: 'low' } });
  assert.equal(uncertain.workflow.assessment.controls.tests, true); assert.equal(uncertain.workflow.assessment.effectiveImpact, 'low');
  await toAdjudication(uncertain);
  assert.equal((await judge(uncertain)).status, 'held');
  const some = await fixture(t, { authorRisk: LOW, risk: { ...LOW, verifiability: 'low' } });
  await toAdjudication(some);
  await some.reviews.recordTest(some.mid, some.wid, { name: 'smoke', passed: true, details: 'passing evidence', sourceHash: (await get(some)).source.hash }, runner);
  w = await judge(some);
  assert.equal(w.status, 'code_approved'); assert.equal(w.requiredTests.state, 'some-passing-evidence'); assert.equal(w.requiredTests.mode, 'legacy');
  // The owner can demand a plan at that tier too.
  const strict = await fixture(t, { authorRisk: LOW, risk: { ...LOW, verifiability: 'low' }, review: { testPlanRequiredImpacts: ['low', 'medium', 'high', 'critical', 'unknown'] } });
  await toAdjudication(strict);
  await strict.reviews.recordTest(strict.mid, strict.wid, { name: 'smoke', passed: true, details: 'passing evidence', sourceHash: (await get(strict)).source.hash }, runner);
  assert.equal((await judge(strict)).requiredTests.state, 'unplanned');
});

test('weakest tier: a recorded failure or contradiction still blocks, and latest-wins is gone', async t => {
  const ctx = await fixture(t, { authorRisk: LOW, risk: { ...LOW, verifiability: 'low' } });
  await toAdjudication(ctx);
  const hash = (await get(ctx)).source.hash;
  await ctx.reviews.recordTest(ctx.mid, ctx.wid, { name: 'suite', passed: false, details: 'failed', sourceHash: hash }, runner);
  await ctx.reviews.recordTest(ctx.mid, ctx.wid, { name: 'suite', passed: true, details: 'passed on retry', sourceHash: hash }, runner);
  const w = await judge(ctx);
  assert.equal(w.status, 'held'); assert.equal(w.requiredTests.state, 'contradictory');
});

test('low-impact work with no required tests keeps working, and an explicit tier-keyed low requirement is enforced', async t => {
  const plain = await fixture(t, { risk: LOW });
  assert.equal(plain.workflow.assessment.controls.tests, false);
  await toAdjudication(plain);
  const w = await judge(plain);
  assert.equal(w.status, 'code_approved'); assert.equal(w.requiredTests.mode, 'not-required'); assert.deepEqual(w.requiredTests.tests, []);
  const keyed = await fixture(t, { risk: LOW, review: { requiredTests: [{ id: 'low:lint', impacts: ['low'] }, { id: 'high-only', impacts: ['high', 'critical'] }] } });
  assert.deepEqual(keyed.workflow.requiredTests.tests.map(x => x.id), ['low:lint']);
  await toAdjudication(keyed);
  assert.equal((await judge(keyed)).status, 'held');
  await ownerRecord(keyed, 'low:lint');
  assert.equal((await get(keyed)).status, 'adjudication');
  assert.equal((await judge(keyed)).status, 'code_approved');
});

test('area-keyed policy follows trusted risk flags, not author text', async t => {
  const entries = [{ id: 'security:fuzz', areas: ['security'] }, { id: 'privacy:redaction', areas: ['privacy'] }, { id: 'any:smoke' }];
  const secure = await fixture(t, { risk: { ...HIGH, securitySensitive: true }, review: { requiredTests: entries } });
  assert.deepEqual(secure.workflow.requiredTests.tests.map(x => x.id), ['any:smoke', 'security:fuzz']);
  const plain = await fixture(t, { review: { requiredTests: entries } });
  assert.deepEqual(plain.workflow.requiredTests.tests.map(x => x.id), ['any:smoke']);
});

test('requireTests=false removes only the demand, never a designated test', async t => {
  const off = await fixture(t, { review: { requireTests: false } });
  await toAdjudication(off);
  assert.equal((await judge(off)).status, 'code_approved');
  const designated = await fixture(t, { review: { requireTests: false, requiredTests: [UNIT] } });
  await toAdjudication(designated);
  assert.equal((await judge(designated)).status, 'held');
});

test('reviewers receive the plan and its state but no way to satisfy it', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  await ran(ctx, UNIT.id);
  const assigned = await ctx.reviews.assign(ctx.mid, ctx.wid);
  const m = await mission(ctx), input = JSON.parse(m.nodes[assigned[0].nodeId].task);
  assert.deepEqual(input.verificationPlan.tests, [{ id: UNIT.id, description: UNIT.description, executable: true, state: 'satisfied' }]);
  assert.equal(input.verificationPlan.planHash, (await get(ctx)).requiredTests.planHash);
  assert.deepEqual(input.declaredTests, ['author claims: all tests pass']);
  assert.equal(Object.hasOwn(input, 'priorReviews'), false, 'blind independence is preserved');
});

// ---- Configuration ----
test('review manifest configuration is strict, owner-only and off by default', () => {
  assert.equal(DEFAULT_CONFIG.enabled, false);
  assert.deepEqual(DEFAULT_CONFIG.review.requiredTests, []);
  assert.deepEqual(DEFAULT_CONFIG.review.ownerAttestedImpacts, ['low', 'medium']);
  assert.equal(DEFAULT_CONFIG.review.allowCriticalWaivers, false);
  const bad = patch => () => resolveConfig({ enabled: true, review: patch });
  assert.throws(bad({ requiredTests: [{ id: '../x' }] }), /stable id/);
  assert.throws(bad({ requiredTests: [{ id: 'a' }, { id: 'a' }] }), /Duplicate/);
  assert.throws(bad({ requiredTests: [{ id: 'a', commandDigest: 'abc' }] }), /SHA-256/);
  assert.throws(bad({ requiredTests: [{ id: 'a', executable: false, commandDigest: CMD }] }), /non-executable/);
  assert.throws(bad({ requiredTests: [{ id: 'a', areas: ['astrology'] }] }), /areas/);
  assert.throws(bad({ requiredTests: [{ id: 'a', typo: true }] }), /Unknown configuration field/);
  assert.throws(bad({ requiredTests: 'unit' }), /bounded array/);
  assert.throws(bad({ ownerAttestedImpacts: ['huge'] }), /ownerAttestedImpacts/);
  assert.throws(bad({ allowCriticalWaivers: 'yes' }), /boolean/);
  assert.throws(() => resolveConfig([{ enabled: true, review: { requiredTests: [UNIT] } }, { scope: 'project', value: { review: { requiredTests: [] } } }]), /cannot alter review/);
  assert.throws(() => resolveConfig([{ enabled: true }, { scope: 'mission', value: { review: { ownerAttestedImpacts: ['high', 'critical'] } } }]), /cannot alter review/);
  validateConfig(resolveConfig({ enabled: true, review: { requiredTests: [UNIT, MANUAL, { id: 'sec', areas: ['security'], impacts: ['high'], commandDigest: CMD }] } }));
});

// ---- Further adversarial and interaction cases ----
test('a judge cannot approve past a requirement it adds in the same report', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  await toAdjudication(ctx); await ran(ctx, UNIT.id);
  const w = await judge(ctx, () => ({ requiredTests: [{ id: 'judge:extra', description: 'Judge wants this proven too' }] }));
  assert.equal(w.status, 'held'); assert.match(w.reason, /missing \[judge:extra, unit:path-scope\]/);
  assert.equal(w.approval ?? null, null);
});

test('the owner can explicitly restore "some passing evidence" for high impact; the downgrade is policy, not an agent choice', async t => {
  const ctx = await fixture(t, { review: { testPlanRequiredImpacts: [] } });
  await toAdjudication(ctx);
  await ctx.reviews.recordTest(ctx.mid, ctx.wid, { name: 'smoke', passed: true, details: 'passing', sourceHash: (await get(ctx)).source.hash }, runner);
  const w = await judge(ctx);
  assert.equal(w.status, 'code_approved'); assert.equal(w.requiredTests.state, 'some-passing-evidence');
});

test('re-adjudication still draws on the shared mission retry budget; exhausting it leaves a precise held state', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] }, mission: { maxRetries: 0 } });
  await toAdjudication(ctx);
  assert.equal((await judge(ctx)).status, 'held');
  await ran(ctx, UNIT.id);
  const w = await get(ctx);
  assert.equal(w.status, 'held'); assert.equal(w.requiredTests.state, 'satisfied'); assert.equal((await mission(ctx)).retryCount, 0);
});

test('evidence volume per workflow is bounded', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  const w = await get(ctx), base = { name: 'noise', passed: true, details: 'x', sourceHash: w.source.hash, planHash: w.requiredTests.planHash };
  await ctx.store.transaction(state => { state.missions[ctx.mid].workflows[ctx.wid].tests = Array.from({ length: 1000 }, (_, i) => ({ id: `e${i}`, testId: 'noise', passed: true, sourceHash: w.source.hash, planHash: w.requiredTests.planHash, provenance: 'unattested-runner' })); });
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, ctx.wid, base, runner), /evidence limit/);
});
// ---- ACT-01: a consumed action is in flight; only unconsumed authority is revoked by later evidence/plan/source changes ----
const WRITE = (ctx, w, description) => ({ kind: 'write', description, workflowId: ctx.wid, sourceHash: w.source.hash });
async function approvedAction(ctx, description) {
  const w = await get(ctx), action = await ctx.actions.propose(ctx.mid, ctx.author, WRITE(ctx, w, description));
  const decided = await ctx.actions.decide(ctx.mid, action.id, { actionHash: action.hash, approved: true, rationale: 'The owner approves this exact action.' }, owner);
  assert.equal(decided.status, 'approved');
  return action;
}
async function executingAction(ctx, description) {
  const action = await approvedAction(ctx, description);
  const consumed = await ctx.actions.consume(ctx.mid, action.id, action.action, { nodeId: ctx.author, capability: 'stage_write' });
  assert.equal(consumed.status, 'executing');
  return action;
}

test('ACT-01: evidence, plan, waiver and source changes stale only unconsumed actions; an executing action still completes and records its result', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] }, tools: ['stage_write'] });
  await toAdjudication(ctx); await ran(ctx, UNIT.id);
  assert.equal((await judge(ctx)).status, 'code_approved');
  const done = await executingAction(ctx, 'Already executed write');
  await ctx.actions.complete(ctx.mid, done.id, { ok: true });
  const pending = await ctx.actions.propose(ctx.mid, ctx.author, WRITE(ctx, await get(ctx), 'Pending write'));
  const approved = await approvedAction(ctx, 'Approved but unconsumed write');
  const running = await executingAction(ctx, 'In-flight write');
  const all = [['done', done], ['pending', pending], ['approved', approved], ['running', running]];
  const now = async () => { const m = await mission(ctx); return Object.fromEntries(all.map(([label, a]) => [label, m.actions[a.id].status])); };
  assert.deepEqual(await now(), { done: 'executed', pending: 'pending', approved: 'approved', running: 'executing' });

  // 1. contradicting executed evidence revokes the approval
  await ran(ctx, UNIT.id, false);
  assert.equal((await get(ctx)).status, 'held');
  assert.deepEqual(await now(), { done: 'executed', pending: 'stale', approved: 'stale', running: 'executing' });
  // 2. plan addition, 3. owner waiver of the new non-executable requirement, 4. owner removal of it
  await ctx.reviews.addRequiredTests(ctx.mid, ctx.wid, [MANUAL], owner);
  assert.equal((await now()).running, 'executing');
  const w = await get(ctx);
  await ctx.reviews.waiveTest(ctx.mid, ctx.wid, { testId: MANUAL.id, rationale: 'Cannot be run safely here', sourceHash: w.source.hash, planHash: w.requiredTests.planHash }, owner);
  assert.equal((await now()).running, 'executing');
  await ctx.reviews.changeRequiredTests(ctx.mid, ctx.wid, { remove: [MANUAL.id], reason: 'No longer applicable' }, owner);
  assert.equal((await now()).running, 'executing');
  // 5. the source changes outside authorised rework
  await ctx.reviews.invalidate(ctx.mid, ctx.wid, source('function plan(p) { return [p]; }\n'));
  assert.deepEqual(await now(), { done: 'executed', pending: 'stale', approved: 'stale', running: 'executing' });

  // The executor can still report what it ran, and the ledger records the source and plan the action was consumed under.
  const completed = await ctx.actions.complete(ctx.mid, running.id, { changed: ['cleanup.js'] });
  assert.equal(completed.status, 'executed'); assert.deepEqual(completed.result, { changed: ['cleanup.js'] });
  assert.equal(completed.executedUnder.sourceHash, w.source.hash);
  assert.match(completed.executedUnder.planHash, /^[a-f0-9]{64}$/);
  assert.notEqual(completed.executedUnder.sourceHash, (await get(ctx)).source.hash, 'the record keeps the evidence it ran under, not the later source');
  assert.equal((await now()).running, 'executed');
  await assert.rejects(ctx.actions.complete(ctx.mid, running.id, { again: true }), /not executing/);
  // A stale action can never be consumed, and nothing new can be proposed on the revoked approval.
  await assert.rejects(ctx.actions.consume(ctx.mid, approved.id, approved.action, { nodeId: ctx.author, capability: 'stage_write' }), /missing, consumed, stale or expired/);
  await assert.rejects(ctx.actions.propose(ctx.mid, ctx.author, WRITE(ctx, w, 'Same effect again')), /lacks independent code approval/);
});

test('ACT-01: an owner risk override stales unconsumed actions but not one already executing, and rejected actions stay rejected', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] }, tools: ['stage_write'] });
  await toAdjudication(ctx); await ran(ctx, UNIT.id);
  assert.equal((await judge(ctx)).status, 'code_approved');
  const approved = await approvedAction(ctx, 'Approved but unconsumed write');
  const running = await executingAction(ctx, 'In-flight write');
  const w = await get(ctx), rejected = await ctx.actions.propose(ctx.mid, ctx.author, WRITE(ctx, w, 'Rejected write'));
  await ctx.actions.decide(ctx.mid, rejected.id, { actionHash: rejected.hash, approved: false, rationale: 'No.' }, owner);
  await ctx.broker.overrideRisk(ctx.mid, ctx.author, { ...HIGH, impact: 'critical' }, { rationale: 'Owner reclassifies the work as critical', ttlMs: 600000 }, owner);
  const m = await mission(ctx);
  assert.equal(m.workflows[ctx.wid].status, 'held');
  assert.equal(m.actions[approved.id].status, 'stale'); assert.equal(m.actions[running.id].status, 'executing'); assert.equal(m.actions[rejected.id].status, 'rejected');
  assert.equal((await ctx.actions.complete(ctx.mid, running.id, { ok: true })).status, 'executed');
});

// ---- REQ-02 / TEST-01: the retry bound is real, its hold is described truthfully and the owner has a way out ----
async function exhausted(t, { plan, review = { requiredTests: [UNIT] } } = {}) {
  const ctx = await fixture(t, { review, mission: { maxRetries: 0 }, ...(plan && { plan }) });
  await toAdjudication(ctx);
  assert.equal((await judge(ctx)).status, 'held');
  await ran(ctx, UNIT.id);
  return ctx;
}

test('REQ-02: with the retry budget exhausted the hold says the manifest is satisfied and names the owner remedy, never "missing"', async t => {
  const ctx = await exhausted(t);
  let w = await get(ctx);
  assert.equal(w.status, 'held'); assert.equal(w.requiredTests.state, 'satisfied'); assert.equal(w.requiredTests.accepted, true);
  assert.match(w.reason, /satisfied but fresh adjudication cannot run/);
  assert.match(w.reason, /retry limit is reached \(mission 0 of 0 retries used/);
  assert.match(w.reason, /Owner remedy: restart the workflow/);
  assert.doesNotMatch(w.reason, /missing|failing/, 'the stale "missing [unit]" diagnostic is gone');
  // The hold keeps following the evidence: a later failure is reported as a test problem again, not as a budget problem.
  await ran(ctx, UNIT.id, false);
  w = await get(ctx);
  assert.equal(w.status, 'held'); assert.match(w.reason, /Required independent test evidence is missing or failing: contradictory \[unit:path-scope\]/);
});

test('TEST-01: the retry bound itself decides whether late evidence can trigger another fresh adjudication', async t => {
  // The same story under two budgets: late pass -> approved -> later failure -> explicit superseding pass. Only the bound differs.
  for (const [maxRetries, finalStatus, used] of [[1, 'held', 1], [2, 'adjudication', 2]]) {
    const ctx = await fixture(t, { review: { requiredTests: [UNIT] }, mission: { maxRetries } });
    await toAdjudication(ctx);
    assert.equal((await judge(ctx)).status, 'held');
    await ran(ctx, UNIT.id);                                           // first re-adjudication draws on the budget
    assert.equal((await get(ctx)).status, 'adjudication'); assert.equal((await mission(ctx)).retryCount, 1);
    assert.equal((await judge(ctx)).status, 'code_approved');
    const failure = await ran(ctx, UNIT.id, false);                    // approval is revoked: contradiction
    assert.equal((await get(ctx)).status, 'held');
    await ran(ctx, UNIT.id, true, { supersedes: [failure.id], reason: 'Flaky runner; failure re-run and explained' });
    const w = await get(ctx);
    assert.equal(w.requiredTests.state, 'satisfied');
    assert.equal(w.status, finalStatus, `maxRetries ${maxRetries}`);
    assert.equal((await mission(ctx)).retryCount, used);
    if (finalStatus === 'held') assert.match(w.reason, /retry limit is reached \(mission 1 of 1/);
    else assert.equal(w.judgementGeneration, 2);
  }
});

test('REQ-02: the local owner can restart a held workflow; the successor is an independent fresh review and the old one is closed', async t => {
  const ctx = await exhausted(t, { plan: { entries: [REGRESSION] } });
  const before = await get(ctx);
  assert.equal(before.status, 'held');
  const dead = before.id, hash = before.source.hash;
  await assert.rejects(ctx.reviews.restart(ctx.mid, dead, { reason: 'x' }, runner), /trusted local owner/);
  await assert.rejects(ctx.reviews.restart(ctx.mid, dead, { reason: 'x' }, { trusted: true, source: 'native-host', authority: 'trusted-orchestrator' }), /trusted local owner/);
  await assert.rejects(ctx.reviews.restart(ctx.mid, dead, {}, owner), /needs a reason/);
  await assert.rejects(ctx.reviews.restart(ctx.mid, 'unknown', { reason: 'x' }, owner), /Unknown workflow/);
  assert.equal((await get(ctx)).status, 'held', 'refused restarts change nothing');
  const fresh = await ctx.reviews.restart(ctx.mid, dead, { reason: 'Retry budget spent; owner accepts a new review' }, owner);
  const m = await mission(ctx), old = m.workflows[dead];
  assert.equal(old.status, 'superseded'); assert.equal(old.supersededBy, fresh.id); assert.equal(old.approval, null);
  assert.match(old.reason, /Restarted by the local owner: Retry budget spent/);
  assert.notEqual(fresh.id, dead); assert.equal(fresh.restartOf, dead); assert.equal(fresh.source.hash, hash);
  assert.equal(fresh.status, 'review'); assert.deepEqual(fresh.tests, []); assert.equal(fresh.judgementGeneration ?? 0, 0);
  assert.deepEqual(fresh.requiredTests.tests.map(x => x.id), [REGRESSION.id, UNIT.id], 'owner policy and owner-registered plan entries carry over; no evidence does');
  assert.ok(fresh.authors.includes(ctx.author));
  assert.equal(m.retryCount, 0, 'a restart is an owner decision, not a draw on the exhausted retry budget');
  // The closed workflow accepts nothing further and a restart cannot be repeated on it.
  await assert.rejects(ctx.reviews.recordTest(ctx.mid, dead, { name: UNIT.id, testId: UNIT.id, passed: true, details: 'late', sourceHash: hash, planHash: old.requiredTests.planHash }, runner), /superseded/);
  await assert.rejects(ctx.reviews.restart(ctx.mid, dead, { reason: 'again' }, owner), /superseded/);
  await assert.rejects(ctx.reviews.addRequiredTests(ctx.mid, dead, [MANUAL], owner), /superseded/);
  await assert.rejects(ctx.reviews.invalidate(ctx.mid, dead, source('changed')), /superseded/);
  // The successor runs the normal path to approval under its own plan hash.
  ctx.wid = fresh.id;
  await ran(ctx, UNIT.id); await ran(ctx, REGRESSION.id);
  await toAdjudication(ctx);
  const approved = await judge(ctx);
  assert.equal(approved.status, 'code_approved'); assert.equal(approved.approval.sourceHash, hash);
  assert.notEqual(approved.requiredTests.planHash, old.requiredTests.planHash);
});

test('REQ-02: restart only applies to a held workflow, and cancels unfinished review work for the superseded one', async t => {
  const ctx = await fixture(t, { review: { requiredTests: [UNIT] } });
  await assert.rejects(ctx.reviews.restart(ctx.mid, ctx.wid, { reason: 'not stuck' }, owner), /Only a held workflow/);
  const assigned = await ctx.reviews.assign(ctx.mid, ctx.wid);
  // an unfinished reviewer exists when the source is replaced outside rework and the workflow is held
  await ctx.reviews.invalidate(ctx.mid, ctx.wid, source('function plan(p) { return [p, p]; }\n'));
  assert.equal((await get(ctx)).status, 'held');
  const fresh = await ctx.reviews.restart(ctx.mid, ctx.wid, { reason: 'Review the changed source afresh', testPlan: { entries: [REGRESSION] } }, owner);
  const m = await mission(ctx);
  assert.equal(m.workflows[ctx.wid].status, 'superseded');
  assert.equal(m.nodes[assigned[0].nodeId].status, 'cancelled'); assert.equal(m.requests[assigned[0].requestId].status, 'cancelled');
  assert.equal(fresh.source.content, 'function plan(p) { return [p, p]; }\n', 'the successor reviews the current source');
  assert.deepEqual(fresh.requiredTests.tests.map(x => x.id), [REGRESSION.id, UNIT.id]);
});
