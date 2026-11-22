import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChat, inputToMessages, toChatTools, toRequestMessages, splitThink, sseParser } from '../bridge/chat.mjs';
import * as convo from '../bridge/convo.mjs';
import { responseStep } from '../hooks/step.js';
import { OPENAI_TOOLS } from '../hooks/tools.js';
import { sse, delta, streamResponse, jsonResponse, scriptedFetch, settle } from './support/fake-chat.mjs';

const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'oai-chat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { OPENAI_WORKER_USAGE_DIR: dir };
};
const base = { worker_type: 'lfm2-5mini', model: 'b3r5erk/lfm2.5-1.2b-instruct', instructions: 'You are a worker.', tools: OPENAI_TOOLS };

test('format: Responses input and tools become chat messages and chat tools', () => {
  const stored = [{ role: 'system', content: 's' }, { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{}' } }] }];
  const msgs = inputToMessages([
    { role: 'user', content: [{ type: 'input_text', text: 'and also' }] },
    { type: 'function_call_output', call_id: 'c1', output: 'file text' },
    { type: 'function_call_output', call_id: 'ghost', output: 'orphan' },
  ], stored);
  assert.deepEqual(msgs, [
    { role: 'tool', tool_call_id: 'c1', content: 'file text' },
    { role: 'user', content: 'and also' },
    { role: 'user', content: '[Tool result for call ghost]\norphan' },
  ]);
  assert.deepEqual(inputToMessages('hello'), [{ role: 'user', content: 'hello' }]);
  const tools = toChatTools(OPENAI_TOOLS);
  assert.equal(tools.length, OPENAI_TOOLS.length);
  assert.deepEqual(Object.keys(tools[0]), ['type', 'function']);
  assert.equal(tools[0].function.name, OPENAI_TOOLS[0].name);
  assert.deepEqual(tools[0].function.parameters, OPENAI_TOOLS[0].parameters);
  // reasoning is never replayed; unanswered calls get an error result; stray results become text
  const req = toRequestMessages([
    { role: 'system', content: 's' },
    { role: 'assistant', content: 'a', reasoning: 'secret thoughts', tool_calls: [{ id: 'k1', type: 'function', function: { name: 'Read', arguments: '{}' } }, { id: 'k2', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'k1', content: 'ok' },
    { role: 'tool', tool_call_id: 'zz', content: 'stray' },
    { role: 'user', content: 'next' },
  ]);
  assert.ok(!JSON.stringify(req).includes('secret thoughts'));
  assert.deepEqual(req.map(m => m.role), ['system', 'assistant', 'tool', 'tool', 'user', 'user']);
  assert.equal(req[3].tool_call_id, 'k2');
  assert.match(req[3].content, /no result was recorded/);
  assert.deepEqual(splitThink('<think>abc</think>Hello'), { reasoning: 'abc', answer: 'Hello', closed: true });
  assert.deepEqual(splitThink(' more</think>Done', { prefilled: true }), { reasoning: ' more', answer: 'Done', closed: true });
  assert.equal(splitThink('<think>still going').closed, false);
  const parse = sseParser();
  assert.deepEqual(parse('data: {"a":'), []);
  assert.deepEqual(parse('1}\n\ndata: [DONE]\n'), [{ a: 1 }, 'done']);
});

test('transport: streamed reasoning + split tool-call deltas normalize into a step the mod can run', async t => {
  const env = fixture(t);
  const text = sse([
    delta({ role: 'assistant', reasoning_content: 'I should ' }),
    delta({ reasoning_content: 'read the file.' }),
    delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Read', arguments: '{"file_pa' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"C:/x.txt"}' } }] }, 'tool_calls'),
    { choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42, completion_tokens_details: { reasoning_tokens: 8 } } },
    '[DONE]',
  ]);
  // split the SSE text at awkward places (mid-line, mid-JSON)
  const pieces = [text.slice(0, 17), text.slice(17, 120), text.slice(120, 121), text.slice(121, 400), text.slice(400)];
  const fetchFn = scriptedFetch([({ signal }) => streamResponse(pieces, signal)]);
  const chat = createChat({ fetchFn, throttleMs: 0 });
  const started = await chat.create({ ...base, input: 'Read C:/x.txt' }, { env });
  assert.equal(started.status, 'in_progress');
  assert.match(started.id, /^chat_c[a-f0-9]{16}_\d+$/);
  const r = await settle(chat, started.id, { env, worker_type: 'lfm2-5mini' });
  assert.equal(r.status, 'completed');
  assert.equal(r.text, '');
  assert.deepEqual(r.calls, [{ call_id: 'call_a', name: 'Read', args: { file_path: 'C:/x.txt' } }]);
  assert.deepEqual(r.usage, { input: 30, cached: 0, output: 12, total: 42, reasoning: 8 });
  assert.equal(r.estimatedUsd, 0);
  assert.equal(r.reasoning, 'I should read the file.');
  const step = responseStep(r, 'seed', null);
  assert.deepEqual(step.toolUses, [{ name: 'Read', input: { file_path: 'C:/x.txt' } }]);
  assert.deepEqual(step.pending, ['call_a']);
  // request: streaming, chat tools, LM Studio default URL, no Authorization header
  const req = fetchFn.requests[0];
  assert.equal(req.url, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(req.body.stream, true);
  assert.equal(req.body.model, 'b3r5erk/lfm2.5-1.2b-instruct');
  assert.equal(req.body.tools[0].type, 'function');
  assert.ok(!('Authorization' in req.headers));
  assert.deepEqual(req.body.messages, [{ role: 'system', content: 'You are a worker.' }, { role: 'user', content: 'Read C:/x.txt' }]);
  // stored: reasoning on the assistant message, never as content
  const stored = convo.get(r.conversation, env);
  const last = stored.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.reasoning, 'I should read the file.');
  assert.equal(last.tool_calls[0].id, 'call_a');
  assert.equal(stored.status, 'completed');
  assert.equal(stored.pending, undefined);
  assert.equal(stored.lastTurn.id, r.id);
});

test('transport: continuation replays the CURRENT (edited) history and "<think>" content is split', async t => {
  const env = fixture(t);
  const fetchFn = scriptedFetch([
    ({ signal }) => streamResponse([sse([delta({ reasoning_content: 'plan' }), delta({ tool_calls: [{ index: 0, id: 'c9', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] }, 'tool_calls'), '[DONE]'])], signal),
    ({ signal }) => streamResponse([sse([delta({ content: '<think>inline ' }), delta({ content: 'thought</think>The answer is 42.' }, 'stop'), '[DONE]'])], signal),
  ]);
  const chat = createChat({ fetchFn, throttleMs: 0 });
  const first = await settle(chat, (await chat.create({ ...base, input: 'go' }, { env })).id, { env });
  // operator edits the first user message before the next step
  convo.editMessage(first.conversation, 1, { content: 'go (edited by operator)' }, env);
  const second = await chat.create({ ...base, input: [{ type: 'function_call_output', call_id: 'c9', output: 'contents of a' }], previous_response_id: first.id }, { env });
  const r = await settle(chat, second.id, { env });
  assert.equal(r.text, 'The answer is 42.');
  assert.equal(r.reasoning, 'inline thought');
  assert.equal(r.conversation, first.conversation);
  const sent = fetchFn.requests[1].body.messages;
  assert.equal(sent[1].content, 'go (edited by operator)');
  assert.deepEqual(sent.map(m => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(sent[2].tool_calls[0].id, 'c9');
  assert.ok(!JSON.stringify(sent).includes('plan'), 'reasoning is not replayed');
  assert.equal(sent[3].content, 'contents of a');
  // the stored transcript is the editable history
  const stored = convo.get(first.conversation, env);
  assert.deepEqual(stored.messages.map(m => m.role), ['system', 'user', 'assistant', 'tool', 'assistant']);
  assert.equal(stored.messages[1].edited, true);
  // unknown conversation / wrong worker fail closed
  await assert.rejects(chat.create({ ...base, worker_type: 'lfm3vl', model: 'lfm3-vl-2b', input: 'x', previous_response_id: first.id }, { env }), /worker differs/);
  await assert.rejects(chat.create({ ...base, input: 'x', previous_response_id: 'resp_abcdef' }, { env }), /Invalid previous_response_id/);
  await assert.rejects(chat.poll(first.id, { env, worker_type: 'lfm3vl' }), /identity mismatch/);
});

test('transport: cancel aborts the stream; HTTP failures report status and provider message', async t => {
  const env = fixture(t);
  const fetchFn = scriptedFetch([
    ({ signal }) => streamResponse([sse([delta({ reasoning_content: 'hmm' })]), { hang: true }], signal),
    () => jsonResponse(404, { error: { message: 'model not found' } }),
  ]);
  const chat = createChat({ fetchFn, throttleMs: 0 });
  const started = await chat.create({ ...base, input: 'go' }, { env });
  await new Promise(r => setTimeout(r, 50));
  const cancelled = await chat.cancel(started.id, { env });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(convo.get(started.conversation, env).status, 'cancelled');
  const failed = await settle(chat, (await chat.create({ ...base, input: 'go' }, { env })).id, { env });
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /LM Studio HTTP 404: model not found/);
  const step = responseStep(failed, 'seed', null);
  assert.equal(step.finished, true);
});

test('transport: LM Studio auto-start is attempted once when the server is not listening', async t => {
  const env = fixture(t);
  const spawned = [];
  let chatCalls = 0;
  const fetchFn = async (url, init = {}) => {
    if (url.endsWith('/models')) return jsonResponse(200, { data: [] });
    if (chatCalls++ === 0) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return jsonResponse(200, { model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'up now', reasoning_content: '' }, finish_reason: 'stop' }] });
  };
  const spawnFn = (exe, args, opts) => { spawned.push({ exe, args, opts }); return { on() {}, unref() {} }; };
  const chat = createChat({ fetchFn, spawnFn, lmsPath: 'C:/fake/lms.exe', lmsPollMs: 5, throttleMs: 0 });
  const r = await settle(chat, (await chat.create({ ...base, input: 'hi' }, { env })).id, { env });
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'up now');
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ['server', 'start']);
  assert.equal(spawned[0].exe, 'C:/fake/lms.exe');
  assert.equal(spawned[0].opts.shell, false);
  assert.equal(spawned[0].opts.windowsHide, true);
  // a second refusal does not spawn again: it fails with a clear message
  const down = createChat({ fetchFn: async () => { throw new TypeError('fetch failed'); }, spawnFn, lmsPath: 'C:/fake/lms.exe', lmsPollMs: 5, lmsStartWaitMs: 30, throttleMs: 0 });
  const f1 = await settle(down, (await down.create({ ...base, input: 'hi' }, { env })).id, { env });
  const f2 = await settle(down, (await down.create({ ...base, input: 'hi' }, { env })).id, { env });
  assert.match(f1.reason, /LM Studio is not reachable/);
  assert.match(f2.reason, /LM Studio is not reachable/);
  assert.equal(spawned.length, 2, 'one start attempt per transport and URL');
});

test('transport: NVIDIA sends Bearer key and thinking controls, never stores or traces the key', async t => {
  const secret = 'nvapi-unit-test-not-a-real-key-000000';
  const env = { ...fixture(t), NVIDIA_API_KEY: secret, OAI_TRACE: '1' };
  env.OAI_TRACE_DIR = join(env.OPENAI_WORKER_USAGE_DIR, 'trace');
  const fetchFn = scriptedFetch([
    ({ signal }) => streamResponse([sse([delta({ reasoning_content: 'Thinking' }), delta({ content: 'Echo: ' + secret }, 'stop'), '[DONE]'])], signal),
    () => jsonResponse(401, { error: { message: `bad key ${secret}` } }),
  ]);
  const chat = createChat({ fetchFn, throttleMs: 0 });
  const nv = { worker_type: 'nemo3-5lightning', model: 'nvidia/nemotron-3.5-lightning-30b-a3b', instructions: 'x', tools: [], effort: 'none', max_output_tokens: 4000 };
  const r = await settle(chat, (await chat.create({ ...nv, input: 'hi' }, { env })).id, { env });
  const req = fetchFn.requests[0];
  assert.equal(req.url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(req.headers.Authorization, `Bearer ${secret}`);
  assert.deepEqual(req.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(req.body.max_tokens, 4000);
  assert.equal(r.estimatedUsd, 0);
  const failed = await settle(chat, (await chat.create({ ...nv, input: 'again' }, { env })).id, { env });
  assert.match(failed.reason, /NVIDIA HTTP 401/);
  assert.ok(!failed.reason.includes(secret));
  for (const file of readdirSync(convo.convoDir(env))) assert.ok(!readFileSync(join(convo.convoDir(env), file), 'utf8').includes(secret));
  for (const file of readdirSync(env.OAI_TRACE_DIR)) assert.ok(!readFileSync(join(env.OAI_TRACE_DIR, file), 'utf8').includes(secret));
  // Mistral effort mapping
  const m = scriptedFetch([({ signal }) => streamResponse([sse([delta({ content: 'ok' }, 'stop'), '[DONE]'])], signal)]);
  const mc = createChat({ fetchFn: m, throttleMs: 0 });
  await settle(mc, (await mc.create({ worker_type: 'mistral4large', model: 'mistralai/mistral-large-4-1t-a52b', instructions: 'x', tools: [], effort: 'max', input: 'hi' }, { env })).id, { env });
  assert.equal(m.requests[0].body.reasoning_effort, 'high');
});

test('transport: sprocket0-5 never receives tools', async t => {
  const env = fixture(t);
  const fetchFn = scriptedFetch([({ signal }) => streamResponse([sse([delta({ content: 'hi' }, 'stop'), '[DONE]'])], signal)]);
  const chat = createChat({ fetchFn, throttleMs: 0 });
  await settle(chat, (await chat.create({ worker_type: 'sprocket0-5', model: 'kandivault/sprocket-500m/sprocket-500m-chat-q4_k_m.gguf', instructions: 'x', tools: OPENAI_TOOLS, input: 'hi' }, { env })).id, { env });
  assert.equal(fetchFn.requests[0].body.tools, undefined);
});
