// Fresh independent source/integration review. This author implemented no ULTRA code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ExecutionStore } from '../ultra/store.mjs';
import { RecruitmentBroker } from '../ultra/broker.mjs';
import { NativeController } from '../ultra/native-controller.mjs';
import { resolveConfig } from '../ultra/config.mjs';
import { writeOwnerConfig } from '../ultra/service.mjs';
import { handleMessage } from '../bridge/desktop-server.mjs';

const risk = { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 1, reversibility: 'reversible' };
const user = { trusted: true, source: 'local-user', authority: 'user' };
const proposal = (worker = 'luna', extra = {}) => ({ worker, task: 'Independent bounded source fixture', role: 'implementation', risk, budget: { tokens: 20000, usd: 1 }, ...extra });
async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ultra-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { OPENAI_ULTRA_STATE_DIR: directory, OPENAI_ULTRA_CONFIG: join(directory, 'policy.json'), OPENAI_ULTRA_ALLOW_API: '0' };
  const policy = resolveConfig({ enabled: true, ...config }); await writeOwnerConfig(policy, env);
  const store = new ExecutionStore(join(directory, 'ultra-execution.json'));
  const broker = new RecruitmentBroker(store, { config: policy });
  return { directory, env, policy, store, broker };
}

test('source: Desktop discovery reports governed source access without publicly caching owner policy', async t => {
  const f = await fixture(t, { desktop: { profile: 'B' } });
  const messages = [];
  const discover = () => handleMessage({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }, line => messages.push(JSON.parse(line)), async () => { throw new Error('Discovery must not call a model'); }, f.env);
  await discover();
  assert.equal(messages[0].result.cacheScope, 'private'); assert.equal(messages[0].result.ttlMs, 0);
  assert.match(messages[0].result.instructions, /ULTRA|scoped|profile B|read/i);
  assert.doesNotMatch(messages[0].result.instructions, /No file system.*access is exposed/);
  await writeOwnerConfig(resolveConfig(), f.env); await discover();
  assert.equal(messages[1].result.cacheScope, 'public'); assert.equal(messages[1].result.ttlMs, 3600000);
  assert.match(messages[1].result.instructions, /Text-only.*No file system/);
});

test('source: an unverified root cannot bootstrap restricted Sol authority by requesting uncertain Luna work', async t => {
  const f = await fixture(t), mission = await f.broker.createMission({ task: 'Unknown Desktop primary fixture' });
  const request = await f.broker.request(mission.id, 'root', proposal('luna', { risk: {} }), 'uncertain-low-tier');
  assert.equal(request.status, 'pending');
  assert(request.evaluation.requiredApprovals.some(a => a.authority === 'helicop-sol'));
  const supervisor = await f.broker.appointSupervisor(mission.id, request.id, 'helicop-sol');
  assert.equal(supervisor.nodeId ?? supervisor.id ?? null, null, 'Restricted identity must obtain user authority before spending on its Sol supervisor');
  const m = await f.store.snapshot(mission.id);
  assert.equal(Object.values(m.nodes).filter(n => n.role === 'supervisor').length, 0);
  assert(m.requests[request.id].evaluation.requiredApprovals.some(a => a.authority === 'user'));
  await f.broker.decide(m.id, request.id, { decision: 'APPROVE', rationale: 'Owner inspected the exact restricted supervisor allocation' }, user);
  const authorised = await f.broker.appointSupervisor(m.id, request.id, 'helicop-sol');
  assert.equal(authorised.worker, 'sol'); assert.equal(authorised.supervises, request.id);
  assert.equal((await f.store.snapshot(m.id)).requests[request.id].status, 'pending', 'Human bootstrap permission does not replace the independent Sol decision');
});

test('source: free-to-paid policy A still requires a mission spending ceiling for a supervisory invocation', async t => {
  const f = await fixture(t, { freeToPaid: { policy: 'A' } });
  const m = await f.broker.createMission({ task: 'Free origin with no paid mission budget', orchestrator: { model: 'opus', trusted: true, source: 'synthetic-host' } });
  const parent = await f.broker.request(m.id, 'root', proposal('daily-astrafree'), 'free-parent');
  const child = await f.broker.request(m.id, parent.nodeId, proposal('daily-terrafree', { risk: {} }), 'free-child-uncertain');
  assert.equal(child.status, 'pending');
  await assert.rejects(() => f.broker.appointSupervisor(m.id, child.id, 'helicop-sol'), /mission.*budget|spending.*ceiling|free-to-paid/i);
  assert.equal(Object.values((await f.store.snapshot(m.id)).nodes).filter(n => n.keyProfile === 'standard').length, 0);
  const budgeted = await f.broker.createMission({ task: 'Explicitly budgeted paid supervision', config: { mission: { maxUsd: 5 } }, orchestrator: { model: 'opus', trusted: true, source: 'synthetic-host' } });
  const budgetedParent = await f.broker.request(budgeted.id, 'root', proposal('daily-astrafree'), 'free-parent-budgeted');
  const budgetedChild = await f.broker.request(budgeted.id, budgetedParent.nodeId, proposal('daily-terrafree', { risk: {} }), 'free-child-budgeted');
  const permitted = await f.broker.appointSupervisor(budgeted.id, budgetedChild.id, 'helicop-sol');
  assert.equal(permitted.keyProfile, 'standard'); assert.equal(permitted.worker, 'sol');
});

