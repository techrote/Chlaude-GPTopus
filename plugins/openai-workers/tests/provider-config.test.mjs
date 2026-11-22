import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PARAMS, PARAM, GROUPS, isAllowed, normalizeValue, validateConfig, effectiveConfig, memoryStore, noteLabel } from '../scripts/oai-config-core.mjs';
import { liveState } from '../scripts/oai-config.mjs';
import { WORKER_TYPES, PROVIDER_WORKERS, OPENAI_WORKERS, workerEnvSuffix } from '../bridge/workers.mjs';

const W = name => `OPENAI_WORKER_${workerEnvSuffix(name)}_`;

test('provider workers get MODEL, EFFORT MIN/DEFAULT/MAX and MAX STEPS in their group, plus the advanced NOTE; no tier or USD', () => {
  for (const name of PROVIDER_WORKERS) {
    const inGroup = PARAMS.filter(p => p.group === `w:${name}`).map(p => p.name).sort();
    assert.deepEqual(inGroup, [WORKER_TYPES[name].env, `${W(name)}EFFORT_MIN`, `${W(name)}EFFORT_DEFAULT`, `${W(name)}EFFORT_MAX`, `${W(name)}MAX_STEPS`].sort());
    assert.equal(PARAM[`${W(name)}EFFORT_NOTE`].group, 'advanced');
    assert.equal(isAllowed(`${W(name)}SERVICE_TIER`), false);
    assert.equal(isAllowed(`${W(name)}MAX_USD`), false);
    assert.equal(GROUPS.find(g => g.id === `w:${name}`).provider, WORKER_TYPES[name].provider);
  }
  for (const name of OPENAI_WORKERS) {
    assert.ok(isAllowed(`${W(name)}SERVICE_TIER`)); assert.ok(isAllowed(`${W(name)}MAX_USD`));
    assert.equal(GROUPS.find(g => g.id === `w:${name}`).provider, undefined);
  }
  assert.ok(PARAMS.every(p => p.label.length <= 20));
  assert.equal(noteLabel('sol6-2'), 'SOL6-2 NOTE');
  assert.equal(noteLabel('nemo3-5lightning'), 'NEMO35LIGHTNING NOTE');
});

