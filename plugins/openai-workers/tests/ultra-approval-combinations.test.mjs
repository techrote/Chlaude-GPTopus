import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutionStore } from '../ultra/store.mjs';
import { RecruitmentBroker } from '../ultra/broker.mjs';
import { ActionGate } from '../ultra/actions.mjs';
import { combineApprovals } from '../ultra/policy.mjs';
import { DEFAULT_CONFIG, resolveConfig, validateConfig } from '../ultra/config.mjs';

const START = Date.parse('2026-11-21T12:00:00Z');
const COMBINATIONS = ['AND', 'OR', 'veto', 'prioritised', 'escalation'];
const permutations = items => items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));
const RISK = { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 1, rationale: 'Deterministic fixture with no live API or external effects.',
  blastRadius: 'local', reversibility: 'reversible', testsAvailable: true, independentEvidence: true };

/* ------------------------------------------------------------------ pure truth table */

const req = (authority, { m = false, v = false, p = 0, c = false } = {}) => ({ id: `r:${authority}`, authority, mandatory: m, veto: v, priority: p, consultation: c });
const dec = (authority, decision, extra = {}) => ({ authority, decision, ...extra });
const verdict = (requirements, decisions, combination) => combineApprovals(requirements, decisions, combination).decision;

test('truth table: OR keeps the action pending until approval is mathematically impossible', () => {
  const optional = [req('helicop-sol', { p: 50 }), req('helicop-astra', { p: 100 })];
  assert.equal(verdict(optional, [], 'OR'), 'PENDING');
  assert.equal(verdict(optional, [dec('helicop-sol', 'REJECT')], 'OR'), 'PENDING');
  assert.equal(verdict(optional, [dec('helicop-astra', 'REJECT')], 'OR'), 'PENDING');
  assert.equal(verdict(optional, [dec('helicop-sol', 'APPROVE')], 'OR'), 'APPROVE');
  assert.equal(verdict(optional, [dec('helicop-sol', 'REJECT'), dec('helicop-astra', 'APPROVE')], 'OR'), 'APPROVE');
  assert.equal(verdict(optional, [dec('helicop-astra', 'APPROVE'), dec('helicop-sol', 'REJECT')], 'OR'), 'APPROVE');
  assert.equal(verdict(optional, [dec('helicop-sol', 'REJECT'), dec('helicop-astra', 'REJECT')], 'OR'), 'REJECT');
});

test('truth table: independently required authorities combine with an OR of the optional ones', () => {
  const rules = [req('user', { m: true, p: 1000 }), req('helicop-sol', { p: 50 }), req('helicop-astra', { p: 100 })];
  assert.equal(verdict(rules, [dec('helicop-sol', 'APPROVE')], 'OR'), 'PENDING', 'user is independently mandatory');
  assert.equal(verdict(rules, [dec('user', 'APPROVE')], 'OR'), 'PENDING');
  assert.equal(verdict(rules, [dec('user', 'APPROVE'), dec('helicop-sol', 'APPROVE')], 'OR'), 'APPROVE');
  assert.equal(verdict(rules, [dec('user', 'APPROVE'), dec('helicop-sol', 'REJECT')], 'OR'), 'PENDING');
  assert.equal(verdict(rules, [dec('user', 'APPROVE'), dec('helicop-sol', 'REJECT'), dec('helicop-astra', 'REJECT')], 'OR'), 'REJECT');
  assert.equal(verdict(rules, [dec('user', 'REJECT')], 'OR'), 'REJECT', 'a mandatory rejection is terminal before anyone else answers');
  assert.equal(verdict(rules, [dec('helicop-astra', 'APPROVE'), dec('user', 'REJECT')], 'OR'), 'REJECT');
});

test('truth table: a veto holder is awaited before approval and its rejection is terminal in every combination', () => {
  for (const combination of COMBINATIONS) {
    const rules = [req('helicop-astra', { v: true, p: 100 }), req('helicop-sol', { p: 50 })];
    assert.equal(verdict(rules, [dec('helicop-sol', 'APPROVE')], combination), 'PENDING', `${combination}: approval waits for the veto holder`);
    assert.equal(verdict(rules, [dec('helicop-astra', 'REJECT')], combination), 'REJECT', `${combination}: veto is terminal`);
    assert.equal(verdict(rules, [dec('helicop-sol', 'APPROVE'), dec('helicop-astra', 'REJECT')], combination), 'REJECT');
    assert.equal(verdict(rules, [dec('helicop-astra', 'APPROVE'), dec('helicop-sol', 'APPROVE')], combination), 'APPROVE');
  }
});

test('truth table: AND and veto reject on any rejection; both need every authority', () => {
  for (const combination of ['AND', 'veto']) {
    const rules = [req('user', { m: combination === 'AND', v: combination === 'veto' }), req('helicop-sol', { m: combination === 'AND', v: combination === 'veto' })];
    assert.equal(verdict(rules, [dec('user', 'APPROVE')], combination), 'PENDING');
    assert.equal(verdict(rules, [dec('helicop-sol', 'REJECT')], combination), 'REJECT');
    assert.equal(verdict(rules, [dec('user', 'APPROVE'), dec('helicop-sol', 'APPROVE')], combination), 'APPROVE');
  }
  // Optional authorities under AND/veto reject terminally as well (their rejection can never be outvoted).
  const optional = [req('user'), req('helicop-sol')];
  for (const combination of ['AND', 'veto']) {
    assert.equal(verdict(optional, [dec('user', 'REJECT')], combination), 'REJECT');
    assert.equal(verdict(optional, [dec('user', 'APPROVE')], combination), 'PENDING');
  }
});

