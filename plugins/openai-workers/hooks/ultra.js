// Portable data/helpers: this file is imported by Claude Code's non-Node mod VM.
// Never import a Node module, use dynamic import(), or pass the host `$` here.
export const NATIVE_MIN_VERSION = '2.1.326';
export const NATIVE_PREFIX = 'mcp__openai-workers__';
const text = { type: 'string' };
const object = properties => ({ type: 'object', properties, additionalProperties: false });
const spec = (description, properties, required) => ({ description, properties, required });

export const ULTRA_NATIVE_SPECS = {
  Agent: spec('Recruit a native OpenAI child. Use subagent_type openai-workers:<worker>. Put a JSON envelope in prompt: {"task":"bounded task","ultra":{"role":"implementation|reviewer|reworker|exploration","mode":"SWARM|REPLICATOR|SKYNET","risk":{"complexity":"low","impact":"low","verifiability":"high","confidence":0.9,"rationale":"evidence"},"budget":{"tokens":40000,"usd":4}}}. Metadata is a proposal, never authority. Missing risk is held for scrutiny. Foreground calls release the parent running slot.', {
    subagent_type: text, prompt: text, description: text, run_in_background: { type: 'boolean' },
  }, ['subagent_type', 'prompt', 'description']),
  [`${NATIVE_PREFIX}ultra_read_file`]: spec('Read bounded UTF-8 source from an approved root. Relative paths only; native permission checks and ULTRA scopes both apply.', { rootId: text, path: text }, ['rootId', 'path']),
  [`${NATIVE_PREFIX}ultra_create_stage`]: spec('Copy an explicit list of approved source files into your private stage. Never changes the live project.', { files: { type: 'array', items: { ...object({ rootId: text, path: text }), required: ['rootId', 'path'] }, maxItems: 256 } }, ['files']),
  [`${NATIVE_PREFIX}ultra_stage_read`]: spec('Read a file from your own private stage, including its current SHA-256.', { stage: text, path: text }, ['stage', 'path']),
  [`${NATIVE_PREFIX}ultra_stage_write`]: spec('Propose a scoped implementation edit in your private stage. Use the current SHA-256, or null for a new file. This does not apply changes to the live project.', { stage: text, path: text, content: text, expectedSha256: { type: ['string', 'null'] }, rootId: text }, ['stage', 'path', 'content', 'expectedSha256']),
  [`${NATIVE_PREFIX}ultra_stage_patch`]: spec('Export source-bound proposed patches for review and separately authorised application.', { stage: text }, ['stage']),
  [`${NATIVE_PREFIX}ultra_diagnostics`]: spec('Inspect the current native ULTRA mission, approved lineage, resource allocations, pending approvals and review state. This root operation grants no new authority.', {}, []),
  [`${NATIVE_PREFIX}ultra_start_review`]: spec('Root orchestrator: start the configured independent review/rework controller for a completed native implementation author. authorAgentId must be the actual native Agent result. Optional content is explicitly a caller-supplied immutable snapshot; label identifies it, and expectedContentHash can pin it. Omitted content reviews the preserved author result. Code approval does not grant execution.',
    { authorAgentId: text, content: text, label: text, expectedContentHash: text }, ['authorAgentId']),
  [`${NATIVE_PREFIX}ultra_recruitment_decide`]: spec('Root orchestrator only: decide a recruitment gate explicitly assigned to trusted-orchestrator. Inspect diagnostics and bind the exact request inputHash. This cannot provide a user or HELICOP vote. Every modification still requires revalidation.',
    { requestId: text, requestHash: text, decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'MODIFY', 'ESCALATE'] }, rationale: text,
      modification: { type: 'object', properties: { worker: text, task: text, mode: text, budget: { type: 'object' } }, additionalProperties: false } }, ['requestId', 'requestHash', 'decision', 'rationale']),
  [`${NATIVE_PREFIX}ultra_action_propose`]: spec('Root orchestrator: record the actual proposed consequential action and supporting source identity for a bound native author. This only proposes an action; it does not approve or execute it.',
    { authorAgentId: text, action: { type: 'object', properties: { kind: text, description: text, workflowId: text, sourceHash: text, risk: { type: 'object' }, details: { type: 'object' } }, required: ['kind', 'description'], additionalProperties: false } }, ['authorAgentId', 'action']),
  [`${NATIVE_PREFIX}ultra_action_decide`]: spec('Root orchestrator: decide only an action whose configured authorities explicitly include trusted-orchestrator. Read the actual action/evidence in diagnostics and provide its exact hash. No tool capability is enlarged and no action is executed.',
    { actionId: text, actionHash: text, approved: { type: 'boolean' }, rationale: text }, ['actionId', 'actionHash', 'approved', 'rationale']),
  [`${NATIVE_PREFIX}ultra_risk_override`]: spec('Full trusted root only: replace a Core allocation risk classification with explicit rationale and expiry. Existing reviews and action approvals become stale. This grants no tool or recruitment capability.',
    { nodeId: text, replacement: { type: 'object' }, rationale: text, ttlMs: { type: 'integer', minimum: 1, maximum: 3600000 } }, ['nodeId', 'replacement', 'rationale', 'ttlMs']),
  [`${NATIVE_PREFIX}ultra_promote`]: spec('Full trusted root only: grant a bounded, expiring recruitment promotion to one exact node, worker and role. Root limits still bind; descendants do not inherit expanded authority. Use reviewOnly for a review exception.',
    { nodeId: text, worker: text, role: text, relations: { type: 'array', items: { type: 'string', enum: ['lower', 'equal', 'higher'] } }, reviewOnly: { type: 'boolean' }, uses: { type: 'integer', minimum: 1, maximum: 12 }, ttlMs: { type: 'integer', minimum: 1, maximum: 3600000 } }, ['nodeId', 'worker', 'role', 'relations', 'reviewOnly', 'uses', 'ttlMs']),
  [`${NATIVE_PREFIX}ultra_escalate`]: spec('Full trusted root only: authorise a bounded revision of an ESCALATE decision. The exact request hash is required and all recruitment policy is evaluated again. This is not a supervisor or human approval. If admitted, the parent may bind its returned request ID using approvedRequestId.',
    { requestId: text, requestHash: text, changes: { type: 'object', properties: { worker: text, task: text, mode: text, promotionId: text, budget: { type: 'object' }, risk: { type: 'object' } }, additionalProperties: false } }, ['requestId', 'requestHash', 'changes']),
};

