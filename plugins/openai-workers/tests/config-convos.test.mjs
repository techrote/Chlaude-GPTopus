import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as convo from '../bridge/convo.mjs';
import * as steer from '../bridge/steer.mjs';
import {
  handleConvoMessage, handleConsoleMessage, convosSnapshot, convoDelta, convoSeen, convoStamp, convoMtime, CONVO_TYPES, createConfigServer,
} from '../scripts/oai-config.mjs';
import { memoryStore, newToken } from '../scripts/oai-config-core.mjs';

const fixture = t => {
  const dir = mkdtempSync(join(tmpdir(), 'oai-cfg-convo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { OPENAI_WORKER_USAGE_DIR: dir };
};
const call = (id, name = 'Read') => ({ id, type: 'function', function: { name, arguments: '{"file_path":"/a"}' } });
function seed(env, { agentId = 'ag_conv1', status = 'running' } = {}) {
  const c = convo.createConvo({ worker: 'lfm3heretic', provider: 'lmstudio', model: 'lfm3-1.7b', agentId, system: 'sys' }, env);
  return convo.append(c.id, [
    { role: 'user', content: 'find 4711' },
    { role: 'assistant', content: '', reasoning: 'I should read', tool_calls: [call('t1')] },
    { role: 'tool', tool_call_id: 't1', content: '4711' },
    { role: 'assistant', content: 'It is 4711.', reasoning: 'found it' },
  ], env, { status });
}

test('config convos: list snapshot joins the steer callsign; full view; bad ids are errors', t => {
  const env = fixture(t);
  const c = seed(env);
  steer.upsertRun('ag_conv1', { worker: 'lfm3heretic', status: 'running' }, env);
  const snap = handleConvoMessage({ type: 'convos' }, env);
  assert.equal(snap.type, 'convos');
  assert.equal(snap.items.length, 1);
  assert.equal(snap.items[0].id, c.id);
  assert.match(snap.items[0].callsign, /^L\d+$/);
  assert.equal(snap.items[0].messages, 5);
  assert.equal(snap.dir, convo.convoDir(env));
  assert.deepEqual(convosSnapshot(env).items, snap.items);
  const view = handleConvoMessage({ type: 'convo', id: c.id }, env);
  assert.equal(view.type, 'convo');
  assert.equal(view.convo.messages.length, 5);
  assert.equal(view.convo.messages[2].reasoning, 'I should read');
  assert.equal(view.convo.callsign, snap.items[0].callsign);
  assert.deepEqual(handleConvoMessage({ type: 'convo', id: null }, env), { type: 'convo', convo: null });
  assert.equal(handleConvoMessage({ type: 'convo', id: 'c0000000000000000' }, env).error, 'Conversation not found.');
  const bad = handleConvoMessage({ type: 'convo', id: '../../etc/passwd' }, env);
  assert.equal(bad.type, 'error'); assert.equal(bad.scope, 'convo'); assert.match(bad.error, /Invalid conversation id/);
  assert.equal(handleConvoMessage({ type: 'nope' }, env).type, 'error');
  for (const k of ['convos', 'convo', 'convo-edit', 'thought-steer']) assert.ok(CONVO_TYPES.has(k));
});

test('config convos: edit / insert / delete / truncate through the hub, with rev checks and tool pairing', t => {
  const env = fixture(t);
  let c = seed(env);
  const edit = (op, i, extra = {}) => handleConvoMessage({ type: 'convo-edit', id: c.id, op, i, expectRev: c.rev, ...extra }, env);
  let r = edit('edit', 4, { content: 'It is 4712.', reasoning: 'checked twice' });
  assert.equal(r.type, 'convo'); assert.equal(r.op, 'edit');
  assert.equal(r.convo.rev, c.rev + 1);
  assert.equal(r.convo.messages[4].content, 'It is 4712.');
  assert.equal(r.convo.messages[4].reasoning, 'checked twice');
  assert.equal(r.convo.messages[4].edited, true);
  // stale expectRev is refused
  const stale = edit('edit', 4, { content: 'x' });
  assert.equal(stale.type, 'error'); assert.match(stale.error, /changed since/);
  c = r.convo;
  // non-string content is not coerced into an edit; nothing to edit is an error
  assert.match(edit('edit', 1, { content: 5 }).error, /Nothing to edit/);
  assert.match(edit('edit', 1.5, { content: 'a' }).error, /whole number/);
  // insert between a tool call and its result is refused; after the user message works
  assert.match(edit('insert', 2, { role: 'user', content: 'x' }).error, /tool call/);
  assert.match(edit('insert', 1, { role: 'tool', content: 'x' }).error, /Only system, user or assistant/);
  r = edit('insert', 1, { role: 'user', content: 'also check /b' });
  assert.equal(r.convo.messages[2].content, 'also check /b'); assert.equal(r.convo.messages[2].role, 'user');
  c = r.convo;
  // truncating inside the tool group is refused; deleting the tool result removes the whole group
  assert.match(edit('truncate', 3).error, /separate tool calls/);
  r = edit('delete', 4);
  assert.deepEqual(r.convo.messages.map(m => m.role), ['system', 'user', 'user', 'assistant']);
  c = r.convo;
  r = edit('truncate', 1);
  assert.deepEqual(r.convo.messages.map(m => m.role), ['system', 'user']);
  c = r.convo;
  assert.equal(edit('frobnicate', 0).error, 'Unknown edit operation.');
  assert.equal(convo.get(c.id, env).messages.length, 2, 'the store holds what the hub returned');
});

test('config convos: thought-steer queues a thought:true tip for the conversation run', t => {
  const env = fixture(t);
  const c = seed(env);
  steer.upsertRun('ag_conv1', { worker: 'lfm3heretic', status: 'running' }, env);
  convo.patch(c.id, { pending: { phase: 'reasoning', reasoning: 'hmm' } }, env);
  const r = handleConvoMessage({ type: 'thought-steer', id: c.id, text: '  consider file /b too  ' }, env);
  assert.equal(r.type, 'thought-sent');
  assert.equal(r.midReasoning, true);
  const tips = steer.pendingTips('ag_conv1', env);
  assert.equal(tips.length, 1);
  assert.equal(tips[0].text, 'consider file /b too');
  assert.equal(tips[0].thought, true);
  assert.equal(tips[0].from, 'panel');
  assert.equal(handleConvoMessage({ type: 'thought-steer', id: c.id, text: '   ' }, env).error, 'Empty thought-steer.');
  // no agent id, or the run ended and nothing is streaming: refused
  const orphan = convo.createConvo({ worker: 'lfm3vl', provider: 'lmstudio', model: 'm' }, env);
  assert.match(handleConvoMessage({ type: 'thought-steer', id: orphan.id, text: 'x' }, env).error, /no steerable run/);
  convo.patch(c.id, { pending: undefined, status: 'completed' }, env);
  steer.upsertRun('ag_conv1', { status: 'ended' }, env);
  assert.match(handleConvoMessage({ type: 'thought-steer', id: c.id, text: 'x' }, env).error, /no longer running/);
  // the console path carries the flag too
  steer.upsertRun('ag_conv1', { status: 'running' }, env);
  assert.equal(handleConsoleMessage({ type: 'tip', target: 'ag_conv1', text: 'via console', thought: true }, env).type, 'sent');
  assert.equal(steer.pendingTips('ag_conv1', env).at(-1).thought, true);
});

test('config convos: delta sends only the live part while rev is unchanged; stamps track file changes', t => {
  const env = fixture(t);
  const c = seed(env);
  const seen = convoSeen(c);
  const live = convo.patch(c.id, { pending: { phase: 'reasoning', reasoning: 'abc' } }, env);
  assert.deepEqual(convoDelta(seen, live), { type: 'convo-live', id: c.id, rev: c.rev, status: 'running', updatedAt: live.updatedAt, pending: { phase: 'reasoning', reasoning: 'abc' } });
  const edited = convo.editMessage(c.id, 1, { content: 'changed' }, env);
  assert.equal(convoDelta(seen, edited), null, 'history changed: send the full view');
  assert.equal(convoDelta(null, edited), null);
  assert.deepEqual(convoDelta(seen, null), { type: 'convo', convo: null, gone: true });
  assert.equal(convoSeen(null), null);
  const s1 = convoStamp(env);
  assert.match(s1, new RegExp(`${c.id}\\.json:`));
  assert.equal(typeof convoMtime(c.id, env), 'number');
  assert.equal(convoMtime('../x', env), null);
  assert.equal(convoStamp({ OPENAI_WORKER_USAGE_DIR: join(env.OPENAI_WORKER_USAGE_DIR, 'none') }), '');
});

/** A tiny masked-frame WebSocket client over a raw upgrade (no dependencies). */
function wsClient(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/ws?t=${token}`, headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), origin: `http://127.0.0.1:${port}` } });
    req.on('error', reject);
    req.on('upgrade', (res, socket) => {
      const inbox = [], waiters = [];
      let buf = Buffer.alloc(0);
      socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) break;
          let len = buf[1] & 0x7f, p = 2;
          if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); p = 4; }
          else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); p = 10; }
          if (buf.length < p + len) break;
          const op = buf[0] & 0x0f, text = buf.subarray(p, p + len).toString('utf8');
          buf = buf.subarray(p + len);
          if (op !== 1) continue;
          const msg = JSON.parse(text);
          const w = waiters.findIndex(x => x.pred(msg));
          if (w >= 0) waiters.splice(w, 1)[0].resolve(msg); else inbox.push(msg);
        }
      });
      resolve({
        send(obj) {
          const payload = Buffer.from(JSON.stringify(obj)), mask = randomBytes(4), n = payload.length;
          const head = n < 126 ? Buffer.from([0x81, 0x80 | n]) : Buffer.from([0x81, 0x80 | 126, n >> 8, n & 255]);
          const body = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
          socket.write(Buffer.concat([head, mask, body]));
        },
        next(pred, ms = 5000) {
          const i = inbox.findIndex(pred);
          if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
          return new Promise((res2, rej) => { const w = { pred, resolve: res2 }; waiters.push(w); setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); rej(new Error('timed out waiting for a frame')); } }, ms); });
        },
        close() { socket.destroy(); },
      });
    });
    req.end();
  });
}