test('truth table: prioritised uses the highest-priority optional tier and ignores lower tiers entirely', () => {
  const rules = [req('user', { p: 3 }), req('helicop-astra', { p: 2 }), req('helicop-sol', { p: 1 })];
  assert.equal(verdict(rules, [dec('helicop-sol', 'REJECT')], 'prioritised'), 'PENDING', 'lower-priority rejection does not decide');
  assert.equal(verdict(rules, [dec('helicop-sol', 'APPROVE')], 'prioritised'), 'PENDING', 'lower-priority approval does not decide');
  assert.equal(verdict(rules, [dec('helicop-sol', 'REJECT'), dec('user', 'APPROVE')], 'prioritised'), 'APPROVE');
  assert.equal(verdict(rules, [dec('user', 'APPROVE'), dec('helicop-sol', 'REJECT')], 'prioritised'), 'APPROVE');
  assert.equal(verdict(rules, [dec('helicop-sol', 'APPROVE'), dec('helicop-astra', 'APPROVE'), dec('user', 'REJECT')], 'prioritised'), 'REJECT');
  const tied = [req('helicop-sol', { p: 50 }), req('helicop-astra', { p: 50 }), req('user', { p: 1 })];
  assert.equal(verdict(tied, [dec('helicop-sol', 'APPROVE')], 'prioritised'), 'PENDING', 'a tie needs every member of the tier');
  assert.equal(verdict(tied, [dec('helicop-sol', 'APPROVE'), dec('helicop-astra', 'APPROVE')], 'prioritised'), 'APPROVE');
  assert.equal(verdict(tied, [dec('helicop-astra', 'REJECT')], 'prioritised'), 'REJECT');
  assert.equal(verdict(tied, [dec('user', 'REJECT'), dec('helicop-sol', 'APPROVE'), dec('helicop-astra', 'APPROVE')], 'prioritised'), 'APPROVE');
});

test('truth table: escalation escalates optional disagreement but a mandatory rejection still prevails', () => {
  const optional = [req('helicop-sol', { p: 50 }), req('helicop-astra', { p: 100 })];
  assert.equal(verdict(optional, [dec('helicop-sol', 'REJECT')], 'escalation'), 'ESCALATE');
  assert.equal(verdict(optional, [dec('helicop-sol', 'APPROVE')], 'escalation'), 'PENDING');
  assert.equal(verdict(optional, [dec('helicop-sol', 'APPROVE'), dec('helicop-astra', 'APPROVE')], 'escalation'), 'APPROVE');
  const gated = [req('user', { m: true, p: 1000 }), ...optional];
  assert.equal(verdict(gated, [dec('helicop-sol', 'REJECT')], 'escalation'), 'PENDING', 'escalation waits for the mandatory gate, which may still reject');
  assert.equal(verdict(gated, [dec('helicop-sol', 'REJECT'), dec('user', 'APPROVE')], 'escalation'), 'ESCALATE');
  assert.equal(verdict(gated, [dec('user', 'APPROVE'), dec('helicop-sol', 'REJECT')], 'escalation'), 'ESCALATE');
  assert.equal(verdict(gated, [dec('helicop-sol', 'REJECT'), dec('user', 'REJECT')], 'escalation'), 'REJECT');
  assert.equal(verdict(gated, [dec('user', 'REJECT'), dec('helicop-sol', 'REJECT')], 'escalation'), 'REJECT');
});

test('truth table: consultation never blocks, never rejects and never satisfies an optional quorum', () => {
  const consulted = [req('helicop-sol', { m: true, c: true }), req('user', { m: true, p: 1000 })];
  assert.equal(verdict(consulted, [dec('user', 'APPROVE')], 'AND'), 'PENDING', 'a mandatory consultation must still answer');
  assert.equal(verdict(consulted, [dec('user', 'APPROVE'), dec('helicop-sol', 'REJECT')], 'AND'), 'APPROVE', 'advisory rejection is not a veto');
  assert.equal(verdict(consulted, [dec('helicop-sol', 'REJECT'), dec('user', 'APPROVE')], 'AND'), 'APPROVE');
  assert.equal(verdict(consulted, [dec('helicop-sol', 'MODIFY'), dec('user', 'APPROVE')], 'AND'), 'APPROVE');
  const quorum = [req('helicop-sol', { c: true }), req('helicop-astra'), req('user', { m: true })];
  assert.equal(verdict(quorum, [dec('user', 'APPROVE'), dec('helicop-sol', 'APPROVE')], 'OR'), 'PENDING', 'an advisory answer is not an OR approval');
  assert.equal(verdict(quorum, [dec('user', 'APPROVE'), dec('helicop-astra', 'APPROVE')], 'OR'), 'APPROVE');
});

test('truth table: malformed, conflicting and duplicate decisions fail closed without depending on order', () => {
  const rules = [req('helicop-sol'), req('helicop-astra')];
  assert.equal(verdict(rules, [dec('helicop-sol', 'MAYBE')], 'OR'), 'REJECT');
  assert.equal(verdict(rules, [dec('helicop-sol', 'APPROVE'), dec('helicop-sol', 'REJECT')], 'OR'), 'REJECT');
  assert.equal(verdict(rules, [dec('helicop-sol', 'REJECT'), dec('helicop-sol', 'APPROVE')], 'OR'), 'REJECT');
  assert.equal(verdict(rules, [dec('helicop-sol', 'APPROVE'), dec('helicop-sol', 'APPROVE')], 'OR'), 'APPROVE');
  assert.equal(verdict(rules, [dec('stranger', 'APPROVE')], 'OR'), 'PENDING', 'decisions from unlisted authorities are ignored');
  assert.equal(verdict([], [], 'OR'), 'APPROVE');
  for (const bad of ['and', 'XOR', '', undefined === null ? '' : 'prioritized']) assert.throws(() => combineApprovals(rules, [], bad), /Unknown approval combination/);
});

test('truth table: MODIFY and ESCALATE precedence is deterministic and carries the senior modification', () => {
  const rules = [req('helicop-sol', { m: true, p: 50 }), req('helicop-astra', { m: true, p: 100 })];
  const sol = dec('helicop-sol', 'MODIFY', { modification: { worker: 'luna6' } }), astra = dec('helicop-astra', 'MODIFY', { modification: { worker: 'terra' } });
  for (const order of permutations([sol, astra])) {
    const result = combineApprovals(rules, order, 'AND');
    assert.equal(result.decision, 'MODIFY'); assert.deepEqual(result.modification, { worker: 'terra' }, 'the senior authority modification prevails');
  }
  assert.equal(verdict(rules, [sol], 'AND'), 'PENDING', 'a junior modification may still be superseded by the senior authority');
  assert.equal(verdict(rules, [astra], 'AND'), 'PENDING', 'the junior mandatory gate may still reject');
  assert.equal(verdict(rules, [astra, dec('helicop-sol', 'APPROVE')], 'AND'), 'MODIFY');
  const optionalJunior = [req('helicop-sol', { p: 50 }), req('helicop-astra', { m: true, p: 100 })];
  assert.equal(verdict(optionalJunior, [astra], 'AND'), 'MODIFY', 'a mandatory modification settles even before an optional junior answers');
  assert.equal(verdict(rules, [sol, dec('helicop-astra', 'REJECT')], 'AND'), 'REJECT', 'a mandatory rejection outranks modification');
  assert.equal(verdict(rules, [dec('helicop-sol', 'ESCALATE'), astra], 'AND'), 'MODIFY');
  assert.equal(verdict(rules, [dec('helicop-sol', 'ESCALATE'), dec('helicop-astra', 'ESCALATE')], 'AND'), 'ESCALATE');
});

