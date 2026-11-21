import path from 'node:path';
import { DEFAULT_CONFIG, ROLES, REVIEW_ROLES, modeFlags, policyHash, validateConfig, validatePermissions } from './config.mjs';
import { assessRisk } from './risk.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const clone = value => structuredClone(value);
const knownModel = (config, id) => own(config.models, id) ? { model: id, ...config.models[id], rank: config.models[id].rank ?? config.families[config.models[id].family] } : null;
const review = role => REVIEW_ROLES.includes(role);
const readTools = new Set(['Read', 'read_file', 'list_files', 'read', 'list', 'project_read', 'project_list', 'search', 'search_files']);
const emptyPermissions = () => ({ recruit: { lower: false, equal: false, higher: false }, reviewHigher: false, tools: [], roots: [] });

function inside(child, root) {
  if (typeof child !== 'string' || typeof root !== 'string' || child.includes('\0') || root.includes('\0')) return false;
  const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(root);
  const api = windows ? path.win32 : path.posix;
  if (!api.isAbsolute(child) || !api.isAbsolute(root)) return false;
  const rel = api.relative(api.resolve(root), api.resolve(child));
  return rel === '' || (!rel.startsWith(`..${api.sep}`) && rel !== '..' && !api.isAbsolute(rel));
}

/** This lexical attenuation is followed by canonical/reparse-point validation at the tool boundary. */
export function intersectPermissions(...ceilings) {
  const values = ceilings.filter(Boolean);
  if (!values.length) return emptyPermissions();
  values.forEach(value => validatePermissions(value));
  const result = clone(values[0]);
  for (const value of values.slice(1)) {
    for (const key of ['lower', 'equal', 'higher']) result.recruit[key] &&= value.recruit[key];
    result.reviewHigher &&= value.reviewHigher;
    result.tools = result.tools.filter(tool => value.tools.includes(tool));
    // Preserve the narrower of overlapping root scopes, even on a non-Windows host.
    result.roots = [...new Set(result.roots.flatMap(root => value.roots.flatMap(other => inside(root, other) ? [root] : inside(other, root) ? [other] : [])))];
  }
  return result;
}

function exceeds(requested, ceiling) {
  for (const key of ['lower', 'equal', 'higher']) if (requested.recruit[key] && !ceiling.recruit[key]) return `Recruitment privilege ${key} exceeds inherited authority.`;
  if (requested.reviewHigher && !ceiling.reviewHigher) return 'Review-only escalation exceeds inherited authority.';
  if (requested.tools.some(tool => !ceiling.tools.includes(tool))) return 'Requested tool permission exceeds inherited authority.';
  if (requested.roots.some(root => !ceiling.roots.some(allowed => inside(root, allowed)))) return 'Requested project scope exceeds inherited authority.';
  return null;
}

function mergePermissions(base, requested) {
  if (!requested) return clone(base);
  if (typeof requested !== 'object' || Array.isArray(requested)) throw new Error('Requested permissions must be an object.');
  for (const key of Object.keys(requested)) if (!['recruit', 'reviewHigher', 'tools', 'roots'].includes(key)) throw new Error(`Unknown requested permission ${key}.`);
  const value = { ...clone(base), ...clone(requested), recruit: { ...base.recruit, ...(requested.recruit ?? {}) } };
  validatePermissions(value); return value;
}

/** Trusted identity is supplied by an adapter; model text from a tool caller is never evidence. */
export function orchestratorIdentity(config, mission = {}, now = Date.now()) {
  const identity = mission.orchestrator;
  if (identity?.trusted === true && own(config.authority.profiles, identity.model)) {
    return { model: identity.model, trusted: true, source: identity.source ?? 'trusted-host', profile: clone(config.authority.profiles[identity.model]) };
  }
  const configured = config.authority.configuredIdentity;
  if (configured && Date.parse(configured.expiresAt) > now) return {
    model: configured.model, trusted: true, source: 'owner-configuration', authorisedBy: configured.authorisedBy, expiresAt: configured.expiresAt,
    profile: clone(config.authority.profiles[configured.model]),
  };
  return { model: 'unknown', trusted: false, source: 'unverified', profile: clone(config.authority.profiles[config.authority.unknownProfile]) };
}

