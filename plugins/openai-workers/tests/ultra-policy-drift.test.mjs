// F2 / POLICY-01: owner policy TIGHTENING must be enforced on an already-open native mission.
//
// Driven through the production path: signed ultra_native_* requests into the real
// bridge dispatcher, which re-reads the owner policy file on every request. The
// owner edits the policy file between calls, exactly as a person would. Attenuation
// only: nothing here may ever enlarge what a session was opened with.
import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NATIVE_PREFIX } from '../hooks/ultra.js';
import { resolveConfig, policyHash, validateConfig, canonical } from '../ultra/config.mjs';
import { attenuateConfig } from '../ultra/attenuation.mjs';
import { bridgeHost, recordingTransport } from './bridge-host.mjs';

const READ = `${NATIVE_PREFIX}ultra_read_file`;
const CODE_B = project => ({ surfaces: { codeCli: { profile: 'B' } }, permissions: { tools: ['read_file'], roots: [project] } });
const read = (h, key = `read-${Math.random().toString(16).slice(2)}`) => h.call('ultra_native_tool', { ...h.s.common, hostAgentId: h.s.hostAgentId, tool: READ, input: { rootId: '0', path: 'source.txt' }, toolUseId: key, primaryModel: 'opus' });
const context = h => h.call('ultra_native_context', { ...h.s.common, hostAgentId: h.s.hostAgentId });
const toolNames = async h => (await context(h)).tools.map(x => x.name);
const diagnostics = h => h.call('ultra_native_diagnostics', h.s.common);
const create = (h, key, extra = {}) => h.call('ultra_native_create', { ...h.s.common, hostAgentId: h.s.hostAgentId, requestKey: key, input: 'a bounded step', max_output_tokens: 1000, ...extra });

/** An open codeCli=B session that has already read a file, as the first half of every scenario. */
async function opened(t, { policy = {}, env = {}, transport = recordingTransport() } = {}) {
  const h = await bridgeHost(t, { transport, env, project: { 'source.txt': 'private project source\n' } });
  await h.writePolicy({ ...CODE_B(h.project), ...policy });
  h.s = await h.session('drift-session', { prompt: JSON.stringify({ task: 'Synthetic drift fixture', ultra: { role: 'implementation', risk: { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 0.95, rationale: 'fixture' }, budget: { tokens: 40000, usd: 4 } } }) });
  assert.equal(h.s.admitted.allowed, true, JSON.stringify(h.s.admitted));
  assert.ok((await toolNames(h)).includes(READ), 'a B surface with a granted root and tool lists the read tool');
  assert.match((await read(h)).content, /private project source/, 'the baseline read works');
  return h;
}

test('POLICY-01: lowering the surface ceiling takes effect on the open session immediately', async t => {
  const h = await opened(t);
  await h.writePolicy({ ...CODE_B(h.project), surfaces: { codeCli: { profile: 'A' } } });
  assert.ok(!(await toolNames(h)).includes(READ), 'the worker no longer lists the read tool');
  await assert.rejects(() => read(h), /outside the allocated role|Think-only|scope|ceiling/i, 'and cannot read');
  const state = await diagnostics(h);
  assert.equal(state.surface.ceiling.profile, 'A', 'diagnostics report the effective ceiling, not the frozen one');
  assert.ok(!state.rootTools.includes(READ));
  assert.notEqual(state.policy.currentOwnerPolicyHash, state.policy.authorisedPolicyHash, 'diagnostics say the owner policy moved');
  assert.equal(state.policy.attenuations.length, 1);
});

test('POLICY-01: removing the root or the read tool from the owner grant is enforced on the open session', async t => {
  for (const [label, edit] of Object.entries({
    'roots removed': h => ({ ...CODE_B(h.project), permissions: { tools: ['read_file'], roots: [] } }),
    'tool removed': h => ({ ...CODE_B(h.project), permissions: { tools: [], roots: [h.project] } }),
  })) {
    const h = await opened(t);
    await h.writePolicy(edit(h));
    await assert.rejects(() => read(h), /./, `${label}: the read is refused`);
    const granted = (await context(h)).permissions;
    if (label === 'tool removed') assert.ok(!(await toolNames(h)).includes(READ), `${label}: the worker tool list shrinks`);
    else assert.deepEqual(granted.roots, [], `${label}: the allocation keeps no root`);
    if (label === 'tool removed') assert.ok(!granted.tools.includes('read_file'));
  }
});

