#!/usr/bin/env node
/**
 * Local web configuration panel for the oai plugin.
 *   node scripts/oai-config.mjs [--no-open] [--port N] [--idle-minutes N]
 * Binds 127.0.0.1 on a random free port, prints the URL (with a per-launch
 * token) and opens the browser. Every API call needs the token; requests with
 * a foreign Host/Origin are refused (DNS rebinding / CSRF). Exits after
 * --idle-minutes without requests (default 30) or ~3 minutes after the page
 * stops heart-beating. Only allowlisted OPENAI_WORKER_* / OAI_* names are read
 * or written; API keys are never read or shown (only whether one is configured).
 * See oai-config-core.mjs for storage locations and OAI_CONFIG_STORE / OAI_CONFIG_STATE_DIR.
 */
import http from 'node:http';
import { readFileSync, statSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import * as steer from '../bridge/steer.mjs';
import * as convoStore from '../bridge/convo.mjs';
import { acceptUpgrade } from './oai-ws.mjs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import {
  PARAMS, GROUPS, ALLOWED, WORKERS, PRICED_MODELS, defaultStore, stateDir as defaultStateDir, applyChanges, validateConfig, effectiveConfig,
  readPending, clearPending, readUi, writeUi, capErrors, listPresets, savePreset, readPreset, deletePreset, presetChanges,
  newToken, tokenOk, originOk,
} from './oai-config-core.mjs';
import { WORKER_TYPES, EFFORTS, DEFAULT_EFFORT_POLICIES } from '../bridge/workers.mjs';
import { configuredKey } from '../bridge/openai.mjs';
import { usageSnapshot } from '../bridge/usage.mjs';
import { traceDir, traceFile } from '../bridge/trace.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
/** Location-only env names the live panels need; never key values. */
/** The pure colour module, inlined into the page (CSP allows only the nonce'd inline script). */
const colourRaw = readFileSync(join(here, 'oai-colour.mjs'), 'utf8');
const colourNames = [...colourRaw.matchAll(/^export (?:const|function) (\w+)/gm)].map(m => m[1]);
export const COLOUR_SRC = `const OC = (() => {
${colourRaw.replace(/^export /gm, '')}
return { ${colourNames.join(', ')} };
})();`;
export const renderPage = (page, nonce) => page.replace('/*__OAI_COLOUR__*/', () => COLOUR_SRC).replaceAll('__NONCE__', nonce);
const BASE_NAMES = ['LOCALAPPDATA', 'XDG_STATE_HOME', 'HOME', 'USERPROFILE'];

function baseEnv(values, env = process.env) {
  const out = {};
  for (const n of BASE_NAMES) if (env[n]) out[n] = env[n];
  for (const [n, v] of Object.entries(values)) if (v !== '') out[n] = v;
  return out;
}

export async function liveState({ store, stateDir, env = process.env, now = new Date(), usage = usageSnapshot }) {
  const values = store.read(ALLOWED);
  const ui = readUi(stateDir);
  const merged = baseEnv(values, env);
  // Key presence only (env or DPAPI file); a key value is never read here.
  const KEY_NAMES = { standard: 'OPENAI_API_KEY', free: 'OPENAI_FREE_API_KEY', nvidia: 'NVIDIA_API_KEY' };
  const KEY_LABELS = { standard: 'PAID', free: 'FREE', nvidia: 'NVIDIA' };
  const keys = ['standard', 'free', 'nvidia'].map(profile => {
    let source = null; try { source = configuredKey(env, profile); } catch { /* treat as missing */ }
    return { profile, name: KEY_NAMES[profile], label: KEY_LABELS[profile], configured: Boolean(source), source: source ?? 'none' };
  });
  let usageInfo = null, usageError = null;
  try { usageInfo = await Promise.race([usage({ env: merged, now }), new Promise((_, r) => setTimeout(() => r(new Error('ledger busy')), 4000))]); }
  catch (e) { usageError = String(e.message || e).slice(0, 200); }
  let trace = { dir: traceDir(merged), file: traceFile(merged, now), bytes: null, enabled: values.OAI_TRACE === '1' };
  try { trace.bytes = statSync(trace.file).size; } catch { /* no file today */ }
  return {
    version: VERSION, storage: { kind: store.kind, location: store.location, stateDir },
    values, check: validateConfig(values), effective: effectiveConfig(values), pending: readPending(stateDir, now, ui), ui,
    keys, usage: usageInfo, usageError, trace, presets: listPresets(stateDir),
  };
}

