import './support/isolate.mjs';
import { testRoot } from './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as direct from '../bridge/direct-run.mjs';
import { directReply } from '../hooks/direct-reply.js';
import { isPrivateBridgeTool } from '../hooks/ultra.js';

const WORKERS = ['luna6flex', 'lfm3heretic'];
let n = 0;
const fresh = () => ({ OPENAI_WORKER_USAGE_DIR: join(testRoot, `direct-${++n}`) });

test('parseRun: worker, optional effort, verbatim task', () => {
  assert.deepEqual(direct.parseRun('luna6flex max decode  this', WORKERS), { worker: 'luna6flex', effort: 'max', task: 'decode  this' });
  assert.deepEqual(direct.parseRun('lfm3heretic hello there', WORKERS), { worker: 'lfm3heretic', effort: undefined, task: 'hello there' });
  assert.match(direct.parseRun('nobody hi', WORKERS).error, /Unknown worker/);
  assert.equal(direct.parseRun('luna6flex max', WORKERS).error, 'Empty task.');
});

test('attachFiles: @path appends file text; missing files are noted', () => {
  const dir = join(testRoot, 'attach'); mkdirSync(dir, { recursive: true });
  const f = join(dir, 'a.md'); writeFileSync(f, 'SECRET-ISH CONTENT');
  const { text, notes } = direct.attachFiles(`read @${f} and @${join(dir, 'missing.md')}`);
  assert.match(text, /----- file: .*a\.md -----\nSECRET-ISH CONTENT/);
  assert.equal(notes.length, 1); assert.match(notes[0], /not attached/);
});

test('startDirect: runs create + poll in the background and stores the result', async () => {
  const env = fresh(), calls = [];
  const call = async (name, args) => {
    calls.push([name, args]);
    return name === 'create' ? { id: 'r1', status: 'in_progress' } : { id: 'r1', status: 'completed', text: 'decoded!' };
  };
  const rec = direct.startDirect({ worker: 'lfm3heretic', task: 'hi' }, { env, call, workers: WORKERS, sleep: async () => {} });
  assert.equal(rec.status, 'running'); const D = rec.id;
  for (let i = 0; i < 50 && direct.getDirect(D, env)?.status === 'running'; i++) await new Promise(r => setTimeout(r, 10));
  const done = direct.getDirect(D, env);
  assert.equal(done.status, 'done'); assert.equal(done.text, 'decoded!');
  assert.deepEqual(calls[0][1].tools, [], 'text-only'); assert.equal(calls[0][1].input, 'hi');
  assert.equal(direct.listDirect(env)[0].id, D);
  assert.match(directReply({ run: done }), /decoded!/);
  assert.match(directReply({ runs: direct.listDirect(env) }), new RegExp(`${D} +lfm3heretic +done`));
});

test('failures are stored, the run op is private', async () => {
  const env = fresh();
  const { id } = direct.startDirect({ worker: 'lfm3heretic', task: 'x' }, { env, workers: WORKERS, call: async () => { throw new Error('LM Studio down'); } });
  for (let i = 0; i < 50 && direct.getDirect(id, env)?.status === 'running'; i++) await new Promise(r => setTimeout(r, 10));
  assert.match(direct.getDirect(id, env).reason, /LM Studio down/);
  assert.equal(isPrivateBridgeTool('mcp__plugin_oai_bridge__run'), true);
  assert.match(directReply({ error: 'usage' }), /Usage: \/oai:run/);
});

test('bridge run op: an id shows a run, unknown ids and workers are errors', async () => {
  const { dispatch } = await import('../bridge/server.mjs'); const options = { env: fresh() };
  assert.match((await dispatch('run', { args: 'D99999' }, options)).error, /No run D99999/);
  assert.match((await dispatch('run', { args: 'nobody hi' }, options)).error, /Unknown worker/);
  assert.ok(Array.isArray((await dispatch('run', { args: '' }, options)).runs));
});
