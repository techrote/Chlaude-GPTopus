/** Canonical worker names and defaults shared by the Claude Code mod and Desktop MCP tools. */
export const WORKER_TYPES = Object.freeze({
  sol: { model: 'gpt-6.2-sol', env: 'OPENAI_WORKER_SOL_MODEL', description: 'OpenAI Sol: general-purpose coding, investigation and independent review.' },
  astra: { model: 'gpt-6.2-astra', env: 'OPENAI_WORKER_ASTRA_MODEL', description: 'OpenAI Astra: complex architecture, difficult coding and rigorous review.' },
  luna: { model: 'gpt-6-luna', env: 'OPENAI_WORKER_LUNA_MODEL', description: 'OpenAI Luna: economical searches, straightforward changes and routine audits.' },
  'flex6-1': { model: 'gpt-6.1-sol', defaultTier: 'flex', env: 'OPENAI_WORKER_FLEX6_1_MODEL', description: 'GPT-6.1 Sol with Flex pricing; best for time-insensitive engineering tasks.' },
  'daily-astrafree': { model: 'gpt-6-astra', defaultTier: 'default', env: 'OPENAI_WORKER_DAILY_ASTRAFREE_MODEL', description: 'GPT-6 Astra on the free-programme key; local 250K/day guardrail with configurable headroom.' },
  'daily-terrafree': { model: 'gpt-5.6-terra', defaultTier: 'default', env: 'OPENAI_WORKER_DAILY_TERRAFREE_MODEL', description: 'GPT-5.6 Terra on the free-programme key; local 2.5M/day guardrail with configurable headroom.' },
});
export const SERVICE_TIERS = Object.freeze(['auto', 'default', 'flex', 'fast', 'priority']);
export const EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
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
  return { name, model, service_tier: tier || undefined, description: spec.description,
    key_profile: name.startsWith('daily-') ? 'free' : 'standard' };
}
