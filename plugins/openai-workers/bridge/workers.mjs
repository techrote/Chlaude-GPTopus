/** Canonical worker names and defaults shared by the Claude Code mod and Desktop MCP tools. */
export const WORKER_TYPES = Object.freeze({
  'sol6-2': { model: 'gpt-6.2-sol', key: 'standard', env: 'OPENAI_WORKER_SOL6_2_MODEL', description: 'OpenAI Sol: general-purpose coding, investigation and independent review.' },
  'astra6-2': { model: 'gpt-6.2-astra', key: 'standard', env: 'OPENAI_WORKER_ASTRA6_2_MODEL', description: 'OpenAI Astra: complex architecture, difficult coding and rigorous review.' },
  luna6: { model: 'gpt-6-luna', key: 'standard', env: 'OPENAI_WORKER_LUNA6_MODEL', description: 'OpenAI Luna: economical searches, straightforward changes and routine audits.' },
  luna6fast: { model: 'gpt-6-luna', key: 'standard', defaultTier: 'fast', env: 'OPENAI_WORKER_LUNA6FAST_MODEL', description: 'GPT-6 Luna on the Fast service tier; quick economical searches and routine changes (Fast is priced above standard).' },
  luna6flex: { model: 'gpt-6-luna', key: 'standard', defaultTier: 'flex', env: 'OPENAI_WORKER_LUNA6FLEX_MODEL', description: 'GPT-6 Luna with Flex pricing; cheapest option for time-insensitive economical tasks.' },
  'sol6-1flex': { model: 'gpt-6.1-sol', key: 'standard', defaultTier: 'flex', env: 'OPENAI_WORKER_SOL6_1FLEX_MODEL', description: 'GPT-6.1 Sol with Flex pricing; best for time-insensitive engineering tasks.' },
  astra6free: { model: 'gpt-6-astra', key: 'free', defaultTier: 'default', env: 'OPENAI_WORKER_ASTRA6FREE_MODEL', description: 'GPT-6 Astra on the free-programme key; local 250K/day guardrail with configurable headroom.' },
  'terra5-6free': { model: 'gpt-5.6-terra', key: 'free', defaultTier: 'default', env: 'OPENAI_WORKER_TERRA5_6FREE_MODEL', description: 'GPT-5.6 Terra on the free-programme key; local 2.5M/day guardrail with configurable headroom.' },
});
export const SERVICE_TIERS = Object.freeze(['auto', 'default', 'flex', 'fast', 'priority']);
export const EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
// The API accepts these single-model efforts; "ultra" is a harness orchestration
// mode, not a reasoning.effort value. Named worker presets may narrow the range.
export const DEFAULT_EFFORT_POLICIES = Object.freeze({
  'sol6-2': { min: 'medium', max: 'max', default: 'high', note: 'Medium for bounded coding; high for multi-file work; xhigh/max for difficult debugging or verification.' },
  'astra6-2': { min: 'medium', max: 'max', default: 'high', note: 'Medium for clear reviews; high for architecture; xhigh/max for critical or ambiguous decisions.' },
  luna6: { min: 'max', max: 'max', default: 'max', note: 'Always Max. Give Luna well-scoped, economical tasks; expect slower completion than lower efforts.' },
  luna6fast: { min: 'max', max: 'max', default: 'max', note: 'Always Max. Give Luna well-scoped, economical tasks; expect slower completion than lower efforts.' },
  luna6flex: { min: 'max', max: 'max', default: 'max', note: 'Always Max. Give Luna well-scoped, economical tasks; expect slower completion than lower efforts.' },
  'sol6-1flex': { min: 'medium', max: 'max', default: 'high', note: 'Medium for routine refactors; high for multi-step tasks; xhigh/max for hard, time-insensitive work.' },
  astra6free: { min: 'medium', max: 'max', default: 'high', note: 'Medium for bounded research; high for independent reviews; xhigh/max for demanding investigations.' },
  'terra5-6free': { min: 'high', max: 'max', default: 'high', note: 'High for everyday inspection; xhigh for multi-file reasoning; max for intricate recovery or audits.' },
});
const effortRank = value => EFFORTS.indexOf(value);
const effortEnvPrefix = name => `OPENAI_WORKER_${workerEnvSuffix(name)}_EFFORT_`;

/** Validate the selected model's known API restrictions before spending tokens. */
function checkModelEffort(model, effort) {
  const forbidsNone = /^gpt-6\.2-(sol|astra)(?:-|$)|^gpt-6\.1-sol(?:-|$)|^gpt-6-astra(?:-|$)/.test(model);
  if (effort === 'none' && forbidsNone) {
    throw new Error(`${model} does not support reasoning effort none. Configure a minimum of low or higher.`);
  }
}

