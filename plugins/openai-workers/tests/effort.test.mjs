import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EFFORT_POLICIES, effortPolicy, selectWorkerEffort, workerSettings, effortGuidance } from '../bridge/workers.mjs';
import { invoke } from '../bridge/desktop-server.mjs';
import { register } from '../hooks/register.js';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const payload = { id: 'resp_abc1234', status: 'completed', text: 'Done', usage: { input: 10, output: 10, total: 20 }, estimatedUsd: 0.00001 };

function mockedMod(worker, vars = {}) {
  const handlers = new Map();
  const registrations = [];
  const calls = [];
  register((event, filter, handler) => {
    if (typeof filter === 'function') handler = filter;
    handlers.set(event, handler);
    return { catch() { return this; } };
  });
  const context = {
    agent: { list: async () => [{ id: 'ag_1', type: `oai:${worker}`, status: 'running' }], register: async x => registrations.push(x) },
    command: { register: async () => {} },
    env: { get: async key => vars[key] },
    session: { cwd: async () => '/tmp', messages: async x => x?.as === 'api' ? [] : [{ role: 'user', text: 'Review this snippet' }] },
    fs: { read: async () => '' },
    state: { get: async () => ({ value: null }), set: async () => {} },
    mcp: { call: async (_server, method, args) => { calls.push({ method, args }); return { content: [{ type: 'text', text: JSON.stringify(payload) }] }; } },
  };
  const next = async function* (e) { throw Error('Anthropic fallback forbidden'); };
  const step = async effort => {
    const iterator = handlers.get('turn.step')(context, { agentId: 'ag_1', turnId: 'turn1', index: 0, effort }, next);
    let r = await iterator.next();
    while (!r.done) r = await iterator.next();
    return r.value;
  };
  return { context, handlers, registrations, calls, step, next };
}

test('defaults: Luna Max only, Terra high..max, other workers bounded with short notes', () => {
  assert.deepEqual(Object.keys(DEFAULT_EFFORT_POLICIES).sort(), ['astra6-2', 'astra6free', 'terra5-6free', 'sol6-1flex', 'luna6', 'luna6fast', 'luna6flex', 'sol6-2',
    // chat-completions provider workers (NVIDIA Build, LM Studio)
    'kimik3-1pro', 'mistral4large', 'nemo3-5supervl', 'nemo3-5lightning', 'sprocket0-5', 'lfm2-5mini', 'lfm3heretic', 'lfm3vl', 'lfm2-5turbo8b', 'lfm2-5turbo24b', 'inkling2mini', 'katcoder2-5'].sort());
  assert.equal(effortPolicy('luna6', {}).min, 'max');
  assert.equal(effortPolicy('luna6', {}).max, 'max');
  assert.equal(effortPolicy('terra5-6free', {}).min, 'high');
  assert.equal(effortPolicy('terra5-6free', {}).default, 'high');
  for (const name of Object.keys(DEFAULT_EFFORT_POLICIES)) {
    const p = effortPolicy(name, {});
    assert(p.note.length >= 25 && p.note.length <= 240);
    assert.equal(workerSettings(name, {}).effort_policy.min, p.min);
    assert.match(effortGuidance(name, p), /specify an effort inside that range/);
  }
});

test('effort constraints clamp both low and high requests and respect chosen defaults', () => {
  assert.deepEqual(selectWorkerEffort('luna6', 'low', {}).effective, 'max');
  assert.equal(selectWorkerEffort('terra5-6free', 'none', {}).effective, 'high');
  assert.equal(selectWorkerEffort('terra5-6free', 'max', {}).effective, 'max');
  assert.equal(selectWorkerEffort('terra5-6free', undefined, {}).effective, 'high');
  const env = { OPENAI_WORKER_SOL6_2_EFFORT_MIN: 'high', OPENAI_WORKER_SOL6_2_EFFORT_MAX: 'xhigh', OPENAI_WORKER_SOL6_2_EFFORT_DEFAULT: 'high' };
  assert.equal(selectWorkerEffort('sol6-2', 'max', env).effective, 'xhigh');
  assert.equal(selectWorkerEffort('sol6-2', 'medium', env).effective, 'high');
  assert.equal(selectWorkerEffort('sol6-2', undefined, env).effective, 'high');
});