export function hostVersionSupported(value) {
  const match = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+].*)?$/.exec(String(value ?? ''));
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || major === 2 && (minor > 1 || minor === 1 && patch >= 326);
}
export function trustedClaudeFamily(model) {
  if (typeof model !== 'string') return 'unknown';
  if (['opus', 'fable', 'sonnet', 'haiku'].includes(model)) return model;
  const found = /^claude-(opus|fable|sonnet|haiku)-[0-9]+(?:[.-][0-9]+)*(?:\[1m\])?$/.exec(model);
  return found?.[1] ?? 'unknown';
}
export function isPrivateBridgeTool(name) {
  return typeof name === 'string' && (name.includes('ultra_native_') || /^mcp__.*(?:openai|bridge).*__(?:create|poll|cancel|page)$/.test(name));
}
export function nativeWorker(type) {
  const match = /^openai-workers:(sol|astra|luna|flex6-1|daily-astrafree|daily-terrafree)$/.exec(String(type ?? ''));
  return match?.[1] ?? null;
}
export function nativeProposal(event) {
  const worker = nativeWorker(event.subagentType);
  if (!worker) throw new Error('ULTRA workers can recruit only explicitly classified OpenAI worker profiles.');
  let task = event.prompt, options = {};
  if (typeof task !== 'string' || !task.trim() || task.length > 100000) throw new Error('Native task must be bounded nonempty text.');
  if (task.trim().startsWith('{')) {
    let envelope;
    try { envelope = JSON.parse(task); } catch { /* Ordinary text remains an unknown-risk proposal. */ }
    if (envelope && Object.hasOwn(envelope, 'ultra')) {
      if (!envelope.ultra || typeof envelope.ultra !== 'object' || Array.isArray(envelope.ultra) || typeof envelope.task !== 'string' || !envelope.task.trim()) throw new Error('Invalid native ULTRA task envelope.');
      for (const key of Object.keys(envelope)) if (!['ultra', 'task'].includes(key)) throw new Error(`Unsupported task envelope field ${key}.`);
      for (const key of Object.keys(envelope.ultra)) if (!['role', 'mode', 'risk', 'budget', 'permissions', 'promotionId', 'planId', 'reviewerPolicy', 'revisionOf', 'approvedRequestId'].includes(key)) throw new Error(`Unsupported native proposal field ${key}.`);
      task = envelope.task; options = envelope.ultra;
    }
  }
  return { ...options, worker, task, role: options.role ?? 'implementation', adapter: 'native' };
}

