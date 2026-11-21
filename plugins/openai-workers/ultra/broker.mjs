import { randomUUID } from 'node:crypto';
import { resolveConfig, evaluateRecruitment, policyHash } from './policy-api.mjs';
import { combineApprovals, orchestratorIdentity } from './policy.mjs';
import { assessRisk, riskInput } from './risk.mjs';
import { clone, digest, invariant } from './store.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const reviewRoles = new Set(['reviewer', 'second_opinion', 'gap_inspector', 'judge', 'supervisor']);
const privilegedRoles = new Set(['judge', 'supervisor']);
const positive = (v, label, fallback) => { const n = v ?? fallback; invariant(Number.isFinite(n) && n >= 0, `Invalid ${label}`); return n; };
const missionOf = (state, id) => { invariant(Object.hasOwn(state.missions, id), 'Unknown mission'); return state.missions[id]; };
const nodeOf = (m, id) => { invariant(Object.hasOwn(m.nodes, id), 'Unknown agent'); return m.nodes[id]; };
const budgetFor = r => ({ tokens: positive(r.budget?.tokens, 'token allocation', 40000), usd: positive(r.budget?.usd, 'USD allocation', 4) });
function accounted(m) {
  return Object.values(m.nodes).reduce((a, n) => ({
    tokens: a.tokens + (n.usage?.tokens ?? 0) + (n.reservation?.tokens ?? 0),
    usd: a.usd + (n.usage?.usd ?? 0) + (n.reservation?.usd ?? 0),
  }), { tokens: 0, usd: 0 });
}
/** Recheck shared ceilings before every new POST, including already allocated peers. */
export function assertApiAdmission(m, n, now = Date.now()) {
  invariant(m.status === 'active' && n.status === 'running', 'Mission/agent is not active');
  const limits = m.config.mission, total = accounted(m);
  invariant(limits.maxWallMs == null || now - m.createdAt < limits.maxWallMs, 'Mission wall-clock budget exhausted');
  invariant(limits.maxTokens == null || total.tokens <= limits.maxTokens, 'Shared mission token budget exhausted');
  invariant(limits.maxUsd == null || total.usd <= limits.maxUsd, 'Shared mission USD budget exhausted');
  for (const [kind, value] of [['perKey', n.keyProfile], ['perModel', n.model]]) {
    const cap = limits[kind]?.[value]; if (!cap) continue;
    const peers = Object.values(m.nodes).filter(p => kind === 'perKey' ? p.keyProfile === value : p.model === value);
    const tokens = peers.reduce((sum, p) => sum + p.usage.tokens + p.reservation.tokens, 0);
    const usd = peers.reduce((sum, p) => sum + p.usage.usd + p.reservation.usd, 0);
    invariant(cap.maxTokens == null || tokens <= cap.maxTokens, `${kind} token ceiling exhausted`);
    invariant(cap.maxUsd == null || usd <= cap.maxUsd, `${kind} USD ceiling exhausted`);
  }
}
function ceiling(m, budget, now) {
  const limits = m.config.mission, spent = accounted(m);
  invariant(!limits.maxWallMs || now - m.createdAt < limits.maxWallMs, 'Mission wall-clock budget exhausted');
  invariant(limits.maxTokens == null || spent.tokens + budget.tokens <= limits.maxTokens, 'Shared mission token budget exhausted');
  invariant(limits.maxUsd == null || spent.usd + budget.usd <= limits.maxUsd, 'Shared mission USD budget exhausted');
  invariant(Object.keys(m.nodes).length - 1 < (limits.maxJobs ?? Infinity), 'Mission job limit exhausted');
}
function independent(m, candidate, author) {
  if (!candidate || !author) return true;
  if (author === m.rootAgentId) return candidate !== author;
  for (let n = m.nodes[candidate]; n; n = m.nodes[n.parentId]) if (n.id === author) return false;
  return candidate !== author;
}
function refreshWaiting(m, event) {
  for (const parent of Object.values(m.nodes).filter(p => p.status === 'waiting')) {
    if (parent.waitingFor.every(id => terminal.has(m.nodes[id].status))) { parent.status = 'queued'; event('agent.resumed', m.id, { id: parent.id }); }
  }
}