function ruleMatches(when, context) {
  const comparisons = {
    modes: context.mode, parentFamilies: context.parentFamily, parentModels: context.parentModel,
    childFamilies: context.childFamily, childModels: context.childModel, purposes: context.role,
    complexities: context.risk.complexity, impacts: context.risk.effectiveImpact, verifiabilities: context.risk.verifiability,
    keyTransitions: `${context.parentKey}->${context.childKey}`,
  };
  for (const [field, value] of Object.entries(comparisons)) if (when[field] && !when[field].includes(value)) return false;
  if (when.toolsAny && !context.tools.some(tool => when.toolsAny.includes(tool))) return false;
  const metrics = { Usd: context.usd, Tokens: context.tokens, Agents: context.agents, Concurrency: context.concurrency, Depth: context.depth };
  for (const [suffix, value] of Object.entries(metrics)) {
    if (own(when, `minimum${suffix}`) && (!Number.isFinite(value) || value < when[`minimum${suffix}`])) return false;
    if (own(when, `maximum${suffix}`) && (!Number.isFinite(value) || value > when[`maximum${suffix}`])) return false;
  }
  if (own(when, 'confidenceBelow') && context.risk.confidence >= when.confidenceBelow) return false;
  return true;
}

function approval(authority, reason, extra = {}) {
  return { authority, scope: 'recruitment', mandatory: true, veto: true, priority: authority === 'user' ? 1000 : authority === 'helicop-astra' ? 100 : 50, reason, ...extra };
}