/* ------------------------------------------------------------------ exhaustive properties */

const NAMES = ['user', 'trusted-orchestrator', 'helicop-sol', 'helicop-astra'];
const TEMPLATES = {
  'all optional (distinct priority)': [req(NAMES[0], { p: 4 }), req(NAMES[1], { p: 3 }), req(NAMES[2], { p: 2 }), req(NAMES[3], { p: 1 })],
  'first mandatory': [req(NAMES[0], { m: true, p: 4 }), req(NAMES[1], { p: 3 }), req(NAMES[2], { p: 2 }), req(NAMES[3], { p: 1 })],
  'veto + mandatory + optional': [req(NAMES[0], { v: true, p: 4 }), req(NAMES[1], { m: true, p: 3 }), req(NAMES[2], { p: 2 }), req(NAMES[3], { p: 1 })],
  'all mandatory': [req(NAMES[0], { m: true }), req(NAMES[1], { m: true }), req(NAMES[2], { m: true })],
  'tied priorities': [req(NAMES[0], { p: 50 }), req(NAMES[1], { p: 50 }), req(NAMES[2], { p: 1 })],
  'mandatory consultation': [req(NAMES[0], { m: true, c: true }), req(NAMES[1], { p: 2 }), req(NAMES[2], { p: 1 })],
  'advisory consultation': [req(NAMES[0], { c: true }), req(NAMES[1], { p: 2 }), req(NAMES[2], { p: 1 })],
  'one authority under two requirements': [req(NAMES[0], { m: true, p: 9 }), req(NAMES[0], { p: 1 }), req(NAMES[1], { p: 5 })],
};
const VALUES = [undefined, 'APPROVE', 'REJECT', 'MODIFY', 'ESCALATE'];
function vectors(names) { return names.reduce((all, name) => all.flatMap(prefix => VALUES.map(value => [...prefix, value])), [[]]); }
const decisionsFor = (names, vector) => names.flatMap((authority, i) => vector[i] === undefined ? [] : [dec(authority, vector[i], vector[i] === 'MODIFY' ? { modification: { by: authority } } : {})]);
const signature = result => JSON.stringify([result.decision, result.modification ?? null]);

for (const [label, requirements] of Object.entries(TEMPLATES)) for (const combination of COMBINATIONS) {
  test(`exhaustive: ${combination} over "${label}" is monotone, order independent and never approves around a blocking gate`, () => {
    const names = [...new Set(requirements.map(r => r.authority))];
    const table = new Map();
    for (const vector of vectors(names)) table.set(vector.join('|'), combineApprovals(requirements, decisionsFor(names, vector), combination));
    const blocking = requirements.filter(r => r.mandatory || (r.veto && !r.consultation));
    for (const vector of vectors(names)) {
      const result = table.get(vector.join('|'));
      // A complete answer set always resolves.
      if (vector.every(v => v !== undefined)) assert.notEqual(result.decision, 'PENDING', `${combination} ${vector}`);
      // Monotone: one more answer never changes a settled verdict.
      if (result.decision !== 'PENDING') vector.forEach((v, i) => {
        if (v !== undefined) return;
        for (const value of VALUES.slice(1)) {
          const extended = [...vector]; extended[i] = value;
          assert.equal(signature(table.get(extended.join('|'))), signature(result), `${combination} ${vector} -> ${extended}`);
        }
      });
      // Approval requires every blocking gate (consultations answer, any answer counts) and any REJECT from one is terminal.
      for (const gate of blocking) {
        const answer = vector[names.indexOf(gate.authority)];
        if (result.decision === 'APPROVE') assert.ok(answer === 'APPROVE' || gate.consultation && answer !== undefined, `${combination} ${vector} approved around ${gate.authority}`);
        if (answer === 'REJECT' && !gate.consultation) assert.equal(result.decision, 'REJECT', `${combination} ${vector}`);
      }
      // Arrival order: applying the cast votes one by one in any order settles on the same verdict.
      const cast = names.map((_, i) => i).filter(i => vector[i] !== undefined);
      for (const order of permutations(cast)) {
        const partial = Array(names.length).fill(undefined); let settled = null;
        for (const i of order) { partial[i] = vector[i]; const step = table.get(partial.join('|')); if (step.decision !== 'PENDING') { settled = step; break; } }
        assert.equal(signature(settled ?? { decision: 'PENDING' }), signature(result), `${combination} ${vector} order ${order}`);
      }
    }
  });
}

/* ------------------------------------------------------------------ configuration */

test('execution configuration: mandatory and veto lists are strict and backwards compatible', () => {
  assert.deepEqual([DEFAULT_CONFIG.execution.mandatoryAuthorities, DEFAULT_CONFIG.execution.vetoAuthorities], [[], []]);
  const configured = resolveConfig({ enabled: true, execution: { consequentialAuthorities: ['user', 'helicop-sol', 'helicop-astra'], combination: 'OR', mandatoryAuthorities: ['user'], vetoAuthorities: ['helicop-astra'] } });
  assert.deepEqual(configured.execution.mandatoryAuthorities, ['user']);
  const bad = patch => () => resolveConfig({ enabled: true, execution: { consequentialAuthorities: ['user', 'helicop-sol'], combination: 'OR', ...patch } });
  assert.throws(bad({ mandatoryAuthorities: ['helicop-astra'] }), /must be listed in execution\.consequentialAuthorities/);
  assert.throws(bad({ vetoAuthorities: ['nobody'] }), /vetoAuthorities must be one of/);
  assert.throws(bad({ mandatoryAuthorities: ['user', 'user'] }), /unique/);
  assert.throws(bad({ mandatoryAuthorities: 'user' }), /bounded array/);
  assert.throws(bad({ mandatoryAuthorities: ['user'], vetoAuthorities: ['user'] }), /both mandatory and veto/);
  assert.throws(bad({ combination: 'or' }), /execution\.combination must be one of/);
  assert.throws(bad({ combination: 'XOR' }), /execution\.combination must be one of/);
  assert.throws(bad({ unknownList: [] }), /Unknown configuration field/);
  // A configuration persisted before these lists existed remains valid and means "no extra gates".
  const legacy = structuredClone(DEFAULT_CONFIG); delete legacy.execution.mandatoryAuthorities; delete legacy.execution.vetoAuthorities;
  assert.doesNotThrow(() => validateConfig(legacy));
});

