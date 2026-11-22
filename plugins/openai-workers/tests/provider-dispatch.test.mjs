import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../bridge/server.mjs';
import { usagePath } from '../bridge/usage.mjs';
import { createTurn, keyProfileForWorker, configuredKey } from '../bridge/openai.mjs';
import { WORKER_TYPES, OPENAI_WORKERS, PROVIDER_WORKERS, isProviderWorker, workerSettings } from '../bridge/workers.mjs';
import { createChat } from '../bridge/chat.mjs';
import { OPENAI_TOOLS } from '../hooks/tools.js';
import { sse, delta, streamResponse, scriptedFetch } from './support/fake-chat.mjs';

const fixture = (t, extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'oai-pdisp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { OPENAI_WORKER_USAGE_DIR: dir, ...extra };
};
const refuseOpenAI = { create: () => { throw new Error('OpenAI transport must not be used'); }, poll: () => { throw new Error('OpenAI poll must not be used'); }, cancel: () => { throw new Error('OpenAI cancel must not be used'); } };

test('registry: eleven provider workers, eight unchanged OpenAI workers, provider-only settings', () => {
  assert.deepEqual(OPENAI_WORKERS, ['sol6-2', 'astra6-2', 'luna6', 'luna6fast', 'luna6flex', 'sol6-1flex', 'astra6free', 'terra5-6free']);
  assert.deepEqual(PROVIDER_WORKERS, ['kimik3-1pro', 'mistral4large', 'nemo3-5supervl', 'nemo3-5lightning', 'sprocket0-5', 'lfm2-5mini', 'lfm3heretic', 'lfm3vl', 'lfm2-5turbo8b', 'lfm2-5turbo24b', 'inkling2mini']);
  for (const w of PROVIDER_WORKERS) {
    const s = workerSettings(w, { OPENAI_WORKER_SERVICE_TIER: 'priority' });
    assert.equal(s.service_tier, undefined, `${w} has no service tier`);
    assert.equal(s.key_profile, WORKER_TYPES[w].provider === 'nvidia' ? 'nvidia' : 'none');
    assert.equal(keyProfileForWorker(w), s.key_profile);
    assert.match(WORKER_TYPES[w].env, /^OPENAI_WORKER_[A-Z0-9_]+_MODEL$/);
    assert.match(WORKER_TYPES[w].description, WORKER_TYPES[w].provider === 'nvidia' ? /^NVIDIA Build free model/ : /^Local LM Studio model on this PC/);
  }
  assert.equal(workerSettings('sprocket0-5', {}).tools, false);
  assert.equal(isProviderWorker('sol6-2'), false);
  assert.equal(isProviderWorker('lfm3vl'), true);
  assert.equal(workerSettings('luna6fast', {}).service_tier, 'fast', 'OpenAI tiers unchanged');
  assert.equal(configuredKey({ NVIDIA_API_KEY: 'nvapi-unit-test-not-a-real-key-333333' }, 'nvidia'), 'environment');
});

test('the OpenAI transport refuses provider workers before any request', async () => {
  let called = false;
  await assert.rejects(createTurn({ worker_type: 'kimik3-1pro', model: 'moonshotai/kimi-k3.1-pro', instructions: 'x', tools: [], input: 'x' },
    { key: 'unused', fetchFn: async () => { called = true; } }), /do not use the OpenAI Responses transport/);
  assert.equal(called, false);
});

test('dispatch routes provider workers to the chat transport, never the OpenAI ledger or transport', async t => {
  const env = fixture(t, { OPENAI_WORKER_LFM3VL_EFFORT_MAX: 'low' });
  const seen = [];
  const chat = {
    create: async (args, o) => { seen.push(['create', args, o.env === env]); return { id: 'chat_c0123456789abcdef_1', status: 'in_progress' }; },
    poll: async (id, o) => { seen.push(['poll', id, o.worker_type, o.wait_ms]); return { id, status: 'completed', text: 'ok', calls: [], usage: null, estimatedUsd: 0 }; },
    cancel: async (id, o) => { seen.push(['cancel', id, o.worker_type]); return { id, status: 'cancelled' }; },
  };
  const opts = { env, chat, transport: refuseOpenAI };
  const args = { worker_type: 'lfm3vl', model: 'lfm3-vl-2b', input: 'hi', instructions: 'sys', tools: OPENAI_TOOLS, effort: 'max',
    service_tier: 'priority', request_id: 'r1', agent_id: 'agent-9', max_output_tokens: 16000 };
  const created = await dispatch('create', args, opts);
  assert.equal(created.status, 'in_progress');
  const [, sent, sameEnv] = seen[0];
  assert.equal(sameEnv, true);
  assert.equal(sent.effort, 'low', 'effort clamped to the worker policy');
  assert.equal(sent.service_tier, undefined);
  assert.equal(sent.request_id, undefined);
  assert.equal(sent.agent_id, 'agent-9');
  assert.equal((await dispatch('poll', { id: created.id, worker_type: 'lfm3vl', wait_ms: 5000 }, opts)).text, 'ok');
  assert.deepEqual(seen[1], ['poll', created.id, 'lfm3vl', 5000]);
  assert.equal((await dispatch('cancel', { id: created.id, worker_type: 'lfm3vl' }, opts)).status, 'cancelled');
  assert.equal(existsSync(usagePath(env)), false, 'the OpenAI usage ledger is never touched');
  await assert.rejects(dispatch('create', { ...args, model: 'gpt-6.2-sol' }, opts), /caller model substitution is not permitted/);
  await assert.rejects(dispatch('poll', { id: 'resp_abcdef', worker_type: 'lfm3vl' }, opts), /Invalid provider response id/);
  await assert.rejects(dispatch('create', { ...args, tools: undefined }, opts), /Tool manifest required/);
  const health = await dispatch('health', {}, { env });
  assert.deepEqual(health.nvidia, { configured: false, source: 'none' });
  assert.equal(health.lmstudio.url, 'http://127.0.0.1:1234/v1');
  assert.equal(health.nvidiaBudget.policy.concurrency, 1);
});

test('dispatch end to end with the real chat transport and a fake LM Studio', async t => {
  const env = fixture(t);
  const fetchFn = scriptedFetch([({ signal }) => streamResponse([sse([delta({ reasoning_content: 'ok' }), delta({ content: 'Hello from LM Studio' }, 'stop'), '[DONE]'])], signal)]);
  const chat = createChat({ fetchFn, throttleMs: 0 });
  const opts = { env, chat, transport: refuseOpenAI };
  let r = await dispatch('create', { worker_type: 'lfm2-5mini', model: 'b3r5erk/lfm2.5-1.2b-instruct', input: 'hi', instructions: 'sys', tools: [] }, opts);
  while (r.status === 'in_progress') r = await dispatch('poll', { id: r.id, worker_type: 'lfm2-5mini', wait_ms: 200 }, opts);
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'Hello from LM Studio');
  assert.equal(r.estimatedUsd, 0);
  await assert.rejects(dispatch('poll', { id: r.id, worker_type: 'lfm3vl' }, opts), /identity mismatch/);
  assert.equal(existsSync(usagePath(env)), false);
});

test('bridge create schema advertises agent_id', async () => {
  const { handle } = await import('../bridge/server.mjs');
  let out;
  await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, m => { out = m; });
  const create = out.result.tools.find(tool => tool.name === 'create');
  assert.deepEqual(create.inputSchema.properties.agent_id, { type: 'string' });
});
