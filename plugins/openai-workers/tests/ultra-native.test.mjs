import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { register } from '../hooks/register.js';
import { hostVersionSupported, trustedClaudeFamily, nativeOpenAITools, filterNativeToolArgs, NATIVE_PREFIX } from '../hooks/ultra.js';
import { NativeController } from '../ultra/native-controller.mjs';
import { ExecutionStore } from '../ultra/store.mjs';
import { RecruitmentBroker } from '../ultra/broker.mjs';
import { UltraRuntime } from '../ultra/runtime.mjs';

const risk = { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 0.95, rationale: 'Deterministic bounded offline fixture.' };
const prompt = (task = 'Synthetic bounded work', extra = {}) => JSON.stringify({ task, ultra: { role: 'exploration', risk, budget: { tokens: 40000, usd: 4 }, ...extra } });
const tool = name => `${NATIVE_PREFIX}ultra_${name}`;

async function fixture(t, { config = {}, model = 'opus', version = '2.1.326', enabled = true, backend: supplied, info = {}, surfaces = ['terminal'] } = {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ultra-native-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(directory, 'execution.json'));
  const broker = new RecruitmentBroker(store, { config: { enabled: true, ...config } });
  const calls = [], bridgeCalls = [];
  let responseCounter = 0;
  const backend = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (supplied) return supplied(name, args, calls.length);
    return { id: `resp_native_${++responseCounter}`, status: 'completed', model: args.model, text: 'Synthetic work complete.', usage: { total: 50 }, estimatedUsd: 0.001 };
  };
  backend.offline = true;
  const runtime = new UltraRuntime(broker, { backend });
  const controller = new NativeController(broker, { backend, supervisorTick: missionId => runtime.tick(missionId, { maxAgents: 1 }) });
  const handlers = new Map(), catches = new Map(), agents = [], states = new Map(), messages = new Map(), registeredAgents = [], registeredTools = [];
  const keyOf = (event, filter) => `${event}${event === 'command.run' && filter?.command ? `:${filter.command}` : filter?.tool ? `:${filter.tool}` : ''}`;
  register((event, filter, fn) => {
    if (typeof filter === 'function') { fn = filter; filter = null; }
    const key = keyOf(event, filter); assert.ok(!handlers.has(key), `duplicate hook ${key}`); handlers.set(key, fn);
    return { catch(handler) { catches.set(key, handler); return this; } };
  });
  let hostModel = model, bindFailure = false, spawns = 0, fallback = 0;
  const context = {
    agent: { register: async x => registeredAgents.push(x), list: async () => structuredClone(agents) },
    tool: { register: async x => { registeredTools.push(x); return { tool: `${NATIVE_PREFIX}${x.name}` }; } },
    command: { register: async () => {} },
    env: { get: async name => name === 'OPENAI_ULTRA_ENABLED' ? enabled ? '1' : undefined : undefined },
    session: { version: async () => ({ version }), id: async () => 'synthetic-native-session', model: async () => hostModel,
      surfaces: async () => structuredClone(surfaces),
      info: async () => ({ platform: 'linux', isHosted: false, dataRules: [], ...info }),
      messages: async args => args.as === 'api' ? [] : structuredClone(messages.get(args.agentId) ?? []), cwd: async () => directory },
    state: { get: async ref => ({ value: states.get(ref.id) }), set: async (ref, value) => states.set(ref.id, structuredClone(value)) },
    fs: { read: async () => '' },
    mcp: { call: async (_server, name, args) => {
      bridgeCalls.push({ name, args: structuredClone(args) });
      if (bindFailure && name === 'ultra_native_bind') throw new Error('Synthetic bind transport failure');
      const value = name.startsWith('ultra_native_') ? await controller.handle(name, args, { trustedHostChannel: true }) : await backend(name, args);
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } },
  };
  async function run(event, e, delegate = async () => ({})) {
    const exact = keyOf(event, e), key = handlers.has(exact) ? exact : event, handler = handlers.get(key); assert.ok(handler, `missing hook ${key}`);
    let called = false, result;
    // The official CatchHandler API explicitly makes next replay-safe once
    // called. This harness models that guarantee instead of duplicating work.
    const next = async value => { if (!called) { called = true; result = Promise.resolve().then(() => delegate(value)); } return result; };
    Object.defineProperty(next, 'called', { get: () => called }); next.signal = new AbortController().signal;
    next.origin = { plugin: 'engine', tier: 'core' };
    try { return await handler(context, e, next); }
    catch (error) { if (!catches.has(key)) throw error; next.error = { kind: 'throw', message: error.message }; return catches.get(key)(context, e, next); }
  }
  async function spawn(worker, options = {}) {
    const event = { tool_use_id: options.toolUseId ?? `spawn_${spawns + 1}`, subagentType: `openai-workers:${worker}`,
      prompt: options.prompt ?? prompt(), description: 'Synthetic native child', parentAgentId: options.parentAgentId,
      parentModel: hostModel, background: options.background ?? false, provider: { plugin: 'openai-workers', tier: 'user' }, fork: false };
    let started;
    const result = await run('agent.spawn', event, async rewritten => {
      const id = `native_agent_${++spawns}`;
      started = { id, type: rewritten.subagentType, parentId: rewritten.parentAgentId, status: 'running', model: hostModel };
      agents.push(started); messages.set(id, [{ role: 'user', text: rewritten.prompt }]);
      if (options.startBeforeReturn) await run('turn.start', { agentId: id, text: rewritten.prompt, turnId: `turn_${id}` });
      return { model: hostModel, agentId: id };
    });
    if (started && !options.startBeforeReturn && !bindFailure) await run('turn.start', { agentId: started.id, text: messages.get(started.id)[0].text, turnId: `turn_${started.id}` });
    return result;
  }
  async function step(agentId, index = 0) {
    const e = { agentId, turnId: `turn_${agentId}`, index, effort: 'max' };
    const next = async function* () { fallback++; throw new Error('Unexpected Claude fallback'); };
    next.signal = new AbortController().signal;
    const iterator = handlers.get('turn.step')(context, e, next), chunks = [];
    let value = await iterator.next(); while (!value.done) { chunks.push(value.value); value = await iterator.next(); }
    return { ...value.value, chunks };
  }
  async function finish(agentId, answer = 'Synthetic accepted output') {
    const outcome = await run('turn.complete', { agentId, answer, isAborted: false, reason: 'answer' }, async () => ({ text: answer }));
    const a = agents.find(a => a.id === agentId); if (a) a.status = 'completed'; return outcome;
  }
  async function execute(agentId, name, input, callId = 'native-tool-1') {
    const check = await run('tool.check', { agentId, tool: name, input, tool_use_id: callId }, async () => ({ decision: 'allow' }));
    if (check.decision !== 'allow') return { deny: check.reason };
    const result = await run('tool.run', { agentId, tool: name, tool_use_id: callId, ...input }, async e => {
      if (e.tool === 'Agent') {
        const spawned = await spawn(e.subagent_type.replace('openai-workers:', ''), { parentAgentId: e.agentId, prompt: e.prompt, background: e.run_in_background, toolUseId: callId });
        return { result: spawned };
      }
      throw new Error('No native filesystem or process execution is installed in this fixture');
    });
    if (agentId) messages.get(agentId).push({ role: 'user', toolResults: [{ tool_use_id: callId, text: JSON.stringify(result.result ?? result.deny), isError: Boolean(result.deny) }] });
    return result;
  }
  await run('session.start', {});
  const initialized = bridgeCalls.find(c => c.name === 'ultra_native_init');
  const snapshot = async () => {
    const state = await store.snapshot(); return Object.values(state.missions).find(m => m.surface === 'native');
  };
  return { directory, store, broker, runtime, controller, context, handlers, catches, registeredAgents, registeredTools, calls, bridgeCalls,
    run, spawn, step, execute, finish, snapshot, agents, states, initialized,
    setModel: async value => {
      hostModel = value;
      const iterator = handlers.get('turn.step')(context, { turnId: 'root-model-change', index: 0, model: value }, async function* () {});
      await iterator.next();
    }, failBinding: () => { bindFailure = true; }, spawnCount: () => spawns, fallbackCount: () => fallback };
}

