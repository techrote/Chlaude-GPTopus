/**
 * Editable conversation store for the chat-completions provider workers (NVIDIA Build, LM Studio).
 *
 * One JSON file per conversation in <state>/conversations (OAI_CONVO_DIR overrides):
 *   { id, worker, provider, model, agentId?, createdAt, updatedAt, rev, status, messages: [...], pending?, lastTurn? }
 * Each message: { i, role: 'system'|'user'|'assistant'|'tool', content, reasoning?, tool_calls?, tool_call_id?, name?, at,
 *   edited?: true, steer?: true, model? }. `i` is always the message's position (renumbered after every change).
 *
 * The bridge replays the CURRENT stored messages on every request, so an operator edit made here (from the config panel)
 * takes effect on the worker's very next step. Every append, edit or size trim bumps `rev`; live streaming previews (`pending`)
 * alone do not. Each message the transport adds carries `turn` (the step id) so a resent step can roll back an abandoned one.
 * Edits that would separate an assistant tool call from its tool results are refused, or (for deletes) remove the whole
 * group together. Files are written atomically and redacted (no API key ever reaches this store); a conversation that grows
 * past the size bound loses its oldest non-system messages, replaced by a marker.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, openSync, closeSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { usagePath } from './usage.mjs';
import { redactKeys } from './trace.mjs';

export const MAX_CONVO_BYTES = 4 * 1024 * 1024;
export const MIN_CONVO_BYTES = 64 * 1024;
/** Live preview strings (pending reasoning/answer) are capped separately: the full text lives in the bridge's memory. */
export const MAX_PENDING_CHARS = 256 * 1024;
export const CONVO_ID = /^c[a-f0-9]{16}$/;
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const TRIM_MARKER = n => `[Earlier conversation trimmed by the bridge: ${n} message${n === 1 ? '' : 's'} removed to stay within the size bound]`;