/** Pure admission decision. Quota reservation and one-use approval consumption remain atomic in the broker. */
export function evaluateRecruitment({ config = DEFAULT_CONFIG, parent, request, mission = {}, now = Date.now() }) {
  validateConfig(config);
  const hash = policyHash(config);
  const reasons = [], trace = [], requiredApprovals = [];
  const finish = (decision, extra = {}) => ({ allowed: decision === 'APPROVE', decision, reasons, requiredApprovals,
    approvalCombination: config.helicop.combination, policyVersion: config.version, policyHash: hash, trace, ...extra });
  const reject = reason => { reasons.push(reason); return finish('REJECT'); };
  if (!config.enabled) return reject('ULTRA is disabled; existing workers remain unchanged.');
  if (!parent || !request || typeof request !== 'object' || Array.isArray(request)) return reject('Recruitment requires a recorded parent and structured request.');
  const root = parent.id === mission.rootAgentId && parent.role === 'orchestrator';
  if (parent.role === 'orchestrator' && !root) return reject('Unverified root lineage.');
  if (!root && (!parent.id || !parent.permissions || !parent.model || !parent.family)) return reject('Parent lacks verified lineage, model or inherited authority.');
  if (['supervisor', 'judge'].includes(parent.role)) return reject('Approval reviewers cannot recursively recruit decision-makers or workers.');
  const role = request.role ?? 'implementation';
  if (!ROLES.includes(role)) return reject(`Unknown agent role ${String(role)}.`);
  if (review(parent.role) && !review(role)) return reject('Review workers cannot recruit implementation through protected review authority; the workflow controller must allocate Core rework.');
  if (!own(config.workers, request.worker)) return reject(`Unknown worker ${String(request.worker)}; explicit owner classification is required.`);
  const worker = config.workers[request.worker];
  const selectedModel = request.model ?? worker.model;
  if (selectedModel !== worker.model) return reject('Requested model differs from the configured worker model; silent substitution is prohibited.');
  const childModel = knownModel(config, selectedModel);
  const parentModel = root ? null : knownModel(config, parent.model);
  if (!childModel || (!root && (!parentModel || parentModel.family !== parent.family))) return reject('Unclassified model identity fails closed.');
  if (request.keyProfile !== undefined && request.keyProfile !== worker.keyProfile) return reject('Requested key profile differs from the fixed worker key route.');
  if (request.serviceTier !== undefined && request.serviceTier !== worker.serviceTier) return reject('Requested service tier differs from the configured worker service tier.');
  const pool = review(role) ? 'review' : 'core';
  let risk;
  try { risk = assessRisk(request.risk ?? {}, config.risk); } catch (error) { return reject(error.message); }
  const mode = request.mode ?? parent.mode ?? mission.recruitmentMode ?? config.recruitment.mode;
  const childMode = request.mode ?? mission.recruitmentMode ?? worker.mode ?? mode;
  let flags, childFlags;
  try { flags = modeFlags(mode, config.recruitment.custom); childFlags = modeFlags(childMode, config.recruitment.custom); } catch (error) { return reject(error.message); }
  let inherited;
  try { inherited = intersectPermissions(config.permissions, parent.permissions, mission.permissions); } catch (error) { return reject(error.message); }
  const parentFlags = root ? inherited.recruit : { ...inherited.recruit };
  const effectiveModeFlags = Object.fromEntries(Object.keys(flags).map(key => [key, flags[key] && parentFlags[key]]));
  const relation = root ? 'root' : childModel.rank < parentModel.rank ? 'lower' : childModel.rank > parentModel.rank ? 'higher' : 'equal';
  const reviewException = !root && relation === 'higher' && review(role) && inherited.reviewHigher && config.recruitment.reviewHigher;
  if (!root && !effectiveModeFlags[relation] && !reviewException) return reject(`${mode} and inherited permissions prohibit ${relation}-tier ${role} recruitment.`);
  if (!root && request.mode && Object.keys(flags).some(key => flags[key] && !parentFlags[key])) {
    return reject('Descendant mode attempts to expand its inherited recruitment ceiling. Use an authorised scoped promotion.');
  }
  const childCeiling = Object.fromEntries(Object.keys(effectiveModeFlags).map(k => [k, effectiveModeFlags[k] && childFlags[k]]));
  const ceiling = { ...inherited, recruit: childCeiling, reviewHigher: inherited.reviewHigher && config.recruitment.reviewHigher };
  if (review(role)) ceiling.tools = ceiling.tools.filter(tool => readTools.has(tool));
  let effectivePermissions;
  try {
    const configured = worker.permissions ? intersectPermissions(ceiling, worker.permissions) : ceiling;
    const requested = mergePermissions(configured, request.permissions);
    const excessive = exceeds(requested, configured);
    if (excessive) return reject(excessive);
    effectivePermissions = requested;
  } catch (error) { return reject(error.message); }
  if (review(role)) {
    if (effectivePermissions.tools.some(tool => !readTools.has(tool))) return reject('Review allocations are read-only. Authorised implementation rework belongs to Core.');
    // Review follow-ups are requests to the controller, never an independent fleet.
    effectivePermissions.recruit = { lower: false, equal: false, higher: false };
    effectivePermissions.reviewHigher = false;
  }
  // A one-time review exception grants no general higher-tier recruitment to the child.
  if (reviewException) { effectivePermissions.recruit.higher = false; trace.push('Used scoped review-only higher-tier exception; ordinary recruitment remains bounded.'); }
  const budget = request.budget ?? {};
  for (const key of ['tokens', 'usd']) if (budget[key] !== undefined && (typeof budget[key] !== 'number' || !Number.isFinite(budget[key]) || budget[key] < 0)) return reject(`Invalid requested ${key} budget.`);
  if (budget.tokens !== undefined && !Number.isInteger(budget.tokens)) return reject('Requested token budget must be an integer.');
  const depth = (parent.depth?.[pool] ?? 0) + 1;
  if (depth > config.fleets[pool].maxDepth) return reject(`${pool} recruitment depth would exceed ${config.fleets[pool].maxDepth}.`);
  const identity = orchestratorIdentity(config, mission, now);
  const authority = identity.profile;
  if (authority.restrictedFamilies.includes(childModel.family)) {
    if (!authority.supervisor) return reject(`${identity.model} has no authority configured for restricted recruitment.`);
    requiredApprovals.push(approval(authority.supervisor,
      identity.model === 'haiku' ? 'Haiku defers restricted recruitment decisions to Sol.' : identity.model === 'sonnet' ? 'Sonnet requires Sol consultation and configured final authority.' : 'Unverified or restricted orchestrator requires independent authority.',
      { id: 'orchestrator-authority', finalAuthority: authority.final, decisionMaker: identity.model === 'haiku' }));
    if (!authority.final) {
      if (!identity.trusted) return reject('An unverified orchestrator cannot accept final authority after advisory consultation.');
      const consultation = requiredApprovals.at(-1); consultation.consultation = true; consultation.veto = false;
      requiredApprovals.push(approval('trusted-orchestrator', 'Owner configured supervisor consultation with a separate final orchestrator decision.', { id: 'orchestrator-final' }));
    }
  }
  const context = { mode, parentFamily: parentModel?.family, parentModel: parent.model, childFamily: childModel.family, childModel: childModel.model,
    role, risk, tools: effectivePermissions.tools, parentKey: parent.keyProfile, childKey: worker.keyProfile,
    usd: budget.usd, tokens: budget.tokens, depth, agents: mission.agentCount ?? 0, concurrency: mission.runningCount ?? 0 };
  for (const rule of config.helicop.rules) {
    if (!rule.enabled || !ruleMatches(rule.when, context)) continue;
    if (rule.authority === 'helicop-sol' && !config.helicop.sol) continue;
    if (rule.authority === 'helicop-astra' && !config.helicop.astra) continue;
    requiredApprovals.push(approval(rule.authority, `Matched HELICOP rule ${rule.id}.`, { id: rule.id, mandatory: rule.mandatory, veto: rule.veto, priority: rule.priority }));
  }
  if (risk.uncertain) requiredApprovals.push(approval(config.risk.uncertainAuthority, 'Uncertain impact or verification requires scrutiny.', { id: 'risk-uncertainty' }));
  if (risk.highImpact && config.risk.requireHighRecruitmentApproval) requiredApprovals.push(approval(config.risk.highAuthority, 'Configured high-impact recruitment gate.', { id: 'risk-high-impact' }));
  const selection = parent.reviewerPolicy?.selection ?? config.review.selection;
  if (review(role) && !['supervisor', 'judge'].includes(role)) {
    if (selection === 'C') requiredApprovals.push(approval('helicop-sol', 'Policy C reviewer recommendation requires authorised supervisor selection.', { id: 'reviewer-selection' }));
    else if (!root) {
      const expected = role === 'second_opinion' ? config.review.secondOpinion : role === 'gap_inspector' ? config.review.gapInspector : parent.reviewerPolicy?.reviewer ?? config.review.primary;
      if (request.worker !== expected) return reject('Policy B review must use the reviewer preauthorised with the implementation allocation.');
    }
  }
  if (parent.keyProfile === 'free' && worker.keyProfile === 'standard') {
    const transition = config.freeToPaid;
    const knownBudget = Number.isFinite(budget.tokens) && Number.isFinite(budget.usd);
    const over = !knownBudget || budget.tokens > transition.maxTokensWithoutApproval || budget.usd > transition.maxUsdWithoutApproval;
    if (transition.policy === 'C' || (transition.policy === 'B' && over)) requiredApprovals.push(approval(transition.policy === 'C' ? 'user' : transition.authority,
      `Free-to-paid policy ${transition.policy} requires approval${knownBudget ? '' : ' because the cost estimate is unknown'}.`, { id: 'free-to-paid' }));
    if (transition.policy === 'A' && (!Number.isFinite(config.mission.maxUsd) || !knownBudget)) return reject('Free-to-paid A requires an explicit mission budget and known request estimate.');
  }
  for (const requirement of requiredApprovals) {
    // Disabling a helicopter never erases independent identity/risk/transition requirements.
    const enabled = requirement.authority === 'user' || requirement.authority === 'trusted-orchestrator' && identity.trusted || requirement.authority === 'helicop-sol' && config.helicop.sol || requirement.authority === 'helicop-astra' && config.helicop.astra;
    if (!enabled) return reject(`Required authority ${requirement.authority} is unavailable; its approval cannot be bypassed.`);
  }
  const allocation = { pool, role, worker: request.worker, model: childModel.model, family: childModel.family, rank: childModel.rank,
    keyProfile: worker.keyProfile, serviceTier: worker.serviceTier, mode: childMode, recruitmentMode: mode, relation, reviewException, effectivePermissions, risk, depth,
    orchestrator: { model: identity.model, trusted: identity.trusted, source: identity.source }, budget: clone(budget) };
  trace.push(`Worker ${request.worker} resolves to exact model ${childModel.model}, family ${childModel.family}, ${worker.keyProfile} key.`);
  trace.push(`Recruitment ${relation} relationship is ${reviewException ? 'review-only authorised' : 'within inherited mode authority'}; ${role} uses ${pool} capacity.`);
  trace.push(`Implementation complexity ${risk.complexity}; effective failure impact ${risk.effectiveImpact}; verification ${risk.verifiability}.`);
  reasons.push(requiredApprovals.length ? 'Recruitment awaits all applicable independent authority requirements.' : 'Recruitment is within model, role, permission and policy ceilings.');
  return finish(requiredApprovals.length ? 'PENDING' : 'APPROVE', allocation);
}

