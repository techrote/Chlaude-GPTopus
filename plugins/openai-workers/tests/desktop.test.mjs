import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invoke, definitions, handleMessage } from '../bridge/desktop-server.mjs';
import { workerSettings } from '../bridge/workers.mjs';
import { dispatch } from '../bridge/server.mjs';
import { configuredKey } from '../bridge/openai.mjs';
import { usageSnapshot, usagePath } from '../bridge/usage.mjs';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pluginRoot, '../..');
const manifest = JSON.parse(readFileSync(join(repoRoot, 'desktop-extension/manifest.json'), 'utf8'));
const targetEnv = { OPENAI_API_KEY: 'test-standard-key', OPENAI_FREE_API_KEY: 'test-free-key' };

function fakeBackend(calls) {
  return async (name, args) => {
    calls.push({ name, args });
    if (name === 'create') return { id: 'resp_abc1234', status: 'in_progress' };
    if (name === 'poll') return { id: args.id, status: 'completed', text: 'Peer review findings', usage: { input: 50, output: 20, total: 70 }, serviceTier: 'default' };
    if (name === 'cancel') return { id: args.id, status: 'cancelled' };
    if (name === 'usage') return { utcDay: '2026-11-21', groups: { premium: {}, terra: {} } };
    throw Error('Unexpected backend call');
  };
}

test('Claude Desktop manifest declares sensitive two-key configuration and built-in Node runtime', () => {
  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.entry_point, 'server/desktop-server.mjs');
  assert.equal(manifest.server.mcp_config.env.OPENAI_API_KEY, '${user_config.straight_api_key}');
  assert.equal(manifest.server.mcp_config.env.OPENAI_FREE_API_KEY, '${user_config.free_api_key}');
  assert.equal(manifest.user_config.straight_api_key.sensitive, true);
  assert.equal(manifest.user_config.free_api_key.sensitive, true);
  assert.equal(manifest.privacy_policies.length > 0, true);
  assert.equal(definitions.length, 5);
});

test('Desktop worker profiles preserve eight native agent defaults and correct two-key tier routing', () => {
  const expected = [
    ['sol6-2', 'gpt-6.2-sol', undefined, 'standard'],
    ['astra6-2', 'gpt-6.2-astra', undefined, 'standard'],
    ['luna6', 'gpt-6-luna', undefined, 'standard'],
    ['luna6fast', 'gpt-6-luna', 'fast', 'standard'],
    ['luna6flex', 'gpt-6-luna', 'flex', 'standard'],
    ['sol6-1flex', 'gpt-6.1-sol', 'flex', 'standard'],
    ['astra6free', 'gpt-6-astra', 'default', 'free'],
    ['terra5-6free', 'gpt-5.6-terra', 'default', 'free'],
  ];
  for (const [name, model, tier, key] of expected) {
    const actual = workerSettings(name, targetEnv);
    assert.equal(actual.model, model);
    assert.equal(actual.service_tier, tier);
    assert.equal(actual.key_profile, key);
  }
  assert.equal(workerSettings('sol6-1flex', { ...targetEnv, OPENAI_WORKER_SOL6_1FLEX_MODEL: 'gpt-6.1-sol', OPENAI_WORKER_SOL6_1FLEX_SERVICE_TIER: 'priority' }).service_tier, 'priority');
  assert.equal(workerSettings('sol6-2', { ...targetEnv, OPENAI_WORKER_SERVICE_TIER: 'fast' }).service_tier, 'fast');
  assert.equal(workerSettings('astra6free', { ...targetEnv, OPENAI_WORKER_SERVICE_TIER: 'fast' }).service_tier, 'default');
});

test('Desktop can list agents and key presence without disclosing secrets', async () => {
  const response = await invoke('list_openai_workers', {}, fakeBackend([]), targetEnv);
  assert.equal(response.workers.length, 8);
  assert.equal(response.keys.free, true);
  assert.equal(response.keys.standard, true);
  assert(!JSON.stringify(response).includes('test-standard-key'));
  assert(!JSON.stringify(response).includes('test-free-key'));
});

test('Desktop delegation carries worker, tier, separate context and no file tools', async () => {
  const calls = [];
  const started = await invoke('ask_openai_worker', { worker: 'sol6-1flex', task: 'Review architecture', context: 'source snippet', reasoning_effort: 'medium' }, fakeBackend(calls), targetEnv);
  assert.equal(started.status, 'in_progress');
  assert.match(started.next_step, /poll_openai_worker/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'create');
  assert.equal(calls[0].args.service_tier, 'flex');
  assert.equal(calls[0].args.model, 'gpt-6.1-sol');
  assert.equal(calls[0].args.worker_type, 'sol6-1flex');
  assert.deepEqual(calls[0].args.tools, []);
  assert.match(JSON.stringify(calls[0].args.input), /source snippet/);
  assert.match(calls[0].args.instructions, /NO file system/);
});

