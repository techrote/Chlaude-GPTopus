/**
 * Pure core of the local OAI configuration panel (scripts/oai-config.mjs):
 * parameter schema, validation (delegating to the plugin's own parsers),
 * environment stores, presets, UI state, locks and the restart-pending marker.
 *
 * Storage:
 *   Windows  - USER environment variables, exactly what the plugin reads at
 *              Claude Code start ([Environment]::Get/SetEnvironmentVariable(n, v, 'User')).
 *   others   - a JSON file ($XDG_CONFIG_HOME/claude-openai-workers/config-env.json);
 *              the plugin does NOT read that file - export the values in your shell profile.
 *   OAI_CONFIG_STORE=<file.json> forces the JSON store anywhere (tests, previews).
 * Panel state (presets, UI windows/caps, locks, pending marker) lives in
 *   %LOCALAPPDATA%\ClaudeOpenAIWorkers (others: $XDG_STATE_HOME/claude-openai-workers),
 *   overridable with OAI_CONFIG_STATE_DIR.
 * API key values are never read, stored, displayed or transmitted by this module.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { WORKER_TYPES, SERVICE_TIERS, EFFORTS, DEFAULT_EFFORT_POLICIES, workerEnvSuffix, workerSettings } from '../bridge/workers.mjs';
import { settings as usageSettings, groupForModel } from '../bridge/usage.mjs';
import { LOCAL_PRICE_ESTIMATES } from '../bridge/openai.mjs';

export const WORKERS = Object.keys(WORKER_TYPES);
export const PRICED_MODELS = Object.keys(LOCAL_PRICE_ESTIMATES);
const W = name => `OPENAI_WORKER_${workerEnvSuffix(name)}_`;
const posNum = v => Number.isFinite(Number(v)) && Number(v) > 0; // hooks/register.js cap() acceptance

// ── schema ────────────────────────────────────────────────────────────────
// kind: int | num | enum | effort | toggle | text | model | path
// bounds = engineering bounds (immutable), window = default slider window,
// notches = preferred values (semantic milestones only), log = log display transform.
function globalParams() {
  return [
    { name: 'OPENAI_WORKER_SERVICE_TIER', group: 'global', label: 'SERVICE TIER', kind: 'enum', options: ['', ...SERVICE_TIERS], def: '',
      help: 'Global OpenAI service tier for workers WITHOUT a built-in tier (sol6-2, astra6-2, luna6). Empty = the API project default.' },
    { name: 'OPENAI_WORKER_MAX_STEPS', group: 'global', label: 'MAX STEPS', kind: 'int', def: 40, bounds: [1, 1000], window: [1, 120], notches: [10, 20, 40, 80, 120], unit: 'steps',
      help: 'Model steps per worker run before the guardrail stops it. Per-worker MAX STEPS overrides this.' },
    { name: 'OPENAI_WORKER_MAX_USD', group: 'global', label: 'MAX USD/RUN', kind: 'num', def: 4, bounds: [0.01, 1000], window: [0.1, 25], log: true, step: 0.01, notches: [0.5, 1, 2, 4, 10, 20], unit: 'USD',
      help: 'Estimated spend per paid-key worker run before it is stopped. Free-key workers ignore it (no cap) unless their own MAX USD is set.' },
    { name: 'OPENAI_WORKER_FLEX_TIMEOUT_MINUTES', group: 'global', label: 'FLEX TIMEOUT', kind: 'int', def: 45, bounds: [1, 120], window: [5, 120], notches: [15, 30, 45, 60, 90, 120], unit: 'min',
      help: 'How long a Flex-tier request may wait. The plugin caps it at 120 minutes.' },
    { name: 'OPENAI_WORKER_PREMIUM_DAILY_TOKENS', group: 'quota', label: 'PREMIUM/DAY', kind: 'int', def: 250000, bounds: [0, 100000000], window: [10000, 5000000], log: true, notches: [100000, 250000, 500000, 1000000], unit: 'tok',
      help: 'Local daily guardrail for the free key, premium model group (astra6free). Local estimate only, not an OpenAI entitlement.' },
    { name: 'OPENAI_WORKER_TERRA_DAILY_TOKENS', group: 'quota', label: 'TERRA/DAY', kind: 'int', def: 2500000, bounds: [0, 100000000], window: [100000, 50000000], log: true, notches: [1000000, 2500000, 5000000, 10000000], unit: 'tok',
      help: 'Local daily guardrail for the free key, mini/terra model group (terra5-6free).' },
    { name: 'OPENAI_WORKER_DAILY_OVERRUN_PERCENT', group: 'quota', label: 'OVERRUN', kind: 'int', def: 10, bounds: [0, 100], window: [0, 100], notches: [0, 5, 10, 25, 50, 100], unit: '%',
      help: 'Headroom above the daily target before admission stops (soft limit = target x (1 + overrun)).' },
    { name: 'OPENAI_WORKER_MONTHLY_LIMIT_USD', group: 'spend', label: 'MONTHLY LIMIT', kind: 'num', def: null, bounds: [0, 100000], window: [1, 1000], log: true, step: 0.01, notches: [10, 25, 50, 100, 250, 500], unit: 'USD', optional: true,
      help: 'ENFORCED: local estimated spend across both keys per UTC month; admission stops at this limit. Empty = no cost blocking.' },
    { name: 'OPENAI_WORKER_MONTHLY_ALLOWANCE_USD', group: 'spend', label: 'ALLOWANCE', kind: 'num', def: null, bounds: [0.01, 100000], window: [1, 1000], log: true, step: 0.01, notches: [10, 25, 50, 100, 250, 500], unit: 'USD', optional: true, informational: true,
      help: 'INFORMATIONAL ONLY: shown as a reference in /oai. It never blocks anything; use MONTHLY LIMIT to enforce.' },
    { name: 'OAI_TRACE', group: 'diag', label: 'LIVE TRACE', kind: 'toggle', def: '',
      help: 'Append every OpenAI request/response (keys redacted) to the trace directory. Follow with scripts/oai-trace.ps1.' },
    { name: 'OAI_STATUS_COLOR', group: 'diag', label: 'STATUS COLOR', kind: 'toggle', def: '',
      help: 'ANSI colour in the /oai status panel.' },
    { name: 'OPENAI_WORKER_DAILY_RESERVE_TOKENS', group: 'advanced', label: 'RESERVE TOKENS', kind: 'int', def: 12000, bounds: [1, 10000000], window: [1000, 200000], log: true, notches: [12000], unit: 'tok',
      help: 'Tokens reserved per free-key request while it is in flight.' },
    { name: 'OPENAI_WORKER_DAILY_MAX_INFLIGHT', group: 'advanced', label: 'MAX IN-FLIGHT', kind: 'int', def: 16, bounds: [1, 128], window: [1, 64], notches: [4, 8, 16, 32, 64], unit: 'req',
      help: 'Concurrent free-key reservations admitted by the daily ledger.' },
    { name: 'OPENAI_WORKER_USAGE_DIR', group: 'advanced', label: 'LEDGER DIR', kind: 'path', def: '',
      help: 'Directory of the local usage ledger. Changing it starts a separate ledger. Empty = default per-user state directory.' },
    { name: 'OAI_TRACE_DIR', group: 'advanced', label: 'TRACE DIR', kind: 'path', def: '',
      help: 'Directory for trace JSONL files. Empty = default per-user state directory.' },
  ];
}
function workerParams(name) {
  const spec = WORKER_TYPES[name], pol = DEFAULT_EFFORT_POLICIES[name], g = `w:${name}`, p = W(name);
  return [
    { name: spec.env, group: g, worker: name, label: 'MODEL', kind: 'model', def: '', builtin: spec.model,
      help: `Model override. Built-in: ${spec.model}. Unpriced models are refused by the spend guard on paid workers; free workers need a model in a free quota group.` },
    { name: `${p}SERVICE_TIER`, group: g, worker: name, label: 'TIER', kind: 'enum', options: ['', ...SERVICE_TIERS], def: '', builtin: spec.defaultTier ?? '',
      help: `Service tier for this worker. Empty = ${spec.defaultTier ? `built-in ${spec.defaultTier}` : 'global SERVICE TIER'}.` },
    { name: `${p}EFFORT_MIN`, group: g, worker: name, label: 'EFFORT MIN', kind: 'effort', def: '', builtin: pol.min, help: 'Lowest reasoning effort a caller may request; lower requests are raised.' },
    { name: `${p}EFFORT_DEFAULT`, group: g, worker: name, label: 'EFFORT DEF', kind: 'effort', def: '', builtin: pol.default, help: 'Effort used when the caller requests none. Must lie within MIN..MAX.' },
    { name: `${p}EFFORT_MAX`, group: g, worker: name, label: 'EFFORT MAX', kind: 'effort', def: '', builtin: pol.max, help: 'Highest reasoning effort; higher requests are lowered.' },
    { name: `${p}MAX_STEPS`, group: g, worker: name, label: 'MAX STEPS', kind: 'int', def: null, optional: true, inherit: 'OPENAI_WORKER_MAX_STEPS', bounds: [1, 1000], window: [1, 120], notches: [10, 20, 40, 80, 120], unit: 'steps',
      help: 'Per-worker step guardrail. Empty = global MAX STEPS.' },
    { name: `${p}MAX_USD`, group: g, worker: name, label: 'MAX USD', kind: 'num', def: null, optional: true, inherit: spec.key === 'free' ? null : 'OPENAI_WORKER_MAX_USD', bounds: [0.01, 1000], window: [0.1, 25], log: true, step: 0.01, notches: [0.5, 1, 2, 4, 10, 20], unit: 'USD',
      help: spec.key === 'free' ? 'Per-run spend guardrail. Empty = none (free key).' : 'Per-run spend guardrail. Empty = global MAX USD.' },
    { name: `${p}EFFORT_NOTE`, group: 'advanced', worker: name, label: `${name.toUpperCase()} NOTE`, kind: 'text', def: '', builtin: pol.note, max: 240,
      help: 'Task-selection note shown to Claude in the worker description (240 chars max). Empty = built-in.' },
  ];
}
export const PARAMS = Object.freeze([...globalParams(), ...WORKERS.flatMap(workerParams)].map(Object.freeze));
export const PARAM = Object.freeze(Object.fromEntries(PARAMS.map(p => [p.name, p])));
export const ALLOWED = Object.freeze(PARAMS.map(p => p.name));
export const GROUPS = Object.freeze([
  { id: 'global', label: 'GLOBAL' }, { id: 'quota', label: 'FREE QUOTA' }, { id: 'spend', label: 'MONTHLY SPEND' },
  { id: 'diag', label: 'DIAGNOSTICS' }, ...WORKERS.map(w => ({ id: `w:${w}`, label: w.toUpperCase(), worker: w })), { id: 'advanced', label: 'ADVANCED' },
]);
export const isAllowed = name => typeof name === 'string' && Object.hasOwn(PARAM, name);

// ── validation ────────────────────────────────────────────────────────────
const fail = (name, message) => { const e = new Error(message); e.param = name; throw e; };
/** Normalise one raw value into its stored string ('' = unset). Throws with .param on error. */
export function normalizeValue(name, raw) {
  if (!isAllowed(name)) fail(name, `${String(name).slice(0, 60)} is not a configurable name.`);
  const p = PARAM[name];
  if (raw === null || raw === undefined) return '';
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') fail(name, 'Value must be a string or number.');
  let v = String(raw).trim();
  if (v === '') return '';
  if (/[\0\r\n]/.test(v)) fail(name, 'Value contains control characters.');
  switch (p.kind) {
    case 'toggle': {
      const on = ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()), off = ['0', 'false', 'no', 'off'].includes(v.toLowerCase());
      if (!on && !off) fail(name, 'Use on/off.');
      return on ? '1' : '';
    }
    case 'enum': v = v.toLowerCase(); if (!p.options.includes(v)) fail(name, `Use ${p.options.filter(Boolean).join(', ')}.`); return v;
    case 'effort': v = v.toLowerCase(); if (!EFFORTS.includes(v)) fail(name, `Use ${EFFORTS.join(', ')} (not ultra).`); return v;
    case 'model': if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(v)) fail(name, 'Invalid model identifier.'); return v;
    case 'text': v = v.replace(/\s+/g, ' '); if (v.length > p.max) fail(name, `${p.max} characters or fewer.`); return v;
    case 'path': if (v.length > 260 || !isAbsolute(v)) fail(name, 'Use an absolute path (260 characters max).'); return v;
    case 'int': case 'num': {
      if (!/^[0-9]*\.?[0-9]+(e[0-9]+)?$/i.test(v)) fail(name, 'Enter a plain non-negative number.');
      const n = Number(v);
      if (!Number.isFinite(n)) fail(name, 'Not a number.');
      if (p.kind === 'int' && !Number.isSafeInteger(n)) fail(name, 'Whole numbers only.');
      if (n < p.bounds[0] || n > p.bounds[1]) fail(name, `Outside engineering bounds ${p.bounds[0]}..${p.bounds[1]}.`);
      return String(n);
    }
  }
  fail(name, 'Unsupported parameter.');
}
/**
 * Validate a complete candidate configuration with the plugin's own parsers
 * (workers.mjs workerSettings/effortPolicy, usage.mjs settings) plus panel rules.
 * Returns { errors: {name: msg}, warnings: {name: msg} }.
 */