/** Resolve authenticated, request-bound decisions supplied by the durable approval engine. */
export function combineApprovals(requirements, decisions, combination = 'AND') {
  if (!['AND', 'OR', 'veto', 'prioritised', 'escalation'].includes(combination)) throw new Error('Unknown approval combination.');
  const records = requirements.map(requirement => {
    const original = decisions.find(d => d.authority === requirement.authority && (!d.requirementId || d.requirementId === requirement.id));
    const decision = requirement.consultation && original && ['APPROVE', 'REJECT', 'MODIFY', 'ESCALATE'].includes(original.decision) ? { ...original, decision: 'APPROVE' } : original;
    return { requirement, decision };
  });
  if (!records.length) return { decision: 'APPROVE', reasons: ['No independent approval is required.'] };
  const veto = records.find(({ requirement, decision }) => decision?.decision === 'REJECT' && (requirement.veto || requirement.mandatory));
  if (veto) return { decision: 'REJECT', reasons: [`${veto.requirement.authority} rejected a mandatory/veto gate.`] };
  const invalid = records.find(({ decision }) => decision && !['APPROVE', 'REJECT', 'MODIFY', 'ESCALATE'].includes(decision.decision));
  if (invalid) return { decision: 'REJECT', reasons: ['Malformed authority decision.'] };
  const modification = records.find(({ decision }) => decision?.decision === 'MODIFY');
  if (modification) return { decision: 'MODIFY', reasons: ['Modified proposals must be revalidated against all governing permissions.'], modification: clone(modification.decision.modification ?? {}) };
  if (records.some(({ decision }) => decision?.decision === 'ESCALATE')) return { decision: 'ESCALATE', reasons: ['An authority explicitly requires escalation.'] };
  if (records.some(({ requirement, decision }) => requirement.mandatory && decision?.decision !== 'APPROVE')) return { decision: 'PENDING', reasons: ['A mandatory authority has not approved.'] };
  const optional = records.filter(({ requirement }) => !requirement.mandatory);
  if (!optional.length) return { decision: 'APPROVE', reasons: ['All mandatory authorities approved.'] };
  if (combination === 'prioritised') {
    const priority = Math.max(...optional.map(({ requirement }) => requirement.priority ?? 0));
    const highest = optional.filter(({ requirement }) => (requirement.priority ?? 0) === priority);
    if (highest.some(({ decision }) => decision?.decision === 'REJECT')) return { decision: 'REJECT', reasons: ['Highest-priority authority rejected.'] };
    return { decision: highest.every(({ decision }) => decision?.decision === 'APPROVE') ? 'APPROVE' : 'PENDING', reasons: ['Highest-priority authorities determine optional gates.'] };
  }
  if (combination === 'OR') {
    if (optional.some(({ decision }) => decision?.decision === 'APPROVE')) return { decision: 'APPROVE', reasons: ['An eligible optional authority approved; mandatory gates also passed.'] };
    return { decision: optional.every(({ decision }) => decision?.decision === 'REJECT') ? 'REJECT' : 'PENDING', reasons: ['No optional authority has approved.'] };
  }
  if (optional.some(({ decision }) => decision?.decision === 'REJECT')) return { decision: combination === 'escalation' ? 'ESCALATE' : 'REJECT', reasons: ['Authorities disagree or reject.'] };
  return { decision: optional.every(({ decision }) => decision?.decision === 'APPROVE') ? 'APPROVE' : 'PENDING', reasons: ['All applicable authorities must respond before admission.'] };
}
