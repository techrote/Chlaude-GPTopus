import { createHash } from 'node:crypto';
import { WORKER_TYPES } from '../bridge/workers.mjs';

export const CONFIG_VERSION = 1;
/** Stable identifier of one required verification; shared by owner policy, workflow plans and evidence. */
export const TEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+ -]{0,127}$/;
/** Areas map onto trusted risk flags (securitySensitive, privacySensitive, ...), never onto author text. */
export const TEST_AREAS = Object.freeze(['security', 'privacy', 'destructive', 'external', 'deployment', 'persistence']);
export const MODES = Object.freeze({
  SWARM: Object.freeze({ lower: true, equal: false, higher: false }),
  REPLICATOR: Object.freeze({ lower: true, equal: true, higher: false }),
  SKYNET: Object.freeze({ lower: true, equal: true, higher: true }),
});
export const ROLES = Object.freeze(['implementation', 'exploration', 'reviewer', 'second_opinion', 'gap_inspector', 'reworker', 'judge', 'supervisor']);
export const REVIEW_ROLES = Object.freeze(['reviewer', 'second_opinion', 'gap_inspector', 'judge', 'supervisor']);
export const PROFILE_NAMES = Object.freeze(['Lite', 'Balanced', 'Research', 'Critical Engineering', 'Custom']);
const clone = value => structuredClone(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const families = { astra: 4, sol: 3, luna: 2, terra: 1 };
const workerFamilies = { 'sol6-2': 'sol', 'astra6-2': 'astra', luna6: 'luna', luna6fast: 'luna', luna6flex: 'luna', 'sol6-1flex': 'sol', astra6free: 'astra', 'terra5-6free': 'terra' };
const models = Object.fromEntries(Object.entries(WORKER_TYPES).map(([worker, spec]) => [spec.model, { family: workerFamilies[worker], rank: null }]));
const workers = Object.fromEntries(Object.entries(WORKER_TYPES).map(([worker, spec]) => [worker, {
  model: spec.model, family: workerFamilies[worker], keyProfile: spec.key,
  mode: null, permissions: null, serviceTier: spec.defaultTier ?? null,
}]));
function freezeDeep(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}
export const DEFAULT_CONFIG = freezeDeep({
  version: CONFIG_VERSION,
  enabled: false,
  profile: 'Lite',
  families, models, workers,
  recruitment: { mode: 'SWARM', custom: { lower: true, equal: false, higher: false }, reviewHigher: true },
  permissions: { recruit: { lower: true, equal: true, higher: true }, reviewHigher: true, tools: [], roots: [] },
  fleets: {
    core: { maxDepth: 2, maxInvocations: 12, concurrency: 4, reserved: 0 },
    review: { maxDepth: 2, maxInvocations: 12, concurrency: 3, reserved: 1 },
  },
  mission: { maxTokens: null, maxUsd: null, maxWallMs: null, maxOutstanding: 32, maxJobs: 24, maxRetries: 2, requestsPerMinute: null, perKey: {}, perModel: {} },
  authority: {
    unknownProfile: 'restricted',
    profiles: {
      opus: { authority: 'full', restrictedFamilies: [], supervisor: null, final: true },
      fable: { authority: 'full', restrictedFamilies: [], supervisor: null, final: true },
      sonnet: { authority: 'routine', restrictedFamilies: ['sol', 'astra'], supervisor: 'helicop-sol', final: true },
      haiku: { authority: 'limited', restrictedFamilies: ['sol', 'astra'], supervisor: 'helicop-sol', final: true },
      restricted: { authority: 'limited', restrictedFamilies: ['sol', 'astra'], supervisor: 'user', final: true },
    },
    configuredIdentity: null,
  },
  helicop: {
    sol: true, astra: true, combination: 'AND', denial: 'revise', maxRevisions: 1,
    rules: [
      { id: 'sol-peer', authority: 'helicop-sol', enabled: true, when: { parentFamilies: ['sol'], childFamilies: ['sol'] }, mandatory: true, veto: true, priority: 50 },
      { id: 'sol-astra', authority: 'helicop-astra', enabled: true, when: { parentFamilies: ['sol'], childFamilies: ['astra'] }, mandatory: true, veto: true, priority: 100 },
    ],
  },
  risk: { minimumConfidence: 0.75, uncertainAuthority: 'helicop-sol', highAuthority: 'helicop-astra', requireHighRecruitmentApproval: false },
  review: {
    selection: 'B', maxRounds: 3, primary: 'astra6-2', reworker: 'sol6-2', rereviewer: 'astra6-2', secondOpinion: 'sol6-2', gapInspector: 'luna6', judge: 'astra6-2',
    secondOpinionImpacts: ['high', 'critical'], gapInspectionImpacts: ['high', 'critical'], freshGapInspector: true,
    requireTests: true, repeatedDefectLimit: 2, noProgressLimit: 1, blindSecondOpinion: true,
    // Owner-policy mandatory tests: [{ id, description?, impacts?, areas?, executable?, commandDigest? }]. Agents may add to, never remove, these.
    requiredTests: [],
    // Impact tiers at which work that demands tests but designates none is held instead of accepting "some passing evidence".
    testPlanRequiredImpacts: ['high', 'critical', 'unknown'],
    // Tiers at which an owner-attested (human) record may satisfy a test; elsewhere independent execution is required.
    ownerAttestedImpacts: ['low', 'medium'],
    // Owner waivers of non-executable tests are refused for critical impact unless this is true.
    allowCriticalWaivers: false,
  },
  freeToPaid: { policy: 'B', maxTokensWithoutApproval: 16000, maxUsdWithoutApproval: 0.25, authority: 'user' },
  execution: { defaultApproval: 'risk-based', consequentialAuthorities: ['user'], combination: 'AND', mandatoryAuthorities: [], vetoAuthorities: [], requireFreshEvidence: true },
  desktop: { profile: 'A', enableExecutionBridge: false, roots: [] },
  // Independent capability ceilings for the two native Code surfaces. Desktop Chat
  // keeps `desktop`. Every ceiling defaults to the lowest (think-only) level.
  surfaces: {
    codeCli: { profile: 'A', enableExecutionBridge: false },
    desktopCode: { profile: 'A', enableExecutionBridge: false },
  },
});

/** Native Code surfaces with an owner-configured ceiling. Desktop Chat is governed by `desktop`. */
export const SURFACE_KEYS = Object.freeze(['codeCli', 'desktopCode']);
export const PROFILE_RANK = Object.freeze({ A: 0, B: 1, C: 2 });
// Closed vocabulary of host-reported surface names (`$.session.surfaces()` reports
// `terminal`/`desktop`/...). Anything else, or a mixture, is an unqualified surface.
const HOST_SURFACE_FACTS = Object.freeze({ terminal: 'codeCli', cli: 'codeCli', desktop: 'desktopCode' });

/**
 * Resolve the native Code surface from trusted host facts supplied by the mod at
 * initialisation. Empty, unrecognised, malformed or mixed facts are 'unknown', which
 * receives the lowest ceiling. Never accepts a caller-supplied model/tool argument.
 */
export function resolveHostSurface(facts) {
  const raw = facts && typeof facts === 'object' ? [...(Array.isArray(facts.surfaces) ? facts.surfaces : []), ...(facts.surface === undefined ? [] : [facts.surface])] : [];
  if (!raw.length || raw.length > 16) return 'unknown';
  const found = new Set();
  for (const fact of raw) {
    if (typeof fact !== 'string' || !own(HOST_SURFACE_FACTS, fact)) return 'unknown';
    found.add(HOST_SURFACE_FACTS[fact]);
  }
  return found.size === 1 ? [...found][0] : 'unknown';
}
/** Ceiling for one native Code surface; a missing/invalid entry or unknown surface is think-only. */
export function surfaceCeiling(config, surface) {
  const known = typeof surface === 'string' && SURFACE_KEYS.includes(surface);
  const spec = known && config?.surfaces && own(config.surfaces, surface) ? config.surfaces[surface] : null;
  if (!spec || typeof spec !== 'object' || typeof spec.profile !== 'string' || !own(PROFILE_RANK, spec.profile)) {
    return { surface: known ? surface : 'unknown', configured: null, profile: 'A', enableExecutionBridge: false };
  }
  const bridge = spec.enableExecutionBridge === true;
  // C without the explicit bridge flag is never honoured, even for unvalidated input.
  return { surface, configured: spec.profile, profile: spec.profile === 'C' && !bridge ? 'B' : spec.profile, enableExecutionBridge: bridge };
}
/** The project-access profile governing a mission's file tools: native missions use their Code surface, others keep Desktop Chat's. */
export function missionProfile(mission) {
  return mission.surface === 'native' ? surfaceCeiling(mission.config, mission.native?.surface).profile : mission.config.desktop.profile;
}

export function modeFlags(mode, custom = DEFAULT_CONFIG.recruitment.custom) {
  if (mode === 'CUSTOM') return clone(custom);
  if (!own(MODES, mode)) throw new Error(`Unknown recruitment mode: ${String(mode)}.`);
  return clone(MODES[mode]);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} must be an object.`);
}
function keys(value, permitted, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!permitted.includes(key)) throw new Error(`Unknown configuration field: ${label}.${key}.`);
}
function bool(value, label) { if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`); }
function str(value, label) { if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new Error(`${label} must be nonblank text.`); }
function en(value, choices, label) { if (!choices.includes(value)) throw new Error(`${label} must be one of ${choices.join(', ')}.`); }
function num(value, label, min = 0, nullable = false, integer = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) throw new Error(`${label} must be a finite ${integer ? 'integer ' : ''}number >= ${min}${nullable ? ' or null' : ''}.`);
}
function list(value, label, choices) {
  if (!Array.isArray(value) || value.length > 512 || new Set(value).size !== value.length) throw new Error(`${label} must be a bounded array of unique values.`);
  value.forEach(v => choices ? en(v, choices, label) : str(v, label));
}
export function validatePermissions(value, label = 'permissions') {
  keys(value, ['recruit', 'reviewHigher', 'tools', 'roots'], label);
  keys(value.recruit, ['lower', 'equal', 'higher'], `${label}.recruit`);
  ['lower', 'equal', 'higher'].forEach(k => bool(value.recruit[k], `${label}.recruit.${k}`));
  bool(value.reviewHigher, `${label}.reviewHigher`);
  list(value.tools, `${label}.tools`); list(value.roots, `${label}.roots`);
  return value;
}
const matchLists = { modes: ['SWARM', 'REPLICATOR', 'SKYNET', 'CUSTOM'], parentFamilies: null, parentModels: null, childFamilies: null, childModels: null, purposes: ROLES,
  complexities: ['low', 'medium', 'high', 'critical', 'unknown'], impacts: ['low', 'medium', 'high', 'critical', 'unknown'], verifiabilities: ['high', 'medium', 'low', 'unknown'], toolsAny: null, keyTransitions: ['free->standard', 'standard->free', 'free->free', 'standard->standard'] };
