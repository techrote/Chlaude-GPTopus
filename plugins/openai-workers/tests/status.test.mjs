import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from '../hooks/register.js';
import { usageSnapshot, usagePath, reserveRequest, releaseRequest, quoteRequest } from '../bridge/usage.mjs';

/** Runs the REAL /openai-workers handler against the REAL ledger snapshot and returns its text. */
async function commandText(env, now) {
  const handlers = new Map();
  register((event, filter, handler) => { if (typeof filter === 'function') handler = filter; handlers.set(event, handler); });
  const $ = {
    agent: { list: async () => [], register: async () => {} },
    env: { get: async () => undefined },
    mcp: { call: async (_server, name) => {
      const data = name === 'health' ? { standard: { configured: true, source: 'environment' }, free: { configured: true, source: 'environment' } }
        : name === 'usage' ? await usageSnapshot({ env, now }) : null;
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } },
    command: { register: async () => {} },
  };
  return (await handlers.get('command.run')($, {})).text;
}

function v1Ledger(dir, env) {
  const stats = { tokens: 100, estimatedUsd: 0.02, requests: 1 };
  const doc = { version: 1, days: { '2026-11-02': { groups: { premium: stats }, workers: { 'daily-astrafree': stats }, totalEstimatedUsd: 0.02 } }, pending: {}, processed: {} };
  writeFileSync(usagePath(env), JSON.stringify(doc));
}

test('/openai-workers shows the monthly limit and the unreconciled v1-history scope it is documented to show', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'status-cmd-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { OPENAI_WORKER_USAGE_DIR: dir, OPENAI_WORKER_DAILY_RESERVE_TOKENS: '10' }, now = new Date('2026-11-21T01:00:00Z');
  v1Ledger(dir, base);
  const quoted = quoteRequest({ model: 'gpt-6-astra', input: 'x' });
  await releaseRequest(await reserveRequest({ workerType: 'daily-astrafree', model: 'gpt-6-astra', ...quoted }, { env: base, now }), { env: base, now }); // performs the v1 upgrade

  const unlimited = await commandText(base, now);
  assert.match(unlimited, /Monthly spend limit: NOT set/);
  assert.match(unlimited, /Ledger upgraded from v1 .*Unreconciled months: 2026-11; not enforced because no monthly limit is set/);

  const limited = await commandText({ ...base, OPENAI_WORKER_MONTHLY_LIMIT_USD: '50' }, now);
  assert.match(limited, /Monthly spend limit: \$50 local estimate across both keys; \$0\.02 committed/);
  assert.match(limited, /the current month is BLOCKED until the owner reconciles it/);
  assert.match(limited, /owner action in a local terminal/);
});

test('/openai-workers says nothing about v1 history on a ledger that was never upgraded', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'status-cmd-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const text = await commandText({ OPENAI_WORKER_USAGE_DIR: dir }, new Date('2026-11-21T01:00:00Z'));
  assert.doesNotMatch(text, /upgraded from v1/);
  assert.match(text, /Monthly spend limit: NOT set/);
});