test('Desktop follow-up, polling, cancellation and ledger tools preserve worker identity', async () => {
  const calls = [];
  const backend = fakeBackend(calls);
  const replied = await invoke('poll_openai_worker', { worker: 'terra5-6free', response_id: 'resp_abc1234' }, backend, targetEnv);
  assert.equal(replied.answer, 'Peer review findings');
  assert.equal(calls[0].args.worker_type, 'terra5-6free');
  await invoke('cancel_openai_worker', { worker: 'astra6free', response_id: 'resp_abc1234' }, backend, targetEnv);
  assert.equal(calls[1].args.worker_type, 'astra6free');
  const usage = await invoke('openai_worker_daily_usage', {}, backend, targetEnv);
  assert.equal(usage.utcDay, '2026-11-21');
  const follow = await invoke('ask_openai_worker', { worker: 'sol6-2', task: 'Continue', previous_response_id: 'resp_abc1234' }, backend, targetEnv);
  assert.equal(follow.status, 'in_progress');
  assert.equal(calls[3].args.previous_response_id, 'resp_abc1234');
});

test('Unknown workers and malformed IDs fail closed without API calls', async () => {
  const calls = [];
  const backend = fakeBackend(calls);
  await assert.rejects(invoke('ask_openai_worker', { worker: 'admin', task: 'hi' }, backend, targetEnv), /Unknown worker/);
  await assert.rejects(invoke('ask_openai_worker', { worker: 'sol6-2', task: '' }, backend, targetEnv), /task must/);
  await assert.rejects(invoke('poll_openai_worker', { worker: 'sol6-2', response_id: '../../secret' }, backend, targetEnv), /Invalid response ID/);
  await assert.rejects(invoke('ask_openai_worker', { worker: 'sol6-2', task: 'x', max_output_tokens: 999999 }, backend, targetEnv), /max_output_tokens/);
  assert.equal(calls.length, 0);
});

test('MCP initialize, list, tool call, error handling and notifications are protocol-correct', async () => {
  const out = [];
  const write = str => out.push(JSON.parse(str));
  const backend = fakeBackend([]);
  await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, write, backend, targetEnv);
  await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, write, backend, targetEnv);
  await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_openai_workers', arguments: {} } }, write, backend, targetEnv);
  await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ask_openai_worker', arguments: { worker: 'bad', task: 'x' } } }, write, backend, targetEnv);
  await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, write, backend, targetEnv);
  assert.equal(out.length, 4);
  assert.equal(out[0].result.serverInfo.name, 'chlaude-gptopus-desktop');
  assert.equal(out[1].result.tools.length, 5);
  assert.equal(JSON.parse(out[2].result.content[0].text).workers.length, 8);
  assert.equal(out[3].result.isError, true);
});

test('MCP 2026-07-28 discovery, metadata and version rejection are protocol-correct', async () => {
  const out = [];
  const write = str => out.push(JSON.parse(str));
  const backend = fakeBackend([]);
  const meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  await handleMessage({ jsonrpc: '2.0', id: 10, method: 'server/discover', params: { _meta: meta } }, write, backend, targetEnv);
  await handleMessage({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: { _meta: meta } }, write, backend, targetEnv);
  await handleMessage({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { _meta: meta, name: 'list_openai_workers', arguments: {} } }, write, backend, targetEnv);
  await handleMessage({ jsonrpc: '2.0', id: 13, method: 'tools/list', params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } }, write, backend, targetEnv);
  assert.deepEqual(out[0].result.supportedVersions, ['2026-07-28']);
  assert.equal(out[0].result.resultType, 'complete');
  assert.equal(out[0].result.cacheScope, 'public');
  assert.equal(out[0].result._meta['io.modelcontextprotocol/serverInfo'].name, 'chlaude-gptopus-desktop');
  assert.equal(out[1].result.tools.length, 5);
  assert.equal(out[1].result.resultType, 'complete');
  assert.equal(out[1].result.ttlMs, 3600000);
  assert.equal(out[2].result.resultType, 'complete');
  assert.equal(JSON.parse(out[2].result.content[0].text).workers.length, 8);
  assert.equal(out[3].error.code, -32022);
  assert.deepEqual(out[3].error.data.supported, ['2026-07-28']);
});

