// Raw-transport qualification of the private native ULTRA control channel.
//
// Everything here drives the real production boundary: the real stdio server
// process (bridge/server.mjs and bridge/desktop-server.mjs, JSON-RPC over pipes)
// and the real mod hook module (hooks/register.js) routed to that server. No
// provider is contacted: live API use is never enabled and no key is supplied.
// The attacks are written against the SECURE outcome: they must fail on a
// dispatcher that merely trusts whoever reaches it.
import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, realpath, symlink, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { register } from '../hooks/register.js';
import { NATIVE_PREFIX, isPrivateBridgeTool } from '../hooks/ultra.js';
import { signRequest, canonicalJson, hmacSha256, bytesToHex, parseChannelKey, modKeyPath, CHANNEL_DENIED, CHANNEL_STALE, CHANNEL_REJECTED, CHANNEL_HELLO, HELLO_EPOCH, SESSION_CLOSED } from '../hooks/channel.js';
import { resolveConfig } from '../ultra/config.mjs';
import { writeOwnerConfig } from '../ultra/service.mjs';
import { ExecutionStore, digest } from '../ultra/store.mjs';
import { RecruitmentBroker } from '../ultra/broker.mjs';
import { NativeController } from '../ultra/native-controller.mjs';
import { NativeChannel, NativeGateway, ChannelDenied, NOT_MEDIATED, loadChannelKey, keyFilePath, provisionChannelKey } from '../bridge/native-channel.mjs';
import { dispatch, handle } from '../bridge/server.mjs';
import { invoke as invokeDesktop } from '../bridge/desktop-server.mjs';
import { main as provisionCli } from '../scripts/provision-ultra-channel.mjs';
import { nativeTransport, signedDispatcher } from './native-host.mjs';

const execFileAsync = promisify(execFile);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(root, 'bridge', 'server.mjs');
const DESKTOP = join(root, 'bridge', 'desktop-server.mjs');
const risk = { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 0.95, rationale: 'Deterministic offline fixture.' };
const taskPrompt = (task = 'Synthetic bounded work') => JSON.stringify({ task, ultra: { role: 'exploration', risk, budget: { tokens: 1000, usd: 0.05 } } });
const KEY_FILE = 'ultra-channel.key';

/** A child environment containing no ambient credential and no live-API opt-in. */
function childEnvironment(dir, extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (!/^(OPENAI_|ANTHROPIC_|CLAUDE)/i.test(name)) env[name] = value;
  return { ...env, OPENAI_ULTRA_ENABLED: '1', OPENAI_ULTRA_STATE_DIR: dir, OPENAI_ULTRA_CONFIG: join(dir, 'ultra-policy.json'),
    OPENAI_WORKER_USAGE_DIR: join(dir, 'usage'), ...extra };
}

/** One stdio MCP connection. Model, mod, hook and tool callers all share it, as in the host. */
class Bridge {
  constructor(env, script = SERVER) {
    this.child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.pending = new Map(); this.unsolicited = []; this.log = []; this.id = 0; this.stderr = '';
    this.exited = new Promise(done => this.child.once('exit', done));
    this.child.stderr.on('data', chunk => { this.stderr += chunk; });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { this.unsolicited.push(line); return; }
      this.log.push(line);
      const waiter = this.pending.get(message.id);
      if (waiter) { this.pending.delete(message.id); waiter(message); } else this.unsolicited.push(message);
    });
  }
  send(message) { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  request(method, params) {
    const id = ++this.id;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`No response to ${method}`)); }, 20000);
      this.pending.set(id, message => { clearTimeout(timer); resolveRequest(message); });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  /** tools/call, normalised to { isError, text, json, rpcError }. */
  async call(name, args = {}, extra = {}) {
    const message = await this.request('tools/call', { name, arguments: args, ...extra });
    if (message.error) return { isError: true, rpcError: message.error, text: message.error.message, json: null };
    const text = message.result?.content?.map(c => c.text).join('') ?? '';
    let json = null; try { json = JSON.parse(text); } catch { /* error text */ }
    return { isError: Boolean(message.result?.isError), text, json };
  }
  async close() { if (this.child.exitCode === null) this.child.kill(); await this.exited; }
}

async function fixture(t, { config = {}, key = true } = {}) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'ultra-transport-'));
  const env = childEnvironment(dir);
  const bridges = [];
  t.after(async () => { for (const b of bridges) await b.close(); await rm(dir, { recursive: true, force: true }); });
  await writeOwnerConfig(resolveConfig({ enabled: true, ...config }), env);
  const keyHex = randomBytes(32).toString('hex');
  // Written by hand, with only the documented path/format convention, so the
  // same fixture also drives a transport that predates the channel key.
  if (key) await writeFile(join(dir, KEY_FILE), `${keyHex}\n`, { mode: 0o600 });
  const open = (script = SERVER, extra = {}) => { const b = new Bridge({ ...env, ...extra }, script); bridges.push(b); return b; };
  return { dir, env, keyHex, keyFile: join(dir, KEY_FILE), open, bridge: () => open(), ledger: () => ledgerFingerprint(dir) };
}