/* ------------------------------------------------------------------ production ActionGate boundary */

let sequence = 0;
async function scratch(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ultra-approval-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } }));
  return results;
}

/** An isolated ledger/mission driven only through the production ActionGate and broker. */
async function gateSession(directory, execution) {
  let now = START;
  const store = new ExecutionStore(path.join(directory, `gate-${++sequence}.json`), { now: () => now });
  const broker = new RecruitmentBroker(store, { config: { enabled: true, execution }, now: () => now });
  await broker.createMission({ id: 'm', task: 'Approval combination fixture', orchestrator: { model: 'opus', trusted: true, source: 'offline-fixture' } });
  const gate = new ActionGate(broker);
  let counter = 0;
  const session = {
    store, gate, advance: ms => { now += ms; }, now: () => now,
    propose: () => gate.propose('m', 'root', { kind: 'command', description: `Synthetic consequential action ${++counter}` }),
    // Judges come from the production appointJudge path; only their completion is set by the fixture.
    async principalsFor(action, authorities = action.authorities) {
      const result = { user: { source: 'local-user', trusted: true, authority: 'user' }, 'trusted-orchestrator': { source: 'native-host', trusted: true, authority: 'trusted-orchestrator' } };
      for (const authority of authorities.filter(a => a.startsWith('helicop-'))) {
        const node = await gate.appointJudge('m', action.id, authority);
        await store.transaction(state => { state.missions.m.nodes[node.id].status = 'completed'; });
        result[authority] = { source: 'judge', trusted: true, authority, nodeId: node.id };
      }
      return result;
    },
    vote: (action, authority, approved, principal) => gate.decide('m', action.id, { actionHash: action.hash, approved, rationale: `${authority} fixture rationale` }, principal),
    record: async action => (await store.snapshot('m')).actions[action.id],
    status: async action => (await session.record(action)).status,
    consume: action => gate.consume('m', action.id, action.action, { nodeId: 'root', capability: 'run_command' }),
  };
  return session;
}

/** Cast votes in order; a vote after a terminal state must be refused and leave no trace. */
async function cast(session, action, principals, order, ballot) {
  for (const authority of order) {
    const before = await session.record(action);
    if (before.status === 'pending') await session.vote(action, authority, ballot[authority], principals[authority]);
    else {
      await assert.rejects(session.vote(action, authority, ballot[authority], principals[authority]), /not pending or has expired/);
      assert.equal((await session.record(action)).votes.length, before.votes.length, 'a refused late vote leaves no trace');
    }
  }
  return session.status(action);
}
async function runGate(directory, execution, order, ballot) {
  const session = await gateSession(directory, execution), action = await session.propose();
  return cast(session, action, await session.principalsFor(action, order), order, ballot);
}
/** Final statuses for every arrival order of the cast votes. */
const finalsFor = (directory, execution, ballot) => mapLimit(permutations(Object.keys(ballot)), 8, order => runGate(directory, execution, order, ballot));

/** Independent hand-written oracle for complete boolean ballots. */
function expectedStatus(authorities, combination, { mandatory = [], veto = [] }, ballot) {
  const blocking = authorities.filter(a => combination === 'AND' || combination === 'veto' || mandatory.includes(a) || veto.includes(a));
  const optional = authorities.filter(a => !blocking.includes(a));
  if (blocking.some(a => ballot[a] === false)) return 'rejected';
  const satisfied = combination === 'OR' ? !optional.length || optional.some(a => ballot[a])
    : combination === 'prioritised' ? !optional.length || ballot[optional[0]] === true : optional.every(a => ballot[a]);
  if (satisfied) return 'approved';
  return combination === 'escalation' && optional.some(a => ballot[a] === false) ? 'escalated' : 'rejected';
}
const fullBallots = authorities => authorities.reduce((all, authority) => all.flatMap(prefix => [true, false].map(value => ({ ...prefix, [authority]: value }))), [{}]);
const agree = (finals, expected, label) => assert.deepEqual([...new Set(finals)], [expected], `${label}: ${finals}`);

test('ActionGate OR: a Sol rejection cannot pre-empt a sufficient Astra approval, in either arrival order (reviewer regression)', async t => {
  const directory = await scratch(t), execution = { consequentialAuthorities: ['helicop-sol', 'helicop-astra'], combination: 'OR' };
  const ballot = { 'helicop-sol': false, 'helicop-astra': true };
  assert.deepEqual(await finalsFor(directory, execution, ballot), ['approved', 'approved']);
});

test('ActionGate OR with both judges: every ballot and arrival order settles on the same status', async t => {
  const directory = await scratch(t), authorities = ['helicop-sol', 'helicop-astra'], execution = { consequentialAuthorities: authorities, combination: 'OR' };
  for (const ballot of fullBallots(authorities)) agree(await finalsFor(directory, execution, ballot), expectedStatus(authorities, 'OR', {}, ballot), JSON.stringify(ballot));
});

test('ActionGate OR keeps a partially answered action pending until it can no longer be approved, then refuses late votes', async t => {
  const directory = await scratch(t), authorities = ['helicop-sol', 'helicop-astra'];
  const session = await gateSession(directory, { consequentialAuthorities: authorities, combination: 'OR' });
  const action = await session.propose(), principals = await session.principalsFor(action);
  await session.vote(action, 'helicop-sol', false, principals['helicop-sol']);
  assert.equal(await session.status(action), 'pending', 'one optional rejection is not terminal');
  await session.vote(action, 'helicop-astra', false, principals['helicop-astra']);
  assert.equal(await session.status(action), 'rejected');
  assert.equal(await cast(session, action, principals, authorities, { 'helicop-sol': true, 'helicop-astra': true }), 'rejected');
  await assert.rejects(session.consume(action), /approval missing/);
});