const matchNumbers = ['minimumUsd', 'maximumUsd', 'minimumTokens', 'maximumTokens', 'minimumAgents', 'maximumAgents', 'minimumConcurrency', 'maximumConcurrency', 'minimumDepth', 'maximumDepth', 'confidenceBelow'];

/** Strict validation: misspelt fields must not quietly weaken a policy. */
export function validateConfig(config) {
  keys(config, Object.keys(DEFAULT_CONFIG), 'config');
  en(config.version, [CONFIG_VERSION], 'config.version'); bool(config.enabled, 'config.enabled'); en(config.profile, PROFILE_NAMES, 'config.profile');
  object(config.families, 'families');
  if (!Object.keys(config.families).length) throw new Error('At least one model family must be classified.');
  for (const [family, rank] of Object.entries(config.families)) { str(family, 'family'); num(rank, `families.${family}`, 0); }
  object(config.models, 'models');
  for (const [model, spec] of Object.entries(config.models)) {
    str(model, 'model'); keys(spec, ['family', 'rank'], `models.${model}`); en(spec.family, Object.keys(config.families), `models.${model}.family`);
    num(spec.rank, `models.${model}.rank`, 0, true);
  }
  object(config.workers, 'workers');
  for (const [worker, spec] of Object.entries(config.workers)) {
    str(worker, 'worker'); keys(spec, ['model', 'family', 'keyProfile', 'mode', 'permissions', 'serviceTier'], `workers.${worker}`);
    if (!own(config.models, spec.model)) throw new Error(`Worker ${worker} uses an unclassified model ${spec.model}.`);
    if (spec.family !== config.models[spec.model].family) throw new Error(`Worker ${worker} family differs from its exact model classification.`);
    en(spec.keyProfile, ['free', 'standard'], `workers.${worker}.keyProfile`);
    const fixedProfile = ['astra6free', 'terra5-6free'].includes(worker) ? 'free' : 'standard';
    if (spec.keyProfile !== fixedProfile) throw new Error(`Worker ${worker} must retain the ${fixedProfile} key route.`);
    if (spec.mode !== null) modeFlags(spec.mode);
    if (spec.permissions !== null) validatePermissions(spec.permissions, `workers.${worker}.permissions`);
    if (spec.serviceTier !== null) en(spec.serviceTier, ['auto', 'default', 'flex', 'fast', 'priority'], `workers.${worker}.serviceTier`);
  }
  for (const worker of Object.keys(WORKER_TYPES)) if (!own(config.workers, worker)) throw new Error(`Existing worker ${worker} must remain available.`);
  keys(config.recruitment, ['mode', 'custom', 'reviewHigher'], 'recruitment'); modeFlags(config.recruitment.mode);
  keys(config.recruitment.custom, ['lower', 'equal', 'higher'], 'recruitment.custom');
  Object.entries(config.recruitment.custom).forEach(([k, v]) => bool(v, `recruitment.custom.${k}`)); bool(config.recruitment.reviewHigher, 'recruitment.reviewHigher');
  validatePermissions(config.permissions);
  keys(config.fleets, ['core', 'review'], 'fleets');
  for (const pool of ['core', 'review']) {
    const fleet = config.fleets[pool]; keys(fleet, ['maxDepth', 'maxInvocations', 'concurrency', 'reserved'], `fleets.${pool}`);
    for (const field of ['maxDepth', 'maxInvocations', 'concurrency']) num(fleet[field], `fleets.${pool}.${field}`, 1, false, true);
    num(fleet.reserved, `fleets.${pool}.reserved`, 0, false, true);
    if (fleet.reserved >= fleet.concurrency) throw new Error(`${pool} reserved concurrency must leave an ordinary slot.`);
    if (pool === 'core' && fleet.reserved !== 0) throw new Error('Protected approval capacity belongs to the Review fleet.');
  }
  keys(config.mission, Object.keys(DEFAULT_CONFIG.mission), 'mission');
  for (const [k, v] of Object.entries(config.mission)) {
    if (['perKey', 'perModel'].includes(k)) continue;
    num(v, `mission.${k}`, k === 'maxRetries' ? 0 : 1e-9, ['maxTokens', 'maxUsd', 'maxWallMs', 'requestsPerMinute'].includes(k), k !== 'maxUsd');
  }
  for (const group of ['perKey', 'perModel']) {
    object(config.mission[group], `mission.${group}`);
    for (const [key, limits] of Object.entries(config.mission[group])) {
      en(key, group === 'perKey' ? ['free', 'standard'] : Object.keys(config.models), `mission.${group} key`);
      keys(limits, ['maxTokens', 'maxUsd', 'maxRequests'], `mission.${group}.${key}`);
      for (const field of ['maxTokens', 'maxUsd', 'maxRequests']) num(limits[field], `mission.${group}.${key}.${field}`, 0, true, field !== 'maxUsd');
    }
  }
  keys(config.authority, ['unknownProfile', 'profiles', 'configuredIdentity'], 'authority'); object(config.authority.profiles, 'authority.profiles');
  for (const [name, profile] of Object.entries(config.authority.profiles)) {
    keys(profile, ['authority', 'restrictedFamilies', 'supervisor', 'final'], `authority.profiles.${name}`);
    en(profile.authority, ['full', 'routine', 'limited'], `authority.profiles.${name}.authority`);
    list(profile.restrictedFamilies, `authority.profiles.${name}.restrictedFamilies`, Object.keys(config.families));
    if (profile.supervisor !== null) en(profile.supervisor, ['helicop-sol', 'helicop-astra', 'user'], `authority.profiles.${name}.supervisor`);
    bool(profile.final, `authority.profiles.${name}.final`);
  }
  en(config.authority.unknownProfile, Object.keys(config.authority.profiles), 'authority.unknownProfile');
  if (config.authority.profiles[config.authority.unknownProfile].authority === 'full') throw new Error('Unverified identity cannot receive full authority. Use explicit owner configuredIdentity.');
  if (config.authority.configuredIdentity !== null) {
    keys(config.authority.configuredIdentity, ['model', 'authorisedBy', 'expiresAt'], 'authority.configuredIdentity');
    en(config.authority.configuredIdentity.model, Object.keys(config.authority.profiles), 'authority.configuredIdentity.model');
    str(config.authority.configuredIdentity.authorisedBy, 'authority.configuredIdentity.authorisedBy');
    if (!Number.isFinite(Date.parse(config.authority.configuredIdentity.expiresAt))) throw new Error('configuredIdentity requires a valid expiry timestamp.');
  }
  keys(config.helicop, ['sol', 'astra', 'combination', 'denial', 'maxRevisions', 'rules'], 'helicop');
  bool(config.helicop.sol, 'helicop.sol'); bool(config.helicop.astra, 'helicop.astra'); en(config.helicop.combination, ['AND', 'OR', 'veto', 'prioritised', 'escalation'], 'helicop.combination');
  en(config.helicop.denial, ['reject', 'revise', 'escalate'], 'helicop.denial'); num(config.helicop.maxRevisions, 'helicop.maxRevisions', 0, false, true);
  if (!Array.isArray(config.helicop.rules) || config.helicop.rules.length > 256) throw new Error('helicop.rules must be a bounded array.');
  const ruleIds = new Set();
  for (const rule of config.helicop.rules) {
    keys(rule, ['id', 'authority', 'enabled', 'when', 'mandatory', 'veto', 'priority'], 'helicop.rule'); str(rule.id, 'helicop.rule.id');
    if (ruleIds.has(rule.id)) throw new Error('Helicop rule IDs must be unique.'); ruleIds.add(rule.id);
    en(rule.authority, ['helicop-sol', 'helicop-astra', 'user'], 'helicop.rule.authority'); bool(rule.enabled, 'helicop.rule.enabled'); bool(rule.mandatory, 'helicop.rule.mandatory'); bool(rule.veto, 'helicop.rule.veto'); num(rule.priority, 'helicop.rule.priority');
    keys(rule.when, [...Object.keys(matchLists), ...matchNumbers], `helicop.rule.${rule.id}.when`);
    for (const [key, value] of Object.entries(rule.when)) {
      if (own(matchLists, key)) list(value, `rule.${rule.id}.${key}`, matchLists[key]); else num(value, `rule.${rule.id}.${key}`);
    }
  }
  keys(config.risk, Object.keys(DEFAULT_CONFIG.risk), 'risk'); num(config.risk.minimumConfidence, 'risk.minimumConfidence');
  if (config.risk.minimumConfidence > 1) throw new Error('Risk confidence must be at most 1.');
  for (const field of ['uncertainAuthority', 'highAuthority']) en(config.risk[field], ['helicop-sol', 'helicop-astra', 'user'], `risk.${field}`);
  bool(config.risk.requireHighRecruitmentApproval, 'risk.requireHighRecruitmentApproval');
  keys(config.review, Object.keys(DEFAULT_CONFIG.review), 'review'); en(config.review.selection, ['B', 'C'], 'review.selection');
  for (const name of ['primary', 'reworker', 'rereviewer', 'secondOpinion', 'gapInspector', 'judge']) en(config.review[name], Object.keys(config.workers), `review.${name}`);
  for (const field of ['maxRounds', 'repeatedDefectLimit', 'noProgressLimit']) num(config.review[field], `review.${field}`, 1, false, true);
  for (const field of ['secondOpinionImpacts', 'gapInspectionImpacts']) list(config.review[field], `review.${field}`, ['low', 'medium', 'high', 'critical', 'unknown']);
  for (const field of ['freshGapInspector', 'requireTests', 'blindSecondOpinion', 'allowCriticalWaivers']) bool(config.review[field], `review.${field}`);
  for (const field of ['testPlanRequiredImpacts', 'ownerAttestedImpacts']) list(config.review[field], `review.${field}`, ['low', 'medium', 'high', 'critical', 'unknown']);
  if (!Array.isArray(config.review.requiredTests) || config.review.requiredTests.length > 64) throw new Error('review.requiredTests must be a bounded array.');
  const testIds = new Set();
  for (const test of config.review.requiredTests) {
    keys(test, ['id', 'description', 'impacts', 'areas', 'executable', 'commandDigest'], 'review.requiredTests entry');
    if (typeof test.id !== 'string' || !TEST_ID_PATTERN.test(test.id)) throw new Error('review.requiredTests entries need a bounded stable id.');
    if (testIds.has(test.id)) throw new Error(`Duplicate review.requiredTests id ${test.id}.`); testIds.add(test.id);
    if (test.description !== undefined) str(test.description, `review.requiredTests.${test.id}.description`);
    if (test.impacts !== undefined) list(test.impacts, `review.requiredTests.${test.id}.impacts`, ['low', 'medium', 'high', 'critical', 'unknown']);
    if (test.areas !== undefined) list(test.areas, `review.requiredTests.${test.id}.areas`, TEST_AREAS);
    if (test.executable !== undefined) bool(test.executable, `review.requiredTests.${test.id}.executable`);
    if (test.commandDigest !== undefined && test.commandDigest !== null && !/^[a-f0-9]{64}$/.test(test.commandDigest)) throw new Error(`review.requiredTests.${test.id}.commandDigest must be a SHA-256 hex digest or null.`);
    if (test.executable === false && test.commandDigest) throw new Error(`review.requiredTests.${test.id} cannot pin a command for a non-executable test.`);
  }
  keys(config.freeToPaid, Object.keys(DEFAULT_CONFIG.freeToPaid), 'freeToPaid'); en(config.freeToPaid.policy, ['A', 'B', 'C'], 'freeToPaid.policy');
  num(config.freeToPaid.maxTokensWithoutApproval, 'freeToPaid.maxTokensWithoutApproval', 0, false, true); num(config.freeToPaid.maxUsdWithoutApproval, 'freeToPaid.maxUsdWithoutApproval');
  en(config.freeToPaid.authority, ['user', 'helicop-sol', 'helicop-astra'], 'freeToPaid.authority');
  keys(config.execution, Object.keys(DEFAULT_CONFIG.execution), 'execution'); en(config.execution.defaultApproval, ['risk-based', 'always'], 'execution.defaultApproval');
  list(config.execution.consequentialAuthorities, 'execution.consequentialAuthorities', ['user', 'trusted-orchestrator', 'helicop-sol', 'helicop-astra']);
  if (!config.execution.consequentialAuthorities.length) throw new Error('Consequential actions require at least one approval authority.');
  en(config.execution.combination, ['AND', 'OR', 'veto', 'prioritised', 'escalation'], 'execution.combination'); bool(config.execution.requireFreshEvidence, 'execution.requireFreshEvidence');
  // Optional so that a configuration persisted before these lists existed stays valid (absent means none).
  for (const field of ['mandatoryAuthorities', 'vetoAuthorities']) if (own(config.execution, field)) {
    list(config.execution[field], `execution.${field}`);
    for (const authority of config.execution[field]) {
      en(authority, ['user', 'trusted-orchestrator', 'helicop-sol', 'helicop-astra'], `execution.${field}`);
      if (!config.execution.consequentialAuthorities.includes(authority)) throw new Error(`execution.${field} entry ${authority} must be listed in execution.consequentialAuthorities.`);
    }
  }
  const overlap = (config.execution.mandatoryAuthorities ?? []).filter(a => (config.execution.vetoAuthorities ?? []).includes(a));
  if (overlap.length) throw new Error(`Authority ${overlap[0]} cannot be both mandatory and veto; mandatory already makes its rejection terminal.`);
  if (!config.execution.requireFreshEvidence) throw new Error('Fresh execution evidence is an invariant; stale approval cannot be enabled by configuration.');
  keys(config.desktop, Object.keys(DEFAULT_CONFIG.desktop), 'desktop'); en(config.desktop.profile, ['A', 'B', 'C'], 'desktop.profile'); bool(config.desktop.enableExecutionBridge, 'desktop.enableExecutionBridge'); list(config.desktop.roots, 'desktop.roots');
  if (config.desktop.profile === 'C' && !config.desktop.enableExecutionBridge) throw new Error('Desktop C requires explicit enableExecutionBridge=true.');
  keys(config.surfaces, SURFACE_KEYS, 'surfaces');
  for (const surface of SURFACE_KEYS) {
    const spec = config.surfaces[surface];
    keys(spec, ['profile', 'enableExecutionBridge'], `surfaces.${surface}`);
    en(spec.profile, ['A', 'B', 'C'], `surfaces.${surface}.profile`); bool(spec.enableExecutionBridge, `surfaces.${surface}.enableExecutionBridge`);
    if (spec.profile === 'C' && !spec.enableExecutionBridge) throw new Error(`surfaces.${surface} C requires explicit enableExecutionBridge=true.`);
  }
  return config;
}