/** Fingerprint of the durable execution ledger: any accepted state change alters it. */
async function ledgerFingerprint(dir) {
  try { return createHash('sha256').update(await readFile(join(dir, 'ultra-execution.json'))).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
}

/** The real mod hook module, connected to a real server process through JSON-RPC. */
async function mod(t, f, bridge, { sessionId = 'victim-session', model = 'opus', version = '2.1.326' } = {}) {
  const handlers = new Map(), catches = new Map(), sent = [], agents = [], states = new Map();
  const keyOf = (event, filter) => `${event}${event === 'command.run' && filter?.command ? `:${filter.command}` : filter?.tool ? `:${filter.tool}` : ''}`;
  register((event, filter, fn) => {
    if (typeof filter === 'function') { fn = filter; filter = null; }
    const key = keyOf(event, filter); handlers.set(key, fn);
    return { catch(handler) { catches.set(key, handler); return this; } };
  });
  const values = { OPENAI_ULTRA_ENABLED: '1', OPENAI_ULTRA_STATE_DIR: f.dir };
  let currentSession = sessionId;
  const $ = {
    agent: { register: async () => {}, list: async () => structuredClone(agents) },
    tool: { register: async () => ({}) }, command: { register: async () => {} },
    env: { get: async name => values[name] },
    session: { version: async () => ({ version }), id: async () => currentSession, model: async () => model, cwd: async () => f.dir,
      info: async () => ({ platform: 'linux', isHosted: false, dataRules: [] }), messages: async () => [] },
    state: { get: async ref => ({ value: states.get(ref.id) }), set: async (ref, value) => states.set(ref.id, structuredClone(value)) },
    fs: { read: async path => readFile(path, 'utf8') },
    mcp: { call: async (_server, name, args) => {
      sent.push({ name, args: structuredClone(args) });
      const answer = await bridge.call(name, args);
      return { isError: answer.isError, content: [{ type: 'text', text: answer.text }] };
    } },
  };
  async function run(event, e, delegate = async () => ({})) {
    const exact = keyOf(event, e), key = handlers.has(exact) ? exact : event, handler = handlers.get(key);
    assert.ok(handler, `missing hook ${key}`);
    let called = false, result;
    const next = async value => { if (!called) { called = true; result = Promise.resolve().then(() => delegate(value)); } return result; };
    Object.defineProperty(next, 'called', { get: () => called }); next.signal = new AbortController().signal; next.origin = { plugin: 'engine', tier: 'core' };
    try { return await handler($, e, next); }
    catch (error) { if (!catches.has(key)) throw error; return catches.get(key)($, e, next); }
  }
  const texts = new Map(); let spawns = 0;
  async function spawnWorker(worker, { parentAgentId, toolUseId, prompt = taskPrompt() } = {}) {
    const event = { tool_use_id: toolUseId ?? `spawn_${spawns + 1}`, subagentType: `openai-workers:${worker}`, prompt, description: 'Synthetic child', parentAgentId, parentModel: model, background: false, fork: false };
    let started;
    const result = await run('agent.spawn', event, async rewritten => {
      const agentId = `native_agent_${++spawns}`;
      started = { id: agentId, type: rewritten.subagentType, parentId: rewritten.parentAgentId, status: 'running', model }; agents.push(started); texts.set(agentId, rewritten.prompt);
      return { model, agentId };
    });
    if (started) await run('turn.start', { agentId: started.id, text: texts.get(started.id), turnId: `turn_${started.id}` });
    return result;
  }
  async function execute(agentId, name, input, callId = 'native-tool-1') {
    const check = await run('tool.check', { agentId, tool: name, input, tool_use_id: callId }, async () => ({ decision: 'allow' }));
    if (check.decision !== 'allow') return { deny: check.reason };
    return run('tool.run', { agentId, tool: name, tool_use_id: callId, ...input }, async () => { throw new Error('No native executor in this fixture'); });
  }
  await run('session.start', {});
  const ultra = async (args = '') => (await run('command.run', { command: 'ultra', args, origin: { kind: 'composer' } })).text;
  return { run, sent, ultra, sessionId, missionId: `native-${digest(sessionId).slice(0, 32)}`, agents, $, handlers, spawn: spawnWorker, execute,
    switchSession: async id => { currentSession = id; await run('session.start', {}); } };
}
const live = text => text.startsWith('ULTRA native mission');
const tool = name => `${NATIVE_PREFIX}ultra_${name}`;
const readLedger = async dir => JSON.parse(await readFile(join(dir, 'ultra-execution.json'), 'utf8'));
const fabricated = (over = {}) => ({ sessionId: 'victim-session', model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false, ...over });

test('transport: ultra_native_* is not advertised, and hiding it is not what protects it', async t => {
  const f = await fixture(t), b = f.bridge();
  const listed = (await b.request('tools/list', {})).result.tools.map(tool => tool.name);
  assert.ok(!listed.some(name => name.includes('ultra_native')), 'the private namespace stays out of tools/list');
  const before = await f.ledger();
  const direct = await b.call('ultra_native_init', fabricated({ sessionId: 'hidden-but-callable' }));
  assert.equal(direct.isError, true, `an unadvertised private operation answered a bare tools/call: ${direct.text.slice(0, 120)}`);
  assert.equal(await f.ledger(), before, 'a refused request must leave the ledger byte-identical');
});

test('transport: a fabricated Opus identity cannot obtain a capability, orchestrator trust, recruitment or promotion', async t => {
  const f = await fixture(t), b = f.bridge(), before = await f.ledger();
  const init = await b.call('ultra_native_init', fabricated({ sessionId: 'attacker-session', model: 'opus' }));
  const common = { sessionId: 'attacker-session', capability: init.json?.capability ?? 'f'.repeat(64), primaryModel: 'opus', effectivePrimaryModel: 'opus' };
  const admit = await b.call('ultra_native_admit', { ...common, parentModel: 'opus', toolUseId: 'forged-spawn', subagentType: 'openai-workers:astra', prompt: taskPrompt() });
  const promote = await b.call('ultra_native_tool', { ...common, toolUseId: 'forged-promote', tool: `${NATIVE_PREFIX}ultra_promote`,
    input: { nodeId: 'root', worker: 'astra', role: 'reviewer', relations: [], reviewOnly: true, uses: 1, ttlMs: 60000 } });
  const diagnostics = await b.call('ultra_native_diagnostics', common);
  const root = (tool, input) => b.call('ultra_native_tool', { ...common, toolUseId: `forged-${tool}`, tool: `${NATIVE_PREFIX}ultra_${tool}`, input });
  const forged = {
    recruitment: await root('recruitment_decide', { requestId: 'any', requestHash: 'x', decision: 'APPROVE', rationale: 'forged root decision' }),
    action: await root('action_decide', { actionId: 'any', actionHash: 'x', approved: true, rationale: 'forged consequential approval' }),
    risk: await root('risk_override', { nodeId: 'root', replacement: risk, rationale: 'forged downgrade', ttlMs: 60000 }),
    escalation: await root('escalate', { requestId: 'any', requestHash: 'x', changes: {} }),
    user: await b.call('ultra_native_user_decide', common),
  };
  const obtained = Object.fromEntries(Object.entries({ init, admit, promote, diagnostics, ...forged }).map(([name, r]) => [name, r.isError ? 'refused' : 'ACCEPTED']));
  assert.deepEqual(obtained, Object.fromEntries(Object.keys(obtained).map(name => [name, 'refused'])));
  assert.equal(init.json?.orchestrator?.trusted, undefined, 'no trusted orchestrator identity may be returned');
  assert.equal(await f.ledger(), before);
});

test('transport: a second init cannot rotate, hijack or deny a live session', async t => {
  const f = await fixture(t), b = f.bridge(), victim = await mod(t, f, b);
  assert.ok(live(await victim.ultra()), 'the genuine mod has a working session');
  const before = await f.ledger();
  const hijack = await b.call('ultra_native_init', fabricated({ sessionId: victim.sessionId }));
  const after = await f.ledger(), victimText = await victim.ultra();
  assert.deepEqual({ hijackRefused: hijack.isError, ledgerUnchanged: after === before, victimKeepsAuthority: live(victimText) },
    { hijackRefused: true, ledgerUnchanged: true, victimKeepsAuthority: true }, `victim after the hijack attempt: ${victimText.slice(0, 160)}`);
});

test('transport: another bridge process on the same owner store cannot open or rotate a session', async t => {
  const f = await fixture(t), primary = f.bridge(), victim = await mod(t, f, primary);
  assert.ok(live(await victim.ultra()));
  const before = await f.ledger(), rogue = f.bridge();
  const attempt = await rogue.call('ultra_native_init', fabricated({ sessionId: victim.sessionId }));
  const fresh = await rogue.call('ultra_native_init', fabricated({ sessionId: 'rogue-process-session' }));
  const victimText = await victim.ultra();
  assert.deepEqual({ rotateRefused: attempt.isError, openRefused: fresh.isError, ledgerUnchanged: await f.ledger() === before, victimKeepsAuthority: live(victimText) },
    { rotateRefused: true, openRefused: true, ledgerUnchanged: true, victimKeepsAuthority: true }, `victim after the rogue init: ${victimText.slice(0, 160)}`);
});

test('transport: a captured request or a leaked capability alone cannot be replayed on the raw channel', async t => {
  const f = await fixture(t), b = f.bridge(), victim = await mod(t, f, b);
  assert.ok(live(await victim.ultra()));
  const captured = victim.sent.filter(c => c.name === 'ultra_native_diagnostics').at(-1);
  assert.ok(captured, 'the mod sent a diagnostics request');
  const before = await f.ledger();
  const replay = await b.call(captured.name, captured.args);
  const { capability, sessionId } = captured.args;
  const bare = await b.call('ultra_native_diagnostics', { sessionId, capability });
  assert.deepEqual({ replayRefused: replay.isError, bareCapabilityRefused: bare.isError, ledgerUnchanged: await f.ledger() === before },
    { replayRefused: true, bareCapabilityRefused: true, ledgerUnchanged: true });
  assert.ok(live(await victim.ultra()));
});

test('transport: one live session cannot borrow a different session capability, bindings or signed requests on the raw channel', async t => {
  const f = await fixture(t), b = f.bridge(), a = await mod(t, f, b, { sessionId: 'session-a' }), other = await mod(t, f, b, { sessionId: 'session-b' });
  const worker = await a.spawn('luna'); assert.ok(worker.agentId, worker.deny);
  assert.ok(live(await a.ultra()) && live(await other.ultra()));
  const before = await f.ledger(), captured = a.sent.filter(c => c.name === 'ultra_native_diagnostics').at(-1).args, theirs = other.sent.filter(c => c.name === 'ultra_native_diagnostics').at(-1).args;
  const { channel, ...bare } = captured;
  const attempts = {
    'A signed request retargeted at B': await b.call('ultra_native_diagnostics', { ...captured, sessionId: 'session-b' }),
    'A capability with B id, unsigned': await b.call('ultra_native_diagnostics', { ...bare, sessionId: 'session-b' }),
    'A capability with B id and an old B envelope': await b.call('ultra_native_diagnostics', { ...bare, sessionId: 'session-b', channel: theirs.channel }),
    'B capability against A bindings': await b.call('ultra_native_context', { sessionId: 'session-a', capability: theirs.capability, hostAgentId: worker.agentId }),
  };
  assert.deepEqual(Object.fromEntries(Object.entries(attempts).map(([name, r]) => [name, r.isError])), Object.fromEntries(Object.keys(attempts).map(name => [name, true])));
  assert.equal(await f.ledger(), before);
  assert.ok(live(await a.ultra()) && live(await other.ultra()), 'both genuine sessions keep their authority');
});

test('transport: every private operation is closed to a caller without the owner key, whatever the transport shape', async t => {
  const f = await fixture(t), b = f.bridge(), victim = await mod(t, f, b), before = await f.ledger();
  const common = { sessionId: victim.sessionId, capability: 'f'.repeat(64) };
  const names = ['hello', 'init', 'admit', 'bind', 'context', 'create', 'poll', 'cancel_response', 'tool_check', 'tool', 'review_start', 'finish', 'abort_spawn', 'diagnostics', 'supervise', 'user_decide', 'cancel'];
  const outcomes = {};
  for (const name of names) outcomes[name] = (await b.call(`ultra_native_${name}`, name === 'init' ? fabricated({ sessionId: victim.sessionId }) : common)).isError ? 'refused' : 'ACCEPTED';
  assert.deepEqual(Object.values(outcomes).filter(value => value !== 'refused'), [], `operations answered an unauthenticated caller: ${JSON.stringify(outcomes)}`);
  assert.equal(await f.ledger(), before);
});

test('transport: Desktop Chat facade never reaches the private namespace, in any spelling', async t => {
  const f = await fixture(t), b = f.open(DESKTOP), before = await f.ledger();
  const privateSpellings = ['ultra_native_init', 'ULTRA_NATIVE_INIT', 'Ultra_Native_Init', ' ultra_native_init', 'ultra_native_init ', 'ultra_native_init\u0000', 'ultra_native_init\n',
    '\uff55ltra_native_init', 'ultra\u200b_native_init', 'ultra_native_', 'ultra_native', 'ultra-native-init', 'ultra.native.init', 'ultra_native_hello'];
  const otherNames = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  for (const name of [...privateSpellings, ...otherNames]) {
    const result = await b.call(name, fabricated({ sessionId: `desktop-${privateSpellings.indexOf(name)}` }));
    assert.equal(result.isError, true, `Desktop answered ${JSON.stringify(name)}: ${result.text.slice(0, 80)}`);
  }
  for (const name of [['ultra_native_init'], { startsWith: true }, 42, null]) {
    assert.equal((await b.call(name, fabricated())).isError, true, `non-string tool name ${JSON.stringify(name)}`);
  }
  // Modern per-request metadata, a wrong protocol version, and an unsupported batch envelope.
  const meta = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } };
  assert.equal((await b.call('ultra_native_init', fabricated(), { ...meta })).isError, true);
  const wrong = await b.call('ultra_native_init', fabricated(), { _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } });
  assert.equal(wrong.isError, true); assert.equal(wrong.rpcError?.code, -32022);
  b.send([{ jsonrpc: '2.0', id: 9001, method: 'tools/call', params: { name: 'ultra_native_init', arguments: fabricated() } }]);
  assert.equal((await b.request('tools/list', {})).id, b.id, 'a batch array is ignored, not executed');
  assert.deepEqual(b.unsolicited, [], 'no stray response to the ignored batch');
  const listed = (await b.request('tools/list', {})).result.tools.map(tool => tool.name);
  assert.ok(!listed.some(name => name.includes('native')));
  assert.equal(await f.ledger(), before, 'the Desktop facade left no durable trace');
});

