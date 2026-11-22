import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChat, applyStep, splitThink, checkProviderUrl, toRequestMessages } from '../bridge/chat.mjs';
import * as convo from '../bridge/convo.mjs';
import * as steer from '../bridge/steer.mjs';
import { acquireLease, nvidiaUsagePath, workerForModel } from '../bridge/rotation.mjs';
import { invoke } from '../bridge/desktop-server.mjs';
import { validateConfig } from '../scripts/oai-config-core.mjs';
import { sse, delta, streamResponse, jsonResponse, scriptedFetch, settle } from './support/fake-chat.mjs';

const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'oai-harden-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { OPENAI_WORKER_USAGE_DIR: dir };
};
const base = { worker_type: 'lfm2-5mini', model: 'b3r5erk/lfm2.5-1.2b-instruct', instructions: 'You are a worker.', tools: [] };
const toolCallStream = (id, signal) => streamResponse([sse([delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'Read', arguments: '{"file_path":"x.txt"}' } }] }, 'tool_calls'), '[DONE]'])], signal);
const answerStream = (text, signal) => streamResponse([sse([delta({ content: text }, 'stop'), '[DONE]'])], signal);
const step2Input = [{ type: 'function_call_output', call_id: 'c1', output: 'x.txt: lorem' }, { role: 'user', content: 'Now write an essay' }];
const roles = c => c.messages.map(m => m.role + (m.tool_calls ? '(tc)' : '') + (m.role === 'user' || m.role === 'tool' ? `:${m.content.slice(0, 12)}` : ''));

test('resend after a cancelled step (hard tip) does not duplicate the step input', async t => {
  const env = fixture(t);
  const fetchFn = scriptedFetch([
    ({ signal }) => toolCallStream('c1', signal),
    ({ signal }) => streamResponse([{ hang: true }], signal),
    ({ signal }) => answerStream('Essay.', signal),
  ]);
  const chat = createChat({ fetchFn, throttleMs: 0 });
  const s1 = await settle(chat, (await chat.create({ ...base, input: 'Read x.txt' }, { env })).id, { env });
  assert.equal(s1.calls[0].call_id, 'c1');
  const s2 = await chat.create({ ...base, previous_response_id: s1.id, input: step2Input }, { env });
  assert.equal((await chat.cancel(s2.id, { env })).status, 'cancelled');
  const s3 = await chat.create({ ...base, previous_response_id: s1.id, input: [...step2Input, { role: 'user', content: '[Operator steering message] be brief' }] }, { env });
  assert.equal((await settle(chat, s3.id, { env })).status, 'completed');
  const c = convo.get(s3.conversation ?? convo.parseTurnId(s3.id).convId, env);
  assert.deepEqual(roles(c), ['system', 'user:Read x.txt', 'assistant(tc)', 'tool:x.txt: lorem', 'user:Now write an', 'user:[Operator st', 'assistant']);
  // the provider saw each tool result and user prompt exactly once
  const sent = fetchFn.requests[2].body.messages;
  assert.equal(sent.filter(m => String(m.content).includes('x.txt: lorem')).length, 1);
  assert.equal(sent.filter(m => m.content === 'Now write an essay').length, 1);
  assert.ok(!sent.some(m => /no result was recorded/.test(String(m.content))));
});

test('resend after a step that completed before the cancel landed drops the abandoned assistant tool call', async t => {
  const env = fixture(t);
  const fetchFn = scriptedFetch([
    ({ signal }) => toolCallStream('c1', signal),
    ({ signal }) => toolCallStream('c2', signal),
    ({ signal }) => answerStream('Done.', signal),
  ]);
  const chat = createChat({ fetchFn, throttleMs: 0 });
  const s1 = await settle(chat, (await chat.create({ ...base, input: 'Read x.txt' }, { env })).id, { env });
  const s2 = await chat.create({ ...base, previous_response_id: s1.id, input: step2Input }, { env });
  assert.equal((await settle(chat, s2.id, { env })).status, 'completed');
  // the mod decides to resend from s1 anyway (hard tip / rate-limit retry)
  const s3 = await chat.create({ ...base, previous_response_id: s1.id, input: step2Input }, { env });
  await settle(chat, s3.id, { env });
  const c = convo.get(convo.parseTurnId(s3.id).convId, env);
  assert.deepEqual(roles(c), ['system', 'user:Read x.txt', 'assistant(tc)', 'tool:x.txt: lorem', 'user:Now write an', 'assistant']);
  assert.ok(!c.messages.some(m => m.tool_calls?.some(tc => tc.id === 'c2')));
});