test('native helper schemas classify only exact known host identities and guarded tools', () => {
  assert.equal(hostVersionSupported('2.1.326'), true); assert.equal(hostVersionSupported('2.1.325'), false);
  assert.equal(trustedClaudeFamily('claude-opus-4-6'), 'opus'); assert.equal(trustedClaudeFamily('fable'), 'fable');
  for (const name of ['opus-impostor', 'other/opus', 'claude-opus-trusted', 'gpt-6.2-astra']) assert.equal(trustedClaudeFamily(name), 'unknown');
  assert.throws(() => filterNativeToolArgs('Agent', { subagent_type: 'openai-workers:sol', prompt: 'x', description: 'x', model: 'opus' }), /Unsupported/);
  assert.throws(() => filterNativeToolArgs('constructor', {}), /Unsupported/);
  assert.deepEqual(nativeOpenAITools({ role: 'supervisor', permissions: { recruit: { lower: true }, reviewHigher: true, tools: ['read_file'] } }, 'C'), []);
});

test('native opt-in registers recursive Agent and scoped tools while legacy mode retains its four tools', async t => {
  const off = await fixture(t, { enabled: false });
  assert.equal(off.registeredAgents.length, 6); assert.equal(off.registeredTools.length, 0);
  assert.ok(off.registeredAgents.every(a => a.tools.join(',') === 'Read,Edit,Write,Bash'));
  const on = await fixture(t);
  assert.equal(on.registeredAgents.length, 6); assert.equal(on.registeredTools.length, 13);
  assert.ok(on.registeredAgents.every(a => a.tools.includes('Agent') && !a.tools.includes('Bash')));
});

