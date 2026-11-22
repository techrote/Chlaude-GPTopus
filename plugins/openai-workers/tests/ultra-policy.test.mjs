import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, resolveConfig, validateConfig, modeFlags, policyHash, migrateConfig, profileConfig } from '../ultra/config.mjs';
import { evaluateRecruitment, combineApprovals, intersectPermissions, orchestratorIdentity } from '../ultra/policy.mjs';
import { assessRisk, overrideRisk } from '../ultra/risk.mjs';

const lowRisk = { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 0.95, reversibility: 'reversible', testsAvailable: true };
const config = patch => resolveConfig({ enabled: true }, patch ?? {});
function root(c, model = 'opus', trusted = true) {
  return { config: c, parent: { id: 'root', role: 'orchestrator', permissions: c.permissions, depth: { core: 0, review: 0 } },
    mission: { rootAgentId: 'root', orchestrator: { model, trusted, source: 'test-host' } } };
}
function parent(c, worker = 'sol', mode = 'SWARM') {
  const spec = c.workers[worker];
  return { id: `parent-${worker}`, role: 'implementation', worker, model: spec.model, family: spec.family, keyProfile: spec.keyProfile,
    mode, permissions: { ...structuredClone(c.permissions), recruit: modeFlags(mode, c.recruitment.custom) }, depth: { core: 1, review: 0 } };
}
const req = (worker, extra = {}) => ({ worker, role: 'implementation', risk: lowRisk, budget: { tokens: 2000, usd: 0.03 }, ...extra });

test('ULTRA is opt-in; six workers and Lite protected fleet defaults remain exact', () => {
  assert.equal(DEFAULT_CONFIG.enabled, false);
  assert.equal(Object.keys(DEFAULT_CONFIG.workers).length, 6);
  assert.deepEqual(DEFAULT_CONFIG.fleets, { core: { maxDepth: 2, maxInvocations: 12, concurrency: 4, reserved: 0 }, review: { maxDepth: 2, maxInvocations: 12, concurrency: 3, reserved: 1 } });
  assert.equal(DEFAULT_CONFIG.review.maxRounds, 3);
  assert.equal(DEFAULT_CONFIG.freeToPaid.policy, 'B');
  assert.equal(evaluateRecruitment({ ...root(DEFAULT_CONFIG), request: req('luna') }).decision, 'REJECT');
  assert.equal(DEFAULT_CONFIG.desktop.profile, 'A');
  assert.equal(DEFAULT_CONFIG.desktop.enableExecutionBridge, false);
});

test('strict validated configuration rejects unknown fields, future migrations and authority mistakes', () => {
  assert.throws(() => config({ fleet: {} }), /Unknown configuration/);
  assert.throws(() => config({ fleets: { review: { reserved: 3 } } }), /ordinary slot/);
  assert.throws(() => config({ workers: { sol: { model: 'unknown' } } }), /unclassified/);
  assert.throws(() => config({ workers: { 'daily-astrafree': { keyProfile: 'standard' } } }), /retain the free key/);
  assert.throws(() => config({ authority: { unknownProfile: 'opus' } }), /Unverified/);
  assert.throws(() => config({ desktop: { profile: 'C' } }), /explicit/);
  assert.throws(() => migrateConfig({ version: 9000 }), /Unsupported/);
  assert.throws(() => config(JSON.parse('{"__proto__":{"polluted":true}}')), /Unsafe/);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(migrateConfig({ version: 1 }), resolveConfig());
});

test('all profile presets validate without enabling ULTRA or adding initial agents', () => {
  for (const name of ['Lite', 'Balanced', 'Research', 'Critical Engineering', 'Custom']) {
    const c = profileConfig(name);
    validateConfig(c);
    assert.equal(c.enabled, false);
    assert.equal(Object.hasOwn(c, 'initialAgents'), false);
  }
  assert.equal(profileConfig('Critical Engineering').review.gapInspectionImpacts.includes('unknown'), true);
});