test('Unsupported legacy initialize versions are counter-offered at the latest handshake revision', async () => {
  const out = [];
  await handleMessage(
    { jsonrpc: '2.0', id: 20, method: 'initialize', params: { protocolVersion: '1900-01-01' } },
    str => out.push(JSON.parse(str)),
    fakeBackend([]),
    targetEnv,
  );
  assert.equal(out[0].result.protocolVersion, '2025-11-25');
});

test('Desktop and native mod share the same on-disk daily usage ledger, never the straight key', async () => {
  const path = mkdtempSync(join(tmpdir(), 'gptopus-desktop-'));
  const prevFetch = globalThis.fetch;
  const old = Object.fromEntries(['OPENAI_WORKER_USAGE_DIR', 'OPENAI_API_KEY', 'OPENAI_FREE_API_KEY'].map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, { OPENAI_WORKER_USAGE_DIR: path, OPENAI_API_KEY: 'standard-test', OPENAI_FREE_API_KEY: 'free-test' });
    const headers = [];
    globalThis.fetch = async (_url, req) => {
      headers.push(req.headers.Authorization);
      const body = JSON.parse(req.body);
      return { ok: true, json: async () => ({ id: `resp_mock${headers.length}1234`, status: 'completed', model: body.model,
        service_tier: body.service_tier, usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Test answer' }] }] }) };
    };
    await invoke('ask_openai_worker', { worker: 'astra6free', task: 'hello' }, dispatch);
    await invoke('ask_openai_worker', { worker: 'terra5-6free', task: 'hello' }, dispatch);
    await invoke('ask_openai_worker', { worker: 'sol6-2', task: 'hello' }, dispatch);
    assert.deepEqual(headers, ['Bearer free-test', 'Bearer free-test', 'Bearer standard-test']);
    const ledger = await usageSnapshot();
    assert.equal(ledger.groups.premium.usedTokens, 1200);
    assert.equal(ledger.groups.terra.usedTokens, 1200);
    assert.equal(ledger.groups.premium.softLimitTokens, 275000);
    assert.equal(ledger.groups.terra.softLimitTokens, 2750000);
    assert.equal(existsSync(usagePath()), true);
  } finally {
    globalThis.fetch = prevFetch;
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(path, { recursive: true, force: true });
  }
});

test('Desktop MCPB builder generates a complete self-contained ZIP with the declared entry point', () => {
  const path = mkdtempSync(join(tmpdir(), 'gptopus-mcpb-'));
  try {
    const artifact = join(path, 'desktop.mcpb');
    execFileSync(process.execPath, [join(repoRoot, 'scripts/build-desktop.mjs'), artifact], { stdio: 'pipe' });
    const buffer = readFileSync(artifact);
    execFileSync(process.execPath, [join(repoRoot, 'scripts/build-desktop.mjs'), '--check', artifact], { stdio: 'pipe' });
    const second = join(path, 'desktop-second.mcpb');
    execFileSync(process.execPath, [join(repoRoot, 'scripts/build-desktop.mjs'), second], { stdio: 'pipe' });
    assert.deepEqual(readFileSync(second), buffer);
    assert.equal(buffer.readUInt32LE(0), 0x04034b50);
    assert(buffer.includes(Buffer.from('manifest.json')));
    assert(buffer.includes(Buffer.from('server/desktop-server.mjs')));
    assert(buffer.includes(Buffer.from('server/usage.mjs')));
    assert(buffer.includes(Buffer.from('scripts/read-openai-key.ps1')));
    const eocd = buffer.length - 22;
    assert.equal(buffer.readUInt32LE(eocd), 0x06054b50);
    assert(buffer.readUInt16LE(eocd + 10) >= 20, 'bundle contains the shared executable policy/runtime');
    for (const required of ['ultra/service.mjs', 'ultra/runtime.mjs', 'ultra/permissions.mjs', 'bridge/workers.mjs', 'bridge/usage.mjs', 'hooks/ultra.js', 'package.json']) assert(buffer.includes(Buffer.from(required)), `missing ${required}`);
  } finally { rmSync(path, { recursive: true, force: true }); }
});


test('Optional missing MCPB key placeholders are never mistaken for credentials', () => {
  const env = { OPENAI_API_KEY: '${user_config.straight_api_key}', OPENAI_FREE_API_KEY: '${user_config.free_api_key}' };
  assert.equal(configuredKey(env, 'standard'), null);
  assert.equal(configuredKey(env, 'free'), null);
});