test('native controller requires mediated transport and private model calls are denied for every actor', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.controller.handle('ultra_native_init', { sessionId: 'forgery', model: 'opus', version: '2.1.326' }), /mediated/);
  for (const agentId of [undefined, 'unknown-worker']) for (const name of ['mcp__openai-workers__ultra_native_init', 'mcp__plugin_openai-workers_bridge__create']) {
    let runs = 0;
    const check = await f.run('tool.check', { agentId, tool: name, input: { model: 'opus' } }, async () => { runs++; return { decision: 'allow' }; });
    assert.equal(check.decision, 'deny');
    const execution = await f.run('tool.run', { agentId, tool: name }, async () => { runs++; return { result: 'BAD' }; });
    assert.ok(execution.deny); assert.equal(runs, 0);
  }
  const disabled = await fixture(t, { enabled: false });
  assert.equal((await disabled.run('tool.check', { tool: 'mcp__x__ultra_native_init' })).decision, 'deny');
});

test('native recursion runs actual Agent hook path and releases a foreground parent slot', async t => {
  let parentTurns = 0;
  const f = await fixture(t, { config: { fleets: { core: { concurrency: 1 } } }, backend: async (name, args, count) => {
    assert.equal(name, 'create');
    const calls = args.worker_type === 'sol' && ++parentTurns === 1 ? [{ call_id: 'recruit_terra', name: 'Agent', args: { subagent_type: 'openai-workers:daily-terrafree', prompt: prompt('Bounded child'), description: 'Terra subtask' } }] : [];
    return { id: `resp_recursive_${count}`, status: 'completed', model: args.model, text: calls.length ? '' : 'Synthetic result', calls, usage: { total: 50 }, estimatedUsd: 0.001 };
  } });
  const parent = await f.spawn('sol', { startBeforeReturn: true }); assert.ok(parent.agentId);
  const first = await f.step(parent.agentId); assert.equal(first.toolUses[0].name, 'Agent');
  const delegated = await f.execute(parent.agentId, 'Agent', first.toolUses[0].input, 'toolu_recruit_terra');
  assert.ok(delegated.result.agentId);
  let m = await f.snapshot(); const parentNode = m.nodes[m.native.bindings[parent.agentId]], childNode = m.nodes[m.native.bindings[delegated.result.agentId]];
  assert.equal(parentNode.status, 'queued'); assert.equal(childNode.parentId, parentNode.id);
  assert.equal(childNode.depth.core, 2); assert.equal(childNode.keyProfile, 'free');
  await f.step(delegated.result.agentId); await f.finish(delegated.result.agentId);
  const last = await f.step(parent.agentId, 1); assert.equal(last.answer, 'Synthetic result'); await f.finish(parent.agentId);
  m = await f.snapshot(); assert.equal(m.nodes[parentNode.id].status, 'completed');
  assert.equal(m.nodes[parentNode.id].usage.tokens, 100); assert.equal(m.nodes[childNode.id].usage.tokens, 50);
  assert.equal(f.fallbackCount(), 0); assert.ok(f.calls.every(c => !JSON.stringify(c.args.input).includes('ULTRA_BIND')));
});

test('native REPLICATOR and SKYNET requests are held then approved by actual tool-less HELICOP runtime', async t => {
  for (const [mode, requested, authority] of [['REPLICATOR', 'sol', 'helicop-sol'], ['SKYNET', 'astra', 'helicop-astra']]) {
    const f = await fixture(t, { config: { recruitment: { mode } }, backend: async (_name, args, count) => {
      assert.deepEqual(args.tools, []);
      return { id: `resp_approval_${count}`, status: 'completed', model: args.model, text: JSON.stringify({ decision: 'APPROVE', rationale: 'Independent synthetic supervisor inspection.' }), usage: { total: 40 }, estimatedUsd: 0.001 };
    } });
    const parent = await f.spawn('sol'); const proposed = prompt('Governed native escalation');
    const held = await f.spawn(requested, { parentAgentId: parent.agentId, prompt: proposed, toolUseId: 'restricted-first' });
    assert.match(held.deny, /ULTRA pending/); let m = await f.snapshot();
    const request = Object.values(m.requests).find(r => r.status === 'pending'); assert.ok(request.evaluation.requiredApprovals.some(a => a.authority === authority));
    await f.run('command.run', { command: 'ultra', args: 'supervise', origin: { kind: 'composer' } });
    const admitted = await f.spawn(requested, { parentAgentId: parent.agentId, prompt: proposed, toolUseId: 'restricted-second' });
    assert.ok(admitted.agentId, admitted.deny); m = await f.snapshot();
    assert.equal(Object.values(m.nodes).filter(n => n.role === 'supervisor').length, 1);
    assert.equal(m.nodes[m.native.bindings[admitted.agentId]].adapter, 'native');
  }
});