test('config convos: the WebSocket hub lists, opens, edits and pushes live reasoning', async t => {
  const env = fixture(t);
  const store = memoryStore({ OPENAI_WORKER_USAGE_DIR: env.OPENAI_WORKER_USAGE_DIR }), token = newToken();
  const c = seed(env);
  steer.upsertRun('ag_conv1', { worker: 'lfm3heretic', status: 'running' }, env);
  const { server } = createConfigServer({ store, stateDir: env.OPENAI_WORKER_USAGE_DIR, token, env: {}, usage: async () => ({ fake: true }), page: '<html>__NONCE__</html>' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const ws = await wsClient(server.address().port, token);
  t.after(() => { ws.close(); server.close(); });
  const list = await ws.next(m => m.type === 'convos');
  assert.equal(list.items[0].id, c.id);
  ws.send({ type: 'convo', id: c.id });
  const view = await ws.next(m => m.type === 'convo');
  assert.equal(view.convo.rev, c.rev);
  // a streaming preview (no rev bump) reaches the viewer as convo-live
  convo.patch(c.id, { pending: { phase: 'reasoning', reasoning: 'step one…' } }, env);
  const live = await ws.next(m => m.type === 'convo-live');
  assert.equal(live.pending.reasoning, 'step one…');
  assert.equal(live.rev, c.rev);
  // an operator edit returns the full view and is visible in the store
  ws.send({ type: 'convo-edit', id: c.id, op: 'edit', i: 1, content: 'find 4712', expectRev: c.rev });
  const edited = await ws.next(m => m.type === 'convo' && m.op === 'edit');
  assert.equal(edited.convo.messages[1].content, 'find 4712');
  assert.equal(convo.get(c.id, env).messages[1].content, 'find 4712');
  // the bridge appending a message (rev bump) pushes a full view to the viewer
  convo.append(c.id, [{ role: 'user', content: 'next' }], env);
  const pushed = await ws.next(m => m.type === 'convo' && !m.op && m.convo?.messages.length === 6);
  assert.equal(pushed.convo.messages[5].content, 'next');
  ws.send({ type: 'thought-steer', id: c.id, text: 'look at /b' });
  assert.equal((await ws.next(m => m.type === 'thought-sent')).id, c.id);
  assert.equal(steer.pendingTips('ag_conv1', env)[0].thought, true);
  // no key value ever appears in what the panel sends
  assert.doesNotMatch(readFileSync(join(convo.convoDir(env), `${c.id}.json`), 'utf8'), /nvapi-|sk-/);
});
