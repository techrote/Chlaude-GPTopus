/**
 * Pure policy helpers shared by the mod, the bridge and the tests: per-task guardrails with their sources,
 * structured stop reasons, and the free -> paid routing decision. Nothing here performs I/O.
 */
export const DEFAULT_MAX_STEPS = 40;
/** After the step cap or a task budget is reached the worker gets this many extra steps to wrap up (commit / summarise). */
export const WRAP_UP_STEPS = 3;
export const STOP_REASONS = Object.freeze(['concurrency', 'tpm_limit', 'quota_free_daily', 'monthly_soft_limit', 'task_budget', 'step_cap', 'api_error', 'cancelled']);
export const WRAP_UP_MESSAGE = 'SYSTEM NOTICE: your step or spending budget for this task is used up. Wrap up NOW: save or commit the work already done (finish or revert half-applied edits), then reply with a short summary of what is done, what is not done and exactly how to continue. Do not start new work.';

const positive = v => Number.isFinite(Number(v)) && Number(v) > 0 && String(v).trim() !== '';
const suffix = type => type.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/**
 * Effective per-task caps for one worker and where each came from. There is NO default USD cap:
 * a USD cap exists only when the owner set OPENAI_WORKER_<WORKER>_MAX_USD or OPENAI_WORKER_MAX_USD.
 */
export function guardrails(env, type, spec = {}) {
  const pick = kind => {
    const specific = `OPENAI_WORKER_${suffix(type)}_${kind}`, global = `OPENAI_WORKER_${kind}`;
    if (positive(env[specific])) return { value: Number(env[specific]), source: { name: specific, scope: 'worker', value: String(env[specific]) } };
    if (positive(env[global])) return { value: Number(env[global]), source: { name: global, scope: 'all workers', value: String(env[global]) } };
    return null;
  };
  const steps = pick('MAX_STEPS'), usd = spec.provider ? null : pick('MAX_USD');
  const sources = [];
  sources.push(steps ? steps.source : { name: null, scope: 'built-in default', value: String(DEFAULT_MAX_STEPS) });
  if (usd) sources.push(usd.source);
  return { maxSteps: steps?.value ?? DEFAULT_MAX_STEPS, maxUsd: usd?.value ?? Infinity, sources };
}

/** One-line acknowledgement of the caps, used in launch notices, /oai and usage. */
export function describeGuardrails(g) {
  const usd = Number.isFinite(g.maxUsd) ? `$${g.maxUsd} estimated per task` : 'no per-task USD cap';
  return `${g.maxSteps} steps, ${usd} (${g.sources.map(s => s.name ? `${s.name}=${s.value} [${s.scope}]` : `steps default ${s.value}`).join('; ')})`;
}

/**
 * Where a run stands against its caps. `used` is relative to the run's budget window (a resumed run
 * starts a new window). phase: 'ok' | 'wrap_up' (grace steps, wrap-up message sent on the first) | 'stop'.
 */
export function budgetPhase(run, g) {
  const steps = run.steps - (run.stepBase ?? 0), usd = run.estimatedUsd - (run.usdBase ?? 0);
  const reason = steps >= g.maxSteps ? 'step_cap' : usd >= g.maxUsd ? 'task_budget' : null;
  if (!reason) return { phase: 'ok', steps, usd };
  const graceUsed = run.wrapUpSteps ?? 0;
  if (graceUsed < WRAP_UP_STEPS) return { phase: 'wrap_up', reason, steps, usd, first: graceUsed === 0 };
  return { phase: 'stop', reason, steps, usd };
}

/** Machine-readable stop record plus the human line; the text ends with a parseable OAI-STATUS line. */
export function stopRecord({ status = 'stopped', reason, detail = {}, resumable = false, resetAt = null, message }) {
  const record = { status, reason, resumable, ...(resetAt && { resetAt }), ...detail };
  return { record, text: `${message}
OAI-STATUS ${JSON.stringify(record)}` };
}

/** Classify a thrown/refused error into a stop reason. */
export function classifyError(error) {
  if (error?.quotaReason === 'free_daily_exhausted' || error?.quotaReason === 'free_daily_reserved' || /soft daily allowance/i.test(error?.message ?? '')) return 'quota_free_daily';
  if (/monthly spending limit/i.test(error?.message ?? '')) return 'monthly_soft_limit';
  if (/tokens per min|TPM|request too large/i.test(error?.message ?? '')) return 'tpm_limit';
  if (/interrupted|cancel/i.test(error?.message ?? '')) return 'cancelled';
  return 'api_error';
}

/** Free -> paid routing for the 'astra' entry point and for free workers when the free pool is spent. */
export const ROUTES = Object.freeze({ astra: { free: 'astra6free', paid: 'astra6-2' }, astra6free: { free: 'astra6free', paid: 'astra6-2' }, 'terra5-6free': { free: 'terra5-6free', paid: null } });
/** Free -> paid switching is ON unless the owner sets OPENAI_WORKER_FREE_TO_PAID_DISABLE=1. */
export const freeToPaidEnabled = env => !['1', 'true', 'on', 'yes'].includes(String(env.OPENAI_WORKER_FREE_TO_PAID_DISABLE ?? '').trim().toLowerCase());

// ---- request size handling (provider TPM limits) ----
/** A failed response saying the single request exceeds the tokens-per-minute limit ("Request too large ... Limit N, Requested M"). */
export function tooLarge(response) {
  const reason = response?.reason ?? '';
  if (response?.status !== 'failed' || !/tokens per min|TPM/i.test(reason)) return null;
  const m = /Limit\s+(\d+),\s*Requested\s+(\d+)/i.exec(reason);
  const limit = m ? Number(m[1]) : null, requested = m ? Number(m[2]) : null;
  return /request too large/i.test(reason) || (limit && requested && requested > limit) ? { limit, requested } : null;
}
const clip = (text, max) => { const s = String(text ?? ''); return s.length <= max ? s : `${s.slice(0, Math.floor(max * 0.6))}\n...[${s.length - max} chars omitted by the bridge]...\n${s.slice(-Math.floor(max * 0.3))}`; };
/** Cap every function_call_output in a Responses input so one huge tool result cannot blow a request. */
export function capOutputs(input, max = 40_000) {
  if (!Array.isArray(input)) return input;
  return input.map(item => item?.type === 'function_call_output' && typeof item.output === 'string' && item.output.length > max ? { ...item, output: clip(item.output, max) } : item);
}
/**
 * A fresh, much smaller conversation: the original task prompts, a compaction notice, and the most recent tool results clipped hard.
 * Used when the server-side history alone no longer fits the model's per-request limit.
 */
export function compactedInput({ prompts, results = [], perResult = 3000, keep = 8, note = '' }) {
  const recent = results.slice(-keep).map(r => `- ${r.isError ? 'ERROR ' : ''}result: ${clip(r.text, perResult)}`).join('\n');
  return [prompts.join('\n\n'),
    `[Context compacted by the bridge: the earlier conversation exceeded the provider's per-request token limit.${note ? ` ${note}` : ''} Re-inspect the working tree (git status / git diff) to see what is already done; do not redo finished work.${recent ? `\nMost recent tool results (clipped):\n${recent}` : ''}]`].join('\n\n');
}