test('applyStep: operator text from an abandoned step is kept; tool results stay paired past steer messages', () => {
  const T = rev => `chat_c0123456789abcdef_${rev}`;
  const stored = [
    { role: 'system', content: 's', at: 'x' },
    { role: 'user', content: 'go', at: 'x', turn: T(1) },
    { role: 'assistant', content: '', at: 'x', turn: T(1), tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'R', at: 'x', turn: T(3) },
    { role: 'user', content: 'thought tip', steer: true, at: 'x', turn: T(3) },
    { role: 'assistant', content: 'half', at: 'x', turn: T(3) },
  ];
  const { messages, dropped } = applyStep(stored, [{ type: 'function_call_output', call_id: 'c1', output: 'R' }], { afterRev: 1, tag: T(6) });
  assert.equal(dropped, 2);
  assert.deepEqual(messages.map(m => `${m.role}:${m.content}`), ['system:s', 'user:go', 'assistant:', 'tool:R', 'user:thought tip']);
  assert.equal(messages[3].turn, T(6));
  // a kept steer message right after a tool-call group does not close it: the result is placed next to its call
  const late = applyStep([...stored.slice(0, 3), { role: 'user', content: 'steer', steer: true, at: 'x' }], [{ type: 'function_call_output', call_id: 'c1', output: 'R' }]);
  assert.deepEqual(late.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  const req = toRequestMessages(late.messages);
  assert.ok(!req.some(m => /no result was recorded|\[Tool result for call/.test(String(m.content))));
});

test('convo: no insert directly after an unanswered tool call', t => {
  const env = fixture(t);
  const c = convo.createConvo({ worker: 'w', system: 's' }, env);
  const saved = convo.append(c.id, [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [{ id: 'k', function: { name: 'Read', arguments: '{}' } }] }], env);
  assert.throws(() => convo.insertMessage(c.id, 2, { role: 'user', content: 'x' }, env), /directly after a tool call/);
  assert.equal(convo.insertMessage(c.id, 1, { role: 'user', content: 'before' }, env).messages[2].content, 'before');
  assert.ok(saved.rev > 0);
});

test('convo store keeps large tool results, tool-call arguments and deep objects intact (no trace truncation)', t => {
  const env = fixture(t);
  const big = 'y'.repeat(250_000);
  const args = JSON.stringify({ file_path: 'a.txt', content: 'z'.repeat(250_000) });
  let deep = { leaf: 'end' };
  for (let n = 0; n < 20; n++) deep = { n: deep };
  const c = convo.createConvo({ worker: 'w', system: 's' }, env);
  convo.append(c.id, [{ role: 'assistant', content: '', tool_calls: [{ id: 'k', function: { name: 'Write', arguments: args } }] }, { role: 'tool', tool_call_id: 'k', content: big }], env,
    { lastTurn: { id: 'x', result: { calls: [{ args: deep }] } } });
  const s = convo.get(c.id, env);
  assert.equal(s.messages[2].content, big);
  assert.equal(s.messages[1].tool_calls[0].function.arguments, args);
  assert.doesNotThrow(() => JSON.parse(s.messages[1].tool_calls[0].function.arguments));
  assert.deepEqual(s.lastTurn.result.calls[0].args, deep);
});

test('convo: a huge live preview never trims history; a trim on a preview write bumps rev', t => {
  const env = { ...fixture(t), OAI_CONVO_MAX_BYTES: String(convo.MIN_CONVO_BYTES) };
  const c = convo.createConvo({ worker: 'w', system: 's' }, env);
  for (let n = 0; n < 4; n++) convo.append(c.id, [{ role: 'user', content: `m${n} ${'x'.repeat(5000)}` }], env);
  const before = convo.get(c.id, env);
  const live = convo.patch(c.id, { pending: { phase: 'reasoning', reasoning: 'r'.repeat(convo.MAX_PENDING_CHARS + 5000), content: '' } }, env);
  assert.equal(live.messages.length, before.messages.length, 'history untouched');
  assert.equal(live.rev, before.rev, 'a plain preview does not bump rev');
  assert.equal(live.pending.reasoning.length, convo.MAX_PENDING_CHARS + 1);
  // history over the bound (bound lowered by configuration) trimmed during a preview write: rev moves on
  const roomy = { ...env, OAI_CONVO_MAX_BYTES: '67108864' };
  for (let n = 0; n < 12; n++) convo.append(c.id, [{ role: 'user', content: `g${n} ${'x'.repeat(9000)}` }], roomy);
  const big = convo.get(c.id, env);
  const trimmed = convo.patch(c.id, { pending: { phase: 'answer', reasoning: '', content: 'a' } }, env);
  assert.ok(trimmed.messages.length < big.messages.length);
  assert.equal(trimmed.rev, big.rev + 1);
  assert.throws(() => convo.editMessage(c.id, 3, { content: 'stale', expectRev: big.rev }, env), /changed since/);
});

test('rotation substitute gets its own thinking controls', async t => {
  const env = fixture(t);
  assert.equal(workerForModel('nvidia/nemotron-3.5-lightning-30b-a3b', env), 'nemo3-5lightning');
  assert.equal(workerForModel('nobody/none', env), null);
  const fetchFn = scriptedFetch([({ signal }) => answerStream('ok', signal), ({ signal }) => answerStream('ok', signal)]);
  const chat = createChat({ fetchFn, throttleMs: 0, key: 'unit-test-not-a-key', acquireLease: async () => ({ release() {} }) });
  const pick = model => () => ({ model, substitutedFrom: 'mistralai/mistral-large-4-1t-a52b' });
  const a = await chat.create({ ...base, worker_type: 'mistral4large', effort: 'high' }, { env, chooseModel: pick('nvidia/nemotron-3.5-lightning-30b-a3b') });
  await settle(chat, a.id, { env });
  const body = fetchFn.requests[0].body;
  assert.equal(body.model, 'nvidia/nemotron-3.5-lightning-30b-a3b');
  assert.equal(body.reasoning_effort, undefined);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
  const b = await chat.create({ ...base, worker_type: 'mistral4large', effort: 'high' }, { env, chooseModel: pick('someone/unknown-model') });
  await settle(chat, b.id, { env });
  assert.equal(fetchFn.requests[1].body.reasoning_effort, undefined);
  assert.equal(fetchFn.requests[1].body.chat_template_kwargs, undefined);
});

test('splitThink: a lone </think> (template opened the thought) splits reasoning from the answer', async t => {
  assert.deepEqual(splitThink('plan it</think>Final'), { reasoning: 'plan it', answer: 'Final', closed: true });
  assert.deepEqual(splitThink('plan it</think>Final', { implicitOpen: false }), { reasoning: '', answer: 'plan it</think>Final', closed: true });
  const env = fixture(t);
  const fetchFn = scriptedFetch([({ signal }) => streamResponse([sse([delta({ content: 'plan ' }), delta({ content: 'it</think>\n\nFinal' }, 'stop'), '[DONE]'])], signal)]);
  const chat = createChat({ fetchFn, throttleMs: 0 });
  const r = await settle(chat, (await chat.create({ ...base, input: 'hi' }, { env })).id, { env });
  assert.equal(r.text, 'Final');
  assert.equal(r.reasoning, 'plan it');
  const stored = convo.get(convo.parseTurnId(r.id).convId, env).messages.at(-1);
  assert.equal(stored.content, 'Final');
  assert.ok(!stored.content.includes('</think>'));
});

test('LM Studio auto-start is asynchronous and shared by concurrent turns', async t => {
  const env = fixture(t);
  let up = false, spawned = 0, ticks = 0;
  const fetchFn = async url => {
    if (url.endsWith('/models')) { if (up) return jsonResponse(200, { data: [] }); throw new TypeError('fetch failed'); }
    if (!up) throw new TypeError('fetch failed');
    return jsonResponse(200, { model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'up' }, finish_reason: 'stop' }] });
  };
  const spawnFn = () => { spawned++; return new Promise(resolve => setTimeout(() => { up = true; resolve(); }, 120)); };
  const timer = setInterval(() => ticks++, 10);
  t.after(() => clearInterval(timer));
  const chat = createChat({ fetchFn, spawnFn, lmsPath: 'C:/fake/lms.exe', lmsPollMs: 5, throttleMs: 0 });
  const [a, b] = await Promise.all([chat.create({ ...base, input: 'one' }, { env }), chat.create({ ...base, input: 'two' }, { env })]);
  const [ra, rb] = await Promise.all([settle(chat, a.id, { env }), settle(chat, b.id, { env })]);
  assert.equal(ra.status, 'completed'); assert.equal(rb.status, 'completed');
  assert.equal(spawned, 1, 'one start attempt shared by both turns');
  assert.ok(ticks >= 5, 'the event loop kept running while LM Studio started');
});