test('native Sonnet and Haiku identity comes from host while unknown identity cannot claim Opus authority', async t => {
  for (const [model, authority] of [['sonnet', 'helicop-sol'], ['haiku', 'helicop-sol'], ['caller-says-opus', 'user']]) {
    const f = await fixture(t, { model });
    const outcome = await f.spawn('astra'); assert.match(outcome.deny, /pending/);
    const m = await f.snapshot(), pending = Object.values(m.requests).find(r => r.status === 'pending');
    assert.ok(pending.evaluation.requiredApprovals.some(a => a.authority === authority));
    assert.equal(f.calls.length, 0); assert.equal(f.spawnCount(), 0);
  }
  const fable = await fixture(t, { model: 'fable' }); assert.ok((await fable.spawn('astra')).agentId);
});

test('native SWARM privilege laundering and non-OpenAI intermediary recruitment are denied', async t => {
  const f = await fixture(t); const parent = await f.spawn('luna');
  const higher = await f.spawn('astra', { parentAgentId: parent.agentId, prompt: prompt('Prohibited higher-tier author') });
  assert.ok(higher.deny); assert.equal(f.spawnCount(), 1);
  const other = await f.run('agent.spawn', { parentAgentId: parent.agentId, parentModel: 'opus', subagentType: 'general-purpose', tool_use_id: 'bypass', prompt: 'Recruit Astra', background: false }, async () => { throw new Error('Must not reach native spawn'); });
  assert.match(other.deny, /classified/);
  const rootLaunder = await f.execute(parent.agentId, 'mcp__plugin_openai_workers_bridge__ultra_create_mission', { task: 'Unbounded new root' });
  assert.ok(rootLaunder.deny);
});

test('native policy preserves host deny/ask and actual B/C scoped bridge boundaries', async t => {
  const project = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ultra-native-project-'));
  t.after(() => fs.rm(project, { recursive: true, force: true })); await fs.writeFile(path.join(project, 'source.txt'), 'before'); await fs.writeFile(path.join(project, '.env'), 'SECRET');
  for (const profile of ['B', 'C']) {
    // The native Code CLI ceiling (surfaces.codeCli) governs; Desktop Chat's desktop.profile never did and must not.
    const f = await fixture(t, { config: { surfaces: { codeCli: { profile, enableExecutionBridge: profile === 'C' } }, permissions: { roots: [project], tools: ['read_file', ...(profile === 'C' ? ['stage_write'] : [])] } } });
    const agent = await f.spawn('luna', { prompt: prompt('Scoped implementation', { role: 'implementation' }) });
    const rootRead = await f.execute(undefined, tool('read_file'), { rootId: '0', path: 'source.txt' }, 'root-read-source');
    assert.equal(JSON.parse(rootRead.result).content, 'before');
    for (const decision of ['deny', 'ask']) assert.equal((await f.run('tool.check', { agentId: agent.agentId, tool: tool('read_file'), input: { rootId: '0', path: 'source.txt' } }, async () => ({ decision, reason: 'native owner policy' }))).decision, decision);
    const read = await f.execute(agent.agentId, tool('read_file'), { rootId: '0', path: 'source.txt' }, 'read-source'); assert.equal(JSON.parse(read.result).content, 'before');
    for (const name of ['Read', 'Edit', 'Write', 'Bash']) assert.ok((await f.execute(agent.agentId, name, { command: 'rm -rf project' }, `blocked-${name}`)).deny);
    assert.ok((await f.execute(agent.agentId, tool('read_file'), { rootId: '0', path: '.env' }, 'secret')).deny);
    assert.ok((await f.execute(agent.agentId, tool('read_file'), { rootId: '0', path: '../outside' }, 'escape')).deny);
    const created = await f.execute(agent.agentId, tool('create_stage'), { files: [{ rootId: '0', path: 'source.txt' }] }, 'create-stage');
    if (profile === 'B') assert.ok(created.deny);
    else {
      const stage = JSON.parse(created.result); const original = await f.execute(agent.agentId, tool('stage_read'), { stage: stage.id, path: 'source.txt' }, 'stage-read');
      const hash = JSON.parse(original.result).sha256;
      const edited = await f.execute(agent.agentId, tool('stage_write'), { stage: stage.id, path: 'source.txt', content: 'after', expectedSha256: hash }, 'stage-write');
      assert.ok(edited.result, edited.deny); assert.equal(await fs.readFile(path.join(project, 'source.txt'), 'utf8'), 'before');
      assert.ok((await f.execute(agent.agentId, tool('stage_patch'), { stage: stage.id }, 'stage-patch')).result);
    }
  }
});

