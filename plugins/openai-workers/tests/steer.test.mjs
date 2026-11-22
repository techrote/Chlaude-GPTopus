import './support/isolate.mjs';
import { testRoot } from './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as steer from '../bridge/steer.mjs';
import { dispatch } from '../bridge/server.mjs';
import { withSteering, steerReply } from '../hooks/register.js';
import { encodeFrame, decodeFrames, acceptKey } from '../scripts/oai-ws.mjs';
import { handleConsoleMessage, readMacros } from '../scripts/oai-config.mjs';

let n = 0;
const fresh = () => ({ OAI_STEER_DIR: join(testRoot, `steer-${++n}`), OAI_STEER_PAUSE_SECONDS: '0.3' });
const WORKERS = ['terra5-6free', 'sol6-2'];

test('parseSteer: target, prefix flags and verbatim text', () => {
  assert.deepEqual(steer.parseSteer('T3 !+ ?ack ?conseq use smaller edits', WORKERS),
    { target: 'T3', text: 'use smaller edits', hard: true, pin: true, ack: true, assess: false, conseq: true });
  assert.equal(steer.parseSteer('terra5-6free hello', WORKERS).target, 'terra5-6free');
  assert.equal(steer.parseSteer('* stop', WORKERS).target, '*');
  const plain = steer.parseSteer('Please keep  "spacing" !', WORKERS);
  assert.equal(plain.target, ''); assert.equal(plain.text, 'Please keep  "spacing" !'); assert.equal(plain.hard, false);
});

test('runs get callsigns; targets resolve by callsign, worker (newest) and *', () => {
  const env = fresh();
  const a = steer.upsertRun('ag_a', { worker: 'terra5-6free', status: 'running' }, env);
  const b = steer.upsertRun('ag_b', { worker: 'sol6-2', status: 'running' }, env);
  assert.equal(a.callsign, 'T1'); assert.equal(b.callsign, 'S2');
  const runs = steer.listRuns(env);
  assert.deepEqual(steer.resolveTarget('t1', runs).map(r => r.agentId), ['ag_a']);
  assert.deepEqual(steer.resolveTarget('sol6-2', runs).map(r => r.agentId), ['ag_b']);
  assert.equal(steer.resolveTarget('*', runs).length, 2);
  assert.equal(steer.resolveTarget('', runs).length, 0, 'ambiguous without a target');
  steer.upsertRun('ag_b', { status: 'ended' }, env);
  assert.deepEqual(steer.resolveTarget('', steer.listRuns(env)).map(r => r.agentId), ['ag_a'], 'the only live run');
});

test('tips queue, deliver once with flags, pins persist, log records it', () => {
  const env = fresh();
  steer.upsertRun('ag_1', { worker: 'terra5-6free' }, env);
  steer.enqueueTip('ag_1', { text: 'avoid rewriting the file', pin: true, assess: true }, env);
  assert.equal(steer.hasHardTip('ag_1', env), false);
  steer.enqueueTip('ag_1', { text: 'stop now', hard: true }, env);
  assert.equal(steer.hasHardTip('ag_1', env), true);
  const got = steer.takeTips('ag_1', 4, env);
  assert.equal(got.length, 2);
  assert.equal(steer.takeTips('ag_1', 5, env).length, 0, 'delivered exactly once');
  const msg = steer.tipMessage(got[0]);
  assert.match(msg, /avoid rewriting the file/); assert.match(msg, /how you understood/); assert.doesNotMatch(msg, /acknowledg/);
  assert.match(steer.pinnedMessage(steer.getRun('ag_1', env).pinned), /avoid rewriting the file/);
  const kinds = steer.readLog(env).map(e => e.kind);
  assert.deepEqual(kinds, ['sent', 'sent', 'delivered', 'delivered']);
});

test('pause waits for a tip and returns early', async () => {
  const env = fresh();
  steer.upsertRun('ag_p', { worker: 'sol6-2' }, env);
  const t0 = Date.now();
  assert.equal(await steer.waitForTip('ag_p', 300, env), false);
  assert.ok(Date.now() - t0 >= 250);
  setTimeout(() => steer.enqueueTip('ag_p', { text: 'go' }, env), 50);
  const t1 = Date.now();
  assert.equal(await steer.waitForTip('ag_p', 5000, env), true);
  assert.ok(Date.now() - t1 < 2000);
});