test('LM Studio requests carry an output bound; a runaway stream is cut off', async t => {
  const env = fixture(t);
  const fetchFn = scriptedFetch([({ signal }) => streamResponse([sse([delta({ content: 'a'.repeat(600) }), delta({ content: 'b'.repeat(600) }), delta({ content: 'c' }, 'stop'), '[DONE]'])], signal)]);
  const chat = createChat({ fetchFn, throttleMs: 0, maxStreamChars: 1000 });
  const r = await settle(chat, (await chat.create({ ...base, input: 'loop' }, { env })).id, { env });
  assert.equal(fetchFn.requests[0].body.max_tokens, 16000);
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /cut off/);
});

test('provider URLs: the NVIDIA key only goes over https to NVIDIA; LM Studio stays on loopback unless opted in', async t => {
  assert.doesNotThrow(() => checkProviderUrl('nvidia', 'https://integrate.api.nvidia.com/v1', {}));
  assert.throws(() => checkProviderUrl('nvidia', 'http://integrate.api.nvidia.com/v1', {}), /https/);
  assert.throws(() => checkProviderUrl('nvidia', 'https://evil.example/v1', {}), /ALLOW_CUSTOM/);
  assert.doesNotThrow(() => checkProviderUrl('nvidia', 'https://nim.example/v1', { OAI_NVIDIA_URL_ALLOW_CUSTOM: '1' }));
  assert.throws(() => checkProviderUrl('nvidia', 'http://nim.example/v1', { OAI_NVIDIA_URL_ALLOW_CUSTOM: '1' }), /https/);
  assert.doesNotThrow(() => checkProviderUrl('nvidia', 'http://127.0.0.1:8000/v1', { OAI_NVIDIA_URL_ALLOW_CUSTOM: '1' }));
  for (const ok of ['http://127.0.0.1:1234/v1', 'http://localhost:1234/v1', 'http://[::1]:1234/v1']) assert.doesNotThrow(() => checkProviderUrl('lmstudio', ok, {}));
  assert.throws(() => checkProviderUrl('lmstudio', 'http://10.0.0.5:1234/v1', {}), /loopback/);
  assert.doesNotThrow(() => checkProviderUrl('lmstudio', 'http://10.0.0.5:1234/v1', { OAI_LMSTUDIO_ALLOW_REMOTE: '1' }));
  // the transport refuses before any request leaves
  const env = { ...fixture(t), OAI_NVIDIA_URL: 'http://evil.example/v1' };
  const fetchFn = scriptedFetch([]);
  const chat = createChat({ fetchFn, throttleMs: 0, key: 'unit-test-not-a-key', acquireLease: async () => ({ release() {} }), chooseModel: m => ({ model: m }) });
  const r = await settle(chat, (await chat.create({ ...base, worker_type: 'kimik3-1pro' }, { env })).id, { env });
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /https/);
  assert.equal(fetchFn.requests.length, 0);
  const remote = { ...fixture(t), OAI_LMSTUDIO_URL: 'http://192.168.1.9:1234/v1' };
  const r2 = await settle(chat, (await chat.create({ ...base, input: 'hi' }, { env: remote })).id, { env: remote });
  assert.match(r2.reason, /loopback/);
  assert.equal(fetchFn.requests.length, 0);
  // the panel refuses the same configurations
  assert.match(validateConfig({ OAI_NVIDIA_URL: 'https://evil.example/v1' }).errors.OAI_NVIDIA_URL, /CUSTOM/);
  assert.match(validateConfig({ OAI_NVIDIA_URL: 'http://nim.example/v1', OAI_NVIDIA_URL_ALLOW_CUSTOM: '1' }).errors.OAI_NVIDIA_URL, /https/);
  assert.equal(validateConfig({ OAI_NVIDIA_URL: 'https://nim.example/v1', OAI_NVIDIA_URL_ALLOW_CUSTOM: '1' }).errors.OAI_NVIDIA_URL, undefined);
  assert.match(validateConfig({ OAI_LMSTUDIO_URL: 'http://10.0.0.5:1234/v1' }).errors.OAI_LMSTUDIO_URL, /REMOTE/);
  assert.equal(validateConfig({ OAI_LMSTUDIO_URL: 'http://10.0.0.5:1234/v1', OAI_LMSTUDIO_ALLOW_REMOTE: '1' }).errors.OAI_LMSTUDIO_URL, undefined);
});

