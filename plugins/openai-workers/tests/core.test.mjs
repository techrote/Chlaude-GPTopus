import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { usageSnapshot } from '../bridge/usage.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newRun, nextInput, toolId, responseStep, finalStep } from '../hooks/step.js';
import { OPENAI_TOOLS, filterToolArgs } from '../hooks/tools.js';
import { createTurn, normalize, configuredKey, getKey, keyProfileForWorker, pollTurn } from '../bridge/openai.mjs';
import { dispatch } from '../bridge/server.mjs';
import { register, parseServiceTier } from '../hooks/register.js';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = join(here, '..');

test('tool manifest permits known calls and removes extraneous arguments', () => {
  assert.equal(OPENAI_TOOLS.length, 4);
  assert.deepEqual(filterToolArgs('Read', { file_path: '/a', offset: 5, run_in_background: true }), { file_path: '/a', offset: 5 });
  assert.throws(() => filterToolArgs('Destroy', {}), /Unsupported tool/);
  assert.throws(() => filterToolArgs('Write', { file_path: '/tmp/f' }), /Missing Write.content/);
});

test('first prompt, file-result continuation, and follow-up map to Responses input', () => {
  const first = [{ role: 'user', text: 'Review auth.js' }];
  assert.deepEqual(nextInput(first, newRun()), { kind: 'openai', input: 'Review auth.js', seenPrompts: 1 });
  const msgs = [...first, { role: 'user', text: '', toolResults: [{ tool_use_id: toolId('call_hello'), text: 'file contents' }] }];
  const run = { ...newRun(), responseId: 'resp_12345', pending: ['call_hello'], seenPrompts: 1 };
  assert.deepEqual(nextInput(msgs, run), { kind: 'openai',
    input: [{ type: 'function_call_output', call_id: 'call_hello', output: 'file contents' }],
    previous_response_id: 'resp_12345', seenPrompts: 1 });
  const follow = nextInput([...msgs, { role: 'user', text: 'Check extra tests' }], { ...run, pending: [] });
  assert.equal(follow.input.at(-1).content, 'Check extra tests');
});

test('failure of a handback returns an ordinary final answer instead of dropping it', () => {
  const run = { ...newRun(), seenPrompts: 1, finished: true, handback: { id: 'toolu_handback_1', message: 'Report' } };
  const messages = [{ role: 'user', text: 'Task' }, { role: 'user', text: '', toolResults: [{ tool_use_id: 'toolu_handback_1', isError: true, text: 'refused' }] }];
  assert.deepEqual(nextInput(messages, run), { kind: 'report', text: 'Report' });
});

test('OpenAI tool calls become native Claude Code tool chunks, not direct tool execution', () => {
  const step = responseStep({ status: 'completed', text: 'I will inspect a file', calls: [{ call_id: 'call_x', name: 'Read', args: { file_path: '/tmp/a' } }] }, 'seed', false);
  assert.equal(step.stopReason, 'tool_use');
  assert.equal(step.chunks[1].name, 'Read');
  assert.equal(step.chunks[1].id, 'toolu_call_x');
  assert.deepEqual(step.toolUses, [{ name: 'Read', input: { file_path: '/tmp/a' } }]);
  assert.equal(responseStep({ status: 'completed', text: 'Done' }, 'seed', false).answer, 'Done');
  assert.equal(finalStep('complete', 'seed', true).toolUses[0].name, 'SubagentHandback');
});