export const convoDir = (env = process.env) => env.OAI_CONVO_DIR || join(dirname(usagePath(env)), 'conversations');
const fileOf = (id, env) => { if (!CONVO_ID.test(String(id ?? ''))) throw new Error('Invalid conversation id'); return join(convoDir(env), `${id}.json`); };
export const newConvoId = () => `c${randomBytes(8).toString('hex')}`;
/** Response ids handed to the mod: chat_<convId>_<rev>. */
export const turnIdFor = (convId, rev) => `chat_${convId}_${rev}`;
export function parseTurnId(id) {
  const m = /^chat_(c[a-f0-9]{16})_(\d{1,9})$/.exec(String(id ?? ''));
  return m ? { convId: m[1], rev: Number(m[2]) } : null;
}

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Small cross-process lock (bridge and config panel both write). A lock older than 5 s is considered stale. */
function withLock(id, env, fn) {
  const lock = `${fileOf(id, env)}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + 3000;
  let fd = null;
  while (fd === null) {
    try { fd = openSync(lock, 'wx'); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) { rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error('Conversation is busy; try again.');
      sleepSync(15);
    }
  }
  try { return fn(); }
  finally { try { closeSync(fd); } catch {} try { rmSync(lock, { force: true }); } catch {} }
}

function readConvo(id, env) {
  const file = fileOf(id, env);
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw new Error('Conversation file is unreadable.'); }
}
const renumber = messages => messages.forEach((m, i) => { m.i = i; });

/** Remove the oldest non-system messages (whole tool groups at a time) until the file fits; insert one marker. */
function boundSize(convo, maxBytes) {
  let removed = 0;
  // Only the history counts: the live preview and the last turn's result must never push history out.
  const size = () => Buffer.byteLength(JSON.stringify(convo.messages));
  while (size() > maxBytes) {
    const msgs = convo.messages;
    let start = msgs.findIndex((m, idx) => m.role !== 'system' && !(m.trimMarker));
    if (start < 0 || start >= msgs.length - 1) break; // keep at least the newest message
    let end = start + 1;
    if (msgs[start].role === 'assistant' && msgs[start].tool_calls?.length) while (end < msgs.length && msgs[end].role === 'tool') end++;
    else if (msgs[start].role === 'tool') while (end < msgs.length && msgs[end].role === 'tool') end++;
    if (end >= msgs.length) break;
    msgs.splice(start, end - start);
    removed += end - start;
    // A conversation must not begin its history with orphaned tool results.
    while (msgs[start]?.role === 'tool') { msgs.splice(start, 1); removed++; }
  }
  if (removed) {
    const prior = convo.messages.find(m => m.trimMarker);
    const total = removed + (prior?.trimmed ?? 0);
    convo.messages = convo.messages.filter(m => !m.trimMarker);
    const at = convo.messages.findIndex(m => m.role !== 'system');
    convo.messages.splice(at < 0 ? convo.messages.length : at, 0, { role: 'user', content: TRIM_MARKER(total), at: new Date().toISOString(), trimMarker: true, trimmed: total });
  }
  return removed;
}

export function maxConvoBytes(env = process.env) {
  const n = Number(env.OAI_CONVO_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.max(MIN_CONVO_BYTES, Math.round(n)) : MAX_CONVO_BYTES;
}
const tail = text => typeof text === 'string' && text.length > MAX_PENDING_CHARS ? `…${text.slice(-MAX_PENDING_CHARS)}` : text;

/** Write atomically. A size trim always bumps rev (even for a live preview) so a stale panel edit cannot hit a renumbered message. */
function writeConvo(convo, env, { maxBytes = maxConvoBytes(env), bumped = false } = {}) {
  const file = fileOf(convo.id, env);
  const clean = redactKeys(convo, env);
  if (clean.pending && typeof clean.pending === 'object') for (const k of ['reasoning', 'content']) if (typeof clean.pending[k] === 'string') clean.pending[k] = tail(clean.pending[k]);
  if (boundSize(clean, maxBytes) && !bumped) clean.rev = (clean.rev ?? 0) + 1;
  renumber(clean.messages);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(clean), { mode: 0o600 });
  renameSync(tmp, file);
  return clean;
}

/** Read-modify-write under the lock. mutate(convo) returns a value; bump=false leaves rev alone (live previews). */
function update(id, env, mutate, { bump = true } = {}) {
  return withLock(id, env, () => {
    const convo = readConvo(id, env);
    if (!convo) throw new Error('Conversation not found.');
    const result = mutate(convo);
    if (bump) convo.rev = (convo.rev ?? 0) + 1;
    convo.updatedAt = new Date().toISOString();
    const saved = writeConvo(convo, env, { bumped: bump });
    return { convo: saved, result };
  });
}

export function message(input, extra = {}) {
  const role = String(input?.role ?? '');
  if (!ROLES.has(role)) throw new Error('Invalid message role.');
  const m = { role, content: typeof input.content === 'string' ? input.content : input.content == null ? '' : String(input.content), at: new Date().toISOString() };
  if (typeof input.reasoning === 'string' && input.reasoning) m.reasoning = input.reasoning;
  if (role === 'assistant' && Array.isArray(input.tool_calls) && input.tool_calls.length) {
    m.tool_calls = input.tool_calls.map(c => ({ id: String(c.id), type: 'function', function: { name: String(c.function?.name ?? ''), arguments: String(c.function?.arguments ?? '{}') } }));
  }
  if (role === 'tool') { m.tool_call_id = String(input.tool_call_id ?? ''); if (input.name) m.name = String(input.name); }
  if (input.steer) m.steer = true;
  if (input.model) m.model = String(input.model);
  if (typeof input.turn === 'string' && input.turn) m.turn = input.turn; // the transport step that added it (rollback on resend)
  return Object.assign(m, extra);
}

export function createConvo({ worker, provider, model, agentId, system } = {}, env = process.env) {
  const now = new Date().toISOString();
  const id = newConvoId();
  const convo = { id, worker: String(worker ?? ''), provider: String(provider ?? ''), model: String(model ?? ''),
    ...(agentId && { agentId: String(agentId) }), createdAt: now, updatedAt: now, rev: 0, status: 'idle', messages: [] };
  if (system) convo.messages.push(message({ role: 'system', content: system }));
  return withLock(id, env, () => writeConvo(convo, env));
}
export function get(id, env = process.env) { return readConvo(id, env); }
/** Summaries for the panel, newest first. */
export function list(env = process.env, { limit = 200 } = {}) {
  let names = [];
  try { names = readdirSync(convoDir(env)).filter(n => /^c[a-f0-9]{16}\.json$/.test(n)); } catch { return []; }
  const out = [];
  for (const name of names) {
    let c;
    try { c = JSON.parse(readFileSync(join(convoDir(env), name), 'utf8')); } catch { continue; }
    out.push({ id: c.id, worker: c.worker, provider: c.provider, model: c.model, agentId: c.agentId ?? null, status: c.status,
      rev: c.rev, createdAt: c.createdAt, updatedAt: c.updatedAt, messages: c.messages?.length ?? 0, live: Boolean(c.pending) });
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit);
}
export function remove(id, env = process.env) { withLock(id, env, () => rmSync(fileOf(id, env), { force: true })); return { ok: true }; }

export function append(id, messages, env = process.env, patch = {}) {
  return update(id, env, convo => {
    for (const m of messages) convo.messages.push(message(m));
    Object.assign(convo, patch);
  }).convo;
}
/**
 * Replace the whole message list under the lock: build(messages) returns the new list, where entries already stored are
 * passed through unchanged and new ones are normalized. Used by the transport to add a step's input (with rollback).
 */
export function rewrite(id, build, env = process.env, patch = {}) {
  return update(id, env, convo => {
    const next = build(convo.messages, convo);
    convo.messages = next.map(m => (m && m.at && ROLES.has(m.role)) ? m : message(m));
    Object.assign(convo, patch);
  }).convo;
}
/** Status / pending / lastTurn changes. Pending previews never bump rev. */
export function patch(id, fields, env = process.env, { bump = false } = {}) {
  return update(id, env, convo => { for (const [k, v] of Object.entries(fields)) { if (v === undefined) delete convo[k]; else convo[k] = v; } }, { bump }).convo;
}

// ---- tool-call pairing ------------------------------------------------------------------------------------------
/** The [start, end) range of the assistant-with-tool_calls group that contains message index i, or null. */
function toolGroup(messages, i) {
  let start = i;
  if (messages[i]?.role === 'tool') { while (start > 0 && messages[start].role === 'tool') start--; }
  if (!(messages[start]?.role === 'assistant' && messages[start].tool_calls?.length)) return messages[i]?.role === 'tool' ? [i, i + 1] : null;
  let end = start + 1;
  while (end < messages.length && messages[end].role === 'tool') end++;
  return [start, end];
}
const checkIndex = (convo, i) => { if (!Number.isInteger(i) || i < 0 || i >= convo.messages.length) throw new Error('Message index out of range.'); };
const checkRev = (convo, expectRev) => { if (expectRev !== undefined && expectRev !== null && Number(expectRev) !== convo.rev) throw new Error('Conversation changed since you loaded it; reload and retry.'); };

/** Edit a message's content and/or reasoning (tool calls themselves are not editable). */
export function editMessage(id, i, { content, reasoning, expectRev } = {}, env = process.env) {
  return update(id, env, convo => {
    checkRev(convo, expectRev); checkIndex(convo, i);
    const m = convo.messages[i];
    if (content === undefined && reasoning === undefined) throw new Error('Nothing to edit.');
    if (content !== undefined) m.content = String(content);
    if (reasoning !== undefined) { if (String(reasoning)) m.reasoning = String(reasoning); else delete m.reasoning; }
    m.edited = true;
  }).convo;
}
/** Delete one message. Deleting either half of a tool call/result group deletes the whole group. */
export function deleteMessage(id, i, { expectRev } = {}, env = process.env) {
  return update(id, env, convo => {
    checkRev(convo, expectRev); checkIndex(convo, i);
    const [start, end] = toolGroup(convo.messages, i) ?? [i, i + 1];
    convo.messages.splice(start, end - start);
    return { deleted: end - start };
  }).convo;
}
/** Insert a system/user/assistant text message after index afterIndex (-1 = at the start). */
export function insertMessage(id, afterIndex, { role, content, reasoning, expectRev } = {}, env = process.env) {
  return update(id, env, convo => {
    checkRev(convo, expectRev);
    if (!['system', 'user', 'assistant'].includes(role)) throw new Error('Only system, user or assistant text messages can be inserted.');
    if (!Number.isInteger(afterIndex) || afterIndex < -1 || afterIndex >= convo.messages.length) throw new Error('Message index out of range.');
    const next = convo.messages[afterIndex + 1], prev = convo.messages[afterIndex];
    if (next?.role === 'tool') throw new Error('Cannot insert between a tool call and its results.');
    // Directly after an assistant tool call, its results are still to come (or missing): an insert would orphan them.
    if (prev?.role === 'assistant' && prev.tool_calls?.length) throw new Error('Cannot insert directly after a tool call before its results; insert before the assistant message or after its results.');
    convo.messages.splice(afterIndex + 1, 0, message({ role, content, reasoning }, { edited: true }));
  }).convo;
}
/** Keep messages 0..i and drop everything after. Refused when it would keep tool calls but cut some of their results. */
export function truncateAfter(id, i, { expectRev } = {}, env = process.env) {
  return update(id, env, convo => {
    checkRev(convo, expectRev); checkIndex(convo, i);
    const group = toolGroup(convo.messages, i);
    if (group && group[1] > i + 1 && convo.messages[group[0]].role === 'assistant') {
      throw new Error('Truncating here would separate tool calls from their results; truncate before the assistant message or after its results.');
    }
    convo.messages.splice(i + 1);
  }).convo;
}