test('native restart invalidates the old capability and holds bound work without replaying API POST', async t => {
  const f = await fixture(t); const a = await f.spawn('luna'); await f.step(a.agentId);
  const firstChannel = f.bridgeCalls.find(c => c.name === 'ultra_native_context').args;
  await f.controller.handle('ultra_native_init', { sessionId: firstChannel.sessionId, model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false }, { trustedHostChannel: true });
  await assert.rejects(() => f.controller.handle('ultra_native_context', firstChannel, { trustedHostChannel: true }), /capability/);
  const m = await f.snapshot(), n = m.nodes[m.native.bindings[a.agentId]];
  assert.equal(n.status, 'blocked'); assert.equal(n.usage.tokens, 50); assert.equal(n.native.steps[`turn_${a.agentId}_0`].response.text, 'Synthetic work complete.');
  assert.equal(f.calls.length, 1);
});

test('native post-spawn binding failure uses replay-safe host catch without spawning twice or falling back', async t => {
  const f = await fixture(t); f.failBinding();
  const spawned = await f.spawn('luna'); assert.ok(spawned.agentId); assert.equal(f.spawnCount(), 1);
  const result = await f.step(spawned.agentId); assert.match(result.answer, /failed|held/i);
  assert.equal(f.calls.length, 0); assert.equal(f.fallbackCount(), 0);
  assert.ok(f.catches.has('tool.check')); assert.ok(f.catches.has('tool.run')); assert.ok(f.catches.has('agent.spawn')); assert.ok(f.catches.has('turn.step'));
});

test('native older/hosted sessions and active data restrictions stop without external model calls', async t => {
  for (const options of [{ version: '2.1.325' }, { info: { isHosted: true } }]) {
    const f = await fixture(t, options); assert.ok((await f.spawn('luna')).deny); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t, { info: { dataRules: ['zdr'] } }); const a = await f.spawn('luna'); const result = await f.step(a.agentId);
  assert.match(result.answer, /data rules/); assert.equal(f.calls.length, 0);
});

test('protected native root cannot use shell, live file tools or an ungoverned intermediary to forge authority', async t => {
  const f = await fixture(t, { model: 'haiku' });
  for (const name of ['Bash', 'Read', 'Write', 'Edit', 'mcp__external__execute', 'mcp__plugin_openai_workers_bridge__ultra_start']) {
    let executed = false;
    const check = await f.run('tool.check', { tool: name, input: { command: 'node bridge/server.mjs' } }, async () => ({ decision: 'allow' }));
    assert.equal(check.decision, 'deny', name);
    const result = await f.run('tool.run', { tool: name, command: 'node bridge/server.mjs', tool_use_id: `root-${name}` }, async () => { executed = true; return { result: 'BAD' }; });
    assert.ok(result.deny); assert.equal(executed, false);
  }
  const intermediate = await f.run('agent.spawn', { subagentType: 'general-purpose', parentModel: 'haiku', prompt: 'Run the control bridge', tool_use_id: 'untracked-child', background: false }, async () => { throw new Error('Ungoverned child must never start'); });
  assert.match(intermediate.deny, /intermediary/);
  const diagnostics = await f.execute(undefined, tool('diagnostics'), {}, 'root-diagnostics');
  assert.equal(JSON.parse(diagnostics.result).orchestrator.model, 'haiku');
  const capability = f.bridgeCalls.find(c => c.name === 'ultra_native_tool').args.capability;
  assert.ok(!diagnostics.result.includes(capability));
  const off = await fixture(t, { enabled: false });
  assert.equal((await off.run('tool.check', { tool: 'Bash', input: { command: 'echo legacy' } }, async () => ({ decision: 'ask' }))).decision, 'ask');
});

