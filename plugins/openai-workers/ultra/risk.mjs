const COMPLEXITIES = ['low', 'medium', 'high', 'critical', 'unknown'];
const IMPACTS = ['low', 'medium', 'high', 'critical', 'unknown'];
const VERIFIABILITIES = ['high', 'medium', 'low', 'unknown'];
const FLAGS = ['destructive', 'securitySensitive', 'privacySensitive', 'externalSideEffects', 'deployment', 'persistence'];
const FIELDS = ['complexity', 'impact', 'verifiability', 'confidence', 'rationale', 'blastRadius', 'reversibility', 'testsAvailable', 'independentEvidence', ...FLAGS];
const level = impact => IMPACTS.indexOf(impact === 'unknown' ? 'high' : impact);

export const riskInput = assessment => Object.fromEntries(FIELDS.filter(k => Object.hasOwn(assessment ?? {}, k)).map(k => [k, assessment[k]]));
export const activeRisk = (node, now = Date.now()) => node.riskOverride && node.riskOverride.expiresAt <= now ? node.riskOverride.original : node.risk;
export function assertWorkflowRisk(mission, workflow, now = Date.now()) {
  const node = mission.nodes[workflow.authorId];
  if ((node?.riskRevision ?? 0) !== (workflow.riskRevision ?? 0)) throw new Error('Risk classification changed; this review evidence is invalid and a fresh workflow is required');
  if (!workflow.riskOverrideId) return;
  const grant = node?.riskOverride;
  if (!grant || grant.id !== workflow.riskOverrideId || grant.expiresAt <= now) throw new Error('Risk override expired or changed; fresh review against the current assessment is required');
}

/** Complexity selects an author; consequence and evidence select controls independently. */
export function assessRisk(input = {}, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Risk assessment must be a structured object.');
  for (const key of Object.keys(input)) if (!FIELDS.includes(key)) throw new Error(`Unknown risk field: ${key}.`);
  const result = {
    complexity: input.complexity ?? 'unknown', impact: input.impact ?? 'unknown', verifiability: input.verifiability ?? 'unknown',
    confidence: input.confidence ?? 0, rationale: input.rationale ?? '', blastRadius: input.blastRadius ?? 'unknown',
    reversibility: input.reversibility ?? 'unknown', testsAvailable: input.testsAvailable ?? false,
    independentEvidence: input.independentEvidence ?? false,
    ...Object.fromEntries(FLAGS.map(key => [key, input[key] ?? false])),
  };
  for (const [name, choices] of [['complexity', COMPLEXITIES], ['impact', IMPACTS], ['verifiability', VERIFIABILITIES]]) {
    if (!choices.includes(result[name])) throw new Error(`Invalid risk ${name}: ${String(result[name])}.`);
  }
  if (typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) throw new Error('Risk confidence must be between zero and one.');
  if (typeof result.rationale !== 'string' || result.rationale.length > 8000) throw new Error('Risk rationale must be bounded text.');
  if (!['local', 'project', 'organisation', 'public', 'unknown'].includes(result.blastRadius)) throw new Error('Invalid risk blastRadius.');
  if (!['reversible', 'partial', 'irreversible', 'unknown'].includes(result.reversibility)) throw new Error('Invalid risk reversibility.');
  for (const flag of [...FLAGS, 'testsAvailable', 'independentEvidence']) if (typeof result[flag] !== 'boolean') throw new Error(`Risk ${flag} must be boolean.`);
  const reasons = [];
  let effectiveImpact = result.impact;
  const atLeast = (impact, reason) => { if (level(effectiveImpact) < level(impact)) effectiveImpact = impact; reasons.push(reason); };
  if (result.destructive || result.deployment || result.externalSideEffects || result.persistence || result.reversibility === 'irreversible') atLeast('high', 'Consequential or irreversible effects require high-impact controls.');
  if (result.securitySensitive || result.privacySensitive) atLeast('high', 'Security/privacy sensitivity requires high-impact controls.');
  if (['organisation', 'public'].includes(result.blastRadius)) atLeast('critical', 'Broad blast radius requires critical-impact controls.');
  const minimumConfidence = options.minimumConfidence ?? 0.75;
  const uncertain = result.impact === 'unknown' || result.verifiability === 'unknown' || result.verifiability === 'low' || result.confidence < minimumConfidence;
  if (uncertain) reasons.push('Impact or verification evidence is insufficiently certain.');
  const highImpact = ['high', 'critical'].includes(effectiveImpact) || effectiveImpact === 'unknown';
  return {
    ...result, effectiveImpact, uncertain, highImpact,
    authorComplexity: result.complexity,
    controls: { independentReview: highImpact || uncertain, secondOpinion: highImpact, gapInspection: highImpact,
      tests: highImpact || uncertain, dryRun: result.destructive || result.deployment || result.externalSideEffects,
      executionApproval: highImpact || result.reversibility !== 'reversible' },
    reasons,
  };
}

/** Only the trusted control plane may supply an override grant; it must be retained in its ledger. */
export function overrideRisk(original, replacement, authority, now = Date.now()) {
  if (!authority || authority.authorised !== true || !authority.id || !authority.reason || !Number.isFinite(Date.parse(authority.expiresAt)) || Date.parse(authority.expiresAt) <= now) {
    throw new Error('A risk override needs a current explicit authority grant and rationale.');
  }
  return { assessment: assessRisk(replacement), audit: { original: assessRisk(original), replacement: assessRisk(replacement), authority: authority.id, reason: authority.reason, expiresAt: authority.expiresAt } };
}