const SETS = [
  { name: 'user mandatory + Sol/Astra OR', combination: 'OR', authorities: ['user', 'helicop-sol', 'helicop-astra'], mandatory: ['user'] },
  { name: 'Astra veto + user/Sol OR', combination: 'OR', authorities: ['helicop-astra', 'user', 'helicop-sol'], veto: ['helicop-astra'] },
  { name: 'AND', combination: 'AND', authorities: ['user', 'trusted-orchestrator', 'helicop-sol'] },
  { name: 'veto', combination: 'veto', authorities: ['user', 'trusted-orchestrator', 'helicop-astra'] },
  { name: 'prioritised (Astra senior)', combination: 'prioritised', authorities: ['helicop-astra', 'helicop-sol', 'user'] },
  { name: 'prioritised with mandatory user', combination: 'prioritised', authorities: ['helicop-astra', 'helicop-sol', 'user'], mandatory: ['user'] },
  { name: 'escalation', combination: 'escalation', authorities: ['user', 'helicop-sol', 'helicop-astra'] },
  { name: 'escalation with mandatory user', combination: 'escalation', authorities: ['user', 'helicop-sol', 'helicop-astra'], mandatory: ['user'] },
];
for (const set of SETS) test(`ActionGate ${set.name}: complete ballots in all arrival orders match the policy`, async t => {
  const directory = await scratch(t), lists = { mandatory: set.mandatory ?? [], veto: set.veto ?? [] };
  const execution = { consequentialAuthorities: set.authorities, combination: set.combination, mandatoryAuthorities: lists.mandatory, vetoAuthorities: lists.veto };
  for (const ballot of fullBallots(set.authorities)) agree(await finalsFor(directory, execution, ballot), expectedStatus(set.authorities, set.combination, lists, ballot), `${set.name} ${JSON.stringify(ballot)}`);
});

test('ActionGate with four authorities: every arrival order agrees for representative ballots', async t => {
  const directory = await scratch(t), authorities = ['user', 'trusted-orchestrator', 'helicop-sol', 'helicop-astra'];
  for (const [combination, mandatory] of [['OR', ['user']], ['prioritised', []], ['escalation', ['trusted-orchestrator']], ['AND', []]]) {
    const execution = { consequentialAuthorities: authorities, combination, mandatoryAuthorities: mandatory };
    for (const ballot of [{ user: true, 'trusted-orchestrator': true, 'helicop-sol': false, 'helicop-astra': true }, { user: true, 'trusted-orchestrator': false, 'helicop-sol': true, 'helicop-astra': false },
      { user: false, 'trusted-orchestrator': true, 'helicop-sol': true, 'helicop-astra': true }]) {
      agree(await finalsFor(directory, execution, ballot), expectedStatus(authorities, combination, { mandatory }, ballot), `${combination} ${JSON.stringify(ballot)}`);
    }
  }
});

test('ActionGate: partial ballots settle identically in any order and approval waits for every mandatory authority', async t => {
  const directory = await scratch(t), authorities = ['user', 'helicop-sol', 'helicop-astra'];
  const execution = { consequentialAuthorities: authorities, combination: 'OR', mandatoryAuthorities: ['user'] };
  for (const [ballot, expected] of [
    [{ 'helicop-sol': true }, 'pending'], [{ user: true }, 'pending'], [{ user: true, 'helicop-sol': false }, 'pending'],
    [{ user: true, 'helicop-sol': true }, 'approved'], [{ user: false }, 'rejected'], [{ user: true, 'helicop-sol': false, 'helicop-astra': false }, 'rejected'],
    [{ 'helicop-sol': true, 'helicop-astra': true }, 'pending'],
  ]) agree(await finalsFor(directory, execution, ballot), expected, JSON.stringify(ballot));
});

test('ActionGate prioritised: lower-priority rejection never decides and the senior authority alone settles', async t => {
  const directory = await scratch(t), authorities = ['helicop-astra', 'helicop-sol', 'user'];
  const session = await gateSession(directory, { consequentialAuthorities: authorities, combination: 'prioritised' });
  for (const order of permutations(['helicop-sol', 'user'])) {
    const action = await session.propose(), principals = await session.principalsFor(action);
    assert.equal(await cast(session, action, principals, order, { 'helicop-sol': false, user: false }), 'pending', 'junior rejections leave the senior gate open');
    await session.vote(action, 'helicop-astra', true, principals['helicop-astra']);
    assert.equal(await session.status(action), 'approved');
  }
  const action = await session.propose(), principals = await session.principalsFor(action);
  await session.vote(action, 'helicop-sol', true, principals['helicop-sol']);
  await session.vote(action, 'helicop-astra', false, principals['helicop-astra']);
  assert.equal(await session.status(action), 'rejected', 'the senior rejection prevails over a junior approval');
});

test('ActionGate escalation: optional dissent escalates only after mandatory gates answer and never silently approves', async t => {
  const directory = await scratch(t), authorities = ['user', 'helicop-sol', 'helicop-astra'];
  const session = await gateSession(directory, { consequentialAuthorities: authorities, combination: 'escalation', mandatoryAuthorities: ['user'] });
  for (const order of permutations(['user', 'helicop-sol'])) {
    const action = await session.propose(), principals = await session.principalsFor(action, ['helicop-sol']);
    assert.equal(await cast(session, action, principals, order, { user: true, 'helicop-sol': false }), 'escalated', order.join());
    await assert.rejects(session.consume(action), /approval missing/);
  }
  const action = await session.propose(), principals = await session.principalsFor(action, ['helicop-sol']);
  await session.vote(action, 'helicop-sol', false, principals['helicop-sol']);
  assert.equal(await session.status(action), 'pending');
  await session.vote(action, 'user', false, principals.user);
  assert.equal(await session.status(action), 'rejected', 'a mandatory rejection beats escalation whatever the arrival order');
});

test('ActionGate: duplicate votes, wrong hashes and unconfigured or unverified principals are refused without changing the verdict', async t => {
  const directory = await scratch(t);
  const session = await gateSession(directory, { consequentialAuthorities: ['user', 'helicop-sol', 'helicop-astra'], combination: 'OR', mandatoryAuthorities: ['user'] });
  const action = await session.propose(), principals = await session.principalsFor(action);
  await session.vote(action, 'helicop-sol', false, principals['helicop-sol']);
  await assert.rejects(session.vote(action, 'helicop-sol', true, principals['helicop-sol']), /already voted/);
  await assert.rejects(session.gate.decide('m', action.id, { actionHash: 'f'.repeat(64), approved: true, rationale: 'wrong action' }, principals.user), /exact action/);
  await assert.rejects(session.vote(action, 'trusted-orchestrator', true, principals['trusted-orchestrator']), /not configured/);
  await assert.rejects(session.vote(action, 'user', true, { ...principals.user, trusted: false }), /Unverified/);
  await assert.rejects(session.vote(action, 'user', true, { source: 'native-host', trusted: true, authority: 'user' }), /Invalid execution principal/);
  assert.equal((await session.record(action)).votes.length, 1);
  await session.vote(action, 'helicop-astra', true, principals['helicop-astra']);
  assert.equal(await session.status(action), 'pending', 'the mandatory user still has to approve');
  await session.vote(action, 'user', true, principals.user);
  assert.equal(await session.status(action), 'approved');
});