test('transport: Desktop Chat refuses every spelling of the private namespace as that namespace, before reading policy', async t => {
  const f = await fixture(t), b = f.open(DESKTOP);
  for (const name of ['ultra_native_init', 'ULTRA_NATIVE_INIT', ' ultra_native_init', 'ultra_native_init\u0000', '\uff55ltra_native_init', 'ultra\u200b_native_init', 'ultra-native-init', 'ultra.native.init', 'ultra_native_hello']) {
    const result = await b.call(name, fabricated());
    assert.match(result.text, /Private native control operations are not available/, `${JSON.stringify(name)}: ${result.text.slice(0, 80)}`);
  }
  await writeFile(join(f.dir, 'ultra-policy.json'), '{ not json');
  assert.match((await b.call('ULTRA_NATIVE_INIT', fabricated())).text, /Private native control/, 'the refusal does not depend on a readable owner policy');
});

test('transport: the Desktop public facade cannot operate on a native mission', async t => {
  const f = await fixture(t), code = f.bridge(), victim = await mod(t, f, code), desktop = f.open(DESKTOP);
  assert.ok(live(await victim.ultra()));
  const before = await f.ledger();
  for (const [name, args] of [['ultra_diagnostics', { mission_id: victim.missionId }], ['ultra_cancel', { mission_id: victim.missionId }],
    ['ultra_recruit', { mission_id: victim.missionId, worker: 'astra', task: 'Launder native authority', risk, request_key: 'launder' }],
    ['ultra_start', { task: 'Take over', mission_id: victim.missionId }]]) {
    assert.equal((await desktop.call(name, args)).isError, true, `${name} reached a native mission`);
  }
  assert.equal(await f.ledger(), before);
  assert.ok(live(await victim.ultra()));
});

test('transport: the Code bridge answers only its advertised tools and the self-authenticating private namespace', async t => {
  const f = await fixture(t), b = f.bridge(), before = await f.ledger();
  for (const name of ['ultra_start', 'ultra_diagnostics', 'ultra_recruit', 'ultra_step', 'constructor', '__proto__', 'ULTRA_NATIVE_INIT']) {
    const result = await b.call(name, { task: 'x', mission_id: 'public-on-code-bridge' });
    assert.equal(result.isError, true, `${name}: ${result.text.slice(0, 80)}`);
  }
  assert.equal(await f.ledger(), before);
});

// ---------------------------------------------------------------------------
// The owner-key authenticator itself: signer/verifier agreement and adversarial input.

const SIGNED_AT = 1_700_000_000_000;
function unit({ windowMs, maxNonces } = {}) {
  const keyHex = randomBytes(32).toString('hex'), clock = { now: SIGNED_AT };
  const channel = new NativeChannel({ key: Buffer.from(keyHex, 'hex'), now: () => clock.now, ...(windowMs && { windowMs }), ...(maxNonces && { maxNonces }) });
  const sign = (name, args, over = {}) => signRequest({ keyHex, epoch: channel.epoch, name, args, now: clock.now, ...over });
  return { keyHex, clock, channel, sign };
}
const refusal = fn => { try { fn(); } catch (error) { return error; } assert.fail('the request was admitted'); };

