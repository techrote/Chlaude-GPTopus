import { randomUUID } from 'node:crypto';
import { clone, digest, invariant } from './store.mjs';
import { assessRisk, activeRisk, assertWorkflowRisk, riskInput } from './risk.mjs';

const severe = f => ['high', 'critical'].includes(f.severity);
const states = new Set(['examined', 'partial', 'not_examined', 'uncertain']);
function sourceIdentity(source) {
  invariant(source && typeof source.content === 'string' && source.content.length <= 2000000, 'Immutable source content is required');
  const snapshot = clone(source), contentHash = digest(source.content);
  delete snapshot.hash; delete snapshot.contentHash;
  return { ...snapshot, contentHash, hash: digest(snapshot) };
}
function validateReport(report) {
  invariant(report && Array.isArray(report.findings) && Array.isArray(report.coverage), 'Review must include findings and an explicit coverage map');
  invariant(report.findings.length <= 100 && report.coverage.length <= 200, 'Review output exceeds bounds');
  for (const f of report.findings) invariant(['low', 'medium', 'high', 'critical'].includes(f.severity) && typeof f.message === 'string', 'Invalid review finding');
  for (const c of report.coverage) invariant(typeof c.area === 'string' && states.has(c.status), 'Invalid coverage-map entry');
  invariant(Object.keys(report).every(k => ['findings', 'coverage', 'resolutions', 'summary'].includes(k)), 'Review cannot override trusted provenance fields');
  const resolutions = report.resolutions ?? [];
  invariant(Array.isArray(resolutions) && resolutions.length <= 100, 'Invalid review resolutions');
  return { findings: clone(report.findings), coverage: clone(report.coverage), resolutions: clone(resolutions), summary: String(report.summary ?? '').slice(0, 20000) };
}