test('ActionGate: user and trusted-orchestrator principals work, and judge independence invariants still hold', async t => {
  const directory = await scratch(t);
  const session = await gateSession(directory, { consequentialAuthorities: ['user', 'trusted-orchestrator', 'helicop-sol'], combination: 'AND' });
  const action = await session.propose(), principals = await session.principalsFor(action);
  // The root node, a judge of another action, and a judge that never completed cannot vote.
  await assert.rejects(session.vote(action, 'helicop-sol', true, { ...principals['helicop-sol'], nodeId: 'root' }), /fresh, independent/);
  const other = await session.propose(), otherPrincipals = await session.principalsFor(other);
  await assert.rejects(session.vote(action, 'helicop-sol', true, otherPrincipals['helicop-sol']), /fresh, independent/);
  const third = await session.propose(), queued = await session.gate.appointJudge('m', third.id, 'helicop-sol');
  await assert.rejects(session.vote(third, 'helicop-sol', true, { source: 'judge', trusted: true, authority: 'helicop-sol', nodeId: queued.id }), /fresh, independent/);
  await assert.rejects(session.vote(action, 'user', true, { source: 'judge', trusted: true, authority: 'user', nodeId: principals['helicop-sol'].nodeId }), /Invalid execution principal|fresh, independent/);
  assert.equal((await session.record(action)).votes.length, 0);
  await session.vote(action, 'user', true, principals.user);
  await session.vote(action, 'trusted-orchestrator', true, principals['trusted-orchestrator']);
  assert.equal(await session.status(action), 'pending');
  await session.vote(action, 'helicop-sol', true, principals['helicop-sol']);
  assert.equal(await session.status(action), 'approved');
  assert.deepEqual((await session.record(action)).votes.map(v => v.authority), ['user', 'trusted-orchestrator', 'helicop-sol']);
});

test('ActionGate expiry: late votes are refused, nothing is resurrected and a fresh proposal starts without old votes', async t => {
  const directory = await scratch(t);
  const session = await gateSession(directory, { consequentialAuthorities: ['user', 'helicop-sol'], combination: 'OR', mandatoryAuthorities: ['user'] });
  const action = await session.propose(), principals = await session.principalsFor(action);
  await session.vote(action, 'user', true, principals.user);
  assert.equal(await session.status(action), 'pending');
  session.advance(900001);
  await assert.rejects(session.vote(action, 'helicop-sol', true, principals['helicop-sol']), /not pending or has expired/);
  const stale = await session.record(action);
  assert.notEqual(stale.status, 'approved'); assert.equal(stale.votes.length, 1);
  await assert.rejects(session.consume(action), /approval missing/);
  // Re-proposing the identical action must not hand back the expired record or carry its votes over.
  const again = await session.gate.propose('m', 'root', action.action);
  assert.notEqual(again.id, action.id); assert.equal(again.status, 'pending'); assert.deepEqual(again.votes, []); assert.ok(again.expiresAt > session.now());
  assert.equal((await session.record(action)).status, 'expired');
  const fresh = await session.principalsFor(again);
  await session.vote(again, 'helicop-sol', true, fresh['helicop-sol']);
  assert.equal(await session.status(again), 'pending', 'the expired action user approval does not carry over');
  await session.vote(again, 'user', true, fresh.user);
  assert.equal(await session.status(again), 'approved');
  // An approved action that then expires can no longer be consumed.
  session.advance(900001);
  await assert.rejects(session.consume(again), /missing, consumed, stale or expired/);
});

test('ActionGate: a terminal approval is final; a later rejection cannot revoke or re-open it', async t => {
  const directory = await scratch(t);
  const session = await gateSession(directory, { consequentialAuthorities: ['helicop-sol', 'helicop-astra'], combination: 'OR' });
  const action = await session.propose(), principals = await session.principalsFor(action);
  await session.vote(action, 'helicop-astra', true, principals['helicop-astra']);
  assert.equal(await session.status(action), 'approved');
  await assert.rejects(session.vote(action, 'helicop-sol', false, principals['helicop-sol']), /not pending or has expired/);
  assert.equal(await session.status(action), 'approved');
});

test('ActionGate: the policy is bound to the proposed action and unknown combinations cannot be configured', async t => {
  const directory = await scratch(t);
  const session = await gateSession(directory, { consequentialAuthorities: ['helicop-sol', 'helicop-astra'], combination: 'OR' });
  const action = await session.propose();
  assert.equal(action.combination, 'OR');
  assert.deepEqual(action.requirements.map(r => [r.authority, r.mandatory, r.veto]), [['helicop-sol', false, false], ['helicop-astra', false, false]]);
  for (const bad of ['or', 'XOR', 'majority', '']) await assert.rejects(gateSession(directory, { consequentialAuthorities: ['user'], combination: bad }), /execution\.combination must be one of/);
});

/* ------------------------------------------------------------------ production broker (recruitment) boundary */

/** Each sequence gets its own ledger because every supervisor consumes bounded Review capacity. */
async function recruitSession(directory, helicop) {
  let now = START;
  const store = new ExecutionStore(path.join(directory, `recruit-${++sequence}.json`), { now: () => now });
  const rule = (id, authority, flags) => ({ id, authority, enabled: true, when: { childFamilies: ['astra'] }, mandatory: false, veto: false, priority: authority === 'helicop-astra' ? 100 : authority === 'user' ? 1000 : 50, ...flags });
  const rules = (helicop.rules ?? [['sol', 'helicop-sol', {}], ['astra', 'helicop-astra', {}]]).map(([id, authority, flags]) => rule(id, authority, flags));
  const broker = new RecruitmentBroker(store, { config: { enabled: true, helicop: { combination: helicop.combination, rules } }, now: () => now });
  await broker.createMission({ id: 'r', task: 'Recruitment approval fixture', orchestrator: { model: 'opus', trusted: true, source: 'offline-fixture' } });
  const request = await broker.request('r', 'root', { worker: 'astra6-2', role: 'implementation', task: 'Independent implementation of the proposal.', risk: RISK }, 'request');
  assert.equal(request.status, 'pending');
  return { broker, store, request, principals: {}, advance: ms => { now += ms; },
    async principalsFor(authorities) {
      const principals = { user: { source: 'local-user', trusted: true, authority: 'user' } };
      for (const authority of authorities.filter(a => a.startsWith('helicop-'))) {
        const node = await broker.appointSupervisor('r', request.id, authority);
        principals[authority] = { source: 'supervisor', trusted: true, authority, nodeId: node.id };
      }
      return principals;
    },
    vote: (authority, decision, principals) => broker.decide('r', request.id, { decision, rationale: `${authority} ${decision}`,
      ...(decision === 'MODIFY' && { modification: { worker: 'luna6', task: 'Narrower scope.', budget: { tokens: 8000, usd: 0.5 } } }) }, principals[authority]),
    status: async () => (await store.snapshot('r')).requests[request.id].status };
}
async function runRecruitment(directory, helicop, order, ballot) {
  const session = await recruitSession(directory, helicop), principals = await session.principalsFor(order);
  for (const authority of order) {
    if (await session.status() === 'pending') await session.vote(authority, ballot[authority], principals);
    else await assert.rejects(session.vote(authority, ballot[authority], principals), /not pending/);
  }
  return session.status();
}
const recruitmentFinals = (directory, helicop, ballot) => mapLimit(permutations(Object.keys(ballot)), 6, order => runRecruitment(directory, helicop, order, ballot));
const SOL = 'helicop-sol', ASTRA = 'helicop-astra';

