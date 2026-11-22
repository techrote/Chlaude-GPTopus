/**
 * Chat-completions transport for the provider workers (NVIDIA Build, local LM Studio).
 *
 * Mirrors the createTurn / pollTurn / cancelTurn contract that bridge/server.mjs dispatch uses for OpenAI:
 *   create(args) appends the step's input to an editable conversation (bridge/convo.mjs), starts a STREAMING request in the
 *   background and returns { id: 'chat_<conv>_<rev>', status: 'in_progress' } at once;
 *   poll(id, { wait_ms }) returns the normalized response the mod already understands (see hooks/step.js responseStep);
 *   cancel(id) aborts the stream.
 * Every request replays the CURRENT stored conversation, so operator edits apply to the very next step. The model's own
 * reasoning is stored on the assistant message (`reasoning`) and is never sent back as content.
 *
 * Thought-steering: while a stream is still reasoning (no answer tokens yet) the transport checks the run's steering inbox
 * (bridge/steer.mjs) every ~300 ms. A tip that arrives then aborts the stream and restarts it at once:
 *   'think' mode: same history + an assistant prefill "<think>\n<partial reasoning>\n[Operator note: <tip>]\n" which the model
 *                 continues; text before "</think>" is reasoning, after it the answer.
 *   'user' mode:  the tip is appended as a user message (steer: true) and the request restarts.
 *
 * No API key is ever written to the conversation, trace or steer log, nor included in an error.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { workerSpec, workerSettings, canonicalWorker, selectWorkerEffort, thinkingParams, EFFORTS } from './workers.mjs';
import { getKey } from './openai.mjs';
import { writeTrace } from './trace.mjs';
import * as convoStore from './convo.mjs';
import * as steerStore from './steer.mjs';
import * as rotation from './rotation.mjs';

export const DEFAULT_LMSTUDIO_URL = 'http://127.0.0.1:1234/v1';
export const DEFAULT_NVIDIA_URL = 'https://integrate.api.nvidia.com/v1';
export const MAX_THOUGHT_STEERS = 8;
/** One response's streamed answer + reasoning + tool-call arguments may not exceed this (a looping model is cut off). */
export const MAX_STREAM_CHARS = 4_000_000;
export const DEFAULT_MAX_TOKENS = 16000;
const SAFE_AGENT = /^[A-Za-z0-9_.:-]{1,128}$/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function providerUrl(provider, env = process.env) {
  const raw = provider === 'nvidia' ? (env.OAI_NVIDIA_URL || DEFAULT_NVIDIA_URL) : (env.OAI_LMSTUDIO_URL || DEFAULT_LMSTUDIO_URL);
  return String(raw).trim().replace(/\/+$/, '');
}
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const truthy = v => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
export const isLoopbackUrl = base => { try { return LOOPBACK.has(new URL(base).hostname.toLowerCase()); } catch { return false; } };
/**
 * Where a provider request may go. The NVIDIA key only travels over https to integrate.api.nvidia.com unless the owner opts
 * in with OAI_NVIDIA_URL_ALLOW_CUSTOM=1 (still https, or plain http to a loopback host). LM Studio conversations stay on
 * this PC (loopback) unless OAI_LMSTUDIO_ALLOW_REMOTE=1. Throws a short reason otherwise.
 */