test('providers group holds the NVIDIA / LM Studio globals; OAI_CONVO_DIR is an advanced path; the NVIDIA key is never a parameter', () => {
  assert.ok(GROUPS.some(g => g.id === 'providers'));
  for (const name of ['OAI_NVIDIA_CONCURRENCY', 'OAI_NVIDIA_HOURS_PER_DAY', 'OAI_NVIDIA_ROTATE', 'OAI_NVIDIA_ROTATE_HOURS', 'OAI_LMSTUDIO_URL', 'OAI_NVIDIA_URL',
    'OAI_NVIDIA_STEER_MODE', 'OAI_LMSTUDIO_STEER_MODE', 'OAI_CHAT_IDLE_SECONDS']) assert.equal(PARAM[name]?.group, 'providers', name);
  assert.equal(PARAM.OAI_CONVO_DIR.group, 'advanced'); assert.equal(PARAM.OAI_CONVO_DIR.kind, 'path');
  assert.equal(isAllowed('NVIDIA_API_KEY'), false);
  assert.equal(normalizeValue('OAI_NVIDIA_CONCURRENCY', '3'), '3');
  assert.throws(() => normalizeValue('OAI_NVIDIA_CONCURRENCY', '9'), /bounds/);
  assert.throws(() => normalizeValue('OAI_NVIDIA_HOURS_PER_DAY', '25'), /bounds/);
  assert.equal(normalizeValue('OAI_NVIDIA_HOURS_PER_DAY', '8.5'), '8.5');
  assert.equal(normalizeValue('OAI_NVIDIA_ROTATE', 'on'), '1');
  assert.equal(normalizeValue('OAI_LMSTUDIO_URL', 'http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1');
  for (const bad of ['ftp://x/v1', 'http://user:pw@host/v1', 'http://host/v1?key=x', 'not a url']) assert.throws(() => normalizeValue('OAI_NVIDIA_URL', bad), /URL/);
  assert.equal(normalizeValue('OAI_LMSTUDIO_STEER_MODE', 'USER'), 'user');
  assert.throws(() => normalizeValue('OAI_NVIDIA_STEER_MODE', 'prefill'), /Use/);
  assert.throws(() => normalizeValue('OAI_CONVO_DIR', 'relative'), /absolute/);
});

test('provider model overrides accept publisher/model ids; OpenAI model ids keep the old rule', () => {
  assert.equal(normalizeValue('OPENAI_WORKER_KIMIK3_1PRO_MODEL', 'moonshotai/kimi-k3.1-pro'), 'moonshotai/kimi-k3.1-pro');
  assert.equal(normalizeValue('OPENAI_WORKER_SPROCKET0_5_MODEL', 'kandivault/sprocket-500m/sprocket-500m-chat-q4_k_m.gguf'), 'kandivault/sprocket-500m/sprocket-500m-chat-q4_k_m.gguf');
  for (const bad of ['a//b', '../etc', '/abs', 'a b']) assert.throws(() => normalizeValue('OPENAI_WORKER_KIMIK3_1PRO_MODEL', bad), /model/);
  assert.throws(() => normalizeValue('OPENAI_WORKER_SOL6_2_MODEL', 'org/gpt'), /model/);
});

test('validation: no price or quota warnings for free provider workers; effort rules still enforced; effective view has no tier or USD', () => {
  assert.deepEqual(validateConfig({}).warnings, {});
  assert.deepEqual(validateConfig({ OPENAI_WORKER_LFM3HERETIC_MODEL: 'some/other-model' }).warnings, {});
  assert.match(validateConfig({ OPENAI_WORKER_MISTRAL4LARGE_EFFORT_MIN: 'high', OPENAI_WORKER_MISTRAL4LARGE_EFFORT_MAX: 'low' }).errors.OPENAI_WORKER_MISTRAL4LARGE_EFFORT_MIN, /exceeds max/);
  const eff = effectiveConfig({ OPENAI_WORKER_MAX_STEPS: '30', OPENAI_WORKER_SERVICE_TIER: 'priority', OPENAI_WORKER_NEMO3_5LIGHTNING_MAX_STEPS: '5' });
  assert.equal(eff.workers['nemo3-5lightning'].maxSteps, 5);
  assert.equal(eff.workers['kimik3-1pro'].maxSteps, 30);
  for (const name of PROVIDER_WORKERS) {
    assert.equal(eff.workers[name].tier, null); assert.equal(eff.workers[name].maxUsd, null);
    assert.equal(eff.workers[name].provider, WORKER_TYPES[name].provider); assert.equal(eff.workers[name].error, null);
  }
  assert.equal(eff.workers['sol6-2'].tier, 'priority');
});

test('liveState KEYS reports the NVIDIA key as configured or not, never its value', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'oai-provider-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const usage = async () => null;
  const missing = await liveState({ store: memoryStore(), stateDir: dir, env: {}, usage });
  const nv = missing.keys.find(k => k.profile === 'nvidia');
  assert.deepEqual(nv, { profile: 'nvidia', name: 'NVIDIA_API_KEY', label: 'NVIDIA', configured: false, source: 'none' });
  const secret = 'nvapi-' + 'x'.repeat(40);
  const set = await liveState({ store: memoryStore(), stateDir: dir, env: { NVIDIA_API_KEY: secret }, usage });
  assert.equal(set.keys.find(k => k.profile === 'nvidia').configured, true);
  assert.equal(set.keys.find(k => k.profile === 'nvidia').source, 'environment');
  assert.doesNotMatch(JSON.stringify(set), /nvapi-x/);
  assert.deepEqual(set.keys.map(k => k.profile), ['standard', 'free', 'nvidia']);
});