/** Durable admission owns every population/depth/budget change, across all interfaces. */
export class RecruitmentBroker {
  constructor(store, { config = {}, now = () => Date.now() } = {}) { this.store = store; this.config = resolveConfig(config); this.now = now; }
  async createMission({ id = randomUUID(), task, orchestrator = { model: 'unknown', trusted: false }, config, rootPermissions, surface = 'internal' } = {}) {
    invariant(typeof task === 'string' && task.trim() && task.length <= 100000, 'A bounded mission task is required');
    invariant(/^[a-zA-Z0-9_-]{1,100}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id), 'Invalid mission ID');
    const resolved = config ? resolveConfig(this.config, config) : clone(this.config);
    invariant(resolved.enabled, 'ULTRA is disabled; explicitly enable it in owner configuration');
    const policy = policyHash(resolved);
    return this.store.transaction((state, event) => {
      if (Object.hasOwn(state.missions, id)) { invariant(state.missions[id].task === task && state.missions[id].policyHash === policy && state.missions[id].surface === surface && digest(state.missions[id].orchestrator) === digest(orchestrator), 'Mission ID already used for different work or authority'); return state.missions[id]; }
      const permissions = clone(resolved.permissions);
      if (rootPermissions) {
        for (const k of ['lower', 'equal', 'higher']) permissions.recruit[k] &&= rootPermissions.recruit?.[k] ?? false;
        permissions.reviewHigher &&= rootPermissions.reviewHigher ?? false;
        permissions.tools = permissions.tools.filter(x => rootPermissions.tools?.includes(x));
        permissions.roots = permissions.roots.filter(x => rootPermissions.roots?.includes(x));
      }
      const m = { id, task, surface, policyHash: policy, config: resolved, createdAt: this.now(), status: 'active',
        orchestrator: clone(orchestrator), rootAgentId: 'root', nodes: {}, requests: {}, approvals: {}, idempotency: {}, workflows: {}, actions: {}, promotions: {}, plans: {}, apiRequests: [] };
      m.nodes.root = { id: 'root', missionId: id, parentId: null, role: 'orchestrator', model: orchestrator.model,
        permissions, depth: { core: 0, review: 0 }, status: 'running', pool: null, usage: { tokens: 0, usd: 0 }, reservation: { tokens: 0, usd: 0 } };
      state.missions[id] = m; event('mission.created', id, { task, policyHash: policy, orchestrator }); return m;
    });
  }
  async request(missionId, parentId, proposal, idempotencyKey, context = {}) {
    invariant(typeof idempotencyKey === 'string' && idempotencyKey.length > 0 && idempotencyKey.length <= 200, 'A bounded idempotency key is required');
    invariant(proposal && typeof proposal === 'object' && JSON.stringify(proposal).length <= 200000, 'Invalid recruitment proposal');
    const inputHash = digest({ parentId, proposal, context }), key = digest({ parentId, idempotencyKey });
    return this.store.transaction((state, event) => {
      const m = missionOf(state, missionId), parent = nodeOf(m, parentId);
      if (m.idempotency[key]) { invariant(m.idempotency[key].hash === inputHash, 'Idempotency key reused for different work'); return m.requests[m.idempotency[key].requestId]; }
      invariant(m.status === 'active', 'Mission is not active');
      invariant(!terminal.has(parent.status), 'Parent agent is no longer active');
      invariant(!privilegedRoles.has(parent.role), 'Approval reviewers cannot recruit approval chains or implementation workers');
      const outstanding = Object.values(m.requests).filter(r => ['pending', 'queued', 'running'].includes(r.status)).length;
      invariant(outstanding < (m.config.mission.maxOutstanding ?? 32), 'Outstanding recruitment limit exhausted');
      const request = clone(proposal);
      invariant(typeof request.task === 'string' && request.task.trim(), 'Child task is required');
      request.budget = budgetFor(request);
      const reviewerPolicy = clone(context.reviewerPolicy ?? { selection: m.config.review.selection, primary: m.config.review.primary });
      invariant(Object.keys(reviewerPolicy).every(k => ['selection', 'primary'].includes(k)) && ['B', 'C'].includes(reviewerPolicy.selection) && Object.hasOwn(m.config.workers, reviewerPolicy.primary), 'Invalid task reviewer policy');
      if (context.reviewerPolicy) {
        const predecessor = context.predecessorId && m.requests[context.predecessorId];
        invariant(predecessor && predecessor.parentId === parentId && digest(predecessor.reviewerPolicy) === digest(reviewerPolicy) || parentId === m.rootAgentId && orchestratorIdentity(m.config, m, this.now()).trusted, 'Task reviewer selection requires the trusted root orchestrator');
        invariant(m.config.review.selection !== 'C' || reviewerPolicy.selection === 'C', 'Task selection cannot bypass mandatory mission Policy C');
      }
      const effectiveParent = this.promotedParent(m, parent, request);
      if (context.originId) { invariant(parentId === m.rootAgentId, 'Controller origin is only valid on root assignments'); effectiveParent.keyProfile = nodeOf(m, context.originId).keyProfile; }
      const evaluation = evaluateRecruitment({ config: m.config, parent: effectiveParent, request, mission: this.policyContext(m), now: this.now() });
      if (request.promotionId && evaluation.effectivePermissions) {
        // A one-request promotion never becomes inherited authority for descendants.
        for (const relation of ['lower', 'equal', 'higher']) evaluation.effectivePermissions.recruit[relation] &&= parent.permissions.recruit[relation];
        evaluation.effectivePermissions.reviewHigher &&= parent.permissions.reviewHigher;
      }
      const record = { id: randomUUID(), missionId, parentId, proposal: request, inputHash, policyHash: m.policyHash,
        evaluation, reviewerPolicy, originId: context.originId ?? null, gapReuseAuthorId: context.gapReuseAuthorId ?? null, protectedAuthority: context.protectedAuthority ?? null, binding: clone(context.binding ?? {}), createdAt: this.now(), status: evaluation.decision === 'REJECT' ? 'rejected' : 'pending', approvals: [], nodeId: null, revisions: 0 };
      if (record.protectedAuthority) invariant(parentId === m.rootAgentId && privilegedRoles.has(request.role) && m.nodes.root.permissions.reviewHigher, 'Protected controller allocation exceeds root authority');
      m.requests[record.id] = record; m.idempotency[key] = { hash: inputHash, requestId: record.id };
      event('recruitment.evaluated', missionId, record);
      if (request.planId && evaluation.decision !== 'REJECT') this.consumePlan(m, record, event);
      const approvedByPlan = record.approvals.length && combineApprovals(evaluation.requiredApprovals, record.approvals.map(id => m.approvals[id]), evaluation.approvalCombination).decision === 'APPROVE';
      if (evaluation.decision === 'APPROVE' || approvedByPlan) this.allocate(m, record, event);
      if (context.predecessorId) {
        const previous = m.requests[context.predecessorId];
        invariant(previous && ['revising', 'escalating'].includes(previous.status) && previous.parentId === parentId && !previous.successor, 'Revision predecessor is no longer available');
        record.revisions = previous.revisions + 1;
        previous.status = previous.status === 'escalating' ? 'escalated_reissued' : 'revised'; previous.successor = record.id;
        for (const workflow of Object.values(m.workflows)) for (const assignment of workflow.assignments.filter(a => a.requestId === previous.id)) {
          invariant(request.role === assignment.role && digest(request.evidence) === digest(previous.proposal.evidence) && request.task === previous.proposal.task, 'A revised workflow allocation cannot substitute role, source or review scope');
          assignment.priorRequestIds ??= []; assignment.priorRequestIds.push(previous.id);
          assignment.requestId = record.id; assignment.nodeId = record.nodeId; assignment.worker = request.worker;
          event('review.assignment_rebound', missionId, { workflowId: workflow.id, previous: previous.id, successor: record.id, role: assignment.role });
        }
        event('recruitment.successor', missionId, { previous: previous.id, successor: record.id, status: previous.status });
      }
      return record;
    });
  }
  async grantPlan(missionId, grant, principal) {
    return this.store.transaction((state, event) => {
      const m = missionOf(state, missionId), parent = nodeOf(m, grant.parentId ?? m.rootAgentId);
      invariant(principal?.trusted && principal.source === 'local-user' && principal.authority === 'user', 'Future recruitment plans require explicit owner authority');
      invariant(grant.acknowledgeFutureRecruitment === true, 'Plan approval authorises future recruitment without inspecting every spawn; explicit acknowledgement required');
      invariant(Array.isArray(grant.workers) && grant.workers.length && grant.workers.every(w => Object.hasOwn(m.config.workers, w)), 'Plan needs exact classified workers');
      invariant(Array.isArray(grant.roles) && grant.roles.length && grant.roles.every(r => ['implementation', 'exploration', 'reviewer', 'second_opinion', 'gap_inspector', 'reworker'].includes(r)), 'Plan needs explicit non-supervisory roles');
      invariant(Number.isInteger(grant.maxInvocations) && grant.maxInvocations > 0 && grant.maxInvocations <= 100, 'Invalid plan population bound');
      const budget = budgetFor(grant); invariant(budget.tokens > 0 && budget.usd > 0, 'Plan needs positive shared token and USD limits');
      const tools = grant.tools ?? [], roots = grant.roots ?? [];
      invariant(Array.isArray(tools) && tools.every(x => parent.permissions.tools.includes(x)) && Array.isArray(roots) && roots.every(x => parent.permissions.roots.includes(x)), 'Plan tool/root ceiling exceeds parent authority');
      const plan = { id: randomUUID(), parentId: parent.id, workers: clone(grant.workers), roles: clone(grant.roles), tools: clone(tools), roots: clone(roots),
        remaining: grant.maxInvocations, remainingBudget: budget, policyHash: m.policyHash, expiresAt: this.now() + Math.min(86400000, positive(grant.ttlMs, 'plan expiry', 3600000)),
        principal: clone(principal), requests: [], warning: 'Authorises bounded future recruitment without inspecting every individual spawn. Tool, supervisor, execution and shared mission gates remain binding.' };
      m.plans[plan.id] = plan; event('approval.plan_granted', missionId, plan); return plan;
    });
  }
  consumePlan(m, r, event) {
    const p = m.plans[r.proposal.planId];
    invariant(p && p.policyHash === m.policyHash && p.expiresAt > this.now() && p.parentId === r.parentId && p.remaining > 0, 'Recruitment plan is absent, expired, exhausted or belongs to another parent');
    invariant(p.workers.includes(r.proposal.worker) && p.roles.includes(r.proposal.role ?? 'implementation'), 'Recruitment is outside approved plan worker/purpose scope');
    invariant(r.evaluation.effectivePermissions.tools.every(x => p.tools.includes(x)) && r.evaluation.effectivePermissions.roots.every(x => p.roots.includes(x)), 'Recruitment exceeds approved plan capabilities');
    invariant(r.proposal.budget.tokens <= p.remainingBudget.tokens && r.proposal.budget.usd <= p.remainingBudget.usd, 'Recruitment plan budget exhausted');
    p.remaining--; p.remainingBudget.tokens -= r.proposal.budget.tokens; p.remainingBudget.usd -= r.proposal.budget.usd; p.requests.push(r.id);
    if (r.evaluation.requiredApprovals.some(a => a.authority === 'user')) {
      const a = { id: randomUUID(), requestId: r.id, inputHash: r.inputHash, policyHash: m.policyHash, authority: 'user', principal: p.principal,
        decision: 'APPROVE', rationale: 'Explicit bounded owner plan', scope: 'recruitment', planId: p.id, createdAt: this.now(), expiresAt: p.expiresAt, consumed: true };
      m.approvals[a.id] = a; r.approvals.push(a.id);
    }
    event('approval.plan_consumed', m.id, { planId: p.id, requestId: r.id, remaining: p.remaining, budget: p.remainingBudget });
  }
  async decideBatch(missionId, requestIds, decision, principal) {
    invariant(Array.isArray(requestIds) && requestIds.length > 0 && requestIds.length <= 100 && new Set(requestIds).size === requestIds.length, 'Batch requires unique bounded request IDs');
    const m = await this.store.snapshot(missionId);
    invariant(requestIds.every(id => m.requests[id]?.status === 'pending'), 'Every batch item must be an existing pending request');
    const results = [];
    for (const id of requestIds) {
      try { const request = await this.decide(missionId, id, decision, principal); results.push({ requestId: id, status: request.status }); }
      catch (error) { results.push({ requestId: id, status: 'held', reason: error.message }); }
    }
    await this.store.transaction((state, event) => event('approval.batch_decided', missionId, { requestIds, results, principal })); return results;
  }
  allocate(m, record, event, { supervisor = false, authority = null } = {}) {
    invariant(!record.nodeId, 'Request already allocated');
    if (record.protectedAuthority) { supervisor = true; authority = record.protectedAuthority; }
    const parent = nodeOf(m, record.parentId), e = record.evaluation, r = record.proposal;
    const pool = supervisor ? 'review' : e.pool ?? (reviewRoles.has(r.role) ? 'review' : 'core');
    const limits = m.config.fleets[pool], depth = { ...parent.depth, [pool]: parent.depth[pool] + 1 };
    invariant(depth[pool] <= limits.maxDepth, `${pool} fleet depth limit exhausted`);
    invariant(Object.values(m.nodes).filter(n => n.pool === pool).length < limits.maxInvocations, `${pool} fleet invocation limit exhausted`);
    ceiling(m, r.budget, this.now());
    for (const [kind, value] of [['perKey', e.keyProfile], ['perModel', e.model]]) {
      const limit = m.config.mission[kind]?.[value]; if (!limit) continue;
      const matching = Object.values(m.nodes).filter(n => kind === 'perKey' ? n.keyProfile === value : n.model === value);
      const tokens = matching.reduce((sum, n) => sum + (n.usage?.tokens ?? 0) + (n.reservation?.tokens ?? 0), 0);
      const usd = matching.reduce((sum, n) => sum + (n.usage?.usd ?? 0) + (n.reservation?.usd ?? 0), 0);
      invariant(limit.maxTokens == null || tokens + r.budget.tokens <= limit.maxTokens, `${kind} token ceiling exhausted`);
      invariant(limit.maxUsd == null || usd + r.budget.usd <= limit.maxUsd, `${kind} USD ceiling exhausted`);
    }
    const node = { id: randomUUID(), missionId: m.id, parentId: parent.id, role: r.role ?? 'implementation', worker: r.worker,
      model: e.model, family: e.family, keyProfile: e.keyProfile, serviceTier: e.serviceTier ?? null, mode: e.mode ?? 'SWARM', pool, depth,
      task: r.task, risk: clone(e.risk ?? null), originId: record.originId ?? null, reviewerPolicy: { selection: record.reviewerPolicy?.selection ?? m.config.review.selection, reviewer: record.reviewerPolicy?.primary ?? m.config.review.primary }, permissions: clone(e.effectivePermissions), allocation: clone(r.budget), reservation: clone(r.budget),
      usage: { tokens: 0, usd: 0 }, status: 'queued', createdAt: this.now(), requestId: record.id,
      supervisor, authority, adapter: r.adapter === 'native' ? 'native' : 'runtime', rounds: 0, responseIds: [], results: [], attempts: [], lease: null };
    m.nodes[node.id] = node; record.nodeId = node.id; record.status = 'queued';
    for (const key of ['selectsWorkflow', 'judgesAction']) if (record.binding?.[key]) node[key] = record.binding[key];
    if (record.gapReuseAuthorId) {
      const author = nodeOf(m, record.gapReuseAuthorId);
      invariant(node.role === 'gap_inspector' && author.status === 'completed' && author.worker === node.worker, 'Author-context reuse requires a matching completed worker and read-only gap role');
      const responseId = author.runtime?.responseId ?? author.native?.lastResponseId;
      invariant(responseId && author.responseIds.includes(responseId), 'Original author has no verified provider conversation to reuse');
      node.runtime = { phase: 'ready', input: node.task, responseId, contextTokens: author.runtime?.contextTokens ?? author.native?.contextBound ?? author.usage.tokens, steps: 0, usage: { tokens: 0, usd: 0 }, reusedAuthorId: author.id };
    }
    if (r.promotionId) { const promotion = m.promotions[r.promotionId]; invariant(promotion && promotion.remaining > 0 && promotion.expiresAt > this.now(), 'Promotion expired or exhausted'); promotion.remaining--; }
    event('agent.allocated', m.id, node); return node;
  }
  async appointSupervisor(missionId, requestId, authority) {
    return this.store.transaction((state, event) => {
      const m = missionOf(state, missionId), r = m.requests[requestId];
      invariant(r?.status === 'pending', 'Approval request is not pending');
      const required = r.evaluation.requiredApprovals.find(a => a.authority === authority);
      invariant(required && authority !== 'user', 'No automatic supervisor for this authority');
      const previous = Object.values(m.nodes).find(n => n.supervises === requestId && n.authority === authority);
      if (previous) return previous;
      const worker = authority === 'helicop-astra' ? 'astra' : authority === 'helicop-sol' ? 'sol' : null;
      invariant(worker && m.config.workers[worker], 'Required supervisor is unavailable');
      const spec = m.config.workers[worker];
      const root = nodeOf(m, m.rootAgentId);
      invariant(root.permissions.reviewHigher, 'Root policy does not authorise supervisory escalation');
      const origin = nodeOf(m, r.originId ?? r.parentId), transition = m.config.freeToPaid;
      const paidGate = origin.keyProfile === 'free' && spec.keyProfile === 'standard' &&
        (transition.policy === 'C' || transition.policy === 'B' && (8000 > transition.maxTokensWithoutApproval || 2 > transition.maxUsdWithoutApproval));
      const paidAuthority = transition.policy === 'C' ? 'user' : transition.authority;
      if (paidGate && !r.approvals.some(id => m.approvals[id].authority === paidAuthority && m.approvals[id].decision === 'APPROVE' && m.approvals[id].expiresAt > this.now())) {
        // A paid approval call is itself paid recruitment, not a spending-policy exception.
        r.additionalRequirements ??= [];
        if (!r.additionalRequirements.some(a => a.id === 'supervisory-key-transition')) r.additionalRequirements.push({ id: 'supervisory-key-transition', authority: paidAuthority, mandatory: true, veto: true, priority: 1000, scope: 'recruitment', reason: 'Paid supervisory allocation requires free-to-paid authorisation' });
        r.evaluation.requiredApprovals = [...r.evaluation.requiredApprovals.filter(a => a.id !== 'supervisory-key-transition'), ...r.additionalRequirements];
        r.blockedReason = 'Awaiting authority before paid supervisory invocation';
        event('supervisor.spending_held', missionId, { requestId, authority: paidAuthority }); return { status: 'pending', reason: r.blockedReason };
      }
      const synthetic = { id: randomUUID(), parentId: root.id,
        proposal: { worker, role: 'supervisor', task: JSON.stringify({ requestId, request: r.proposal, evidence: r.evaluation, instruction: 'Return JSON: decision APPROVE, REJECT, MODIFY, or ESCALATE; rationale; optional modification. No delegation.' }), budget: { tokens: 8000, usd: 2 } },
        evaluation: { model: spec.model, family: spec.family, keyProfile: spec.keyProfile, serviceTier: spec.serviceTier, effectivePermissions: { recruit: { lower: false, equal: false, higher: false }, reviewHigher: false, tools: [], roots: [] } }, status: 'pending', approvals: [], policyHash: m.policyHash };
      m.requests[synthetic.id] = synthetic;
      const n = this.allocate(m, synthetic, event, { supervisor: true, authority }); n.supervises = requestId;
      event('supervisor.appointed', m.id, { nodeId: n.id, requestId, authority }); return n;
    });
  }
  async decide(missionId, requestId, decision, principal) {
    return this.store.transaction((state, event) => {
      const m = missionOf(state, missionId), r = m.requests[requestId];
      invariant(r?.status === 'pending', 'Approval request is not pending');
      invariant(['APPROVE', 'REJECT', 'MODIFY', 'ESCALATE'].includes(decision.decision), 'Invalid approval decision');
      invariant(principal?.trusted && ['local-user', 'native-host', 'supervisor'].includes(principal.source), 'Unverified approval authority');
      const required = r.evaluation.requiredApprovals.find(a => a.authority === principal.authority);
      invariant(required, 'Authority is not assigned to this decision');
      if (principal.source === 'supervisor') {
        const n = nodeOf(m, principal.nodeId);
        invariant(n.supervises === requestId && n.authority === principal.authority && n.role === 'supervisor', 'Supervisor scope mismatch');
        invariant(independent(m, n.id, r.parentId), 'An author or its descendant cannot approve itself');
      } else if (principal.source === 'local-user') invariant(principal.authority === 'user', 'Local user authority mismatch');
      else { const identity = orchestratorIdentity(m.config, m, this.now()); invariant(principal.authority === 'trusted-orchestrator' && identity.trusted && (identity.profile.authority === 'full' || identity.profile.final === false), 'Native orchestrator cannot impersonate independent/human authority'); }
      invariant(!r.approvals.some(id => m.approvals[id].authority === principal.authority), 'Authority already decided; submit a revised request');
      const a = { id: randomUUID(), requestId, inputHash: r.inputHash, policyHash: m.policyHash, authority: principal.authority,
        principal: clone(principal), decision: decision.decision, rationale: String(decision.rationale ?? '').slice(0, 20000),
        modification: decision.modification ? clone(decision.modification) : null, scope: 'recruitment', createdAt: this.now(), expiresAt: this.now() + Math.min(3600000, positive(decision.ttlMs, 'approval TTL', 900000)), consumed: false };
      m.approvals[a.id] = a; r.approvals.push(a.id); event('approval.decided', missionId, a);
      if (decision.decision === 'MODIFY' && !required.consultation) { r.status = 'modify'; return r; }
      if (decision.decision === 'ESCALATE' && !required.consultation) { r.status = 'escalated'; return r; }
      const votes = r.approvals.map(id => m.approvals[id]).filter(v => v.expiresAt > this.now());
      const freshParent = this.promotedParent(m, nodeOf(m, r.parentId), r.proposal);
      if (r.originId) freshParent.keyProfile = nodeOf(m, r.originId).keyProfile;
      const fresh = evaluateRecruitment({ config: m.config, parent: freshParent, request: r.proposal, mission: this.policyContext(m), now: this.now() });
      if (fresh.decision === 'REJECT') { r.status = 'rejected'; r.evaluation = fresh; return r; }
      // Dynamic agent-count, depth and concurrency rules are rechecked after votes.
      fresh.requiredApprovals.push(...(r.additionalRequirements ?? []));
      const requirements = fresh.requiredApprovals;
      const combination = r.evaluation.approvalCombination ?? 'AND';
      const combined = combineApprovals(requirements, votes, combination);
      if (combined.decision === 'REJECT') { r.status = m.config.helicop.denial === 'escalate' ? 'escalated' : 'rejected'; return r; }
      if (combined.decision === 'MODIFY') { r.status = 'modify'; r.modification = combined.modification; return r; }
      if (combined.decision === 'ESCALATE') { r.status = 'escalated'; return r; }
      if (combined.decision === 'APPROVE') {
        invariant(fresh.decision !== 'REJECT' && r.policyHash === m.policyHash, 'Approval no longer satisfies governing policy');
        r.evaluation = fresh;
        if (r.proposal.promotionId) for (const relation of ['lower', 'equal', 'higher']) r.evaluation.effectivePermissions.recruit[relation] &&= m.nodes[r.parentId].permissions.recruit[relation];
        this.allocate(m, r, event);
        for (const vote of votes) vote.consumed = true;
      } else r.evaluation = fresh;
      return r;
    });
  }
  policyContext(m) {
    return { ...m, agentCount: Object.keys(m.nodes).length - 1, runningCount: Object.values(m.nodes).filter(n => n.pool && n.status === 'running').length };
  }
  promotedParent(m, parent, request) {
    if (!request.promotionId) return clone(parent);
    const g = m.promotions[request.promotionId];
    invariant(g && g.nodeId === parent.id && g.remaining > 0 && g.expiresAt > this.now() && g.policyHash === m.policyHash, 'Promotion is absent, expired or exhausted');
    invariant(g.worker === request.worker && g.role === (request.role ?? 'implementation'), 'Promotion scope mismatch');
    const temporary = clone(parent);
    temporary.mode = 'SKYNET';
    for (const key of g.relations) temporary.permissions.recruit[key] = true;
    if (g.reviewOnly) temporary.permissions.reviewHigher = true;
    return temporary;
  }
  async promote(missionId, nodeId, grant, principal) {
    return this.store.transaction((state, event) => {
      const m = missionOf(state, missionId), n = nodeOf(m, nodeId), root = m.nodes[m.rootAgentId];
      const identity = orchestratorIdentity(m.config, m, this.now());
      invariant(principal?.trusted && (principal.source === 'local-user' && principal.authority === 'user' || principal.source === 'native-host' && principal.authority === 'trusted-orchestrator' && identity.trusted && identity.profile.authority === 'full'), 'Promotion needs authorised owner/orchestrator');
      invariant(!reviewRoles.has(n.role), 'Reviewer roles cannot become implementation recruiters');
      invariant(m.config.workers[grant.worker] && typeof grant.role === 'string', 'Promotion requires an exact worker and purpose');
      const relations = grant.relations ?? [];
      invariant(relations.every(k => ['lower', 'equal', 'higher'].includes(k) && root.permissions.recruit[k]), 'Promotion exceeds root recruitment ceiling');
      invariant(!grant.reviewOnly || reviewRoles.has(grant.role) && root.permissions.reviewHigher, 'Review-only promotion cannot authorise implementation');
      const g = { id: randomUUID(), nodeId, worker: grant.worker, role: grant.role, relations, reviewOnly: Boolean(grant.reviewOnly),
        remaining: Math.min(12, Math.max(1, Math.floor(grant.uses ?? 1))), expiresAt: this.now() + Math.min(3600000, positive(grant.ttlMs, 'promotion TTL', 900000)), policyHash: m.policyHash, principal: clone(principal) };
      m.promotions[g.id] = g; event('authority.promoted', missionId, g); return g;
    });
  }
  async yield(missionId, nodeId, lease) {
    return this.store.transaction((state, event) => { const n = nodeOf(missionOf(state, missionId), nodeId); invariant(n.status === 'running' && n.lease?.token === lease, 'Execution lease is not owned'); n.status = 'queued'; n.lease = null; event('agent.yielded', missionId, { id: nodeId }); return n; });
  }
  async revise(missionId, requestId, parentId, changes, key) {
    const r = await this.store.transaction((state, event) => {
      const m = missionOf(state, missionId), prior = m.requests[requestId];
      invariant(prior && prior.parentId === parentId && ['modify', 'rejected', 'escalated'].includes(prior.status), 'Request cannot be revised or was already revised');
      invariant(prior.status === 'modify' || m.config.helicop.denial === 'revise' && prior.status !== 'escalated', 'Policy requires final rejection or an explicitly authorised escalation');
      invariant(prior.revisions < Math.min(m.config.mission.maxRetries ?? 2, m.config.helicop.maxRevisions), 'Recruitment revision limit exhausted');
      prior.status = 'revising'; event('recruitment.revision_claimed', missionId, { requestId }); return prior;
    });
    return this.request(missionId, parentId, { ...r.proposal, ...changes }, key, { predecessorId: requestId, reviewerPolicy: r.reviewerPolicy, originId: r.originId, protectedAuthority: r.protectedAuthority, binding: r.binding, gapReuseAuthorId: r.gapReuseAuthorId });
  }
  async escalate(missionId, requestId, changes, key, principal) {
    const prior = await this.store.transaction((state, event) => {
      const m = missionOf(state, missionId), r = m.requests[requestId];
      invariant(r?.status === 'escalated', 'Request is not awaiting explicit escalation');
      const identity = orchestratorIdentity(m.config, m, this.now());
      invariant(principal?.trusted && (principal.source === 'local-user' && principal.authority === 'user' || principal.source === 'native-host' && principal.authority === 'trusted-orchestrator' && identity.trusted && identity.profile.authority === 'full'), 'Escalation needs authorised owner or full orchestrator authority');
      invariant(r.revisions < m.config.mission.maxRetries, 'Mission escalation/retry limit exhausted');
      r.status = 'escalating'; r.escalatedBy = clone(principal); event('recruitment.escalation_authorised', missionId, { requestId, principal }); return r;
    });
    return this.request(missionId, prior.parentId, { ...prior.proposal, ...changes }, key, { predecessorId: requestId, reviewerPolicy: prior.reviewerPolicy, originId: prior.originId, protectedAuthority: prior.protectedAuthority, binding: prior.binding, gapReuseAuthorId: prior.gapReuseAuthorId });
  }
  async overrideRisk(missionId, nodeId, replacement, grant, principal) {
    return this.store.transaction((state, event) => {
      const m = missionOf(state, missionId), node = nodeOf(m, nodeId), identity = orchestratorIdentity(m.config, m, this.now());
      invariant(principal?.trusted && (principal.source === 'local-user' && principal.authority === 'user' || principal.source === 'native-host' && principal.authority === 'trusted-orchestrator' && identity.trusted && identity.profile.authority === 'full'), 'Risk override needs explicit owner or full trusted orchestrator authority');
      invariant(['implementation', 'reworker', 'exploration'].includes(node.role), 'Risk overrides are scoped to a Core work allocation');
      invariant(typeof grant?.rationale === 'string' && grant.rationale.trim() && grant.rationale.length <= 8000, 'Risk override requires a bounded rationale');
      invariant(Number.isInteger(grant.ttlMs) && grant.ttlMs > 0 && grant.ttlMs <= 3600000, 'Risk override requires an expiry within one hour');
      const original = node.riskOverride?.original ?? node.risk;
      const record = { id: randomUUID(), nodeId, policyHash: m.policyHash, original: clone(original), previous: clone(node.risk), replacement: riskInput(replacement), assessment: assessRisk(replacement, m.config.risk), rationale: grant.rationale, principal: clone(principal), createdAt: this.now(), expiresAt: this.now() + grant.ttlMs };
      node.riskOverride = record; node.risk = record.assessment; node.riskRevision = (node.riskRevision ?? 0) + 1;
      m.riskOverrides ??= {}; m.riskOverrides[record.id] = record;
      for (const workflow of Object.values(m.workflows)) if (workflow.authors.includes(nodeId)) { workflow.status = 'held'; workflow.approval = null; workflow.reason = 'Risk classification changed; start a fresh source-bound review workflow'; }
      for (const action of Object.values(m.actions)) if (action.status !== 'executed' && (action.nodeId === nodeId || m.workflows[action.workflowId]?.authors.includes(nodeId))) action.status = 'stale';
      event('risk.overridden', missionId, record); return record;
    });
  }
  async claim(missionId, owner = randomUUID(), { pool, nodeId, adapter = 'runtime', leaseMs = 30000 } = {}) {
    return this.store.transaction((state, event) => {
      const m = missionOf(state, missionId); invariant(m.status === 'active', 'Mission is not active');
      const running = Object.values(m.nodes).filter(n => n.pool && n.status === 'running');
      const candidates = Object.values(m.nodes).filter(n => n.status === 'queued' && (!pool || n.pool === pool) && (!nodeId || n.id === nodeId) && (n.adapter ?? 'runtime') === adapter)
        .sort((a, b) => Number(b.supervisor) - Number(a.supervisor) || a.createdAt - b.createdAt);
      for (const n of candidates) {
        const limit = m.config.fleets[n.pool];
        const active = running.filter(x => x.pool === n.pool);
        if (active.length >= limit.concurrency) continue;
        if (n.pool === 'review' && !n.supervisor && active.filter(x => !x.supervisor).length >= limit.concurrency - limit.reserved) continue;
        n.status = 'running'; n.lease = { owner, token: randomUUID(), expiresAt: this.now() + leaseMs }; n.attempts.push({ ...n.lease, at: this.now() });
        m.requests[n.requestId].status = 'running'; event('agent.claimed', missionId, { id: n.id, lease: n.lease }); return n;
      }
      return null;
    });
  }
  async heartbeat(missionId, nodeId, lease, leaseMs = 30000) {
    return this.store.transaction(state => { const n = nodeOf(missionOf(state, missionId), nodeId); invariant(n.lease?.token === lease && n.status === 'running', 'Execution lease is not owned'); n.lease.expiresAt = this.now() + leaseMs; return n; });
  }
  async waitFor(missionId, nodeId, childIds, lease) {
    return this.store.transaction((state, event) => {
      const m = missionOf(state, missionId), n = nodeOf(m, nodeId);
      invariant(n.status === 'running' && n.lease?.token === lease, 'Execution lease is not owned');
      invariant(childIds.length && childIds.every(id => nodeOf(m, id).parentId === nodeId), 'Can wait only for own children');
      n.status = childIds.every(id => terminal.has(m.nodes[id].status)) ? 'queued' : 'waiting'; n.waitingFor = [...childIds]; n.lease = null; event('agent.waiting', missionId, { id: nodeId, childIds, status: n.status }); return n;
    });
  }
  async finish(missionId, nodeId, { result, status = 'completed', usage, lease } = {}) {
    return this.store.transaction((state, event) => {
      const m = missionOf(state, missionId), n = nodeOf(m, nodeId);
      invariant(n.id !== m.rootAgentId, 'Use mission cancellation for the root');
      if (terminal.has(n.status)) { invariant(digest(n.results.at(-1)?.value) === digest(result), 'Conflicting terminal result'); return n; }
      invariant(terminal.has(status), 'Invalid terminal status');
      invariant(n.lease?.token === lease && n.status === 'running', 'Execution lease is not owned');
      n.results.push({ at: this.now(), hash: digest(result ?? null), value: clone(result ?? null) }); n.status = status; n.lease = null;
      if (usage && Number.isFinite(usage.tokens) && Number.isFinite(usage.usd) && usage.tokens >= 0 && usage.usd >= 0) {
        n.usage = { tokens: usage.tokens, usd: usage.usd }; n.reservation = { tokens: 0, usd: 0 }; n.usageStatus = 'verified';
      } else n.usageStatus = 'unknown'; // retain conservative reservation
      m.requests[n.requestId].status = status;
      refreshWaiting(m, event);
      event('agent.finished', missionId, { id: nodeId, status, resultHash: n.results.at(-1).hash, usageStatus: n.usageStatus }); return n;
    });
  }
  async checkpoint(missionId, nodeId, lease, patch) {
    return this.store.transaction((state, event) => {
      const m = missionOf(state, missionId), n = nodeOf(m, nodeId); invariant(n.status === 'running' && n.lease?.token === lease, 'Execution lease is not owned');
      invariant(Object.keys(patch).every(k => ['runtime', 'responseId', 'usage', 'rounds'].includes(k)), 'Checkpoint cannot change permissions or allocation');
      Object.assign(n, clone(patch)); event('agent.checkpoint', missionId, { id: nodeId, hash: digest(patch) }); return n;
    });
  }
  async recordUsage(missionId, nodeId, lease, responseId, usage) {
    return this.store.transaction((state, event) => {
      const m = missionOf(state, missionId), n = nodeOf(m, nodeId);
      invariant(n.attempts.some(a => a.token === lease), 'Usage recorder does not own an execution attempt');
      invariant(Number.isFinite(usage.tokens) && usage.tokens >= 0 && Number.isFinite(usage.usd) && usage.usd >= 0, 'Usage must be verified nonnegative values');
      const previous = Object.values(m.nodes).find(x => x.responseIds?.includes(responseId));
      if (previous) { invariant(previous.id === nodeId, 'Response usage belongs to another agent'); return n; }
      n.responseIds.push(responseId); n.usage.tokens += usage.tokens; n.usage.usd += usage.usd;
      n.reservation = { tokens: Math.max(0, n.allocation.tokens - n.usage.tokens), usd: Math.max(0, n.allocation.usd - n.usage.usd) };
      event('api.usage', missionId, { nodeId, responseId, usage, incurred: n.usage }); return n;
    });
  }
  async recover(missionId) {
    return this.store.transaction((state, event) => {
      const m = missionOf(state, missionId); const recovered = [];
      for (const n of Object.values(m.nodes)) {
        if (n.status === 'running' && n.pool && n.lease?.expiresAt <= this.now()) {
          // Never blindly replay a POST or tool side effect after a crash.
          n.status = n.runtime?.phase === 'poll' && n.runtime?.responseId ? 'queued' : 'blocked';
          n.lease = null; n.recoveryReason = n.status === 'queued' ? 'Resume known response by GET' : 'Ambiguous work requires explicit reconciliation';
          recovered.push(n.id); event('agent.recovered', missionId, { id: n.id, status: n.status, reason: n.recoveryReason });
        }
      }
      refreshWaiting(m, event);
      return recovered;
    });
  }
  async cancel(missionId, nodeId = 'root') {
    return this.store.transaction((state, event) => {
      const m = missionOf(state, missionId); nodeOf(m, nodeId);
      const descendants = new Set([nodeId]); let changed = true;
      while (changed) { changed = false; for (const n of Object.values(m.nodes)) if (descendants.has(n.parentId) && !descendants.has(n.id)) { descendants.add(n.id); changed = true; } }
      for (const id of descendants) { const n = m.nodes[id]; if (!terminal.has(n.status)) { n.status = 'cancelled'; n.lease = null; } }
      for (const r of Object.values(m.requests)) if (descendants.has(r.parentId) && r.status === 'pending') r.status = 'cancelled';
      if (nodeId === 'root') m.status = 'cancelled';
      if (m.status === 'active') refreshWaiting(m, event);
      event('mission.cancelled', missionId, { nodeId, descendants: [...descendants], note: 'Incurred or ambiguous usage and accepted work retained' }); return [...descendants];
    });
  }
  async diagnostics(missionId) {
    const m = await this.store.snapshot(missionId), nodes = Object.values(m.nodes);
    const fleets = Object.fromEntries(['core', 'review'].map(pool => [pool, { ...m.config.fleets[pool],
      invocations: nodes.filter(n => n.pool === pool).length, running: nodes.filter(n => n.pool === pool && n.status === 'running').length,
      waiting: nodes.filter(n => n.pool === pool && n.status === 'waiting').length }]));
    const total = accounted(m);
    return { missionId, status: m.status, policyHash: m.policyHash, orchestrator: m.orchestrator, fleets,
      estimated: total, remaining: { tokens: m.config.mission.maxTokens == null ? null : m.config.mission.maxTokens - total.tokens, usd: m.config.mission.maxUsd == null ? null : m.config.mission.maxUsd - total.usd },
      tree: nodes.map(({ id, parentId, model, worker, role, pool, depth, status, permissions, requestId }) => ({ id, parentId, model, worker, role, pool, depth, status, permissions, requestId })),
      pending: Object.values(m.requests).filter(r => ['pending', 'modify', 'escalated'].includes(r.status)),
      approvals: Object.values(m.approvals), workflows: m.workflows,
      blocked: nodes.filter(n => n.status === 'blocked').map(n => ({ id: n.id, reason: n.recoveryReason })),
      note: 'Local usage estimates and reservations are not authoritative OpenAI billing.' };
  }
}
