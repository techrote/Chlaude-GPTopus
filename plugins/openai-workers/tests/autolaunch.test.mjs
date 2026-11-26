import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoLaunchPanel } from '../bridge/autolaunch.mjs';

test('panel launches once per install', () => {
  const env = { OAI_CONFIG_STATE_DIR: mkdtempSync(join(tmpdir(), 'oai-al-')) };
  let n = 0;
  assert.equal(autoLaunchPanel(env, { launch: () => n++ }), true);
  assert.equal(autoLaunchPanel(env, { launch: () => n++ }), false);
  assert.equal(n, 1);
});

test('OAI_CONFIG_AUTOLAUNCH=0 disables it', () => {
  const env = { OAI_CONFIG_STATE_DIR: mkdtempSync(join(tmpdir(), 'oai-al-')), OAI_CONFIG_AUTOLAUNCH: '0' };
  assert.equal(autoLaunchPanel(env, { launch: () => assert.fail() }), false);
});
