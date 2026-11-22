#!/usr/bin/env node
// Pretty-print and follow the OAI live trace (written by the bridge when OAI_TRACE=1).
//   node oai-trace.mjs               follow today's trace live (new records only)
//   node oai-trace.mjs --all         print today's history, then keep following
//   node oai-trace.mjs --date 2026-11-22 [--no-follow]
//   options: --dir <path>  --full (no truncation)  --no-color  --no-follow
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { traceDir } from '../bridge/trace.mjs';

const USAGE = 'Usage: oai-trace [--all] [--date YYYY-MM-DD] [--dir PATH] [--full] [--no-follow] [--no-color]';
export function parseArgs(argv) {
  const opts = { all: false, date: null, dir: null, full: false, follow: true, color: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--full') opts.full = true;
    else if (a === '--no-follow') opts.follow = false;
    else if (a === '--no-color') opts.color = false;
    else if (a === '--date' || a === '--dir') {
      const v = argv[++i]; if (!v) throw new Error(`${a} needs a value`);
      if (a === '--date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('--date must be YYYY-MM-DD');
      opts[a.slice(2)] = v;
    } else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  // A past date is history: print it all.
  if (opts.date) opts.all = true;
  return opts;
}

const C = { reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m', cyan: '\u001b[96m', magenta: '\u001b[95m', green: '\u001b[92m', yellow: '\u001b[93m', red: '\u001b[91m', blue: '\u001b[94m' };
const painter = on => (style, text) => on ? `${style.split('+').map(s => C[s]).join('')}${text}${C.reset}` : String(text);
const clipText = (text, full, max = 1200) => {
  const s = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  return full || s.length <= max ? s : `${s.slice(0, max)}… [+${s.length - max} chars; --full shows all]`;
};
const indent = (text, pad = '    ') => String(text).split('\n').map(l => pad + l).join('\n');
const contentText = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(c => c?.text ?? c?.refusal ?? (c?.type ? `[${c.type}]` : JSON.stringify(c))).join('') : JSON.stringify(content);

/** Render one trace record (already parsed) as coloured text. */
export function formatRecord(rec, { color = false, full = false } = {}) {
  const p = painter(color), out = [];
  const time = String(rec.time ?? '').replace('T', ' ').slice(0, 19);
  if (rec.kind === 'request') {
    out.push(p('cyan+bold', `▶ REQUEST  ${time}  ${rec.worker ?? '?'}`) + p('dim', `  model=${rec.model} tier=${rec.tier} effort=${rec.effort}${rec.previousResponseId ? ` continues=${rec.previousResponseId}` : ''}`));
    if (rec.tools?.length) out.push(p('dim', `  tools: ${rec.tools.join(', ')}`));
    if (rec.instructions && !rec.previousResponseId) out.push(p('magenta', '  ┌ instructions'), p('dim', indent(clipText(rec.instructions, full, 600))));
    const items = typeof rec.input === 'string' ? [{ role: 'user', content: rec.input }] : Array.isArray(rec.input) ? rec.input : [];
    for (const item of items) {
      if (item?.type === 'function_call_output') out.push(p('yellow', `  ┌ tool result ${item.call_id ?? ''}`), indent(clipText(item.output, full)));
      else if (item?.type === 'function_call') out.push(p('yellow', `  ┌ tool call ${item.name}(${clipText(item.arguments, full, 300)})`));
      else out.push(p('magenta', `  ┌ ${item?.role ?? item?.type ?? 'input'}`), indent(clipText(contentText(item?.content ?? item), full)));
    }
  } else if (rec.kind === 'response') {
    const failed = !['completed', 'in_progress'].includes(rec.status);
    const usage = rec.usage ? `in=${rec.usage.input} (cached ${rec.usage.cached ?? 0}) out=${rec.usage.output}` : 'usage unknown';
    const cost = rec.estimatedUsd == null ? '$?' : `$${Number(rec.estimatedUsd).toFixed(4)}`;
    out.push(p(failed ? 'red+bold' : 'green+bold', `◀ RESPONSE ${time}  ${rec.worker ?? '?'}  ${rec.status}`) + p('dim', `  ${rec.id ?? ''} ${rec.model ?? ''} ${usage} ${cost}`));
    if (rec.reason) out.push(p('red', `  reason: ${rec.reason}`));
    if (rec.text) out.push(p('green', '  ┌ assistant'), indent(clipText(rec.text, full, 4000)));
    for (const call of rec.toolCalls ?? []) out.push(p('yellow', `  ┌ tool call ${call.name}`) + p('dim', ` ${call.call_id ?? ''}`), indent(clipText(call.args, full, 800)));
  } else out.push(p('dim', `· ${time} ${JSON.stringify(rec)}`));
  return out.join('\n');
}

export function formatLine(line, options) {
  if (!line.trim()) return null;
  try { return formatRecord(JSON.parse(line), options); }
  catch { return painter(options?.color)('red', `! unparsable trace line: ${line.slice(0, 200)}`); }
}

const today = () => new Date().toISOString().slice(0, 10);
async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
  if (opts.help) { console.log(USAGE); return; }
  const color = opts.color && process.stdout.isTTY && !process.env.NO_COLOR;
  const dir = opts.dir ?? traceDir(process.env);
  let day = opts.date ?? today();
  let file = join(dir, `${day}.jsonl`), offset = 0, carry = '';
  const fmt = { color, full: opts.full };
  if (existsSync(file) && !opts.all) offset = statSync(file).size; // follow only new records
  console.error(`oai-trace: ${opts.follow ? 'following' : 'reading'} ${file}${process.env.OAI_TRACE ? '' : '  (tracing is written by the bridge only when OAI_TRACE=1 is set for Claude Code)'}`);
  const drain = () => {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size < offset) offset = 0; // truncated or replaced
    if (size === offset) return;
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset); readSync(fd, buf, 0, buf.length, offset); offset = size;
      const lines = (carry + buf.toString('utf8')).split('\n'); carry = lines.pop();
      for (const line of lines) { const text = formatLine(line, fmt); if (text) console.log(`${text}\n`); }
    } finally { closeSync(fd); }
  };
  drain();
  if (!opts.follow) return;
  setInterval(() => {
    if (!opts.date && today() !== day) { drain(); day = today(); file = join(dir, `${day}.jsonl`); offset = 0; carry = ''; }
    drain();
  }, 500);
}
if (process.argv[1] && /oai-trace\.mjs$/.test(process.argv[1])) await main();