export function schema() {
  return { params: PARAMS, groups: GROUPS, workers: WORKERS.map(w => ({ name: w, ...WORKER_TYPES[w], policy: DEFAULT_EFFORT_POLICIES[w] })),
    efforts: EFFORTS, pricedModels: PRICED_MODELS };
}

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
async function body(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 65536) throw Object.assign(new Error('Body too large.'), { status: 413 }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

// ── steering console: macros + WebSocket hub ─────────────────────────────
export const MACRO_COUNT = 8;
export function macroDir(stateDir) { return join(stateDir, 'macros'); }
export function readMacros(stateDir) {
  const dir = macroDir(stateDir);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const items = [];
  for (let n = 1; n <= MACRO_COUNT; n++) {
    const file = join(dir, `${n}.txt`);
    try { if (!existsSync(file)) writeFileSync(file, ''); } catch {}
    let text = ''; try { text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').slice(0, steer.MAX_TIP); } catch {}
    items.push({ n, text, label: text.trim().split(/\r?\n/)[0].slice(0, 40) });
  }
  return { dir, items };
}
const macroStamp = stateDir => { let s = ''; for (let n = 1; n <= MACRO_COUNT; n++) { try { s += statSync(join(macroDir(stateDir), `${n}.txt`)).mtimeMs; } catch {} s += ':'; } return s; };
export function steerSnapshot(env) { return { type: 'steer', runs: steer.listRuns(env), log: steer.readLog(env, 120), pause: steer.pausePolicy(env) }; }
/** Handle one console message. Targets are agent ids from the run list, or '*' for every live run. */
export function handleConsoleMessage(msg, env) {
  if (msg?.type !== 'tip') return { type: 'error', error: 'Unknown message' };
  const text = String(msg.text ?? '');
  if (!text.trim()) return { type: 'error', error: 'Empty tip' };
  const live = steer.listRuns(env, { includeEnded: false });
  const targets = msg.target === '*' ? live : live.filter(r => r.agentId === msg.target);
  if (!targets.length) return { type: 'error', error: 'That worker is no longer running.' };
  const flags = { hard: !!msg.hard, pin: !!msg.pin, ack: !!msg.ack, assess: !!msg.assess, conseq: !!msg.conseq, thought: !!msg.thought };
  const sent = targets.map(r => ({ callsign: r.callsign, tip: steer.enqueueTip(r.agentId, { text, ...flags, from: 'console' }, env) }));
  return { type: 'sent', sent: sent.map(s => ({ callsign: s.callsign, id: s.tip.id })) };
}

// ── conversations: the provider workers' editable history (bridge/convo.mjs) ──
export const CONVO_TYPES = new Set(['convos', 'convo', 'convo-edit', 'thought-steer']);
const runsById = env => { try { return new Map(steer.listRuns(env).map(r => [r.agentId, r])); } catch { return new Map(); } };
/** Conversation summaries for the list, newest first, with the steer callsign when a run matches the agentId. */
export function convoSummaries(env) {
  const runs = runsById(env);
  return convoStore.list(env).map(c => { const run = c.agentId ? runs.get(c.agentId) : null; return { ...c, callsign: run?.callsign ?? null, runStatus: run?.status ?? null }; });
}
export function convosSnapshot(env) { return { type: 'convos', items: convoSummaries(env), dir: convoStore.convoDir(env) }; }
/** Full view of one conversation (messages, pending live preview) plus its callsign. */
export function convoView(convo, env) {
  if (!convo) return { type: 'convo', convo: null };
  let run = null; try { run = convo.agentId ? steer.getRun(convo.agentId, env) : null; } catch { /* unknown run */ }
  return { type: 'convo', convo: { ...convo, callsign: run?.callsign ?? null, runStatus: run?.status ?? null } };
}
/** What a viewer needs after the file changed: the whole conversation when its history changed, else only the live part. */
export function convoDelta(seen, convo) {
  if (!convo) return { type: 'convo', convo: null, gone: true };
  if (!seen || seen.id !== convo.id || seen.rev !== convo.rev || seen.count !== (convo.messages?.length ?? 0)) return null; // caller sends convoView
  return { type: 'convo-live', id: convo.id, rev: convo.rev, status: convo.status, updatedAt: convo.updatedAt, pending: convo.pending ?? null };
}
export const convoSeen = convo => convo ? { id: convo.id, rev: convo.rev, count: convo.messages?.length ?? 0 } : null;
/** A cheap change stamp of the conversation directory (file names + mtimes). */
export function convoStamp(env) {
  const dir = convoStore.convoDir(env);
  let names = [];
  try { names = readdirSync(dir).filter(n => /^c[a-f0-9]{16}\.json$/.test(n)).sort(); } catch { return ''; }
  let s = '';
  for (const n of names) { try { s += `${n}:${statSync(join(dir, n)).mtimeMs};`; } catch {} }
  return s;
}
export function convoMtime(id, env) { if (!convoStore.CONVO_ID.test(String(id ?? ''))) return null; try { return statSync(join(convoStore.convoDir(env), `${id}.json`)).mtimeMs; } catch { return null; } }
const optText = v => typeof v === 'string' ? v : undefined;
/** Handle one conversation message from the panel. Pure apart from the conversation/steer stores. */
export function handleConvoMessage(msg, env) {
  try {
    if (msg?.type === 'convos') return convosSnapshot(env);
    if (msg?.type === 'convo') {
      if (msg.id === null || msg.id === undefined || msg.id === '') return { type: 'convo', convo: null };
      const convo = convoStore.get(String(msg.id), env);
      if (!convo) return { type: 'error', scope: 'convo', error: 'Conversation not found.' };
      return convoView(convo, env);
    }
    if (msg?.type === 'convo-edit') {
      const id = String(msg.id ?? ''), i = Number(msg.i), expectRev = msg.expectRev ?? undefined;
      if (!Number.isInteger(i)) return { type: 'error', scope: 'convo', error: 'Message index must be a whole number.' };
      let convo;
      if (msg.op === 'edit') convo = convoStore.editMessage(id, i, { content: optText(msg.content), reasoning: optText(msg.reasoning), expectRev }, env);
      else if (msg.op === 'delete') convo = convoStore.deleteMessage(id, i, { expectRev }, env);
      else if (msg.op === 'insert') convo = convoStore.insertMessage(id, i, { role: msg.role, content: optText(msg.content) ?? '', reasoning: optText(msg.reasoning), expectRev }, env);
      else if (msg.op === 'truncate') convo = convoStore.truncateAfter(id, i, { expectRev }, env);
      else return { type: 'error', scope: 'convo', error: 'Unknown edit operation.' };
      return { ...convoView(convo, env), op: msg.op };
    }
    if (msg?.type === 'thought-steer') {
      const text = String(msg.text ?? '').trim();
      if (!text) return { type: 'error', scope: 'convo', error: 'Empty thought-steer.' };
      const convo = convoStore.get(String(msg.id ?? ''), env);
      if (!convo) return { type: 'error', scope: 'convo', error: 'Conversation not found.' };
      if (!convo.agentId) return { type: 'error', scope: 'convo', error: 'This conversation has no steerable run (no agent id).' };
      let run = null; try { run = steer.getRun(convo.agentId, env); } catch {}
      if (!(convo.pending || convo.status === 'running') && (!run || run.status === 'ended')) return { type: 'error', scope: 'convo', error: 'That worker is no longer running.' };
      const tip = steer.enqueueTip(convo.agentId, { text, thought: true, from: 'panel' }, env);
      return { type: 'thought-sent', id: convo.id, callsign: run?.callsign ?? null, tipId: tip.id, midReasoning: convo.pending?.phase === 'reasoning' };
    }
    return { type: 'error', scope: 'convo', error: 'Unknown message' };
  } catch (e) {
    return { type: 'error', scope: 'convo', error: String(e?.message || e).slice(0, 300) };
  }
}

/** Build the server (not listening). Tests pass a memory store and a temp state dir. */
export function createConfigServer({ store = defaultStore(), stateDir = defaultStateDir(), token = newToken(), env = process.env,
  usage = usageSnapshot, onActivity = () => {}, onHeartbeat = () => {}, page = readFileSync(join(here, 'oai-config.html'), 'utf8') } = {}) {
  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    try {
      if (!originOk(req.headers, port)) return json(res, 403, { error: 'Foreign host or origin refused.' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      onActivity();
      if (req.method === 'GET' && url.pathname === '/') {
        if (!tokenOk(token, url.searchParams.get('t') ?? '')) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('Missing or wrong token. Relaunch /oai:config to get a fresh link.'); }
        const nonce = randomBytes(16).toString('base64');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
        return res.end(renderPage(page, nonce));
      }
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
      // API: token header only (a cross-site form cannot set it); JSON bodies only.
      if (!tokenOk(token, String(req.headers['x-oai-token'] ?? ''))) return json(res, 401, { error: 'Missing or wrong token.' });
      if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'JSON only.' });
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/schema') return json(res, 200, schema());
      if (route === 'GET /api/state') return json(res, 200, await liveState({ store, stateDir, env, usage }));
      if (route === 'POST /api/heartbeat') { onHeartbeat(); return json(res, 200, { ok: true }); }
      const input = req.method === 'POST' ? await body(req) : {};
      if (route === 'POST /api/set') {
        const changes = input.changes ?? (typeof input.name === 'string' ? { [input.name]: input.value } : null);
        const caps = capErrors(changes ?? {}, readUi(stateDir));
        if (Object.keys(caps).length) return json(res, 422, { ok: false, errors: caps });
        const result = applyChanges(store, changes, { state: stateDir });
        return json(res, result.ok ? 200 : 422, result);
      }
      if (route === 'POST /api/restarted') { clearPending(stateDir); return json(res, 200, { ok: true }); }
      if (route === 'POST /api/ui') { const r = writeUi(stateDir, input.ui, store.read(ALLOWED)); return json(res, r.ok ? 200 : 422, r); }
      if (route === 'POST /api/preset/save') return json(res, 200, { ok: true, ...savePreset(stateDir, input.name, store.read(ALLOWED)) });
      if (route === 'POST /api/preset/delete') { deletePreset(stateDir, input.name); return json(res, 200, { ok: true }); }
      if (route === 'POST /api/preset/load') {
        const preset = readPreset(stateDir, input.name), current = store.read(ALLOWED);
        const { changes, skipped } = presetChanges(preset, current, readUi(stateDir).locks, input.overrideLocks === true);
        if (!Object.keys(changes).length) return json(res, 200, { ok: true, changed: [], skipped });
        const result = applyChanges(store, changes, { state: stateDir });
        return json(res, result.ok ? 200 : 422, { ...result, skipped });
      }
      return json(res, 404, { error: 'Unknown route.' });
    } catch (e) {
      return json(res, e.status ?? 500, { error: String(e.message || e).slice(0, 300) });
    }
  });
  // WebSocket: same token (query) and the same Host/Origin checks as the page.
  const clients = new Set();
  const steerEnv = () => baseEnv(store.read(ALLOWED), env);
  server.on('upgrade', (req, socket) => {
    const port = server.address()?.port;
    let url; try { url = new URL(req.url, `http://127.0.0.1:${port}`); } catch { return socket.destroy(); }
    if (url.pathname !== '/ws' || !originOk(req.headers, port) || !req.headers.origin || !tokenOk(token, url.searchParams.get('t') ?? '')) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    onActivity();
    const conn = acceptUpgrade(req, socket, {
      onMessage: text => { onActivity(); let msg; try { msg = JSON.parse(text); } catch { return conn.send({ type: 'error', error: 'Invalid JSON' }); }
        if (msg?.type === 'hello') return conn.send({ type: 'macros', ...readMacros(stateDir) });
        if (CONVO_TYPES.has(msg?.type)) {
          const e = steerEnv(), reply = handleConvoMessage(msg, e);
          if (msg.type === 'convo' && reply.type === 'convo') viewing.set(conn, reply.convo ? { ...convoSeen(reply.convo), mtime: convoMtime(reply.convo.id, e) } : null);
          if (msg.type === 'convo-edit' && reply.type === 'convo' && reply.convo) viewing.set(conn, { ...convoSeen(reply.convo), mtime: convoMtime(reply.convo.id, e) });
          conn.send(reply);
          if (msg.type === 'convo-edit' || msg.type === 'thought-steer') push(true);
          return;
        }
        conn.send(handleConsoleMessage(msg, steerEnv())); push(true); },
      onClose: () => { clients.delete(conn); viewing.delete(conn); },
    });
    if (!conn) return;
    clients.add(conn);
    const e0 = steerEnv();
    conn.send(steerSnapshot(e0)); conn.send({ type: 'macros', ...readMacros(stateDir) });
    try { conn.send(convosSnapshot(e0)); } catch { /* conversation store unreadable */ }
  });
  let last = '', lastMacro = '', lastConvo = '', lastConvoList = 0;
  /** conn -> { id, rev, count, mtime } of the conversation that client is viewing. */
  const viewing = new Map();
  function push(force = false) {
    if (!clients.size) return;
    const e = steerEnv(), stamp = steer.storeStamp(e), ms = macroStamp(stateDir);
    if (force || stamp !== last) { last = stamp; const snap = steerSnapshot(e); for (const c of clients) c.send(snap); }
    if (ms !== lastMacro) { lastMacro = ms; const m = { type: 'macros', ...readMacros(stateDir) }; for (const c of clients) c.send(m); }
    pushConvos(e, force);
  }
  /** Conversation list: on any file change (at most every 1.5 s while streams rewrite it). Viewers: live part or full view. */
  function pushConvos(e, force) {
    const cs = convoStamp(e);
    if (cs !== lastConvo && (force || Date.now() - lastConvoList > 1500)) {
      lastConvo = cs; lastConvoList = Date.now();
      const snap = convosSnapshot(e); for (const c of clients) c.send(snap);
    }
    for (const [conn, seen] of viewing) {
      if (!seen) continue;
      const mtime = convoMtime(seen.id, e);
      if (!force && mtime === seen.mtime) continue;
      let convo = null; try { convo = convoStore.get(seen.id, e); } catch { continue; } // mid-write: next tick
      const delta = convoDelta(seen, convo);
      const msg = delta ?? convoView(convo, e);
      viewing.set(conn, convo ? { ...convoSeen(convo), mtime } : null);
      conn.send(msg);
    }
  }
  const timer = setInterval(() => { try { push(); } catch { /* store briefly unreadable */ } }, 400);
  timer.unref?.();
  server.on('close', () => { clearInterval(timer); for (const c of clients) c.close(); });
  return { server, token, clients };
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' }).on('error', () => {}).unref(); } catch { /* print-only */ }
}