test('changing only the minimum adjusts the built-in default; invalid explicit default is rejected', () => {
  const env = { OPENAI_WORKER_TERRA5_6FREE_EFFORT_MIN: 'max' };
  assert.equal(effortPolicy('terra5-6free', env).default, 'max');
  assert.throws(() => effortPolicy('terra5-6free', { ...env, OPENAI_WORKER_TERRA5_6FREE_EFFORT_DEFAULT: 'high' }), /falls outside/);
  assert.throws(() => effortPolicy('sol6-2', { OPENAI_WORKER_SOL6_2_EFFORT_MIN: 'max', OPENAI_WORKER_SOL6_2_EFFORT_MAX: 'high' }), /exceeds/);
  assert.throws(() => effortPolicy('sol6-2', { OPENAI_WORKER_SOL6_2_EFFORT_NOTE: 'x'.repeat(241) }), /240 characters/);
  assert.throws(() => selectWorkerEffort('sol6-2', 'ultra', {}), /not ultra/);
  assert.throws(() => effortPolicy('sol6-2', { OPENAI_WORKER_SOL6_2_EFFORT_MIN: 'none' }), /does not support/);
  assert.throws(() => effortPolicy('sol6-1flex', { OPENAI_WORKER_SOL6_1FLEX_EFFORT_MIN: 'none' }), /does not support/);
});

test('Desktop Chat exposes selection guidance and clamps effort before the API call', async () => {
  const calls = [];
  const backend = async (name, args) => { calls.push({ name, args }); return payload; };
  const workers = await invoke('list_openai_workers', {}, backend, {});
  const luna = workers.workers.find(x => x.name === 'luna6');
  assert.equal(luna.effort_policy.min, 'max');
  assert.match(luna.effort_policy.note, /Always Max/);
  const response = await invoke('ask_openai_worker', { worker: 'terra5-6free', task: 'Inspect', reasoning_effort: 'low' }, backend, {});
  assert.equal(calls[0].args.effort, 'high');
  assert.equal(response.reasoning_effort, 'high');
  assert.equal(response.effort_adjusted_from, 'low');
  const lunaResponse = await invoke('ask_openai_worker', { worker: 'luna6', task: 'Inspect' }, backend, {});
  assert.equal(calls[1].args.effort, 'max');
  assert.equal(calls[1].args.max_output_tokens, 32000);
  assert.equal(lunaResponse.reasoning_effort, 'max');
});

test('native mod shows policy to Claude and enforces it on real model step', async () => {
  const fake = mockedMod('terra5-6free');
  await fake.handlers.get('session.start')(fake.context, {}, async () => {});
  const descriptor = fake.registrations.find(x => x.name === 'terra5-6free');
  assert.match(descriptor.description, /high\.\.max/);
  assert.match(descriptor.description, /High for everyday inspection/);
  await fake.step('low');
  assert.equal(fake.calls.at(-1).args.effort, 'high');
});

test('native mod respects custom range and maps host ultra to API max', async () => {
  const vars = {
    OPENAI_WORKER_SOL6_2_EFFORT_MIN: 'medium',
    OPENAI_WORKER_SOL6_2_EFFORT_MAX: 'max',
    OPENAI_WORKER_SOL6_2_EFFORT_DEFAULT: 'high',
    OPENAI_WORKER_SOL6_2_EFFORT_NOTE: 'Max for deep investigations.',
  };
  const fake = mockedMod('sol6-2', vars);
  await fake.handlers.get('session.start')(fake.context, {}, async () => {});
  assert.match(fake.registrations.find(x => x.name === 'sol6-2').description, /Max for deep investigations/);
  await fake.step('ultra');
  assert.equal(fake.calls.at(-1).args.effort, 'max');
  assert.equal(fake.calls.at(-1).args.max_output_tokens, 32000);
});

test('invalid policy fails before native model dispatch, no Anthropic fallback', async () => {
  const fake = mockedMod('sol6-2', { OPENAI_WORKER_SOL6_2_EFFORT_MIN: 'max', OPENAI_WORKER_SOL6_2_EFFORT_MAX: 'low' });
  const result = await fake.step('high');
  assert.match(result.answer, /Invalid effort range/);
  assert.equal(fake.calls.length, 0);
});

test('Windows helper remains a dedicated per-worker configuration script', () => {
  const script = readFileSync(join(pluginRoot, 'scripts/set-worker-effort.ps1'), 'utf8');
  for (const item of ['-Min', '-Max', '-Default', '-Note', '-Show', '-Reset']) assert(script.includes(item));
  assert(script.includes('SetEnvironmentVariable'));
});