test('Desktop facade refuses provider workers even though the schema enum is not enforced by clients', async () => {
  const env = { OPENAI_API_KEY: 'test-standard-key', OPENAI_FREE_API_KEY: 'test-free-key' };
  const calls = [];
  const backend = async (tool, args) => { calls.push(tool); return { id: 'chat_c0123456789abcdef_1', status: 'in_progress' }; };
  await assert.rejects(() => invoke('ask_openai_worker', { worker: 'lfm2-5mini', task: 'hi' }, backend, env), /OpenAI workers only/);
  await assert.rejects(() => invoke('ask_openai_worker', { worker: 'kimik3-1pro', task: 'hi' }, backend, env), /OpenAI workers only/);
  await assert.rejects(() => invoke('poll_openai_worker', { worker: 'kimik3-1pro', response_id: 'resp_abc1234' }, backend, env), /OpenAI workers only/);
  await assert.rejects(() => invoke('cancel_openai_worker', { worker: 'lfm3vl', response_id: 'resp_abc1234' }, backend, env), /OpenAI workers only/);
  assert.deepEqual(calls, []);
});

test('a lease whose release could not be written does not block the next request of this process', async t => {
  const env = fixture(t);
  const model = 'nvidia/nemotron-3.5-lightning-30b-a3b';
  const first = await acquireLease(model, env);
  const lock = `${nvidiaUsagePath(env)}.lock`;
  writeFileSync(lock, ''); // another writer holds the usage file: the release write fails after its wait
  first.release();
  rmSync(lock, { force: true });
  const state = JSON.parse(readFileSync(nvidiaUsagePath(env), 'utf8'));
  assert.ok(state.leases[first.id], 'the failed release left the entry behind');
  const started = Date.now();
  const second = await acquireLease(model, env, { pollMs: 10 });
  assert.ok(Date.now() - started < 1000, 'the leftover entry of this process was dropped at once');
  second.release();
  await new Promise(r => setTimeout(r, 400)); // let the release retry run against the now-free file
  assert.deepEqual(JSON.parse(readFileSync(nvidiaUsagePath(env), 'utf8')).leases, {});
});