/** Per-worker range and short task-selection note, shared by CLI and Desktop Chat. */
export function effortPolicy(name, env = process.env, model) {
  const preset = DEFAULT_EFFORT_POLICIES[name];
  if (!preset) workerSpec(name); // useful "unknown worker" diagnostic
  const prefix = effortEnvPrefix(name);
  const configured = field => {
    const raw = env[prefix + field];
    if (raw === undefined || String(raw).trim() === '') return { value: preset[field.toLowerCase()], set: false };
    const value = String(raw).trim().toLowerCase();
    if (!EFFORTS.includes(value)) throw new Error(`Invalid ${prefix + field}: ${value.slice(0, 24)}. Use none, low, medium, high, xhigh, or max (not ultra).`);
    return { value, set: true };
  };
  const min = configured('MIN').value;
  const max = configured('MAX').value;
  if (effortRank(min) > effortRank(max)) throw new Error(`Invalid effort range for ${name}: min ${min} exceeds max ${max}.`);
  const chosenDefault = configured('DEFAULT');
  // If the user changes only a bound, clamp the built-in default into it.
  // An explicitly configured default outside the interval is a config error.
  if (chosenDefault.set && (effortRank(chosenDefault.value) < effortRank(min) || effortRank(chosenDefault.value) > effortRank(max))) {
    throw new Error(`Default effort ${chosenDefault.value} for ${name} falls outside ${min}..${max}.`);
  }
  const defaultEffort = chosenDefault.set ? chosenDefault.value : EFFORTS[Math.min(effortRank(max), Math.max(effortRank(min), effortRank(chosenDefault.value)))];
  const rawNote = env[prefix + 'NOTE'];
  const note = rawNote === undefined || String(rawNote).trim() === '' ? preset.note : String(rawNote).replace(/\s+/g, ' ').trim();
  if (note.length > 240) throw new Error(`${prefix}NOTE must be 240 characters or fewer.`);
  const currentModel = model || (env[workerSpec(name).env] || '').trim() || workerSpec(name).model;
  checkModelEffort(currentModel, min);
  checkModelEffort(currentModel, defaultEffort);
  return { min, max, default: defaultEffort, note };
}

/** Enforce the range even if the parent asks for a lower/higher effort. */
export function selectWorkerEffort(name, requested, env = process.env, model) {
  const policy = effortPolicy(name, env, model);
  const raw = requested == null || String(requested).trim() === '' ? null : String(requested).trim().toLowerCase();
  if (raw && !EFFORTS.includes(raw)) throw new Error(`Invalid reasoning effort ${raw.slice(0, 24)}: use none, low, medium, high, xhigh, or max (not ultra).`);
  const desired = raw || policy.default;
  const effective = EFFORTS[Math.min(effortRank(policy.max), Math.max(effortRank(policy.min), effortRank(desired)))];
  const currentModel = model || (env[workerSpec(name).env] || '').trim() || workerSpec(name).model;
  checkModelEffort(currentModel, effective);
  return { effective, requested: raw, adjusted: effective !== desired, policy };
}

export function effortGuidance(name, policy = effortPolicy(name)) {
  return `API reasoning effort ${policy.min}..${policy.max}; default ${policy.default}. ${policy.note} ` +
    'When delegating, specify an effort inside that range if your Claude Code version supports per-invocation effort. ' +
    'The plugin enforces the range regardless of inherited or requested effort.';
}

/** Worker names used before the oai rename; old ledger records and in-flight calls still resolve. */
export const LEGACY_WORKER_NAMES = Object.freeze({
  sol: 'sol6-2', astra: 'astra6-2', luna: 'luna6', 'flex6-1': 'sol6-1flex', 'daily-astrafree': 'astra6free', 'daily-terrafree': 'terra5-6free',
});
/** Map a legacy worker name to its current name; current and unknown names pass through unchanged. */
export function canonicalWorker(name) {
  return typeof name === 'string' && Object.hasOwn(LEGACY_WORKER_NAMES, name) ? LEGACY_WORKER_NAMES[name] : name;
}
export function workerSpec(name) {
  if (typeof name !== 'string' || !Object.hasOwn(WORKER_TYPES, name)) {
    throw new Error(`Unknown worker. Choose one of: ${Object.keys(WORKER_TYPES).join(', ')}.`);
  }
  return WORKER_TYPES[name];
}
export function workerEnvSuffix(name) { return name.toUpperCase().replace(/[^A-Z0-9]/g, '_'); }
export function workerSettings(name, env = process.env) {
  const spec = workerSpec(name);
  const model = (env[spec.env] || '').trim() || spec.model;
  const specificName = `OPENAI_WORKER_${workerEnvSuffix(name)}_SERVICE_TIER`;
  const tier = (env[specificName] || '').trim().toLowerCase() || spec.defaultTier || (env.OPENAI_WORKER_SERVICE_TIER || '').trim().toLowerCase();
  if (tier && !SERVICE_TIERS.includes(tier)) throw new Error(`Invalid service tier for ${name}: ${tier.slice(0, 30)}.`);
  return { name, model, service_tier: tier || undefined, description: spec.description, effort_policy: effortPolicy(name, env, model),
    key_profile: spec.key };
}
