import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshLiveEnv, resetLiveEnvForTests } from '../bridge/live-env.mjs';

const store = values => ({ read: names => Object.fromEntries(names.map(n => [n, values[n] ?? ''])) });

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('applies stored values, unsets empties, honours the ttl, writes live-config.json', () => {
  resetLiveEnvForTests();
  const dir = mkdtempSync(join(tmpdir(), 'oai-live-'));
  const env = { OAI_CONFIG_STATE_DIR: dir, OPENAI_WORKER_MAX_STEPS: '40', OPENAI_WORKER_SERVICE_TIER: 'flex', UNRELATED: 'x' };
  assert.equal(refreshLiveEnv(env, { store: store({ OPENAI_WORKER_MAX_STEPS: '7' }), now: 10_000 }), true);
  assert.equal(env.OPENAI_WORKER_MAX_STEPS, '7');
  assert.equal(env.OPENAI_WORKER_SERVICE_TIER, undefined);
  assert.equal(env.UNRELATED, 'x');
  assert.equal(refreshLiveEnv(env, { store: store({ OPENAI_WORKER_MAX_STEPS: '9' }), now: 11_000 }), false);
  assert.equal(env.OPENAI_WORKER_MAX_STEPS, '7');
  assert.equal(refreshLiveEnv(env, { store: store({ OPENAI_WORKER_MAX_STEPS: '9' }), now: 20_000 }), true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'live-config.json'), 'utf8')).values.OPENAI_WORKER_MAX_STEPS, '9');
});

test('a failing store keeps the last configuration; OAI_LIVE_CONFIG=0 disables', () => {
  resetLiveEnvForTests();
  const env = { OAI_CONFIG_STATE_DIR: mkdtempSync(join(tmpdir(), 'oai-live-')), OPENAI_WORKER_MAX_STEPS: '5' };
  assert.equal(refreshLiveEnv(env, { store: { read() { throw new Error('boom'); } }, now: 1 }), false);
  assert.equal(env.OPENAI_WORKER_MAX_STEPS, '5');
  resetLiveEnvForTests();
  assert.equal(refreshLiveEnv({ ...env, OAI_LIVE_CONFIG: '0' }, { store: store({}), now: 1 }), false);
});
