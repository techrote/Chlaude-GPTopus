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
  // Chat-completions provider workers (bridge/chat.mjs). They never use an OpenAI key, ledger, price guard or service tier.
  // thinking: 'toggle-kwargs' (chat_template_kwargs.enable_thinking), 'effort' (reasoning_effort), 'always', 'none'.
  // steerMode: how a mid-reasoning operator tip is injected ('think' = assistant <think> prefill, 'user' = extra user message).
  'kimik3-1pro': { model: 'moonshotai/kimi-k3.1-pro', provider: 'nvidia', key: 'nvidia', env: 'OPENAI_WORKER_KIMIK3_1PRO_MODEL', tools: true, thinking: 'always', steerMode: 'user', vision: false,
    description: 'NVIDIA Build free model: Kimi K3.1 Pro, long-horizon agentic coding and reasoning (reasoning visible and steerable).' },
  mistral4large: { model: 'mistralai/mistral-large-4-1t-a52b', provider: 'nvidia', key: 'nvidia', env: 'OPENAI_WORKER_MISTRAL4LARGE_MODEL', tools: true, thinking: 'effort', steerMode: 'user', vision: false,
    description: 'NVIDIA Build free model: Mistral Large 4, broad coding and analysis with low/medium/high reasoning effort.' },
  'nemo3-5supervl': { model: 'nvidia/nemotron-3.5-super-vl-120b-a12b', provider: 'nvidia', key: 'nvidia', env: 'OPENAI_WORKER_NEMO3_5SUPERVL_MODEL', tools: true, thinking: 'toggle-kwargs', steerMode: 'user', vision: true,
    description: 'NVIDIA Build free model: Nemotron 3.5 Super VL, strong reasoning and vision; thinking switchable.' },
  'nemo3-5lightning': { model: 'nvidia/nemotron-3.5-lightning-30b-a3b', provider: 'nvidia', key: 'nvidia', env: 'OPENAI_WORKER_NEMO3_5LIGHTNING_MODEL', tools: true, thinking: 'toggle-kwargs', steerMode: 'user', vision: false,
    description: 'NVIDIA Build free model: Nemotron 3.5 Lightning, fast economical reasoning; thinking switchable.' },
  'sprocket0-5': { model: 'kandivault/sprocket-500m/sprocket-500m-chat-q4_k_m.gguf', provider: 'lmstudio', key: 'none', env: 'OPENAI_WORKER_SPROCKET0_5_MODEL', tools: false, thinking: 'none', steerMode: 'think', vision: false,
    description: 'Local LM Studio model on this PC: Sprocket 500M, tiny chat model (2K context, no tools) for trivial text tasks.' },
  'lfm2-5mini': { model: 'b3r5erk/lfm2.5-1.2b-instruct', provider: 'lmstudio', key: 'none', env: 'OPENAI_WORKER_LFM2_5MINI_MODEL', tools: true, thinking: 'none', steerMode: 'think', vision: false,
    description: 'Local LM Studio model on this PC: LFM2.5 1.2B Instruct, quick small edits, lookups and summaries.' },
  lfm3heretic: { model: 'lfm3-1.7b-heretic-uncensored', provider: 'lmstudio', key: 'none', env: 'OPENAI_WORKER_LFM3HERETIC_MODEL', tools: true, thinking: 'always', steerMode: 'think', vision: false,
    description: 'Local LM Studio model on this PC: LFM3 1.7B Heretic (uncensored), small reasoning model.' },
  lfm3vl: { model: 'lfm3-vl-2b', provider: 'lmstudio', key: 'none', env: 'OPENAI_WORKER_LFM3VL_MODEL', tools: true, thinking: 'always', steerMode: 'think', vision: true,
    description: 'Local LM Studio model on this PC: LFM3 VL 2B, small vision-language model.' },
  'lfm2-5turbo8b': { model: 'lfm2.5-8b-a1b-qwen3.8-turbo-brilliance-power-x12-neo-max', provider: 'lmstudio', key: 'none', env: 'OPENAI_WORKER_LFM2_5TURBO8B_MODEL', tools: true, thinking: 'always', steerMode: 'think', vision: false,
    description: 'Local LM Studio model on this PC: LFM2.5 8B-A1B Turbo (MoE), fast local reasoning.' },
  'lfm2-5turbo24b': { model: 'lfm2.5-24b-a2b-turbo-brilliance-50x-neo-max-imatrix', provider: 'lmstudio', key: 'none', env: 'OPENAI_WORKER_LFM2_5TURBO24B_MODEL', tools: true, thinking: 'always', steerMode: 'think', vision: false,
    description: 'Local LM Studio model on this PC: LFM2.5 24B-A2B Turbo (MoE), the strongest local LFM for multi-step work.' },
  inkling2mini: { model: 'thinkingmachines/inkling-2-mini', provider: 'lmstudio', key: 'none', env: 'OPENAI_WORKER_INKLING2MINI_MODEL', tools: true, thinking: 'always', steerMode: 'think', vision: true,
    description: 'Local LM Studio model on this PC: Inkling 2 Mini, long-context vision reasoning model.' },
  'katcoder2-5': { model: 'kat-coder-v2.5-dev-reap-50', provider: 'lmstudio', key: 'none', env: 'OPENAI_WORKER_KATCODER2_5_MODEL', tools: true, thinking: 'none', steerMode: 'think', vision: false,
    description: 'Local LM Studio model on this PC: KAT-Coder V2.5 (REAP-50), agentic coding: edits, refactors and multi-step code tasks.' },
});
/** Chat-completions providers. OpenAI workers have no provider field. */
export const PROVIDERS = Object.freeze(['nvidia', 'lmstudio']);
export const isProviderWorker = name => typeof name === 'string' && Object.hasOwn(WORKER_TYPES, name) && Boolean(WORKER_TYPES[name].provider);
/** The OpenAI (Responses API) workers only: pricing, quotas, tiers, ULTRA and Desktop iterate these. */
export const OPENAI_WORKERS = Object.freeze(Object.keys(WORKER_TYPES).filter(name => !WORKER_TYPES[name].provider));
export const PROVIDER_WORKERS = Object.freeze(Object.keys(WORKER_TYPES).filter(name => WORKER_TYPES[name].provider));
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
  'kimik3-1pro': { min: 'none', max: 'max', default: 'high', note: 'Kimi always reasons; effort is advisory. Free on NVIDIA Build, bounded by the local concurrency and active-hours budget.' },
  mistral4large: { min: 'low', max: 'max', default: 'medium', note: 'Low for quick answers; medium for routine work; high for hard problems (xhigh/max are sent as high).' },
  'nemo3-5supervl': { min: 'none', max: 'max', default: 'high', note: 'None switches thinking off for quick answers; any other effort switches it on.' },
  'nemo3-5lightning': { min: 'none', max: 'max', default: 'medium', note: 'None switches thinking off for quick answers; any other effort switches it on.' },
  'sprocket0-5': { min: 'none', max: 'max', default: 'none', note: 'Tiny local model without reasoning; effort has no effect.' },
  'lfm2-5mini': { min: 'none', max: 'max', default: 'none', note: 'Small local instruct model without separate reasoning; effort has no effect.' },
  lfm3heretic: { min: 'none', max: 'max', default: 'medium', note: 'Local reasoning model; effort is advisory (LM Studio controls thinking).' },
  lfm3vl: { min: 'none', max: 'max', default: 'medium', note: 'Local vision model; effort is advisory (LM Studio controls thinking).' },
  'lfm2-5turbo8b': { min: 'none', max: 'max', default: 'medium', note: 'Local reasoning model; effort is advisory (LM Studio controls thinking).' },
  'lfm2-5turbo24b': { min: 'none', max: 'max', default: 'medium', note: 'Local reasoning model; effort is advisory (LM Studio controls thinking).' },
  inkling2mini: { min: 'none', max: 'max', default: 'medium', note: 'Local reasoning model; effort is advisory (LM Studio controls thinking).' },
  'katcoder2-5': { min: 'none', max: 'max', default: 'none', note: 'Local coding model without separate reasoning; effort has no effect.' },
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
  if (spec.provider) {
    // Service tiers are an OpenAI concept; a provider worker never has one.
    return { name, model, service_tier: undefined, description: spec.description, effort_policy: effortPolicy(name, env, model),
      key_profile: spec.key, provider: spec.provider, tools: spec.tools !== false, thinking: spec.thinking ?? 'none',
      steer_mode: steerModeFor(name, env), vision: Boolean(spec.vision) };
  }
  const specificName = `OPENAI_WORKER_${workerEnvSuffix(name)}_SERVICE_TIER`;
  const tier = (env[specificName] || '').trim().toLowerCase() || spec.defaultTier || (env.OPENAI_WORKER_SERVICE_TIER || '').trim().toLowerCase();
  if (tier && !SERVICE_TIERS.includes(tier)) throw new Error(`Invalid service tier for ${name}: ${tier.slice(0, 30)}.`);
  return { name, model, service_tier: tier || undefined, description: spec.description, effort_policy: effortPolicy(name, env, model),
    key_profile: spec.key };
}
/** Mid-reasoning steering mode: OAI_<SUFFIX>_STEER_MODE, else OAI_<PROVIDER>_STEER_MODE, else the preset ('think' | 'user'). */
export function steerModeFor(name, env = process.env) {
  const spec = workerSpec(name);
  for (const raw of [env[`OAI_${workerEnvSuffix(name)}_STEER_MODE`], spec.provider && env[`OAI_${spec.provider.toUpperCase()}_STEER_MODE`]]) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (value === 'think' || value === 'user') return value;
  }
  return spec.steerMode === 'think' ? 'think' : 'user';
}
/** Chat-completions thinking controls for one request (an empty object when the model has none). */
export function thinkingParams(name, effort) {
  const spec = workerSpec(name);
  if (spec.thinking === 'toggle-kwargs') return { chat_template_kwargs: { enable_thinking: effort !== 'none' } };
  if (spec.thinking === 'effort') return effort === 'none' ? {} : { reasoning_effort: ['xhigh', 'max'].includes(effort) ? 'high' : effort };
  return {};
}
