import './support/isolate.mjs';
/**
 * Opt-in live test against a running LM Studio server (never runs in the normal suite):
 *   OAI_LIVE_LMSTUDIO=1 node --test tests/lmstudio-live.test.mjs
 * Uses a small model that is already on disk (default lfm3-1.7b; override with OAI_LIVE_LMSTUDIO_MODEL). Never downloads.
 * OAI_LMSTUDIO_URL overrides the server URL (default http://127.0.0.1:1234/v1).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChat } from '../bridge/chat.mjs';
import * as convo from '../bridge/convo.mjs';
import * as steer from '../bridge/steer.mjs';
import { responseStep } from '../hooks/step.js';
import { OPENAI_TOOLS } from '../hooks/tools.js';

const live = process.env.OAI_LIVE_LMSTUDIO === '1';
const MODEL = process.env.OAI_LIVE_LMSTUDIO_MODEL || 'lfm3-1.7b';
const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'oai-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { OPENAI_WORKER_USAGE_DIR: dir, OPENAI_WORKER_LFM3HERETIC_MODEL: MODEL,
    ...(process.env.OAI_LMSTUDIO_URL && { OAI_LMSTUDIO_URL: process.env.OAI_LMSTUDIO_URL }) };
};
const base = { worker_type: 'lfm3heretic', model: MODEL, tools: OPENAI_TOOLS.filter(t => t.name === 'Read') };
async function settle(chat, id, env) {
  const end = Date.now() + 240_000;
  while (Date.now() < end) {
    const r = await chat.poll(id, { env, wait_ms: 5000 });
    if (r.status !== 'in_progress') return r;
  }
  throw new Error('live LM Studio step timed out');
}

test('live LM Studio: one tool call round trip', { skip: !live && 'set OAI_LIVE_LMSTUDIO=1 to run' }, async t => {
  const env = fixture(t);
  const chat = createChat({});
  const instructions = 'You are a coding subagent. When asked about a file you MUST call the Read tool with its absolute path. After you receive the tool result, answer in one short sentence quoting the file content.';
  const first = await settle(chat, (await chat.create({ ...base, instructions, input: 'What does the file C:/demo/answer.txt contain? Use the Read tool.' }, { env })).id, env);
  assert.equal(first.status, 'completed', first.reason);
  assert.ok(first.calls.length >= 1, `expected a tool call, got text: ${first.text}`);
  assert.equal(first.calls[0].name, 'Read');
  const step = responseStep(first, 'live', null);
  assert.equal(step.toolUses[0].name, 'Read');
  assert.equal(typeof step.toolUses[0].input.file_path, 'string');
  const outputs = first.calls.map(c => ({ type: 'function_call_output', call_id: c.call_id, output: 'The secret number is 4711.' }));
  const second = await settle(chat, (await chat.create({ ...base, instructions, input: outputs, previous_response_id: first.id }, { env })).id, env);
  assert.equal(second.status, 'completed', second.reason);
  assert.match(second.text, /4711/);
  const stored = convo.get(second.conversation, env).messages;
  assert.deepEqual(stored.map(m => m.role).slice(0, 4), ['system', 'user', 'assistant', 'tool']);
  t.diagnostic(`answer: ${second.text.slice(0, 200)}`);
});

test('live LM Studio: thought-steer mid-reasoning (think prefill)', { skip: !live && 'set OAI_LIVE_LMSTUDIO=1 to run' }, async t => {
  const env = fixture(t);
  const agent = 'live-thought-agent';
  steer.upsertRun(agent, { worker: 'lfm3heretic', callsign: 'L9', step: 1, status: 'running' }, env);
  // The tip is already waiting when the model starts to reason, so it is injected as soon as reasoning appears.
  steer.enqueueTip(agent, { text: 'The operator wants the final answer to end with the word BANANA.', thought: true }, env);
  const chat = createChat({ steerTickMs: 50, throttleMs: 50 });
  const r = await settle(chat, (await chat.create({ ...base, tools: [], instructions: 'Think step by step before answering.',
    input: 'List the prime numbers between 1 and 60, then say how many there are.', agent_id: agent }, { env })).id, env);
  assert.equal(r.status, 'completed', r.reason);
  assert.equal(r.thoughtSteers, 1);
  assert.match(r.reasoning, /\[Operator note: The operator wants the final answer to end with the word BANANA\.\]/);
  const last = convo.get(r.conversation, env).messages.at(-1);
  assert.equal(last.steer, true);
  assert.ok(steer.readLog(env).some(e => e.kind === 'thought-steer' && e.mode === 'think' && e.callsign === 'L9'));
  t.diagnostic(`reasoning tail: ${r.reasoning.slice(-300).replace(/\s+/g, ' ')}`);
  t.diagnostic(`answer: ${r.text.slice(0, 300).replace(/\s+/g, ' ')}`);
});