export function checkProviderUrl(provider, base, env = process.env) {
  let u;
  try { u = new URL(base); } catch { throw new Error(`${provider === 'nvidia' ? 'OAI_NVIDIA_URL' : 'OAI_LMSTUDIO_URL'} is not a valid URL.`); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Provider URL must be a plain http(s) URL without credentials.');
  const host = u.hostname.toLowerCase();
  if (provider === 'nvidia') {
    const custom = truthy(env.OAI_NVIDIA_URL_ALLOW_CUSTOM);
    if (u.protocol !== 'https:' && !(custom && LOOPBACK.has(host))) throw new Error('OAI_NVIDIA_URL must use https: the NVIDIA key is never sent in clear text.');
    if (!custom && host !== 'integrate.api.nvidia.com') throw new Error('OAI_NVIDIA_URL must point at integrate.api.nvidia.com; set OAI_NVIDIA_URL_ALLOW_CUSTOM=1 to send the NVIDIA key to another host.');
  } else if (!LOOPBACK.has(host) && !truthy(env.OAI_LMSTUDIO_ALLOW_REMOTE)) {
    throw new Error('OAI_LMSTUDIO_URL must be a loopback address (127.0.0.1, localhost or [::1]) so conversations stay on this PC; set OAI_LMSTUDIO_ALLOW_REMOTE=1 to use another host.');
  }
  return base;
}
export const lmsPath = (env = process.env) => join(env.USERPROFILE || env.HOME || homedir(), '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms');

// ---- format conversion --------------------------------------------------------------------------------------------
/** Responses-format function tools ({type, name, description, parameters}) to chat format. */
export function toChatTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.filter(t => t && (t.type === 'function' || t.function)).map(t => t.function
    ? { type: 'function', function: { name: t.function.name, description: t.function.description ?? '', parameters: t.function.parameters ?? { type: 'object', properties: {} } } }
    : { type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } } });
}
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(c => typeof c === 'string' ? c : c?.text ?? c?.output_text ?? '').join('') : content == null ? '' : String(content);

/**
 * The newest assistant tool-call group whose results may still arrive: { ids (unanswered call ids), at (where results go) }.
 * Operator steering / edited user or system text after the group does not close it; any other message does.
 */
function openCalls(messages) {
  let i = messages.length - 1;
  while (i >= 0 && (messages[i].role === 'user' || messages[i].role === 'system') && (messages[i].steer || messages[i].edited)) i--;
  const at = i + 1;
  let j = i;
  while (j >= 0 && messages[j].role === 'tool') j--;
  const m = messages[j];
  if (m?.role === 'assistant' && m.tool_calls?.length) {
    const answered = new Set(messages.slice(j + 1, at).map(t => t.tool_call_id));
    return { ids: new Set(m.tool_calls.map(c => c.id).filter(id => !answered.has(id))), at };
  }
  return { ids: new Set(), at: messages.length };
}

function convertInput(input, open) {
  const tools = [], users = [];
  if (typeof input === 'string') { if (input.trim()) users.push({ role: 'user', content: input }); return { tools, users }; }
  if (!Array.isArray(input)) return { tools, users };
  for (const item of input) {
    if (item?.type === 'function_call_output') {
      const id = String(item.call_id ?? ''), output = textOf(item.output);
      // A result whose call was edited away (or is otherwise unmatched) still reaches the model, as plain text.
      if (open.has(id)) { tools.push({ role: 'tool', tool_call_id: id, content: output }); open.delete(id); }
      else users.push({ role: 'user', content: `[Tool result for call ${id}]\n${output}` });
    } else if (item && (item.role === 'user' || item.role === 'developer' || item.role === 'system' || item.type === 'message')) {
      const text = textOf(item.content);
      if (text.trim()) users.push({ role: 'user', content: text });
    }
  }
  return { tools, users };
}

/** Convert a step's Responses-style input into chat messages to append (tool results first, then user text). */
export function inputToMessages(input, stored = []) {
  const { tools, users } = convertInput(input, openCalls(stored).ids);
  return [...tools, ...users];
}

/**
 * The conversation after adding one step's input. previous_response_id is a rollback point: messages added by any LATER
 * step (tagged with a turn id whose rev is above afterRev) belong to an abandoned attempt (cancelled for a hard tip,
 * failed for a rate limit, or superseded) and are dropped before the resent input is added, so a resend never doubles the
 * input or keeps an orphaned tool call. Operator text from those steps (edited, or thought-steer user messages) is kept
 * and moved after the new input. Untagged messages (operator inserts) always stay where they are.
 * Tool results go directly after their tool-call group; new messages are tagged with `tag`.
 */
export function applyStep(stored, input, { afterRev = null, tag = null } = {}) {
  let base = stored, dropped = 0;
  const carried = [];
  if (Number.isInteger(afterRev)) {
    base = [];
    for (const m of stored) {
      const rev = m.turn ? convoStore.parseTurnId(m.turn)?.rev : null;
      if (rev === null || rev === undefined || rev <= afterRev) base.push(m);
      else if ((m.role === 'user' || m.role === 'system') && (m.edited || m.steer)) carried.push(m);
      else dropped++;
    }
  }
  const { ids, at } = openCalls(base);
  const { tools, users } = convertInput(input, ids);
  const stamp = m => (tag ? { ...m, turn: tag } : m);
  return { messages: [...base.slice(0, at), ...tools.map(stamp), ...base.slice(at), ...users.map(stamp), ...carried],
    added: tools.length + users.length, dropped };
}