/** Roles, evidence freshness and convergence are persisted; allocation always goes through the broker. */
export class ReviewController {
  constructor(broker) { this.broker = broker; this.store = broker.store; }
  async start(missionId, { authorId, source, risk = {}, policy = {} }) {
    const artifact = sourceIdentity(source);
    return this.store.transaction((state, event) => {
      const m = state.missions[missionId], author = m?.nodes[authorId];
      invariant(author && ['implementation', 'reworker'].includes(author.role), 'Workflow needs an allocated implementation author');
      invariant(author.status === 'completed', 'Author must complete before review');
      const admitted = activeRisk(author, this.broker.now()) ?? m.requests[author.requestId]?.evaluation.risk;
      const reviewRisk = { ...riskInput(admitted), ...clone(risk) };
      if (admitted) {
        const rank = v => ['low', 'medium', 'high', 'critical'].indexOf(v === 'unknown' ? 'high' : v);
        if (rank(admitted.effectiveImpact) > rank(reviewRisk.impact ?? 'unknown')) reviewRisk.impact = admitted.effectiveImpact;
        for (const field of ['destructive', 'securitySensitive', 'privacySensitive', 'externalSideEffects', 'deployment', 'persistence']) if (admitted[field]) reviewRisk[field] = true;
        reviewRisk.confidence = Math.min(reviewRisk.confidence ?? 0, admitted.confidence);
        if (admitted.uncertain) reviewRisk.verifiability = admitted.verifiability === 'low' ? 'low' : 'unknown';
      }
      const assessment = assessRisk(reviewRisk, m.config.risk), configured = m.config.review;
      const requiredSecond = configured.secondOpinionImpacts.includes(assessment.effectiveImpact) || assessment.uncertain;
      const requiredGap = configured.gapInspectionImpacts.includes(assessment.effectiveImpact) || assessment.uncertain;
      invariant(Object.keys(policy).every(k => ['maxRounds', 'secondOpinion', 'gapReview'].includes(k)), 'Workflow model/selection overrides belong in authorised owner policy');
      invariant(policy.secondOpinion !== false || !requiredSecond, 'Required second opinion cannot be disabled');
      invariant(policy.gapReview !== false || !requiredGap, 'Required coverage-gap review cannot be disabled');
      invariant(policy.maxRounds == null || policy.maxRounds <= configured.maxRounds, 'Workflow rounds cannot exceed the mission policy');
      const assignments = { selection: author.reviewerPolicy?.selection ?? configured.selection, reviewer: author.reviewerPolicy?.reviewer ?? configured.primary, secondReviewer: configured.secondOpinion, reworker: configured.reworker, reReviewer: configured.rereviewer, gapInspector: configured.gapInspector, judge: configured.judge, maxRounds: configured.maxRounds, secondOpinion: requiredSecond, gapReview: requiredGap, freshGapInspector: configured.freshGapInspector, blindSecondOpinion: configured.blindSecondOpinion, repeatedDefectLimit: configured.repeatedDefectLimit, noProgressLimit: configured.noProgressLimit, ...policy };
      invariant(['B', 'C'].includes(assignments.selection), 'Invalid reviewer-selection policy');
      invariant(Number.isInteger(assignments.maxRounds) && assignments.maxRounds >= 1 && assignments.maxRounds <= 20, 'Invalid review round limit');
      const w = { id: randomUUID(), authorId, authors: [authorId], source: artifact, sourceOrigin: 'caller-supplied immutable snapshot; approval binds this exact snapshot', sourceHistory: [artifact], risk: reviewRisk, assessment, policy: assignments,
        riskRevision: author.riskRevision ?? 0, riskOverrideId: author.riskOverride?.expiresAt > this.broker.now() ? author.riskOverride.id : null,
        round: 1, judgementGeneration: 0, status: assignments.selection === 'C' ? 'selection_required' : 'review', assignments: [], reviews: [], findings: [], tests: [], history: [], selection: null };
      m.workflows[w.id] = w; event('review.started', missionId, { ...w, source: { hash: artifact.hash, id: artifact.id } }); return w;
    });
  }
  async selectReviewer(missionId, workflowId, worker, principal) {
    return this.store.transaction((state, event) => {
      const m = state.missions[missionId], w = m?.workflows[workflowId]; invariant(w?.status === 'selection_required', 'Reviewer selection is not pending');
      invariant(principal?.trusted && principal.source === 'supervisor', 'Policy C requires an authorised independent HELICOP selection');
      const n = m.nodes[principal.nodeId]; invariant(n?.role === 'supervisor' && n.selectsWorkflow === workflowId && n.status === 'completed' && ['helicop-sol', 'helicop-astra'].includes(n.authority), 'Reviewer selector has no workflow-bound HELICOP authority');
      invariant(!w.authors.includes(n.id) && m.config.workers[worker], 'Invalid or dependent reviewer selection');
      w.policy.reviewer = worker; w.selection = { nodeId: n.id, worker, at: this.broker.now() }; w.status = 'review';
      event('review.selected', missionId, { workflowId, ...w.selection }); return w;
    });
  }
  async appointSelector(missionId, workflowId) {
    const m = await this.store.snapshot(missionId), w = m.workflows[workflowId];
    invariant(w?.status === 'selection_required', 'Selection is not pending');
    invariant(m.config.helicop.sol, 'Required reviewer-selection supervisor is unavailable');
    const request = await this.broker.request(missionId, m.rootAgentId, {
      worker: 'sol', role: 'supervisor', budget: { tokens: 12000, usd: 3 }, risk: w.risk,
      task: JSON.stringify({ workflowId, risk: w.assessment, source: w.source, permittedWorkers: Object.keys(m.config.workers), instruction: 'Choose an independent reviewer appropriate for consequence and evidence. Return JSON {worker,rationale}.' }),
      permissions: { tools: [], roots: [], recruit: { lower: false, equal: false, higher: false }, reviewHigher: false },
    }, `selector:${workflowId}`, { originId: w.authorId, protectedAuthority: 'helicop-sol', binding: { selectsWorkflow: workflowId } });
    return request.nodeId ? (await this.store.snapshot(missionId)).nodes[request.nodeId] : request;
  }
  async assign(missionId, workflowId) {
    let m = await this.store.snapshot(missionId), w = m.workflows[workflowId]; invariant(w, 'Unknown review workflow');
    assertWorkflowRisk(m, w, this.broker.now());
    const current = w.assignments.filter(a => a.round === w.round && a.sourceHash === w.source.hash && (a.role !== 'judge' || (a.generation ?? 0) === (w.judgementGeneration ?? 0)));
    let roles = [];
    const primaryCompleted = w.reviews.some(r => r.role === 'reviewer' && r.round === w.round && r.sourceHash === w.source.hash);
    if (w.status === 'review') roles = ['reviewer', ...(w.policy.secondOpinion && (w.policy.blindSecondOpinion || primaryCompleted) ? ['second_opinion'] : [])];
    if (w.status === 'gap') roles = ['gap_inspector'];
    if (w.status === 'adjudication') roles = ['judge'];
    if (w.status === 'rework') roles = ['reworker'];
    const result = [];
    for (const role of roles) {
      const existing = current.find(a => a.role === role); if (existing) { result.push(existing); continue; }
      const worker = role === 'reviewer' ? (w.round === 1 ? w.policy.reviewer : w.policy.reReviewer)
        : role === 'second_opinion' ? w.policy.secondReviewer : role === 'gap_inspector' ? (w.policy.freshGapInspector ? w.policy.gapInspector : m.nodes[w.authorId].worker) : role === 'judge' ? w.policy.judge : w.policy.reworker;
      // Primary and second opinion tasks are independently constructed from source/evidence only.
      const input = { role, workflowId, source: w.source, declaredTests: w.source.tests ?? [], trustedTestEvidence: w.tests.filter(t => t.sourceHash === w.source.hash), risk: w.risk,
        instruction: role === 'reworker' ? 'Apply only the requested fixes using scoped Core tools. Return updated source and test evidence.'
          : role === 'gap_inspector' ? 'Investigate partial, not_examined and uncertain coverage. Return consequential findings for senior adjudication.'
            : role === 'judge' ? 'Adjudicate every disagreement and gap finding explicitly; return findings, coverage and resolutions by finding ID. Do not average away unresolved high-severity defects.'
              : 'Independently inspect the immutable source and evidence. Return JSON with findings [{id,severity,message,area}] and coverage [{area,status,notes}]. No other review conclusions are supplied.' };
      if (['gap_inspector', 'judge', 'reworker'].includes(role)) input.priorReviews = w.reviews.filter(r => r.sourceHash === w.source.hash);
      if (role === 'second_opinion' && !w.policy.blindSecondOpinion) { input.priorReviews = w.reviews.filter(r => r.sourceHash === w.source.hash && r.role === 'reviewer'); input.instruction = 'Provide a configured informed second opinion. Primary conclusions are included; independently substantiate each finding against the exact source and evidence.'; }
      if (role === 'gap_inspector' && !w.policy.freshGapInspector) input.instruction += ' The owner chose continuation of the original author conversation under a new read-only Review allocation; this is not an independent senior sign-off.';
      const request = await this.broker.request(missionId, m.rootAgentId, { worker, role, task: JSON.stringify(input), risk: w.risk,
        permissions: role === 'reworker' ? clone(m.nodes[w.authorId].permissions) : { tools: [], roots: [], recruit: { lower: false, equal: false, higher: false }, reviewHigher: false },
        budget: { tokens: role === 'gap_inspector' ? 16000 : 32000, usd: 4 }, evidence: { sourceHash: w.source.hash, workflowId, round: w.round } }, `review:${workflowId}:${w.round}:${w.source.hash}:${role}:${role === 'judge' ? w.judgementGeneration ?? 0 : 0}`, { originId: w.authorId, ...(role === 'gap_inspector' && !w.policy.freshGapInspector ? { gapReuseAuthorId: w.authorId } : {}) });
      const a = { role, worker, requestId: request.id, nodeId: request.nodeId, round: w.round, sourceHash: w.source.hash, generation: role === 'judge' ? w.judgementGeneration ?? 0 : null };
      await this.store.transaction((state, event) => {
        const flow = state.missions[missionId].workflows[workflowId];
        invariant(flow.round === w.round && flow.source.hash === w.source.hash, 'Source changed during reviewer assignment');
        if (!flow.assignments.some(x => x.requestId === a.requestId)) flow.assignments.push(a);
        event('review.assigned', missionId, { workflowId, ...a });
      }); result.push(a);
    }
    return result;
  }
  async submit(missionId, workflowId, nodeId, sourceHash, report) {
    const checked = validateReport(report);
    return this.store.transaction((state, event) => {
      const m = state.missions[missionId], w = m?.workflows[workflowId], node = m?.nodes[nodeId];
      invariant(w && node, 'Unknown review/agent');
      assertWorkflowRisk(m, w, this.broker.now());
      invariant(w.source.hash === sourceHash, 'Review evidence is stale');
      const a = w.assignments.find(a => (a.nodeId === nodeId || m.requests[a.requestId]?.nodeId === nodeId) && a.round === w.round && a.sourceHash === sourceHash);
      invariant(a && ['reviewer', 'second_opinion', 'gap_inspector', 'judge'].includes(a.role), 'Agent has no review assignment');
      invariant(a.role !== 'judge' || (a.generation ?? 0) === (w.judgementGeneration ?? 0), 'Adjudication was superseded by newer test evidence');
      invariant(!w.authors.includes(nodeId), 'Authors and reworkers cannot review their own implementation');
      invariant(node.role === a.role && node.pool === 'review' && node.status === 'completed', 'Review agent has not completed an authorised Review allocation');
      invariant(!w.reviews.some(r => r.nodeId === nodeId), 'Review already submitted');
      const review = { id: randomUUID(), nodeId, role: a.role, round: w.round, sourceHash, ...checked, at: this.broker.now() };
      w.reviews.push(review); w.history.push({ event: 'review', id: review.id, sourceHash });
      const roundReviews = w.reviews.filter(r => r.round === w.round && r.sourceHash === sourceHash);
      const senior = roundReviews.filter(r => ['reviewer', 'second_opinion'].includes(r.role));
      const seniorComplete = senior.some(r => r.role === 'reviewer') && (!w.policy.secondOpinion || senior.some(r => r.role === 'second_opinion')) && new Set(senior.map(r => r.nodeId)).size === senior.length;
      if (seniorComplete && a.role !== 'gap_inspector' && a.role !== 'judge') {
        w.findings = senior.flatMap(r => r.findings.map((f, i) => ({ ...f, id: `${r.id}:${f.id ?? i}`, reviewerId: r.nodeId })));
        if (w.findings.some(severe)) this.needsRework(w);
        else w.status = w.policy.gapReview ? 'gap' : 'adjudication';
      }
      if (a.role === 'gap_inspector') { w.findings.push(...checked.findings.map((f, i) => ({ ...f, id: `${review.id}:${f.id ?? i}`, reviewerId: nodeId }))); w.status = 'adjudication'; }
      if (a.role === 'judge') {
        const resolutions = checked.resolutions ?? [];
        const unresolved = w.findings.filter(f => severe(f) && !resolutions.some(r => r.findingId === f.id && r.decision === 'dismissed' && typeof r.rationale === 'string' && r.rationale.trim()));
        w.findings.push(...checked.findings);
        if (unresolved.length || checked.findings.some(severe)) this.needsRework(w);
        else if (m.config.review.requireTests && w.assessment.controls.tests && !this.testsPass(w, sourceHash)) { w.status = 'held'; w.reason = 'Required independent test evidence is missing or failing'; }
        else { w.status = 'code_approved'; w.approval = { sourceHash, judgeId: nodeId, reviewIds: roundReviews.map(r => r.id), at: this.broker.now() }; }
      }
      event('review.submitted', missionId, { workflowId, review, status: w.status }); return w;
    });
  }
  testsPass(w, sourceHash) {
    const latest = new Map(w.tests.filter(t => t.sourceHash === sourceHash).map(t => [t.name, t]));
    return latest.size > 0 && [...latest.values()].every(t => t.passed === true);
  }
  assertPlanner(m, principal) {
    const identity = orchestratorIdentity(m.config, m, this.broker.now());
    invariant(principal?.trusted === true && (principal.source === 'local-user' && principal.authority === 'user'
      || principal.source === 'native-host' && principal.authority === 'trusted-orchestrator' && identity.trusted && identity.profile.authority === 'full'),
    'A verification plan needs the trusted local owner or a full trusted orchestrator');
  }
  ensurePlan(m, w) {
    w.waivers ??= [];
    w.testPlan ??= { id: null, policyHash: m.policyHash, policyEntries: policyRequirements(m.config, w.assessment), entries: [], revision: 0, registeredBy: null, at: this.broker.now(), history: [] };
    return w.testPlan;
  }
  effective(plan) {
    const byId = new Map();
    for (const e of [...plan.policyEntries, ...plan.entries]) if (!byId.has(e.id)) byId.set(e.id, e);
    return [...byId.values()].sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  }
  planHashOf(w, plan, entries) {
    return digest({ kind: 'verification-plan', workflowId: w.id, planId: plan.id ?? null, sourceHash: w.source.hash, tests: entries.map(core) });
  }
  /** Trusted additions only: an identical re-registration is a no-op, a different definition of an existing id is refused. */
  admit(existing, raws, origin) {
    invariant(Array.isArray(raws) && raws.length <= MAX_REQUIREMENTS, 'Invalid required-test list');
    const added = [], all = [...existing];
    for (const raw of raws) {
      const e = requirement(raw, origin), prior = all.find(x => x.id === e.id);
      if (prior) { invariant(sameRequirement(prior, e), `Required test ${e.id} is already defined differently; only the local owner can change a requirement`); continue; }
      all.push(e); added.push(e);
    }
    invariant(all.length <= MAX_REQUIREMENTS, 'Too many required tests');
    return added;
  }
  buildPlan(m, assessment, testPlan, principal) {
    const policyEntries = policyRequirements(m.config, assessment), plan = { id: randomUUID(), policyHash: m.policyHash, policyEntries, entries: [], revision: 0, registeredBy: null, at: this.broker.now(), history: [] };
    if (testPlan === undefined) return plan;
    invariant(testPlan && typeof testPlan === 'object' && !Array.isArray(testPlan) && Object.keys(testPlan).every(k => ['id', 'entries'].includes(k)), 'Invalid verification plan');
    this.assertPlanner(m, principal);
    if (testPlan.id !== undefined) { invariant(typeof testPlan.id === 'string' && testPlan.id.trim() && testPlan.id.length <= 128, 'Invalid verification plan id'); plan.id = testPlan.id; }
    plan.entries = this.admit(policyEntries, testPlan.entries, `plan:${principal.source}`);
    plan.registeredBy = clone(principal);
    return plan;
  }
  /** Agents (reviewers, inspectors, judges) can only request more verification, as executable tests, and never alter an existing one. */
  addAgentRequirements(m, w, requested, nodeId) {
    const plan = this.ensurePlan(m, w), added = [], ignored = [];
    for (const raw of requested ?? []) {
      let e;
      try { e = requirement({ id: raw.id, description: raw.description, executable: true, commandDigest: raw.commandDigest }, `agent:${nodeId}`); }
      catch (error) { ignored.push({ id: String(raw?.id ?? '').slice(0, 128), reason: error.message }); continue; }
      const all = this.effective(plan);
      if (all.some(x => x.id === e.id)) { ignored.push({ id: e.id, reason: 'Already designated; an agent cannot change a requirement' }); continue; }
      if (all.length >= MAX_REQUIREMENTS) { ignored.push({ id: e.id, reason: 'Required-test limit reached' }); continue; }
      plan.entries.push(e); added.push(e.id);
    }
    if (added.length) { plan.revision++; plan.history.push({ at: this.broker.now(), kind: 'agent-added', nodeId, ids: added }); }
    return { added, ignored };
  }
  staleActions(m, workflowId) {
    staleUnconsumedActions(m, action => action.workflowId === workflowId);
  }
  /** Evaluate the manifest against current, source- and plan-bound evidence and store the precise state on the workflow. */
  refresh(m, w) {
    const plan = this.ensurePlan(m, w), entries = this.effective(plan), planHash = this.planHashOf(w, plan, entries);
    const cfg = m.config.review, tier = w.assessment.effectiveImpact, sourceHash = w.source.hash;
    const ownerOk = cfg.ownerAttestedImpacts.includes(tier);
    const eligible = t => t.provenance === 'executed' || (t.provenance === 'owner-attested' && ownerOk);
    const waiverOk = tier !== 'critical' || cfg.allowCriticalWaivers === true;
    const current = w.tests.filter(t => t.sourceHash === sourceHash);
    const tests = entries.map(e => {
      const out = { id: e.id, description: e.description, executable: e.executable, origin: e.origin, commandDigest: e.commandDigest, state: 'missing', evidenceIds: [], waiverId: null, detail: '' };
      if (!e.executable) {
        const waiver = w.waivers.find(x => x.testId === e.id && x.sourceHash === sourceHash && x.planHash === planHash);
        if (waiver && waiverOk) { out.state = 'waived'; out.waiverId = waiver.id; }
        else out.detail = waiver ? 'Owner policy does not allow this waiver at this impact' : 'Non-executable: needs an explicit trusted-owner waiver with rationale';
        return out;
      }
      const records = current.filter(t => (t.testId ?? t.name) === e.id && t.planHash === planHash && !(e.commandDigest && t.provenance === 'executed' && t.attestation?.commandDigest !== e.commandDigest));
      const c = classify(records, eligible);
      out.state = c.state; out.evidenceIds = c.live.map(r => r.id);
      if (c.state === 'missing' && c.live.some(r => r.passed)) out.detail = 'Only passing evidence of a class this impact tier does not accept (independent execution is required)';
      return out;
    });
    const ids = state => tests.filter(t => t.state === state).map(t => t.id);
    const named = new Set(entries.map(e => e.id));
    const unrelated = [...new Set(current.filter(t => !named.has(t.testId ?? t.name)).map(t => t.testId ?? t.name))];
    let mode, state, accepted, reason = null;
    if (entries.length) {
      mode = 'manifest'; accepted = tests.every(t => ['satisfied', 'waived'].includes(t.state));
      state = ids('contradictory').length ? 'contradictory' : ids('failing').length ? 'failing' : ids('missing').length ? 'missing' : ids('waived').length ? 'waived' : 'satisfied';
      if (!accepted) reason = `${TEST_HOLD}: ${[['missing', ids('missing')], ['failing', ids('failing')], ['contradictory', ids('contradictory')]].filter(([, list]) => list.length).map(([label, list]) => `${label} [${list.join(', ')}]`).join('; ')}`;
    } else if (cfg.requireTests && w.assessment.controls.tests) {
      if (tierMatches(cfg.testPlanRequiredImpacts, tier)) {
        mode = 'unplanned'; state = 'unplanned'; accepted = false;
        reason = `${TEST_HOLD}: no required tests are designated for work whose risk demands tests; the local owner registers a verification plan (ultra/cli.mjs plan-add) or lists owner-policy review.requiredTests`;
      } else {
        // Weakest tier only: "some passing evidence". Designated tests are never replaced by this rule.
        mode = 'legacy'; const legacy = legacyEvaluate(current); accepted = legacy.accepted; state = accepted ? 'some-passing-evidence' : legacy.state;
        if (!accepted) reason = `${TEST_HOLD}: ${legacy.state === 'missing' ? 'no passing test evidence is recorded' : `recorded evidence is ${legacy.state}`}`;
      }
    } else { mode = 'not-required'; state = 'not-required'; accepted = true; }
    return w.requiredTests = { mode, state, accepted, reason, planId: plan.id, planHash, sourceHash, impact: tier, ownerAttestedAccepted: ownerOk, tests,
      satisfied: ids('satisfied'), missing: ids('missing'), failing: ids('failing'), contradictory: ids('contradictory'), waived: ids('waived'), unrelated, evaluatedAt: this.broker.now() };
  }
  /** Re-evaluate after any evidence/plan change: revoke approval that is no longer supported; optionally re-adjudicate once satisfied. */
  enforce(m, w, event, { readjudicate = false } = {}) {
    const gate = this.refresh(m, w);
    if (w.status === 'code_approved' && !gate.accepted) { w.status = 'held'; w.approval = null; w.reason = gate.reason; }
    if (w.status === 'held' && isTestHold(w.reason)) {
      const maximum = m.config.mission.maxRetries, used = m.retryCount ?? 0, generation = w.judgementGeneration ?? 0;
      if (!gate.accepted) w.reason = gate.reason;
      else if (readjudicate && generation < maximum && used < maximum) {
        this.broker.consumeRetry(m, event, { kind: 'evidence-readjudication', workflowId: w.id });
        w.judgementGeneration = generation + 1; w.status = 'adjudication'; w.reason = null;
        event('review.readjudication_required', m.id, { workflowId: w.id, generation: w.judgementGeneration, sourceHash: w.source.hash });
      } else if (readjudicate) {
        // Say what is actually true: the evidence is complete, only the budget for another adjudication is gone.
        w.reason = `${RETRY_HOLD}: the retry limit is reached (mission ${used} of ${maximum} retries used, this workflow ${generation} re-adjudications). Owner remedy: restart the workflow (ReviewController.restart, local owner, with a reason) to review the same source afresh`;
      }
    }
    return gate;
  }
  /** Legacy helper retained for "some passing evidence" semantics; contradiction-aware rather than latest-wins. */
  testsPass(w, sourceHash) { return legacyEvaluate(w.tests.filter(t => t.sourceHash === sourceHash)).accepted; }
  async recordTest(missionId, workflowId, evidence, principal) {
    return this.store.transaction((state, event) => {
      const m = state.missions[missionId], w = m?.workflows[workflowId]; invariant(w && evidence.sourceHash === w.source.hash, 'Test evidence has stale source');
      assertWorkflowRisk(m, w, this.broker.now());
      invariant(principal?.trusted && ['local-user', 'test-runner'].includes(principal.source), 'Test evidence needs a trusted runner or explicit owner record');
      invariant(typeof evidence.name === 'string' && typeof evidence.passed === 'boolean' && typeof evidence.details === 'string', 'Complete test evidence required');
      invariant(Object.keys(evidence).every(k => ['name', 'passed', 'details', 'sourceHash'].includes(k)), 'Test evidence cannot override trusted provenance');
      const t = { id: randomUUID(), ...clone(evidence), principal: clone(principal), at: this.broker.now() };
      w.tests.push(t);
      if (w.status === 'code_approved' && !this.testsPass(w, w.source.hash)) { w.status = 'held'; w.approval = null; w.reason = 'Required independent test evidence is missing or failing'; }
      if (w.status === 'held' && w.reason === 'Required independent test evidence is missing or failing' && this.testsPass(w, w.source.hash) && (w.judgementGeneration ?? 0) < m.config.mission.maxRetries && (m.retryCount ?? 0) < m.config.mission.maxRetries) {
        this.broker.consumeRetry(m, event, { kind: 'evidence-readjudication', workflowId });
        w.judgementGeneration = (w.judgementGeneration ?? 0) + 1; w.status = 'adjudication'; w.reason = null;
        event('review.readjudication_required', missionId, { workflowId, generation: w.judgementGeneration, sourceHash: w.source.hash });
      }
      for (const action of Object.values(m.actions)) if (action.workflowId === workflowId && action.status !== 'executed') action.status = 'stale';
      event('review.test_evidence', missionId, { workflowId, ...t }); return t;
    });
  }
  /** A non-executable required test can only be satisfied by this explicit, rationale-carrying owner waiver. */
  async waiveTest(missionId, workflowId, waiver, principal) {
    return this.store.transaction((state, event) => {
      const m = state.missions[missionId], w = m?.workflows[workflowId]; invariant(w, 'Unknown workflow'); superseded(w);
      assertWorkflowRisk(m, w, this.broker.now()); this.assertOwner(principal);
      invariant(waiver && typeof waiver === 'object' && Object.keys(waiver).every(k => ['testId', 'rationale', 'sourceHash', 'planHash'].includes(k)), 'Invalid waiver');
      const gate = this.refresh(m, w), entry = this.effective(this.ensurePlan(m, w)).find(e => e.id === waiver.testId);
      invariant(waiver.sourceHash === w.source.hash && waiver.planHash === gate.planHash, 'Waiver is bound to a different source or verification plan');
      invariant(entry && !entry.executable, 'Only a non-executable required test can be waived; executable tests need executed or owner-attested evidence');
      invariant(w.assessment.effectiveImpact !== 'critical' || m.config.review.allowCriticalWaivers === true, 'Owner policy does not allow waivers for critical-impact work');
      invariant(typeof waiver.rationale === 'string' && waiver.rationale.trim() && waiver.rationale.length <= 2000, 'A waiver needs a rationale');
      invariant(!w.waivers.some(x => x.testId === entry.id && x.sourceHash === gate.sourceHash && x.planHash === gate.planHash), 'Test is already waived');
      const record = { id: randomUUID(), testId: entry.id, rationale: waiver.rationale, sourceHash: gate.sourceHash, planHash: gate.planHash, principal: clone(principal), at: this.broker.now() };
      w.waivers.push(record);
      this.enforce(m, w, event, { readjudicate: true }); this.staleActions(m, workflowId);
      event('review.test_waived', missionId, { workflowId, ...record }); return record;
    });
  }
  planChanged(m, w, event, change) {
    const plan = w.testPlan; plan.revision++; plan.history.push({ at: this.broker.now(), ...change });
    // Approval rested on the previous plan; it cannot survive any change, even one that looks harmless.
    if (w.status === 'code_approved') { w.status = 'held'; w.approval = null; w.reason = `${TEST_HOLD}: the verification plan changed after approval; re-adjudication required`; }
    this.enforce(m, w, event, { readjudicate: true }); this.staleActions(m, w.id);
    event('review.plan_changed', m.id, { workflowId: w.id, planId: plan.id, revision: plan.revision, planHash: w.requiredTests.planHash, change });
  }
  /** Read-only: the current manifest state of a workflow, evaluated on a copy of the ledger snapshot (nothing is written). */
  async inspect(missionId, workflowId) {
    const m = await this.store.snapshot(missionId), w = m.workflows[workflowId]; invariant(w, 'Unknown workflow');
    const gate = this.refresh(m, w), plan = this.ensurePlan(m, w), config = m.config.review;
    return { workflowId: w.id, status: w.status, reason: w.reason ?? null, source: { id: w.source.id ?? null, hash: w.source.hash }, impact: gate.impact,
      ownerAttestedAccepted: gate.ownerAttestedAccepted, ownerAttestedImpacts: [...config.ownerAttestedImpacts], criticalWaiversAllowed: config.allowCriticalWaivers === true,
      plan: { id: plan.id, hash: gate.planHash, revision: plan.revision }, gate: clone(gate), evidence: w.tests.filter(t => t.sourceHash === w.source.hash).map(t => ({ id: t.id, testId: t.testId ?? t.name, passed: t.passed, provenance: t.provenance, at: t.at })) };
  }
  /** Read-only preview of an additive owner plan registration: exactly what would be added, and the plan hash before and after. */
  async previewRequiredTests(missionId, workflowId, entries) {
    const m = await this.store.snapshot(missionId), w = m.workflows[workflowId]; invariant(w, 'Unknown workflow');
    const plan = this.ensurePlan(m, w), existing = this.effective(plan), added = this.admit(existing, entries, 'plan:local-user');
    const after = { ...plan, entries: [...plan.entries, ...added] };
    return { workflowId: w.id, source: { id: w.source.id ?? null, hash: w.source.hash }, impact: w.assessment.effectiveImpact, planId: plan.id,
      planHashBefore: this.planHashOf(w, plan, existing), planHashAfter: this.planHashOf(w, after, this.effective(after)),
      existing: existing.map(core), added: added.map(core), unchanged: added.length === 0 };
  }
  /** Additive registration by the trusted owner (or a full trusted orchestrator). It can never shrink or alter the suite. */
  async addRequiredTests(missionId, workflowId, entries, principal, { expectedPlanHash } = {}) {
    return this.store.transaction((state, event) => {
      const m = state.missions[missionId], w = m?.workflows[workflowId]; invariant(w, 'Unknown workflow'); superseded(w);
      assertWorkflowRisk(m, w, this.broker.now()); this.assertPlanner(m, principal);
      const plan = this.ensurePlan(m, w);
      // A confirmation binds the exact plan (and source) the owner was shown; anything that changed it since is refused.
      invariant(expectedPlanHash === undefined || this.planHashOf(w, plan, this.effective(plan)) === expectedPlanHash, 'The verification plan or source changed after it was displayed; review it again');
      const added = this.admit(this.effective(plan), entries, `plan:${principal.source}`);
      if (!added.length) return w;
      plan.entries.push(...added);
      this.planChanged(m, w, event, { kind: 'added', ids: added.map(e => e.id), principal: clone(principal) }); return w;
    });
  }
  /** Removing or redefining a requirement is a local-owner decision with a reason; owner-policy tests change only in owner configuration. */
  async changeRequiredTests(missionId, workflowId, { remove = [], replace = [], reason } = {}, principal) {
    return this.store.transaction((state, event) => {
      const m = state.missions[missionId], w = m?.workflows[workflowId]; invariant(w, 'Unknown workflow'); superseded(w);
      assertWorkflowRisk(m, w, this.broker.now()); this.assertOwner(principal);
      invariant(typeof reason === 'string' && reason.trim() && reason.length <= 2000, 'Changing the verification plan needs a reason');
      invariant(Array.isArray(remove) && Array.isArray(replace) && remove.length + replace.length >= 1 && remove.length + replace.length <= MAX_REQUIREMENTS, 'Nothing to change');
      const plan = this.ensurePlan(m, w), policyIds = new Set(plan.policyEntries.map(e => e.id));
      const replacements = replace.map(r => requirement(r, 'plan:local-user'));
      const touched = [...remove, ...replacements.map(r => r.id)];
      invariant(new Set(touched).size === touched.length, 'A requirement can be changed only once per request');
      for (const id of touched) { invariant(!policyIds.has(id), 'Owner-policy tests change only in owner configuration'); invariant(plan.entries.some(e => e.id === id), `Unknown plan test ${String(id)}`); }
      const before = plan.entries.filter(e => touched.includes(e.id)).map(core);
      plan.entries = plan.entries.filter(e => !remove.includes(e.id)).map(e => replacements.find(r => r.id === e.id) ?? e);
      this.planChanged(m, w, event, { kind: 'changed', removed: remove, replaced: replacements.map(core), before, reason, principal: clone(principal) }); return w;
    });
  }
  needsRework(w) {
    const signature = digest(w.findings.filter(severe).map(f => `${f.area ?? ''}:${f.message}`).sort());
    w.defectCounts ??= {}; w.defectCounts[signature] = (w.defectCounts[signature] ?? 0) + 1;
    if (w.round >= w.policy.maxRounds) { w.status = 'held'; w.reason = 'Review/rework round limit reached'; }
    else if (w.defectCounts[signature] >= w.policy.repeatedDefectLimit) { w.status = 'held'; w.reason = 'Repeated defects without progress'; }
    else w.status = 'rework';
    w.lastDefectSignature = signature;
  }
  async revisedSource(missionId, workflowId, reworkerId, source) {
    const next = sourceIdentity(source);
    return this.store.transaction((state, event) => {
      const m = state.missions[missionId], w = m?.workflows[workflowId], n = m?.nodes[reworkerId];
      invariant(w?.status === 'rework' && n?.role === 'reworker' && n.pool === 'core' && n.status === 'completed', 'Rework requires a completed authorised Core allocation');
      invariant(w.assignments.some(a => a.role === 'reworker' && (a.nodeId === reworkerId || m.requests[a.requestId]?.nodeId === reworkerId) && a.round === w.round), 'Reworker is not assigned to this workflow');
      if (w.source.contentHash === next.contentHash) {
        w.noProgressCount = (w.noProgressCount ?? 0) + 1;
        if (w.noProgressCount >= w.policy.noProgressLimit || w.round >= w.policy.maxRounds) { w.status = 'held'; w.reason = 'No meaningful source change'; }
        else { w.round++; w.status = 'rework'; }
      } else if (w.sourceHistory.some(s => s.contentHash === next.contentHash)) { w.status = 'held'; w.reason = 'Source oscillation detected'; }
      else { w.source = next; w.sourceHistory.push(next); w.round++; w.status = 'review'; w.authors.push(reworkerId); w.approval = null; w.noProgressCount = 0; }
      for (const action of Object.values(m.actions)) if (action.workflowId === workflowId && action.status !== 'executed') { action.status = 'stale'; }
      event('review.source_changed', missionId, { workflowId, sourceHash: next.hash, reworkerId, status: w.status }); return w;
    });
  }
  async invalidate(missionId, workflowId, source) {
    const next = sourceIdentity(source);
    return this.store.transaction((state, event) => {
      const m = state.missions[missionId], w = m?.workflows[workflowId]; invariant(w, 'Unknown workflow');
      if (w.source.hash === next.hash) return w;
      w.source = next; w.sourceHistory.push(next); w.approval = null; w.status = 'held'; w.reason = 'Source changed outside authorised rework; fresh review required';
      for (const a of Object.values(m.actions)) if (a.workflowId === workflowId && a.status !== 'executed') a.status = 'stale';
      event('review.invalidated', missionId, { workflowId, sourceHash: next.hash }); return w;
    });
  }
}