test('scoped configuration can attenuate but cannot expand or rewrite owner authority', () => {
  const c = resolveConfig([{ enabled: true, recruitment: { mode: 'SKYNET' }, mission: { maxUsd: 4 } }, { scope: 'mission', value: { recruitment: { mode: 'SWARM' }, mission: { maxUsd: 1 } } }]);
  assert.equal(c.recruitment.mode, 'SWARM');
  assert.equal(c.mission.maxUsd, 1);
  assert.throws(() => resolveConfig([{ enabled: true }, { scope: 'stage', value: { recruitment: { mode: 'SKYNET' } } }]), /exceeds/);
  assert.throws(() => resolveConfig([{ enabled: true }, { scope: 'project', value: { authority: { unknownProfile: 'sonnet' } } }]), /cannot alter authority/);
  assert.throws(() => resolveConfig([{ mission: { maxUsd: 1 } }, { scope: 'mission', value: { mission: { maxUsd: null } } }]), /ceiling/);
  assert.equal(resolveConfig([{ enabled: true }, { scope: 'owner', value: { recruitment: { mode: 'SKYNET' } } }]).recruitment.mode, 'SKYNET');
});

test('policy hashes are key-order stable and distinguish consequential policy changes', () => {
  const c = config();
  const reversed = Object.fromEntries(Object.entries(c).reverse());
  assert.equal(policyHash(c), policyHash(reversed));
  assert.notEqual(policyHash(c), policyHash(config({ recruitment: { mode: 'SKYNET' } })));
});

test('per-key and per-model mission ceilings are explicit validated maps and scoped limits only tighten', () => {
  const limits = { maxTokens: 10000, maxUsd: 1, maxRequests: 3 };
  const c = config({ mission: { perKey: { standard: limits }, perModel: { 'gpt-6.2-astra': limits } } });
  assert.deepEqual(c.mission.perKey.standard, limits);
  assert.throws(() => config({ mission: { perKey: { paid: limits } } }), /must be one of/);
  assert.throws(() => config({ mission: { perModel: { unknown: limits } } }), /must be one of/);
  assert.throws(() => resolveConfig([c, { scope: 'mission', value: { mission: { perKey: { standard: { maxRequests: 4 } } } } }]), /ceiling/);
  assert.equal(resolveConfig([c, { scope: 'mission', value: { mission: { perModel: { 'gpt-6.2-astra': { maxUsd: 0.25 } } } } }]).mission.perModel['gpt-6.2-astra'].maxUsd, 0.25);
});

test('SWARM REPLICATOR SKYNET and all CUSTOM flag combinations govern relative ranks', () => {
  for (const [mode, expected] of Object.entries({ SWARM: [true, false, false], REPLICATOR: [true, true, false], SKYNET: [true, true, true] })) {
    const c = config();
    for (const [index, worker] of ['luna', 'flex6-1', 'astra'].entries()) {
      const result = evaluateRecruitment({ config: c, parent: parent(c, 'sol', mode), mission: {}, request: req(worker) });
      assert.equal(result.decision !== 'REJECT', expected[index], `${mode} -> ${worker}: ${result.reasons}`);
    }
  }
  for (let mask = 0; mask < 8; mask++) {
    const flags = { lower: Boolean(mask & 1), equal: Boolean(mask & 2), higher: Boolean(mask & 4) };
    const c = config({ recruitment: { mode: 'CUSTOM', custom: flags } });
    for (const [index, worker] of ['luna', 'sol', 'astra'].entries()) {
      const result = evaluateRecruitment({ config: c, parent: parent(c, 'sol', 'CUSTOM'), mission: {}, request: req(worker) });
      assert.equal(result.decision !== 'REJECT', Object.values(flags)[index]);
    }
  }
});

test('exact aliases inherit family rank independent of key, tier or reasoning', () => {
  const c = config();
  const p = parent(c, 'astra', 'REPLICATOR');
  const equal = evaluateRecruitment({ config: c, parent: p, request: req('daily-astrafree', { reasoning_effort: 'max' }) });
  assert.equal(equal.relation, 'equal');
  assert.equal(equal.family, 'astra');
  assert.equal(equal.keyProfile, 'free');
  assert.equal(evaluateRecruitment({ config: c, parent: parent(c), request: req('astra', { model: 'gpt-new' }) }).decision, 'REJECT');
  assert.equal(evaluateRecruitment({ ...root(c), request: req('luna', { keyProfile: 'free' }) }).decision, 'REJECT');
  assert.equal(evaluateRecruitment({ ...root(c), request: req('sol', { serviceTier: 'priority' }) }).decision, 'REJECT');
});