test('channel: the mod-side HMAC matches RFC 4231 and node:crypto, and the canonical form is order- and undefined-insensitive', async () => {
  const text = value => new TextEncoder().encode(value);
  assert.equal(bytesToHex(await hmacSha256(text('Jefe'), text('what do ya want for nothing?'))), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  assert.equal(bytesToHex(await hmacSha256(new Uint8Array(131).fill(0xaa), text('Test Using Larger Than Block-Size Key - Hash Key First'))), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  for (const size of [0, 1, 55, 56, 63, 64, 65, 1000, 70000]) {
    const key = randomBytes(32), message = randomBytes(size);
    assert.equal(bytesToHex(await hmacSha256(key, message)), createHmac('sha256', key).update(message).digest('hex'), `message length ${size}`);
  }
  assert.equal(canonicalJson({ b: 1, a: { d: [1, undefined, 'x'], c: undefined, e: null } }), canonicalJson({ a: { e: null, d: [1, null, 'x'] }, b: 1 }));
  assert.equal(canonicalJson({ n: -0, s: '\u00e9"', t: true }), '{"n":0,"s":"\u00e9\\"","t":true}');
  for (const bad of [NaN, Infinity, -Infinity, 10n]) assert.throws(() => canonicalJson({ bad }), /number|Unsupported/);
  assert.equal(canonicalJson({ f: () => 1, s: Symbol('x'), u: undefined }), '{}', 'members JSON.stringify drops are dropped identically');
});

test('channel: a request signed by the mod code verifies in the production channel, survives a JSON round trip, and is single use', async () => {
  const u = unit(), args = { sessionId: 's', capability: 'c'.repeat(64), hostAgentId: undefined, input: { z: [1, { y: undefined, x: '\u00e9' }], a: null } };
  const wire = JSON.parse(JSON.stringify(await u.sign('ultra_native_diagnostics', args)));
  const { payload } = u.channel.verify('ultra_native_diagnostics', wire);
  assert.deepEqual(payload, JSON.parse(JSON.stringify(args)));
  assert.ok(refusal(() => u.channel.verify('ultra_native_diagnostics', wire)).message.startsWith(CHANNEL_REJECTED), 'the same bytes cannot be admitted twice');
});

test('channel: tampering with any signed element, or malforming the envelope, gives one uniform refusal that discloses nothing', async () => {
  const u = unit(), other = unit(), name = 'ultra_native_admit', args = { sessionId: 's', capability: 'c'.repeat(64), prompt: 'x' };
  const fresh = async () => JSON.parse(JSON.stringify(await u.sign(name, args)));
  const mutations = {
    'changed argument': r => { r.prompt = 'y'; }, 'added argument': r => { r.extra = 1; }, 'removed argument': r => { delete r.prompt; },
    'retargeted session': r => { r.sessionId = 'other'; }, 'changed epoch': r => { r.channel.epoch = '0'.repeat(32); },
    'changed nonce': r => { r.channel.nonce = randomBytes(16).toString('hex'); }, 'changed timestamp': r => { r.channel.ts += 1; },
    'flipped mac': r => { r.channel.mac = (r.channel.mac[0] === 'a' ? 'b' : 'a') + r.channel.mac.slice(1); }, 'uppercase mac': r => { r.channel.mac = r.channel.mac.toUpperCase(); },
    'short mac': r => { r.channel.mac = r.channel.mac.slice(2); }, 'non-hex mac': r => { r.channel.mac = 'z'.repeat(64); }, 'numeric mac': r => { r.channel.mac = 7; },
    'extra envelope field': r => { r.channel.admin = true; }, 'wrong version': r => { r.channel.v = 2; }, 'string timestamp': r => { r.channel.ts = String(r.channel.ts); },
    'envelope removed': r => { delete r.channel; }, 'envelope null': r => { r.channel = null; }, 'envelope array': r => { r.channel = [r.channel]; },
    'envelope string': r => { r.channel = 'trusted'; },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const request = await fresh(); mutate(request);
    const error = refusal(() => u.channel.verify(name, request));
    assert.ok(error instanceof ChannelDenied && error.message === CHANNEL_DENIED, `${label}: ${error.message}`);
    assert.ok(!JSON.stringify(error).includes(u.keyHex));
  }
  const foreign = JSON.parse(JSON.stringify(await other.sign(name, args, { epoch: u.channel.epoch })));
  assert.equal(refusal(() => u.channel.verify(name, foreign)).message, CHANNEL_DENIED, 'signed with another key');
  for (const [label, bad] of Object.entries({ 'renamed operation': ['ultra_native_cancel', await fresh()], 'non-string name': [['x'], await fresh()], 'array arguments': [name, [await fresh()]], 'null arguments': [name, null], 'string arguments': [name, 'x'] })) {
    assert.equal(refusal(() => u.channel.verify(...bad)).message, CHANNEL_DENIED, label);
  }
  assert.equal(u.channel.nonces.size, 0, 'a refused request records nothing, so refused garbage cannot exhaust or poison the replay window');
  assert.ok(u.channel.verify(name, await fresh()).payload, 'the untampered original is still admitted');
});

test('channel: only a holder of the key learns that a request was stale, replayed or outside the clock window, and none is admitted', async () => {
  const u = unit({ windowMs: 60000, maxNonces: 2 }), name = 'ultra_native_diagnostics';
  const stale = await signRequest({ keyHex: u.keyHex, epoch: randomBytes(16).toString('hex'), name, args: { sessionId: 's' }, now: u.clock.now });
  assert.ok(refusal(() => u.channel.verify(name, stale)).message.startsWith(CHANNEL_STALE));
  for (const skew of [61000, -61000]) {
    const skewed = await u.sign(name, { sessionId: 's' }, { now: u.clock.now + skew });
    assert.ok(refusal(() => u.channel.verify(name, skewed)).message.startsWith(CHANNEL_REJECTED), `skew ${skew}`);
  }
  const a = await u.sign(name, { sessionId: 'a' }), b = await u.sign(name, { sessionId: 'b' }), c = await u.sign(name, { sessionId: 'c' });
  u.channel.verify(name, a); u.channel.verify(name, b);
  assert.match(refusal(() => u.channel.verify(name, c)).message, /saturated/, 'a full replay window fails closed');
  u.clock.now += 200000; // expired entries are pruned so capacity returns, while the old request is now outside its window
  assert.ok(refusal(() => u.channel.verify(name, a)).message.startsWith(CHANNEL_REJECTED));
  assert.ok(u.channel.verify(name, await u.sign(name, { sessionId: 'd' })).payload);
});

test('channel: hello is signed like every request, needs no epoch, answers only the epoch and cannot be replayed', async () => {
  const u = unit(), hello = await signRequest({ keyHex: u.keyHex, epoch: HELLO_EPOCH, name: CHANNEL_HELLO, args: {}, now: u.clock.now });
  assert.deepEqual(u.channel.verify(CHANNEL_HELLO, hello).payload, {});
  assert.deepEqual(u.channel.hello(), { v: 1, epoch: u.channel.epoch });
  assert.ok(refusal(() => u.channel.verify(CHANNEL_HELLO, hello)).message.startsWith(CHANNEL_REJECTED), 'a replayed hello is refused');
  const notHello = await signRequest({ keyHex: u.keyHex, epoch: HELLO_EPOCH, name: 'ultra_native_diagnostics', args: { sessionId: 's' }, now: u.clock.now });
  assert.ok(refusal(() => u.channel.verify('ultra_native_diagnostics', notHello)).message.startsWith(CHANNEL_STALE), 'the epoch exemption is for hello alone');
  assert.equal(refusal(() => u.channel.verify(CHANNEL_HELLO, { channel: { ...hello.channel, mac: 'a'.repeat(64) } })).message, CHANNEL_DENIED);
});

test('channel: verification tokens cannot be forged, reused, retargeted or taken from another channel', async () => {
  const u = unit(), v = unit(), name = 'ultra_native_diagnostics';
  const first = u.channel.verify(name, await u.sign(name, { sessionId: 's' }));
  assert.throws(() => u.channel.admit(true, name, first.payload), new RegExp(NOT_MEDIATED));
  assert.throws(() => u.channel.admit({ kind: 'ultra-native-verified-request' }, name, first.payload), /mediated/);
  assert.throws(() => u.channel.admit(Object.freeze({ ...first.verified }), name, first.payload), /mediated/);
  assert.throws(() => u.channel.admit(first.verified, 'ultra_native_cancel', first.payload), /mediated/, 'bound to its operation');
  assert.throws(() => u.channel.admit(first.verified, name, { ...first.payload }), /mediated/, 'bound to its exact argument object');
  assert.throws(() => v.channel.admit(first.verified, name, first.payload), /mediated/, 'bound to its channel');
  assert.deepEqual(u.channel.admit(first.verified, name, first.payload), { epoch: u.channel.epoch, keyId: u.channel.keyId });
  assert.throws(() => u.channel.admit(first.verified, name, first.payload), /mediated/, 'single use');
});

// ---------------------------------------------------------------------------
// Controller semantics behind the authenticator (real NativeController, real ledger).

async function controllerFixture(t, { config = {} } = {}) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'ultra-transport-ctl-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(join(dir, 'ledger.json')), broker = new RecruitmentBroker(store, { config: { enabled: true, ...config } });
  const backend = async () => { throw new Error('No provider call is expected'); }; backend.offline = true;
  const open = keyHex => nativeTransport(new NativeController(broker, { backend }), keyHex ? { keyHex } : {});
  const fingerprint = async () => createHash('sha256').update(await readFile(store.path)).digest('hex');
  const init = (host, sessionId = 'ctl-session', extra = {}) => host.signed('ultra_native_init', { sessionId, model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false, ...extra });
  const recruit = async (host, opened, sessionId = 'ctl-session', toolUseId = 'ctl-spawn') => {
    const common = { sessionId, capability: opened.capability, primaryModel: 'opus', parentModel: 'opus' };
    const admitted = await host.signed('ultra_native_admit', { ...common, toolUseId, subagentType: 'openai-workers:luna', prompt: taskPrompt() });
    await host.signed('ultra_native_bind', { ...common, toolUseId, nodeId: admitted.nodeId, hostAgentId: `agent-${toolUseId}` });
    return { ...admitted, hostAgentId: `agent-${toolUseId}` };
  };
  return { dir, store, broker, backend, open, init, recruit, fingerprint };
}

test('controller: a bound controller rejects the old boolean assertion, lookalike tokens and a retargeted session', async t => {
  const c = await controllerFixture(t), host = c.open();
  const opened = await c.init(host), before = await c.fingerprint();
  for (const transport of [{ trustedHostChannel: true }, {}, undefined, { verified: { kind: 'ultra-native-verified-request' } }, { verified: true }]) {
    await assert.rejects(() => host.gateway.fixed.handle('ultra_native_diagnostics', { sessionId: 'ctl-session', capability: opened.capability }, transport), /mediated/);
  }
  const signed = JSON.parse(JSON.stringify(await signRequest({ keyHex: host.keyHex, epoch: host.channel.epoch, name: 'ultra_native_diagnostics', args: { sessionId: 'ctl-session', capability: opened.capability } })));
  signed.sessionId = 'another-session';
  assert.ok(refusal(() => host.channel.verify('ultra_native_diagnostics', signed)) instanceof ChannelDenied, 'a signed request cannot be pointed at another session');
  assert.equal(await c.fingerprint(), before);
  assert.throws(() => host.gateway.fixed.bindChannel(unit().channel), /another channel/, 'a bound controller cannot be rebound to a weaker authenticator');
});

test('controller: one session cannot borrow another session capability, bindings or epoch', async t => {
  const c = await controllerFixture(t), host = c.open();
  const a = await c.init(host, 'session-a'), b = await c.init(host, 'session-b');
  const worker = await c.recruit(host, a, 'session-a', 'spawn-a');
  const before = await c.fingerprint();
  await assert.rejects(() => host.signed('ultra_native_diagnostics', { sessionId: 'session-b', capability: a.capability }), /capability/);
  await assert.rejects(() => host.signed('ultra_native_context', { sessionId: 'session-b', capability: b.capability, hostAgentId: worker.hostAgentId }), /binding|agent/i);
  await assert.rejects(() => host.signed('ultra_native_cancel', { sessionId: 'session-a', capability: b.capability }), /capability/);
  assert.equal(await c.fingerprint(), before, 'every refused borrow left the ledger byte-identical');
  assert.equal((await host.signed('ultra_native_diagnostics', { sessionId: 'session-a', capability: a.capability })).nativeBindings.length, 1);
});

test('controller: an open session rotates only with its current capability; after a restart the owner key reopens it and blocks running work', async t => {
  const c = await controllerFixture(t), host = c.open();
  const first = await c.init(host), worker = await c.recruit(host, first);
  const before = await c.fingerprint();
  await assert.rejects(() => c.init(host), /current capability/);
  await assert.rejects(() => c.init(host, 'ctl-session', { currentCapability: 'f'.repeat(64) }), /current capability/);
  assert.equal(await c.fingerprint(), before, 'a refused rotation writes nothing');
  const rotated = await c.init(host, 'ctl-session', { currentCapability: first.capability });
  assert.notEqual(rotated.capability, first.capability);
  await assert.rejects(() => host.signed('ultra_native_diagnostics', { sessionId: 'ctl-session', capability: first.capability }), /capability/);
  assert.equal((await c.store.snapshot(rotated.missionId)).nodes[worker.nodeId].status, 'blocked', 'any fresh handshake holds native work whose host side may have gone');

  // A new bridge process: new controller and epoch over the same ledger and owner key.
  const restarted = c.open(host.keyHex);
  assert.notEqual(restarted.channel.epoch, host.channel.epoch);
  await assert.rejects(() => restarted.signed('ultra_native_diagnostics', { sessionId: 'ctl-session', capability: rotated.capability }), new RegExp(SESSION_CLOSED), 'authority does not silently continue into a new process');
  const reopened = await c.init(restarted);
  assert.equal(reopened.missionId, rotated.missionId);
  await assert.rejects(() => restarted.signed('ultra_native_diagnostics', { sessionId: 'ctl-session', capability: rotated.capability }), /capability/);
  const mission = await c.store.snapshot(reopened.missionId);
  assert.match(mission.nodes[worker.nodeId].recoveryReason, /restarted/);
  const events = (await c.store.read()).events.filter(e => e.type === 'native.channel');
  assert.deepEqual(events.map(e => [e.data.authenticated, e.data.reopened]), [[true, false], [true, true], [true, true]]);
  assert.equal(events.at(-1).data.previousEpoch, host.channel.epoch);
});

test('controller: a mission opened under another owner key, or before the channel existed, can never be reopened', async t => {
  const c = await controllerFixture(t), host = c.open();
  await c.init(host, 'keyed-session');
  const keyed = await c.fingerprint();
  await assert.rejects(() => c.init(c.open(), 'keyed-session'), /different owner channel key/);
  assert.equal(await c.fingerprint(), keyed);
  // A legacy mission (created by the unauthenticated protocol) carries no key binding: fail closed.
  await new NativeController(c.broker, { backend: c.backend }).handle('ultra_native_init', { sessionId: 'legacy-session', model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false }, { trustedHostChannel: true });
  const legacy = await c.fingerprint();
  await assert.rejects(() => c.init(host, 'legacy-session'), /different owner channel key/);
  assert.equal(await c.fingerprint(), legacy);
});

test('controller: concurrent duplicates of one signed request execute exactly once', async t => {
  const c = await controllerFixture(t), host = c.open(), opened = await c.init(host);
  const request = await signRequest({ keyHex: host.keyHex, epoch: host.channel.epoch, name: 'ultra_native_diagnostics', args: { sessionId: 'ctl-session', capability: opened.capability } });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => host.gateway.call('ultra_native_diagnostics', structuredClone(request))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.message.startsWith(CHANNEL_REJECTED)));
});

