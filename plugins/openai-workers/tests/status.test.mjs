import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from '../hooks/register.js';
import { usageSnapshot, usagePath, reserveRequest, releaseRequest, quoteRequest } from '../bridge/usage.mjs';

/** Runs the REAL /oai handler against the REAL ledger snapshot and returns its text. */
async function commandText(env, now) {
  const handlers = new Map();
  // The real registration API chains `.catch(...)` fallbacks, so the fake host must return a chainable registration.
  register((event, filter, handler) => {
    if (typeof filter === 'function') { handler = filter; filter = null; }
    handlers.set(filter?.command ? `${event}:${filter.command}` : event, handler);
    return { catch() { return this; } };
  });
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
  await handlers.get('session.start')($, {}, async () => {}); // bootstrap as the host does: ULTRA is not enabled here, so no signed channel is established
  // The panel wraps long notes inside its frame: flatten borders and line breaks before matching.
  const text = (await handlers.get('command.run:oai')($, {})).text;
  for (const line of text.split('\n')) assert.ok([...line].length <= 100, `status line wider than 100 columns: ${line}`);
  return text.split('\n').map(line => line.replace(/^║ ?|║$/g, '').trim()).join(' ').replace(/\s+/g, ' ');
}

function v1Ledger(dir, env) {
  const stats = { tokens: 100, estimatedUsd: 0.02, requests: 1 };
  const doc = { version: 1, days: { '2026-11-02': { groups: { premium: stats }, workers: { 'astra6free': stats }, totalEstimatedUsd: 0.02 } }, pending: {}, processed: {} };
  writeFileSync(usagePath(env), JSON.stringify(doc));
}

test('/oai shows the monthly limit and the unreconciled v1-history scope it is documented to show', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'status-cmd-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { OPENAI_WORKER_USAGE_DIR: dir, OPENAI_WORKER_DAILY_RESERVE_TOKENS: '10' }, now = new Date('2026-11-21T01:00:00Z');
  v1Ledger(dir, base);
  const quoted = quoteRequest({ model: 'gpt-6-astra', input: 'x' });
  await releaseRequest(await reserveRequest({ workerType: 'astra6free', model: 'gpt-6-astra', ...quoted }, { env: base, now }), { env: base, now }); // performs the v1 upgrade

  const unlimited = await commandText(base, now);
  assert.match(unlimited, /spend limit not set \(OPENAI_WORKER_MONTHLY_LIMIT_USD\)/);
  assert.match(unlimited, /Ledger upgraded from v1 .*Unreconciled months: 2026-11; not enforced because no monthly limit is set/);

  const limited = await commandText({ ...base, OPENAI_WORKER_MONTHLY_LIMIT_USD: '50' }, now);
  assert.match(limited, /Monthly spend limit: \$50 local estimate across both keys; \$0\.02 committed/);
  assert.match(limited, /the current month is BLOCKED until the owner reconciles it/);
  assert.match(limited, /owner action in a local terminal/);
});

test('/oai says nothing about v1 history on a ledger that was never upgraded', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'status-cmd-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const text = await commandText({ OPENAI_WORKER_USAGE_DIR: dir }, new Date('2026-11-21T01:00:00Z'));
  assert.doesNotMatch(text, /upgraded from v1/);
  assert.match(text, /spend limit not set \(OPENAI_WORKER_MONTHLY_LIMIT_USD\)/);
});