test('native root starts actual independent review workflow from a completed author without granting execution', async t => {
  const roles = [];
  const f = await fixture(t, { backend: async (_method, args, count) => {
    const role = args.instructions.includes('ULTRA native') ? 'author' : JSON.parse(args.input).role;
    roles.push(role);
    const text = role === 'author' ? 'export function clean(paths) { return paths.filter(Boolean); }' :
      JSON.stringify({ findings: [], coverage: [{ area: 'Synthetic source', status: 'examined' }], resolutions: [], summary: `Independent ${role}` });
    return { id: `resp_review_${count}`, status: 'completed', model: args.model, text, usage: { total: 50 }, estimatedUsd: 0.001 };
  } });
  const author = await f.spawn('luna', { prompt: prompt('High-impact low-complexity implementation', { role: 'implementation', risk: { ...risk, impact: 'high', destructive: true } }) });
  const result = await f.step(author.agentId); await f.finish(author.agentId, result.answer);
  const started = await f.execute(undefined, tool('start_review'), { authorAgentId: author.agentId, label: 'Synthetic completed author source' }, 'start-native-review');
  assert.ok(started.result, started.deny); const workflow = JSON.parse(started.result);
  assert.equal(workflow.policy.secondOpinion, true); assert.equal(workflow.policy.gapReview, true);
  assert.equal(workflow.source.content, result.answer);
  let m = await f.snapshot();
  await f.runtime.reviews.recordTest(m.id, workflow.id, { sourceHash: workflow.source.hash, name: 'Synthetic independent function evidence', passed: true, details: 'Offline fixture evidence; not an OS sandbox or live host qualification.' }, { source: 'test-runner', trusted: true });
  for (let i = 0; i < 6; i++) {
    await f.run('command.run', { command: 'ultra', args: 'supervise', origin: { kind: 'composer' } });
    m = await f.snapshot(); if (m.workflows[workflow.id].status === 'code_approved') break;
  }
  assert.equal(m.workflows[workflow.id].status, 'code_approved');
  assert.deepEqual(roles, ['author', 'reviewer', 'second_opinion', 'gap_inspector', 'judge']);
  assert.ok((await f.execute(undefined, 'Bash', { command: 'perform-destructive-cleanup' }, 'post-review-execution')).deny);
  assert.ok((await f.execute(author.agentId, tool('start_review'), { authorAgentId: author.agentId }, 'self-review-control')).deny);
  const again = await f.execute(undefined, tool('start_review'), { authorAgentId: author.agentId }, 'same-source-review');
  assert.equal(JSON.parse(again.result).id, workflow.id, 'same accepted source does not recruit duplicate reviewers');
});

test('legacy unverified cost response preserves useful output and stops returned tools without inventing zero usage', async t => {
  const f = await fixture(t, { enabled: false, backend: async () => ({ id: 'resp_unknown_cost', status: 'completed', text: 'Useful retained work', estimatedUsd: null,
    calls: [{ call_id: 'unsafe-edit', name: 'Write', args: { file_path: '/tmp/unsafe', content: 'do not execute' } }] }) });
  const a = await f.spawn('luna'); const result = await f.step(a.agentId);
  assert.match(result.answer, /accounting HOLD/); assert.match(result.answer, /Useful retained work/); assert.deepEqual(result.toolUses, []);
  assert.equal(f.states.get(a.agentId).usageStatus, 'unverified'); assert.equal(f.states.get(a.agentId).responseId, 'resp_unknown_cost');
});

test('Code Mode script entrypoint has exact fail-closed guards in addition to wildcard policy', async t => {
  const f = await fixture(t);
  for (const event of ['tool.call', 'tool.check', 'tool.run']) {
    assert.ok(f.handlers.has(`${event}:REPL`)); assert.ok(f.catches.has(`${event}:REPL`));
    const result = await f.run(event, { tool: 'REPL', code: 'launch unmediated controller' }, async () => { throw new Error('Code Mode must not execute'); });
    assert.ok(result.deny || result.decision === 'deny');
  }
});

test('native configured consultative Sonnet uses independent Sol opinion and exact root final decision', async t => {
  const f = await fixture(t, { model: 'sonnet', config: { authority: { profiles: { sonnet: { final: false } } } }, backend: async (_name, args, count) => ({
    id: `resp_consultative_${count}`, status: 'completed', model: args.model, text: JSON.stringify({ decision: 'APPROVE', rationale: 'Synthetic Sol consultation.' }), usage: { total: 40 }, estimatedUsd: 0.001,
  }) });
  const task = prompt('Restricted consultation fixture');
  assert.match((await f.spawn('astra', { prompt: task, toolUseId: 'initial-consultation' })).deny, /pending/);
  await f.run('command.run', { command: 'ultra', args: 'supervise', origin: { kind: 'composer' } });
  let m = await f.snapshot(); const request = Object.values(m.requests).find(r => r.status === 'pending' && r.proposal.worker === 'astra');
  assert.ok(request.evaluation.requiredApprovals.some(r => r.authority === 'trusted-orchestrator'));
  assert.ok(request.approvals.some(id => m.approvals[id].authority === 'helicop-sol'));
  const deniedHash = await f.execute(undefined, tool('recruitment_decide'), { requestId: request.id, requestHash: 'wrong', decision: 'APPROVE', rationale: 'Wrong proposal identity must fail' }, 'bad-proposal-hash');
  assert.ok(deniedHash.deny);
  const decision = await f.execute(undefined, tool('recruitment_decide'), { requestId: request.id, requestHash: request.inputHash, decision: 'APPROVE', rationale: 'Reviewed exact proposal and independent Sol opinion.' }, 'root-final-recruitment');
  assert.ok(decision.result, decision.deny); assert.equal(JSON.parse(decision.result).status, 'queued');
  assert.ok((await f.spawn('astra', { prompt: task, toolUseId: 'approved-consultation' })).agentId);
  m = await f.snapshot(); assert.ok(Object.values(m.approvals).some(a => a.principal.source === 'native-host' && a.authority === 'trusted-orchestrator'));
});