test('recruitment OR: optional helicopters cannot pre-empt each other whatever the arrival order', async t => {
  const directory = await scratch(t);
  for (const [ballot, expected] of [
    [{ [SOL]: 'REJECT', [ASTRA]: 'APPROVE' }, 'queued'], [{ [SOL]: 'APPROVE', [ASTRA]: 'REJECT' }, 'queued'], [{ [SOL]: 'APPROVE', [ASTRA]: 'APPROVE' }, 'queued'],
    [{ [SOL]: 'REJECT', [ASTRA]: 'REJECT' }, 'rejected'], [{ [SOL]: 'MODIFY', [ASTRA]: 'APPROVE' }, 'queued'], [{ [SOL]: 'ESCALATE', [ASTRA]: 'APPROVE' }, 'queued'],
    [{ [SOL]: 'MODIFY', [ASTRA]: 'REJECT' }, 'modify'], [{ [SOL]: 'ESCALATE', [ASTRA]: 'REJECT' }, 'escalated'], [{ [SOL]: 'MODIFY', [ASTRA]: 'ESCALATE' }, 'modify'],
  ]) agree(await recruitmentFinals(directory, { combination: 'OR' }, ballot), expected, JSON.stringify(ballot));
});

test('recruitment OR: one answered optional gate leaves the request pending until the peer answers', async t => {
  const directory = await scratch(t), session = await recruitSession(directory, { combination: 'OR' });
  const principals = await session.principalsFor([SOL, ASTRA]);
  await session.vote(SOL, 'REJECT', principals);
  assert.equal(await session.status(), 'pending');
  await session.vote(ASTRA, 'APPROVE', principals);
  assert.equal(await session.status(), 'queued');
  await assert.rejects(session.vote(SOL, 'REJECT', principals), /not pending/);
});

test('recruitment keeps genuinely mandatory/veto gates terminal and independent of arrival order in every combination', async t => {
  const directory = await scratch(t);
  for (const combination of COMBINATIONS) {
    const helicop = { combination, rules: [['sol', SOL, { mandatory: true, veto: true }], ['astra', ASTRA, { mandatory: true, veto: true }]] };
    for (const ballot of [{ [SOL]: 'APPROVE', [ASTRA]: 'APPROVE' }, { [SOL]: 'REJECT', [ASTRA]: 'APPROVE' }, { [SOL]: 'APPROVE', [ASTRA]: 'REJECT' }, { [SOL]: 'REJECT', [ASTRA]: 'REJECT' },
      { [SOL]: 'MODIFY', [ASTRA]: 'REJECT' }, { [SOL]: 'MODIFY', [ASTRA]: 'APPROVE' }, { [SOL]: 'ESCALATE', [ASTRA]: 'APPROVE' }, { [SOL]: 'ESCALATE', [ASTRA]: 'MODIFY' }]) {
      const v = Object.values(ballot);
      const expected = v.includes('REJECT') ? 'rejected' : v.includes('MODIFY') ? 'modify' : v.includes('ESCALATE') ? 'escalated' : 'queued';
      agree(await recruitmentFinals(directory, helicop, ballot), expected, `${combination} ${JSON.stringify(ballot)}`);
    }
  }
});

test('recruitment: a mandatory gate is not replaced by optional helicopters and a mandatory user gate stays independent', async t => {
  const directory = await scratch(t);
  const helicop = { combination: 'OR', rules: [['sol', SOL, {}], ['astra', ASTRA, {}], ['owner', 'user', { mandatory: true, veto: true }]] };
  for (const [name, ballot, expected] of [
    ['helicop approvals alone', { [SOL]: 'APPROVE', [ASTRA]: 'APPROVE' }, 'pending'],
    ['user approves, one helicop approves', { user: 'APPROVE', [SOL]: 'APPROVE' }, 'queued'],
    ['user rejects after helicop approval', { [ASTRA]: 'APPROVE', user: 'REJECT' }, 'rejected'],
    ['user approves then both helicopters reject', { user: 'APPROVE', [SOL]: 'REJECT', [ASTRA]: 'REJECT' }, 'rejected'],
    ['user approves, one rejection', { user: 'APPROVE', [SOL]: 'REJECT' }, 'pending'],
  ]) agree(await recruitmentFinals(directory, helicop, ballot), expected, name);
});

test('recruitment: a veto holder among optional helicopters is awaited before an optional approval is accepted', async t => {
  const directory = await scratch(t);
  const helicop = { combination: 'OR', rules: [['sol', SOL, {}], ['astra', ASTRA, { veto: true }]] };
  agree(await recruitmentFinals(directory, helicop, { [SOL]: 'APPROVE' }), 'pending', 'optional approval alone');
  agree(await recruitmentFinals(directory, helicop, { [SOL]: 'APPROVE', [ASTRA]: 'REJECT' }), 'rejected', 'late veto prevails');
  agree(await recruitmentFinals(directory, helicop, { [SOL]: 'APPROVE', [ASTRA]: 'APPROVE' }), 'queued', 'veto holder approves');
});