/** Stored conversation to provider messages: content + tool_calls only (never reasoning), with tool pairing repaired. */
export function toRequestMessages(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') { out.push({ role: 'user', content: `[Tool result for call ${m.tool_call_id}]\n${m.content ?? ''}` }); continue; }
    if (m.role === 'assistant') {
      const a = { role: 'assistant', content: m.content ?? '' };
      if (m.tool_calls?.length) {
        a.tool_calls = m.tool_calls.map(c => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } }));
        out.push(a);
        const seen = new Set(), stray = [];
        let j = i + 1;
        for (; j < messages.length && messages[j].role === 'tool'; j++) {
          const t = messages[j];
          if (a.tool_calls.some(c => c.id === t.tool_call_id) && !seen.has(t.tool_call_id)) { out.push({ role: 'tool', tool_call_id: t.tool_call_id, content: t.content ?? '' }); seen.add(t.tool_call_id); }
          else stray.push({ role: 'user', content: `[Tool result for call ${t.tool_call_id}]\n${t.content ?? ''}` });
        }
        // A tool call must always be answered before the conversation continues.
        for (const c of a.tool_calls.filter(c => !seen.has(c.id))) out.push({ role: 'tool', tool_call_id: c.id, content: 'ERROR: no result was recorded for this tool call.' });
        out.push(...stray);
        i = j - 1;
        continue;
      }
      out.push(a);
      continue;
    }
    out.push({ role: m.role, content: m.content ?? '' });
  }
  return out;
}

/**
 * Split "<think>...</think>answer" (or a prefilled continuation "...</think>answer"). implicitOpen: a template that put
 * "<think>" into the generation prompt makes the model emit "reasoning...</think>answer" with no opening tag; the text before
 * a lone "</think>" is then reasoning too (callers pass false when the provider already separated the reasoning).
 */
export function splitThink(content, { prefilled = false, implicitOpen = true } = {}) {
  const text = String(content ?? '');
  const close = text.indexOf('</think>');
  // A prefilled continuation is reasoning until the model closes its thought.
  if (prefilled) return close < 0 ? { reasoning: text, answer: '', closed: false } : { reasoning: text.slice(0, close), answer: text.slice(close + 8), closed: true };
  const lead = /^\s*<think>/.exec(text);
  if (!lead) {
    if (implicitOpen && close >= 0 && !text.slice(0, close).includes('<think>')) return { reasoning: text.slice(0, close), answer: text.slice(close + 8), closed: true };
    return { reasoning: '', answer: text, closed: true };
  }
  const rest = text.slice(lead[0].length), end = rest.indexOf('</think>');
  return end < 0 ? { reasoning: rest, answer: '', closed: false } : { reasoning: rest.slice(0, end), answer: rest.slice(end + 8), closed: true };
}

// ---- SSE ---------------------------------------------------------------------------------------------------------
/** Feed decoded text; returns parsed JSON events (and 'done' when [DONE] arrives). Keeps partial lines buffered. */
export function sseParser() {
  let buffer = '';
  return text => {
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    const events = [];
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') { events.push('done'); continue; }
      try { events.push(JSON.parse(data)); } catch { /* ignore malformed keep-alive fragments */ }
    }
    return events;
  };
}
/** Accumulates chat.completion.chunk deltas (content, reasoning_content, tool_calls by index). */
export function deltaAccumulator() {
  const s = { content: '', reasoning: '', toolCalls: [], usage: null, finish: null, model: null, error: null };
  s.add = chunk => {
    if (chunk?.error) { s.error = String(chunk.error.message ?? chunk.error).slice(0, 300); return; }
    if (chunk?.model) s.model = chunk.model;
    if (chunk?.usage) s.usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? choice.message ?? {};
    if (typeof d.reasoning_content === 'string') s.reasoning += d.reasoning_content;
    else if (typeof d.reasoning === 'string') s.reasoning += d.reasoning;
    if (typeof d.content === 'string') s.content += d.content;
    if (Array.isArray(d.tool_calls)) d.tool_calls.forEach((tc, pos) => {
      const idx = Number.isInteger(tc.index) ? tc.index : pos;
      const entry = s.toolCalls[idx] ??= { id: '', name: '', arguments: '' };
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name += tc.function.name;
      if (typeof tc.function?.arguments === 'string') entry.arguments += tc.function.arguments;
      else if (tc.function?.arguments && typeof tc.function.arguments === 'object') entry.arguments += JSON.stringify(tc.function.arguments);
    });
    if (choice.finish_reason) s.finish = choice.finish_reason;
  };
  return s;
}