export function mergeConfig(base, patch) {
  object(patch, 'configuration layer');
  const result = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe configuration property.');
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])
      ? mergeConfig(result[key], value) : clone(value);
  }
  return result;
}

export function profileConfig(name = 'Lite') {
  if (name === 'Critical') name = 'Critical Engineering';
  en(name, PROFILE_NAMES, 'profile');
  const value = clone(DEFAULT_CONFIG); value.profile = name;
  if (name === 'Balanced') {
    value.fleets.core = { maxDepth: 3, maxInvocations: 24, concurrency: 6, reserved: 0 };
    value.fleets.review = { maxDepth: 2, maxInvocations: 18, concurrency: 4, reserved: 1 }; value.mission.maxJobs = 42;
  } else if (name === 'Research') {
    value.fleets.core = { maxDepth: 3, maxInvocations: 24, concurrency: 8, reserved: 0 }; value.mission.maxJobs = 36;
    value.permissions.tools = ['read_file', 'list_files'];
  } else if (name === 'Critical Engineering') {
    value.risk.requireHighRecruitmentApproval = true; value.execution.defaultApproval = 'always'; value.freeToPaid.policy = 'C';
    value.review.secondOpinionImpacts = ['medium', 'high', 'critical', 'unknown']; value.review.gapInspectionImpacts = ['medium', 'high', 'critical', 'unknown'];
  }
  return value;
}

