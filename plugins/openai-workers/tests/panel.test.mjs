import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { panelOp, runningPanel, panelFile } from '../bridge/panel.mjs';

const fresh = () => ({ OAI_CONFIG_STATE_DIR: mkdtempSync(join(tmpdir(), 'oai-panel-')) });
const URL1 = 'http://127.0.0.1:4321/?t=abcDEF123_-';

test('starts a panel, opens the system browser only when asked', async () => {
  const env = fresh(), opened = [];
  let starts = 0;
  const deps = { start: async () => { starts++; return URL1; }, open: u => opened.push(u), isAlive: () => false };
  assert.deepEqual(await panelOp({}, env, deps), { url: URL1, reused: false });
  assert.deepEqual(opened, []);
  await panelOp({ system: true }, env, deps);
  assert.deepEqual(opened, [URL1]);
  assert.equal(starts, 2);
});

test('reuses a running panel recorded in panel.json', async () => {
  const env = fresh();
  writeFileSync(panelFile(env), JSON.stringify({ url: URL1, pid: 999999 }));
  assert.equal(runningPanel(env, { isAlive: () => true }), URL1);
  assert.equal(runningPanel(env, { isAlive: () => false }), null);
  const r = await panelOp({}, env, { start: async () => assert.fail('must reuse'), open: () => {}, isAlive: () => true });
  assert.deepEqual(r, { url: URL1, reused: true });
});

test('auto opens once per install and honours OAI_CONFIG_AUTOLAUNCH=0', async () => {
  const env = fresh(), deps = { start: async () => URL1, open: () => {}, isAlive: () => false };
  assert.equal((await panelOp({ auto: true }, env, deps)).url, URL1);
  assert.deepEqual(await panelOp({ auto: true }, env, deps), { url: null, skipped: 'already-launched' });
  assert.equal((await panelOp({}, env, deps)).url, URL1, 'manual /oai:config still works');
  assert.equal((await panelOp({ auto: true }, { ...fresh(), OAI_CONFIG_AUTOLAUNCH: '0' }, deps)).url, null);
});

test('never starts a real panel or browser under node --test', async () => {
  assert.deepEqual(await panelOp({}, fresh()), { url: null, skipped: 'test' });
  assert.deepEqual(await panelOp({ auto: true, system: true }, fresh()), { url: null, skipped: 'test' });
});
