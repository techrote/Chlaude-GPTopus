// Hardening round for the private native channel and its surroundings:
//   F1  raw legacy create/poll/cancel/page need the owner-key proof when ULTRA is enabled for the bridge
//   F5  every malformed envelope gets the same denial (array-typed mac used to throw a RangeError)
//   F6  nonce retention covers the whole clock window; future-dated requests beyond skew are refused
//   F7  two live bridge processes cannot share a session id (documented behaviour, pinned)
//   F8  / KEY-01  an overridden key file and the usage directory are protected like the state directory
//   F9  the mod guard and the Desktop namespace filter refuse exactly the same set of spellings
//   F11 the signing module needs no web global at import time; Windows is detected from the host's own report
//   F12 relative key file / state directory overrides are refused instead of resolving against a cwd
// All of it drives production code: the real stdio server process, the real dispatcher, the real mod hooks.
import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { register } from '../hooks/register.js';
import { isPrivateBridgeTool, isNativeNamespaceName, normalizeToolName } from '../hooks/ultra.js';
import { signRequest, utf8, isWindowsHost, isAbsoluteHostPath, modKeyPath, CHANNEL_DENIED, CHANNEL_REJECTED, CHANNEL_STALE, CHANNEL_HELLO, HELLO_EPOCH, CHANNEL_KEY_FILE } from '../hooks/channel.js';
import { NativeChannel, ChannelDenied, keyFilePath, provisionChannelKey } from '../bridge/native-channel.mjs';
import { NativeController } from '../ultra/native-controller.mjs';
import { ExecutionStore } from '../ultra/store.mjs';
import { RecruitmentBroker } from '../ultra/broker.mjs';
import { ownerPaths, ownerProtectedPaths, createService, keyFileExposure, OWNER_KEY_FILE, isAbsoluteSpelling } from '../ultra/service.mjs';
import { resolveConfig } from '../ultra/config.mjs';
import { dispatch } from '../bridge/server.mjs';
import { invoke as invokeDesktop } from '../bridge/desktop-server.mjs';
import { main as cli } from '../ultra/cli.mjs';
import { bridgeHost, nativePrompt } from './bridge-host.mjs';
import { nativeTransport } from './native-host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(root, 'bridge', 'server.mjs');
const T0 = 1_700_000_000_000;

function unit({ windowMs = 120000, futureMs, maxNonces } = {}) {
  const keyHex = randomBytes(32).toString('hex'), clock = { now: T0 };
  const channel = new NativeChannel({ key: Buffer.from(keyHex, 'hex'), now: () => clock.now, windowMs, ...(futureMs !== undefined && { futureMs }), ...(maxNonces && { maxNonces }) });
  const sign = (name, args, over = {}) => signRequest({ keyHex, epoch: channel.epoch, name, args, now: clock.now, ...over });
  return { keyHex, clock, channel, sign };
}
const refusal = fn => { try { fn(); } catch (error) { return error; } assert.fail('the request was admitted'); };

// ---------------------------------------------------------------------------------------------------------------------
// F5

test('F5: every malformed envelope field, in every JSON shape, gets the identical denial (array-typed mac used to throw a RangeError)', async () => {
  const u = unit(), name = 'ultra_native_diagnostics', args = { sessionId: 's', capability: 'c'.repeat(64) };
  const valid = JSON.parse(JSON.stringify(await u.sign(name, args)));
  const hex64 = 'a'.repeat(64), hex32 = 'b'.repeat(32);
  const shapes = { array: v => [v], 'nested array': v => [[v]], 'empty array': () => [], object: v => ({ v }), 'object with toString': v => ({ toString: () => v }), number: () => 7, boolean: () => true, null: () => null, 'empty string': () => '' };
  const outcomes = {};
  for (const field of ['epoch', 'nonce', 'mac', 'ts', 'v']) for (const [label, make] of Object.entries(shapes)) {
    const request = JSON.parse(JSON.stringify(valid));
    request.channel[field] = make(field === 'mac' ? hex64 : field === 'ts' ? String(T0) : hex32);
    const error = refusal(() => u.channel.verify(name, request));
    outcomes[`${field}/${label}`] = error instanceof ChannelDenied && error.message === CHANNEL_DENIED ? 'denied' : `${error.name}: ${error.message}`;
  }
  assert.deepEqual(Object.values(outcomes).filter(value => value !== 'denied'), [], JSON.stringify(outcomes));
  assert.equal(u.channel.nonces.size, 0, 'nothing was recorded');
  assert.ok(u.channel.verify(name, JSON.parse(JSON.stringify(await u.sign(name, args)))).payload, 'the genuine request is still admitted');
});