test('source: the mission retry ceiling is shared by independent revised proposals', async t => {
  const f = await fixture(t, { mission: { maxRetries: 1 }, helicop: { denial: 'revise', maxRevisions: 1 } });
  const m = await f.broker.createMission({ task: 'Two independent restricted proposals' });
  const requests = [];
  for (let i = 0; i < 2; i++) {
    const r = await f.broker.request(m.id, 'root', proposal('astra', { task: `Bounded task ${i}` }), `initial-${i}`);
    await f.broker.decide(m.id, r.id, { decision: 'REJECT', rationale: 'Synthetic request revision test' }, user); requests.push(r);
  }
  await f.broker.revise(m.id, requests[0].id, 'root', { budget: { tokens: 10000, usd: 0.5 } }, 'first-retry');
  await assert.rejects(() => f.broker.revise(m.id, requests[1].id, 'root', { budget: { tokens: 10000, usd: 0.5 } }, 'second-retry'), /mission.*retry|retry.*(?:budget|limit|ceiling)|retries/i);
});

test('source: redirected CLI input cannot manufacture an explicit owner approval', async t => {
  const f = await fixture(t), m = await f.broker.createMission({ task: 'Redirected approval fixture', surface: 'desktop-chat' });
  const request = await f.broker.request(m.id, 'root', proposal('astra'), 'human-needed');
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), '../ultra/cli.mjs');
  const child = spawnSync(process.execPath, [entry, 'approve', m.id, request.id], { env: { ...process.env, ...f.env }, input: `APPROVE ${request.id}\n`, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /interactive local terminal/);
  const after = await f.store.snapshot(m.id); assert.equal(after.requests[request.id].status, 'pending'); assert.equal(Object.keys(after.approvals).length, 0);
});

test('source: an approved native request retains its original task, parent and single allocation', async t => {
  const f = await fixture(t), controller = new NativeController(f.broker);
  const channel = { trustedHostChannel: true }, sessionId = 'independent-source-native';
  const initialized = await controller.handle('ultra_native_init', { sessionId, model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false }, channel);
  const identity = { sessionId, capability: initialized.capability, primaryModel: 'opus' };
  const admittedParent = await controller.handle('ultra_native_admit', { ...identity, toolUseId: 'parent-spawn', subagentType: 'openai-workers:luna', prompt: JSON.stringify({ task: 'Native parent', ultra: { risk } }), parentModel: 'opus' }, channel);
  await controller.handle('ultra_native_bind', { ...identity, nodeId: admittedParent.nodeId, toolUseId: 'parent-spawn', hostAgentId: 'native-parent' }, channel);
  const queued = await f.broker.request(initialized.missionId, 'root', proposal('luna', { task: 'Exact approved task bytes', adapter: 'native' }), 'approved-work');
  const envelope = JSON.stringify({ task: 'Attempted replacement task bytes', ultra: { approvedRequestId: queued.id, risk, role: 'reworker' } });
  await assert.rejects(() => controller.handle('ultra_native_admit', { ...identity, toolUseId: 'wrong-parent', parentAgentId: 'native-parent', parentModel: 'opus', subagentType: 'openai-workers:luna', prompt: envelope }, channel), /parent/);
  const admitted = await controller.handle('ultra_native_admit', { ...identity, toolUseId: 'exact-parent', parentModel: 'opus', subagentType: 'openai-workers:luna', prompt: envelope }, channel);
  assert.equal(admitted.task, 'Exact approved task bytes'); assert.equal(admitted.role, 'implementation'); assert.equal(admitted.nodeId, queued.nodeId);
  await controller.handle('ultra_native_bind', { ...identity, nodeId: admitted.nodeId, toolUseId: 'exact-parent', hostAgentId: 'native-child' }, channel);
  await assert.rejects(() => controller.handle('ultra_native_admit', { ...identity, toolUseId: 'replay', parentModel: 'opus', subagentType: 'openai-workers:luna', prompt: envelope }, channel), /consumed/);
  assert.equal(Object.values((await f.store.snapshot(initialized.missionId)).nodes).filter(n => n.task === 'Exact approved task bytes').length, 1);
});