test('POLICY-01: lowering a mission budget or fleet allowance is enforced before the next API request', async t => {
  const transport = recordingTransport(), h = await opened(t, { transport });
  await h.writePolicy({ ...CODE_B(h.project), mission: { maxUsd: 1 } });
  await assert.rejects(() => create(h, 'step-1'), /USD budget exhausted|budget/i);
  assert.equal(transport.calls.create.length, 0, 'refused before any POST');
  // Fleet allowance: the open mission already holds its allocation; one fewer slot than it uses blocks new recruitment.
  const second = await opened(t, { transport: recordingTransport() });
  await second.writePolicy({ ...CODE_B(second.project), fleets: { core: { maxDepth: 2, maxInvocations: 1, concurrency: 4, reserved: 0 } } });
  const admitted = await second.call('ultra_native_admit', { ...second.s.common, toolUseId: 'spawn-2', primaryModel: 'opus', parentModel: 'opus', subagentType: 'oai:luna6',
    prompt: JSON.stringify({ task: 'Second fixture', ultra: { role: 'implementation', risk: { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 0.95, rationale: 'fixture' }, budget: { tokens: 1000, usd: 0.05 } } }) }).catch(error => ({ allowed: false, reason: error.message }));
  assert.equal(admitted.allowed, false, `recruitment under a lowered fleet allowance must be refused: ${JSON.stringify(admitted)}`);
});

test('POLICY-01: disabling or corrupting the owner policy mid-session fails closed, and the original session is not revived by repairing it', async t => {
  const h = await opened(t);
  await h.writePolicy({ ...CODE_B(h.project), enabled: false });
  for (const operation of [() => read(h), () => context(h), () => create(h, 'disabled-step')]) await assert.rejects(operation, /disabled/i);
  assert.equal(h.transport.calls.create.length, 0);
  assert.ok((await diagnostics(h)).missionId, 'diagnostics stay available so the owner can see the session');
  const wound = await h.call('ultra_native_cancel', h.s.common);
  assert.ok(wound.includes('root'), 'cancel stays available so the session can be wound down');
  await assert.rejects(() => h.call('ultra_native_init', { sessionId: 'new-while-disabled', model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false, surfaces: ['terminal'] }), /disabled/i, 'nothing new opens');

  const g = await opened(t);
  await writeFile(join(g.dir, 'ultra-policy.json'), '{ this is not json');
  for (const operation of [() => read(g), () => diagnostics(g), () => context(g), () => create(g, 'step-1')]) await assert.rejects(operation, /policy is invalid|Owner ULTRA policy/i, 'an unreadable policy refuses, it does not fall back to the frozen mission config');
  assert.equal(g.transport.calls.create.length, 0);
});

test('POLICY-01: tightening is one-way: re-raising the owner policy never enlarges an open session, a new session gets the new policy', async t => {
  const h = await opened(t);
  await h.writePolicy({ ...CODE_B(h.project), surfaces: { codeCli: { profile: 'A' } } });
  await assert.rejects(() => read(h));
  await h.writePolicy({ ...CODE_B(h.project), surfaces: { codeCli: { profile: 'C', enableExecutionBridge: true } }, permissions: { tools: ['read_file', 'stage_write'], roots: [h.project] } });
  const after = await diagnostics(h);
  assert.equal(after.surface.ceiling.profile, 'A', 'the open session stays at the lowest ceiling it has been held to');
  assert.ok(!(await toolNames(h)).includes(READ));
  assert.ok(!(await context(h)).permissions.tools.includes('stage_write'), 'a raised owner grant is never added to an existing allocation');
  const fresh = await h.session('new-session-after-raise');
  assert.equal(fresh.admitted.allowed, true);
  const tools = (await h.call('ultra_native_context', { ...fresh.common, hostAgentId: fresh.hostAgentId })).tools.map(x => x.name);
  assert.ok(tools.includes(READ), `a NEW session opens under the current owner policy: ${tools.join(',')}`);
});

test('POLICY-01: cancel and diagnostics stay available to the owner after tightening; reopening after a policy change says why', async t => {
  const h = await opened(t);
  await h.writePolicy({ ...CODE_B(h.project), surfaces: { codeCli: { profile: 'A' } } });
  assert.ok((await diagnostics(h)).missionId);
  await assert.rejects(() => h.call('ultra_native_init', { sessionId: 'drift-session', model: 'opus', version: '2.1.326', platform: 'linux', isHosted: false, surfaces: ['terminal'], currentCapability: h.s.common.capability }),
    /owner (ULTRA )?policy changed/i, 'the reopen refusal names the real cause instead of the generic mission-identity message');
  const cancelled = await h.call('ultra_native_cancel', h.s.common);
  assert.ok(Array.isArray(cancelled) && cancelled.includes('root'));
});

