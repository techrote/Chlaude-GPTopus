import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChat } from '../bridge/chat.mjs';
import * as convo from '../bridge/convo.mjs';
import * as steer from '../bridge/steer.mjs';
import { steerModeFor } from '../bridge/workers.mjs';
import { sse, delta, streamResponse, scriptedFetch, settle } from './support/fake-chat.mjs';

const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'oai-tsteer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { OPENAI_WORKER_USAGE_DIR: dir };
};
const AGENT = 'agent-thought-1';

test('steer modes: LM Studio defaults to think, NVIDIA to user, both configurable', () => {
  assert.equal(steerModeFor('lfm3heretic', {}), 'think');
  assert.equal(steerModeFor('kimik3-1pro', {}), 'user');
  assert.equal(steerModeFor('kimik3-1pro', { OAI_NVIDIA_STEER_MODE: 'think' }), 'think');
  assert.equal(steerModeFor('kimik3-1pro', { OAI_NVIDIA_STEER_MODE: 'think', OAI_KIMIK3_1PRO_STEER_MODE: 'user' }), 'user');
  assert.equal(steerModeFor('lfm3vl', { OAI_LMSTUDIO_STEER_MODE: 'bogus' }), 'think');
});

test('think mode: a tip mid-reasoning aborts and restarts with a <think> prefill holding the partial reasoning + note', async t => {
  const env = fixture(t);
  steer.upsertRun(AGENT, { worker: 'lfm3heretic', callsign: 'L1', step: 3, status: 'running' }, env);
  const fetchFn = scriptedFetch([
    ({ signal }) => {
      // reasoning starts, the operator posts a thought-steer, the stream would otherwise run on
      setTimeout(() => steer.enqueueTip(AGENT, { text: 'Check the README first', thought: true }, env), 30);
      return streamResponse([sse([delta({ reasoning_content: 'I will edit ' }), delta({ reasoning_content: 'main.js directly.' })]), { hang: true }], signal);
    },
    ({ signal }) => streamResponse([sse([delta({ content: ' Right, README.' }), delta({ content: '</think>I read the README first.' }, 'stop'), '[DONE]'])], signal),
  ]);
  const chat = createChat({ fetchFn, throttleMs: 0, steerTickMs: 10 });
  const started = await chat.create({ worker_type: 'lfm3heretic', model: 'lfm3-1.7b-heretic-uncensored', instructions: 'sys', tools: [], input: 'fix the bug', agent_id: AGENT }, { env });
  const r = await settle(chat, started.id, { env });
  assert.equal(r.status, 'completed');
  assert.equal(fetchFn.requests.length, 2);
  const restart = fetchFn.requests[1].body.messages;
  const prefill = restart.at(-1);
  assert.equal(prefill.role, 'assistant');
  assert.equal(prefill.content, '<think>\nI will edit main.js directly.\n[Operator note: Check the README first]\n');
  assert.deepEqual(restart.slice(0, -1), fetchFn.requests[0].body.messages, 'same history otherwise');
  assert.equal(r.text, 'I read the README first.');
  assert.equal(r.reasoning, 'I will edit main.js directly.\n[Operator note: Check the README first]\n Right, README.');
  assert.equal(r.thoughtSteers, 1);
  const stored = convo.get(r.conversation, env).messages.at(-1);
  assert.equal(stored.steer, true);
  assert.equal(stored.reasoning, r.reasoning);
  assert.equal(stored.content, 'I read the README first.');
  // the tip was consumed (not delivered again between steps) and logged
  assert.deepEqual(steer.pendingTips(AGENT, env), []);
  const log = steer.readLog(env);
  const entry = log.find(e => e.kind === 'thought-steer');
  assert.equal(entry.callsign, 'L1');
  assert.equal(entry.step, 3);
  assert.equal(entry.mode, 'think');
  assert.equal(entry.text, 'Check the README first');
  assert.ok(log.some(e => e.kind === 'delivered'));
});

test('user mode: a tip mid-reasoning aborts and restarts with an extra steer user message', async t => {
  const env = { ...fixture(t), NVIDIA_API_KEY: 'nvapi-unit-test-not-a-real-key-111111' };
  steer.upsertRun(AGENT, { worker: 'kimik3-1pro', callsign: 'K1', step: 1, status: 'running' }, env);
  steer.enqueueTip(AGENT, { text: 'Use TypeScript', ack: true }, env); // already waiting when reasoning begins
  const fetchFn = scriptedFetch([
    ({ signal }) => streamResponse([sse([delta({ reasoning_content: 'Plain JS seems fine' })]), { hang: true }], signal),
    ({ signal }) => streamResponse([sse([delta({ reasoning_content: 'Switching to TS.' }), delta({ content: 'Done in TypeScript.' }, 'stop'), '[DONE]'])], signal),
  ]);
  const chat = createChat({ fetchFn, throttleMs: 0, steerTickMs: 10 });
  const started = await chat.create({ worker_type: 'kimik3-1pro', model: 'moonshotai/kimi-k3.1-pro', instructions: 'sys', tools: [], input: 'write it', agent_id: AGENT }, { env });
  const r = await settle(chat, started.id, { env });
  assert.equal(r.status, 'completed');
  const restart = fetchFn.requests[1].body.messages;
  assert.equal(restart.at(-1).role, 'user');
  assert.equal(restart.at(-1).content, steer.tipMessage({ text: 'Use TypeScript', ack: true }));
  assert.ok(!restart.some(m => m.role === 'assistant'), 'no prefill in user mode');
  assert.equal(r.text, 'Done in TypeScript.');
  assert.equal(r.reasoning, 'Switching to TS.');
  const messages = convo.get(r.conversation, env).messages;
  assert.equal(messages.at(-2).steer, true);
  assert.equal(messages.at(-2).role, 'user');
  assert.equal(steer.readLog(env).find(e => e.kind === 'thought-steer').mode, 'user');
});

test('no thought-steer once the answer has begun, or without an agent id: the tip waits for the next step', async t => {
  const env = fixture(t);
  steer.upsertRun(AGENT, { worker: 'lfm3heretic', step: 0, status: 'running' }, env);
  const fetchFn = scriptedFetch([
    ({ signal }) => {
      setTimeout(() => steer.enqueueTip(AGENT, { text: 'late tip' }, env), 20);
      return streamResponse([sse([delta({ reasoning_content: 'short' }), delta({ content: 'Answer begins' })]), { wait: 120 }, sse([delta({ content: ' and ends.' }, 'stop'), '[DONE]'])], signal);
    },
    ({ signal }) => streamResponse([sse([delta({ reasoning_content: 'thinking a lot' })]), { wait: 80 }, sse([delta({ content: 'ok' }, 'stop'), '[DONE]'])], signal),
  ]);
  const chat = createChat({ fetchFn, throttleMs: 0, steerTickMs: 10 });
  const r = await settle(chat, (await chat.create({ worker_type: 'lfm3heretic', model: 'lfm3-1.7b-heretic-uncensored', instructions: 'sys', tools: [], input: 'q', agent_id: AGENT }, { env })).id, { env });
  assert.equal(r.text, 'Answer begins and ends.');
  assert.equal(fetchFn.requests.length, 1);
  assert.equal(steer.pendingTips(AGENT, env).length, 1, 'left for normal between-step delivery');
  const r2 = await settle(chat, (await chat.create({ worker_type: 'lfm3heretic', model: 'lfm3-1.7b-heretic-uncensored', instructions: 'sys', tools: [], input: 'q' }, { env })).id, { env });
  assert.equal(r2.text, 'ok');
  assert.equal(steer.pendingTips(AGENT, env).length, 1);
});