/** Explicit project/worker/mission/stage layers may only attenuate security policy. */
function assertAttenuation(before, after) {
  const equalSections = ['families', 'models', 'workers', 'authority', 'helicop', 'risk', 'review', 'freeToPaid', 'execution'];
  for (const field of equalSections) if (canonical(before[field]) !== canonical(after[field])) throw new Error(`Untrusted configuration layer cannot alter ${field}; authorise it in owner configuration.`);
  if (!before.enabled && after.enabled) throw new Error('A scoped layer cannot enable ULTRA.');
  const oldFlags = modeFlags(before.recruitment.mode, before.recruitment.custom), flags = modeFlags(after.recruitment.mode, after.recruitment.custom);
  for (const key of Object.keys(flags)) if (flags[key] && !oldFlags[key]) throw new Error('Scoped recruitment mode exceeds its inherited ceiling.');
  if (after.recruitment.reviewHigher && !before.recruitment.reviewHigher) throw new Error('Scoped review escalation exceeds its ceiling.');
  for (const key of ['lower', 'equal', 'higher']) if (after.permissions.recruit[key] && !before.permissions.recruit[key]) throw new Error('Scoped recruitment permissions exceed their ceiling.');
  if (after.permissions.reviewHigher && !before.permissions.reviewHigher) throw new Error('Scoped review privilege exceeds its ceiling.');
  for (const key of ['tools', 'roots']) if (after.permissions[key].some(v => !before.permissions[key].includes(v))) throw new Error(`Scoped ${key} exceed their ceiling.`);
  for (const pool of ['core', 'review']) for (const field of ['maxDepth', 'maxInvocations', 'concurrency']) if (after.fleets[pool][field] > before.fleets[pool][field]) throw new Error('Scoped fleet allowance exceeds its ceiling.');
  if (after.fleets.review.reserved < before.fleets.review.reserved) throw new Error('Scoped policy cannot remove protected reviewer capacity.');
  for (const [key, value] of Object.entries(before.mission)) {
    if (['perKey', 'perModel'].includes(key)) {
      for (const [name, limits] of Object.entries(value)) for (const [field, limit] of Object.entries(limits)) {
        const next = after.mission[key][name]?.[field];
        if (limit !== null && (next === undefined || next === null || next > limit)) throw new Error(`Scoped mission ${key}.${name}.${field} exceeds its ceiling.`);
      }
    } else if (value !== null && (after.mission[key] === null || after.mission[key] > value)) throw new Error(`Scoped mission ${key} exceeds its ceiling.`);
  }
  const ranks = { A: 0, B: 1, C: 2 };
  if (ranks[after.desktop.profile] > ranks[before.desktop.profile] || (after.desktop.enableExecutionBridge && !before.desktop.enableExecutionBridge) || after.desktop.roots.some(p => !before.desktop.roots.includes(p))) throw new Error('Scoped Desktop access exceeds its ceiling.');
  for (const surface of SURFACE_KEYS) {
    const was = before.surfaces[surface], now = after.surfaces[surface];
    if (PROFILE_RANK[now.profile] > PROFILE_RANK[was.profile] || (now.enableExecutionBridge && !was.enableExecutionBridge)) throw new Error(`Scoped ${surface} Code surface access exceeds its ceiling.`);
  }
}