test('POLICY-01: an unchanged owner policy changes nothing (no spurious attenuation, no extra writes)', async t => {
  const h = await opened(t);
  const before = (await h.ledger()).events.filter(e => e.type === 'native.policy_attenuated').length;
  await read(h); await diagnostics(h); await context(h);
  assert.equal((await h.ledger()).events.filter(e => e.type === 'native.policy_attenuated').length, before);
  assert.equal((await diagnostics(h)).policy.attenuations.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// The attenuation function itself: never enlarges either input, always valid.

const variants = [
  {}, { enabled: true },
  { surfaces: { codeCli: { profile: 'B' } } }, { surfaces: { codeCli: { profile: 'C', enableExecutionBridge: true }, desktopCode: { profile: 'B' } } },
  { permissions: { tools: ['read_file'], roots: [process.platform === 'win32' ? 'C:\\proj' : '/proj'] } },
  { permissions: { tools: ['read_file', 'stage_write'], roots: [process.platform === 'win32' ? 'C:\\proj\\sub' : '/proj/sub', process.platform === 'win32' ? 'D:\\other' : '/other'] } },
  { permissions: { recruit: { lower: true, equal: false, higher: false }, reviewHigher: false } },
  { recruitment: { mode: 'SKYNET' } }, { recruitment: { mode: 'SWARM' } }, { recruitment: { mode: 'CUSTOM', custom: { lower: false, equal: true, higher: false }, reviewHigher: false } },
  { fleets: { core: { maxDepth: 1, maxInvocations: 3, concurrency: 2, reserved: 0 }, review: { maxDepth: 3, maxInvocations: 20, concurrency: 5, reserved: 2 } } },
  { mission: { maxUsd: 2, maxTokens: 1000, maxWallMs: 60000, requestsPerMinute: 10, maxRetries: 1, perKey: { standard: { maxTokens: null, maxUsd: 1, maxRequests: 3 } }, perModel: {} } },
  { mission: { maxUsd: null, maxTokens: 500, perKey: { free: { maxTokens: 10, maxUsd: null, maxRequests: null } } } },
  { desktop: { profile: 'B', enableExecutionBridge: false, roots: [process.platform === 'win32' ? 'C:\\proj' : '/proj'] } },
];
const rank = { A: 0, B: 1, C: 2 }, tighterOrEqual = (out, source) => source === null || out !== null && out <= source;

test('attenuateConfig: the result is valid, never exceeds either input, and equals the stored config when the owner only loosened', () => {
  for (const a of variants) for (const b of variants) {
    const stored = resolveConfig({ enabled: true, ...a }), current = resolveConfig({ enabled: true, ...b }), out = attenuateConfig(stored, current);
    validateConfig(out);
    for (const key of ['codeCli', 'desktopCode']) {
      for (const source of [stored, current]) assert.ok(rank[out.surfaces[key].profile] <= rank[source.surfaces[key].profile], `${key} profile`);
      assert.ok(!out.surfaces[key].enableExecutionBridge || stored.surfaces[key].enableExecutionBridge && current.surfaces[key].enableExecutionBridge);
    }
    for (const tool of out.permissions.tools) assert.ok(stored.permissions.tools.includes(tool) && current.permissions.tools.includes(tool), `tool ${tool}`);
    for (const flag of ['lower', 'equal', 'higher']) assert.ok(!out.permissions.recruit[flag] || stored.permissions.recruit[flag] && current.permissions.recruit[flag]);
    assert.ok(!out.permissions.reviewHigher || stored.permissions.reviewHigher && current.permissions.reviewHigher);
    for (const field of ['maxTokens', 'maxUsd', 'maxWallMs', 'requestsPerMinute']) for (const source of [stored, current]) assert.ok(tighterOrEqual(out.mission[field], source.mission[field]), `mission.${field}`);
    for (const field of ['maxOutstanding', 'maxJobs', 'maxRetries']) for (const source of [stored, current]) assert.ok(out.mission[field] <= source.mission[field], `mission.${field}`);
    for (const pool of ['core', 'review']) for (const field of ['maxDepth', 'maxInvocations', 'concurrency']) for (const source of [stored, current]) assert.ok(out.fleets[pool][field] <= source.fleets[pool][field], `fleets.${pool}.${field}`);
    assert.ok(out.fleets.review.reserved >= Math.min(stored.fleets.review.reserved, out.fleets.review.concurrency - 1));
    assert.equal(canonical(attenuateConfig(out, current)), canonical(out), 'idempotent');
    assert.equal(canonical(attenuateConfig(stored, stored)), canonical(stored), 'no change when nothing differs');
  }
  const looser = resolveConfig({ enabled: true, surfaces: { codeCli: { profile: 'B' } } }), wider = resolveConfig({ enabled: true, surfaces: { codeCli: { profile: 'C', enableExecutionBridge: true } } });
  assert.equal(attenuateConfig(looser, wider).surfaces.codeCli.profile, 'B', 'a raised owner ceiling never lifts a stored mission');
  assert.equal(policyHash(attenuateConfig(looser, wider)), policyHash(looser));
});

test('attenuateConfig: a stored config without the surface section (older mission) is treated as think-only, and malformed input fails closed', () => {
  const stored = structuredClone(resolveConfig({ enabled: true })); delete stored.surfaces;
  assert.equal(attenuateConfig(stored, resolveConfig({ enabled: true, surfaces: { codeCli: { profile: 'B' } } })).surfaces.codeCli.profile, 'A');
  assert.throws(() => attenuateConfig(resolveConfig({ enabled: true }), { enabled: 'yes' }));
  assert.throws(() => attenuateConfig(null, resolveConfig({ enabled: true })));
});