test('controller: an unauthenticated flood leaves no replay state and does not delay a genuine request', async t => {
  const c = await controllerFixture(t), host = c.open(), opened = await c.init(host), recorded = host.channel.nonces.size;
  for (let i = 0; i < 500; i++) {
    const forged = { sessionId: 'ctl-session', capability: opened.capability, channel: { v: 1, epoch: host.channel.epoch, nonce: randomBytes(16).toString('hex'), ts: Date.now(), mac: randomBytes(32).toString('hex') } };
    assert.ok(refusal(() => host.channel.verify('ultra_native_diagnostics', forged)) instanceof ChannelDenied);
  }
  assert.equal(host.channel.nonces.size, recorded, 'refused requests record no nonce');
  assert.ok(Array.isArray((await host.signed('ultra_native_diagnostics', { sessionId: 'ctl-session', capability: opened.capability })).nativeBindings));
});

// ---------------------------------------------------------------------------
// Fail-closed provisioning, revocation and the in-process dispatcher.

async function captured(fn) {
  const original = process.stderr.write; let stderr = '';
  process.stderr.write = chunk => { stderr += chunk; return true; };
  try { return { value: await fn(), stderr }; } finally { process.stderr.write = original; }
}
async function stateDirectory(t, { enabled = true, policy = {} } = {}) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'ultra-transport-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { OPENAI_ULTRA_STATE_DIR: dir, OPENAI_ULTRA_CONFIG: join(dir, 'ultra-policy.json'), OPENAI_WORKER_USAGE_DIR: join(dir, 'usage'), ...(enabled && { OPENAI_ULTRA_ENABLED: '1' }) };
  await writeOwnerConfig(resolveConfig({ enabled: true, ...policy }), env);
  return { dir, env, file: join(dir, KEY_FILE) };
}
const validKey = () => randomBytes(32).toString('hex');
/** A signed hello: the only way to learn a bridge epoch. */
const helloFor = async (env, keyHex) => dispatch(CHANNEL_HELLO, await signRequest({ keyHex, epoch: HELLO_EPOCH, name: CHANNEL_HELLO, args: {} }), { env });

