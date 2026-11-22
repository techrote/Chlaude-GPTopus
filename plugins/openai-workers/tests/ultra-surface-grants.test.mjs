// SURF-01: surface CEILINGS are independent, but roots and tools are one shared grant. The CLI, diagnostics and docs must
// say exactly that, and the behaviour they describe is pinned here so the statement cannot silently become false.
import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as cli } from '../ultra/cli.mjs';
import { resolveConfig } from '../ultra/config.mjs';
import { createService, writeOwnerConfig, ownerPaths } from '../ultra/service.mjs';
import { UltraRuntime } from '../ultra/runtime.mjs';
import { ExecutionStore } from '../ultra/store.mjs';
import { RecruitmentBroker } from '../ultra/broker.mjs';
import { bridgeHost } from './bridge-host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function owner(t) {
  const dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-grants-')));
  const project = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-grants-project-')));
  t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(project, { recursive: true, force: true })]));
  const env = { OPENAI_ULTRA_STATE_DIR: dir, OPENAI_ULTRA_CONFIG: join(dir, 'ultra-policy.json') };
  await writeFile(join(project, 'source.txt'), 'shared source\n');
  const run = async argv => { const out = []; await cli(argv, { env, print: v => out.push(v) }); return out[0]; };
  return { dir, project, env, run };
}

test('SURF-01: project-add for one surface says that the root is shared with every surface already at B or higher', async t => {
  const o = await owner(t);
  await o.run(['init', 'Lite']);
  await o.run(['project-add', o.project, 'B', '--surface', 'chat']);
  const added = await o.run(['project-add', o.project, 'B', '--surface', 'codeCli']);
  assert.deepEqual(added.sharedGrant.readableBy, ['chat (B)', 'codeCli (B)'], 'both surfaces can now read it');
  assert.match(added.note, /ONE|one grant shared by every surface/i);
  assert.match(added.note, /capability CEILING changed/);
  assert.doesNotMatch(added.note, /unchanged\. Workers still need/, 'the old wording implied nothing else was affected');
  const policy = (await o.run(['show'])).policy;
  assert.deepEqual(policy.permissions.roots, [o.project]); assert.deepEqual(policy.desktop.roots, [o.project]);
  assert.equal(policy.surfaces.desktopCode.profile, 'A', 'a surface still at A gains nothing');
});

test('SURF-01: the shared grant is real: a Chat worker reads a root that was added only for a Code surface (documented limitation)', async t => {
  const o = await owner(t);
  await o.run(['init', 'Lite']); await o.run(['set', 'enabled', 'true']);
  await o.run(['set', 'desktop.profile', '"B"']);                           // Chat at B, with NO desktop.roots
  await o.run(['project-add', o.project, 'B', '--surface', 'codeCli']);     // the root is added "for Code" only
  const config = (await o.run(['show'])).policy, store = new ExecutionStore(ownerPaths(o.env).ledger);
  assert.deepEqual(config.desktop.roots, []);
  const service = await createService({ env: o.env, store, backend: Object.assign(async () => { throw new Error('offline'); }, { offline: true }) });
  await assert.rejects(() => service.invoke('ultra_read_project', { root: '0', path: 'source.txt' }), /./, 'the public Chat read tool DOES require desktop.roots');
  const broker = new RecruitmentBroker(store, { config: resolveConfig(config) }), runtime = new UltraRuntime(broker, { backend: Object.assign(async () => ({}), { offline: true }) });
  const mission = await broker.createMission({ id: 'grants', task: 'Chat worker', surface: 'desktop-chat' });
  const request = await broker.request(mission.id, 'root', { worker: 'luna', role: 'exploration', task: 'read', risk: { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 0.95 } }, 'r');
  const m = await store.snapshot(mission.id);
  const boundary = runtime.boundary(m, m.nodes[request.nodeId]);
  assert.equal((await boundary.readFile('0', 'source.txt')).content, 'shared source\n', 'a Chat worker reads the root that was never in desktop.roots');
});

test('SURF-01: diagnostics report the shared grant, in public Chat diagnostics and in native diagnostics', async t => {
  const h = await bridgeHost(t, { project: { 'source.txt': 'x\n' } });
  await h.writePolicy({ surfaces: { codeCli: { profile: 'B' } }, permissions: { tools: ['read_file'], roots: [h.project] } });
  const service = await createService({ env: h.env, backend: async () => { throw new Error('offline'); } });
  const chat = await service.invoke('ultra_diagnostics', {});
  assert.equal(chat.grants.sharedAcrossSurfaces, true); assert.deepEqual(chat.grants.roots, [h.project]);
  assert.match(chat.grants.note, /no per-surface root lists/); assert.equal(chat.surfaces.codeCli.profile, 'B');
  const session = await h.session('grants-session');
  const native = await h.call('ultra_native_diagnostics', session.common);
  assert.equal(native.grants.sharedAcrossSurfaces, true); assert.deepEqual(native.grants.tools, ['read_file']); assert.match(native.grants.note, /ONE owner grant shared by every surface/);
});

test('SURF-01: the user documentation states the limitation and no longer claims independent roots', async () => {
  const ultra = await readFile(join(root, '..', '..', 'docs', 'ULTRA.md'), 'utf8');
  assert.match(ultra, /Ceilings are independent; roots and tools are not/);
  assert.doesNotMatch(ultra, /a Chat-visible read still additionally requires the Chat profile and `desktop\.roots`\./, 'the sentence that implied independence for roots was corrected');
  assert.match(await readFile(join(root, '..', '..', 'docs', 'ULTRA_HANDOFF.md'), 'utf8'), /Roots and tools are one grant shared by every surface/);
});