export function validateConfig(values) {
  const errors = {}, warnings = {};
  const env = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
  for (const [name, v] of Object.entries(values)) {
    try { normalizeValue(name, v); } catch (e) { errors[name] = e.message; }
  }
  try { usageSettings(env); } catch (e) { errors.OPENAI_WORKER_PREMIUM_DAILY_TOKENS ??= e.message; }
  for (const name of ['OPENAI_WORKER_MAX_STEPS', 'OPENAI_WORKER_MAX_USD', 'OPENAI_WORKER_FLEX_TIMEOUT_MINUTES', ...WORKERS.flatMap(w => [`${W(w)}MAX_STEPS`, `${W(w)}MAX_USD`])]) {
    if (env[name] !== undefined && !posNum(env[name]) && !errors[name]) errors[name] = 'Must be greater than zero (the plugin ignores zero).';
  }
  for (const w of WORKERS) {
    try { workerSettings(w, env); } catch (e) {
      const p = W(w), msg = e.message;
      const target = /service tier/i.test(msg) ? `${p}SERVICE_TIER` : /NOTE/.test(msg) ? `${p}EFFORT_NOTE`
        : /min .* exceeds max/i.test(msg) ? `${p}EFFORT_MIN` : /Default effort/i.test(msg) ? `${p}EFFORT_DEFAULT`
        : /does not support/i.test(msg) ? `${p}EFFORT_MIN` : /EFFORT_MAX/.test(msg) ? `${p}EFFORT_MAX` : /EFFORT_DEFAULT/.test(msg) ? `${p}EFFORT_DEFAULT` : `${p}EFFORT_MIN`;
      errors[target] ??= msg;
    }
    const spec = WORKER_TYPES[w], model = env[spec.env] || spec.model;
    if (!Object.hasOwn(LOCAL_PRICE_ESTIMATES, model)) {
      warnings[spec.env] = spec.key === 'standard' ? `${model} has no local price: the paid spend guard will REFUSE requests.` : `${model} has no local price estimate (cost shows as unknown).`;
    }
    if (spec.key === 'free' && !groupForModel(model)) warnings[spec.env] = `${model} is in no free quota group: free-key requests will be refused.`;
  }
  return { errors, warnings };
}
/** Effective runtime values the plugin would use for this configuration (requested vs effective). */
export function effectiveConfig(values) {
  const env = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
  const cap = (v, fb) => posNum(v) ? Number(v) : fb;
  const out = { workers: {}, global: {} };
  out.global.maxSteps = cap(env.OPENAI_WORKER_MAX_STEPS, 40);
  out.global.maxUsd = cap(env.OPENAI_WORKER_MAX_USD, 4);
  out.global.flexMinutes = Math.min(120, cap(env.OPENAI_WORKER_FLEX_TIMEOUT_MINUTES, 45));
  try { const s = usageSettings(env); out.global.quota = s; } catch { out.global.quota = null; }
  for (const w of WORKERS) {
    const spec = WORKER_TYPES[w], p = W(w);
    let ws = null, error = null;
    try { ws = workerSettings(w, env); } catch (e) { error = e.message; }
    const maxUsd = cap(env[`${p}MAX_USD`], spec.key === 'free' ? null : out.global.maxUsd);
    out.workers[w] = { model: ws?.model ?? (env[spec.env] || spec.model), tier: ws ? (ws.service_tier ?? 'project default') : null, effort: ws?.effort_policy ?? null,
      maxSteps: cap(env[`${p}MAX_STEPS`], out.global.maxSteps), maxUsd, key: spec.key, priced: Object.hasOwn(LOCAL_PRICE_ESTIMATES, ws?.model ?? spec.model), error };
  }
  return out;
}