test('native consequential decision honors exact hash, current host identity and separately configured authority', async t => {
  for (const configured of [false, true]) {
    const f = await fixture(t, { config: configured ? { execution: { consequentialAuthorities: ['trusted-orchestrator'] } } : {} });
    const author = await f.spawn('luna', { prompt: prompt('Author a proposed cleanup', { role: 'implementation' }) });
    await f.step(author.agentId); await f.finish(author.agentId);
    const proposed = await f.execute(undefined, tool('action_propose'), { authorAgentId: author.agentId, action: { kind: 'delete', description: 'Explicit synthetic cleanup proposal', details: { path: 'synthetic-only' }, risk: { ...risk, impact: 'high' } } }, 'propose-native-action');
    assert.ok(proposed.result, proposed.deny); const action = JSON.parse(proposed.result);
    const input = { actionId: action.id, actionHash: action.hash, approved: true, rationale: 'Exact proposed action and evidence inspected.' };
    if (configured) {
      await f.setModel('haiku'); assert.ok((await f.execute(undefined, tool('action_decide'), input, 'changed-model-vote')).deny);
      await f.setModel('opus'); assert.ok((await f.execute(undefined, tool('action_decide'), { ...input, actionHash: 'wrong' }, 'wrong-action-vote')).deny);
    }
    const decision = await f.execute(undefined, tool('action_decide'), input, 'exact-action-vote');
    if (configured) assert.equal(JSON.parse(decision.result).status, 'approved'); else assert.ok(decision.deny, 'trusted orchestrator cannot provide the default user vote');
    assert.ok((await f.execute(undefined, 'Bash', { command: 'delete synthetic-only' }, 'after-action-vote')).deny);
    const m = await f.snapshot(); assert.notEqual(m.actions[action.id].status, 'executed');
  }
});

test('native review-only escalation does not grant a SWARM author unrestricted implementation recruitment', async t => {
  const f = await fixture(t); const author = await f.spawn('luna');
  const review = await f.spawn('astra', { parentAgentId: author.agentId, toolUseId: 'review-only-astra', prompt: prompt('Review existing source only', { role: 'reviewer' }) });
  assert.ok(review.agentId, review.deny); const m = await f.snapshot();
  assert.equal(m.nodes[m.native.bindings[review.agentId]].pool, 'review');
  assert.equal(m.nodes[m.native.bindings[author.agentId]].permissions.recruit.higher, false);
  assert.ok((await f.spawn('astra', { parentAgentId: author.agentId, toolUseId: 'forbidden-astra-author', prompt: prompt('Try implementation escalation') })).deny);
});

test('native cancellation revokes local authority first and retains verified remote cancellation usage', async t => {
  let f;
  f = await fixture(t, { backend: async (method, args) => {
    if (method === 'create') return { id: 'resp_cancel_native', status: 'in_progress', model: args.model };
    assert.equal(method, 'cancel'); assert.equal((await f.snapshot()).status, 'cancelled');
    return { id: 'resp_cancel_native', status: 'cancelled', model: 'gpt-6-luna', text: 'Stopped', usage: { total: 99 }, estimatedUsd: 5 };
  } });
  const a = await f.spawn('luna');
  const channel = f.bridgeCalls.find(c => c.name === 'ultra_native_bind').args;
  const common = { sessionId: channel.sessionId, capability: channel.capability };
  await f.controller.handle('ultra_native_create', { ...common, hostAgentId: a.agentId, input: 'bounded', requestKey: 'cancelled-step', max_output_tokens: 1000 }, { trustedHostChannel: true });
  await f.run('command.run', { command: 'ultra', args: 'cancel', origin: { kind: 'composer' } });
  const m = await f.snapshot(), n = m.nodes[m.native.bindings[a.agentId]];
  assert.equal(n.status, 'cancelled'); assert.equal(n.usage.tokens, 99); assert.equal(n.usage.usd, 5);
  assert.equal(f.calls.length, 2);
});