test('owner can explicitly classify future exact models and family rank exceptions', () => {
  const c = config({ models: { 'future-luna': { family: 'luna', rank: null } }, workers: { luna: { model: 'future-luna' } } });
  const result = evaluateRecruitment({ ...root(c), request: req('luna') });
  assert.equal(result.model, 'future-luna');
  assert.equal(result.rank, 2);
  const changed = config({ families: { luna: 5 } });
  assert.equal(evaluateRecruitment({ config: changed, parent: parent(changed), request: req('luna') }).decision, 'REJECT');
});

test('descendants cannot relabel SWARM as SKYNET or launder authority through a lower worker', () => {
  const c = config();
  const a = parent(c, 'sol');
  const first = evaluateRecruitment({ config: c, parent: a, request: req('luna') });
  assert.equal(first.decision, 'APPROVE');
  const b = { ...parent(c, 'luna'), permissions: first.effectivePermissions, depth: { core: 0, review: 0 } };
  assert.equal(evaluateRecruitment({ config: c, parent: b, request: req('astra', { mode: 'SKYNET' }) }).decision, 'REJECT');
  assert.equal(evaluateRecruitment({ config: c, parent: b, request: req('daily-terrafree', { permissions: { recruit: { higher: true } } }) }).decision, 'REJECT');
  assert.equal(evaluateRecruitment({ config: c, parent: { ...b, role: 'orchestrator' }, mission: { rootAgentId: 'root' }, request: req('astra') }).decision, 'REJECT');
});

test('Luna SWARM has a distinct higher reviewer exception without implementation recruitment', () => {
  const c = config({ permissions: { tools: ['Read', 'Edit'], roots: ['/project'] } });
  const mission = root(c).mission;
  const p = parent(c, 'luna');
  const result = evaluateRecruitment({ config: c, mission, parent: p, request: req('astra', { role: 'reviewer' }) });
  assert.equal(result.decision, 'APPROVE');
  assert.equal(result.pool, 'review');
  assert.equal(result.reviewException, true);
  assert.deepEqual(result.effectivePermissions.tools, ['Read']);
  assert.deepEqual(result.effectivePermissions.recruit, { lower: false, equal: false, higher: false });
  assert.equal(evaluateRecruitment({ config: c, parent: p, request: req('astra') }).decision, 'REJECT');
  assert.equal(evaluateRecruitment({ config: c, parent: p, request: req('astra', { role: 'reviewer', permissions: { tools: ['Edit'] } }) }).decision, 'REJECT');
  const reviewer = { ...parent(c, 'astra', 'SKYNET'), role: 'reviewer', permissions: result.effectivePermissions };
  assert.equal(evaluateRecruitment({ config: c, parent: reviewer, request: req('sol', { role: 'reworker' }) }).decision, 'REJECT');
});

test('Opus and Fable are separately configurable; Sonnet consults Sol and Haiku defers', () => {
  const c = config();
  for (const name of ['opus', 'fable']) assert.equal(evaluateRecruitment({ ...root(c, name), request: req('astra') }).decision, 'APPROVE');
  const sonnet = evaluateRecruitment({ ...root(c, 'sonnet'), request: req('astra') });
  assert.equal(sonnet.decision, 'PENDING');
  assert.equal(sonnet.requiredApprovals[0].authority, 'helicop-sol');
  assert.equal(sonnet.requiredApprovals[0].finalAuthority, true);
  const haiku = evaluateRecruitment({ ...root(c, 'haiku'), request: req('sol') });
  assert.equal(haiku.requiredApprovals[0].decisionMaker, true);
  const changed = config({ authority: { profiles: { fable: { authority: 'limited', restrictedFamilies: ['sol', 'astra'], supervisor: 'user' } } } });
  assert.equal(evaluateRecruitment({ ...root(changed, 'fable'), request: req('astra') }).requiredApprovals[0].authority, 'user');
  assert.equal(evaluateRecruitment({ ...root(changed, 'opus'), request: req('astra') }).decision, 'APPROVE');
});

test('unverified claimed Opus never receives full authority; explicit identity configuration expires', () => {
  const c = config();
  const result = evaluateRecruitment({ ...root(c, 'opus', false), request: req('astra') });
  assert.equal(result.orchestrator.model, 'unknown');
  assert.equal(result.requiredApprovals[0].authority, 'user');
  const authorised = config({ authority: { configuredIdentity: { model: 'opus', authorisedBy: 'owner-confirmed-local-config', expiresAt: '2030-01-01T00:00:00Z' } } });
  assert.equal(orchestratorIdentity(authorised, {}, Date.parse('2029-01-01')).model, 'opus');
  assert.equal(orchestratorIdentity(authorised, {}, Date.parse('2031-01-01')).model, 'unknown');
});