// ── stores (fake / JSON / Windows user environment) ───────────────────────
export function memoryStore(initial = {}) {
  const data = { ...initial };
  return { kind: 'memory', location: 'memory', read: names => Object.fromEntries(names.map(n => [n, data[n] ?? ''])),
    write: changes => { for (const [n, v] of Object.entries(changes)) { if (v === '') delete data[n]; else data[n] = v; } }, data };
}
export function jsonStore(file) {
  const load = () => { try { const d = JSON.parse(readFileSync(file, 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; } };
  return { kind: 'json', location: file,
    read: names => { const d = load(); return Object.fromEntries(names.map(n => [n, typeof d[n] === 'string' ? d[n] : ''])); },
    write: changes => { const d = load(); for (const [n, v] of Object.entries(changes)) { if (v === '') delete d[n]; else d[n] = v; } atomicWrite(file, JSON.stringify(d, null, 2) + '\n'); } };
}
/** Windows USER environment through PowerShell; names are allowlisted, values travel via stdin JSON. */
export function windowsUserStore(run = (script, input) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, encoding: 'utf8', windowsHide: true, timeout: 30000 })) {
  const guard = names => { for (const n of names) if (!isAllowed(n)) throw new Error(`Refusing non-allowlisted name ${String(n).slice(0, 60)}.`); };
  return { kind: 'windows-user-env', location: 'HKCU\\Environment (Windows user environment variables)',
    read: names => {
      guard(names);
      const script = '$n = [Console]::In.ReadToEnd() | ConvertFrom-Json; $o = @{}; foreach ($k in $n) { $v = [Environment]::GetEnvironmentVariable($k, \'User\'); if ($v -ne $null) { $o[$k] = $v } }; [Console]::Out.Write(($o | ConvertTo-Json -Compress))';
      const text = run(script, JSON.stringify(names)).trim();
      const d = text ? JSON.parse(text) : {};
      return Object.fromEntries(names.map(n => [n, typeof d[n] === 'string' ? d[n] : '']));
    },
    write: changes => {
      guard(Object.keys(changes));
      const script = '$c = [Console]::In.ReadToEnd() | ConvertFrom-Json; foreach ($p in $c.PSObject.Properties) { $v = [string]$p.Value; if ($v -eq \'\') { $v = $null }; [Environment]::SetEnvironmentVariable($p.Name, $v, \'User\') }';
      run(script, JSON.stringify(changes));
    } };
}
export function defaultStore(env = process.env, platform = process.platform) {
  if (env.OAI_CONFIG_STORE) return jsonStore(env.OAI_CONFIG_STORE);
  if (platform === 'win32') return windowsUserStore();
  return jsonStore(join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'claude-openai-workers', 'config-env.json'));
}
export function stateDir(env = process.env, platform = process.platform) {
  if (env.OAI_CONFIG_STATE_DIR) return env.OAI_CONFIG_STATE_DIR;
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'ClaudeOpenAIWorkers');
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'claude-openai-workers');
}
export function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text); renameSync(tmp, file);
}
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };

/** Apply a batch atomically: normalise, validate the merged config, then write only changed names. */
export function applyChanges(store, changes, { state, now = new Date() } = {}) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw Object.assign(new Error('changes must be an object.'), { status: 400 });
  const names = Object.keys(changes);
  if (!names.length || names.length > ALLOWED.length) throw Object.assign(new Error('Nothing to change.'), { status: 400 });
  const normalized = {}, errors = {};
  for (const n of names) { try { normalized[n] = normalizeValue(n, changes[n]); } catch (e) { errors[n] = e.message; } }
  if (Object.keys(errors).length) return { ok: false, errors };
  const current = store.read(ALLOWED), merged = { ...current, ...normalized };
  const check = validateConfig(merged);
  const relevant = Object.fromEntries(Object.entries(check.errors).filter(([n]) => names.includes(n) || !validateConfig(current).errors[n]));
  if (Object.keys(relevant).length) return { ok: false, errors: relevant };
  const diff = Object.fromEntries(Object.entries(normalized).filter(([n, v]) => current[n] !== v));
  if (Object.keys(diff).length) {
    store.write(diff);
    if (state) markPending(state, Object.fromEntries(Object.keys(diff).map(n => [n, { from: current[n], to: diff[n] }])), now);
  }
  return { ok: true, changed: Object.keys(diff), warnings: check.warnings };
}