test('OpenAI response is converted to text, tool calls and estimated billing', () => {
  const actual = normalize({ id: 'resp_123456', status: 'completed', model: 'gpt-6.2-sol', usage: { input_tokens: 1000, output_tokens: 100 },
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer' }] }, { type: 'function_call', name: 'Read', call_id: 'call_a', arguments: '{"file_path":"/a"}' }] });
  assert.equal(actual.text, 'Answer');
  assert.equal(actual.calls[0].args.file_path, '/a');
  assert.equal(actual.estimatedUsd, 0.003);
});

test('requested service tiers are validated explicitly (including priority alias)', () => {
  assert.equal(parseServiceTier(' FLEX '), 'flex');
  assert.equal(parseServiceTier('Priority'), 'priority');
  assert.equal(parseServiceTier(''), undefined);
  assert.equal(parseServiceTier(null), undefined);
  assert.throws(() => parseServiceTier('ultrafast'), /Invalid/);
  assert.throws(() => parseServiceTier('banana'), /Invalid/);
});

test('estimate uses actual reported tier, not assumed requested tier', () => {
  const sample = { id: 'resp_abcdef', status: 'completed', model: 'gpt-6.1-sol',
    usage: { input_tokens: 1000, output_tokens: 100 }, output: [] };
  assert.equal(normalize({ ...sample, service_tier: 'default' }).estimatedUsd, 0.003);
  assert.equal(normalize({ ...sample, service_tier: 'flex' }).estimatedUsd, 0.0015);
  assert.equal(normalize({ ...sample, service_tier: 'priority' }).estimatedUsd, 0.006);
  assert.equal(normalize({ ...sample, service_tier: 'fast' }).estimatedUsd, 0.006);
  assert.equal(normalize({ ...sample, service_tier: 'default' }).serviceTier, 'default');
});

test('create request uses only OpenAI endpoint, Responses API and background/store mode', async () => {
  let captured;
  const response = { ok: true, json: async () => ({ id: 'resp_xyz123', status: 'queued' }) };
  const fetchFn = async (url, init) => { captured = { url, init }; return response; };
  const result = await createTurn({ model: 'gpt-6.2-sol', input: 'Hello', instructions: 'Be concise', tools: [], effort: 'high' }, { key: 'sk-unit-test', fetchFn });
  assert.equal(result.status, 'in_progress');
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-unit-test');
  const payload = JSON.parse(captured.init.body);
  assert.equal(payload.background, true);
  assert.equal(payload.store, true);
  assert.equal(payload.reasoning.effort, 'high');
  assert.equal(Object.hasOwn(payload, 'service_tier'), false);
});

test('OpenAI Responses API gets each supported tier and preserves continuation', async () => {
  for (const tier of ['auto', 'default', 'flex', 'fast', 'priority']) {
    let body;
    const fetchFn = async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ id: 'resp_abcde', status: 'queued' }) };
    };
    await createTurn({ model: 'gpt-6.1-sol', input: 'Continue', instructions: 'Read files', tools: [],
      service_tier: tier, previous_response_id: 'resp_old123' }, { key: 'test', fetchFn });
    assert.equal(body.service_tier, tier);
    assert.equal(body.previous_response_id, 'resp_old123');
    assert.equal(body.background, true);
  }
});

test('Flex on unsupported GPT-6.2 models fails before any API call and no paid fallback occurs', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; throw new Error('should not be called'); };
  for (const model of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.2-sol-2026-11-01']) {
    await assert.rejects(createTurn({ model, input: 'x', instructions: 'x', tools: [], service_tier: 'flex' },
      { key: 'test', fetchFn }), /Flex processing is unavailable/);
  }
  await assert.rejects(createTurn({ model: 'gpt-6-luna', input: 'x', instructions: 'x', tools: [], service_tier: 'ultrafast' },
    { key: 'test', fetchFn }), /Invalid service_tier/);
  assert.equal(calls, 0);
});

test('poll returns a completed saved OpenAI response', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ id: 'resp_abcdef', model: 'gpt-6.2-sol', status: 'completed', output: [], usage: {} }) });
  const result = await pollTurn('resp_abcdef', { key: 'test', fetchFn });
  assert.equal(result.status, 'completed');
  assert.equal(configuredKey({ OPENAI_API_KEY: 'fake' }), 'environment');
});

function makeEngine(responses, agent = 'openai-workers:sol', config = {}) {
  const handlers = new Map();
  register((event, filter, handler) => {
    if (typeof filter === 'function') handler = filter;
    handlers.set(event, handler);
  });
  let state = {};
  let messages = [{ role: 'user', text: 'Read /tmp/a and report' }];
  const sent = [];
  const context = {
    agent: { list: async () => [{ id: 'ag_1', type: agent, status: 'running' }], register: async () => {} },
    session: { cwd: async () => '/tmp', messages: async args => args.as === 'api' ? [] : messages },
    fs: { read: async () => '' },
    state: { get: async () => ({ value: state.run }), set: async (_, s) => { state.run = s; } },
    env: { get: async name => config[name] },
    mcp: { call: async (_server, name, args) => {
      sent.push({ name, args });
      return { content: [{ type: 'text', text: JSON.stringify(responses.shift()) }] };
    } },
    command: { register: async () => {} },
  };
  return { handlers, context, sent, setMessages: m => { messages = m; }, getState: () => state.run };
}

