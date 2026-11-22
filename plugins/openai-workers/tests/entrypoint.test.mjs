import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A directory link to the plugin (a junction on Windows, so no privilege is needed). */
function linkedPlugin(t) {
  const base = mkdtempSync(join(tmpdir(), 'gptopus-link-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const link = join(base, 'linked-plugin');
  try { symlinkSync(pluginRoot, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip(`cannot create a directory link here: ${error.code}`); return null; }
  assert.notEqual(realpathSync(link), link, 'the link must really be an alias');
  return link;
}
const run = (script, args, input = '') => spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8', env: { ...process.env, OPENAI_WORKER_USAGE_DIR: join(process.env.OPENAI_WORKER_USAGE_DIR, 'entry') }, timeout: 30_000 });

test('the owner reconciliation script runs (not a silent exit 0) when launched through a symlink or junction', t => {
  const link = linkedPlugin(t); if (!link) return;
  for (const script of [join(pluginRoot, 'scripts/reconcile-usage.mjs'), join(link, 'scripts/reconcile-usage.mjs')]) {
    const r = run(script, ['status']);
    assert.equal(r.status, 0, `${script}: ${r.stderr}`);
    assert.match(r.stdout, /Local usage ledger reconciliation status/, `${script} printed nothing`);
  }
  const bad = run(join(link, 'scripts/reconcile-usage.mjs'), ['reconcile', '--month', 'nope']);
  assert.notEqual(bad.status, 0, 'a refused command through the link must still fail');
});

test('the Desktop MCP server answers when launched through a symlink or junction', t => {
  const link = linkedPlugin(t); if (!link) return;
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) + '\n';
  for (const script of [join(pluginRoot, 'bridge/desktop-server.mjs'), join(link, 'bridge/desktop-server.mjs')]) {
    const r = run(script, [], request);
    assert.match(r.stdout, /"id":1/, `${script} did not answer: ${r.stderr}`);
  }
});