// ── restart-pending marker ────────────────────────────────────────────────
const pendingFile = dir => join(dir, 'config-pending.json');
export function markPending(dir, changes, now = new Date()) {
  const doc = readJson(pendingFile(dir), null);
  const cur = doc && doc.changes && typeof doc.changes === 'object' ? doc : { version: 1, since: new Date(now).toISOString(), changes: {} };
  for (const [n, c] of Object.entries(changes)) {
    const prior = cur.changes[n];
    cur.changes[n] = { at: new Date(now).toISOString(), from: prior ? prior.from : c.from, to: c.to };
    if (cur.changes[n].from === cur.changes[n].to) delete cur.changes[n]; // reverted to the value the session started with
  }
  if (!Object.keys(cur.changes).length) { rmSync(pendingFile(dir), { force: true }); return null; }
  atomicWrite(pendingFile(dir), JSON.stringify(cur, null, 2) + '\n');
  return cur;
}
/** Current marker or null; honours the owner's optional auto-clear window (ui.autoClearMinutes). */
export function readPending(dir, now = new Date(), ui = readUi(dir)) {
  const doc = readJson(pendingFile(dir), null);
  if (!doc || !doc.changes || !Object.keys(doc.changes).length) return null;
  const minutes = Number(ui.autoClearMinutes) || 0;
  if (minutes > 0) {
    const last = Math.max(...Object.values(doc.changes).map(c => Date.parse(c.at) || 0));
    if (new Date(now).getTime() - last >= minutes * 60000) { clearPending(dir); return null; }
  }
  return doc;
}
export function clearPending(dir) { rmSync(pendingFile(dir), { force: true }); }

