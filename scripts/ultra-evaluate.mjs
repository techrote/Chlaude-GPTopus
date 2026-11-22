#!/usr/bin/env node
/** Offline owner evaluator. The backend is deterministic and never opens a network connection. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { ExecutionStore, digest } from '../plugins/openai-workers/ultra/store.mjs';
import { RecruitmentBroker } from '../plugins/openai-workers/ultra/broker.mjs';
import { UltraRuntime } from '../plugins/openai-workers/ultra/runtime.mjs';
import { ReviewController } from '../plugins/openai-workers/ultra/review.mjs';
import { ActionGate } from '../plugins/openai-workers/ultra/actions.mjs';
import { PermissionBoundary } from '../plugins/openai-workers/ultra/permissions.mjs';

export const LOW_RISK = Object.freeze({ complexity: 'low', impact: 'low', verifiability: 'high', confidence: 1,
  rationale: 'Deterministic fixture with no live API or external effects.', blastRadius: 'local', reversibility: 'reversible', testsAvailable: true, independentEvidence: true });
export const HIGH_RISK = Object.freeze({ ...LOW_RISK, impact: 'high', destructive: true,
  rationale: 'A simple cleanup planner could select valuable files if later executed; this evaluator only produces private patches.' });
const TOOL_RISK = Object.fromEntries(['complexity', 'impact', 'verifiability', 'confidence', 'rationale'].map(k => [k, LOW_RISK[k]]));
const SAFE_BASE = 'function planCleanup(paths) { return []; }\n';
const FLAWED = 'function planCleanup(paths) { return paths.filter(p => p.endsWith(".tmp")); }\n';
const FIXED = 'function planCleanup(paths) { return paths.filter(p => /^cache\\/[A-Za-z0-9_-]+\\.tmp$/.test(p)); }\n';
const owner = { trusted: true, source: 'local-user', authority: 'user' };
const TEST_ID = 'Synthetic cleanup scope cases';
const terminal = new Set(['completed', 'failed', 'blocked', 'cancelled']);
const call = (name, args, n = 0) => ({ call_id: `call_${n}_${name}`, name, args });
const toolOutputs = args => Array.isArray(args.input) ? args.input.filter(x => x.type === 'function_call_output').map(x => JSON.parse(x.output)) : [];
const jsonTask = node => { try { return JSON.parse(node.task); } catch { return {}; } };

async function context(label, config = {}, orchestrator = 'opus') {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ultra-evaluator-fixture-'));
  const project = path.join(directory, 'project'); await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'cleanup.js'), SAFE_BASE);
  await fs.writeFile(path.join(project, 'README.md'), 'Disposable ULTRA evaluator fixture.\n');
  let now = Date.parse('2026-11-21T12:00:00Z');
  const store = new ExecutionStore(path.join(directory, 'execution.json'), { now: () => now });
  const broker = new RecruitmentBroker(store, { config: { enabled: true, ...config }, now: () => now });
  const mission = await broker.createMission({ id: `offline_${label}`, task: `Offline ULTRA acceptance ${label}`, orchestrator: { model: orchestrator, trusted: orchestrator !== 'unverified', source: 'offline-fixture' } });
  return { label, directory, project, store, broker, missionId: mission.id, observations: [], transport: [],
    now: () => now, advance: ms => { now += ms; }, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}
function backendFor(ctx, program = () => ({ text: 'Fixture task completed.' })) {
  const counters = new Map(), state = new Map(); let responseSequence = 0;
  const backend = async (method, args) => {
    if (method !== 'create') throw new Error(`Unexpected fixture transport ${method}`);
    const id = /ULTRA governed agent ([^.]+)\./.exec(args.instructions)?.[1];
    assert.ok(id, 'Runtime must provide a recorded agent identity');
    const mission = await ctx.store.snapshot(ctx.missionId), node = mission.nodes[id];
    assert.ok(node, 'No unrecorded model invocation may reach the transport');
    const step = counters.get(id) ?? 0; counters.set(id, step + 1);
    if (!state.has(id)) state.set(id, {});
    ctx.transport.push({ method, nodeId: id, worker: node.worker, model: args.model, role: node.role, step, toolNames: args.tools.map(x => x.name), inputHash: digest(args.input) });
    const output = node.role === 'supervisor'
      ? { text: JSON.stringify({ decision: 'APPROVE', rationale: 'Offline independent supervisor inspected the exact synthetic proposal.' }) }
      : await program({ node, args, step, state: state.get(id), mission });
    return { id: `resp_offline_${++responseSequence}_${id.replaceAll('-', '')}`, status: 'completed', model: node.model,
      usage: { input: 24, output: 8, total: 32, total_tokens: 32 }, estimatedUsd: 0.00001, ...output };
  };
  backend.offline = true;
  return backend;
}
function runtimeFor(ctx, backend) {
  return new UltraRuntime(ctx.broker, { backend, boundaryFactory: options => new PermissionBoundary(options, { stageDirectory: ctx.directory }) });
}
async function drain(ctx, runtime, { rounds = 30, predicate } = {}) {
  for (let i = 0; i < rounds; i++) {
    const batch = await runtime.tick(ctx.missionId);
    const snapshot = await ctx.store.snapshot(ctx.missionId);
    const blocked = Object.values(snapshot.nodes).filter(n => n.pool && n.status === 'blocked');
    assert.equal(blocked.length, 0, `Unexpected blocked work: ${blocked.map(n => n.results.at(-1)?.value?.error ?? n.recoveryReason).join('; ')}`);
    if (predicate ? predicate(snapshot) : Object.values(snapshot.nodes).filter(n => n.pool).every(n => terminal.has(n.status)) && !Object.values(snapshot.requests).some(r => r.status === 'pending')) return snapshot;
    assert.ok(batch.length || Object.values(snapshot.requests).some(r => r.status === 'pending'), 'Scheduler stalled without pending authority');
  }
  throw new Error('Offline workflow did not converge within its bounded tick count');
}
async function evidence(ctx, extra = {}) {
  const state = await ctx.store.snapshot(), diagnostics = await ctx.broker.diagnostics(ctx.missionId);
  return { id: ctx.label, status: 'PASS', qualification: 'deterministic offline execution; no live API or Desktop UI',
    realApiRequests: 0, fixtureTransportCalls: ctx.transport.length, assertions: ctx.observations,
    diagnostics, events: state.events, transport: ctx.transport, ...extra };
}
async function withContext(label, config, fn, orchestrator) {
  const ctx = await context(label, config, orchestrator);
  try { return await fn(ctx); } finally { await ctx.cleanup(); }
}
function fixtureTests(source) {
  // This only evaluates one of the fixed pure-function fixtures above. It is not
  // presented as an OS sandbox or a facility for running untrusted agent code.
  assert.ok([SAFE_BASE, FLAWED, FIXED].includes(source), 'Evaluator only tests its known synthetic source');
  const cases = ['cache/a.tmp', 'documents/important.tmp', 'cache/../important.tmp', 'cache/a.txt', 'cache/nested/a.tmp'];
  const actual = vm.runInNewContext(`${source}\nJSON.stringify(planCleanup(${JSON.stringify(cases)}));`, Object.create(null), { timeout: 100 });
  const pass = actual === JSON.stringify(['cache/a.tmp']);
  return { passed: pass, details: JSON.stringify({ cases, expected: ['cache/a.tmp'], actual: JSON.parse(actual), fixtureOnly: true }) };
}
function editorProgram(content) {
  return ({ args, step, state }) => {
    const outputs = toolOutputs(args);
    if (step === 0) return { calls: [call('create_stage', { files: [{ rootId: '0', path: 'src/cleanup.js' }] })] };
    if (step === 1) {
      state.stage = outputs[0].id;
      return { calls: [call('stage_write', { stage: state.stage, root: '0', path: 'src/cleanup.js', content, expected_sha256: outputs[0].files[0].sha256 })] };
    }
    if (step === 2) return { calls: [call('stage_patch', { stage: state.stage })] };
    return { text: JSON.stringify({ source: { id: 'synthetic-cleanup.js', content }, patch: outputs[0] }) };
  };
}

export async function scenarioA() {
  // Resolve the fixture path before constructing owner scope; no user project is selected.
  const ctx = await context('A');
  try {
    ctx.broker = new RecruitmentBroker(ctx.store, { config: { enabled: true, permissions: { tools: ['read_file', 'stage_write'], roots: [ctx.project] }, desktop: { profile: 'C', enableExecutionBridge: true, roots: [ctx.project] } }, now: ctx.now });
    const mission = await ctx.broker.createMission({ id: 'offline_A_workflow', task: 'Synthetic high-impact cleanup planner', orchestrator: { model: 'opus', trusted: true, source: 'offline-fixture' } });
    ctx.missionId = mission.id;
    const editAuthor = editorProgram(FLAWED), editReworker = editorProgram(FIXED), blindInputs = [];
    const backend = backendFor(ctx, data => {
      if (data.node.role === 'implementation') return editAuthor(data);
      if (data.node.role === 'reworker') {
        const response = editReworker(data);
        if (response.text) { const result = JSON.parse(response.text); response.text = JSON.stringify({ ...result.source, patch: result.patch }); }
        return response;
      }
      const task = jsonTask(data.node), fixed = task.source.content === FIXED;
      if (['reviewer', 'second_opinion'].includes(data.node.role)) {
        assert.equal(Object.hasOwn(task, 'priorReviews'), false, 'Independent opinions must not receive prior conclusions');
        blindInputs.push({ role: data.node.role, nodeId: data.node.id, sourceHash: task.source.hash });
        return { text: JSON.stringify({ findings: fixed ? [] : [{ id: 'scope', severity: 'high', message: 'Cleanup selects protected or traversing paths.', area: 'path scope' }],
          coverage: [{ area: 'path scope', status: 'examined' }, { area: 'empty input', status: 'partial' }, { area: 'host execution', status: 'not_examined' }, { area: 'Windows junctions', status: 'uncertain' }] }) };
      }
      if (data.node.role === 'gap_inspector') {
        assert.ok(task.priorReviews.length >= 2); assert.ok(task.priorReviews.some(r => r.coverage.some(c => c.status === 'partial')));
        return { text: JSON.stringify({ findings: [{ id: 'gap-note', severity: 'medium', message: 'Host execution needs separate owner qualification.', area: 'host execution' }], coverage: [{ area: 'empty input', status: 'examined' }, { area: 'host execution', status: 'uncertain' }] }) };
      }
      assert.equal(data.node.role, 'judge');
      return { text: JSON.stringify({ findings: [], coverage: [{ area: 'independent findings and gap note', status: 'examined' }], resolutions: [], summary: 'Synthetic code passes; execution remains separately gated.' }) };
    });
    const runtime = runtimeFor(ctx, backend), reviews = new ReviewController(ctx.broker), actions = new ActionGate(ctx.broker);
    const authorRequest = await ctx.broker.request(ctx.missionId, 'root', { worker: 'luna6', role: 'implementation', task: 'Write a simple cleanup planner in an isolated stage.', risk: HIGH_RISK }, 'author');
    await drain(ctx, runtime);
    let snapshot = await ctx.store.snapshot(ctx.missionId), author = snapshot.nodes[authorRequest.nodeId];
    const authored = JSON.parse(author.results.at(-1).value.text);
    assert.equal(author.worker, 'luna6'); assert.equal(authored.patch.applied, false); assert.equal(authored.patch.patches[0].content, FLAWED);
    assert.equal(await fs.readFile(path.join(ctx.project, 'src', 'cleanup.js'), 'utf8'), SAFE_BASE);
    // Designated verification: high-impact work needs a plan naming the exact tests; one arbitrary passing test is not enough.
    let workflow = await reviews.start(ctx.missionId, { authorId: author.id, source: authored.source, risk: HIGH_RISK,
      testPlan: { entries: [{ id: TEST_ID, description: 'Synthetic cleanup scope cases (offline fixture)' }] }, principal: owner });
    assert.equal(fixtureTests(workflow.source.content).passed, false);
    snapshot = await drain(ctx, runtime, { predicate: m => m.workflows[workflow.id].status === 'rework' });
    workflow = snapshot.workflows[workflow.id];
    assert.equal(workflow.reviews.length, 2);
    snapshot = await drain(ctx, runtime, { predicate: m => m.workflows[workflow.id].round === 2 && m.workflows[workflow.id].status === 'review' });
    workflow = snapshot.workflows[workflow.id];
    const reworker = Object.values(snapshot.nodes).find(n => n.role === 'reworker');
    assert.equal(reworker.worker, 'sol6-2'); assert.equal(reworker.pool, 'core');
    const revised = JSON.parse(reworker.results.at(-1).value.text); assert.equal(revised.patch.applied, false);
    const tested = fixtureTests(workflow.source.content); assert.equal(tested.passed, true);
    // The in-process fixture stands in for the trusted executor; its attestation is synthetic, not a sandbox qualification.
    await reviews.recordTest(ctx.missionId, workflow.id, { sourceHash: workflow.source.hash, planHash: workflow.requiredTests.planHash, name: TEST_ID, testId: TEST_ID, ...tested,
      attestation: { runnerId: 'offline-evaluator-fixture', commandDigest: digest('vm fixture: cleanup scope cases'), exitCode: tested.passed ? 0 : 1, sourceHash: workflow.source.hash, qualification: 'trusted-executor' } }, { trusted: true, source: 'test-runner' });
    snapshot = await drain(ctx, runtime, { predicate: m => m.workflows[workflow.id].status === 'code_approved' });
    workflow = snapshot.workflows[workflow.id];
    assert.equal(workflow.reviews.filter(r => ['reviewer', 'second_opinion'].includes(r.role)).length, 4);
    const gap = Object.values(snapshot.nodes).find(n => n.role === 'gap_inspector');
    assert.equal(gap.worker, 'luna6'); assert.notEqual(gap.id, author.id);
    assert.equal(workflow.status, 'code_approved');
    const proposed = { kind: 'delete', description: 'Synthetic request to apply the cleanup plan; never executed.', workflowId: workflow.id, sourceHash: workflow.source.hash, targets: ['cache/a.tmp'] };
    const action = await actions.propose(ctx.missionId, author.id, proposed);
    await assert.rejects(actions.consume(ctx.missionId, action.id, proposed, { nodeId: author.id, capability: 'delete' }), /approval missing/);
    await actions.decide(ctx.missionId, action.id, { actionHash: action.hash, approved: true, rationale: 'Synthetic user vote for boundary test only.' }, owner);
    // A granted staging capability cannot stand in for the delete capability,
    // and even the correct action capability must exist on the author.
    await assert.rejects(actions.consume(ctx.missionId, action.id, proposed, { nodeId: author.id, capability: 'stage_write' }), /Claimed capability does not authorise this action class/);
    await assert.rejects(actions.consume(ctx.missionId, action.id, proposed, { nodeId: author.id, capability: 'delete' }), /cannot enlarge tool permissions/);
    assert.equal((await ctx.store.snapshot(ctx.missionId)).actions[action.id].status, 'approved', 'Rejected tool attempts must not consume approval or execute an action');
    const priorSource = workflow.source.hash;
    await reviews.invalidate(ctx.missionId, workflow.id, { ...workflow.source, content: `${FIXED}// changed after review\n` });
    await assert.rejects(reviews.submit(ctx.missionId, workflow.id, author.id, priorSource, { findings: [], coverage: [] }), /stale/);
    snapshot = await ctx.store.snapshot(ctx.missionId); assert.equal(snapshot.actions[action.id].status, 'stale');
    ctx.observations.push('Luna authored an actual private patch; Astra independently reviewed; Sol reworked; Astra re-reviewed.',
      'Two blind senior opinions inspected each source version; a fresh Luna inspected coverage gaps and a senior judge assessed them.',
      'Trusted deterministic tests were tied to the revised source; code approval did not authorise deletion.',
      'Even a synthetic user action vote could not enlarge tool permissions; a later source change invalidated evidence.');
    return await evidence(ctx, { completedWorkflowBeforeFreshnessCheck: 'code_approved', blindInputs, actualProjectChanged: false });
  } finally { await ctx.cleanup(); }
}

export async function scenarioB() {
  const runs = [];
  for (const mode of ['SWARM', 'REPLICATOR', 'SKYNET']) {
    const baseRules = [
      { id: 'sol-peer', authority: 'helicop-sol', enabled: true, when: { parentFamilies: ['sol'], childFamilies: ['sol'] }, mandatory: true, veto: true, priority: 50 },
      { id: 'sol-astra', authority: 'helicop-astra', enabled: true, when: { parentFamilies: ['sol'], childFamilies: ['astra'] }, mandatory: true, veto: true, priority: 100 },
      ...(mode === 'SKYNET' ? [{ id: 'combined-sol-check', authority: 'helicop-sol', enabled: true, when: { parentFamilies: ['sol'], childFamilies: ['astra'] }, mandatory: true, veto: true, priority: 50 }] : []),
    ];
    runs.push(await withContext(`B_${mode}`, { recruitment: { mode }, helicop: { rules: baseRules } }, async ctx => {
      const workers = mode === 'SWARM' ? ['terra5-6free', 'luna6'] : mode === 'REPLICATOR' ? ['sol6-2'] : ['astra6-2'];
      const backend = backendFor(ctx, ({ node, args, step, state }) => {
        if (node.task !== 'recursive-parent') return { text: 'Bounded child result.' };
        if (state.waiting) return { text: 'Parent received completed child results.' };
        if (step === 0) return { calls: workers.map((worker, i) => call('recruit_agent', { worker, role: 'exploration', task: `bounded-${worker}`, risk: TOOL_RISK, budget: { tokens: 20000, usd: 1 } }, i)) };
        const outputs = toolOutputs(args).flat(), children = outputs.filter(x => x.nodeId).map(x => x.nodeId);
        if (children.length === workers.length) { state.waiting = true; return { calls: [call('wait_for_agents', { ids: children })] }; }
        return { calls: [call('agent_results', {})] };
      });
      const runtime = runtimeFor(ctx, backend);
      const parent = await ctx.broker.request(ctx.missionId, 'root', { worker: 'sol6-2', role: 'exploration', task: 'recursive-parent', mode, risk: LOW_RISK }, 'recursive-parent');
      if (mode === 'SWARM') {
        const denied = await ctx.broker.request(ctx.missionId, parent.nodeId, { worker: 'astra6-2', role: 'implementation', task: 'Attempt forbidden higher author.', risk: LOW_RISK }, 'forbidden-upgrade');
        assert.equal(denied.status, 'rejected');
        const relabel = await ctx.broker.request(ctx.missionId, parent.nodeId, { worker: 'astra6-2', mode: 'SKYNET', role: 'implementation', task: 'Attempt mode laundering.', risk: LOW_RISK }, 'launder');
        assert.equal(relabel.status, 'rejected');
      }
      const snapshot = await drain(ctx, runtime), nodes = Object.values(snapshot.nodes);
      assert.equal(nodes.find(n => n.id === parent.nodeId).status, 'completed');
      assert.ok(nodes.filter(n => n.parentId === parent.nodeId).length >= workers.length);
      assert.ok((await ctx.store.snapshot()).events.some(e => e.type === 'agent.waiting'));
      const supervisors = nodes.filter(n => n.role === 'supervisor');
      assert.equal(supervisors.length, mode === 'SWARM' ? 0 : mode === 'REPLICATOR' ? 1 : 2);
      assert.ok(supervisors.every(n => n.status === 'completed' && n.permissions.tools.length === 0));
      ctx.observations.push(`${mode} completed actual recursive runtime recruitment and cooperative wait.`, `${supervisors.length} independent HELICOP decision(s) passed through durable approval records.`);
      return evidence(ctx);
    }));
  }
  return { id: 'B', status: 'PASS', qualification: 'offline recursive runtime', realApiRequests: 0, runs };
}

export async function scenarioC() {
  const runs = [];
  for (const model of ['opus', 'fable', 'sonnet', 'haiku']) runs.push(await withContext(`C_${model}`, {}, async ctx => {
    const request = await ctx.broker.request(ctx.missionId, 'root', { worker: 'astra6-2', role: 'exploration', task: 'A bounded architect task.', risk: LOW_RISK }, 'identity');
    assert.equal(request.status, ['opus', 'fable'].includes(model) ? 'queued' : 'pending');
    if (model === 'haiku') assert.equal(request.evaluation.requiredApprovals.find(a => a.id === 'orchestrator-authority').decisionMaker, true);
    const runtime = runtimeFor(ctx, backendFor(ctx)); const snapshot = await drain(ctx, runtime);
    const supervisors = Object.values(snapshot.nodes).filter(n => n.role === 'supervisor');
    assert.equal(supervisors.length, ['opus', 'fable'].includes(model) ? 0 : 1);
    assert.ok(Object.values(snapshot.nodes).filter(n => n.pool).every(n => n.model.startsWith('gpt-')));
    ctx.observations.push(`${model} authority enforced without spawning another Claude model.`);
    return evidence(ctx);
  }, model));
  runs.push(await withContext('C_unverified', {}, async ctx => {
    // The caller can spell 'opus', but untrusted identity never gains its authority.
    await ctx.store.transaction(state => { state.missions[ctx.missionId].orchestrator = { model: 'opus', trusted: false, source: 'caller-string-fixture' }; });
    const request = await ctx.broker.request(ctx.missionId, 'root', { worker: 'astra6-2', role: 'exploration', task: 'Unverified caller request.', risk: LOW_RISK }, 'unverified');
    assert.equal(request.status, 'pending'); assert.ok(request.evaluation.requiredApprovals.some(a => a.authority === 'user'));
    const runtime = runtimeFor(ctx, backendFor(ctx)); assert.equal((await runtime.tick(ctx.missionId)).length, 0);
    ctx.observations.push('A caller-supplied Opus string remains restricted and awaits the configured authority.');
    return evidence(ctx);
  }));
  return { id: 'C', status: 'PASS', qualification: 'offline model-dependent governance', realApiRequests: 0, runs };
}

export async function scenarioD() {
  return withContext('D', { recruitment: { mode: 'REPLICATOR' }, review: { primary: 'sol6-2' }, mission: { maxTokens: 600000, maxUsd: 80 } }, async ctx => {
    const core = [];
    for (let i = 0; i < 12; i++) core.push(await ctx.broker.request(ctx.missionId, 'root', { worker: i === 0 ? 'sol6-2' : 'luna6', role: 'exploration', task: `Core saturation ${i}`, risk: LOW_RISK }, `core-${i}`));
    await assert.rejects(ctx.broker.request(ctx.missionId, 'root', { worker: 'luna6', role: 'exploration', task: 'Thirteenth Core allocation', risk: LOW_RISK }, 'overflow'), /invocation limit/);
    for (let i = 0; i < 3; i++) await ctx.broker.request(ctx.missionId, 'root', { worker: 'astra6-2', role: 'reviewer', task: `Independent critical review ${i}`, risk: HIGH_RISK, budget: { tokens: 16000, usd: 2 } }, `review-${i}`);
    for (let i = 0; i < 4; i++) assert.ok(await ctx.broker.claim(ctx.missionId, 'core-fixture', { pool: 'core' }));
    assert.equal(await ctx.broker.claim(ctx.missionId, 'core-fixture', { pool: 'core' }), null);
    for (let i = 0; i < 2; i++) assert.ok(await ctx.broker.claim(ctx.missionId, 'review-fixture', { pool: 'review' }));
    assert.equal(await ctx.broker.claim(ctx.missionId, 'review-fixture', { pool: 'review' }), null, 'Ordinary review must leave protected slot unused');
    // The fixture owner preauthorises Sol under Policy B; the parent cannot
    // select another reviewer merely because capacity is available.
    const wrongReviewer = await ctx.broker.request(ctx.missionId, core[0].nodeId, { worker: 'luna6', role: 'reviewer', task: 'Attempt to substitute the preauthorised reviewer.', risk: LOW_RISK, budget: { tokens: 16000, usd: 2 } }, 'wrong-reviewer');
    assert.equal(wrongReviewer.status, 'rejected');
    assert.ok(wrongReviewer.evaluation.reasons.some(reason => reason.includes('preauthorised')));
    const pending = await ctx.broker.request(ctx.missionId, core[0].nodeId, { worker: 'sol6-2', role: 'reviewer', task: 'Mandatory peer review under saturation.', risk: LOW_RISK, budget: { tokens: 16000, usd: 2 } }, 'mandatory');
    assert.equal(pending.status, 'pending');
    const supervisor = await ctx.broker.appointSupervisor(ctx.missionId, pending.id, 'helicop-sol');
    const claimed = await ctx.broker.claim(ctx.missionId, 'supervisor-fixture', { pool: 'review' });
    assert.equal(claimed.id, supervisor.id);
    const runtime = runtimeFor(ctx, backendFor(ctx)); const result = await runtime.step(ctx.missionId, claimed); assert.equal(result.status, 'completed');
    const diagnostics = await ctx.broker.diagnostics(ctx.missionId);
    assert.equal(diagnostics.fleets.core.invocations, 12); assert.equal(diagnostics.fleets.core.running, 4);
    assert.equal(diagnostics.fleets.review.running, 2);
    await assert.rejects(ctx.broker.request(ctx.missionId, 'root', { worker: 'astra6-2', role: 'reviewer', task: 'Exceed the shared limit.', risk: LOW_RISK, budget: { tokens: 100000, usd: 2 } }, 'shared-overflow'), /Shared mission token budget/);
    ctx.observations.push('All 12 Lite Core invocations were allocated; four Core agents and two ordinary reviewers occupied their independent running slots.',
      'Ordinary Review work could not consume the protected third slot; a mandatory HELICOP-SOL executed there.',
      'Policy B used an explicitly owner-preauthorised Sol reviewer and rejected a reviewer substitution.',
      'The shared mission token ceiling remained binding across both fleets.');
    return evidence(ctx);
  });
}

export async function scenarioE() {
  const runs = [];
  for (const profile of ['A', 'B', 'C']) {
    const ctx = await context(`E_${profile}`);
    try {
      ctx.broker = new RecruitmentBroker(ctx.store, { config: { enabled: true, permissions: { tools: ['read_file', 'stage_write'], roots: [ctx.project] }, desktop: { profile, enableExecutionBridge: profile === 'C', roots: [ctx.project] } }, now: ctx.now });
      const m = await ctx.broker.createMission({ id: `offline_E_${profile}_permissions`, task: `Synthetic permission profile ${profile}`, orchestrator: { model: 'opus', trusted: true } }); ctx.missionId = m.id;
      const backend = backendFor(ctx, data => {
        if (profile === 'A') { assert.equal(data.args.tools.some(t => t.name === 'read_file'), false); return { text: 'Think-only answer.' }; }
        if (profile === 'B') {
          assert.equal(data.args.tools.some(t => t.name === 'stage_write'), false);
          if (data.step === 0) return { calls: [call('read_file', { root: '0', path: 'README.md' })] };
          assert.match(toolOutputs(data.args)[0].content, /Disposable/); return { text: 'Read-only source inspected.' };
        }
        return editorProgram(FIXED)(data);
      });
      const runtime = runtimeFor(ctx, backend);
      const request = await ctx.broker.request(ctx.missionId, 'root', { worker: 'luna6', role: 'implementation', task: `Profile ${profile} fixture.`, risk: LOW_RISK }, 'profile');
      await drain(ctx, runtime);
      const snapshot = await ctx.store.snapshot(ctx.missionId), node = snapshot.nodes[request.nodeId], boundary = runtime.boundary(snapshot, node);
      if (profile === 'A') await assert.rejects(boundary.readFile('0', 'README.md'), error => error.code === 'PROFILE');
      else await assert.rejects(boundary.readFile('0', '../outside.txt'));
      if (profile === 'B') await assert.rejects(boundary.createStage([{ rootId: '0', path: 'src/cleanup.js' }]), error => error.code === 'PROFILE');
      if (profile === 'C') {
        const result = JSON.parse(node.results.at(-1).value.text); assert.equal(result.patch.applied, false);
        assert.throws(() => boundary.applyToProject(), error => error.code === 'LIVE_WRITE');
        assert.throws(() => boundary.executeConsequential({ approved: true }), error => error.code === 'EXECUTION_GATE');
      }
      assert.equal(await fs.readFile(path.join(ctx.project, 'src', 'cleanup.js'), 'utf8'), SAFE_BASE);
      ctx.observations.push(`Profile ${profile} exercised through the real runtime and file boundary.`, 'No live project changes or shell execution occurred.');
      runs.push(await evidence(ctx, { hostUiQualification: 'NOT RUN', actualProjectChanged: false }));
    } finally { await ctx.cleanup(); }
  }
  return { id: 'E', status: 'PASS', qualification: 'shared runtime A/B/private-stage C permission boundaries; actual Desktop UI remains NOT RUN', realApiRequests: 0, runs };
}

export async function scenarioF() {
  return withContext('F', {}, async ctx => {
    let creates = 0, polls = 0;
    const backend = async (method, args) => {
      if (method === 'create') { creates++; return { id: 'resp_resume_known', status: 'in_progress' }; }
      polls++; return { id: args.id, status: 'completed', text: 'Preserved accepted response after restart.', usage: { total_tokens: 32, total: 32, input: 24, output: 8 }, estimatedUsd: 0.00001 };
    }; backend.offline = true;
    const request = await ctx.broker.request(ctx.missionId, 'root', { worker: 'luna6', role: 'exploration', task: 'Recover an accepted request.', risk: LOW_RISK }, 'recover-known');
    await runtimeFor(ctx, backend).tick(ctx.missionId);
    const crashed = await ctx.broker.claim(ctx.missionId, 'crashed-process', { leaseMs: 10 }); assert.equal(crashed.id, request.nodeId);
    ctx.advance(100);
    const restartedStore = new ExecutionStore(ctx.store.path, { now: ctx.now });
    ctx.broker = new RecruitmentBroker(restartedStore, { config: { enabled: true }, now: ctx.now }); ctx.store = restartedStore;
    const resumed = await runtimeFor(ctx, backend).tick(ctx.missionId);
    assert.equal(resumed[0].status, 'completed'); assert.equal(creates, 1); assert.equal(polls, 1);
    const unknown = await ctx.broker.request(ctx.missionId, 'root', { worker: 'luna6', role: 'exploration', task: 'Ambiguous sent request.', risk: LOW_RISK }, 'recover-unknown');
    const claim = await ctx.broker.claim(ctx.missionId, 'crashed-process', { leaseMs: 10 }); assert.equal(claim.id, unknown.nodeId);
    await ctx.broker.checkpoint(ctx.missionId, claim.id, claim.lease.token, { runtime: { phase: 'sending', steps: 0, usage: { tokens: 0, usd: 0 }, requestKey: 'accepted-or-lost' } });
    ctx.advance(100); await ctx.broker.recover(ctx.missionId);
    assert.equal((await runtimeFor(ctx, backend).tick(ctx.missionId)).length, 0);
    const snapshot = await ctx.store.snapshot(ctx.missionId);
    assert.equal(snapshot.nodes[unknown.nodeId].status, 'blocked'); assert.ok(snapshot.nodes[unknown.nodeId].reservation.tokens > 0);
    assert.equal(snapshot.nodes[request.nodeId].results[0].value.text, 'Preserved accepted response after restart.');
    assert.equal(creates, 1, 'Ambiguous work must never be replayed automatically');
    ctx.observations.push('An expired lease with a known response resumed by poll, preserving accepted output.',
      'An interrupted sending phase was blocked for reconciliation with its reservation retained; no duplicate POST occurred.');
    return evidence(ctx, { creates, polls });
  });
}

export const SCENARIOS = Object.freeze([
  { id: 'A', title: 'Cheap author, independent validation and protected execution', run: scenarioA },
  { id: 'B', title: 'Recursive SWARM, REPLICATOR and SKYNET with HELICOP', run: scenarioB },
  { id: 'C', title: 'Trusted Claude model-dependent authority', run: scenarioC },
  { id: 'D', title: 'Core saturation with protected Review capacity', run: scenarioD },
  { id: 'E', title: 'Think-only, read-only and private staged editing', run: scenarioE },
  { id: 'F', title: 'Crash recovery and no ambiguous replay', run: scenarioF },
]);

export async function provenance(repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  let commit = null, dirty = null, files;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
    dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim());
    files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repo, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean).sort();
  } catch { files = ['plugins/openai-workers/ultra/config.mjs', 'plugins/openai-workers/ultra/policy.mjs', 'plugins/openai-workers/ultra/broker.mjs', 'plugins/openai-workers/ultra/runtime.mjs', 'plugins/openai-workers/ultra/store.mjs', 'plugins/openai-workers/ultra/review.mjs', 'plugins/openai-workers/ultra/actions.mjs', 'plugins/openai-workers/ultra/permissions.mjs', 'scripts/ultra-evaluate.mjs', 'scripts/Evaluate-ULTRA.ps1', 'scripts/Run-ULTRA-Evaluator.cmd', 'plugins/openai-workers/bridge/workers.mjs']; }
  const hashes = [];
  for (const file of [...new Set(files)]) {
    if (!/\.(?:mjs|js|json|ps1|cmd|yml|yaml)$/.test(file)) continue;
    try { hashes.push([file, digest(await fs.readFile(path.join(repo, file), 'utf8'))]); } catch { hashes.push([file, 'MISSING']); }
  }
  return { commit, dirty, sourceFingerprint: digest(hashes), files: hashes, node: process.version, platform: process.platform, architecture: process.arch };
}
export async function evaluate({ outputDirectory, scenarios = SCENARIOS.map(x => x.id), expectedSha } = {}) {
  const output = outputDirectory ? path.resolve(outputDirectory) : await fs.mkdtemp(path.join(os.tmpdir(), 'ULTRA-acceptance-report-'));
  await fs.mkdir(output, { recursive: true });
  for (const filename of ['report.json', 'summary.txt', 'activity.jsonl', 'budgets.json']) {
    try { await fs.access(path.join(output, filename)); const error = new Error('Acceptance output already exists; choose a new directory.'); error.code = 'EEXIST'; throw error; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const source = await provenance();
  if (expectedSha) assert.equal(source.commit, expectedSha, 'Checked-out source does not match the requested exact SHA');
  const report = { programme: 'ULTRA-001', generatedAt: new Date().toISOString(), qualification: 'OFFLINE ONLY', source, realApiRequests: 0, realApiSpendUsd: 0,
    liveDesktopUi: 'NOT RUN', liveOpenAiApi: 'NOT RUN', consequentialActionsExecuted: 0, scenarios: [] };
  for (const scenario of SCENARIOS.filter(s => scenarios.includes(s.id))) {
    const began = Date.now();
    try { const result = await scenario.run(); report.scenarios.push({ title: scenario.title, durationMs: Date.now() - began, ...result }); }
    catch (error) { report.scenarios.push({ id: scenario.id, title: scenario.title, status: 'FAIL', error: String(error.stack ?? error), durationMs: Date.now() - began }); }
    process.stdout.write(`${report.scenarios.at(-1).status} ${scenario.id} - ${scenario.title}\n`);
  }
  report.status = report.scenarios.length && report.scenarios.every(s => s.status === 'PASS') ? 'PASS' : 'FAIL';
  const flatten = values => values.flatMap(v => v.runs ? flatten(v.runs) : [v]);
  const leaf = flatten(report.scenarios);
  const events = leaf.flatMap(s => (s.events ?? []).map(event => ({ scenario: s.id, ...event })));
  const budgets = leaf.map(s => ({ scenario: s.id, status: s.status, fleets: s.diagnostics?.fleets, estimatedFixtureUsageAndReservations: s.diagnostics?.estimated, remaining: s.diagnostics?.remaining }));
  const summary = [`ULTRA-001 OFFLINE ACCEPTANCE: ${report.status}`, `Source commit: ${source.commit ?? 'unavailable (archive/no Git)'}`, `Working tree modified: ${source.dirty ?? 'unknown'}`, `Source fingerprint: ${source.sourceFingerprint}`,
    `Node: ${source.node}; platform: ${source.platform}; architecture: ${source.architecture}`, '', ...report.scenarios.map(s => `${s.status} ${s.id}: ${s.title}${s.error ? `\n${s.error}` : ''}`), '',
    'Live API calls: 0. Real API spend: $0. Consequential local/external actions: 0.',
    'Reported agent tokens/dollars are deterministic fixture data, not billed usage.',
    'Desktop UI, real Claude host hooks and live OpenAI API qualification: NOT RUN.',
    'Profile C proves private staging and blocked execution. This does not certify an OS sandbox or live editing/testing.',
    'Owner: inspect report.json, activity.jsonl and budgets.json. Record physical Desktop/API acceptance separately.', ''].join('\n');
  // Refuse to silently overwrite a previous acceptance record.
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  await fs.writeFile(path.join(output, 'summary.txt'), summary, { flag: 'wx' });
  await fs.writeFile(path.join(output, 'activity.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(output, 'budgets.json'), JSON.stringify({ note: 'Synthetic estimates and reservations only; no real spend.', scenarios: budgets }, null, 2), { flag: 'wx' });
  process.stdout.write(`Report: ${path.join(output, 'summary.txt')}\n`);
  return { ...report, outputDirectory: output };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--output' && args[i + 1]) options.outputDirectory = args[++i];
      else if (args[i] === '--expect-sha' && args[i + 1]) options.expectedSha = args[++i];
      else if (args[i] === '--scenario' && args[i + 1]) { options.scenarios ??= []; const selected = args[++i]; assert.ok(SCENARIOS.some(s => s.id === selected), 'Unknown scenario'); options.scenarios.push(selected); }
      else if (args[i] === '--help') { process.stdout.write('Usage: node scripts/ultra-evaluate.mjs [--output NEW_DIRECTORY] [--scenario A..F] [--expect-sha EXACT_GIT_SHA]\nOffline only. No credentials, network, installation changes or user project access.\n'); process.exit(0); }
      else throw new Error(`Unknown argument: ${args[i]}`);
    }
    const result = await evaluate(options); process.exitCode = result.status === 'PASS' ? 0 : 1;
  } catch (error) { process.stderr.write(`Evaluator failed: ${error.message}\n`); process.exitCode = 1; }
}