test('F5: through the real dispatcher an array-typed mac is refused with the one uniform text', async t => {
  const h = await bridgeHost(t);
  const name = 'ultra_native_diagnostics', args = { sessionId: 'x', capability: 'f'.repeat(64) };
  const { epoch } = await dispatch(CHANNEL_HELLO, await signRequest({ keyHex: h.keyHex, epoch: HELLO_EPOCH, name: CHANNEL_HELLO, args: {} }), h.options);
  const signed = JSON.parse(JSON.stringify(await signRequest({ keyHex: h.keyHex, epoch, name, args })));
  for (const mac of [[signed.channel.mac], [[signed.channel.mac]], { 0: signed.channel.mac }, Object.assign([], { length: 0 })]) {
    await assert.rejects(() => dispatch(name, { ...signed, channel: { ...signed.channel, mac } }, h.options), error => error.message === CHANNEL_DENIED);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// F6

test('F6: a request is never admitted twice at any instant its timestamp is acceptable (the off-by-one at 2x window is closed)', async () => {
  for (const [future, windowMs, futureMs] of [[0, 1000, 500], [500, 1000, 500], [-1000, 1000, 500], [500, 120000, 30000], [30000, 120000, 30000]]) {
    const u = unit({ windowMs, futureMs }), name = 'ultra_native_diagnostics';
    const request = JSON.parse(JSON.stringify(await u.sign(name, { sessionId: `s${future}` }, { now: T0 + future })));
    u.channel.verify(name, request);
    // Walk the clock across the whole span in which the timestamp could still pass the clock check, one tick at a time at the boundaries.
    const last = T0 + future + windowMs;
    for (const now of [T0, T0 + future, last - 1, last, last + 1, last + windowMs, last + 2 * windowMs]) {
      u.clock.now = now;
      const error = refusal(() => u.channel.verify(name, JSON.parse(JSON.stringify(request))));
      assert.ok(error.message.startsWith(CHANNEL_REJECTED), `future ${future}, now ${now - T0}: ${error.message}`);
    }
  }
});

test('F6: a timestamp beyond the future skew is refused, within it is admitted, and pruning keeps the replay window bounded', async () => {
  const u = unit({ windowMs: 60000, futureMs: 5000, maxNonces: 3 }), name = 'ultra_native_diagnostics';
  const early = JSON.parse(JSON.stringify(await u.sign(name, { sessionId: 'a' }, { now: T0 + 5001 })));
  assert.match(refusal(() => u.channel.verify(name, early)).message, /^ULTRA_CHANNEL_REJECTED: .*future/);
  const edge = JSON.parse(JSON.stringify(await u.sign(name, { sessionId: 'b' }, { now: T0 + 5000 })));
  assert.ok(u.channel.verify(name, edge).payload);
  assert.match(refusal(() => u.channel.verify(name, JSON.parse(JSON.stringify(edge)))).message, /replayed/);
  u.clock.now = T0 + 5000 + 60000 + 1; // past every instant the edge request could pass
  for (let i = 0; i < 3; i++) u.channel.verify(name, JSON.parse(JSON.stringify(await u.sign(name, { sessionId: `n${i}` }, { now: u.clock.now }))));
  assert.equal(u.channel.nonces.size, 3, 'the expired entry was pruned, capacity returned');
});

test('F6: hello is replayable across bridge PROCESSES inside the clock window (documented), and discloses only the epoch', async () => {
  const keyHex = randomBytes(32).toString('hex'), clock = { now: T0 };
  const a = new NativeChannel({ key: Buffer.from(keyHex, 'hex'), now: () => clock.now }), b = new NativeChannel({ key: Buffer.from(keyHex, 'hex'), now: () => clock.now });
  const hello = JSON.parse(JSON.stringify(await signRequest({ keyHex, epoch: HELLO_EPOCH, name: CHANNEL_HELLO, args: {}, now: T0 })));
  a.verify(CHANNEL_HELLO, hello);
  assert.deepEqual(Object.keys(b.verify(CHANNEL_HELLO, JSON.parse(JSON.stringify(hello)))).sort(), ['payload', 'verified'], 'a second process with the same key accepts the same signed hello');
  assert.deepEqual(Object.keys(b.hello()).sort(), ['epoch', 'v'], 'all it learns is that process epoch');
  const request = JSON.parse(JSON.stringify(await signRequest({ keyHex, epoch: a.epoch, name: 'ultra_native_diagnostics', args: { sessionId: 's' }, now: T0 })));
  assert.ok(refusal(() => b.verify('ultra_native_diagnostics', request)).message.startsWith(CHANNEL_STALE), 'a request signed for one process is never admitted by another');
  clock.now = T0 + 120001;
  assert.ok(refusal(() => b.verify(CHANNEL_HELLO, JSON.parse(JSON.stringify(hello)))).message.startsWith(CHANNEL_REJECTED), 'and the replay horizon is the clock window');
});

// ---------------------------------------------------------------------------------------------------------------------
// F7

test('F7: two live bridge processes with one key cannot share a session id; each reopen takes it and blocks running native work (pinned behaviour)', async t => {
  const dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-f7-'))); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(join(dir, 'ledger.json')), broker = new RecruitmentBroker(store, { config: { enabled: true } });
  const backend = async () => { throw new Error('no provider call'); }; backend.offline = true;
  const keyHex = randomBytes(32).toString('hex');
  const A = nativeTransport(new NativeController(broker, { backend }), { keyHex }), B = nativeTransport(new NativeController(broker, { backend }), { keyHex });
  assert.notEqual(A.channel.epoch, B.channel.epoch);
  const facts = { sessionId: 'shared-session', model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false, surfaces: ['terminal'] };
  const first = await A.signed('ultra_native_init', facts);
  const second = await B.signed('ultra_native_init', facts);
  assert.notEqual(second.capability, first.capability, 'the later process is accepted and the capability changes');
  await assert.rejects(() => A.signed('ultra_native_diagnostics', { sessionId: 'shared-session', capability: first.capability }), /capability|closed/i, 'the first process lost the session');
  const again = await A.signed('ultra_native_init', { ...facts, currentCapability: first.capability });
  assert.notEqual(again.capability, second.capability, 'and may take it straight back');
  await assert.rejects(() => B.signed('ultra_native_diagnostics', { sessionId: 'shared-session', capability: second.capability }), /capability|closed/i);
  assert.equal((await store.read()).events.filter(e => e.type === 'native.channel').length, 3, 'every takeover is audited');
});

// ---------------------------------------------------------------------------------------------------------------------
// F8 / KEY-01 and F12

test('F8: an overridden key file, the policy file and the usage directory are refused by the Chat reader and the runtime boundary (when the override is known)', async t => {
  const h = await bridgeHost(t, { project: { 'source.txt': 'open source file\n', 'channel.cfg': 'KEY-MATERIAL', 'usage/free-usage-ledger.json.bak': 'ledger copy' } });
  const keyOverride = join(h.project, 'channel.cfg'), usageDir = join(h.project, 'usage');
  const env = { ...h.env, OPENAI_ULTRA_CHANNEL_KEY_FILE: keyOverride, OPENAI_WORKER_USAGE_DIR: usageDir };
  await h.writePolicy({ desktop: { profile: 'B', roots: [h.project] }, permissions: { tools: ['read_file'], roots: [h.project] } });
  assert.ok(ownerProtectedPaths(env).includes(keyOverride) && ownerProtectedPaths(env).includes(usageDir) && ownerProtectedPaths(env).includes(ownerPaths(env).base));
  const service = await createService({ env, backend: async () => { throw new Error('no backend'); } });
  assert.match((await service.invoke('ultra_read_project', { root: '0', path: 'source.txt' })).content, /open source file/, 'ordinary project files remain readable');
  for (const path of ['channel.cfg', 'usage/free-usage-ledger.json.bak']) {
    await assert.rejects(() => service.invoke('ultra_read_project', { root: '0', path }), error => error.code === 'SECRET' || /protected|secret/i.test(error.message), path);
  }
  // The Desktop facade, as the extension process would run it with the same variables.
  const policy = await (await import('../ultra/service.mjs')).readOwnerConfig(env);
  assert.equal(policy.desktop.profile, 'B');
  await assert.rejects(() => invokeDesktop('ultra_read_project', { root: '0', path: 'channel.cfg' }, (name, args) => service.invoke(name, args), env), /protected control or credential path/);
  assert.match((await invokeDesktop('ultra_read_project', { root: '0', path: 'source.txt' }, (name, args) => service.invoke(name, args), env)).content, /open source file/, 'and an ordinary file is still served through the same facade');
});

test('F8: a key file inside a configured root under a non-secret name is never used by the Code bridge, and the owner is told by validate and show', async t => {
  const h = await bridgeHost(t, { key: false, project: { 'source.txt': 'x\n' } });
  const keyPath = join(h.project, 'channel.cfg'), env = { ...h.env, OPENAI_ULTRA_CHANNEL_KEY_FILE: keyPath };
  await h.writePolicy({ surfaces: { codeCli: { profile: 'B' } }, permissions: { tools: ['read_file'], roots: [h.project] } });
  await writeFile(keyPath, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  const keyHex = (await (await import('node:fs/promises')).readFile(keyPath, 'utf8')).trim();
  const config = resolveConfig({ enabled: true, permissions: { tools: ['read_file'], roots: [h.project] } });
  assert.deepEqual(keyFileExposure(config, env), [h.project]);
  assert.deepEqual(keyFileExposure(config, { ...env, OPENAI_ULTRA_CHANNEL_KEY_FILE: join(h.project, 'safe.key') }), [], 'a *.key name is refused by name through any root, so it is not an exposure');
  assert.deepEqual(keyFileExposure(config, { ...env, OPENAI_ULTRA_CHANNEL_KEY_FILE: join(h.dir, 'ultra-channel.key') }), [], 'outside every root');
  const options = { env, transport: h.transport };
  const hello = await dispatch(CHANNEL_HELLO, await signRequest({ keyHex, epoch: HELLO_EPOCH, name: CHANNEL_HELLO, args: {} }), options);
  const init = await signRequest({ keyHex, epoch: hello.epoch, name: 'ultra_native_init', args: { sessionId: 'exposed', model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false, surfaces: ['terminal'] } });
  await assert.rejects(() => dispatch('ultra_native_init', init, options), /key file lies inside a configured project root/);
  assert.equal((await h.ledger()).missions.constructor, Object, 'no mission was opened');
  assert.deepEqual(Object.keys((await h.ledger()).missions), []);
  const printed = []; await cli(['validate'], { env, print: value => printed.push(value) });
  assert.match(printed[0].warnings[0], /channel key file lies inside the configured project root/);
  printed.length = 0; await cli(['show'], { env, print: value => printed.push(value) });
  assert.equal(printed[0].warnings.length, 1);
});

test('F12: a relative key file or state directory override is refused everywhere instead of resolving against some working directory', async t => {
  const dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-f12-'))); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const bad of ['rel/key.key', './key.key', '../key.key', 'key.key', process.platform === 'win32' ? 'C:key.key' : 'key\\k']) {
    assert.throws(() => keyFilePath({ OPENAI_ULTRA_CHANNEL_KEY_FILE: bad }), /OPENAI_ULTRA_CHANNEL_KEY_FILE must be an absolute path/, bad);
    assert.throws(() => ownerPaths({ OPENAI_ULTRA_STATE_DIR: bad }), /OPENAI_ULTRA_STATE_DIR must be an absolute path/, bad);
    await assert.rejects(() => provisionChannelKey({ OPENAI_ULTRA_CHANNEL_KEY_FILE: bad }), /absolute/);
    assert.throws(() => modKeyPath({ file: bad, windows: false }), /OPENAI_ULTRA_CHANNEL_KEY_FILE must be an absolute path/);
    assert.throws(() => modKeyPath({ state: bad, windows: false }), /OPENAI_ULTRA_STATE_DIR must be an absolute path/);
  }
  assert.equal(keyFilePath({ OPENAI_ULTRA_CHANNEL_KEY_FILE: join(dir, 'k.key') }), join(dir, 'k.key'));
  assert.equal(keyFilePath({ OPENAI_ULTRA_CHANNEL_KEY_FILE: '${user_config.key}', OPENAI_ULTRA_STATE_DIR: dir }), join(dir, CHANNEL_KEY_FILE), 'an unexpanded placeholder is unset, as before');
  assert.equal(OWNER_KEY_FILE, CHANNEL_KEY_FILE, 'the bridge-side and mod-side default file names agree');
  assert.equal(isAbsoluteSpelling('C:\\x', 'win32'), true); assert.equal(isAbsoluteSpelling('/x', 'win32'), false); assert.equal(isAbsoluteSpelling('x', 'linux'), false);
  for (const ok of ['/abs/key', 'C:\\k', 'C:/k', '\\\\server\\share\\k']) assert.equal(isAbsoluteHostPath(ok), true, ok);
  for (const no of ['k', './k', '..\\k', 'C:k', '']) assert.equal(isAbsoluteHostPath(no), false, no);
});

test('F12: with ULTRA enabled and a relative key override the bridge does NOT load a key from the project directory; callers get the uniform refusal and the owner a diagnostic', async t => {
  const cwd = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-f12-cwd-'))); t.after(() => rm(cwd, { recursive: true, force: true }));
  const keyHex = randomBytes(32).toString('hex'), previous = process.cwd();
  await writeFile(join(cwd, 'planted.key'), `${keyHex}\n`, { mode: 0o600 });
  const stderr = []; const original = process.stderr.write;
  process.stderr.write = chunk => { stderr.push(String(chunk)); return true; };
  try {
    process.chdir(cwd);
    const env = { OPENAI_ULTRA_ENABLED: '1', OPENAI_ULTRA_CHANNEL_KEY_FILE: 'planted.key', OPENAI_ULTRA_STATE_DIR: join(cwd, 'state'), OPENAI_WORKER_USAGE_DIR: join(cwd, 'usage') };
    const hello = await signRequest({ keyHex, epoch: HELLO_EPOCH, name: CHANNEL_HELLO, args: {} });
    await assert.rejects(() => dispatch(CHANNEL_HELLO, hello, { env }), error => error.message === CHANNEL_DENIED, 'a key planted in the working directory is not accepted');
  } finally { process.chdir(previous); process.stderr.write = original; }
  assert.match(stderr.join(''), /OPENAI_ULTRA_CHANNEL_KEY_FILE must be an absolute path/);
  assert.ok(!stderr.join('').includes(keyHex));
});

// ---------------------------------------------------------------------------------------------------------------------
// F9

test('F9: the mod guard and the Desktop namespace filter refuse exactly the same set of spellings', async t => {
  const h = await bridgeHost(t), env = h.env;
  const separators = ['', '_', '-', '.', ' ', '__', '_-_', '\u200b', '\u00ad', '\u2061', '\u180e', '\ufe0f', '\u202e', '\u034f', '\u3164', '\u0000', '\ufeff', '\u2060'];
  const names = new Set(['ultra_native_init', 'ULTRA_NATIVE_INIT', 'Ultra_Native_Init', ' ultra_native_init', 'ultra_native_init\n', '\uff55ltra_native_init', 'ultra_native', 'mcp__x__ultra_native_hello']);
  for (const sep of separators) { names.add(`ultra${sep}native_init`); names.add(`mcp__server__ultra${sep}native${sep}init`); }
  const unrelated = ['health', 'create', 'ask_openai_worker', 'ultra_start', 'ultra_diagnostics', 'mcp__github__create_issue', 'native_ultra', 'ultranat', 'consult_ranative'];
  const refusesAsPrivate = async name => /Private native control/.test(await invokeDesktop(name, {}, async () => { throw new Error('backend must not be reached'); }, env).then(() => '', error => error.message));
  const disagreements = [];
  for (const name of [...names, ...unrelated]) {
    const expected = names.has(name), desktop = await refusesAsPrivate(name), mod = isNativeNamespaceName(name), guard = isPrivateBridgeTool(name);
    if (!(expected === desktop && desktop === mod && (!expected || guard))) disagreements.push({ name: JSON.stringify(name), expected, desktop, mod, guard });
  }
  assert.deepEqual(disagreements, []);
  assert.equal(normalizeToolName('ULTRA\u200b_native'), 'ultra_native');
  assert.equal(isPrivateBridgeTool('mcp__plugin_openai-workers_bridge__create'), true, 'raw legacy tools are still denied to model-origin calls');
  assert.equal(isPrivateBridgeTool('mcp__plugin_openai-workers_bridge__cre\u00adate'), true);
  assert.equal(isPrivateBridgeTool(undefined), false);
});

test('F9: both guards use ONE function (no second copy of the pattern can drift)', async () => {
  const { readFile } = await import('node:fs/promises');
  const desktop = await readFile(join(root, 'bridge', 'desktop-server.mjs'), 'utf8');
  assert.match(desktop, /import \{ isNativeNamespaceName \} from '\.\.\/hooks\/ultra\.js'/);
  assert.ok(!/ultra\[/.test(desktop), 'the Desktop facade carries no pattern of its own');
});

// ---------------------------------------------------------------------------------------------------------------------
// F11

test('F11: utf8() is byte-identical to TextEncoder, including lone surrogates, astral characters and NUL', () => {
  const samples = ['', 'plain', 'caf\u00e9', '\u20ac', '\ud83d\ude00', 'a\ud800b', '\udc00', '\ud800', 'x\u0000y', '\u00ff\u0100\u07ff\u0800\uffff', 'ultra-native/1/request '.repeat(50), '\ud83d', '\ude00\ud83d'];
  for (const text of samples) assert.deepEqual([...utf8(text)], [...new TextEncoder().encode(text)], JSON.stringify(text));
  // and Node's Buffer, which is what the bridge MACs, agrees about every lone surrogate
  for (const text of samples) assert.deepEqual([...utf8(text)], [...Buffer.from(text, 'utf8')], `Buffer ${JSON.stringify(text)}`);
});

test('F11: the signing module imports and signs with NO TextEncoder at all, and produces the same signature', async () => {
  const url = pathToFileURL(join(root, 'hooks', 'channel.js')).href, keyHex = 'ab'.repeat(32);
  const program = `
    const encoderless = process.argv[1] === 'without';
    if (encoderless) { delete globalThis.TextEncoder; if (typeof TextEncoder !== 'undefined') throw new Error('TextEncoder is still present'); }
    const { signRequest, keyIdOf } = await import(${JSON.stringify(url)});
    const signed = await signRequest({ keyHex: ${JSON.stringify(keyHex)}, epoch: '0'.repeat(32), name: 'ultra_native_diagnostics', args: { text: 'caf\\u00e9 \\ud83d\\ude00 \\ud800' }, now: 1700000000000, nonce: '1'.repeat(32) });
    process.stdout.write(JSON.stringify([signed.channel.mac, await keyIdOf(${JSON.stringify(keyHex)})]));`;
  const run = mode => execFileSync(process.execPath, ['--input-type=module', '-e', program, mode], { encoding: 'utf8', windowsHide: true });
  assert.deepEqual(JSON.parse(run('without')), JSON.parse(run('with')));
});

test('F11: the host platform is read from the host\'s own report, with Windows evidence only as a fallback', () => {
  for (const platform of ['windows', 'Windows', 'win32', 'WIN32', 'windows_nt']) assert.equal(isWindowsHost({ platform }), true, platform);
  for (const platform of ['linux', 'wsl', 'darwin', 'macos', 'freebsd']) assert.equal(isWindowsHost({ platform, localAppData: 'C:\\Users\\a\\AppData\\Local', userProfile: 'C:\\Users\\a' }), false, `${platform} is final even with Windows-looking variables`);
  assert.equal(isWindowsHost({ localAppData: 'C:\\Users\\a\\AppData\\Local' }), true, 'no report, Windows evidence');
  assert.equal(isWindowsHost({ platform: 'plan9', userProfile: 'C:\\Users\\a' }), true);
  assert.equal(isWindowsHost({ platform: 'plan9', userProfile: 'C:\\Users\\a', home: '/home/a' }), false, 'a HOME means a POSIX-style environment');
  assert.equal(isWindowsHost({}), false); assert.equal(isWindowsHost(), false);
  const base = 'C:\\Users\\a\\AppData\\Local';
  assert.equal(modKeyPath({ localAppData: base, windows: isWindowsHost({ platform: 'win32', localAppData: base }) }), `${base}/ClaudeOpenAIWorkers/${CHANNEL_KEY_FILE}`, 'a host that says win32 gets the Windows default, not an XDG miss');
});

test('F11: a host reporting win32 still finds the default Windows key location through the real hook module', async () => {
  const handlers = new Map(), sent = [];
  register((event, filter, fn) => { if (typeof filter === 'function') fn = filter; handlers.set(event + (filter?.command ? `:${filter.command}` : ''), fn); return { catch() { return this; } }; });
  const base = process.platform === 'win32' ? 'C:\\Users\\mod\\AppData\\Local' : '/home/mod/.localappdata';
  const reads = [];
  const $ = { env: { get: async name => ({ OPENAI_ULTRA_ENABLED: '1', LOCALAPPDATA: base, USERPROFILE: 'C:\\Users\\mod' })[name] },
    fs: { read: async path => { reads.push(path); throw new Error('ENOENT'); } },
    session: { version: async () => ({ version: '2.1.326' }), id: async () => 's', model: async () => 'opus', info: async () => ({ platform: 'win32', isHosted: false, dataRules: [] }), surfaces: async () => ['terminal'], cwd: async () => '/' },
    agent: { register: async () => {} }, tool: { register: async () => {} }, command: { register: async () => {} },
    mcp: { call: async (...call) => { sent.push(call); return { content: [] }; } } };
  await handlers.get('session.start')($, {}, async e => e);
  assert.deepEqual(reads, [`${base}/ClaudeOpenAIWorkers/${CHANNEL_KEY_FILE}`], 'the mod looked where the bridge keeps the key on Windows');
  assert.deepEqual(sent, [], 'and sent nothing without a key');
});

test('F11: a relative key file override holds the mod with a clear message and sends nothing', async () => {
  const handlers = new Map(), sent = [];
  register((event, filter, fn) => { if (typeof filter === 'function') fn = filter; handlers.set(event + (filter?.command ? `:${filter.command}` : ''), fn); return { catch() { return this; } }; });
  const $ = { env: { get: async name => ({ OPENAI_ULTRA_ENABLED: '1', OPENAI_ULTRA_CHANNEL_KEY_FILE: 'relative/ultra-channel.key' })[name] },
    fs: { read: async () => { throw new Error('must not be read'); } },
    session: { version: async () => ({ version: '2.1.326' }), id: async () => 's', model: async () => 'opus', info: async () => ({ platform: 'linux', isHosted: false, dataRules: [] }), surfaces: async () => ['terminal'], cwd: async () => '/' },
    agent: { register: async () => {} }, tool: { register: async () => {} }, command: { register: async () => {} }, mcp: { call: async (...call) => { sent.push(call); return { content: [] }; } } };
  await handlers.get('session.start')($, {}, async e => e);
  const text = (await handlers.get('command.run:ultra')($, { args: '', origin: { kind: 'composer' } }, async e => e)).text;
  assert.match(text, /ULTRA is HOLD: .*OPENAI_ULTRA_CHANNEL_KEY_FILE must be an absolute path/);
  assert.deepEqual(sent, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// F1: the raw stdio server process

class Stdio {
  constructor(env) {
    this.child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.pending = new Map(); this.id = 0; this.stderr = '';
    this.exited = new Promise(done => this.child.once('exit', done));
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', line => { const m = JSON.parse(line); this.pending.get(m.id)?.(m); this.pending.delete(m.id); });
  }
  call(name, args = {}) {
    const id = ++this.id;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response to ${name}`)), 20000);
      this.pending.set(id, message => { clearTimeout(timer); const text = message.result?.content?.map(c => c.text).join('') ?? message.error?.message ?? ''; let json = null; try { json = JSON.parse(text); } catch { /* error text */ } done({ isError: Boolean(message.result?.isError || message.error), text, json }); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    });
  }
  async close() { if (this.child.exitCode === null) this.child.kill(); await this.exited; }
}
const childEnv = extra => { const env = {}; for (const [name, value] of Object.entries(process.env)) if (!/^(OPENAI_|ANTHROPIC_|CLAUDE)/i.test(name)) env[name] = value; return { ...env, ...extra }; };

test('F1: with ULTRA enabled the raw create/poll/cancel/page need the owner-key proof on the stdio server; health and usage stay open', async t => {
  const h = await bridgeHost(t), env = childEnv({ OPENAI_ULTRA_ENABLED: '1', OPENAI_ULTRA_STATE_DIR: h.dir, OPENAI_ULTRA_CONFIG: join(h.dir, 'ultra-policy.json'), OPENAI_WORKER_USAGE_DIR: join(h.dir, 'usage') });
  const b = new Stdio(env); t.after(() => b.close());
  const create = { worker_type: 'sol', model: 'gpt-6.2-sol', input: 'x', instructions: 'x', tools: [] };
  const raw = { create, poll: { id: 'resp_abcdef', worker_type: 'sol' }, cancel: { id: 'resp_abcdef', worker_type: 'sol' }, page: { id: 'resp_abcdef', page: 0 } };
  for (const [name, args] of Object.entries(raw)) {
    const answer = await b.call(name, args);
    assert.deepEqual([answer.isError, answer.text], [true, CHANNEL_DENIED], `${name} must be refused without proof, with the uniform text`);
  }
  assert.ok(!(await b.call('health')).isError, 'health is read-only local status');
  assert.ok(!(await b.call('usage')).isError, 'usage is read-only local accounting');
  assert.match(b.stderr, /raw bridge tool "create" refused: OPENAI_ULTRA_ENABLED=1/, 'the owner is told why, once');
  // With the proof the SAME requests are authenticated and reach their handlers (which then fail on their own terms).
  const { epoch } = (await b.call(CHANNEL_HELLO, await signRequest({ keyHex: h.keyHex, epoch: HELLO_EPOCH, name: CHANNEL_HELLO, args: {} }))).json;
  const proved = {};
  for (const [name, args] of Object.entries(raw)) proved[name] = await b.call(name, await signRequest({ keyHex: h.keyHex, epoch, name, args }));
  assert.match(proved.page.text, /Paged response not found/, 'page reached its handler');
  assert.match(proved.poll.text, /ownership is unknown|Invalid|reconcile/i, 'poll reached its handler');
  assert.match(proved.create.text, /Missing standard OpenAI key|key|reserve|spending/i, 'create reached key selection (no key is configured, so nothing was sent)');
  for (const answer of Object.values(proved)) assert.notEqual(answer.text, CHANNEL_DENIED);
  // The proof is single use and bound to the operation.
  const request = await signRequest({ keyHex: h.keyHex, epoch, name: 'page', args: raw.page });
  assert.notEqual((await b.call('page', request)).text, CHANNEL_DENIED);
  assert.equal((await b.call('page', request)).text, `${CHANNEL_REJECTED}: replayed request`, 'a replayed proof is refused');
  assert.equal((await b.call('poll', request)).text, CHANNEL_DENIED, 'a proof for another operation is refused');
});

test('F1: without OPENAI_ULTRA_ENABLED the legacy integration is unchanged: raw tools answer unsigned, exactly as before', async t => {
  const h = await bridgeHost(t), env = childEnv({ OPENAI_ULTRA_STATE_DIR: h.dir, OPENAI_ULTRA_CONFIG: join(h.dir, 'ultra-policy.json'), OPENAI_WORKER_USAGE_DIR: join(h.dir, 'usage') });
  const b = new Stdio(env); t.after(() => b.close());
  assert.match((await b.call('page', { id: 'resp_abcdef', page: 0 })).text, /Paged response not found/);
  assert.match((await b.call('create', { worker_type: 'sol', model: 'gpt-6.2-sol', input: 'x', instructions: 'x', tools: [] })).text, /Missing standard OpenAI key|key/i);
  assert.ok(!(await b.call('health')).isError);
  assert.ok(!b.stderr.includes('refused: OPENAI_ULTRA_ENABLED'), 'no spurious diagnostic');
});

test('F1: an ULTRA-enabled mod never needs the raw tools: its protected flow only signs ultra_native_* (and health/usage are unsigned reads)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = (await readFile(join(root, 'hooks', 'register.js'), 'utf8'));
  const ultraBranch = source.slice(source.indexOf('async function nativeQuery'), source.indexOf('function nativeToolInput'));
  assert.ok(!/bridge\(\$, '(create|poll|cancel|page)'/.test(ultraBranch), 'the native request loop uses only ultra_native_* operations');
  assert.match(ultraBranch, /nativeBridge\(\$, channel, 'create'/);
});
