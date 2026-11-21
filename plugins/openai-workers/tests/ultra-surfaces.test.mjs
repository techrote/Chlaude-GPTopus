// Separate policy surfaces: Claude Code CLI, Claude Desktop Code and Claude Desktop Chat
// have independent capability ceilings. Everything here drives the real production
// controllers (NativeController, UltraRuntime, UltraService, PermissionBoundary, CLI,
// register hooks); the only test doubles are the offline provider transport and the host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionStore } from '../ultra/store.mjs';
import { RecruitmentBroker } from '../ultra/broker.mjs';
import { NativeController } from '../ultra/native-controller.mjs';
import { UltraRuntime, runtimeTools } from '../ultra/runtime.mjs';
import { UltraService, readOwnerConfig, ownerPaths } from '../ultra/service.mjs';
import { PermissionBoundary } from '../ultra/permissions.mjs';
import { main as cli } from '../ultra/cli.mjs';
import * as ceilings from '../ultra/config.mjs';
import { register } from '../hooks/register.js';
import { nativeToolNames, nativeRootToolNames, nativeOpenAITools, NATIVE_PREFIX } from '../hooks/ultra.js';

// Namespace import: on unfixed source the new exports are simply undefined, so each test fails individually.
const { DEFAULT_CONFIG, resolveConfig, validateConfig, policyHash, profileConfig, resolveHostSurface, surfaceCeiling, missionProfile } = ceilings;
const SURFACE_KEYS = ceilings.SURFACE_KEYS ?? ['codeCli', 'desktopCode'];

const risk = { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 0.95, rationale: 'Deterministic bounded offline fixture.' };
const transport = { trustedHostChannel: true };
const tool = name => `${NATIVE_PREFIX}ultra_${name}`;
const TOOLS = { read_file: tool('read_file'), create_stage: tool('create_stage'), stage_read: tool('stage_read'), stage_write: tool('stage_write'), stage_patch: tool('stage_patch') };
const INPUTS = {
  read_file: { rootId: '0', path: 'source.txt' },
  create_stage: { files: [{ rootId: '0', path: 'source.txt' }] },
  stage_read: { stage: 'placeholder', path: 'source.txt' },
  stage_write: { stage: 'placeholder', path: 'source.txt', content: 'changed', expectedSha256: null },
  stage_patch: { stage: 'placeholder' },
};
const rank = { A: 0, B: 1, C: 2 };
const code = (profile, other = {}) => ({ profile, enableExecutionBridge: profile === 'C', ...other });
const HOST = { codeCli: ['terminal'], desktopCode: ['desktop'] };
const names = list => list.map(t => t.name).filter(n => n.startsWith(NATIVE_PREFIX)).sort();