test('native root per-assignment reviewer policy reaches the real workflow and cannot be replaced by a child', async t => {
  const f = await fixture(t);
  const a = await f.spawn('luna', { prompt: prompt('Task-specific review selection', { role: 'implementation', reviewerPolicy: { selection: 'B', primary: 'sol' } }) });
  assert.ok(a.agentId, a.deny); let m = await f.snapshot();
  assert.deepEqual(m.nodes[m.native.bindings[a.agentId]].reviewerPolicy, { selection: 'B', reviewer: 'sol' });
  const forbidden = await f.spawn('daily-terrafree', { parentAgentId: a.agentId, toolUseId: 'child-review-policy', prompt: prompt('Try to replace root review assignment', { reviewerPolicy: { selection: 'B', primary: 'luna' } }) });
  assert.ok(forbidden.deny);
  await f.step(a.agentId); await f.finish(a.agentId);
  const started = await f.execute(undefined, tool('start_review'), { authorAgentId: a.agentId }, 'selected-review');
  assert.equal(JSON.parse(started.result).policy.reviewer, 'sol');
});

test('native full root risk override and one-use promotion are scoped, audited and separate from tools', async t => {
  const f = await fixture(t); const a = await f.spawn('luna', { prompt: prompt('Scoped original author', { role: 'implementation' }) });
  let m = await f.snapshot(); const nodeId = m.native.bindings[a.agentId];
  const override = await f.execute(undefined, tool('risk_override'), { nodeId, replacement: { ...risk, impact: 'high' }, rationale: 'Consequences were underestimated in this synthetic fixture.', ttlMs: 60000 }, 'risk-override');
  assert.ok(override.result, override.deny); assert.equal(JSON.parse(override.result).assessment.effectiveImpact, 'high');
  const promotion = await f.execute(undefined, tool('promote'), { nodeId, worker: 'astra', role: 'reviewer', relations: [], reviewOnly: true, uses: 1, ttlMs: 60000 }, 'promote-review');
  assert.ok(promotion.result, promotion.deny); const granted = JSON.parse(promotion.result);
  const review = await f.spawn('astra', { parentAgentId: a.agentId, toolUseId: 'one-review-promotion', prompt: prompt('One independent review only', { role: 'reviewer', promotionId: granted.id }) });
  assert.ok(review.agentId, review.deny);
  const repeated = await f.spawn('astra', { parentAgentId: a.agentId, toolUseId: 'replayed-promotion', prompt: prompt('Replay the consumed promotion', { role: 'reviewer', promotionId: granted.id }) }); assert.ok(repeated.deny);
  m = await f.snapshot(); assert.equal(m.promotions[granted.id].remaining, 0); assert.equal(m.nodes[nodeId].permissions.recruit.higher, false);
  assert.ok((await f.execute(a.agentId, tool('risk_override'), { nodeId, replacement: risk, rationale: 'Self override forbidden', ttlMs: 60000 }, 'self-risk-override')).deny);
  await f.setModel('haiku');
  assert.ok((await f.execute(undefined, tool('risk_override'), { nodeId, replacement: risk, rationale: 'Limited orchestrator cannot replace full-authority classification', ttlMs: 60000 }, 'haiku-risk-override')).deny);
});

test('native explicit escalation is revalidated and its approved request cannot run a replacement prompt', async t => {
  const f = await fixture(t, { config: { recruitment: { mode: 'REPLICATOR' } }, backend: async (_method, args, count) => ({
    id: `resp_native_escalation_${count}`, status: 'completed', model: args.model, text: JSON.stringify({ decision: 'ESCALATE', rationale: 'A narrower proposal is appropriate.' }), usage: { total: 40 }, estimatedUsd: 0.001,
  }) });
  const parent = await f.spawn('sol');
  assert.ok((await f.spawn('sol', { parentAgentId: parent.agentId, prompt: prompt('Original peer request'), toolUseId: 'needs-escalation' })).deny);
  await f.run('command.run', { command: 'ultra', args: 'supervise', origin: { kind: 'composer' } });
  let m = await f.snapshot(); const previous = Object.values(m.requests).find(r => r.status === 'escalated'); assert.ok(previous);
  const result = await f.execute(undefined, tool('escalate'), { requestId: previous.id, requestHash: previous.inputHash, changes: { worker: 'luna', task: 'Approved narrowed task' } }, 'root-explicit-escalation');
  assert.ok(result.result, result.deny); const approved = JSON.parse(result.result); assert.equal(approved.status, 'queued');
  const child = await f.spawn('luna', { parentAgentId: parent.agentId, prompt: prompt('This replacement must never be used', { approvedRequestId: approved.id }), toolUseId: 'bind-escalation' });
  assert.ok(child.agentId, child.deny); m = await f.snapshot();
  assert.equal(m.nodes[m.native.bindings[child.agentId]].task, 'Approved narrowed task');
  const message = (await f.context.session.messages({ agentId: child.agentId }))[0].text;
  assert.ok(message.endsWith('Approved narrowed task')); assert.ok(!message.includes('replacement must never'));
  assert.ok((await f.spawn('luna', { parentAgentId: parent.agentId, prompt: prompt('Replay', { approvedRequestId: approved.id }), toolUseId: 'duplicate-escalation' })).deny);
});