test('HELICOP defaults independently gate Sol peers and Sol to Astra and match compound rule conditions', () => {
  const c = config();
  const mission = root(c).mission;
  const peer = evaluateRecruitment({ config: c, mission, parent: parent(c, 'sol', 'REPLICATOR'), request: req('sol') });
  assert.equal(peer.requiredApprovals[0].authority, 'helicop-sol');
  const up = evaluateRecruitment({ config: c, mission, parent: parent(c, 'sol', 'SKYNET'), request: req('astra') });
  assert.equal(up.requiredApprovals[0].authority, 'helicop-astra');
  const rules = [...c.helicop.rules, { id: 'cost-and-confidence', enabled: true, authority: 'helicop-sol', mandatory: true, veto: true, priority: 75,
    when: { modes: ['SKYNET'], parentModels: ['gpt-6.2-sol'], childModels: ['gpt-6.2-astra'], purposes: ['implementation'], minimumUsd: 0.02, maximumTokens: 3000, minimumDepth: 2, confidenceBelow: 0.99 } }];
  const custom = config({ helicop: { rules } });
  const both = evaluateRecruitment({ config: custom, mission, parent: parent(custom, 'sol', 'SKYNET'), request: req('astra') });
  assert.deepEqual(new Set(both.requiredApprovals.map(a => a.authority)), new Set(['helicop-sol', 'helicop-astra']));
  assert.equal(evaluateRecruitment({ ...root(config({ helicop: { sol: false } }), 'sonnet'), request: req('astra') }).decision, 'REJECT');
});

test('all approval combinations preserve mandatory high-authority vetoes and reject bypass', () => {
  const mandatory = [{ id: 'senior', authority: 'helicop-astra', mandatory: true, veto: true, priority: 100 }, { id: 'junior', authority: 'helicop-sol', mandatory: false, veto: false, priority: 50 }];
  for (const mode of ['AND', 'OR', 'veto', 'prioritised', 'escalation']) {
    assert.equal(combineApprovals(mandatory, [{ authority: 'helicop-sol', decision: 'APPROVE' }, { authority: 'helicop-astra', decision: 'REJECT' }], mode).decision, 'REJECT');
    assert.equal(combineApprovals(mandatory, [{ authority: 'helicop-sol', decision: 'APPROVE' }], mode).decision, 'PENDING');
  }
  const optional = mandatory.map(x => ({ ...x, mandatory: false, veto: false }));
  assert.equal(combineApprovals(optional, [{ authority: 'helicop-sol', decision: 'APPROVE' }], 'OR').decision, 'APPROVE');
  assert.equal(combineApprovals(optional, [{ authority: 'helicop-sol', decision: 'APPROVE' }], 'prioritised').decision, 'PENDING');
  assert.equal(combineApprovals(optional, [{ authority: 'helicop-astra', decision: 'APPROVE' }], 'prioritised').decision, 'APPROVE');
  assert.equal(combineApprovals(optional, [{ authority: 'helicop-sol', decision: 'REJECT' }], 'escalation').decision, 'ESCALATE');
  assert.equal(combineApprovals(mandatory, [{ authority: 'helicop-astra', decision: 'MODIFY', modification: { worker: 'luna' } }]).decision, 'MODIFY');
});

test('cheap destructive author remains Luna but receives expensive verification and execution controls', () => {
  const c = config();
  const result = evaluateRecruitment({ ...root(c), request: req('luna', { risk: { ...lowRisk, destructive: true } }) });
  assert.equal(result.decision, 'APPROVE');
  assert.equal(result.family, 'luna');
  assert.equal(result.risk.authorComplexity, 'low');
  assert.equal(result.risk.effectiveImpact, 'high');
  assert.equal(result.risk.controls.secondOpinion, true);
  assert.equal(result.risk.controls.executionApproval, true);
  assert.equal(result.risk.controls.dryRun, true);
  const uncertain = evaluateRecruitment({ ...root(c), request: req('luna', { risk: { ...lowRisk, confidence: 0.2 } }) });
  assert.equal(uncertain.decision, 'PENDING');
  assert.equal(uncertain.requiredApprovals[0].id, 'risk-uncertainty');
});

