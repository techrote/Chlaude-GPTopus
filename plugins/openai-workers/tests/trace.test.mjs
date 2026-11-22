import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { traceEnabled, traceDir, traceFile, redact, writeTrace, traceRequest, traceResponse } from '../bridge/trace.mjs';
import { formatRecord, formatLine, parseArgs } from '../scripts/oai-trace.mjs';
import { dispatch } from '../bridge/server.mjs';

const scratch = t => { const dir = mkdtempSync(join(tmpdir(), 'oai-trace-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const records = file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('trace is off unless OAI_TRACE is set, and then writes nothing', t => {
  const dir = scratch(t), env = { OAI_TRACE_DIR: dir };
  assert.equal(traceEnabled(env), false);
  assert.equal(writeTrace({ kind: 'request' }, { env }), false);
  assert.equal(existsSync(traceFile(env)), false);
  assert.equal(traceEnabled({ OAI_TRACE: '1' }), true);
});

test('trace location: Windows LOCALAPPDATA, XDG state elsewhere, OAI_TRACE_DIR override; one file per UTC day', () => {
  assert.equal(traceDir({ LOCALAPPDATA: 'C:\\L' }, 'win32'), join('C:\\L', 'ClaudeOpenAIWorkers', 'trace'));
  assert.equal(traceDir({ XDG_STATE_HOME: '/s' }, 'linux'), join('/s', 'claude-openai-workers', 'trace'));
  assert.equal(traceDir({ HOME: '/h' }, 'linux'), join('/h', '.local', 'state', 'claude-openai-workers', 'trace'));
  assert.equal(traceDir({ OAI_TRACE_DIR: '/x', LOCALAPPDATA: 'C:\\L' }, 'win32'), '/x');
  assert.equal(traceFile({ OAI_TRACE_DIR: '/x' }, new Date('2026-11-22T23:59:59Z')), join('/x', '2026-11-22.jsonl'));
});

test('trace writer appends request and response records as JSONL', t => {
  const dir = scratch(t), env = { OAI_TRACE: '1', OAI_TRACE_DIR: dir }, now = new Date('2026-11-22T10:00:00Z');
  assert.equal(traceRequest({ name: 'luna6flex' }, { model: 'gpt-6-luna', service_tier: 'flex', effort: 'max', instructions: 'Be useful',
    input: [{ role: 'user', content: 'hello' }, { type: 'function_call_output', call_id: 'c1', output: 'file text' }], tools: [{ type: 'function', name: 'Read' }, { name: 'Bash' }] }, { env, now }), true);
  traceResponse('luna6flex', { id: 'resp_abcd1234', status: 'completed', model: 'gpt-6-luna', serviceTier: 'flex', text: 'done',
    calls: [{ call_id: 'c2', name: 'Read', args: { file_path: '/a' } }], usage: { input: 10, cached: 0, output: 5, total: 15 }, estimatedUsd: 0.0001 }, { env, now });
  const [req, res] = records(join(dir, '2026-11-22.jsonl'));
  assert.deepEqual({ kind: req.kind, worker: req.worker, model: req.model, tier: req.tier, effort: req.effort, tools: req.tools, instructions: req.instructions },
    { kind: 'request', worker: 'luna6flex', model: 'gpt-6-luna', tier: 'flex', effort: 'max', tools: ['Read', 'Bash'], instructions: 'Be useful' });
  assert.equal(req.time, '2026-11-22T10:00:00.000Z');
  assert.equal(req.input[1].output, 'file text');
  assert.deepEqual({ id: res.id, status: res.status, text: res.text, toolCalls: res.toolCalls, estimatedUsd: res.estimatedUsd, total: res.usage.total },
    { id: 'resp_abcd1234', status: 'completed', text: 'done', toolCalls: [{ name: 'Read', call_id: 'c2', args: { file_path: '/a' } }], estimatedUsd: 0.0001, total: 15 });
});

test('trace redaction: configured keys, key-shaped strings and secret fields never reach the file', t => {
  const dir = scratch(t), key = 'sk-proj-THISISASECRETVALUE1234567890', free = 'a-free-key-value-0987654321';
  const env = { OAI_TRACE: '1', OAI_TRACE_DIR: dir, OPENAI_API_KEY: key, OPENAI_FREE_API_KEY: free };
  writeTrace({ kind: 'request', input: `my key is ${key} and ${free}`, headers: { Authorization: `Bearer ${key}` }, api_key: 'zzz',
    nested: [{ note: 'sk-otherLooking0123456789abcdef' }] }, { env });
  const text = readFileSync(traceFile(env), 'utf8');
  for (const secret of [key, free, 'zzz', 'sk-otherLooking0123456789abcdef']) assert.equal(text.includes(secret), false, secret);
  assert.match(text, /\[redacted\]/);
  const r = redact({ authorization: 'x', token: 'y', ok: 'fine' }, {});
  assert.deepEqual(r, { authorization: '[redacted]', token: '[redacted]', ok: 'fine' });
});

test('bridge create/poll write trace records through a fake transport (no network, no real key)', async t => {
  const dir = scratch(t), usage = scratch(t);
  const env = { ...process.env, OAI_TRACE: '1', OAI_TRACE_DIR: dir, OPENAI_WORKER_USAGE_DIR: usage, OPENAI_API_KEY: 'sk-test-not-a-real-key-000000000' };
  const response = { id: 'resp_trace0001', status: 'completed', model: 'gpt-6-luna', serviceTier: 'fast', text: 'pong', calls: [],
    usage: { input: 3, cached: 0, output: 2, total: 5 }, usageStatus: 'verified', estimatedUsd: 0.000001 };
  const transport = { create: async () => response, poll: async () => response, cancel: async () => response };
  await dispatch('create', { worker_type: 'luna6fast', model: 'gpt-6-luna', input: 'ping', instructions: 'Reply', tools: [{ name: 'Read' }] }, { env, transport });
  await dispatch('poll', { worker_type: 'luna6fast', id: 'resp_trace0001', wait_ms: 0 }, { env, transport });
  const recs = records(traceFile(env));
  assert.deepEqual(recs.map(r => r.kind), ['request', 'response', 'response']);
  assert.equal(recs[0].tier, 'fast'); assert.equal(recs[0].worker, 'luna6fast'); assert.equal(recs[0].input, 'ping');
  assert.equal(recs[1].text, 'pong');
  assert.equal(readFileSync(traceFile(env), 'utf8').includes('sk-test-not-a-real-key'), false);
});

test('legacy worker names still route: old ledger records are renamed on load and old worker_type is accepted', async t => {
  const usage = scratch(t), env = { ...process.env, OPENAI_WORKER_USAGE_DIR: usage, OPENAI_API_KEY: 'sk-test-not-a-real-key-000000000', OPENAI_FREE_API_KEY: 'free-test-key-0000000000' };
  const day = new Date().toISOString().slice(0, 10);
  const stats = { tokens: 100, estimatedUsd: 0.01, requests: 1 };
  writeFileSync(join(usage, 'free-usage-ledger.json'), JSON.stringify({ version: 2, days: { [day]: { groups: { premium: stats },
    workers: { 'daily-astrafree': { ...stats }, astra6free: { ...stats }, sol: { ...stats } }, totalEstimatedUsd: 0.03 } },
  pending: {}, processed: { resp_legacy0001: { day, workerType: 'daily-astrafree', model: 'gpt-6-astra', profile: 'free', tokens: 100, contextTokenUpperBound: 100, estimatedUsd: 0.01, serviceTier: 'default', usageStatus: 'verified' } },
  months: {}, requests: {}, releases: {}, reconciliations: [], baselines: {} }));
  const response = { id: 'resp_new000001', status: 'completed', model: 'gpt-6.2-sol', serviceTier: null, text: 'ok', calls: [],
    usage: { input: 1, cached: 0, output: 1, total: 2 }, usageStatus: 'verified', estimatedUsd: 0.00001 };
  const transport = { create: async () => response, poll: async () => ({ ...response, id: 'resp_legacy0001', model: 'gpt-6-astra' }), cancel: async () => response };
  // Old name 'sol' is accepted and becomes sol6-2.
  await dispatch('create', { worker_type: 'sol', model: 'gpt-6.2-sol', input: 'hi', instructions: 'x', tools: [] }, { env, transport });
  // A response recorded under 'daily-astrafree' is still owned by astra6free.
  await dispatch('poll', { worker_type: 'daily-astrafree', id: 'resp_legacy0001', wait_ms: 0 }, { env, transport });
  const snapshot = await dispatch('usage', {}, { env, transport });
  assert.equal(snapshot.groups.premium.usedTokens, 100);
  const doc = JSON.parse(readFileSync(join(usage, 'free-usage-ledger.json'), 'utf8'));
  assert.deepEqual(Object.keys(doc.days[day].workers).sort(), ['astra6free', 'sol6-2']);
  assert.equal(doc.days[day].workers.astra6free.tokens, 200);
  assert.equal(doc.processed.resp_legacy0001.workerType, 'astra6free');
});

test('trace viewer: argument parsing and readable request/response rendering', () => {
  assert.deepEqual(parseArgs(['--all', '--no-color']), { all: true, date: null, dir: null, full: false, follow: true, color: false });
  assert.equal(parseArgs(['--date', '2026-11-20']).all, true);
  assert.throws(() => parseArgs(['--date', 'yesterday']), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
  const req = formatRecord({ kind: 'request', time: '2026-11-22T10:00:00.000Z', worker: 'sol6-2', model: 'gpt-6.2-sol', tier: 'auto', effort: 'high',
    tools: ['Read'], instructions: 'Rules', input: [{ role: 'user', content: 'Fix it' }, { type: 'function_call_output', call_id: 'c1', output: 'ok' }] });
  assert.match(req, /▶ REQUEST\s+2026-11-22 10:00:00\s+sol6-2/);
  assert.match(req, /┌ user\n\s+Fix it/);
  assert.match(req, /tool result c1/);
  const res = formatRecord({ kind: 'response', worker: 'sol6-2', status: 'failed', reason: 'rate limit', toolCalls: [{ name: 'Bash', args: { command: 'ls' } }], text: '' }, { color: true });
  assert.match(res, /\u001b\[91m/);
  assert.match(res, /rate limit/);
  assert.match(formatLine('{not json', {}), /unparsable/);
  assert.equal(formatLine('   ', {}), null);
});

test('settle: failed or cancelled responses without usage release their reservation as failed-without-usage; incomplete stays held', async t => {
  const { reserveRequest, accountResponse, usageSnapshot, quoteRequest } = await import('../bridge/usage.mjs');
  const dir = scratch(t), env = { OPENAI_WORKER_USAGE_DIR: dir }, quote = quoteRequest({ model: 'gpt-6-astra', input: 'x' });
  const outcome = async (status, n) => {
    const ticket = await reserveRequest({ workerType: 'astra6free', model: 'gpt-6-astra', ...quote }, { env });
    await accountResponse(ticket, { id: `resp_settle000${n}`, status, model: 'gpt-6-astra', usage: null, usageStatus: 'unknown', estimatedUsd: null }, { env });
    return ticket;
  };
  const failed = await outcome('failed', 1), cancelled = await outcome('cancelled', 2), incomplete = await outcome('incomplete', 3);
  const doc = JSON.parse(readFileSync(join(dir, 'free-usage-ledger.json'), 'utf8'));
  assert.equal(doc.releases[failed].reason, 'failed-without-usage');
  assert.equal(doc.releases[cancelled].reason, 'failed-without-usage');
  assert.equal(doc.pending[failed], undefined); assert.equal(doc.pending[cancelled], undefined);
  assert.equal(doc.pending[incomplete].status, 'usage_unknown');
  const snap = await usageSnapshot({ env });
  assert.equal(snap.groups.premium.usedTokens, 0);
  assert.equal(snap.groups.premium.reservedTokens, doc.pending[incomplete].reservedTokens);
});

test('free-ledger reservation counts at most 128000 input tokens plus max_output_tokens', async t => {
  const { reserveRequest, FREE_RESERVATION_INPUT_CAP } = await import('../bridge/usage.mjs');
  const dir = scratch(t), env = { OPENAI_WORKER_USAGE_DIR: dir };
  assert.equal(FREE_RESERVATION_INPUT_CAP, 128000);
  const big = { reservationTokens: 366000, reservationUsd: 1, inputTokens: 350000, outputTokens: 16000 };
  const ticket = await reserveRequest({ workerType: 'terra5-6free', model: 'gpt-5.6-terra', ...big }, { env });
  const small = await reserveRequest({ workerType: 'terra5-6free', model: 'gpt-5.6-terra', reservationTokens: 20000, reservationUsd: 1, inputTokens: 4000, outputTokens: 16000 }, { env });
  const doc = JSON.parse(readFileSync(join(dir, 'free-usage-ledger.json'), 'utf8'));
  assert.equal(doc.pending[ticket].reservedTokens, 144000);
  assert.equal(doc.pending[small].reservedTokens, 20000);
});
