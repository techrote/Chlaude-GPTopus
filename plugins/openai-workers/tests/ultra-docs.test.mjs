// DOC-01 and docs-versus-code drift guards. These do not judge prose; they pin the facts that went stale or false in review:
// frozen-tree figures must carry their scope, qualification numbers must be derived rather than hard-coded for the tip, and
// every CLI command the documentation tells an owner to run must exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP } from '../ultra/cli.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const doc = name => readFile(join(repo, 'docs', name), 'utf8');

test('DOC-01: documents that quote frozen-tree test counts or bundle hashes say that they do not qualify the current head', async () => {
  for (const name of ['ULTRA_INDEPENDENT_REVIEW.md', 'ULTRA_ARCHITECTURE_REVIEW.md', 'ULTRA_SOURCE_REVIEW.md']) {
    const text = await doc(name);
    assert.match(text, /Scope of the figures in this (document|review)/, name);
    assert.match(text, /(?:do|does) \*\*not\*\* qualify the current head/, name);
    assert.match(text, /qualification record\]\(ULTRA_HANDOFF\.md#qualification-record\)/, `${name} points to the derivation commands`);
  }
  const handoff = await doc('ULTRA_HANDOFF.md');
  const record = handoff.slice(handoff.indexOf('## Qualification record'));
  assert.match(record, /(?:do|does) \*\*not\*\* qualify the current head/);
  for (const command of ['node --test', 'node scripts/build-desktop.mjs --check', 'node scripts/ultra-evaluate.mjs']) assert.ok(record.includes(command), `the handoff derives figures with ${command}`);
  assert.match(record, /broken by those fixes and updated/, 'the updated tests are described as broken by the later fixes, not as already failing');
  assert.doesNotMatch(record, /already failing/);
  assert.match(record, /Frozen candidate \(historical, superseded for the current head\)/);
});

test('DOC-01: no document hard-codes a suite size for the current head (the figures come from CI and node --test)', async () => {
  for (const name of ['README.md', 'docs/DESKTOP.md', 'docs/INSTALLATION.md', 'CONTRIBUTING.md', 'docs/ARCHITECTURE.md']) {
    const text = await readFile(join(repo, name), 'utf8');
    assert.doesNotMatch(text, /\b\d{3}\s*(?:\/\s*\d{3}\s*)?(?:tests|test cases)\b/i, `${name} states a suite size`);
  }
});

test('docs: every ultra/cli.mjs command named in the documentation exists in the CLI', async () => {
  const known = new Set([...HELP.matchAll(/ultra\/cli\.mjs ([a-z][a-z-]*)/g)].map(match => match[1]));
  for (const name of ['init', 'show', 'validate', 'set', 'project-add', 'start', 'status', 'recruit', 'step', 'cancel', 'review', 'approve', 'approve-action', 'approve-batch', 'approve-plan', 'escalate', 'risk-override',
    'record-test', 'promote', 'propose-action', 'test-status', 'plan-add', 'waive-test', 'test-digest', 'run-test']) assert.ok(known.has(name), `${name} is in the CLI help`);
  const named = new Set();
  for (const file of ['ULTRA.md', 'ULTRA_POLICY.md', 'ULTRA_HANDOFF.md', 'ULTRA_ACCEPTANCE.md', 'ULTRA_HOSTS.md', 'TROUBLESHOOTING.md', 'CONFIGURATION.md']) {
    for (const match of (await doc(file)).matchAll(/ultra\/cli\.mjs ([a-z][a-z-]*)/g)) named.add(match[1]);
  }
  for (const command of named) assert.ok(known.has(command), `documentation names a CLI command that does not exist: ${command}`);
});
