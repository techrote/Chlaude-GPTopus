import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { rotationPolicy, rotationPool, chooseModel, acquireLease, nvidiaUsagePath, rotationSnapshot } from '../bridge/rotation.mjs';
import { utcDay } from '../bridge/usage.mjs';
import { createChat } from '../bridge/chat.mjs';
import { settle, scriptedFetch, streamResponse, sse, delta } from './support/fake-chat.mjs';

const fixture = (t, extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'oai-rot-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { OPENAI_WORKER_USAGE_DIR: dir, ...extra };
};
const KIMI = 'moonshotai/kimi-k3.1-pro', MISTRAL = 'mistralai/mistral-large-4-1t-a52b';
const NEMO_SUPER = 'nvidia/nemotron-3.5-super-vl-120b-a12b', NEMO_LIGHT = 'nvidia/nemotron-3.5-lightning-30b-a3b';
const seed = (env, days, leases = {}) => {
  mkdirSync(dirname(nvidiaUsagePath(env)), { recursive: true });
  writeFileSync(nvidiaUsagePath(env), JSON.stringify({ version: 1, days, leases }));
};

test('rotation policy defaults and pool', () => {
  assert.deepEqual(rotationPolicy({}), { concurrency: 1, hoursPerDay: 16, rotate: false, rotateHours: 9, budgetSeconds: 16 * 3600 });
  assert.equal(rotationPolicy({ OAI_NVIDIA_ROTATE: '1' }).budgetSeconds, 9 * 3600);
  assert.equal(rotationPolicy({ OAI_NVIDIA_CONCURRENCY: '3' }).concurrency, 3);
  assert.equal(rotationPolicy({ OAI_NVIDIA_CONCURRENCY: '99' }).concurrency, 1, 'out-of-range values fall back');
  assert.deepEqual(rotationPool({}), [KIMI, MISTRAL, NEMO_SUPER, NEMO_LIGHT]);
  assert.deepEqual(rotationPool({ OPENAI_WORKER_KIMIK3_1PRO_MODEL: 'moonshotai/kimi-next' })[0], 'moonshotai/kimi-next');
});

test('concurrency cap: a second stream on the same model waits for the first lease', async t => {
  const env = fixture(t);
  const a = await acquireLease(KIMI, env);
  let bGot = false;
  const bPromise = acquireLease(KIMI, env, { pollMs: 10 }).then(lease => { bGot = true; return lease; });
  const other = await acquireLease(MISTRAL, env); // other models are independent
  await new Promise(r => setTimeout(r, 60));
  assert.equal(bGot, false);
  assert.equal(rotationSnapshot(env).models[KIMI].inflight, 1);
  a.release();
  const b = await bPromise;
  assert.equal(bGot, true);
  b.release(); other.release();
  // cap 2 admits two at once
  const env2 = { ...env, OAI_NVIDIA_CONCURRENCY: '2' };
  const x = await acquireLease(KIMI, env2), y = await acquireLease(KIMI, env2);
  x.release(); y.release();
  // a waiting request can be cancelled
  const held = await acquireLease(KIMI, env);
  const ctl = new AbortController();
  const waiting = acquireLease(KIMI, env, { pollMs: 10, signal: ctl.signal });
  ctl.abort();
  await assert.rejects(waiting, /Cancelled while waiting/);
  held.release();
});

test('stale leases from dead processes or expired heartbeats are dropped', async t => {
  const env = fixture(t);
  seed(env, {}, { ghost: { model: KIMI, pid: 2147483646, startedAt: 0, accruedTo: 0, expires: Date.now() + 60_000 },
    old: { model: KIMI, pid: process.pid, startedAt: 0, accruedTo: 0, expires: Date.now() - 1 } });
  const lease = await acquireLease(KIMI, env, { pollMs: 10 });
  const state = JSON.parse(readFileSync(nvidiaUsagePath(env), 'utf8'));
  assert.deepEqual(Object.keys(state.leases), [lease.id]);
  lease.release();
});

test('active hours accrue per model per UTC day', async t => {
  const env = fixture(t);
  let clock = Date.parse('2026-11-22T10:00:00Z');
  const lease = await acquireLease(NEMO_LIGHT, env, { now: () => clock });
  clock += 1800_000; lease.heartbeat();
  clock += 1800_000; lease.release();
  lease.release(); // idempotent
  const state = JSON.parse(readFileSync(nvidiaUsagePath(env), 'utf8'));
  assert.equal(Math.round(state.days['2026-11-22'][NEMO_LIGHT]), 3600);
  assert.deepEqual(state.leases, {});
});

test('over budget: failure without rotation, substitution of the least-used model with rotation', async t => {
  const env = fixture(t);
  const day = utcDay();
  seed(env, { [day]: { [KIMI]: 16 * 3600, [MISTRAL]: 3 * 3600, [NEMO_SUPER]: 1 * 3600, [NEMO_LIGHT]: 2 * 3600 } });
  assert.deepEqual(chooseModel(MISTRAL, env), { model: MISTRAL });
  assert.throws(() => chooseModel(KIMI, env), /used its 16\.0 h active budget.*OAI_NVIDIA_ROTATE=1/);
  const rot = { ...env, OAI_NVIDIA_ROTATE: '1' };
  assert.deepEqual(chooseModel(KIMI, rot), { model: NEMO_SUPER, substitutedFrom: KIMI });
  seed(env, { [day]: { [KIMI]: 10 * 3600, [MISTRAL]: 10 * 3600, [NEMO_SUPER]: 10 * 3600, [NEMO_LIGHT]: 10 * 3600 } });
  assert.throws(() => chooseModel(KIMI, rot), /Every NVIDIA model in the rotation pool/);
  assert.deepEqual(chooseModel(KIMI, env), { model: KIMI }, '10 h is under the 16 h non-rotating budget');
});

test('transport: rotation substitutes the model in the request and response; over budget fails clearly', async t => {
  const env = fixture(t, { NVIDIA_API_KEY: 'nvapi-unit-test-not-a-real-key-222222', OAI_NVIDIA_ROTATE: '1' });
  seed(env, { [utcDay()]: { [KIMI]: 9 * 3600, [MISTRAL]: 9 * 3600, [NEMO_SUPER]: 1 } });
  const fetchFn = scriptedFetch([({ signal }) => streamResponse([sse([delta({ content: 'hello' }, 'stop'), '[DONE]'])], signal)]);
  const chat = createChat({ fetchFn, throttleMs: 0 });
  const args = { worker_type: 'kimik3-1pro', model: KIMI, instructions: 'x', tools: [], input: 'hi' };
  const started = await chat.create(args, { env });
  assert.equal(started.substitutedFrom, KIMI);
  const r = await settle(chat, started.id, { env });
  assert.equal(r.status, 'completed');
  assert.equal(r.substitutedFrom, KIMI);
  assert.equal(fetchFn.requests[0].body.model, NEMO_LIGHT);
  const noRotate = { ...env, OAI_NVIDIA_ROTATE: '0', OAI_NVIDIA_HOURS_PER_DAY: '8' };
  const failed = await chat.create(args, { env: noRotate });
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /active budget/);
  assert.equal((await chat.poll(failed.id, { env: noRotate })).status, 'failed');
  assert.equal(fetchFn.requests.length, 1, 'no request is sent when over budget');
  // missing key: failed before any request
  const nokey = await chat.create(args, { env: { OPENAI_WORKER_USAGE_DIR: env.OPENAI_WORKER_USAGE_DIR } });
  assert.equal(nokey.status, 'failed');
  assert.match(nokey.reason, /Missing NVIDIA API key/);
});