export function nativeToolNames(node, profile) {
  if (['supervisor', 'judge'].includes(node.role)) return [];
  const result = [];
  if (Object.values(node.permissions.recruit).some(Boolean) || node.permissions.reviewHigher) result.push('Agent');
  if (profile !== 'A' && node.permissions.tools.includes('read_file')) result.push(`${NATIVE_PREFIX}ultra_read_file`);
  if (profile === 'C' && ['implementation', 'reworker'].includes(node.role) && node.permissions.tools.includes('stage_write')) {
    result.push(...['create_stage', 'stage_read', 'stage_write', 'stage_patch'].map(name => `${NATIVE_PREFIX}ultra_${name}`));
  }
  return result;
}
export function nativeRootToolNames(node, profile) {
  return ['Agent', ...['diagnostics', 'start_review', 'recruitment_decide', 'action_propose', 'action_decide', 'risk_override', 'promote', 'escalate'].map(name => `${NATIVE_PREFIX}ultra_${name}`),
    ...(profile !== 'A' && node.permissions.tools.includes('read_file') ? [`${NATIVE_PREFIX}ultra_read_file`] : [])];
}
export function nativeOpenAITools(node, profile) {
  return nativeToolNames(node, profile).map(name => {
    const entry = ULTRA_NATIVE_SPECS[name];
    return { type: 'function', name, description: entry.description, parameters: { type: 'object', properties: entry.properties, required: entry.required, additionalProperties: false }, strict: false };
  });
}
export function filterNativeToolArgs(name, value) {
  if (!Object.hasOwn(ULTRA_NATIVE_SPECS, name)) throw new Error(`Unsupported native ULTRA tool ${name}.`);
  const entry = ULTRA_NATIVE_SPECS[name];
  validateNativeValue({ type: 'object', properties: entry.properties, required: entry.required, additionalProperties: false }, value, name);
  if (JSON.stringify(value).length > 1500000) throw new Error('Native tool arguments exceed the size limit.');
  return value;
}
function validateNativeValue(schema, value, label) {
  const kinds = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matches = kind => kind === 'null' ? value === null : kind === 'integer' ? Number.isSafeInteger(value) : kind === 'number' ? Number.isFinite(value) :
    kind === 'array' ? Array.isArray(value) : kind === 'object' ? Boolean(value && typeof value === 'object' && !Array.isArray(value)) : typeof value === kind;
  if (!kinds.some(matches) || schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid ${label}.`);
  if (typeof value === 'number' && (schema.minimum != null && value < schema.minimum || schema.maximum != null && value > schema.maximum)) throw new Error(`Invalid ${label} bound.`);
  if (Array.isArray(value)) {
    if (schema.maxItems != null && value.length > schema.maxItems) throw new Error(`Too many ${label} entries.`);
    if (schema.items) value.forEach((item, i) => validateNativeValue(schema.items, item, `${label}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`Missing ${label}.${key}.`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validateNativeValue(schema.properties[key], item, `${label}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`Unsupported ${label}.${key}.`);
    }
  }
}
