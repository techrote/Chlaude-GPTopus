import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PARAMS, ALLOWED, isAllowed, normalizeValue, validateConfig, effectiveConfig, memoryStore, jsonStore, windowsUserStore, applyChanges,
  markPending, readPending, clearPending, readUi, writeUi, sanitizeUi, capErrors, savePreset, readPreset, listPresets, deletePreset,
  presetChanges, tokenOk, originOk, newToken, defaultStore,
} from '../scripts/oai-config-core.mjs';
import { createConfigServer, parseArgs } from '../scripts/oai-config.mjs';
import { WORKER_TYPES } from '../bridge/workers.mjs';

const scratch = t => { const dir = mkdtempSync(join(tmpdir(), 'oai-config-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const NOW = new Date('2026-11-22T10:00:00Z');

test('allowlist covers every env name the mod and bridge read, and never key names', () => {
  const register = readFileSync(new URL('../hooks/register.js', import.meta.url), 'utf8');
  const sources = register + ['usage.mjs', 'policy.mjs', 'tree.mjs', 'workers.mjs', 'trace.mjs', 'steer.mjs'].map(f => readFileSync(new URL(`../bridge/${f}`, import.meta.url), 'utf8')).join('\n');
  const literal = new Set(sources.match(/\b(?:OPENAI_WORKER|OAI)_[A-Z0-9_]+\b/g));
  // Provider workers (NVIDIA Build, LM Studio) have no service tier and no USD cap, so those names are not configurable.
  for (const w of Object.keys(WORKER_TYPES)) for (const f of WORKER_TYPES[w].provider ? ['MODEL', 'EFFORT_MIN', 'EFFORT_MAX', 'EFFORT_DEFAULT', 'EFFORT_NOTE', 'MAX_STEPS']
    : ['MODEL', 'SERVICE_TIER', 'EFFORT_MIN', 'EFFORT_MAX', 'EFFORT_DEFAULT', 'EFFORT_NOTE', 'MAX_STEPS', 'MAX_USD'])
    literal.add(`OPENAI_WORKER_${w.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${f}`);
  // The provider bridge modules' literal names (chat transport, rotation, conversation store) must be configurable too.
  const providerSources = ['chat.mjs', 'rotation.mjs', 'convo.mjs'].map(f => readFileSync(new URL(`../bridge/${f}`, import.meta.url), 'utf8')).join('\n');
  for (const name of providerSources.match(/\b(?:OAI_NVIDIA|OAI_LMSTUDIO|OAI_CONVO)_[A-Z0-9_]+\b/g) ?? []) if (!name.endsWith('_')) assert.ok(isAllowed(name), `missing ${name}`);
  for (const w of Object.keys(WORKER_TYPES)) if (WORKER_TYPES[w].provider) {
    const p = `OPENAI_WORKER_${w.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
    assert.equal(isAllowed(`${p}SERVICE_TIER`), false); assert.equal(isAllowed(`${p}MAX_USD`), false);
  }
  for (const forbidden of ['NVIDIA_API_KEY']) assert.equal(isAllowed(forbidden), false);
  literal.delete('OPENAI_WORKER_TEST_WINDOWS'); // test-only switch
  for (const name of literal) if (!name.endsWith('_')) assert.ok(isAllowed(name), `missing ${name}`);
  for (const forbidden of ['OPENAI_API_KEY', 'OPENAI_FREE_API_KEY', 'PATH', 'OPENAI_ULTRA_ENABLED', '__proto__', 'constructor']) assert.equal(isAllowed(forbidden), false);
  assert.equal(new Set(ALLOWED).size, ALLOWED.length);
});

test('normalizeValue: empty unsets, bounds and kinds enforced', () => {
  assert.equal(normalizeValue('OPENAI_WORKER_MAX_STEPS', ''), '');
  assert.equal(normalizeValue('OPENAI_WORKER_MAX_STEPS', ' 60 '), '60');
  assert.throws(() => normalizeValue('OPENAI_WORKER_MAX_STEPS', '0'), /bounds/);
  assert.throws(() => normalizeValue('OPENAI_WORKER_MAX_STEPS', '2.5'), /Whole/);
  assert.throws(() => normalizeValue('OPENAI_WORKER_MAX_USD', '-1'), /number/);
  assert.throws(() => normalizeValue('OPENAI_WORKER_MAX_USD', '1e999'), /Not a number|bounds/);
  assert.equal(normalizeValue('OPENAI_WORKER_SERVICE_TIER', 'FLEX'), 'flex');
  assert.throws(() => normalizeValue('OPENAI_WORKER_SERVICE_TIER', 'turbo'), /Use/);
  assert.equal(normalizeValue('OPENAI_WORKER_SOL6_2_EFFORT_MIN', 'XHigh'), 'xhigh');
  assert.throws(() => normalizeValue('OPENAI_WORKER_SOL6_2_EFFORT_MIN', 'ultra'), /not ultra/);
  assert.equal(normalizeValue('OAI_TRACE', 'on'), '1');
  assert.equal(normalizeValue('OAI_TRACE', 'off'), '');
  assert.throws(() => normalizeValue('OPENAI_WORKER_SOL6_2_MODEL', 'gpt x'), /model/);
  assert.throws(() => normalizeValue('OAI_TRACE_DIR', 'relative/dir'), /absolute/);
  assert.throws(() => normalizeValue('OPENAI_WORKER_SOL6_2_EFFORT_NOTE', 'x'.repeat(241)), /240/);
  assert.throws(() => normalizeValue('OPENAI_API_KEY', 'sk-x'), /not a configurable/);
  assert.throws(() => normalizeValue('OPENAI_WORKER_SOL6_2_MODEL', 'a\nb'), /control/);
});

test('validateConfig delegates to the plugin parsers: effort order, model/effort compatibility, price warnings', () => {
  assert.deepEqual(validateConfig({}).errors, {});
  const bad = validateConfig({ OPENAI_WORKER_SOL6_2_EFFORT_MIN: 'max', OPENAI_WORKER_SOL6_2_EFFORT_MAX: 'high' });
  assert.match(bad.errors.OPENAI_WORKER_SOL6_2_EFFORT_MIN, /exceeds max/);
  assert.match(validateConfig({ OPENAI_WORKER_SOL6_2_EFFORT_DEFAULT: 'low' }).errors.OPENAI_WORKER_SOL6_2_EFFORT_DEFAULT, /outside/);
  assert.match(validateConfig({ OPENAI_WORKER_SOL6_2_EFFORT_MIN: 'none' }).errors.OPENAI_WORKER_SOL6_2_EFFORT_MIN, /does not support/);
  assert.match(validateConfig({ OPENAI_WORKER_SOL6_2_MODEL: 'gpt-x' }).warnings.OPENAI_WORKER_SOL6_2_MODEL, /REFUSE/);
  assert.match(validateConfig({ OPENAI_WORKER_TERRA5_6FREE_MODEL: 'gpt-x' }).warnings.OPENAI_WORKER_TERRA5_6FREE_MODEL, /quota group/);
  const eff = effectiveConfig({ OPENAI_WORKER_MAX_STEPS: '60', OPENAI_WORKER_LUNA6_MAX_STEPS: '7', OPENAI_WORKER_SERVICE_TIER: 'priority' });
  assert.equal(eff.workers['sol6-2'].maxSteps, 60);
  assert.equal(eff.workers.luna6.maxSteps, 7);
  assert.equal(eff.workers['sol6-2'].tier, 'priority');
  assert.equal(eff.workers.luna6flex.tier, 'flex');
  assert.equal(eff.workers.astra6free.maxUsd, null);
  assert.equal(eff.workers['sol6-2'].maxUsd, null, 'no default per-task USD cap');
});

test('applyChanges is atomic, writes only the diff and records the pending marker', t => {
  const dir = scratch(t), store = memoryStore({ OPENAI_WORKER_MAX_STEPS: '40' });
  const refused = applyChanges(store, { OPENAI_WORKER_SOL6_2_EFFORT_MIN: 'max', OPENAI_WORKER_MAX_USD: '2' }, { state: dir, now: NOW });
  assert.equal(refused.ok, true, 'min=max with built-in default clamps, so it is valid');
  const r2 = applyChanges(store, { OPENAI_WORKER_SOL6_2_EFFORT_DEFAULT: 'low' }, { state: dir });
  assert.equal(r2.ok, false); assert.ok(r2.errors.OPENAI_WORKER_SOL6_2_EFFORT_DEFAULT);
  assert.equal(store.data.OPENAI_WORKER_SOL6_2_EFFORT_DEFAULT, undefined);
  const r3 = applyChanges(store, { OPENAI_WORKER_MAX_STEPS: 'x', OPENAI_WORKER_MAX_USD: '3' }, { state: dir });
  assert.equal(r3.ok, false); assert.equal(store.data.OPENAI_WORKER_MAX_USD, '2', 'nothing from a refused batch is written');
  assert.equal(applyChanges(store, { PATH: 'x' }).ok, false);
  const p = readPending(dir, NOW, { autoClearMinutes: 0 });
  assert.deepEqual(Object.keys(p.changes).sort(), ['OPENAI_WORKER_MAX_USD', 'OPENAI_WORKER_SOL6_2_EFFORT_MIN']);
  assert.equal(applyChanges(store, { OPENAI_WORKER_MAX_USD: '' }, { state: dir }).ok, true);
  assert.equal(store.data.OPENAI_WORKER_MAX_USD, undefined, 'empty unsets');
  assert.deepEqual(Object.keys(readPending(dir, NOW, {}).changes), ['OPENAI_WORKER_SOL6_2_EFFORT_MIN'], 'reverting to the original value drops it from the marker');
});

test('pending marker: auto-clear only when chosen, explicit clear', t => {
  const dir = scratch(t);
  markPending(dir, { OAI_TRACE: { from: '', to: '1' } }, NOW);
  assert.ok(readPending(dir, new Date('2026-11-23T10:00:00Z'), { autoClearMinutes: 0 }));
  assert.ok(readPending(dir, new Date('2026-11-22T10:20:00Z'), { autoClearMinutes: 30 }));
  assert.equal(readPending(dir, new Date('2026-11-22T10:31:00Z'), { autoClearMinutes: 30 }), null);
  markPending(dir, { OAI_TRACE: { from: '', to: '1' } }, NOW);
  clearPending(dir);
  assert.equal(readPending(dir, NOW, {}), null);
});

test('UI state: caps within engineering bounds, window within caps, caps cannot exclude the current value', t => {
  const dir = scratch(t);
  assert.ok(sanitizeUi({ params: { OPENAI_WORKER_MAX_STEPS: { caps: [0, 5000] } } }).errors.OPENAI_WORKER_MAX_STEPS);
  assert.ok(sanitizeUi({ params: { OPENAI_WORKER_MAX_STEPS: { caps: [1, 50], window: [1, 80] } } }).errors.OPENAI_WORKER_MAX_STEPS);
  const refused = writeUi(dir, { params: { OPENAI_WORKER_MAX_STEPS: { caps: [1, 50] } } }, { OPENAI_WORKER_MAX_STEPS: '60' });
  assert.equal(refused.ok, false);
  const ok = writeUi(dir, { params: { OPENAI_WORKER_MAX_STEPS: { caps: [1, 80], window: [1, 70], align: 'forced' } }, locks: { global: true, bogus: true }, autoClearMinutes: 30 }, { OPENAI_WORKER_MAX_STEPS: '60' });
  assert.equal(ok.ok, true);
  const ui = readUi(dir);
  assert.deepEqual(ui.params.OPENAI_WORKER_MAX_STEPS, { caps: [1, 80], window: [1, 70], align: 'forced' });
  assert.deepEqual(ui.locks, { global: true });
  assert.equal(ui.autoClearMinutes, 30);
  assert.ok(capErrors({ OPENAI_WORKER_MAX_STEPS: '90' }, ui).OPENAI_WORKER_MAX_STEPS);
  assert.deepEqual(capErrors({ OPENAI_WORKER_MAX_STEPS: '75' }, ui), {}, 'direct entry may exceed the slider window up to the caps');
});

test('presets round-trip, built-ins are reserved, locks skip groups without being mutated', t => {
  const dir = scratch(t), values = { OPENAI_WORKER_MAX_STEPS: '60', OPENAI_WORKER_SOL6_2_EFFORT_DEFAULT: 'xhigh', OAI_TRACE: '1' };
  savePreset(dir, 'my deep', values, NOW);
  assert.deepEqual(readPreset(dir, 'my deep').values, values);
  assert.ok(listPresets(dir).some(p => p.name === 'my deep' && !p.builtin));
  assert.throws(() => savePreset(dir, 'FACTORY', values), /reserved/);
  assert.throws(() => savePreset(dir, '../evil', values), /Preset names/);
  const current = { OPENAI_WORKER_MAX_USD: '9', OPENAI_WORKER_SOL6_2_MODEL: 'gpt-6.2-sol' };
  const locks = { 'w:sol6-2': true };
  const { changes, skipped } = presetChanges(readPreset(dir, 'my deep'), current, locks);
  assert.deepEqual(changes, { OPENAI_WORKER_MAX_STEPS: '60', OAI_TRACE: '1', OPENAI_WORKER_MAX_USD: '' });
  assert.deepEqual(skipped.sort(), ['OPENAI_WORKER_SOL6_2_EFFORT_DEFAULT', 'OPENAI_WORKER_SOL6_2_MODEL']);
  assert.deepEqual(locks, { 'w:sol6-2': true });
  assert.ok('OPENAI_WORKER_SOL6_2_EFFORT_DEFAULT' in presetChanges(readPreset(dir, 'my deep'), current, locks, true).changes);
  for (const p of listPresets(dir).filter(p => p.builtin)) assert.deepEqual(validateConfig(readPreset(dir, p.name).values).errors, {}, p.name);
  deletePreset(dir, 'my deep');
  assert.throws(() => readPreset(dir, 'my deep'), /not found/);
});

test('stores: JSON file and Windows store pass only allowlisted names via stdin', t => {
  const dir = scratch(t), file = join(dir, 'env.json');
  const js = jsonStore(file); js.write({ OAI_TRACE: '1', OPENAI_WORKER_MAX_STEPS: '5' }); js.write({ OPENAI_WORKER_MAX_STEPS: '' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { OAI_TRACE: '1' });
  assert.deepEqual(js.read(['OAI_TRACE', 'OAI_STATUS_COLOR']), { OAI_TRACE: '1', OAI_STATUS_COLOR: '' });
  const calls = [];
  const win = windowsUserStore((script, input) => { calls.push({ script, input }); return '{"OAI_TRACE":"1"}'; });
  assert.deepEqual(win.read(['OAI_TRACE', 'OAI_STATUS_COLOR']), { OAI_TRACE: '1', OAI_STATUS_COLOR: '' });
  win.write({ OAI_TRACE: '' });
  assert.match(calls[0].script, /GetEnvironmentVariable\(\$k, 'User'\)/);
  assert.match(calls[1].script, /SetEnvironmentVariable\(\$p.Name, \$v, 'User'\)/);
  assert.equal(calls[1].input, '{"OAI_TRACE":""}');
  assert.ok(!calls.some(c => c.script.includes('OAI_TRACE')), 'names travel as data, never in the script text');
  assert.throws(() => win.write({ OPENAI_API_KEY: 'x' }), /non-allowlisted/);
  assert.throws(() => win.read(['OPENAI_API_KEY']), /non-allowlisted/);
  assert.equal(defaultStore({ OAI_CONFIG_STORE: file }).kind, 'json');
  assert.equal(defaultStore({}, 'win32').kind, 'windows-user-env');
});

test('token and origin guards', () => {
  const tok = newToken();
  assert.equal(tokenOk(tok, tok), true);
  assert.equal(tokenOk(tok, tok.slice(0, -1) + (tok.endsWith('a') ? 'b' : 'a')), false);
  assert.equal(tokenOk(tok, ''), false);
  assert.equal(tokenOk(tok, undefined), false);
  assert.equal(originOk({ host: '127.0.0.1:5000' }, 5000), true);
  assert.equal(originOk({ host: 'localhost:5000', origin: 'http://localhost:5000' }, 5000), true);
  assert.equal(originOk({ host: 'evil.example:5000' }, 5000), false, 'DNS rebinding');
  assert.equal(originOk({ host: '127.0.0.1:5000', origin: 'http://evil.example' }, 5000), false, 'CSRF');
  assert.equal(originOk({ host: '127.0.0.1:5000', 'sec-fetch-site': 'cross-site' }, 5000), false);
  assert.equal(originOk({ host: '127.0.0.1:5001' }, 5000), false);
});

test('HTTP server: token required, foreign host refused, set/preset/restarted flow, keys never exposed', async t => {
  const dir = scratch(t), store = memoryStore({ OPENAI_WORKER_USAGE_DIR: join(dir, 'u') }), token = newToken();
  const env = { OPENAI_API_KEY: 'sk-test-SECRET-value-1234567890' };
  const { server } = createConfigServer({ store, stateDir: dir, token, env, usage: async () => ({ fake: true }), page: '<html>__NONCE__</html>' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { body, tok = token, headers = {} } = {}) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'x-oai-token': tok, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await fetch(`${base}/`)).status, 403);
  const page = await fetch(`${base}/?t=${token}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.doesNotMatch(await page.text(), /__NONCE__/);
  assert.equal((await call('/api/state', { tok: 'nope' })).status, 401);
  assert.equal((await call('/api/state', { headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/set`, { method: 'POST', headers: { 'x-oai-token': token, 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  const state = await (await call('/api/state')).json();
  const text = JSON.stringify(state);
  assert.doesNotMatch(text, /SECRET/);
  assert.equal(state.keys[0].configured, true);
  assert.equal(state.pending, null);
  const bad = await call('/api/set', { body: { name: 'OPENAI_WORKER_MAX_STEPS', value: '-3' } });
  assert.equal(bad.status, 422);
  assert.equal((await call('/api/set', { body: { changes: { PATH: 'x' } } })).status, 422);
  const ok = await (await call('/api/set', { body: { changes: { OPENAI_WORKER_MAX_STEPS: '61' } } })).json();
  assert.deepEqual(ok.changed, ['OPENAI_WORKER_MAX_STEPS']);
  assert.equal(store.data.OPENAI_WORKER_MAX_STEPS, '61');
  assert.ok((await (await call('/api/state')).json()).pending.changes.OPENAI_WORKER_MAX_STEPS);
  await call('/api/ui', { body: { ui: { params: { OPENAI_WORKER_MAX_STEPS: { caps: [1, 70] } } } } });
  assert.equal((await call('/api/set', { body: { name: 'OPENAI_WORKER_MAX_STEPS', value: '80' } })).status, 422, 'safety caps enforced on direct entry');
  await call('/api/preset/save', { body: { name: 'snap' } });
  await call('/api/set', { body: { changes: { OPENAI_WORKER_MAX_STEPS: '' } } });
  const loaded = await (await call('/api/preset/load', { body: { name: 'snap' } })).json();
  assert.deepEqual(loaded.changed, ['OPENAI_WORKER_MAX_STEPS']);
  assert.equal(store.data.OPENAI_WORKER_MAX_STEPS, '61');
  await call('/api/restarted', { body: {} });
  assert.equal((await (await call('/api/state')).json()).pending, null);
  assert.ok(existsSync(join(dir, 'config-presets', 'snap.json')));
});

test('launcher arguments and /oai status footer mention the panel', () => {
  assert.deepEqual(parseArgs(['--no-open', '--idle-minutes', '5']), { open: false, port: 0, idleMinutes: 5 });
  assert.throws(() => parseArgs(['--port', '99999']), /port/);
  assert.match(readFileSync(new URL('../hooks/status-art.js', import.meta.url), 'utf8'), /\/oai:config/);
  assert.ok(PARAMS.every(p => p.help && p.label.length <= 20));
});
