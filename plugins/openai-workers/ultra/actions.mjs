import { randomUUID } from 'node:crypto';
import { digest, clone, invariant } from './store.mjs';
import { combineApprovals, executionRequirements, orchestratorIdentity } from './policy.mjs';
import { assessRisk, assertWorkflowRisk } from './risk.mjs';
const ACTION_CAPABILITY = Object.freeze({ test: 'run_test', command: 'run_command', write: 'stage_write', delete: 'delete', merge: 'merge', deploy: 'deploy', external: 'external' });

/**
 * Authority that has not been spent yet. Evidence, plan, waiver, source or risk changes revoke exactly these. An action that was
 * already consumed ('executing') or finished ('executed') keeps its state: the effect may already be happening, so it must still be
 * able to record its result, and a terminal decision ('rejected', 'escalated', 'expired') has no authority left to revoke.
 */
export const REVOCABLE_ACTION_STATES = Object.freeze(['pending', 'approved']);
export function staleUnconsumedActions(m, applies = () => true) {
  const revoked = [];
  for (const action of Object.values(m.actions)) if (REVOCABLE_ACTION_STATES.includes(action.status) && applies(action)) { action.status = 'stale'; revoked.push(action.id); }
  return revoked;
}

/** Code, tests, destructive execution and merge are different immutable requests. */
export class ActionGate {
  constructor(broker) { this.broker = broker; this.store = broker.store; }
  async propose(missionId, nodeId, action) {
    invariant(action && ['test', 'command', 'write', 'delete', 'merge', 'deploy', 'external'].includes(action.kind), 'Unknown action class');
    invariant(typeof action.description === 'string' && action.description.trim(), 'Actual proposed action and evidence are required');
    return this.store.transaction((state, event) => {
      const m = state.missions[missionId], n = m?.nodes[nodeId]; invariant(n, 'Unknown agent');
      const hash = digest(action), now = this.broker.now();
      // An expired proposal is never handed back: it can no longer be decided and its votes must not carry over.
      for (const stale of Object.values(m.actions)) if (stale.status === 'pending' && stale.expiresAt <= now) { stale.status = 'expired'; event('action.expired', missionId, { actionId: stale.id }); }
      const prior = Object.values(m.actions).find(a => a.nodeId === nodeId && a.hash === hash && a.status === 'pending');
      if (prior) return prior;
      if (action.workflowId) { const w = m.workflows[action.workflowId]; invariant(w?.status === 'code_approved' && w.approval?.sourceHash === action.sourceHash, 'Current source lacks independent code approval'); assertWorkflowRisk(m, w, this.broker.now()); }
      const authorities = clone(m.config.execution?.consequentialAuthorities ?? ['user']);
      // The approval policy is frozen into the action so a verdict never depends on who answers first or on later reads of configuration.
      const combination = m.config.execution.combination;
      const requirements = executionRequirements(authorities, combination, { mandatoryAuthorities: m.config.execution.mandatoryAuthorities ?? [], vetoAuthorities: m.config.execution.vetoAuthorities ?? [] });
      const a = { id: randomUUID(), nodeId, workflowId: action.workflowId ?? null, hash, action: clone(action), policyHash: m.policyHash, authorities, combination, requirements,
        status: 'pending', votes: [], createdAt: this.broker.now(), expiresAt: this.broker.now() + 900000 };
      const risk = assessRisk(action.risk ?? {}, m.config.risk);
      if (m.config.execution.defaultApproval === 'risk-based' && action.kind === 'test' && action.isolated === true && n.permissions.tools.includes('run_test') && !risk.highImpact && !risk.uncertain && !risk.controls.executionApproval) {
        a.status = 'approved'; a.automaticBasis = 'Owner granted isolated testing capability and complete low-impact reversible risk evidence; executor attestation remains mandatory';
      }
      m.actions[a.id] = a; event('action.proposed', missionId, a); return a;
    });
  }
  async decide(missionId, actionId, decision, principal) {
    return this.store.transaction((state, event) => {
      const m = state.missions[missionId], a = m?.actions[actionId]; invariant(a?.status === 'pending' && a.expiresAt > this.broker.now(), 'Action is not pending or has expired');
      if (a.workflowId) assertWorkflowRisk(m, m.workflows[a.workflowId], this.broker.now());
      invariant(principal?.trusted, 'Unverified execution approval');
      invariant(a.authorities.includes(principal.authority), 'Execution authority is not configured');
      const identity = orchestratorIdentity(m.config, m, this.broker.now());
      invariant(principal.source === 'local-user' && principal.authority === 'user' || principal.source === 'native-host' && principal.authority === 'trusted-orchestrator' && identity.trusted && identity.profile.authority === 'full' || principal.source === 'judge', 'Invalid execution principal');
      if (principal.source === 'judge') {
        const n = m.nodes[principal.nodeId]; invariant(n?.role === 'judge' && n.judgesAction === actionId && n.id !== a.nodeId && n.status === 'completed' && principal.authority === `helicop-${n.family}` && ['sol', 'astra'].includes(n.family), 'Final judge must be fresh, independent and assigned the actual action');
      }
      invariant(decision.actionHash === a.hash && typeof decision.rationale === 'string', 'Decision must identify the exact action and evidence');
      invariant(!a.votes.some(v => v.authority === principal.authority), 'Authority already voted');
      a.votes.push({ principal: clone(principal), authority: principal.authority, approved: decision.approved === true, rationale: decision.rationale });
      // Actions recorded before the policy was frozen fall back to the immutable mission configuration.
      const combination = a.combination ?? m.config.execution.combination;
      const requirements = a.requirements ?? executionRequirements(a.authorities, combination, { mandatoryAuthorities: m.config.execution.mandatoryAuthorities ?? [], vetoAuthorities: m.config.execution.vetoAuthorities ?? [] });
      const verdict = combineApprovals(requirements, a.votes.map(v => ({ authority: v.authority, decision: v.approved ? 'APPROVE' : 'REJECT' })), combination);
      if (verdict.decision === 'REJECT') a.status = 'rejected';
      else if (verdict.decision === 'APPROVE') a.status = 'approved';
      else if (verdict.decision === 'ESCALATE') a.status = 'escalated';
      event('action.decided', missionId, { actionId, status: a.status, vote: a.votes.at(-1) }); return a;
    });
  }
  async appointJudge(missionId, actionId, authority) {
    const m = await this.store.snapshot(missionId), a = m.actions[actionId];
    invariant(a?.status === 'pending' && a.authorities.includes(authority) && ['helicop-sol', 'helicop-astra'].includes(authority), 'Action does not authorise this judge');
    const worker = authority.slice('helicop-'.length);
    const request = await this.broker.request(missionId, m.rootAgentId, {
      worker, role: 'judge', budget: { tokens: 16000, usd: 4 },
      risk: { complexity: 'low', impact: 'high', verifiability: 'high', confidence: 1, rationale: 'Independent decision on explicitly proposed consequential action' },
      task: JSON.stringify({ actionId, actionHash: a.hash, action: a.action, evidence: a.workflowId ? m.workflows[a.workflowId] : null, instruction: 'Independently judge this exact execution and evidence. Return JSON {approved, actionHash, rationale}.' }),
      permissions: { tools: [], roots: [], recruit: { lower: false, equal: false, higher: false }, reviewHigher: false },
    }, `action-judge:${actionId}:${authority}`, { originId: a.nodeId, protectedAuthority: authority, binding: { judgesAction: actionId } });
    return request.nodeId ? (await this.store.snapshot(missionId)).nodes[request.nodeId] : request;
  }
  async consume(missionId, actionId, action, { nodeId, capability } = {}) {
    return this.store.transaction((state, event) => {
      const m = state.missions[missionId], a = m?.actions[actionId], n = m?.nodes[nodeId];
      invariant(m?.status === 'active' && n && n.status !== 'cancelled' && n.status !== 'blocked', 'Mission/agent is cancelled or blocked');
      invariant(a?.status === 'approved' && a.expiresAt > this.broker.now(), 'Execution approval missing, consumed, stale or expired');
      invariant(a.nodeId === nodeId && a.hash === digest(action) && a.policyHash === m.policyHash, 'Approval does not match this action');
      invariant(capability === ACTION_CAPABILITY[action.kind], 'Claimed capability does not authorise this action class');
      invariant(n?.permissions.tools.includes(capability), 'Execution approval cannot enlarge tool permissions');
      if (a.workflowId) { const w = m.workflows[a.workflowId]; invariant(w?.status === 'code_approved' && w.source.hash === action.sourceHash, 'Code evidence changed after approval'); assertWorkflowRisk(m, w, this.broker.now()); }
      // Remember exactly which approval the effect ran under: later evidence changes cannot rewrite or revoke this record.
      const w = a.workflowId ? m.workflows[a.workflowId] : null;
      a.executedUnder = w ? { workflowId: w.id, sourceHash: w.source.hash, planHash: w.approval?.planHash ?? null, approvedAt: w.approval?.at ?? null } : null;
      a.status = 'executing'; a.consumedAt = this.broker.now(); event('action.consumed', missionId, { actionId, hash: a.hash, executedUnder: a.executedUnder }); return a;
    });
  }
  async complete(missionId, actionId, result) {
    return this.store.transaction((state, event) => { const a = state.missions[missionId]?.actions[actionId]; invariant(a?.status === 'executing', 'Action is not executing'); a.status = 'executed'; a.result = clone(result); a.completedAt = this.broker.now(); event('action.completed', missionId, { actionId, resultHash: digest(result), executedUnder: a.executedUnder ?? null }); return a; });
  }
}
