/**
 * Optional live trace of what the bridge sends to and receives from OpenAI.
 * Enabled only by OAI_TRACE=1 in the BRIDGE process environment. Appends one
 * JSON object per line to <state>/trace/YYYY-MM-DD.jsonl (UTC day):
 *   Windows: %LOCALAPPDATA%\ClaudeOpenAIWorkers\trace
 *   others:  $XDG_STATE_HOME/claude-openai-workers/trace (default ~/.local/state)
 * OAI_TRACE_DIR overrides the directory. API keys and auth headers are never
 * written: records are built from request/response bodies only, and any
 * key-shaped or configured-key string is replaced with [redacted].
 * Tracing never throws into the caller; a failed write is silently dropped.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAX_STRING = 200_000;
const SECRET_FIELD = /^(authorization|api[_-]?key|x-api-key|bearer|password|secret|token)$/i;
const KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{16,}|sess-[A-Za-z0-9_-]{16,})\b/g;

export function traceEnabled(env = process.env) { return ['1', 'true', 'yes', 'on'].includes(String(env.OAI_TRACE ?? '').trim().toLowerCase()); }

export function traceDir(env = process.env, platform = process.platform) {
  if (env.OAI_TRACE_DIR) return env.OAI_TRACE_DIR;
  if (platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'ClaudeOpenAIWorkers', 'trace');
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'claude-openai-workers', 'trace');
}
export const traceFile = (env = process.env, now = new Date(), platform = process.platform) =>
  join(traceDir(env, platform), `${new Date(now).toISOString().slice(0, 10)}.jsonl`);

/** Deep copy with secret fields dropped and key-shaped / configured-key strings masked. */
export function redact(value, env = process.env) {
  const known = [env.OPENAI_API_KEY, env.OPENAI_FREE_API_KEY].map(k => typeof k === 'string' ? k.trim() : '').filter(k => k.length >= 8);
  const scrub = text => {
    let out = String(text);
    for (const key of known) out = out.split(key).join('[redacted]');
    out = out.replace(KEY_PATTERN, '[redacted]');
    return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated ${out.length - MAX_STRING} chars]` : out;
  };
  const walk = (v, depth) => {
    if (typeof v === 'string') return scrub(v);
    if (v === null || typeof v !== 'object') return v;
    if (depth > 12) return '[depth limit]';
    if (Array.isArray(v)) return v.map(item => walk(item, depth + 1));
    const out = {};
    for (const [k, item] of Object.entries(v)) out[k] = SECRET_FIELD.test(k) ? '[redacted]' : walk(item, depth + 1);
    return out;
  };
  return walk(value, 0);
}

export function writeTrace(record, options = {}) {
  const env = options.env ?? process.env;
  if (!traceEnabled(env)) return false;
  try {
    const now = options.now ?? new Date();
    const file = traceFile(env, now, options.platform);
    mkdirSync(traceDir(env, options.platform), { recursive: true });
    appendFileSync(file, `${JSON.stringify(redact({ time: new Date(now).toISOString(), ...record }, env))}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch { return false; }
}

/** One record per create: who, which model/tier/effort, and what was sent. */
export function traceRequest(selected, effective, options = {}) {
  return writeTrace({ kind: 'request', worker: selected?.name ?? null, model: effective?.model ?? null,
    tier: effective?.service_tier ?? 'project default', effort: effective?.effort ?? null,
    previousResponseId: effective?.previous_response_id ?? null,
    instructions: effective?.instructions ?? null, input: effective?.input ?? null,
    tools: Array.isArray(effective?.tools) ? effective.tools.map(t => t?.name ?? t?.type ?? '?') : [] }, options);
}
/** One record per completed (or failed) response. */
export function traceResponse(worker, response, options = {}) {
  return writeTrace({ kind: 'response', worker: worker ?? null, id: response?.id ?? null, status: response?.status ?? null,
    model: response?.model ?? null, tier: response?.serviceTier ?? null, text: response?.text ?? '',
    toolCalls: Array.isArray(response?.calls) ? response.calls.map(c => ({ name: c.name, call_id: c.call_id, args: c.args })) : [],
    usage: response?.usage ?? null, estimatedUsd: response?.estimatedUsd ?? null, reason: response?.reason ?? null }, options);
}
