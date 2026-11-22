import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveConfig } from '../ultra/config.mjs';
import { ExecutionStore } from '../ultra/store.mjs';
import { RecruitmentBroker } from '../ultra/broker.mjs';
import { createService, ownerPaths, writeOwnerConfig } from '../ultra/service.mjs';
import { invoke, handleMessage } from '../bridge/desktop-server.mjs';
import { main as cli } from '../ultra/cli.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const risk = { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 1, reversibility: 'reversible' };
const user = { source: 'local-user', authority: 'user', trusted: true };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ultra-public-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { OPENAI_ULTRA_STATE_DIR: dir, OPENAI_ULTRA_CONFIG: join(dir, 'policy.json') };
  const config = resolveConfig({ enabled: true }); await writeOwnerConfig(config, env);
  const store = new ExecutionStore(join(dir, 'ledger.json')), broker = new RecruitmentBroker(store, { config });
  return { dir, env, config, store, broker };
}
test('enabled Desktop cannot bypass ULTRA through legacy delegation or private native names', async t => {
  const f = await fixture(t); let calls = 0; const backend = async () => { calls++; };
  for (const name of ['ask_openai_worker', 'poll_openai_worker', 'cancel_openai_worker', 'ultra_native_init']) await assert.rejects(() => invoke(name, {}, backend, f.env), /ULTRA|native/);
  assert.equal(calls, 0);
  const lines = [];
  await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, line => lines.push(JSON.parse(line)), backend, f.env);
  const names = lines[0].result.tools.map(t => t.name);
  assert(names.includes('ultra_start')); assert(!names.includes('ask_openai_worker')); assert(!names.some(n => n.startsWith('ultra_native_')));
});
test('public API cannot set trusted identity, permissions, parent, approval or live transport', async t => {
  const f = await fixture(t), backend = async () => { throw new Error('No API expected'); };
  const service = await createService({ env: f.env, backend, store: f.store });
  await assert.rejects(() => service.invoke('ultra_start', { task: 'test', model: 'opus', trusted: true }), /privileged|Unknown/);
  const m = await service.invoke('ultra_start', { task: 'Public test mission' });
  await assert.rejects(() => service.invoke('ultra_recruit', { mission_id: m.mission_id, parentId: 'root', permissions: { tools: ['Bash'] } }), /privileged|Unknown/);
  await assert.rejects(() => service.invoke('ultra_step', { mission_id: m.mission_id }), /Live.*disabled/);
  assert.equal((await service.broker.diagnostics(m.mission_id)).orchestrator.trusted, false);
});
test('local configuration CLI validates edits, retains safe defaults and rejects unknown fields', async t => {
  const f = await fixture(t), printed = [];
  await cli(['init', 'Lite'], { env: f.env, print: x => printed.push(x) });
  assert.equal(JSON.parse(await readFile(f.env.OPENAI_ULTRA_CONFIG, 'utf8')).enabled, false);
  await cli(['set', 'enabled', 'true'], { env: f.env, print: x => printed.push(x) });
  await assert.rejects(() => cli(['set', 'permissionz', 'true'], { env: f.env, print: () => {} }), /Unknown/);
  await assert.rejects(() => cli(['set', '__proto__.enabled', 'true'], { env: f.env, print: () => {} }), /Invalid/);
  assert.equal(ownerPaths({ ...f.env, OPENAI_ULTRA_CONFIG: '${user_config.ultra_config_path}' }).config, join(f.dir, 'ultra-policy.json'));
});
test('future plan approval is explicit, bounded, one-use per request and cannot waive HELICOP gates', async t => {
  const f = await fixture(t), m = await f.broker.createMission({ task: 'Restricted plan fixture' });
  const grant = { parentId: 'root', workers: ['astra6-2'], roles: ['implementation'], tools: [], roots: [], maxInvocations: 1, budget: { tokens: 1000, usd: 0.1 } };
  await assert.rejects(() => f.broker.grantPlan(m.id, grant, user), /acknowledgement/);
  const plan = await f.broker.grantPlan(m.id, { ...grant, acknowledgeFutureRecruitment: true }, user);
  const proposal = { worker: 'astra6-2', role: 'implementation', task: 'Bounded planned task', risk, budget: { tokens: 1000, usd: 0.1 }, planId: plan.id };
  const accepted = await f.broker.request(m.id, 'root', proposal, 'one'); assert.equal(accepted.status, 'queued');
  assert.equal((await f.broker.request(m.id, 'root', proposal, 'one')).id, accepted.id);
  await assert.rejects(() => f.broker.request(m.id, 'root', proposal, 'two'), /exhausted/);
  assert.equal((await f.store.snapshot(m.id)).plans[plan.id].remaining, 0);
});
test('batch approval records separate exact request decisions', async t => {
  const f = await fixture(t), m = await f.broker.createMission({ task: 'Restricted batch' });
  const requests = [];
  for (let i = 0; i < 2; i++) requests.push(await f.broker.request(m.id, 'root', { worker: 'astra6-2', task: `Exact task ${i}`, risk, budget: { tokens: 1000, usd: 0.1 } }, String(i)));
  const results = await f.broker.decideBatch(m.id, requests.map(r => r.id), { decision: 'APPROVE', rationale: 'Owner reviewed exact batch' }, user);
  assert(results.every(r => r.status === 'queued'));
  const approvals = Object.values((await f.store.snapshot(m.id)).approvals);
  assert.equal(new Set(approvals.map(a => a.inputHash)).size, 2);
});
test('extracted MCPB loads the real governed service and exposes no native control channel', async t => {
  const f = await fixture(t), artifact = join(f.dir, 'extension.mcpb'), extracted = join(f.dir, 'extension');
  execFileSync(process.execPath, [join(repo, 'scripts/build-desktop.mjs'), artifact], { stdio: 'pipe' });
  const zip = await readFile(artifact); let offset = 0, count = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(offset + 8), 0, 'deterministic bundle uses stored ZIP entries');
    const size = zip.readUInt32LE(offset + 18), length = zip.readUInt16LE(offset + 26), extra = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + length).toString(); assert(!name.includes('..') && !name.startsWith('/'));
    const begin = offset + 30 + length + extra, target = join(extracted, name);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, zip.subarray(begin, begin + size)); offset = begin + size; count++;
  }
  assert.equal(zip.readUInt16LE(zip.length - 12), count);
  const script = `import {invoke} from './server/desktop-server.mjs';
const start=await invoke('ultra_start',{task:'Extracted bundle offline protocol qualification'});
const state=await invoke('ultra_diagnostics',{mission_id:start.mission_id});
let denied=false;try{await invoke('ultra_native_init',{model:'opus'});}catch{denied=true;}
console.log(JSON.stringify({mission:state.missionId,authority:state.orchestrator.trusted,denied}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', script], { cwd: extracted,
    env: { ...process.env, ...f.env, OPENAI_API_KEY: '', OPENAI_FREE_API_KEY: '', OPENAI_ULTRA_ALLOW_API: '0' }, encoding: 'utf8' }));
  assert.equal(result.authority, false); assert.equal(result.denied, true); assert(result.mission);
});