async function consume(generator) {
  const chunks = [];
  let r = await generator.next();
  while (!r.done) { chunks.push(r.value); r = await generator.next(); }
  return { result: r.value, chunks };
}

test('real mod handler dispatches OpenAI agent, never calls parent Claude model', async () => {
  const fake = makeEngine([{ id: 'resp_good', status: 'completed', text: 'Review done.', estimatedUsd: 0.001 }]);
  let fellBack = false;
  const next = async function* () { fellBack = true; return null; };
  const output = await consume(fake.handlers.get('turn.step')(fake.context, { agentId: 'ag_1', turnId: 'turn1', index: 0 }, next));
  assert.equal(output.result.answer, 'Review done.');
  assert.equal(fake.sent[0].name, 'create');
  assert.equal(fake.sent[0].args.worker_type, 'sol');
  assert.equal(fellBack, false);
  assert.equal(fake.getState().responseId, 'resp_good');
  assert.equal(fake.getState().steps, 1);
});

test('per-agent tier overrides global tier; priority passes to every model step', async () => {
  const fake = makeEngine([{ id: 'resp_11111', status: 'completed', text: 'First', estimatedUsd: 0 },
    { id: 'resp_22222', status: 'completed', text: 'Second', estimatedUsd: 0 }], 'openai-workers:sol', {
    OPENAI_WORKER_SERVICE_TIER: 'flex', OPENAI_WORKER_SOL_SERVICE_TIER: 'Priority',
  });
  const hook = fake.handlers.get('turn.step');
  const noFallback = async function* () { throw new Error('Anthropic fallback'); };
  await consume(hook(fake.context, { agentId: 'ag_1', turnId: 'turnA', index: 0 }, noFallback));
  assert.equal(fake.sent[0].args.service_tier, 'priority');
  fake.setMessages([{ role: 'user', text: 'Read /tmp/a and report' }, { role: 'user', text: 'Now review another file' }]);
  await consume(hook(fake.context, { agentId: 'ag_1', turnId: 'turnB', index: 0 }, noFallback));
  assert.equal(fake.sent[1].args.service_tier, 'priority');
});

test('unconfigured agent tier inherits global flex; invalid tier fails closed', async () => {
  const flex = makeEngine([{ id: 'resp_12345', status: 'completed', text: 'OK' }], 'openai-workers:luna', {
    OPENAI_WORKER_SERVICE_TIER: 'flex',
  });
  const noFallback = async function* () { throw new Error('Anthropic fallback'); };
  await consume(flex.handlers.get('turn.step')(flex.context, { agentId: 'ag_1', turnId: 'turnA', index: 0 }, noFallback));
  assert.equal(flex.sent[0].args.service_tier, 'flex');
  const bad = makeEngine([], 'openai-workers:sol', { OPENAI_WORKER_SERVICE_TIER: 'faster' });
  const output = await consume(bad.handlers.get('turn.step')(bad.context,
    { agentId: 'ag_1', turnId: 'turnA', index: 0 }, noFallback));
  assert.match(output.result.answer, /Invalid OPENAI_WORKER_SERVICE_TIER/);
  assert.equal(bad.sent.length, 0);
});

test('real mod routes OpenAI tool results back into next GPT step', async () => {
  const fake = makeEngine([
    { id: 'resp_11111', status: 'completed', text: '', calls: [{ call_id: 'call_X', name: 'Read', args: { file_path: '/tmp/a' } }] },
    { id: 'resp_22222', status: 'completed', text: 'Got it.' },
  ]);
  const noFallback = async function* () { throw new Error('Anthropic fallback'); };
  const hook = fake.handlers.get('turn.step');
  const first = await consume(hook(fake.context, { agentId: 'ag_1', turnId: 'turn1', index: 0 }, noFallback));
  assert.equal(first.result.toolUses[0].name, 'Read');
  fake.setMessages([{ role: 'user', text: 'Read /tmp/a and report' },
    { role: 'user', toolResults: [{ tool_use_id: 'toolu_call_X', text: 'ABC', isError: false }] }]);
  const second = await consume(hook(fake.context, { agentId: 'ag_1', turnId: 'turn1', index: 1 }, noFallback));
  assert.equal(second.result.answer, 'Got it.');
  assert.equal(fake.sent[1].args.previous_response_id, 'resp_11111');
  assert.equal(fake.sent[1].args.input[0].call_id, 'call_X');
  assert.equal(fake.sent[1].args.input[0].output, 'ABC');
});

