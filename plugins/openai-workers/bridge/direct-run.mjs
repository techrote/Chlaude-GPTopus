/**
 * /oai:run: start a worker with the operator's exact text, no Claude in the loop.
 *
 * The bridge process runs the request and polls it to completion in the
 * background, so the mod command returns at once. Runs are text-only (no file or
 * shell tools); `@path` tokens attach a local file's text to the task verbatim.
 * Results live in <state>/direct/<id>.json and are written to the trace.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { usagePath } from './usage.mjs';
import { redact } from './trace.mjs';
import { workerSettings, selectWorkerEffort, canonicalWorker, EFFORTS } from './workers.mjs';

export const MAX_ATTACH = 200_000;
export const MAX_TASK = 400_000;
const POLL_LIMIT_MS = 6 * 60 * 60 * 1000;
const SAFE_ID = /^D\d{1,6}$/i;

export const directDir = (env = process.env) => join(dirname(usagePath(env)), 'direct');
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
function writeJson(file, value, env) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(redact(value, env)), { mode: 0o600 });
  renameSync(tmp, file);
}
function nextId(env) {
  const f = join(directDir(env), 'counter.json'), c = readJson(f, { n: 0 });
  const n = (c.n ?? 0) + 1; writeJson(f, { n }, env);
  return `D${n}`;
}

/** "<worker> [effort] <task>"; @path tokens attach files. */
export function parseRun(args, workers) {
  const text = String(args ?? '').trim();
  const m = /^(\S+)\s*([\s\S]*)$/.exec(text);
  if (!m) return { error: 'usage' };
  const worker = canonicalWorker(m[1]);
  if (!workers.includes(worker)) return { error: `Unknown worker "${m[1].slice(0, 40)}". Choose one of: ${workers.join(', ')}.` };
  let rest = m[2], effort;
  const e = /^(\S+)\s+([\s\S]*)$/.exec(rest);
  if (e && EFFORTS.includes(e[1].toLowerCase())) { effort = e[1].toLowerCase(); rest = e[2]; }
  if (EFFORTS.includes(rest.trim().toLowerCase()) || !rest.trim()) return { error: 'Empty task.' };
  return { worker, effort, task: rest.trim() };
}

/** Replace nothing; append each @path file's text after the task. */
export function attachFiles(task, read = p => readFileSync(p, 'utf8')) {
  const paths = [...task.matchAll(/(?:^|\s)@("([^"]+)"|(\S+))/g)].map(m => m[2] ?? m[3]);
  const parts = [task], notes = [];
  for (const p of [...new Set(paths)]) {
    let body;
    try { body = read(resolve(p)); } catch (err) { notes.push(`@${p}: not attached (${String(err?.code ?? err?.message ?? err).slice(0, 60)})`); continue; }
    if (body.length > MAX_ATTACH) { body = body.slice(0, MAX_ATTACH); notes.push(`@${p}: truncated to ${MAX_ATTACH} characters`); }
    parts.push(`\n\n----- file: ${p} -----\n${body}\n----- end of file -----`);
  }
  return { text: parts.join('').slice(0, MAX_TASK), notes };
}

export function getDirect(id, env = process.env) {
  if (!SAFE_ID.test(String(id))) return null;
  return readJson(join(directDir(env), `${String(id).toUpperCase()}.json`), null);
}
export function listDirect(env = process.env, limit = 10) {
  let names = [];
  try { names = readdirSync(directDir(env)).filter(n => /^D\d+\.json$/.test(n)); } catch { return []; }
  return names.map(n => readJson(join(directDir(env), n), null)).filter(Boolean)
    .sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1))).slice(0, limit);
}

const INSTRUCTIONS = 'You are answering an operator directly. You have no tools and no file access; any files the operator attached are included in the message. Answer the task completely in your reply.';

/**
 * Start a run. `call(name, args)` is the bridge dispatcher; it runs in the background.
 * Returns the stored record at once (status "running").
 */
export function startDirect({ worker, effort, task }, { env = process.env, call, workers, read, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const settings = workerSettings(worker, env);
  const chosen = selectWorkerEffort(worker, effort, env, settings.model);
  const { text, notes } = attachFiles(task, read);
  const id = nextId(env), file = join(directDir(env), `${id}.json`);
  const rec = { id, worker, model: settings.model, effort: chosen.effective, task: task.slice(0, 2000), notes,
    status: 'running', startedAt: new Date().toISOString() };
  writeJson(file, rec, env);
  const save = patch => { Object.assign(rec, patch, { updatedAt: new Date().toISOString() }); writeJson(file, rec, env); };
  const effortValue = chosen.effective;
  (async () => {
    try {
      let t = await call('create', { worker_type: worker, model: settings.model, input: text, instructions: INSTRUCTIONS, tools: [],
        ...(effortValue && effortValue !== 'none' && { effort: effortValue }), ...(settings.service_tier && { service_tier: settings.service_tier }),
        agent_id: `direct_${id}` });
      save({ responseId: t.id });
      const end = Date.now() + POLL_LIMIT_MS;
      while (t.status === 'in_progress' || t.status === 'queued') {
        if (Date.now() > end) throw new Error('Timed out after 6 hours.');
        await sleep(1000);
        t = await call('poll', { id: t.id, worker_type: worker, wait_ms: 5000 });
      }
      save({ status: t.status === 'completed' ? 'done' : t.status, text: String(t.text ?? ''), reason: t.reason, usage: t.usage ?? null });
    } catch (err) {
      save({ status: 'failed', reason: String(err?.message ?? err).slice(0, 800) });
    }
  })();
  return { ...rec, workers };
}