export function parseArgs(argv) {
  const opts = { open: true, port: 0, idleMinutes: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') opts.open = false;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--idle-minutes') opts.idleMinutes = Number(argv[++i]);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('--port must be 0..65535');
  if (!(opts.idleMinutes > 0)) throw new Error('--idle-minutes must be positive');
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log('Usage: node scripts/oai-config.mjs [--no-open] [--port N] [--idle-minutes N]'); return; }
  let last = Date.now(), lastBeat = 0;
  const { server, token, clients } = createConfigServer({ onActivity: () => { last = Date.now(); }, onHeartbeat: () => { lastBeat = Date.now(); } });
  server.listen(opts.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
    console.log(`OAI config panel: ${url}`);
    console.log(`Exits after ${opts.idleMinutes} idle minutes or when the page is closed.`);
    if (opts.open) openBrowser(url);
  });
  setInterval(() => {
    // Stay up while the console is connected or any worker is running.
    if (clients.size || steer.listRuns(process.env, { includeEnded: false }).length) { last = Date.now(); return; }
    const idle = Date.now() - last > opts.idleMinutes * 60000;
    const closed = lastBeat && Date.now() - lastBeat > 180000;
    if (idle || closed) { console.log(closed ? 'Page closed; exiting.' : 'Idle; exiting.'); process.exit(0); }
  }, 10000).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });
