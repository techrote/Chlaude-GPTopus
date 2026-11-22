import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { WORKER_TYPES, canonicalWorker, isProviderWorker } from './workers.mjs';

const ENDPOINT = 'https://api.openai.com/v1';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const FINAL = new Set(['completed', 'failed', 'cancelled', 'incomplete']);
const SERVICE_TIERS = new Set(['auto', 'default', 'flex', 'fast', 'priority']);
export const LOCAL_PRICE_ESTIMATES = Object.freeze({
  'gpt-6.2-astra': [8, 40, 0.4],
  'gpt-6.2-sol': [2, 10, 0.1],
  'gpt-6-luna': [0.1, 0.5, 0.01],
  'gpt-6.1-sol': [2, 10, 0.1],
  'gpt-6.1-terra': [1, 5, 0.05],
  'gpt-6-astra': [10, 50, 1],
  'gpt-5.6-terra': [2, 12, 0.2],
});
const myDir = dirname(fileURLToPath(import.meta.url));
const cachedKeys = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const onWindows = (env = process.env) => process.platform === 'win32' || env.OPENAI_WORKER_TEST_WINDOWS === '1';

// Each worker always uses one of two fixed key profiles. The 'free' profile
// never falls back to the straight API key when it is missing.
const PROFILES = {
  standard: { env: 'OPENAI_API_KEY', file: 'openai-key.dpapi' },
  free: { env: 'OPENAI_FREE_API_KEY', file: 'openai-free-key.dpapi' },
  // NVIDIA Build key for the chat-completions provider workers (bridge/chat.mjs) only; never sent to OpenAI.
  nvidia: { env: 'NVIDIA_API_KEY', file: 'nvidia-key.dpapi' },
};
export function keyProfileForWorker(workerType) {
  // Undefined is the legacy native bridge's standard-key route; a misspelled
  // named worker must never silently become a paid worker.
  // Legacy (pre-rename) names map onto their current worker and keep its key route.
  const name = canonicalWorker(workerType);
  if (name !== undefined && !Object.hasOwn(WORKER_TYPES, name)) throw new Error('Unknown worker key route.');
  return name === undefined ? 'standard' : WORKER_TYPES[name].key;
}
function providedKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  // MCPB clients may leave an optional user_config placeholder unexpanded.
  // Never send a literal placeholder as an API credential.
  return key && !/^\$\{user_config\.[a-zA-Z0-9_-]+\}$/.test(key) ? key : null;
}
export function configuredKey(env = process.env, profile = 'standard') {
  const spec = PROFILES[profile];
  if (!spec) throw new Error('Unknown OpenAI key profile.');
  if (providedKey(env[spec.env])) return 'environment';
  if (onWindows(env) && env.LOCALAPPDATA && existsSync(join(env.LOCALAPPDATA, 'ClaudeOpenAIWorkers', spec.file))) return 'Windows DPAPI';
  return null;
}

export function getKey(env = process.env, profile = 'standard') {
  const spec = PROFILES[profile];
  if (!spec) throw new Error('Unknown OpenAI key profile.');
  if (providedKey(env[spec.env])) return providedKey(env[spec.env]);
  if (env === process.env && cachedKeys.has(profile)) return cachedKeys.get(profile);
  if (!onWindows(env) || !env.LOCALAPPDATA || !existsSync(join(env.LOCALAPPDATA, 'ClaudeOpenAIWorkers', spec.file))) {
    if (profile === 'nvidia') throw new Error(`Missing NVIDIA API key. Set NVIDIA_API_KEY${onWindows(env) ? ' or run set-nvidia-key.ps1' : ''}.`);
    throw new Error(`Missing ${profile} OpenAI key. Set ${spec.env}${onWindows(env) ? ' or run set-openai-key.ps1 -Profile ' + profile : ''}.`);
  }
  const script = join(myDir, '..', 'scripts', 'read-openai-key.ps1');
  try {
    const key = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Profile', profile], {
      timeout: 15000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!key) throw new Error('empty key');
    if (env === process.env) cachedKeys.set(profile, key);
    return key;
  } catch {
    if (profile === 'nvidia') throw new Error('Could not decrypt the NVIDIA DPAPI key. Run set-nvidia-key.ps1 as this Windows user.');
    throw new Error(`Could not decrypt the ${profile} OpenAI DPAPI key. Run set-openai-key.ps1 -Profile ${profile} as this Windows user.`);
  }
}

// Limit errors to upstream status/message. Never expose request headers, the API key, or raw response dumps.
export async function request(method, route, body, options = {}) {
  let key;
  try { key = options.key ?? getKey(options.env ?? process.env, options.profile ?? 'standard'); }
  catch (error) { error.usageDisposition = 'not_started'; throw error; }
  const doFetch = options.fetchFn ?? fetch;
  const maxTries = method === 'GET' ? 3 : 1;
  for (let i = 0; i < maxTries; ++i) {
    let response;
    try {
      response = await doFetch(ENDPOINT + route, {
        method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Flex can take longer even to accept a request. The worker's outer
        // deadline separately bounds polling of background Responses.
        signal: AbortSignal.timeout(method === 'POST' && route === '/responses' && body?.service_tier === 'flex'
          ? 15 * 60 * 1000 : 30000),
      });
    } catch (err) {
      const failure = new Error(`OpenAI request failed: ${err?.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
      failure.usageDisposition = method === 'GET' ? 'read_only' : 'ambiguous';
      throw failure;
    }
    if (response.ok) {
      try { return await response.json(); }
      catch { const failure = new Error('OpenAI returned invalid JSON (ambiguous network response).'); failure.usageDisposition = method === 'GET' ? 'read_only' : 'ambiguous'; throw failure; }
    }
    if (i + 1 < maxTries && RETRYABLE.has(response.status)) { await pause(300 * (i + 1)); continue; }
    const json = await response.json().catch(() => null);
    const raw = json?.error?.message ?? response.statusText ?? 'request rejected';
    const safe = String(raw).split(key).join('[redacted]').slice(0, 400);
    const failure = new Error(`OpenAI HTTP ${response.status}: ${safe}`);
    // A server failure can arrive after a POST was accepted. Do not release
    // reservations merely because an HTTP response was received.
    failure.usageDisposition = method === 'GET' ? 'read_only' : response.status >= 400 && response.status < 500 ? 'rejected' : 'ambiguous';
    throw failure;
  }
}

/** Frozen local estimates, not authoritative OpenAI billing or eligibility. */
export function estimateUsageUsd(model, usage, serviceTier = null) {
  const p = Object.hasOwn(LOCAL_PRICE_ESTIMATES, model) ? LOCAL_PRICE_ESTIMATES[model] : null;
  if (!p || (serviceTier !== null && !SERVICE_TIERS.has(serviceTier))) return null;
  if (!usage || !['input', 'output'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) return null;
  const cached = usage.cached ?? 0;
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > usage.input) return null;
  const multiplier = serviceTier === 'flex' ? 0.5 : ['fast', 'priority'].includes(serviceTier) ? 2 : 1;
  return Number(((Math.max(0, usage.input - cached) * p[0] + cached * p[2] + usage.output * p[1]) * multiplier / 1_000_000).toFixed(7));
}

/** Only explicit HTTP rejection or validation before transport proves no usage. */
export function mayHaveIncurredUsage(error) {
  return !['not_started', 'rejected', 'read_only'].includes(error?.usageDisposition);
}

export function normalize(response) {
  const status = FINAL.has(response?.status) ? response.status : 'in_progress';
  if (status === 'in_progress') return { id: response.id, status };
  const output = Array.isArray(response.output) ? response.output : [];
  const text = output.filter(item => item.type === 'message').flatMap(m => m.content ?? [])
    .filter(c => c.type === 'output_text' || c.type === 'refusal').map(c => c.text ?? c.refusal ?? '').join('');
  const calls = output.filter(item => item.type === 'function_call').map(item => {
    let args;
    try { args = JSON.parse(item.arguments); }
    catch { args = null; }
    return { call_id: item.call_id, name: item.name, args };
  });
  const u = response.usage;
  const valid = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  // Absence, partial fields, inconsistent totals and malformed counts are all
  // unknown evidence. A fabricated {input:0, output:0} must not settle a bill.
  const complete = u && valid(u.input_tokens) && valid(u.output_tokens) &&
    (u.total_tokens === undefined || (valid(u.total_tokens) && u.total_tokens === u.input_tokens + u.output_tokens)) &&
    (u.input_tokens_details?.cached_tokens === undefined || (valid(u.input_tokens_details.cached_tokens) && u.input_tokens_details.cached_tokens <= u.input_tokens));
  const usage = complete ? { input: u.input_tokens, cached: u.input_tokens_details?.cached_tokens ?? 0,
    output: u.output_tokens, total: u.total_tokens ?? u.input_tokens + u.output_tokens } : null;
  const serviceTier = response.service_tier ?? null;
  const estimatedUsd = usage ? estimateUsageUsd(response.model, usage, serviceTier) : null;
  const reason = response.error?.message ?? response.incomplete_details?.reason ?? undefined;
  return { id: response.id, status, text, calls, usage, usageStatus: usage ? 'verified' : 'unknown', estimatedUsd,
    priceStatus: estimatedUsd === null ? 'unknown' : 'estimated', model: response.model ?? null, serviceTier,
    ...(reason && { reason: String(reason).slice(0, 300) }) };
}

export function validateTurnArgs(args) {
  if (typeof args.model !== 'string' || !/^gpt-[\w.-]{1,80}$/.test(args.model)) throw new Error('Invalid model name.');
  if (typeof args.instructions !== 'string' || !args.instructions) throw new Error('Instructions are required.');
  if (!Array.isArray(args.tools)) throw new Error('Tool manifest required.');
  if (args.service_tier !== undefined && !SERVICE_TIERS.has(args.service_tier)) {
    throw new Error('Invalid service_tier. Use auto, default, flex, fast, or priority.');
  }
  if (args.service_tier === 'flex' && /^gpt-6\.2-(sol|astra)(?:-|$)/.test(args.model)) {
    throw new Error(`Flex processing is unavailable for ${args.model}. Choose a supported model (e.g. gpt-6.1-sol) or set the service tier to default/fast.`);
  }
  const effort = ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(args.effort) ? args.effort : 'high';
  return {
    model: args.model, instructions: args.instructions, input: args.input, tools: args.tools,
    reasoning: { effort }, store: true, background: true, parallel_tool_calls: true,
    max_output_tokens: Math.min(32000, Math.max(1024, Number(args.max_output_tokens) || 16000)),
    ...(args.previous_response_id && { previous_response_id: args.previous_response_id }),
    ...(args.service_tier !== undefined && { service_tier: args.service_tier }),
  };
}

export async function createTurn(args, options = {}) {
  // Everything before request() is local validation: no POST was ever sent, which callers
  // (and the native controller) may rely on to release a reservation or a step.
  let payload;
  try {
    if (args.worker_type !== undefined) {
      // Provider workers (NVIDIA, LM Studio) use bridge/chat.mjs; their key must never reach the OpenAI endpoint.
      if (isProviderWorker(canonicalWorker(args.worker_type))) throw new Error('Provider workers do not use the OpenAI Responses transport.');
      const expected = keyProfileForWorker(args.worker_type);
      if (options.profile !== undefined && options.profile !== expected) throw new Error('Worker key-profile mismatch; no fallback is permitted.');
      options = { ...options, profile: expected };
    }
    payload = validateTurnArgs(args);
  } catch (error) { if (error && typeof error === 'object') error.usageDisposition = 'not_started'; throw error; }
  return normalize(await request('POST', '/responses', payload, options));
}
export async function pollTurn(id, options = {}) {
  if (typeof id !== 'string' || !/^resp_[a-zA-Z0-9_-]{4,128}$/.test(id)) throw new Error('Invalid OpenAI response id.');
  const deadline = Date.now() + Math.min(5000, Math.max(0, Number(options.wait_ms) || 0));
  while (true) {
    const response = normalize(await request('GET', `/responses/${encodeURIComponent(id)}`, undefined, options));
    if (response.status !== 'in_progress' || Date.now() >= deadline) return response;
    await pause(Math.min(900, Math.max(0, deadline - Date.now())));
  }
}
export async function cancelTurn(id, options = {}) {
  if (typeof id !== 'string' || !/^resp_[a-zA-Z0-9_-]{4,128}$/.test(id)) throw new Error('Invalid response id.');
  // API may return 400 when the response completed between checking and cancelling.
  try { return normalize(await request('POST', `/responses/${encodeURIComponent(id)}/cancel`, {}, options)); }
  catch (err) { return { id, status: 'cancel_unknown', reason: 'Cancellation was attempted but could not be confirmed' }; }
}
