import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderStatus, bar, clip, visibleLength, table, WIDTH } from '../hooks/status-art.js';
import { WORKER_TYPES, effortPolicy } from '../bridge/workers.mjs';

export function sampleData(overrides = {}) {
  return {
    now: new Date('2026-11-22T09:30:00Z'), version: '0.8.0', color: false,
    keys: [{ label: 'straight (OPENAI_API_KEY)', configured: true, source: 'Windows DPAPI' },
      { label: 'free (OPENAI_FREE_API_KEY)', configured: false, source: 'none' }],
    workers: Object.entries(WORKER_TYPES).map(([name, spec]) => ({ name, model: spec.model, key: spec.key, tier: spec.defaultTier ?? 'auto', effort: effortPolicy(name, {}) })),
    usage: { utcDay: '2026-11-22', resetAtUtc: '2026-11-23T00:00:00.000Z', overrunPercent: 10,
      groups: { premium: { usedTokens: 120000, reservedTokens: 12000, softLimitTokens: 275000, dailyTargetTokens: 250000 },
        terra: { usedTokens: 2400000, reservedTokens: 0, softLimitTokens: 2750000, dailyTargetTokens: 2500000 } },
      monthlyEstimatedUsd: 3.4567, monthlyCommittedUsd: 5.2, monthlyLimitUsd: null, monthlyAllowanceUsd: 8 },
    usageError: null, notes: ['Monthly spend limit: NOT set; the local ledger does not block requests on cost.'],
    ultra: { enabled: false, state: '' },
    active: [{ type: 'oai:luna6flex', status: 'running', description: 'Summarise the README and list three improvements for the maintainers' }],
    ...overrides,
  };
}

test('status panel: every line is exactly the frame width (<= 100) and has the expected sections', () => {
  const text = renderStatus(sampleData());
  const lines = text.split('\n');
  assert.ok(WIDTH <= 100);
  for (const line of lines) assert.equal(visibleLength(line), WIDTH, `bad width: ${JSON.stringify(line)}`);
  for (const title of ['KEYS', 'WORKERS', 'FREE QUOTA', 'MONTH', 'ULTRA', 'ACTIVE']) assert.match(text, new RegExp(`▓▒░ ${title}`));
  for (const name of Object.keys(WORKER_TYPES)) assert.match(text, new RegExp(`║ ${name.replace(/[-]/g, '\\-')}\\s`));
  assert.match(text, /luna6fast\s+gpt-6-luna\s+straight\s+fast\s+max\.\.max \(max\)/);
  assert.match(text, /astra6free\s+gpt-6-astra\s+free\s+default\s+medium\.\.max \(high\)/);
  assert.match(text, /● online\s+Windows DPAPI/);
  assert.match(text, /○ missing\s+not configured/);
  assert.match(text, /▰+▱+\s+48%/); // premium: 132000 / 275000
  assert.match(text, /\/oai:a <worker> \[low\|medium\|high\|xhigh\|max\] <task>/);
  assert.doesNotMatch(text, /\u001b\[/, 'plain mode must not emit ANSI escapes');
});

test('status panel: colour mode adds ANSI escapes without changing the visible layout', () => {
  const plain = renderStatus(sampleData()), coloured = renderStatus(sampleData({ color: true }));
  assert.match(coloured, /\u001b\[\d/);
  assert.equal(coloured.replace(/\u001b\[[0-9;]*m/g, ''), plain);
});

test('status panel: errors, missing usage, ULTRA text and empty activity render inside the frame', () => {
  const text = renderStatus(sampleData({ usage: null, usageError: 'ledger unreadable '.repeat(12), notes: [],
    workers: [{ name: 'sol6-2', error: 'Invalid OPENAI_WORKER_SOL6_2_EFFORT_MIN: ultra' }],
    ultra: { enabled: true, state: 'HOLD: native channel unavailable' }, active: [] }));
  for (const line of text.split('\n')) assert.equal(visibleLength(line), WIDTH);
  assert.match(text, /CONFIG ERROR/);
  assert.match(text, /usage unavailable: ledger unreadable/);
  assert.match(text, /HOLD: native channel unavailable/);
  assert.match(text, /no OpenAI workers dispatched/);
});

test('status helpers: bar, clip and table are bounded', () => {
  assert.equal(bar(0, 100, 5), '▱▱▱▱▱');
  assert.equal(bar(60, 100, 5), '▰▰▰▱▱');
  assert.equal(bar(500, 100, 5), '▰▰▰▰▰');
  assert.equal(bar(5, 0, 3), '▱▱▱');
  assert.equal(clip('abcdef', 4), 'abc…');
  const rows = table(['a', 'b'], [['x', 'y'.repeat(300)]], (_s, t) => t);
  for (const row of rows) assert.ok(visibleLength(row) <= WIDTH - 4);
});

test('status renderer is a pure module: no host ($) access or I/O imports', () => {
  const source = readFileSync(new URL('../hooks/status-art.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\$\.[a-z]+\./);
  assert.doesNotMatch(source, /^import /m);
});

if (process.env.OAI_STATUS_PREVIEW === '1') console.log(renderStatus(sampleData({ color: process.env.OAI_STATUS_COLOR === '1' })));