test('bridge steer op: reserve, sync delivers, send resolves, wait honours pause tools', async () => {
  const env = fresh();
  const { callsign } = await dispatch('steer', { op: 'reserve', worker: 'terra5-6free' }, { env });
  await dispatch('steer', { op: 'sync', agentId: 'ag_x', worker: 'terra5-6free', callsign, step: 0 }, { env });
  const sent = await dispatch('steer', { op: 'send', args: `${callsign} ?ack prefer tests first`, workers: WORKERS }, { env });
  assert.equal(sent.sent[0].callsign, callsign); assert.equal(sent.parsed.ack, true);
  const synced = await dispatch('steer', { op: 'sync', agentId: 'ag_x', worker: 'terra5-6free', step: 3 }, { env });
  assert.equal(synced.tips.length, 1); assert.match(synced.tips[0].message, /prefer tests first/);
  assert.deepEqual(await dispatch('steer', { op: 'wait', agentId: 'ag_x', tools: ['Read'] }, { env }), { waited: false });
  assert.equal((await dispatch('steer', { op: 'wait', agentId: 'ag_x', tools: ['Edit'] }, { env })).waited, true);
  assert.match((await dispatch('steer', { op: 'send', args: 'nobody here', workers: WORKERS }, { env: fresh() })).error, /No OpenAI worker/);
});

test('mod helpers: tips are appended verbatim; reply text lists runs', () => {
  assert.equal(withSteering('task', ['tip A']), 'task\n\ntip A');
  assert.deepEqual(withSteering([{ type: 'function_call_output' }], ['tip', '']), [{ type: 'function_call_output' }, { role: 'user', content: 'tip' }]);
  assert.equal(withSteering('same', []), 'same');
  assert.match(steerReply({ usage: true, runs: [{ callsign: 'T1', worker: 'terra5-6free', step: 2, status: 'running' }] }), /T1 +terra5-6free/);
  assert.match(steerReply({ sent: [{ callsign: 'T1', worker: 'terra5-6free', step: 2 }], parsed: { hard: true } }), /Tip queued \[hard\] for T1/);
});

test('websocket: accept key, server frames, masked client frames, size bound', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  const big = 'x'.repeat(70000);
  assert.equal(encodeFrame(big)[1], 127);
  const mask = Buffer.from([1, 2, 3, 4]), body = Buffer.from('{"type":"hello"}');
  const masked = Buffer.from(body.map((b, i) => b ^ mask[i & 3]));
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
  const { frames, rest } = decodeFrames(Buffer.concat([frame, frame.subarray(0, 3)]));
  assert.equal(frames.length, 1); assert.equal(frames[0].data.toString(), '{"type":"hello"}'); assert.equal(rest.length, 3);
  assert.throws(() => decodeFrames(Buffer.from([0x81, 0x05, 1, 2, 3, 4, 5])), /masked/);
  assert.throws(() => decodeFrames(Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0x10, 0, 0])), /too large/);
  void createHash;
});

test('console: tips go only to live runs; macros are 1..8.txt', () => {
  const env = fresh();
  steer.upsertRun('ag_c', { worker: 'sol6-2', status: 'running' }, env);
  assert.equal(handleConsoleMessage({ type: 'tip', target: 'ag_c', text: 'hi', ack: true }, env).type, 'sent');
  assert.equal(handleConsoleMessage({ type: 'tip', target: 'ag_missing', text: 'hi' }, env).type, 'error');
  assert.equal(handleConsoleMessage({ type: 'tip', target: '*', text: '  ' }, env).type, 'error');
  assert.equal(steer.pendingTips('ag_c', env)[0].ack, true);
  const m = readMacros(join(testRoot, 'cfg-state'));
  assert.deepEqual(m.items.map(x => x.n), [1, 2, 3, 4, 5, 6, 7, 8]);
});