function usageOf(u) {
  const ok = v => Number.isSafeInteger(v) && v >= 0;
  if (!u || !ok(u.prompt_tokens) || !ok(u.completion_tokens)) return null;
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  return { input: u.prompt_tokens, cached: 0, output: u.completion_tokens, total: ok(u.total_tokens) ? u.total_tokens : u.prompt_tokens + u.completion_tokens,
    ...(ok(reasoning) && { reasoning }) };
}
const streamChars = acc => acc.content.length + acc.reasoning.length + acc.toolCalls.reduce((n, tc) => n + (tc?.arguments?.length ?? 0), 0);
const scrubKey = (text, key) => key ? String(text).split(key).join('[redacted]') : String(text);

// ---- transport ---------------------------------------------------------------------------------------------------
export function createChat(defaults = {}) {
  const turns = new Map();
  const startingLms = new Map(); // base URL -> the one start attempt's promise (concurrent callers share it)
  const opts = o => ({ ...defaults, ...o });

  async function post(url, body, key, signal, o) {
    const doFetch = o.fetchFn ?? fetch;
    return doFetch(url, { method: 'POST', signal, body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(key && { Authorization: `Bearer ${key}` }) } });
  }
  /**
   * LM Studio not listening: start its server once per transport and URL (no shell, hidden window, asynchronous so the
   * bridge keeps serving other workers), then wait for /models. Concurrent callers await the same attempt.
   */
  function startLmStudio(base, o) {
    if (!isLoopbackUrl(base)) return Promise.resolve(false);
    if (!startingLms.has(base)) startingLms.set(base, (async () => {
      const exe = o.lmsPath ?? lmsPath(o.env);
      if (!o.spawnFn && !existsSync(exe)) return false;
      const launch = o.spawnFn ?? ((file, args, options) => new Promise(resolve => { execFile(file, args, options, () => resolve()); }));
      // "lms server start" asks the LM Studio daemon to listen and then exits; bounded by its own timeout.
      try { await launch(exe, ['server', 'start'], { shell: false, windowsHide: true, stdio: 'ignore', timeout: 20_000 }); }
      catch { /* it may still have started; the readiness probe below decides */ }
      const doFetch = o.fetchFn ?? fetch;
      const until = Date.now() + (o.lmsStartWaitMs ?? 30_000);
      while (Date.now() < until) {
        try { const r = await doFetch(`${base}/models`, { method: 'GET', signal: AbortSignal.timeout(3000) }); if (r.ok) return true; } catch {}
        await pause(o.lmsPollMs ?? 1000);
      }
      return false;
    })());
    return startingLms.get(base);
  }
  const abortable = (promise, signal) => Promise.race([promise, new Promise(resolve => {
    if (signal.aborted) resolve(false); else signal.addEventListener('abort', () => resolve(false), { once: true });
  })]);

  async function streamOnce(turn, body, o, hooks) {
    const base = checkProviderUrl(turn.provider, providerUrl(turn.provider, o.env), o.env);
    const ctl = new AbortController();
    turn.controller = ctl;
    const idleMs = Math.max(1000, (Number(o.env.OAI_CHAT_IDLE_SECONDS) > 0 ? Number(o.env.OAI_CHAT_IDLE_SECONDS) : 600) * 1000);
    let idleTimer = null, stalled = false;
    const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { stalled = true; ctl.abort(); }, idleMs); idleTimer.unref?.(); };
    let response;
    touch();
    try {
      try { response = await post(`${base}/chat/completions`, body, turn.key, ctl.signal, o); }
      catch (error) {
        if (ctl.signal.aborted) throw error;
        if (turn.provider === 'lmstudio' && await abortable(startLmStudio(base, o), ctl.signal) && !ctl.signal.aborted) response = await post(`${base}/chat/completions`, body, turn.key, ctl.signal, o);
        else throw Object.assign(new Error(turn.provider === 'lmstudio' ? `LM Studio is not reachable at ${base} (start it with "lms server start").` : `NVIDIA request failed: network error.`), { network: true });
      }
      if (!response.ok) {
        const json = await response.json().catch(() => null);
        const raw = json?.error?.message ?? json?.message ?? json?.detail ?? response.statusText ?? 'request rejected';
        throw Object.assign(new Error(`${turn.provider === 'nvidia' ? 'NVIDIA' : 'LM Studio'} HTTP ${response.status}: ${scrubKey(typeof raw === 'string' ? raw : JSON.stringify(raw), turn.key).slice(0, 300)}`), { http: response.status });
      }
      const acc = deltaAccumulator();
      const type = String(response.headers?.get?.('content-type') ?? '');
      if (type.includes('application/json') || !response.body) {
        const json = await response.json();
        acc.add({ ...json, choices: json?.choices?.map(c => ({ ...c, delta: c.message })) });
        hooks.progress(acc, true);
        return { acc };
      }
      const parse = sseParser(), decoder = new TextDecoder();
      const reader = response.body.getReader();
      hooks.attach(acc);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        touch();
        let finished = false;
        for (const event of parse(decoder.decode(value, { stream: true }))) {
          if (event === 'done') { finished = true; break; }
          acc.add(event);
        }
        hooks.progress(acc, false);
        if (streamChars(acc) > (o.maxStreamChars ?? MAX_STREAM_CHARS)) throw new Error(`Provider output passed ${o.maxStreamChars ?? MAX_STREAM_CHARS} characters; the stream was cut off (is the model looping?).`);
        if (acc.error) throw new Error(`${turn.provider === 'nvidia' ? 'NVIDIA' : 'LM Studio'} stream error: ${scrubKey(acc.error, turn.key)}`);
        if (finished) break;
      }
      for (const event of parse('\n')) if (event !== 'done') acc.add(event);
      hooks.progress(acc, true);
      return { acc };
    } catch (error) {
      if (stalled) throw new Error('Provider stream stalled (no data within the idle timeout).');
      throw error;
    } finally { clearTimeout(idleTimer); hooks.detach?.(); try { ctl.abort(); } catch {} }
  }

  async function run(turn, o) {
    const env = o.env, steer = o.steer ?? steerStore;
    let lease = null;
    const finish = async (result, assistant) => {
      turn.result = result;
      try {
        const fields = { status: result.status, pending: undefined, lastTurn: { id: turn.id, status: result.status, result } };
        if (assistant) convoStore.append(turn.convId, [assistant], env, fields);
        else convoStore.patch(turn.convId, fields, env);
      } catch { /* the in-memory result still answers polls */ }
      writeTrace({ kind: 'chat-response', worker: turn.worker, provider: turn.provider, id: turn.id, status: result.status, model: result.model,
        reasoning: result.reasoning ?? '', text: result.text ?? '', substitutedFrom: result.substitutedFrom ?? null, reason: result.reason ?? null }, { env });
      return result;
    };
    const base = { id: turn.id, provider: turn.provider, conversation: turn.convId, estimatedUsd: 0, priceStatus: 'free', serviceTier: null,
      ...(turn.substitutedFrom && { substitutedFrom: turn.substitutedFrom }) };
    try {
      checkProviderUrl(turn.provider, providerUrl(turn.provider, env), env);
      if (turn.provider === 'nvidia') lease = await (o.acquireLease ?? rotation.acquireLease)(turn.model, env, { signal: turn.abort.signal });
      let turnReasoning = '', prefill = null, steers = 0;
      for (;;) {
        const convo = convoStore.get(turn.convId, env);
        if (!convo) throw new Error('Conversation was deleted.');
        const messages = toRequestMessages(convo.messages);
        if (prefill !== null) messages.push({ role: 'assistant', content: prefill });
        const body = { model: turn.model, messages, stream: true, stream_options: { include_usage: true },
          ...(turn.tools.length && { tools: turn.tools, tool_choice: 'auto' }), ...(turn.thinkingWorker ? thinkingParams(turn.thinkingWorker, turn.effort) : {}),
          ...(turn.maxTokens && { max_tokens: turn.maxTokens }) };
        writeTrace({ kind: 'chat-request', worker: turn.worker, provider: turn.provider, id: turn.id, model: turn.model, effort: turn.effort,
          prefill: prefill !== null, messages, tools: turn.tools.map(t => t.function.name) }, { env });
        const baseReasoning = prefill !== null ? turnReasoning : '';
        const view = acc => {
          const split = splitThink(acc.content, { prefilled: prefill !== null, implicitOpen: !acc.reasoning });
          const reasoning = baseReasoning + acc.reasoning + split.reasoning;
          const inReasoning = !acc.toolCalls.length && (prefill !== null ? !split.closed : (!split.closed || acc.content === '')) && !split.answer.trim();
          return { reasoning, answer: split.answer, closed: split.closed, inReasoning };
        };
        let steerTips = null, lastWrite = 0, timer = null, current = null;
        const progress = (acc, final) => {
          current = acc;
          const now = Date.now();
          if (!final && now - lastWrite < (o.throttleMs ?? 250)) return;
          lastWrite = now;
          const v = view(acc);
          try { convoStore.patch(turn.convId, { pending: { turn: turn.id, model: turn.model, phase: v.inReasoning ? 'reasoning' : acc.toolCalls.length ? 'tools' : 'answer',
            reasoning: v.reasoning, content: v.answer, at: new Date(now).toISOString() } }, env); } catch {}
        };
        const checkSteer = () => {
          if (!turn.agentId || steerTips || steers >= MAX_THOUGHT_STEERS || !current) return;
          const v = view(current);
          if (!v.inReasoning || !v.reasoning.trim()) return;
          let pending = [];
          try { pending = steer.pendingTips(turn.agentId, env); } catch { return; }
          if (!pending.length) return;
          steerTips = true; // claim before aborting so a racing tick does nothing
          turn.controller?.abort();
        };
        let outcome;
        try {
          outcome = await streamOnce(turn, body, o, { progress,
            attach: () => { timer = setInterval(checkSteer, o.steerTickMs ?? 300); timer.unref?.(); },
            detach: () => clearInterval(timer) });
        } catch (error) {
          if (steerTips && !turn.abort.signal.aborted) {
            // Thought-steer: take the tips and restart before any answer has been produced.
            const run = (() => { try { return steer.getRun(turn.agentId, env); } catch { return null; } })();
            const tips = steer.takeTips(turn.agentId, run?.step ?? 0, env);
            if (!tips.length) { steerTips = null; continue; }
            steers++;
            const partial = current ? view(current).reasoning : turnReasoning;
            const note = tips.map(t => t.text).join('\n');
            if (turn.steerMode === 'think') {
              turnReasoning = `${partial}\n[Operator note: ${note}]\n`;
              prefill = `<think>\n${turnReasoning}`;
            } else {
              convoStore.append(turn.convId, tips.map(t => ({ role: 'user', content: steer.tipMessage(t), steer: true, turn: turn.id })), env);
              turnReasoning = ''; prefill = null;
            }
            turn.steered = true;
            steer.appendLog({ kind: 'thought-steer', agentId: turn.agentId, callsign: run?.callsign, worker: turn.worker, step: run?.step ?? 0,
              mode: turn.steerMode, text: note.slice(0, 2000), reasoningChars: partial.length }, env);
            writeTrace({ type: 'thought-steer', worker: turn.worker, callsign: run?.callsign ?? null, step: run?.step ?? 0, mode: turn.steerMode, text: note, partialReasoning: partial }, { env });
            continue;
          }
          throw error;
        }
        const acc = outcome.acc, v = view(acc);
        let reasoning = v.reasoning, answer = v.answer;
        if (prefill !== null && !v.closed) { reasoning = baseReasoning + acc.reasoning; answer = acc.content; } // the model never closed its thought
        const calls = acc.toolCalls.filter(Boolean).map(tc => {
          let args;
          try { args = tc.arguments.trim() ? JSON.parse(tc.arguments) : {}; } catch { args = null; }
          return { call_id: tc.id || `call_${randomBytes(6).toString('hex')}`, name: tc.name, args, raw: tc.arguments || '{}' };
        });
        const usage = usageOf(acc.usage);
        const text = answer.replace(/^\s+/, '');
        const status = acc.finish === 'length' && !text.trim() && !calls.length ? 'incomplete' : 'completed';
        const result = { ...base, status, text, calls: calls.map(({ raw, ...c }) => c), usage, usageStatus: usage ? 'verified' : 'unknown',
          model: acc.model || turn.model, reasoning: reasoning.trim() ? reasoning : undefined, ...(steers && { thoughtSteers: steers }),
          ...(status === 'incomplete' && { reason: 'Output token limit reached before any answer.' }) };
        if (result.reasoning === undefined) delete result.reasoning;
        const assistant = { role: 'assistant', content: text, ...(reasoning.trim() && { reasoning }), model: result.model,
          ...(calls.length && { tool_calls: calls.map(c => ({ id: c.call_id, type: 'function', function: { name: c.name, arguments: c.raw } })) }),
          ...(turn.steered && { steer: true }), turn: turn.id };
        return await finish(result, assistant);
      }
    } catch (error) {
      if (turn.abort.signal.aborted) return finish({ ...base, status: 'cancelled', text: '', calls: [], usage: null, usageStatus: 'unknown', model: turn.model, reason: 'Cancelled by request.' });
      return finish({ ...base, status: 'failed', text: '', calls: [], usage: null, usageStatus: 'unknown', model: turn.model,
        reason: scrubKey(String(error?.message ?? error), turn.key).slice(0, 300) });
    } finally {
      lease?.release();
      setTimeout(() => turns.delete(turn.id), 15 * 60 * 1000).unref?.();
    }
  }

  async function create(args, options = {}) {
    const o = opts(options); o.env ??= process.env;
    const env = o.env;
    const name = canonicalWorker(args?.worker_type);
    const spec = workerSpec(name);
    if (!spec.provider) throw new Error('Not a provider worker.');
    const settings = workerSettings(name, env);
    const effort = EFFORTS.includes(args.effort) ? selectWorkerEffort(name, args.effort, env, settings.model).effective : settings.effort_policy.default;
    const agentId = typeof args.agent_id === 'string' && SAFE_AGENT.test(args.agent_id) ? args.agent_id : null;
    let convo, parsed = null;
    if (args.previous_response_id) {
      parsed = convoStore.parseTurnId(args.previous_response_id);
      if (!parsed) throw new Error('Invalid previous_response_id for a provider worker.');
      convo = convoStore.get(parsed.convId, env);
      if (!convo) throw new Error('Conversation not found for previous_response_id (it may have been deleted).');
      if (convo.worker !== name) throw new Error('Conversation worker differs from the requested worker.');
      for (const t of turns.values()) if (t.convId === convo.id && !t.result) throw new Error('This conversation already has a running step.');
    } else {
      if (typeof args.instructions !== 'string' || !args.instructions) throw new Error('Instructions are required.');
      convo = convoStore.createConvo({ worker: name, provider: spec.provider, model: settings.model, agentId, system: args.instructions }, env);
    }
    // Under the conversation lock: roll back any abandoned attempt after previous_response_id, then add this step's input.
    const saved = convoStore.rewrite(convo.id, (messages, current) => applyStep(messages, args.input,
      { afterRev: parsed ? parsed.rev : null, tag: convoStore.turnIdFor(convo.id, (current.rev ?? 0) + 1) }).messages,
    env, { status: 'running', ...(agentId && { agentId }) });
    const turn = { id: convoStore.turnIdFor(convo.id, saved.rev), thinkingWorker: name, convId: convo.id, worker: name, provider: spec.provider, model: settings.model,
      effort, agentId, steerMode: settings.steer_mode, tools: settings.tools ? toChatTools(args.tools) : [], key: null,
      // Both providers get an output bound so a looping model cannot stream forever.
      maxTokens: Math.min(32000, Math.max(1024, Number(args.max_output_tokens) || DEFAULT_MAX_TOKENS)),
      abort: new AbortController(), controller: null, result: null, steered: false };
    turns.set(turn.id, turn);
    const fail = reason => {
      turn.result = { id: turn.id, status: 'failed', text: '', calls: [], usage: null, usageStatus: 'unknown', estimatedUsd: 0, priceStatus: 'free',
        model: turn.model, serviceTier: null, provider: turn.provider, conversation: turn.convId, reason: String(reason).slice(0, 300) };
      try { convoStore.patch(turn.convId, { status: 'failed', lastTurn: { id: turn.id, status: 'failed', result: turn.result } }, env); } catch {}
      turn.promise = Promise.resolve(turn.result);
      return turn.result;
    };
    if (spec.provider === 'nvidia') {
      try { turn.key = o.key ?? getKey(env, 'nvidia'); } catch (error) { return fail(error.message); }
      try {
        const pick = (o.chooseModel ?? rotation.chooseModel)(turn.model, env);
        if (pick.substitutedFrom) {
          turn.substitutedFrom = pick.substitutedFrom; turn.model = pick.model;
          // The substitute gets ITS OWN thinking controls (none when no configured worker runs that model).
          turn.thinkingWorker = (o.workerForModel ?? rotation.workerForModel)(pick.model, env);
          const note = `NVIDIA rotation: ${pick.substitutedFrom} is over today's active-hours budget; using ${pick.model}.`;
          writeTrace({ type: 'rotation', worker: name, from: pick.substitutedFrom, to: pick.model }, { env });
          steerStore.appendLog({ kind: 'rotation', agentId, worker: name, text: note }, env);
        }
      } catch (error) { return fail(error.message); }
    }
    turn.promise = run(turn, o);
    return { id: turn.id, status: 'in_progress', provider: turn.provider, conversation: turn.convId, model: turn.model,
      ...(turn.substitutedFrom && { substitutedFrom: turn.substitutedFrom }) };
  }

  async function poll(id, options = {}) {
    const o = opts(options); const env = o.env ?? process.env;
    const parsed = convoStore.parseTurnId(id);
    if (!parsed) throw new Error('Invalid provider response id.');
    const worker = options.worker_type ? canonicalWorker(options.worker_type) : null;
    const turn = turns.get(id);
    if (turn) {
      if (worker && turn.worker !== worker) throw new Error('Response worker identity mismatch.');
      if (!turn.result) await Promise.race([turn.promise, pause(Math.min(5000, Math.max(0, Number(options.wait_ms) || 0)))]);
      return turn.result ?? { id, status: 'in_progress', provider: turn.provider, conversation: turn.convId };
    }
    const convo = convoStore.get(parsed.convId, env);
    if (!convo) throw new Error('Conversation not found.');
    if (worker && convo.worker !== worker) throw new Error('Response worker identity mismatch.');
    if (convo.lastTurn?.id === id) return convo.lastTurn.result;
    return { id, status: 'failed', text: '', calls: [], usage: null, usageStatus: 'unknown', estimatedUsd: 0, priceStatus: 'free', serviceTier: null,
      model: convo.model, provider: convo.provider, conversation: convo.id, reason: 'This provider step is no longer tracked (the bridge restarted); continue with a new step.' };
  }

  async function cancel(id, options = {}) {
    const parsed = convoStore.parseTurnId(id);
    if (!parsed) throw new Error('Invalid provider response id.');
    const turn = turns.get(id);
    const worker = options.worker_type ? canonicalWorker(options.worker_type) : null;
    if (turn && worker && turn.worker !== worker) throw new Error('Response worker identity mismatch.');
    if (!turn) return { id, status: 'cancel_unknown', reason: 'This provider step is not running in this bridge.' };
    if (turn.result) return turn.result;
    turn.abort.abort();
    turn.controller?.abort();
    await Promise.race([turn.promise, pause(2000)]);
    return turn.result ?? { id, status: 'cancelled', text: '', calls: [], usage: null, usageStatus: 'unknown', estimatedUsd: 0, provider: turn.provider };
  }

  return { create, poll, cancel, turns };
}

/** The bridge process's shared transport. */
export const chat = createChat();