test('fail closed: without a usable owner key, or with ULTRA not enabled, every caller gets the same refusal and nothing is written', async t => {
  const posixOnly = process.platform === 'win32' ? { skip: true } : {};
  const scenarios = {
    'no key file': { reason: /no owner channel key/ },
    'malformed key': { reason: /malformed/, write: file => writeFile(file, 'not a key\n', { mode: 0o600 }) },
    'low-entropy key': { reason: /malformed/, write: file => writeFile(file, `${'0'.repeat(64)}\n`, { mode: 0o600 }) },
    'oversized file': { reason: /oversized/, write: file => writeFile(file, `${validKey()}\n${'x'.repeat(400)}`, { mode: 0o600 }) },
    'directory in place of the file': { reason: /not a regular file/, write: file => mkdir(file) },
    'ULTRA not enabled for this process': { enabled: false, write: file => writeFile(file, `${validKey()}\n`, { mode: 0o600 }) },
    'readable by other users': { ...posixOnly, reason: /readable by other users/, write: async file => { await writeFile(file, `${validKey()}\n`); await chmod(file, 0o644); } },
    'symbolic link to a valid key': { ...posixOnly, reason: /not a regular file/, write: async (file, dir) => { await writeFile(join(dir, 'real.key'), `${validKey()}\n`, { mode: 0o600 }); await symlink(join(dir, 'real.key'), file); } },
  };
  for (const [label, scenario] of Object.entries(scenarios)) {
    if (scenario.skip) continue;
    const s = await stateDirectory(t, { enabled: scenario.enabled !== false });
    await scenario.write?.(s.file, s.dir);
    const signingKey = validKey();
    const attempts = [['ultra_native_hello', {}], ['ultra_native_init', await signRequest({ keyHex: signingKey, epoch: '0'.repeat(32), name: 'ultra_native_init', args: fabricated() })], ['ultra_native_init', fabricated()]];
    const { value, stderr } = await captured(async () => {
      const outcomes = [];
      for (const [name, args] of attempts) { try { await dispatch(name, args, { env: s.env }); outcomes.push('ACCEPTED'); } catch (error) { outcomes.push(error.message); } }
      return outcomes;
    });
    assert.deepEqual(value, [CHANNEL_DENIED, CHANNEL_DENIED, CHANNEL_DENIED], label);
    if (scenario.reason) assert.match(stderr, scenario.reason, `${label}: the owner is told why on stderr`);
    assert.ok(!stderr.includes(signingKey), `${label}: no secret in diagnostics`);
    assert.equal(await ledgerFingerprint(s.dir), 'absent', `${label}: no ULTRA service or ledger was even created`);
  }
});

test('revocation: rotating or deleting the key closes the channel at once, and a new key never inherits an old epoch or session', async t => {
  const s = await stateDirectory(t), options = { env: s.env };
  const first = await provisionChannelKey(s.env), key1 = (await readFile(first.path, 'utf8')).trim();
  assert.match(key1, /^[0-9a-f]{64}$/);
  const one = signedDispatcher(dispatch, options, key1), epoch1 = (await helloFor(s.env, key1)).epoch;
  const opened = await one('ultra_native_init', fabricated({ sessionId: 'rotating-session' }));
  assert.ok((await one('ultra_native_diagnostics', { sessionId: 'rotating-session', capability: opened.capability })).nativeBindings);
  const rotated = await provisionChannelKey(s.env, { rotate: true }), key2 = (await readFile(rotated.path, 'utf8')).trim();
  assert.notEqual(key1, key2);
  assert.deepEqual((await readdir(s.dir)).filter(name => name.endsWith('.tmp')), [], 'rotation leaves no temporary key file');
  const before = await ledgerFingerprint(s.dir);
  const epoch2 = (await helloFor(s.env, key2)).epoch;
  assert.notEqual(epoch2, epoch1, 'a new key is a new channel');
  await assert.rejects(() => helloFor(s.env, key1), error => error.message === CHANNEL_DENIED, 'the old key cannot even say hello');
  await assert.rejects(() => one('ultra_native_diagnostics', { sessionId: 'rotating-session', capability: opened.capability }), error => error.message === CHANNEL_DENIED, 'the old key no longer authenticates');
  const two = signedDispatcher(dispatch, options, key2);
  await assert.rejects(() => two('ultra_native_init', fabricated({ sessionId: 'rotating-session' })), /different owner channel key/, 'a session opened under the old key cannot be reopened');
  await assert.rejects(() => two('ultra_native_diagnostics', { sessionId: 'rotating-session', capability: opened.capability }), /key|closed|capability/i);
  assert.equal(await ledgerFingerprint(s.dir), before, 'refusals wrote nothing');
  assert.ok((await two('ultra_native_init', fabricated({ sessionId: 'fresh-session' }))).capability, 'a new session opens under the new key');
  await rm(first.path);
  const { value } = await captured(() => helloFor(s.env, key2).then(() => 'ACCEPTED', error => error.message));
  assert.equal(value, CHANNEL_DENIED, 'deleting the key file disables the channel without a restart');
});