test('source: native review startup uses the authorised current risk classification', async t => {
  const f = await fixture(t), controller = new NativeController(f.broker);
  const channel = { trustedHostChannel: true }, sessionId = 'independent-risk-native';
  const initialized = await controller.handle('ultra_native_init', { sessionId, model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false }, channel);
  const identity = { sessionId, capability: initialized.capability, primaryModel: 'opus' };
  const admitted = await controller.handle('ultra_native_admit', { ...identity, toolUseId: 'high-author', subagentType: 'openai-workers:luna', prompt: JSON.stringify({ task: 'Synthetic already-safe implementation', ultra: { role: 'implementation', risk: { ...risk, impact: 'high' } } }), parentModel: 'opus' }, channel);
  await controller.handle('ultra_native_bind', { ...identity, nodeId: admitted.nodeId, toolUseId: 'high-author', hostAgentId: 'native-risk-author' }, channel);
  const m = await f.store.snapshot(initialized.missionId), n = m.nodes[admitted.nodeId];
  await f.broker.finish(m.id, n.id, { lease: n.lease.token, result: { text: 'Synthetic source snapshot' }, usage: { tokens: 0, usd: 0 } });
  await f.broker.overrideRisk(m.id, n.id, risk, { rationale: 'Trusted owner established the initial high-impact classification was incorrect for this bounded synthetic fixture', ttlMs: 60000 }, user);
  const workflow = await controller.handle('ultra_native_review_start', { ...identity, authorAgentId: 'native-risk-author' }, channel);
  assert.equal(workflow.assessment.effectiveImpact, 'low', 'Native adapter must not overwrite the current authorised assessment with the stale recruitment proposal');
  assert(workflow.riskOverrideId);
});

test('source: real Git autocrlf checkout preserves source fingerprints and the reproducible Desktop bundle', async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ultra-source-checkout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const indexRoot = join(directory, 'index');
  const git = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 0, `Git ${args.join(' ')} failed: ${result.error ?? result.stderr}`);
    return result.stdout;
  };
  // Match the evaluator's source-byte inputs, including the PowerShell/CMD
  // entry points. Use the current source bytes without changing the real index.
  const paths = git(root, ['ls-files', '-z']).split('\0').filter(file => /\.(?:mjs|js|json|ps1|cmd|yml|yaml)$/.test(file));
  const bundle = 'dist/Chlaude-GPTopus-Desktop.mcpb';
  const original = new Map();
  for (const file of [...paths, bundle]) {
    const bytes = await readFile(join(root, file)); original.set(file, bytes);
    await mkdir(dirname(join(indexRoot, file)), { recursive: true });
    await writeFile(join(indexRoot, file), bytes);
  }
  const fixedAttributes = await readFile(join(root, '.gitattributes'));
  // Negative control: the exact original rules omitted the newly bundled
  // ultra modules, portable hook and package metadata. Real Git must reproduce
  // their Windows-style CRLF conversion and the resulting package mismatch.
  const oldAttributes = '# Bundle inputs must have stable bytes across Windows/Linux checkouts.\n'
    + 'desktop-extension/manifest.json text eol=lf\n'
    + 'plugins/openai-workers/bridge/*.mjs text eol=lf\n'
    + 'plugins/openai-workers/scripts/read-openai-key.ps1 text eol=lf\n\n'
    + '# The distributable is an opaque ZIP/MCPB binary.\n'
    + 'dist/*.mcpb -text\n';
  await writeFile(join(indexRoot, '.gitattributes'), oldAttributes);
  git(indexRoot, ['-c', 'core.autocrlf=false', 'init', '--quiet']);
  git(indexRoot, ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', 'add', '--all']);
  const checkout = async name => {
    const target = join(directory, name); await mkdir(target);
    git(indexRoot, ['-c', 'core.autocrlf=true', '-c', 'core.eol=crlf', 'checkout-index', '--all', `--prefix=${target.replaceAll('\\', '/')}/`]);
    return target;
  };
  const verifyBundle = cwd => spawnSync(process.execPath, ['scripts/build-desktop.mjs', '--check'], { cwd, encoding: 'utf8', timeout: 20000, windowsHide: true });
  const legacy = await checkout('legacy');
  const legacyModule = await readFile(join(legacy, 'plugins/openai-workers/ultra/config.mjs'));
  assert(legacyModule.includes(Buffer.from('\r\n')), 'Negative control must really check out CRLF source, rather than only inspecting attributes');
  assert.deepEqual(await readFile(join(legacy, bundle)), original.get(bundle), 'Git must preserve the binary distributable even with old attributes');
  const mismatch = verifyBundle(legacy);
  assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /Committed MCPB does not match deterministic source build/);

  await writeFile(join(indexRoot, '.gitattributes'), fixedAttributes);
  git(indexRoot, ['-c', 'core.autocrlf=false', 'add', '.gitattributes']);
  const fixed = await checkout('fixed');
  for (const [file, bytes] of original) {
    assert.deepEqual(await readFile(join(fixed, file)), bytes, `Git checkout changed reviewed bytes: ${file}`);
  }
  const matched = verifyBundle(fixed);
  assert.equal(matched.status, 0, `Fixed checkout failed source/package matching: ${matched.error ?? matched.stderr}`);
  assert.match(matched.stdout, /Verified reproducible MCPB/);
});