test('risk input validation and explicit override grants retain original and revised assessments', () => {
  assert.throws(() => assessRisk({ confidence: 1.5 }), /confidence/);
  assert.throws(() => assessRisk({ impact: 'none' }), /Invalid/);
  assert.throws(() => assessRisk({ secretlySafe: true }), /Unknown/);
  assert.throws(() => overrideRisk(lowRisk, lowRisk, { authorised: true }), /authority grant/);
  const result = overrideRisk({ ...lowRisk, impact: 'high' }, lowRisk, { id: 'grant1', authorised: true, reason: 'Isolated synthetic project', expiresAt: '2030-01-01' }, Date.parse('2029-01-01'));
  assert.equal(result.audit.original.impact, 'high');
  assert.equal(result.assessment.impact, 'low');
});

test('free-to-paid A/B/C use explicit budgets and policy C always requires human approval', () => {
  for (const policy of ['A', 'B', 'C']) {
    const c = config({ recruitment: { mode: 'SKYNET' }, freeToPaid: { policy }, mission: { maxUsd: 1 } });
    const p = parent(c, 'daily-astrafree', 'SKYNET');
    const result = evaluateRecruitment({ config: c, parent: p, request: req('luna') });
    assert.equal(result.requiredApprovals.some(a => a.id === 'free-to-paid'), policy === 'C');
    if (policy === 'C') assert.equal(result.requiredApprovals.find(a => a.id === 'free-to-paid').authority, 'user');
  }
  const c = config({ recruitment: { mode: 'SKYNET' } });
  assert.equal(evaluateRecruitment({ config: c, parent: parent(c, 'daily-astrafree', 'SKYNET'), request: req('luna', { budget: {} }) }).decision, 'PENDING');
  const a = config({ freeToPaid: { policy: 'A' } });
  assert.equal(evaluateRecruitment({ config: a, parent: parent(a, 'daily-astrafree', 'SWARM'), request: req('luna') }).decision, 'REJECT');
});

test('Core and Review depth are independent but inherited lineage cannot reset a pool', () => {
  const c = config();
  const mission = root(c).mission;
  const p = { ...parent(c, 'luna'), depth: { core: 2, review: 0 } };
  assert.equal(evaluateRecruitment({ config: c, parent: p, request: req('daily-terrafree') }).decision, 'REJECT');
  assert.equal(evaluateRecruitment({ config: c, mission, parent: p, request: req('astra', { role: 'reviewer' }) }).decision, 'APPROVE');
  assert.equal(evaluateRecruitment({ config: c, parent: { ...p, depth: { core: 2, review: 2 } }, request: req('astra', { role: 'reviewer' }) }).decision, 'REJECT');
});

test('tool and canonical lexical root ceilings attenuate POSIX and Windows project scope', () => {
  const c = config({ permissions: { tools: ['Read', 'Edit'], roots: ['/projects/safe', 'C:\\Projects\\safe'] } });
  const okay = evaluateRecruitment({ ...root(c), request: req('luna', { permissions: { tools: ['Read'], roots: ['/projects/safe/src'] } }) });
  assert.equal(okay.decision, 'APPROVE');
  assert.equal(evaluateRecruitment({ ...root(c), request: req('luna', { permissions: { tools: ['Bash'] } }) }).decision, 'REJECT');
  for (const target of ['/projects/safe-other', '/projects/safe/../secret', 'C:\\Projects\\safe\\..\\secret']) {
    assert.equal(evaluateRecruitment({ ...root(c), request: req('luna', { permissions: { roots: [target] } }) }).decision, 'REJECT');
  }
  const win = evaluateRecruitment({ ...root(c), request: req('luna', { permissions: { roots: ['c:\\projects\\safe\\src'] } }) });
  assert.equal(win.decision, 'APPROVE');
  const permissions = structuredClone(c.permissions);
  assert.deepEqual(intersectPermissions(permissions, { ...permissions, roots: ['/projects/safe/src'] }).roots, ['/projects/safe/src']);
});

test('approval judges cannot recursively allocate reviewers, and rework is Core', () => {
  const c = config();
  assert.equal(evaluateRecruitment({ config: c, parent: { ...parent(c, 'astra', 'SKYNET'), role: 'supervisor' }, request: req('sol', { role: 'supervisor' }) }).decision, 'REJECT');
  assert.equal(evaluateRecruitment({ ...root(c), request: req('sol', { role: 'reworker' }) }).pool, 'core');
  assert.equal(evaluateRecruitment({ ...root(c), request: req('luna', { role: 'gap_inspector' }) }).pool, 'review');
});