test('stdio MCP worker responds to initialization, tool listing and health without exposing key', async () => {
  const child = spawn(process.execPath, [join(plugin, 'bridge/server.mjs')], { env: { ...process.env, OPENAI_API_KEY: 'sk-secret-unit-test', OPENAI_FREE_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const outputs = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    for (const line of chunk.trim().split('\n')) if (line.trim()) outputs.push(JSON.parse(line));
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health', arguments: {} } }) + '\n');
  const started = Date.now();
  while (outputs.length < 3 && Date.now() - started < 2000) await new Promise(r => setTimeout(r, 20));
  child.kill();
  assert.equal(outputs.length, 3);
  assert.equal(outputs.find(x => x.id === 1).result.serverInfo.name, 'openai-workers-bridge');
  assert.equal(outputs.find(x => x.id === 2).result.tools.length, 6);
  const status = JSON.parse(outputs.find(x => x.id === 3).result.content[0].text);
  assert.equal(status.standard.configured, true);
  assert.equal(status.free.configured, false);
  assert.equal(JSON.stringify(outputs).includes('sk-secret-unit-test'), false);
});


test('new worker presets register and enforce their intended defaults despite global overrides', async () => {
  for (const [type, model, tier] of [
    ['flex6-1', 'gpt-6.1-sol', 'flex'],
    ['daily-astrafree', 'gpt-6-astra', 'default'],
    ['daily-terrafree', 'gpt-5.6-terra', 'default'],
  ]) {
    const fake = makeEngine([{ id: 'resp_12345', status: 'completed', text: 'Done' }],
      `openai-workers:${type}`, { OPENAI_WORKER_SERVICE_TIER: 'priority' });
    const next = async function* () { throw new Error('unexpected Anthropic fallback'); };
    await consume(fake.handlers.get('turn.step')(fake.context, { agentId: 'ag_1', turnId: 'turnA', index: 0 }, next));
    assert.equal(fake.sent[0].args.worker_type, type);
    assert.equal(fake.sent[0].args.model, model);
    assert.equal(fake.sent[0].args.service_tier, tier);
  }
});

test('new named worker supports explicit service tier override', async () => {
  const fake = makeEngine([{ id: 'resp_abcde', status: 'completed', text: 'Done' }], 'openai-workers:daily-terrafree', {
    OPENAI_WORKER_DAILY_TERRAFREE_SERVICE_TIER: 'flex',
    OPENAI_WORKER_DAILY_TERRAFREE_MODEL: 'gpt-5.6-terra',
  });
  const next = async function* () { throw new Error('unexpected Anthropic fallback'); };
  await consume(fake.handlers.get('turn.step')(fake.context, { agentId: 'ag_1', turnId: 'turnA', index: 0 }, next));
  assert.equal(fake.sent[0].args.service_tier, 'flex');
});


test('exactly two API key profiles: free daily workers and all straight-API workers', () => {
  for (const type of ['daily-astrafree', 'daily-terrafree']) {
    assert.equal(keyProfileForWorker(type), 'free');
  }
  for (const type of ['sol', 'astra', 'luna', 'flex6-1', undefined]) {
    assert.equal(keyProfileForWorker(type), 'standard');
  }
  const env = { OPENAI_API_KEY: 'sk-straight', OPENAI_FREE_API_KEY: 'sk-free' };
  assert.equal(getKey(env, 'standard'), 'sk-straight');
  assert.equal(getKey(env, 'free'), 'sk-free');
  assert.equal(configuredKey(env, 'standard'), 'environment');
  assert.equal(configuredKey(env, 'free'), 'environment');
  assert.throws(() => getKey({ OPENAI_API_KEY: 'sk-straight' }, 'free'), /Missing free OpenAI key/);
});

test('bridge create, poll, cancel all use the matching worker key (never cross the two profiles)', async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'two-key-usage-'));
  const oldUsageDir = process.env.OPENAI_WORKER_USAGE_DIR;
  process.env.OPENAI_WORKER_USAGE_DIR = ledgerDir;
  const originalFetch = globalThis.fetch;
  const oldStandard = process.env.OPENAI_API_KEY;
  const oldFree = process.env.OPENAI_FREE_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-straight-test';
  process.env.OPENAI_FREE_API_KEY = 'sk-free-test';
  const headers = [];
  try {
    globalThis.fetch = async (_url, init) => {
      headers.push(init.headers.Authorization);
      return { ok: true, json: async () => ({ id: `resp_keyrouting${headers.length}`, status: 'completed', output: [], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } }) };
    };
    for (const [type, expected] of [
      ['daily-astrafree', 'Bearer sk-free-test'],
      ['daily-terrafree', 'Bearer sk-free-test'],
      ['flex6-1', 'Bearer sk-straight-test'],
      ['sol', 'Bearer sk-straight-test'],
    ]) {
      await dispatch('create', { worker_type: type, model: type === 'daily-terrafree' ? 'gpt-5.6-terra' : type === 'daily-astrafree' ? 'gpt-6-astra' : 'gpt-6.1-sol', input: 'Hi', instructions: 'Test', tools: [] });
      await dispatch('poll', { id: 'resp_keyrouting1', worker_type: type, wait_ms: 0 });
      await dispatch('cancel', { id: 'resp_keyrouting1', worker_type: type });
      assert.deepEqual(headers.slice(-3), [expected, expected, expected]);
    }
    const usage = await dispatch('usage');
    // Two free-key requests were counted; paid-key requests were not.
    assert.equal(usage.groups.premium.usedTokens, 25);
    assert.equal(usage.groups.terra.usedTokens, 25);
    assert.equal(usage.groups.premium.pendingRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldUsageDir === undefined) delete process.env.OPENAI_WORKER_USAGE_DIR; else process.env.OPENAI_WORKER_USAGE_DIR = oldUsageDir;
    rmSync(ledgerDir, { recursive: true, force: true });
    if (oldStandard === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldStandard;
    if (oldFree === undefined) delete process.env.OPENAI_FREE_API_KEY; else process.env.OPENAI_FREE_API_KEY = oldFree;
  }
});