/** Raw objects are owner configuration. Wrapped scoped layers require explicit authorisation to expand. */
export function resolveConfig(overrides = {}, ...additionalLayers) {
  const layers = Array.isArray(overrides) ? overrides : [overrides, ...additionalLayers];
  const first = layers[0]?.value ?? layers[0] ?? {};
  let value = profileConfig(first.profile ?? 'Lite');
  for (const layer of layers) {
    const wrapped = layer && own(layer, 'value');
    const patch = wrapped ? layer.value : layer;
    if (wrapped) {
      keys(layer, ['value', 'scope', 'authorised'], 'layer'); en(layer.scope, ['owner', 'project', 'worker', 'mission', 'stage'], 'layer.scope');
      if (layer.authorised !== undefined) bool(layer.authorised, 'layer.authorised');
    }
    const next = mergeConfig(value, patch ?? {}); validateConfig(next);
    if (wrapped && layer.scope !== 'owner' && layer.authorised !== true) assertAttenuation(value, next);
    value = next;
  }
  return validateConfig(value);
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function policyHash(config) { validateConfig(config); return createHash('sha256').update(canonical(config)).digest('hex'); }

/** Migrations are explicit; future/unknown versions fail without changing the original file. */
export function migrateConfig(input) {
  object(input, 'configuration');
  if (input.version !== CONFIG_VERSION) throw new Error(`Unsupported ULTRA configuration version ${String(input.version)}. Keep the original file and migrate explicitly.`);
  return resolveConfig(input);
}