// ── UI state: slider windows, safety caps, alignment modes, locks ─────────
const uiFile = dir => join(dir, 'config-ui.json');
const ALIGN = ['free', 'indicate', 'notched', 'forced'];
export const DEFAULT_UI = Object.freeze({ version: 1, params: {}, locks: {}, autoClearMinutes: 0, tooltips: true });
export function readUi(dir) { const doc = readJson(uiFile(dir), null); return sanitizeUi(doc ?? {}).ui; }
/** Validate a whole UI document; returns { ui, errors }. Engineering bounds always win. */
export function sanitizeUi(doc) {
  const ui = { version: 1, params: {}, locks: {}, autoClearMinutes: 0, tooltips: true }, errors = {};
  if (!doc || typeof doc !== 'object') return { ui, errors };
  for (const [name, s] of Object.entries(doc.params ?? {})) {
    const p = PARAM[name];
    if (!p || !p.bounds || !s || typeof s !== 'object') continue;
    const [lo, hi] = p.bounds, out = {};
    const pair = v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) && v[0] < v[1] ? v : null;
    const caps = pair(s.caps), win = pair(s.window);
    if (caps) { if (caps[0] < lo || caps[1] > hi) errors[name] = `Safety caps must stay within engineering bounds ${lo}..${hi}.`; else out.caps = caps; }
    if (win) { const c = out.caps ?? p.bounds; if (win[0] < c[0] || win[1] > c[1]) errors[name] = 'Slider window must lie within the safety caps.'; else out.window = win; }
    if (ALIGN.includes(s.align)) out.align = s.align;
    if (Object.keys(out).length) ui.params[name] = out;
  }
  for (const [g, v] of Object.entries(doc.locks ?? {})) if (GROUPS.some(x => x.id === g) && v === true) ui.locks[g] = true;
  const m = Number(doc.autoClearMinutes); if (Number.isInteger(m) && m >= 0 && m <= 1440) ui.autoClearMinutes = m;
  if (doc.tooltips === false) ui.tooltips = false;
  return { ui, errors };
}
/** Save UI state; refuses caps that would exclude the current value (spec 1.1). */
export function writeUi(dir, doc, values) {
  const { ui, errors } = sanitizeUi(doc);
  for (const [name, s] of Object.entries(ui.params)) {
    const v = values?.[name];
    if (s.caps && v !== undefined && v !== '' && (Number(v) < s.caps[0] || Number(v) > s.caps[1])) errors[name] = `Caps ${s.caps[0]}..${s.caps[1]} would exclude the current value ${v}.`;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  atomicWrite(uiFile(dir), JSON.stringify(ui, null, 2) + '\n');
  return { ok: true, ui };
}
/** Direct-entry check against the user's active safety caps (stricter than engineering bounds). */
export function capErrors(changes, ui) {
  const errors = {};
  for (const [n, v] of Object.entries(changes)) {
    const caps = ui.params[n]?.caps;
    if (caps && v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) && (Number(v) < caps[0] || Number(v) > caps[1])) errors[n] = `Outside active safety caps ${caps[0]}..${caps[1]} (edit caps in the info panel).`;
  }
  return errors;
}