test('recruitment: the shipped default HELICOP rules remain mandatory and unaffected by arrival order', async t => {
  const directory = await scratch(t);
  let now = START;
  const store = new ExecutionStore(path.join(directory, 'default.json'), { now: () => now });
  const broker = new RecruitmentBroker(store, { config: { enabled: true, recruitment: { mode: 'SKYNET' } }, now: () => now });
  const mission = await broker.createMission({ id: 'd', task: 'Default rules', orchestrator: { model: 'opus', trusted: true, source: 'offline-fixture' } });
  const parent = await broker.request(mission.id, 'root', { worker: 'sol6-2', role: 'exploration', task: 'Keep the parent active.', risk: RISK }, 'parent');
  await broker.claim(mission.id, 'fixture-parent', { nodeId: parent.nodeId });
  const child = await broker.request(mission.id, parent.nodeId, { worker: 'astra6-2', role: 'exploration', task: 'Senior exploration.', risk: RISK }, 'child');
  assert.equal(child.status, 'pending');
  assert.ok(child.evaluation.requiredApprovals.every(a => a.mandatory && a.veto));
  const node = await broker.appointSupervisor(mission.id, child.id, ASTRA);
  await assert.rejects(broker.decide(mission.id, child.id, { decision: 'APPROVE', rationale: 'wrong authority' }, { source: 'local-user', trusted: true, authority: 'user' }), /not assigned/);
  const after = await broker.decide(mission.id, child.id, { decision: 'REJECT', rationale: 'Astra vetoes.' }, { source: 'supervisor', trusted: true, authority: ASTRA, nodeId: node.id });
  assert.equal(after.status, 'rejected');
});

/* ------------------------------------------------------------------ VOTE-01: a lapsed recruitment vote never strands the request */

const OWNER = { source: 'local-user', trusted: true, authority: 'user' };
const BOTH_MANDATORY = { combination: 'AND', rules: [['sol6-2', SOL, { mandatory: true, veto: true }], ['astra6-2', ASTRA, { mandatory: true, veto: true }]] };
const outstanding = async session => Object.values((await session.store.snapshot('r')).requests).filter(r => ['pending', 'queued', 'running'].includes(r.status)).length;
const VOTE_TTL = 15 * 60 * 1000 + 1;
const ORIGINAL = { worker: 'astra6-2', role: 'implementation', task: 'Independent implementation of the proposal.', risk: RISK };

test('VOTE-01: an authority whose vote lapsed may decide again, so the slow co-approver no longer strands the request', async t => {
  const session = await recruitSession(await scratch(t), BOTH_MANDATORY), principals = await session.principalsFor([SOL, ASTRA]);
  await session.vote(SOL, 'APPROVE', principals);
  // A vote that is still in force really is final, and the error no longer names the impossible "revised request" remedy.
  await assert.rejects(session.vote(SOL, 'REJECT', principals), error => /unexpired vote/.test(error.message) && !/revised request/.test(error.message));
  session.advance(VOTE_TTL);
  await session.vote(ASTRA, 'APPROVE', principals);
  assert.equal(await session.status(), 'pending', "Sol's lapsed vote no longer counts, so Astra alone cannot approve");
  await session.vote(SOL, 'APPROVE', principals);
  assert.equal(await session.status(), 'queued', 'the renewed vote completes the combination');
  const request = (await session.store.snapshot('r')).requests[session.request.id];
  assert.equal(request.approvals.length, 3, 'the lapsed vote stays on record next to the fresh one');
  // The renewed vote is itself an unexpired decision: a second renewal is refused once the request is no longer pending.
  await assert.rejects(session.vote(SOL, 'APPROVE', principals), /not pending/);
});

test('VOTE-01: a lapsed vote whose authority never answers again can be expired by the owner, which frees the slot and ends supervision', async t => {
  const session = await recruitSession(await scratch(t), BOTH_MANDATORY), principals = await session.principalsFor([SOL, ASTRA]);
  const before = await outstanding(session);
  assert.equal(before, 3, 'the stuck request and its two supervisor allocations occupy slots');
  await session.vote(SOL, 'APPROVE', principals);
  session.advance(VOTE_TTL);
  await session.vote(ASTRA, 'APPROVE', principals);
  assert.equal(await session.status(), 'pending');
  // revise() was never the remedy: the request is not modify/rejected/escalated.
  await assert.rejects(session.broker.revise('r', session.request.id, 'root', {}, 'revise-key'), /cannot be revised/);
  // Nobody but the owner or a full orchestrator can close it, and a reason is required.
  const restricted = { source: 'supervisor', trusted: true, authority: SOL, nodeId: principals[SOL].nodeId };
  await assert.rejects(session.broker.expire('r', session.request.id, 'x', restricted), /authorised owner/);
  await assert.rejects(session.broker.expire('r', session.request.id, 'x', { source: 'local-user', trusted: false, authority: 'user' }), /authorised owner/);
  await assert.rejects(session.broker.expire('r', session.request.id, ' ', OWNER), /needs a reason/);
  await assert.rejects(session.broker.expire('r', 'unknown', 'x', OWNER), /awaiting votes/);
  assert.equal(await session.status(), 'pending', 'refused expiries change nothing');
  const expired = await session.broker.expire('r', session.request.id, 'Sol never answered again; resubmitting', OWNER);
  assert.equal(expired.status, 'expired'); assert.equal(expired.expiryReason, 'Sol never answered again; resubmitting');
  assert.equal(await outstanding(session), 0, 'the request and its unfinished supervisors no longer occupy outstanding slots');
  const m = await session.store.snapshot('r');
  assert.ok(Object.values(m.nodes).filter(n => n.supervises === session.request.id).every(n => n.status === 'cancelled'));
  // Terminal: no further votes, no second expiry, no revival through the same idempotency key.
  await assert.rejects(session.vote(SOL, 'APPROVE', principals), /not pending/);
  await assert.rejects(session.broker.expire('r', session.request.id, 'again', OWNER), /awaiting votes/);
  assert.equal((await session.broker.request('r', 'root', ORIGINAL, 'request')).status, 'expired');
  // A new request is adjudicated from scratch: it carries none of the old votes.
  const fresh = await session.broker.request('r', 'root', ORIGINAL, 'request-2');
  assert.notEqual(fresh.id, session.request.id); assert.equal(fresh.status, 'pending'); assert.deepEqual(fresh.approvals, []);
  assert.equal(await outstanding(session), 1);
});

test('VOTE-01: repeatedly lapsing requests no longer leak outstanding slots once the owner expires them', async t => {
  const session = await recruitSession(await scratch(t), BOTH_MANDATORY);
  for (let i = 0; i < 3; i++) {
    const stuck = await session.broker.request('r', 'root', ORIGINAL, `again-${i}`);
    session.advance(VOTE_TTL);
    await session.broker.expire('r', stuck.id, 'lapsed', OWNER);
  }
  assert.equal(await outstanding(session), 1, 'only the original request still holds a slot');
});
