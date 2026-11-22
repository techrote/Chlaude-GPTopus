import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as convo from '../bridge/convo.mjs';

const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'oai-convo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { OPENAI_WORKER_USAGE_DIR: dir };
};
const call = (id, name = 'Read', args = '{"file_path":"/a"}') => ({ id, type: 'function', function: { name, arguments: args } });

test('convo: create, append, list, rev bump and turn ids', t => {
  const env = fixture(t);
  const c = convo.createConvo({ worker: 'lfm2-5mini', provider: 'lmstudio', model: 'm', system: 'be brief' }, env);
  assert.match(c.id, convo.CONVO_ID);
  assert.equal(c.rev, 0);
  assert.equal(c.messages[0].role, 'system');
  assert.equal(convo.convoDir(env), join(env.OPENAI_WORKER_USAGE_DIR, 'conversations'));
  const a = convo.append(c.id, [{ role: 'user', content: 'hi' }], env, { status: 'running' });
  assert.equal(a.rev, 1);
  assert.equal(a.status, 'running');
  assert.deepEqual(a.messages.map(m => [m.i, m.role]), [[0, 'system'], [1, 'user']]);
  const p = convo.patch(c.id, { pending: { reasoning: 'thinking' } }, env);
  assert.equal(p.rev, 1, 'live previews never bump rev');
  assert.equal(convo.get(c.id, env).pending.reasoning, 'thinking');
  const turn = convo.turnIdFor(c.id, 1);
  assert.deepEqual(convo.parseTurnId(turn), { convId: c.id, rev: 1 });
  assert.equal(convo.parseTurnId('resp_abc'), null);
  assert.equal(convo.parseTurnId(`chat_${c.id}_1/../x`), null);
  const listed = convo.list(env);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].messages, 2);
  assert.equal(listed[0].live, true);
  assert.throws(() => convo.get('../../etc', env), /Invalid conversation id/);
  // atomic writes leave no temp or lock files behind
  assert.deepEqual(readdirSync(convo.convoDir(env)), [`${c.id}.json`]);
});

test('convo: edit, delete, insert and truncate mark edits and bump rev', t => {
  const env = fixture(t);
  const c = convo.createConvo({ worker: 'w', system: 'sys' }, env);
  convo.append(c.id, [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two', reasoning: 'r2' }, { role: 'user', content: 'three' }], env);
  let s = convo.editMessage(c.id, 2, { content: 'TWO', reasoning: 'better thought' }, env);
  assert.equal(s.messages[2].content, 'TWO');
  assert.equal(s.messages[2].reasoning, 'better thought');
  assert.equal(s.messages[2].edited, true);
  assert.equal(s.rev, 2);
  assert.throws(() => convo.editMessage(c.id, 2, { content: 'x', expectRev: 1 }, env), /changed since/);
  s = convo.insertMessage(c.id, 1, { role: 'user', content: 'inserted' }, env);
  assert.deepEqual(s.messages.map(m => m.content), ['sys', 'one', 'inserted', 'TWO', 'three']);
  assert.deepEqual(s.messages.map(m => m.i), [0, 1, 2, 3, 4]);
  assert.equal(s.messages[2].edited, true);
  assert.throws(() => convo.insertMessage(c.id, 1, { role: 'tool', content: 'x' }, env), /Only system, user or assistant/);
  s = convo.deleteMessage(c.id, 2, {}, env);
  assert.deepEqual(s.messages.map(m => m.content), ['sys', 'one', 'TWO', 'three']);
  s = convo.truncateAfter(c.id, 1, {}, env);
  assert.deepEqual(s.messages.map(m => m.content), ['sys', 'one']);
  assert.equal(s.rev, 5, 'a refused edit does not bump rev');
  assert.throws(() => convo.deleteMessage(c.id, 9, {}, env), /out of range/);
});

test('convo: tool call / result pairing is protected', t => {
  const env = fixture(t);
  const c = convo.createConvo({ worker: 'w', system: 'sys' }, env);
  convo.append(c.id, [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [call('c1'), call('c2')] },
    { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    { role: 'tool', tool_call_id: 'c2', content: 'r2' },
    { role: 'user', content: 'next' },
  ], env);
  assert.throws(() => convo.insertMessage(c.id, 2, { role: 'user', content: 'between' }, env), /between a tool call/);
  assert.throws(() => convo.insertMessage(c.id, 3, { role: 'user', content: 'between' }, env), /between a tool call/);
  assert.throws(() => convo.truncateAfter(c.id, 2, {}, env), /separate tool calls/);
  assert.throws(() => convo.truncateAfter(c.id, 3, {}, env), /separate tool calls/);
  // after the last result is fine
  convo.insertMessage(c.id, 4, { role: 'user', content: 'after results' }, env);
  // deleting one result deletes the whole group
  const s = convo.deleteMessage(c.id, 3, {}, env);
  assert.deepEqual(s.messages.map(m => m.role), ['system', 'user', 'user', 'user']);
  assert.ok(!s.messages.some(m => m.tool_calls || m.role === 'tool'));
});

test('convo: size bound trims the oldest non-system messages with a marker', t => {
  // values below the 64 KB floor are raised to it
  const env = { ...fixture(t), OAI_CONVO_MAX_BYTES: '6000' };
  assert.equal(convo.maxConvoBytes(env), convo.MIN_CONVO_BYTES);
  const c = convo.createConvo({ worker: 'w', system: 'sys' }, env);
  for (let n = 0; n < 12; n++) convo.append(c.id, [{ role: 'user', content: `msg${n} ${'x'.repeat(9000)}` }], env);
  const s = convo.get(c.id, env);
  assert.ok(Buffer.byteLength(JSON.stringify(s.messages)) <= convo.MIN_CONVO_BYTES);
  assert.equal(s.messages[0].role, 'system');
  assert.match(s.messages[1].content, /Earlier conversation trimmed by the bridge: \d+ messages/);
  assert.ok(s.messages.at(-1).content.startsWith('msg11'), 'the newest message is kept');
  assert.deepEqual(s.messages.map(m => m.i), s.messages.map((_, i) => i));
  // a tool group is trimmed as a whole, never leaving an orphan tool result first
  const g = convo.createConvo({ worker: 'w', system: 'sys' }, env);
  convo.append(g.id, [{ role: 'assistant', content: '', tool_calls: [call('k1')] }, { role: 'tool', tool_call_id: 'k1', content: 'y'.repeat(25000) }], env);
  for (let n = 0; n < 4; n++) convo.append(g.id, [{ role: 'user', content: `u${n} ${'z'.repeat(12000)}` }], env);
  const gs = convo.get(g.id, env);
  assert.ok(!gs.messages.some(m => m.role === 'tool'));
  assert.ok(!gs.messages.some(m => m.tool_calls));
});

test('convo: API keys are redacted on write', t => {
  const env = { ...fixture(t), NVIDIA_API_KEY: 'nvapi-unit-test-secret-value-123456' };
  const c = convo.createConvo({ worker: 'w', system: 'sys' }, env);
  convo.append(c.id, [{ role: 'user', content: 'my key is nvapi-unit-test-secret-value-123456 and sk-abcdefghijklmnopqrstuvwxyz' }], env);
  const raw = readFileSync(join(convo.convoDir(env), `${c.id}.json`), 'utf8');
  assert.ok(!raw.includes('nvapi-unit-test-secret-value-123456'));
  assert.ok(!raw.includes('sk-abcdefghijklmnopqrstuvwxyz'));
  assert.match(raw, /\[redacted\]/);
});