test('missing free API key fails closed rather than falling back to straight API', async () => {
  const oldStandard = process.env.OPENAI_API_KEY;
  const oldFree = process.env.OPENAI_FREE_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-straight-test';
  delete process.env.OPENAI_FREE_API_KEY;
  try {
    await assert.rejects(dispatch('create', {
      worker_type: 'daily-astrafree', model: 'gpt-6-astra', input: 'Hi', instructions: 'Test', tools: [],
    }), /Missing free OpenAI key/);
  } finally {
    if (oldStandard === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldStandard;
    if (oldFree === undefined) delete process.env.OPENAI_FREE_API_KEY; else process.env.OPENAI_FREE_API_KEY = oldFree;
  }
});


test('free-key daily threshold pauses only its worker; straight API continues', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'two-key-limit-'));
  const env = ['OPENAI_API_KEY', 'OPENAI_FREE_API_KEY', 'OPENAI_WORKER_USAGE_DIR',
    'OPENAI_WORKER_PREMIUM_DAILY_TOKENS', 'OPENAI_WORKER_DAILY_RESERVE_TOKENS',
    'OPENAI_WORKER_DAILY_OVERRUN_PERCENT'];
  const old = Object.fromEntries(env.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    Object.assign(process.env, {
      OPENAI_API_KEY: 'sk-paid-fixture', OPENAI_FREE_API_KEY: 'sk-free-fixture',
      OPENAI_WORKER_USAGE_DIR: directory, OPENAI_WORKER_PREMIUM_DAILY_TOKENS: '20',
      OPENAI_WORKER_DAILY_RESERVE_TOKENS: '10', OPENAI_WORKER_DAILY_OVERRUN_PERCENT: '0',
    });
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, json: async () => ({ id: `resp_limit${calls}`, status: 'completed',
        usage: { total_tokens: 25, input_tokens: 20, output_tokens: 5 }, output: [] }) };
    };
    const args = { input: 'hello', instructions: 'test', tools: [] };
    await dispatch('create', { ...args, worker_type: 'daily-astrafree', model: 'gpt-6-astra' });
    await assert.rejects(dispatch('create', { ...args, worker_type: 'daily-astrafree', model: 'gpt-6-astra' }), /paused at its soft daily allowance/);
    assert.equal(calls, 1, 'quota must fail before making another request');
    await dispatch('create', { ...args, worker_type: 'flex6-1', model: 'gpt-6.1-sol', service_tier: 'flex' });
    assert.equal(calls, 2, 'straight key must remain available');
    const usage = await dispatch('usage');
    assert.equal(usage.groups.premium.usedTokens, 25);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