async function tmp(t, prefix = 'ultra-surfaces-') {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function project(t) {
  const root = await tmp(t, 'ultra-surfaces-project-');
  await fs.writeFile(path.join(root, 'source.txt'), 'before');
  return root;
}
/** A real NativeController over a real broker/store; only the provider transport is offline. */
async function harness(t, { config = {}, surfaces = ['terminal'], init = {}, enabled = true, sessionId = 'surface-session', directory, backend } = {}) {
  directory ??= await tmp(t);
  const store = new ExecutionStore(path.join(directory, 'execution.json'));
  const broker = new RecruitmentBroker(store, { config: { enabled, ...config } });
  const calls = [];
  const provider = backend ?? (async (name, args) => { calls.push({ name, args: structuredClone(args) }); return { id: `resp_surface_${calls.length}`, status: 'completed', model: args.model, text: 'done', usage: { total: 50 }, estimatedUsd: 0.001 }; });
  provider.offline = true;
  const controller = new NativeController(broker, { backend: provider });
  const facts = { sessionId, model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false, ...(surfaces === undefined ? {} : { surfaces }), ...init };
  const h = { directory, store, broker, controller, calls, sessionId };
  h.init = () => controller.handle('ultra_native_init', facts, transport);
  const initialized = await h.init();
  h.initialized = initialized; h.missionId = initialized.missionId;
  h.common = { sessionId, capability: initialized.capability };
  h.handle = (name, args = {}) => controller.handle(name, { ...h.common, ...args }, transport);
  h.mission = () => store.snapshot(h.missionId);
  let spawns = 0;
  h.spawn = async (role = 'implementation') => {
    const n = ++spawns, toolUseId = `spawn-${n}`, hostAgentId = `agent-${n}`;
    const admitted = await h.handle('ultra_native_admit', { toolUseId, primaryModel: 'opus', subagentType: 'openai-workers:luna',
      prompt: JSON.stringify({ task: 'Surface scoped work', ultra: { role, risk, budget: { tokens: 40000, usd: 4 } } }) });
    assert.equal(admitted.allowed, true, JSON.stringify(admitted));
    await h.handle('ultra_native_bind', { toolUseId, hostAgentId, nodeId: admitted.nodeId, bindingTicket: admitted.bindingTicket, hostWorker: 'luna' });
    return { hostAgentId, nodeId: admitted.nodeId };
  };
  return h;
}

// ---------------------------------------------------------------------------------------
// Configuration schema
// ---------------------------------------------------------------------------------------

test('surfaces: defaults are fail-closed, Chat keeps desktop, and the owner presets declare the section', async () => {
  assert.deepEqual(DEFAULT_CONFIG.surfaces, { codeCli: { profile: 'A', enableExecutionBridge: false }, desktopCode: { profile: 'A', enableExecutionBridge: false } });
  assert.deepEqual([...SURFACE_KEYS], ['codeCli', 'desktopCode']);
  assert.equal(DEFAULT_CONFIG.enabled, false);
  for (const name of ['lite', 'balanced', 'research', 'critical']) {
    const preset = JSON.parse(await fs.readFile(new URL(`../../../config/ultra-${name}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(preset.surfaces, DEFAULT_CONFIG.surfaces, `${name} preset`);
    validateConfig(preset);
  }
  // A pre-existing owner file without the section still validates and gets the defaults.
  const legacy = structuredClone(profileConfig('Lite')); delete legacy.surfaces;
  assert.deepEqual(resolveConfig(legacy).surfaces, DEFAULT_CONFIG.surfaces);
});

test('surfaces: strict validation rejects unknown surfaces, fields, types and bridge-less C', () => {
  const attempt = surfaces => resolveConfig({ surfaces });
  for (const [label, value, pattern] of [
    ['Chat is not a Code surface key', { chat: code('B') }, /Unknown configuration field: surfaces\.chat/],
    ['an unqualified surface', { vscode: code('B') }, /Unknown configuration field: surfaces\.vscode/],
    ['prototype pollution key', JSON.parse('{"__proto__":{"profile":"C"}}'), /Unsafe|Unknown/],
    ['misspelt field', { codeCli: { profile: 'B', bridge: true } }, /Unknown configuration field: surfaces\.codeCli\.bridge/],
    ['profile outside A/B/C', { codeCli: { profile: 'D' } }, /surfaces\.codeCli\.profile must be one of A, B, C/],
    ['lowercase profile', { desktopCode: { profile: 'b' } }, /surfaces\.desktopCode\.profile/],
    ['non-boolean bridge flag', { codeCli: { enableExecutionBridge: 'yes' } }, /enableExecutionBridge must be a boolean/],
    ['Code C without the explicit bridge flag (CLI)', { codeCli: { profile: 'C' } }, /surfaces\.codeCli C requires explicit enableExecutionBridge=true/],
    ['Code C without the explicit bridge flag (Desktop Code)', { desktopCode: { profile: 'C', enableExecutionBridge: false } }, /surfaces\.desktopCode C requires explicit enableExecutionBridge=true/],
    ['surface entry is not an object', { codeCli: 'C' }, /must be an object/],
    ['surface entry is an array', { codeCli: ['C'] }, /must be an object/],
  ]) assert.throws(() => attempt(value), pattern, label);
  assert.throws(() => resolveConfig({ surfaces: [] }), /surfaces must be an object/);
  assert.throws(() => resolveConfig({ surfaces: null }), /surfaces must be an object/);
  assert.throws(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG), surfaces: undefined }), /surfaces must be an object/);
  // Valid shapes: one surface at a time, bridge flag may be set below C.
  assert.equal(resolveConfig({ surfaces: { codeCli: code('C') } }).surfaces.desktopCode.profile, 'A');
  assert.equal(resolveConfig({ surfaces: { desktopCode: { profile: 'B', enableExecutionBridge: true } } }).surfaces.desktopCode.profile, 'B');
});

test('surfaces: Chat, CLI and Desktop Code settings are mutually independent in the hash and resolved policy', () => {
  const base = policyHash(resolveConfig({ enabled: true }));
  const hashes = new Set([base]);
  for (const patch of [{ surfaces: { codeCli: code('B') } }, { surfaces: { codeCli: code('C') } }, { surfaces: { desktopCode: code('B') } }, { surfaces: { desktopCode: code('C') } },
    { desktop: { profile: 'B' } }, { surfaces: { codeCli: { profile: 'A', enableExecutionBridge: true } } }]) hashes.add(policyHash(resolveConfig({ enabled: true, ...patch })));
  assert.equal(hashes.size, 7, 'each owner-visible ceiling change yields its own policy hash');
  const cliC = resolveConfig({ enabled: true, surfaces: { codeCli: code('C') } });
  assert.equal(cliC.desktop.profile, 'A', 'enabling Code C leaves Chat unchanged');
  assert.equal(cliC.surfaces.desktopCode.profile, 'A', 'enabling CLI C leaves Desktop Code unchanged');
  const chatC = resolveConfig({ enabled: true, desktop: { profile: 'C', enableExecutionBridge: true } });
  assert.deepEqual(chatC.surfaces, DEFAULT_CONFIG.surfaces, 'enabling Chat C leaves every Code surface unchanged');
});

test('surfaces: scoped layers can only lower a Code surface ceiling', () => {
  const owner = { enabled: true, surfaces: { codeCli: code('B'), desktopCode: code('C') } };
  const scoped = (scope, surfaces, authorised) => resolveConfig([owner, { scope, value: { surfaces }, ...(authorised === undefined ? {} : { authorised }) }]);
  for (const scope of ['project', 'worker', 'mission', 'stage']) {
    assert.throws(() => scoped(scope, { codeCli: code('C') }), /Scoped codeCli Code surface access exceeds its ceiling/, `${scope} raising CLI B->C`);
    assert.throws(() => scoped(scope, { desktopCode: { enableExecutionBridge: true } }) && scoped(scope, { codeCli: { enableExecutionBridge: true } }), /Scoped codeCli Code surface access exceeds its ceiling/, `${scope} enabling the bridge flag`);
  }
  assert.throws(() => scoped('project', { codeCli: { profile: 'B', enableExecutionBridge: true } }), /Scoped codeCli Code surface access exceeds its ceiling/, 'bridge flag is a separate ceiling');
  // A ceiling that is already at A cannot be raised by any unauthorised scoped layer.
  assert.throws(() => resolveConfig([{ enabled: true }, { scope: 'project', value: { surfaces: { desktopCode: code('B') } } }]), /Scoped desktopCode Code surface access exceeds its ceiling/);
  // Lowering is always permitted and does not disturb the other surface or Chat.
  const lowered = scoped('mission', { desktopCode: { profile: 'A', enableExecutionBridge: false } });
  assert.equal(lowered.surfaces.desktopCode.profile, 'A'); assert.equal(lowered.surfaces.codeCli.profile, 'B');
  // Only an explicitly authorised layer may expand, and never past validation.
  assert.equal(scoped('project', { codeCli: code('C') }, true).surfaces.codeCli.profile, 'C');
  assert.throws(() => scoped('project', { codeCli: { profile: 'C', enableExecutionBridge: false } }, true), /requires explicit enableExecutionBridge/);
  // Raising Chat in a scoped layer is still refused as before, and does not mask Code checks.
  assert.throws(() => scoped('project', { }, undefined) && resolveConfig([owner, { scope: 'project', value: { desktop: { profile: 'C', enableExecutionBridge: true } } }]), /Scoped Desktop access exceeds its ceiling/);
});

test('surfaces: host facts resolve to one qualified Code surface or fail closed to unknown', () => {
  assert.equal(resolveHostSurface({ surfaces: ['terminal'] }), 'codeCli');
  assert.equal(resolveHostSurface({ surfaces: ['terminal', 'terminal'] }), 'codeCli');
  assert.equal(resolveHostSurface({ surface: 'cli' }), 'codeCli');
  assert.equal(resolveHostSurface({ surfaces: ['desktop'] }), 'desktopCode');
  assert.equal(resolveHostSurface({ surface: 'desktop' }), 'desktopCode');
  for (const facts of [undefined, null, 'desktop', 42, [], {}, { surfaces: [] }, { surfaces: 'desktop' }, { surfaces: { 0: 'desktop' } }, { surfaces: ['vscode'] }, { surfaces: ['mobile'] },
    { surfaces: ['terminal', 'desktop'] }, { surfaces: ['terminal'], surface: 'desktop' }, { surfaces: ['terminal', 'vscode'] }, { surfaces: ['Desktop'] }, { surfaces: ['DESKTOP'] },
    { surfaces: [' desktop'] }, { surfaces: ['constructor'] }, { surfaces: ['__proto__'] }, { surfaces: ['toString'] }, { surfaces: [42] }, { surfaces: [null] }, { surfaces: [['desktop']] },
    { surfaces: [{ toString: () => 'desktop' }] }, { surface: ['desktop'] }, { surface: {} }, { surfaces: Array(17).fill('terminal') }]) {
    assert.equal(resolveHostSurface(facts), 'unknown', JSON.stringify(facts));
  }
});

test('surfaces: ceilings attenuate only; an unknown surface, bad entry or bridge-less C is never above B/A', () => {
  const config = resolveConfig({ surfaces: { codeCli: code('C'), desktopCode: code('B') }, desktop: { profile: 'C', enableExecutionBridge: true } });
  assert.deepEqual([surfaceCeiling(config, 'codeCli').profile, surfaceCeiling(config, 'desktopCode').profile], ['C', 'B']);
  for (const surface of ['unknown', undefined, null, 'chat', 'desktopChat', 'desktop', 'terminal', '__proto__', 'constructor', 42, {}]) {
    const ceiling = surfaceCeiling(config, surface);
    assert.equal(ceiling.profile, 'A', `surface ${String(surface)}`); assert.equal(ceiling.enableExecutionBridge, false);
  }
  const unvalidated = { surfaces: { codeCli: { profile: 'C', enableExecutionBridge: 'true' }, desktopCode: { profile: 'Z', enableExecutionBridge: true } } };
  assert.equal(surfaceCeiling(unvalidated, 'codeCli').profile, 'B', 'C needs a literal true bridge flag even on unvalidated input');
  assert.equal(surfaceCeiling(unvalidated, 'desktopCode').profile, 'A');
  assert.equal(surfaceCeiling({}, 'codeCli').profile, 'A', 'a mission persisted before this section existed is think-only');
  assert.equal(surfaceCeiling(undefined, 'codeCli').profile, 'A');
  assert.equal(missionProfile({ surface: 'native', config, native: {} }), 'A');
  assert.equal(missionProfile({ surface: 'native', config, native: { surface: 'desktopCode' } }), 'B');
  assert.equal(missionProfile({ surface: 'native', config, native: { surface: 'codeCli' } }), 'C');
  assert.equal(missionProfile({ surface: 'desktop-chat', config, native: { surface: 'codeCli' } }), 'C', 'non-native missions keep Desktop Chat profile (here C)');
  assert.equal(missionProfile({ surface: 'desktop-chat', config: resolveConfig({ surfaces: { codeCli: code('C') } }) }), 'A', 'Code C never raises Chat');
});

test('surfaces: portable tool lists treat a missing or unrecognised profile as think-only', () => {
  const node = { role: 'implementation', permissions: { recruit: { lower: true, equal: false, higher: false }, reviewHigher: false, tools: ['read_file', 'stage_write'], roots: ['/x'] } };
  for (const profile of [undefined, null, '', 'a', 'D', 'AA', 0, 1, {}, [], '__proto__', 'constructor', 'toString']) {
    assert.deepEqual(nativeToolNames(node, profile), ['Agent'], `profile ${String(profile)}`);
    assert.ok(!nativeRootToolNames(node, profile).includes(tool('read_file')), `root profile ${String(profile)}`);
    assert.deepEqual(nativeOpenAITools(node, profile).map(t => t.name), ['Agent']);
    assert.deepEqual(runtimeTools(node, profile).map(t => t.name).sort(), ['agent_results', 'recruit_agent', 'wait_for_agents']);
  }
  assert.ok(nativeToolNames(node, 'B').includes(TOOLS.read_file)); assert.ok(!nativeToolNames(node, 'B').includes(TOOLS.stage_write));
  assert.ok(nativeToolNames(node, 'C').includes(TOOLS.stage_write)); assert.ok(nativeRootToolNames(node, 'C').includes(TOOLS.read_file));
  assert.ok(!nativeToolNames({ ...node, role: 'reviewer' }, 'C').includes(TOOLS.stage_write), 'only authors/reworkers receive stage tools');
  assert.deepEqual(nativeToolNames({ ...node, role: 'supervisor' }, 'C'), []);
});

// ---------------------------------------------------------------------------------------
// The reviewed defect, stated with the pre-fix configuration vocabulary
// ---------------------------------------------------------------------------------------

test('surfaces: REVIEWED DEFECT - Desktop Chat profile must neither grant nor revoke the explicitly authorised tools', async t => {
  const root = await project(t), permissions = { tools: ['read_file', 'stage_write'], roots: [root] };
  // (1) Converse leak: Chat C (and nothing else) used to hand a Code worker read AND stage tools.
  const chatC = await harness(t, { sessionId: 'defect-chat-c', config: { desktop: { profile: 'C', enableExecutionBridge: true, roots: [root] }, permissions } });
  const leaked = await chatC.spawn();
  assert.deepEqual(names((await chatC.handle('ultra_native_context', { hostAgentId: leaked.hostAgentId })).tools), [], 'Chat C must not enlarge Code');
  // (2) Revocation: a Code worker authorised with read_file+roots and a Code ceiling lost its tools while Chat stayed think-only.
  const codeB = await harness(t, { sessionId: 'defect-code-b', config: { desktop: { profile: 'A' }, surfaces: { codeCli: { profile: 'B', enableExecutionBridge: false } }, permissions } });
  const granted = await codeB.spawn();
  assert.deepEqual(names((await codeB.handle('ultra_native_context', { hostAgentId: granted.hostAgentId })).tools), [TOOLS.read_file], 'the Code ceiling alone must suffice');
});

// ---------------------------------------------------------------------------------------
// Exhaustive cross-surface matrix through the real NativeController
// ---------------------------------------------------------------------------------------

const GRANTS = { none: [], read: ['read_file'], 'read+stage': ['read_file', 'stage_write'] };
for (const surface of SURFACE_KEYS) for (const profile of ['A', 'B', 'C']) for (const [grantName, grantedTools] of Object.entries(GRANTS)) for (const withRoots of [true, false]) for (const others of ['A', 'C']) {
  test(`surfaces matrix: ${surface}=${profile}, tools=${grantName}, roots=${withRoots}, other surfaces/Chat=${others}`, async t => {
    const root = await project(t);
    const otherSurface = SURFACE_KEYS.find(s => s !== surface);
    // The hostile settings are every OTHER surface including Desktop Chat at ${others}; only the named ceiling may matter.
    const config = { desktop: { profile: others, enableExecutionBridge: others === 'C', roots: others === 'C' ? [root] : [] },
      surfaces: { [surface]: code(profile), [otherSurface]: code(others) }, permissions: { tools: grantedTools, roots: withRoots ? [root] : [] } };
    const h = await harness(t, { config, surfaces: HOST[surface] });
    assert.equal(h.initialized.surface, surface); assert.equal((await h.mission()).native.surface, surface);
    assert.equal(h.initialized.profile, profile, 'init reports the effective ceiling for THIS surface');
    const wantRead = rank[profile] >= 1 && grantedTools.includes('read_file'), wantStage = rank[profile] >= 2 && grantedTools.includes('stage_write');
    const expected = [...(wantRead ? [TOOLS.read_file] : []), ...(wantStage ? [TOOLS.create_stage, TOOLS.stage_read, TOOLS.stage_write, TOOLS.stage_patch] : [])].sort();
    const agent = await h.spawn('implementation');
    const context = await h.handle('ultra_native_context', { hostAgentId: agent.hostAgentId });
    assert.deepEqual(names(context.tools), expected, 'admit/bind/context advertised tools');
    assert.deepEqual(context.permissions.tools.slice().sort(), grantedTools.slice().sort(), 'the grant itself is untouched by the ceiling');
    assert.deepEqual(context.permissions.roots, withRoots ? [root] : [], 'roots are never created or enlarged by a ceiling');
    // tool.check for every governed tool
    for (const [name, full] of Object.entries(TOOLS)) {
      const check = h.handle('ultra_native_tool_check', { hostAgentId: agent.hostAgentId, tool: full, input: INPUTS[name] });
      if (expected.includes(full)) assert.deepEqual(await check, { allowed: true }, `${name} allowed`); else await assert.rejects(() => check, /outside the allocated role and scope/, `${name} denied`);
    }
    for (const full of ['Read', 'Edit', 'Write', 'Bash', `${NATIVE_PREFIX}ultra_diagnostics`]) await assert.rejects(() => h.handle('ultra_native_tool_check', { hostAgentId: agent.hostAgentId, tool: full, input: {} }), /outside the allocated role and scope/);
    // The provider request advertises exactly the same tools.
    await h.handle('ultra_native_create', { hostAgentId: agent.hostAgentId, requestKey: 'matrix-step', input: 'work', max_output_tokens: 1000 });
    assert.deepEqual(names(h.calls.at(-1).args.tools), expected, 'native API create tool list');
    // Execution through ultra_native_tool, bounded by BOTH the tool list and the PermissionBoundary profile.
    const read = () => h.handle('ultra_native_tool', { hostAgentId: agent.hostAgentId, toolUseId: 'matrix-read', tool: TOOLS.read_file, input: INPUTS.read_file });
    if (wantRead && withRoots) assert.equal((await read()).content, 'before'); else await assert.rejects(read, wantRead ? /root|configured/i : /outside the allocated role/);
    const stage = () => h.handle('ultra_native_tool', { hostAgentId: agent.hostAgentId, toolUseId: 'matrix-stage', tool: TOOLS.create_stage, input: INPUTS.create_stage });
    if (wantStage && withRoots) {
      const created = await stage();
      const hash = (await h.handle('ultra_native_tool', { hostAgentId: agent.hostAgentId, toolUseId: 'matrix-sr', tool: TOOLS.stage_read, input: { stage: created.id, path: 'source.txt' } })).sha256;
      const edited = await h.handle('ultra_native_tool', { hostAgentId: agent.hostAgentId, toolUseId: 'matrix-sw', tool: TOOLS.stage_write, input: { stage: created.id, path: 'source.txt', content: 'after', expectedSha256: hash } });
      assert.equal(edited.liveProjectModified, false);
      assert.equal((await h.handle('ultra_native_tool', { hostAgentId: agent.hostAgentId, toolUseId: 'matrix-sp', tool: TOOLS.stage_patch, input: { stage: created.id } })).patches.length, 1);
    } else await assert.rejects(stage, wantStage ? /root|configured/i : /outside the allocated role/);
    assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), 'before', 'the live project is never modified');
    // Defence in depth: the production boundary built for this node refuses beyond the ceiling even if a tool check were bypassed.
    const mission = await h.mission(), node = mission.nodes[agent.nodeId], boundary = h.controller.boundary(mission, node);
    if (rank[profile] < 2) for (const attempt of [() => boundary.createStage([{ rootId: '0', path: 'source.txt' }]), () => boundary.stageWrite('00000000-0000-4000-8000-000000000000', 'source.txt', 'x', null, '0'), () => boundary.stageDelete('00000000-0000-4000-8000-000000000000', 'source.txt', 'x')]) await assert.rejects(attempt, { code: 'PROFILE' });
    if (rank[profile] === 0 && withRoots) await assert.rejects(() => boundary.readFile('0', 'source.txt'), { code: 'PROFILE' });
    // Root orchestrator: same ceiling, same grants.
    const rootCheck = h.handle('ultra_native_tool_check', { tool: TOOLS.read_file, input: INPUTS.read_file });
    if (wantRead) assert.deepEqual(await rootCheck, { allowed: true, root: true }); else await assert.rejects(() => rootCheck, /Protected ULTRA root cannot use/);
    for (const full of [TOOLS.create_stage, TOOLS.stage_write]) await assert.rejects(() => h.handle('ultra_native_tool_check', { tool: full, input: INPUTS.create_stage }), /Protected ULTRA root cannot use/, 'the root never receives stage tools');
    const diagnostics = await h.handle('ultra_native_diagnostics');
    assert.equal(diagnostics.rootTools.includes(TOOLS.read_file), wantRead);
    assert.equal(diagnostics.surface.resolved, surface); assert.equal(diagnostics.surface.ceiling.profile, profile);
  });
}

// ---------------------------------------------------------------------------------------
// Default, disabled, unknown surface
// ---------------------------------------------------------------------------------------

test('surfaces: default configuration gives no Code file capability even when the worker is explicitly granted read/stage and roots', async t => {
  const root = await project(t);
  for (const facts of [['terminal'], ['desktop']]) {
    const h = await harness(t, { config: { permissions: { tools: ['read_file', 'stage_write'], roots: [root] } }, surfaces: facts, sessionId: `default-${facts[0]}` });
    assert.equal(h.initialized.profile, 'A');
    const agent = await h.spawn();
    assert.deepEqual(names((await h.handle('ultra_native_context', { hostAgentId: agent.hostAgentId })).tools), []);
    await assert.rejects(() => h.handle('ultra_native_tool_check', { hostAgentId: agent.hostAgentId, tool: TOOLS.read_file, input: INPUTS.read_file }), /outside the allocated role/);
    const d = await h.handle('ultra_native_diagnostics');
    assert.deepEqual(d.surface.ceilings.codeCli, { surface: 'codeCli', configured: 'A', profile: 'A', enableExecutionBridge: false });
    assert.equal(d.surface.ceilings.desktopChat.profile, 'A'); assert.deepEqual(d.rootTools.filter(n => n.includes('read_file')), []);
  }
});

test('surfaces: Chat C or desktop.roots never grant a Code worker anything (the reviewed defect), and Code B never needs Chat', async t => {
  const root = await project(t);
  const chatOnly = await harness(t, { sessionId: 'chat-c-only', config: { desktop: { profile: 'C', enableExecutionBridge: true, roots: [root] }, permissions: { tools: ['read_file', 'stage_write'], roots: [root] } } });
  const a = await chatOnly.spawn();
  assert.deepEqual(names((await chatOnly.handle('ultra_native_context', { hostAgentId: a.hostAgentId })).tools), [], 'Chat C does not enlarge a Code worker');
  const codeOnly = await harness(t, { sessionId: 'code-b-chat-a', config: { desktop: { profile: 'A' }, surfaces: { codeCli: code('B') }, permissions: { tools: ['read_file'], roots: [root] } } });
  const b = await codeOnly.spawn();
  assert.deepEqual(names((await codeOnly.handle('ultra_native_context', { hostAgentId: b.hostAgentId })).tools), [TOOLS.read_file], 'a think-only Chat does not strip an authorised Code worker');
  assert.equal((await codeOnly.handle('ultra_native_tool', { hostAgentId: b.hostAgentId, toolUseId: 'read-1', tool: TOOLS.read_file, input: INPUTS.read_file })).content, 'before');
});

test('surfaces: an owner who sets only the Desktop Code ceiling does not enable the CLI and vice versa', async t => {
  const root = await project(t), permissions = { tools: ['read_file'], roots: [root] };
  const desktop = await harness(t, { sessionId: 'desktop-only', surfaces: ['desktop'], config: { surfaces: { desktopCode: code('B') }, permissions } });
  const cli = await harness(t, { sessionId: 'cli-under-desktop-config', surfaces: ['terminal'], config: { surfaces: { desktopCode: code('B') }, permissions } });
  for (const [h, expected] of [[desktop, [TOOLS.read_file]], [cli, []]]) {
    const agent = await h.spawn(); assert.deepEqual(names((await h.handle('ultra_native_context', { hostAgentId: agent.hostAgentId })).tools), expected);
  }
  assert.equal(desktop.initialized.profile, 'B'); assert.equal(cli.initialized.profile, 'A');
});

test('surfaces: disabled configuration refuses initialisation before any surface is recorded', async t => {
  const directory = await tmp(t);
  const store = new ExecutionStore(path.join(directory, 'execution.json'));
  const broker = new RecruitmentBroker(store, { config: { enabled: false, surfaces: { codeCli: code('C') } } });
  const controller = new NativeController(broker, { backend: Object.assign(async () => { throw new Error('No API expected'); }, { offline: true }) });
  await assert.rejects(() => controller.handle('ultra_native_init', { sessionId: 'disabled-session', model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false, surfaces: ['terminal'] }, transport), /disabled/i);
  assert.deepEqual(Object.keys((await store.snapshot()).missions), []);
});

test('surfaces: unreported, malformed, mixed or unqualified surfaces fail closed to think-only even when every ceiling is C', async t => {
  const root = await project(t);
  const config = { desktop: { profile: 'C', enableExecutionBridge: true, roots: [root] }, surfaces: { codeCli: code('C'), desktopCode: code('C') }, permissions: { tools: ['read_file', 'stage_write'], roots: [root] } };
  const cases = [['unreported', ['terminal'], { surfaces: undefined }], ['empty', [], {}], ['vscode', ['vscode'], {}], ['mobile attach', ['terminal', 'mobile'], {}], ['both terminal and desktop', ['terminal', 'desktop'], {}],
    ['wrong type', 'desktop', {}], ['case variant', ['Terminal'], {}], ['prototype key', ['constructor'], {}], ['legacy field disagreeing', ['terminal'], { surface: 'desktop' }]];
  let n = 0;
  for (const [label, surfaces, init] of cases) {
    const h = await harness(t, { config, surfaces, init, sessionId: `unknown-${++n}` });
    assert.equal(h.initialized.surface, 'unknown', label); assert.equal(h.initialized.profile, 'A', label);
    const agent = await h.spawn();
    assert.deepEqual(names((await h.handle('ultra_native_context', { hostAgentId: agent.hostAgentId })).tools), [], label);
    await assert.rejects(() => h.handle('ultra_native_tool_check', { hostAgentId: agent.hostAgentId, tool: TOOLS.read_file, input: INPUTS.read_file }), /outside the allocated role/, label);
    await assert.rejects(() => h.handle('ultra_native_tool_check', { tool: TOOLS.read_file, input: INPUTS.read_file }), /Protected ULTRA root/, label);
    const mission = await h.mission(); assert.equal(mission.native.surface, 'unknown');
    await assert.rejects(() => h.controller.boundary(mission, mission.nodes[agent.nodeId]).readFile('0', 'source.txt'), { code: 'PROFILE' }, label);
    const d = await h.handle('ultra_native_diagnostics');
    assert.equal(d.surface.resolved, 'unknown'); assert.equal(d.surface.ceiling.profile, 'A');
    assert.equal(d.surface.ceilings.codeCli.profile, 'C', 'diagnostics still reports the configured ceilings truthfully');
  }
});

test('surfaces: a mission persisted before this section existed is think-only until a new mission is authorised', async t => {
  const root = await project(t);
  const h = await harness(t, { config: { surfaces: { codeCli: code('C') }, permissions: { tools: ['read_file', 'stage_write'], roots: [root] } } });
  const agent = await h.spawn();
  await h.store.transaction(state => { const m = state.missions[h.missionId]; delete m.config.surfaces; delete m.native.surface; delete m.native.hostSurfaces; });
  assert.deepEqual(names((await h.handle('ultra_native_context', { hostAgentId: agent.hostAgentId })).tools), []);
  const d = await h.handle('ultra_native_diagnostics'); assert.equal(d.surface.resolved, 'unknown'); assert.equal(d.surface.ceiling.profile, 'A');
});

test('surfaces: host WSL refusal covers every Desktop fact, not only the legacy field', async t => {
  for (const [label, surfaces, init] of [['desktop surfaces', ['desktop'], {}], ['desktop legacy field', undefined, { surface: 'desktop' }], ['desktop plus terminal', ['terminal', 'desktop'], {}]]) {
    await assert.rejects(() => harness(t, { surfaces, init: { platform: 'wsl', ...init }, sessionId: `wsl-${label.replaceAll(' ', '-')}`, config: { surfaces: { desktopCode: code('B') } } }), /Desktop WSL/, label);
  }
  const cliWsl = await harness(t, { surfaces: ['terminal'], init: { platform: 'wsl' }, sessionId: 'wsl-cli', config: { surfaces: { codeCli: code('B') } } });
  assert.equal(cliWsl.initialized.surface, 'codeCli');
});

// ---------------------------------------------------------------------------------------
// Policy hash, reopen, cache
// ---------------------------------------------------------------------------------------

test('surfaces: changing a ceiling changes the policy hash and cannot silently re-authorise an existing native mission', async t => {
  const directory = await tmp(t), root = await project(t), permissions = { tools: ['read_file'], roots: [root] };
  const first = await harness(t, { directory, sessionId: 'rehash', config: { surfaces: { codeCli: code('A') }, permissions } });
  const m = await first.mission(); assert.equal(m.policyHash, policyHash(m.config));
  const raised = resolveConfig({ enabled: true, surfaces: { codeCli: code('C') }, permissions });
  assert.notEqual(policyHash(raised), m.policyHash);
  const broker = new RecruitmentBroker(first.store, { config: raised });
  await assert.rejects(() => new NativeController(broker, { backend: Object.assign(async () => ({}), { offline: true }) })
    .handle('ultra_native_init', { sessionId: 'rehash', model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false, surfaces: ['terminal'] }, transport), /already used for different work or authority/);
  assert.equal((await first.mission()).config.surfaces.codeCli.profile, 'A', 'the stored mission keeps the ceiling it was authorised under');
  // A fresh session under the raised ceiling is a new mission with the new hash.
  const second = await harness(t, { directory: await tmp(t), sessionId: 'rehash-new', config: { surfaces: { codeCli: code('C') }, permissions } });
  assert.notEqual((await second.mission()).policyHash, m.policyHash); assert.equal(second.initialized.profile, 'C');
});

test('surfaces: re-initialisation records the new host surface and the boundary cache cannot outlive a profile change', async t => {
  const root = await project(t);
  const h = await harness(t, { sessionId: 'reopen', config: { surfaces: { codeCli: code('B'), desktopCode: code('A') }, permissions: { tools: ['read_file'], roots: [root] } } });
  const agent = await h.spawn(); const before = await h.mission();
  const wide = h.controller.boundary(before, before.nodes[agent.nodeId]);
  assert.equal((await wide.readFile('0', 'source.txt')).content, 'before');
  const reopened = await h.controller.handle('ultra_native_init', { sessionId: 'reopen', model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false, surfaces: ['desktop'] }, transport);
  assert.equal(reopened.surface, 'desktopCode'); assert.equal(reopened.profile, 'A');
  const after = await h.store.snapshot(h.missionId);
  assert.equal(after.native.surface, 'desktopCode'); assert.deepEqual(after.native.hostSurfaces, ['desktop']);
  assert.equal((await h.store.snapshot()).events.filter(e => e.type === 'native.channel').at(-1).data.surface, 'desktopCode');
  const narrow = h.controller.boundary(after, after.nodes[agent.nodeId]);
  assert.notEqual(narrow, wide, 'a boundary built for B is never reused for A');
  await assert.rejects(() => narrow.readFile('0', 'source.txt'), { code: 'PROFILE' });
  assert.equal(h.controller.boundary(before, before.nodes[agent.nodeId]), wide, 'and the same profile still reuses its boundary');
});

// ---------------------------------------------------------------------------------------
// Other consumers of the profile
// ---------------------------------------------------------------------------------------

test('surfaces: a native mission\'s API nodes run under the Code ceiling, never Desktop Chat\'s profile', async t => {
  const root = await project(t);
  for (const [desktop, codeProfile, expectRead] of [['C', 'A', false], ['A', 'B', true], ['A', 'A', false]]) {
    const h = await harness(t, { sessionId: `runtime-${desktop}-${codeProfile}`, config: { desktop: code(desktop, { roots: [root] }), surfaces: { codeCli: code(codeProfile) }, permissions: { tools: ['read_file'], roots: [root] } } });
    let tools = null;
    const backend = Object.assign(async (name, args) => { if (name === 'create') { tools = args.tools.map(x => x.name); return { id: 'resp_runtime_surface', status: 'completed', model: args.model, text: 'done', usage: { total: 20 }, estimatedUsd: 0.001, calls: [] }; } throw new Error(name); }, { offline: true });
    const runtime = new UltraRuntime(h.broker, { backend });
    const requested = await h.broker.request(h.missionId, 'root', { worker: 'luna', task: 'API exploration inside a native mission', role: 'exploration', risk, budget: { tokens: 20000, usd: 1 } }, 'runtime-surface');
    assert.ok(requested.nodeId, JSON.stringify(requested.evaluation));
    await runtime.tick(h.missionId);
    assert.ok(tools, 'the runtime node actually issued a provider request');
    assert.equal(tools.includes('read_file'), expectRead, `desktop=${desktop} code=${codeProfile}`);
    const mission = await h.mission(); assert.equal(missionProfile(mission), codeProfile);
    const probe = runtime.boundary(mission, mission.nodes[requested.nodeId]);
    if (expectRead) assert.equal((await probe.readFile('0', 'source.txt')).content, 'before'); else await assert.rejects(() => probe.readFile('0', 'source.txt'), { code: 'PROFILE' });
  }
});

test('surfaces: Desktop Chat keeps using desktop.profile and ignores every Code ceiling', async t => {
  const root = await project(t), directory = await tmp(t);
  const service = (config) => new UltraService({ config: resolveConfig({ enabled: true, permissions: { tools: ['read_file'], roots: [root] }, ...config }), store: new ExecutionStore(path.join(directory, `${Math.random()}.json`)), backend: Object.assign(async () => { throw new Error('No API'); }, { offline: true }), env: {} });
  const read = s => s.invoke('ultra_read_project', { root: '0', path: 'source.txt' });
  await assert.rejects(() => read(service({ surfaces: { codeCli: code('C'), desktopCode: code('C') } })), /PROFILE|Think-only/i);
  await assert.rejects(() => read(service({ desktop: { profile: 'B', enableExecutionBridge: false, roots: [] }, surfaces: { codeCli: code('C') } })), /not configured|ROOT/i, 'Chat roots are a separate allowlist');
  assert.equal((await read(service({ desktop: { profile: 'B', roots: [root] } }))).content, 'before');
  assert.equal((await read(service({ desktop: { profile: 'C', enableExecutionBridge: true, roots: [root] }, surfaces: { codeCli: code('A'), desktopCode: code('A') } }))).content, 'before', 'a think-only Code ceiling does not weaken Chat');
  const s = service({ surfaces: { codeCli: code('B') } });
  assert.equal(s.config.desktop.profile, 'A'); assert.equal((await s.invoke('ultra_diagnostics', {})).desktop.profile, 'A');
});

test('surfaces: PermissionBoundary profile enforcement for read, stage create, write and patch', async t => {
  const root = await project(t), stages = await tmp(t, 'ultra-surfaces-stages-');
  const make = profile => new PermissionBoundary({ profile, roots: [{ id: '0', path: root, read: ['.'], write: ['.'] }], principal: { id: 'author', role: 'implementation' } }, { stageDirectory: path.join(stages, profile) });
  const refused = (promise, code) => assert.rejects(() => promise, { code });
  await refused(make('A').readFile('0', 'source.txt'), 'PROFILE');
  await refused(make('A').createStage([{ rootId: '0', path: 'source.txt' }]), 'PROFILE');
  assert.equal((await make('B').readFile('0', 'source.txt')).content, 'before');
  await refused(make('B').createStage([{ rootId: '0', path: 'source.txt' }]), 'PROFILE');
  await refused(make('B').stageWrite('11111111-1111-4111-8111-111111111111', 'source.txt', 'x', null), 'PROFILE');
  await refused(make('B').stageDelete('11111111-1111-4111-8111-111111111111', 'source.txt', 'x'), 'PROFILE');
  await refused(make('B').recoverStage('11111111-1111-4111-8111-111111111111'), 'PROFILE');
  await refused(make('B').stagePatch('11111111-1111-4111-8111-111111111111'), 'STAGE');
  const c = make('C'), stage = await c.createStage([{ rootId: '0', path: 'source.txt' }]);
  const edited = await c.stageWrite(stage.id, 'source.txt', 'after', (await c.stageRead(stage.id, 'source.txt')).sha256);
  assert.equal(edited.liveProjectModified, false); assert.equal(await fs.readFile(path.join(root, 'source.txt'), 'utf8'), 'before');
  assert.equal((await c.stagePatch(stage.id)).patches.length, 1);
  assert.throws(() => new PermissionBoundary({ profile: 'D', roots: [] }), { code: 'PROFILE' });
});

// ---------------------------------------------------------------------------------------
// Host mod: trusted surface facts reach the controller
// ---------------------------------------------------------------------------------------

async function modHarness(t, { surfaces, config = {}, surfaceFails = false, noSurfaceApi = false }) {
  const directory = await tmp(t), root = await project(t);
  const store = new ExecutionStore(path.join(directory, 'execution.json'));
  const broker = new RecruitmentBroker(store, { config: { enabled: true, permissions: { tools: ['read_file'], roots: [root] }, ...config } });
  const controller = new NativeController(broker, { backend: Object.assign(async () => { throw new Error('No API'); }, { offline: true }) });
  const handlers = new Map(), initCalls = [];
  register((event, filter, fn) => { if (typeof filter === 'function') { fn = filter; filter = null; } if (!filter?.tool && !filter?.command) handlers.set(event, fn); return { catch() { return this; } }; });
  const session = { version: async () => ({ version: '2.1.326' }), model: async () => 'opus', id: async () => 'mod-session', info: async () => ({ platform: 'linux', isHosted: false, dataRules: [] }) };
  if (!noSurfaceApi) session.surfaces = async () => { if (surfaceFails) throw new Error('surfaces unavailable'); return surfaces; };
  const context = { env: { get: async name => name === 'OPENAI_ULTRA_ENABLED' ? '1' : undefined }, session, tool: { register: async () => {} }, agent: { register: async () => {} }, command: { register: async () => {} },
    mcp: { call: async (_server, name, args) => { if (name === 'ultra_native_init') initCalls.push(structuredClone(args)); return { content: [{ type: 'text', text: JSON.stringify(await controller.handle(name, args, transport)) }] }; } } };
  await handlers.get('session.start')(context, {}, async value => value);
  return { initCalls, store, root };
}

test('surfaces: the installed mod forwards host-reported surfaces and an absent or failing report is an unknown surface', async t => {
  const cases = [['desktop', ['desktop'], {}, 'desktopCode'], ['terminal', ['terminal'], {}, 'codeCli'], ['plain -p run', [], {}, 'unknown'], ['failing report', undefined, { surfaceFails: true }, 'unknown'],
    ['no API', undefined, { noSurfaceApi: true }, 'unknown'], ['non-array report', 'desktop', {}, 'unknown'], ['oversized report', Array(40).fill('terminal'), {}, 'codeCli'], ['non-string entries', [{ desktop: true }, 7], {}, 'unknown']];
  for (const [label, surfaces, options, expected] of cases) {
    const h = await modHarness(t, { surfaces, ...options });
    assert.equal(h.initCalls.length, 1, label);
    assert.ok(Array.isArray(h.initCalls[0].surfaces) && h.initCalls[0].surfaces.length <= 8 && h.initCalls[0].surfaces.every(s => typeof s === 'string'), `${label}: only a bounded string list crosses the channel`);
    const mission = Object.values((await h.store.snapshot()).missions).find(m => m.surface === 'native');
    assert.equal(mission.native.surface, expected, label);
  }
});

// ---------------------------------------------------------------------------------------
// Owner CLI
// ---------------------------------------------------------------------------------------

test('surfaces: project-add configures exactly the named surface and no other', async t => {
  const directory = await tmp(t), root = await tmp(t, 'ultra-surfaces-cli-project-');
  const env = { OPENAI_ULTRA_STATE_DIR: path.join(directory, 'state'), OPENAI_ULTRA_CONFIG: path.join(directory, 'policy.json') };
  const run = async (...argv) => { let out; await cli(argv, { env, print: value => { out = value; } }); return out; };
  const read = () => readOwnerConfig(env);
  const baseline = await read();
  for (const bad of [[root, 'B'], [root], [root, 'C', '--surface', 'both'], [root, 'B', '--surface'], [root, 'B', '--surface=vscode'], [root, 'B', '--surface', 'codeCli', '--surface', 'chat'], [root, 'B', '--surfaces', 'codeCli'], [root, 'B', '--surface', '__proto__'], [root, 'A', '--surface', 'codeCli']]) {
    await assert.rejects(() => run('project-add', ...bad), /explicit --surface|Specify --surface|Unknown project-add|Choose B or C/, JSON.stringify(bad));
    assert.deepEqual(await read(), baseline, `a refused command changes nothing: ${JSON.stringify(bad)}`);
  }
  const sections = c => ({ desktop: c.desktop, surfaces: c.surfaces });
  let result = await run('project-add', root, 'C', '--surface', 'codeCli');
  assert.equal(result.surface, 'codeCli');
  let config = await read();
  assert.deepEqual(config.surfaces.codeCli, code('C')); assert.deepEqual(config.surfaces.desktopCode, baseline.surfaces.desktopCode); assert.deepEqual(config.desktop, baseline.desktop, 'Chat untouched by a Code surface');
  assert.deepEqual(config.permissions.roots, [root]); assert.deepEqual(config.permissions.tools.slice().sort(), ['read_file', 'stage_write']);
  const afterCli = sections(config);
  await run('project-add', root, 'B', '--surface=desktopCode');
  config = await read();
  assert.deepEqual(config.surfaces.desktopCode, code('B')); assert.deepEqual(config.surfaces.codeCli, afterCli.surfaces.codeCli); assert.deepEqual(config.desktop, afterCli.desktop);
  await run('project-add', root, 'B', '--surface', 'chat');
  config = await read();
  assert.equal(config.desktop.profile, 'B'); assert.deepEqual(config.desktop.roots, [root]);
  assert.deepEqual(config.surfaces, afterCli.surfaces === undefined ? {} : { codeCli: code('C'), desktopCode: code('B') }, 'Chat leaves both Code ceilings alone');
  await run('project-add', root, 'B', '--surface', 'codeCli');
  assert.deepEqual((await read()).surfaces.codeCli, code('B'), 'lowering C->B also clears the bridge flag');
  assert.equal((await read()).enabled, false, 'project-add never enables ULTRA');
  assert.ok(ownerPaths(env).config.endsWith('policy.json'));
});

test('surfaces: the legacy set command can edit a surface but cannot create an unvalidated ceiling', async t => {
  const directory = await tmp(t);
  const env = { OPENAI_ULTRA_STATE_DIR: path.join(directory, 'state'), OPENAI_ULTRA_CONFIG: path.join(directory, 'policy.json') };
  const run = (...argv) => cli(argv, { env, print: () => {} });
  await run('set', 'surfaces.desktopCode.profile', '"B"');
  assert.equal((await readOwnerConfig(env)).surfaces.desktopCode.profile, 'B');
  await assert.rejects(() => run('set', 'surfaces.desktopCode.profile', '"C"'), /requires explicit enableExecutionBridge/);
  await assert.rejects(() => run('set', 'surfaces.chat.profile', '"C"'), /Unknown configuration/);
  await assert.rejects(() => run('set', 'surfaces.codeCli.profile', '"Z"'), /must be one of A, B, C/);
  assert.equal((await readOwnerConfig(env)).surfaces.desktopCode.profile, 'B');
});