// ── presets ───────────────────────────────────────────────────────────────
const presetDir = dir => join(dir, 'config-presets');
const PRESET_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,47}$/;
export const BUILTIN_PRESETS = Object.freeze({
  FACTORY: { description: 'Every value unset: the plugin\'s built-in defaults.', values: {} },
  THRIFTY: { description: 'Flex by default, tight per-run caps, lower efforts on the big workers.', values: {
    OPENAI_WORKER_SERVICE_TIER: 'flex', OPENAI_WORKER_MAX_STEPS: '25', OPENAI_WORKER_MAX_USD: '1', OPENAI_WORKER_MONTHLY_LIMIT_USD: '25',
    OPENAI_WORKER_SOL6_2_EFFORT_DEFAULT: 'medium', OPENAI_WORKER_ASTRA6_2_EFFORT_DEFAULT: 'medium' } },
  DEEP: { description: 'Long, thorough runs: more steps, larger caps, xhigh defaults on Sol and Astra.', values: {
    OPENAI_WORKER_MAX_STEPS: '100', OPENAI_WORKER_MAX_USD: '12', OPENAI_WORKER_FLEX_TIMEOUT_MINUTES: '120',
    OPENAI_WORKER_SOL6_2_EFFORT_DEFAULT: 'xhigh', OPENAI_WORKER_ASTRA6_2_EFFORT_DEFAULT: 'xhigh', OPENAI_WORKER_SOL6_1FLEX_EFFORT_DEFAULT: 'xhigh' } },
});
export function listPresets(dir) {
  const user = [];
  try {
    for (const f of readdirSync(presetDir(dir)).filter(f => f.endsWith('.json')).sort()) {
      const doc = readJson(join(presetDir(dir), f), null);
      if (doc && doc.version === 1 && typeof doc.name === 'string') user.push({ name: doc.name, savedAt: doc.savedAt ?? null, builtin: false });
    }
  } catch { /* none yet */ }
  return [...Object.entries(BUILTIN_PRESETS).map(([name, p]) => ({ name, description: p.description, builtin: true })), ...user];
}
const presetPath = (dir, name) => {
  if (typeof name !== 'string' || !PRESET_NAME.test(name)) throw Object.assign(new Error('Preset names: 1-48 letters, digits, space, _ . -'), { status: 400 });
  return join(presetDir(dir), `${name.replace(/[ .]/g, '_')}.json`);
};
export function savePreset(dir, name, values, now = new Date()) {
  if (Object.hasOwn(BUILTIN_PRESETS, name)) throw Object.assign(new Error('Built-in preset names are reserved.'), { status: 400 });
  const snapshot = Object.fromEntries(ALLOWED.filter(n => values[n] !== undefined && values[n] !== '').map(n => [n, values[n]]));
  atomicWrite(presetPath(dir, name), JSON.stringify({ version: 1, name, savedAt: new Date(now).toISOString(), values: snapshot }, null, 2) + '\n');
  return { name, count: Object.keys(snapshot).length };
}
export function readPreset(dir, name) {
  if (Object.hasOwn(BUILTIN_PRESETS, name)) return { name, values: { ...BUILTIN_PRESETS[name].values } };
  const doc = readJson(presetPath(dir, name), null);
  if (!doc || doc.version !== 1 || !doc.values || typeof doc.values !== 'object') throw Object.assign(new Error('Preset not found or unreadable.'), { status: 404 });
  return { name: doc.name, values: Object.fromEntries(Object.entries(doc.values).filter(([n, v]) => isAllowed(n) && typeof v === 'string')) };
}
export function deletePreset(dir, name) {
  if (Object.hasOwn(BUILTIN_PRESETS, name)) throw Object.assign(new Error('Built-in presets cannot be deleted.'), { status: 400 });
  rmSync(presetPath(dir, name), { force: true });
}
/** Changes needed to load a whole-config preset, skipping locked groups unless overridden (locks are not mutated). */
export function presetChanges(preset, current, locks = {}, overrideLocks = false) {
  const changes = {}, skipped = [];
  for (const p of PARAMS) {
    const target = preset.values[p.name] ?? '';
    if (target === (current[p.name] ?? '')) continue;
    if (locks[p.group] && !overrideLocks) { skipped.push(p.name); continue; }
    changes[p.name] = target;
  }
  return { changes, skipped };
}

// ── request guards ────────────────────────────────────────────────────────
export const newToken = () => randomBytes(24).toString('hex');
export function tokenOk(expected, given) {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
/** DNS-rebinding / CSRF guard: Host must be our loopback origin; Origin (when sent) must match. */
export function originOk(headers, port) {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes(String(headers.host ?? '').toLowerCase())) return false;
  const origin = headers.origin;
  if (origin !== undefined && !allowed.map(h => `http://${h}`).includes(String(origin).toLowerCase())) return false;
  const site = headers['sec-fetch-site'];
  if (site !== undefined && !['same-origin', 'none'].includes(site)) return false;
  return true;
}