test('authenticated callers get a specific refusal when owner policy is disabled, and nothing is written', async t => {
  const s = await stateDirectory(t, { policy: { enabled: false } }), key = (await readFile((await provisionChannelKey(s.env)).path, 'utf8')).trim();
  await assert.rejects(() => signedDispatcher(dispatch, { env: s.env }, key)('ultra_native_init', fabricated()), /Owner ULTRA policy is disabled/);
  assert.equal(await ledgerFingerprint(s.dir), 'absent');
});

test('dispatcher: even hello needs the key, and the exported stdio handler refuses private requests without proof', async t => {
  const s = await stateDirectory(t), key = (await readFile((await provisionChannelKey(s.env)).path, 'utf8')).trim();
  const hello = await helloFor(s.env, key);
  assert.deepEqual(Object.keys(hello).sort(), ['epoch', 'v']); assert.match(hello.epoch, /^[0-9a-f]{32}$/);
  for (const bare of [{}, { whatever: 1 }]) await assert.rejects(() => dispatch(CHANNEL_HELLO, bare, { env: s.env }), error => error.message === CHANNEL_DENIED, 'an unauthenticated hello is not answered');
  const written = []; const write = message => written.push(message);
  await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ultra_native_init', arguments: fabricated() } }, write);
  await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ultra_native_init', arguments: [fabricated()] } }, write);
  await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ultra_start', arguments: { task: 'public op on the code bridge' } } }, write);
  await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: ['ultra_native_init'], arguments: {} } }, write);
  await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: null }, write);
  await handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'ultra_native_init', arguments: fabricated() } }, write);
  await handle([{ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ultra_native_init', arguments: fabricated() } }], write);
  await handle(null, write); await handle('tools/call', write);
  assert.deepEqual(written.map(m => m.id), [1, 2, 3, 4, 5], 'notifications and batch envelopes are ignored');
  assert.ok(written.every(m => m.result?.isError === true));
  assert.equal(written[0].result.content[0].text, CHANNEL_DENIED);
  assert.equal(written[2].result.content[0].text, 'Unknown bridge tool');
  assert.equal(await ledgerFingerprint(s.dir), 'absent');
  const disabled = await captured(() => helloFor({ ...s.env, OPENAI_ULTRA_ENABLED: undefined }, key).then(() => 'ACCEPTED', e => e.message));
  assert.equal(disabled.value, CHANNEL_DENIED, 'hello also needs ULTRA enabled');
});

// ---------------------------------------------------------------------------
// The real mod hook module against the real stdio bridge.

test('mod: the legitimate protected flow works end to end over real stdio, every private request is signed and the key never leaves the mod', async t => {
  const f = await fixture(t), b = f.bridge(), m = await mod(t, f, b);
  assert.ok(live(await m.ultra()), 'session.start opened the session through hello + signed init');
  const child = await m.spawn('luna'); assert.ok(child.agentId, child.deny);
  const diagnostics = await m.execute(undefined, tool('diagnostics'), {}, 'root-diagnostics');
  const state = JSON.parse(diagnostics.result);
  assert.equal(state.orchestrator.model, 'opus'); assert.equal(state.nativeBindings.length, 1);
  assert.ok((await m.execute(child.agentId, 'Bash', { command: 'echo no' }, 'worker-shell')).deny, 'the worker still cannot use arbitrary shell');
  assert.match(await m.ultra('review unknown-author'), /ULTRA HOLD/, 'a controller refusal on the authenticated path is reported, not hidden');
  assert.ok(live(await m.ultra('cancel')));
  assert.equal((await readLedger(f.dir)).missions[m.missionId].status, 'cancelled');
  const natives = m.sent.filter(c => c.name.startsWith('ultra_native_'));
  assert.ok(natives.length >= 8);
  for (const call of natives) assert.deepEqual(Object.keys(call.args.channel).sort(), ['epoch', 'mac', 'nonce', 'ts', 'v'], `${call.name} is signed`);
  assert.equal(new Set(natives.map(c => c.args.channel.nonce)).size, natives.length, 'every nonce is fresh');
  const everything = JSON.stringify(m.sent) + b.log.join('\n') + b.stderr;
  assert.ok(!everything.includes(f.keyHex), 'the owner key appears in no request, response or log');
  const capability = m.sent.find(c => c.name === 'ultra_native_diagnostics').args.capability;
  assert.equal(b.log.join('\n').split(capability).length - 1, 1, 'the session capability crosses the wire once, in the init response to the mod');
  assert.ok(!b.log.join('\n').includes(m.sent.at(-1).args.channel.mac), 'no signature is ever echoed');
});

test('mod: the host-side name guard denies model-origin private calls without reaching the bridge, and is not the control', async t => {
  const f = await fixture(t), b = f.bridge(), m = await mod(t, f, b), calls = m.sent.length;
  for (const name of ['mcp__plugin_openai-workers_bridge__ultra_native_init', 'MCP__X__ULTRA_NATIVE_INIT', 'mcp__x__ultra-native-init', 'mcp__x__ultra\u200b_native_init', 'mcp__x__\uff55ltra_native_init']) {
    assert.equal((await m.run('tool.check', { tool: name, input: {} }, async () => ({ decision: 'allow' }))).decision, 'deny', name);
    assert.ok((await m.run('tool.run', { tool: name }, async () => ({ result: 'BAD' }))).deny, name);
  }
  assert.equal(m.sent.length, calls, 'the guard answered locally');
  assert.equal(isPrivateBridgeTool('mcp__github__create_issue'), false); assert.equal(isPrivateBridgeTool('Bash'), false); assert.equal(isPrivateBridgeTool(undefined), false);
  const before = await f.ledger();
  assert.equal((await b.call('ultra_native_init', fabricated({ sessionId: 'hooks-bypassed' }))).isError, true, 'with every hook bypassed the dispatcher still refuses');
  assert.equal(await f.ledger(), before);
});

test('mod: a bridge restart is recognised as stale, the session is reopened once by owner-key proof, and running work is held', async t => {
  const f = await fixture(t), holder = { current: f.bridge(), call(...args) { return this.current.call(...args); } };
  const m = await mod(t, f, holder), child = await m.spawn('luna'); assert.ok(child.agentId, child.deny);
  const first = (await readLedger(f.dir)).missions[m.missionId];
  await holder.current.close(); holder.current = f.bridge();
  const text = await m.ultra();
  assert.ok(live(text), text);
  assert.deepEqual(m.sent.slice(-4).map(c => c.name), ['ultra_native_diagnostics', 'ultra_native_hello', 'ultra_native_init', 'ultra_native_diagnostics'], 'one refused stale call, one reopen, one retry');
  assert.ok(m.sent.filter(c => c.name === 'ultra_native_init').at(-1).args.currentCapability, 'a live mod proves its previous capability');
  const after = (await readLedger(f.dir)).missions[m.missionId];
  assert.notEqual(after.native.epoch, first.native.epoch); assert.notEqual(after.native.capabilityHash, first.native.capabilityHash);
  assert.equal(Object.values(after.nodes).find(n => n.adapter === 'native').status, 'blocked', 'native work is held, never assumed alive');
  assert.ok(live(await m.ultra()));
});

test('mod: a second mod instance for a live session (lost closure) is refused and the live session is undisturbed', async t => {
  const f = await fixture(t), b = f.bridge(), first = await mod(t, f, b);
  assert.ok(live(await first.ultra()));
  const before = await f.ledger(), second = await mod(t, f, b);
  assert.match(await second.ultra(), /ULTRA is HOLD: .*already open/);
  assert.match((await second.spawn('luna')).deny, /held/);
  assert.equal(await f.ledger(), before, 'the refused reopen wrote nothing');
  assert.ok(live(await first.ultra()), 'the genuine session keeps its capability');
});

test('mod: a missing, unreadable or malformed owner key holds ULTRA instead of falling back, and sends nothing', async t => {
  const f = await fixture(t, { key: false }), b = f.bridge(), m = await mod(t, f, b);
  assert.match(await m.ultra(), /ULTRA is HOLD: .*owner channel key is not readable/);
  assert.match((await m.spawn('luna')).deny, /held/);
  assert.deepEqual(m.sent, [], 'nothing, not even hello, is sent without a key');
  await writeFile(f.keyFile, 'garbage\n', { mode: 0o600 });
  const malformed = await mod(t, f, b);
  assert.match(await malformed.ultra(), /malformed/); assert.deepEqual(malformed.sent, []);
  assert.equal(await f.ledger(), 'absent');
});

test('mod: a key rotated mid-session turns into a HOLD, never an unsigned fallback; reopening needs the matching key', async t => {
  const f = await fixture(t), b = f.bridge(), m = await mod(t, f, b);
  assert.ok(live(await m.ultra()));
  await provisionChannelKey(f.env, { rotate: true });
  const text = await m.ultra();
  assert.match(text, /^ULTRA HOLD: .*not authenticated/);
  assert.ok(!text.includes(f.keyHex));
  assert.ok(m.sent.slice(-1)[0].args.channel, 'the refused request was still signed, never downgraded');
  const reopened = await mod(t, f, b, { sessionId: 'victim-session' });
  assert.match(await reopened.ultra(), /different owner channel key/);
  assert.ok(live(await (await mod(t, f, b, { sessionId: 'after-rotation' })).ultra()), 'a new session opens under the new key');
});

// ---------------------------------------------------------------------------
// Portability, agreement between mod and bridge, and owner provisioning.

test('portability: the signing module and the mod never import Node, use dynamic import, or hand the host to an imported helper', async () => {
  const channelSource = await readFile(join(root, 'hooks', 'channel.js'), 'utf8'), modSource = await readFile(join(root, 'hooks', 'register.js'), 'utf8');
  const code = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const [label, source] of [['channel.js', code(channelSource)], ['register.js', code(modSource)]]) {
    assert.ok(!/from\s+['"]node:/.test(source) && !/\brequire\s*\(/.test(source) && !/\bimport\s*\(/.test(source) && !/\bprocess\./.test(source), `${label} must run in the non-Node mod VM`);
  }
  assert.ok(!/(^|[^\w$])\$\s*[.[(,)]/.test(code(channelSource)), 'channel.js never touches the host object');
  assert.ok(!/\b(signRequest|modKeyPath|parseChannelKey|canonicalJson)\(\s*\$/.test(modSource), 'the host object is never passed to an imported helper');
  assert.ok(!/crypto\.subtle\.(importKey|sign|verify|generateKey|deriveBits)/.test(channelSource), 'only the declared digest primitive is used');
});

test('agreement: the mod and the bridge resolve the same owner key file for every supported configuration', async t => {
  const dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-transport-path-'))); t.after(() => rm(dir, { recursive: true, force: true }));
  const windows = process.platform === 'win32', same = (values, env) => assert.equal(resolve(modKeyPath({ ...values, windows })), keyFilePath(env), JSON.stringify(values));
  same({ file: join(dir, 'elsewhere', 'my.key') }, { OPENAI_ULTRA_CHANNEL_KEY_FILE: join(dir, 'elsewhere', 'my.key') });
  same({ state: dir }, { OPENAI_ULTRA_STATE_DIR: dir });
  same({ state: dir, file: join(dir, 'x.key') }, { OPENAI_ULTRA_STATE_DIR: dir, OPENAI_ULTRA_CHANNEL_KEY_FILE: join(dir, 'x.key') });
  same({ state: '${user_config.state}', localAppData: dir, xdgState: dir, home: dir }, { OPENAI_ULTRA_STATE_DIR: '${user_config.state}', LOCALAPPDATA: dir, XDG_STATE_HOME: dir, HOME: dir, USERPROFILE: dir });
  assert.equal(modKeyPath({ windows: false }), null, 'an undecidable location fails closed rather than guessing');
  const sample = '0123456789abcdef'.repeat(4);
  assert.equal(parseChannelKey(`${sample}\n`), sample); assert.equal(parseChannelKey(sample.toUpperCase()), sample);
  for (const bad of ['', 'abc', '0'.repeat(64), 'g'.repeat(64), `${validKey()}00`, undefined, 7]) assert.equal(parseChannelKey(bad), null, String(bad));
});

test('provisioning: the owner key is created private, never overwritten silently, rotated atomically and never printed', async t => {
  const s = await stateDirectory(t), printed = [];
  const created = await provisionChannelKey(s.env);
  assert.deepEqual([created.created, created.rotated, created.path], [true, false, s.file]);
  const text = await readFile(s.file, 'utf8'); assert.match(text, /^[0-9a-f]{64}\n$/); assert.ok(parseChannelKey(text));
  if (process.platform !== 'win32') assert.equal((await stat(s.file)).mode & 0o777, 0o600);
  await assert.rejects(() => provisionChannelKey(s.env), /already exists/);
  assert.equal(await readFile(s.file, 'utf8'), text, 'a refused re-provision keeps the key');
  const loaded = await loadChannelKey(s.env); assert.equal(loaded.key.toString('hex'), text.trim()); assert.equal(loaded.path, s.file);
  await provisionCli(['--rotate'], { env: s.env, print: line => printed.push(line) });
  assert.notEqual(await readFile(s.file, 'utf8'), text);
  assert.ok(!printed.join('\n').includes(text.trim()) && !printed.join('\n').includes((await readFile(s.file, 'utf8')).trim()), 'the key is never displayed');
  await assert.rejects(() => provisionCli(['--bogus'], { env: s.env, print: () => {} }), /Unknown option/);
  const script = join(root, 'scripts', 'provision-ultra-channel.mjs');
  const run = args => execFileAsync(process.execPath, [script, ...args], { env: { ...process.env, OPENAI_ULTRA_STATE_DIR: s.dir }, windowsHide: true });
  assert.equal((await run(['--print-path'])).stdout.trim(), s.file);
  await assert.rejects(() => run([]), error => /already exists/.test(error.stderr) && error.code === 1);
});

test('mod: switching to another session and back inside one mod instance proves the held capability instead of being refused', async t => {
  const f = await fixture(t), b = f.bridge(), m = await mod(t, f, b);
  assert.ok(live(await m.ultra()));
  await m.switchSession('second-session'); assert.match(await m.ultra(), /second-session|native-/);
  const other = (await readLedger(f.dir)).missions[`native-${digest('second-session').slice(0, 32)}`].native.capabilityHash;
  await m.switchSession('victim-session');
  assert.ok(live(await m.ultra()), 'the first session is reopened');
  const inits = m.sent.filter(c => c.name === 'ultra_native_init');
  assert.deepEqual(inits.map(c => Boolean(c.args.currentCapability)), [false, false, true]);
  assert.equal((await readLedger(f.dir)).missions[`native-${digest('second-session').slice(0, 32)}`].native.capabilityHash, other, 'the other session was not touched');
});
