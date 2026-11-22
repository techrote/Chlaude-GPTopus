// Pure renderer for the /oai status panel: plain data in, string out.
// No host ($) access, no I/O. Edit freely: register.js only calls renderStatus().
//
// Layout (max WIDTH columns): scene banner with the OAI logo, then KEYS, WORKERS,
// FREE QUOTA, MONTH, ULTRA, ACTIVE and a footer. Colours are ANSI escapes that are
// emitted only when data.color is true (OAI_STATUS_COLOR=1); the plain form uses
// box-drawing and block characters only, so it reads well either way.

export const WIDTH = 96; // total line width including the frame (keep <= 100)
const INNER = WIDTH - 4; // "║ " + content + " ║"

const ESC = '\u001b[';
const PALETTE = { cyan: '96', magenta: '95', yellow: '93', green: '92', red: '91', dim: '2', bold: '1', blue: '94' };
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export const visibleLength = text => [...String(text).replace(ANSI_RE, '')].length;
function makePaint(color) {
  return (style, text) => color && text ? `${ESC}${style.split('+').map(s => PALETTE[s]).join(';')}m${text}${ESC}0m` : String(text);
}
/** Cut plain text to n columns (with an ellipsis). Only used on uncoloured cells. */
export function clip(text, n) {
  const chars = [...String(text ?? '')];
  return chars.length <= n ? chars.join('') : `${chars.slice(0, Math.max(0, n - 1)).join('')}…`;
}
const padEnd = (text, n) => text + ' '.repeat(Math.max(0, n - visibleLength(text)));
const fmt = n => Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
const usd = n => n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(2)}`;

/** ▰▰▰▱▱ meter: filled share of `value` against `limit` over `cells` cells. */
export function bar(value, limit, cells = 16) {
  if (!(limit > 0)) return '▱'.repeat(cells);
  const filled = Math.max(0, Math.min(cells, Math.round((value / limit) * cells)));
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled);
}

/** Fixed-width table; widths are content-driven, the last column absorbs the rest. */
export function table(headers, rows, paint) {
  const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map(r => visibleLength(r[i] ?? ''))));
  const gap = 2, fixed = widths.slice(0, -1).reduce((a, b) => a + b + gap, 0);
  widths[widths.length - 1] = Math.max(4, Math.min(widths.at(-1), INNER - fixed));
  const line = cells => cells.map((c, i) => {
    const cell = visibleLength(c) > widths[i] ? clip(String(c).replace(ANSI_RE, ''), widths[i]) : String(c);
    return i === cells.length - 1 ? cell : padEnd(cell, widths[i]);
  }).join(' '.repeat(gap));
  return [paint('dim', line(headers)), paint('dim', widths.map(w => '─'.repeat(w)).join(' '.repeat(gap))), ...rows.map(line)];
}

const LOGO = [
  ' ▄██████▄   ▄█████▄  ██ ',
  ' ██    ██  ██▀   ▀██ ██ ',
  ' ██    ██  ██▀▀▀▀▀██ ██ ',
  ' ▀██████▀  ██     ██ ██ ',
];

/**
 * data = {
 *   now: Date|string, version: string, color: boolean,
 *   keys: [{ label, configured, source }],
 *   workers: [{ name, model, key, tier, effort: { min, max, default } } | { name, error }],
 *   usage: { utcDay, resetAtUtc, overrunPercent, groups: { premium, terra }, monthlyEstimatedUsd, monthlyAllowanceUsd,
 *            monthlyLimitUsd, monthlyCommittedUsd } | null,
 *   usageError: string|null, notes: string[],
 *   ultra: { enabled: boolean, state: string },   // state: short text (one or more lines)
 *   active: [{ type, status, description }],
 * }
 */
export function renderStatus(data) {
  const paint = makePaint(Boolean(data.color));
  const out = [];
  const row = (text = '') => out.push(`${paint('magenta', '║')} ${padEnd(text, INNER)} ${paint('magenta', '║')}`);
  const rule = () => out.push(paint('magenta', `╟${'─'.repeat(WIDTH - 2)}╢`));
  const section = title => { rule(); row(`${paint('yellow+bold', `▓▒░ ${title}`)} ${paint('dim', '░'.repeat(Math.max(0, INNER - title.length - 5)))}`); };
  const wrap = (text, style) => {
    for (const para of String(text ?? '').split('\n')) {
      let lineText = '';
      for (const word of para.split(' ')) {
        if (visibleLength(`${lineText} ${word}`) > INNER && lineText) { row(paint(style, lineText)); lineText = clip(word, INNER); }
        else lineText = lineText ? `${lineText} ${word}` : clip(word, INNER);
      }
      row(paint(style, lineText));
    }
  };

  // ── banner ───────────────────────────────────────────────────────────────
  const stamp = new Date(data.now ?? Date.now()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const side = [
    paint('cyan+bold', '░▒▓ OPENAI WORKER CREW ▓▒░'),
    paint('dim', `presents ${paint('bold', `oai v${data.version ?? '?'}`)} :: status`),
    paint('dim', `release date ${stamp}`),
    paint('dim', 'greetz to the orchestrator · claude stays lead'),
  ];
  out.push(paint('magenta', `╔${'═'.repeat(WIDTH - 2)}╗`));
  LOGO.forEach((art, i) => row(`${paint('cyan+bold', art)}  ${side[i]}`));

  // ── keys ─────────────────────────────────────────────────────────────────
  section('KEYS');
  out.push(...table(['key', 'state', 'source'], (data.keys ?? []).map(k => [k.label,
    k.configured ? paint('green', '● online') : paint('red', '○ missing'), k.configured ? k.source : 'not configured']), paint)
    .map(line => `${paint('magenta', '║')} ${padEnd(line, INNER)} ${paint('magenta', '║')}`));

  // ── workers ──────────────────────────────────────────────────────────────
  section('WORKERS');
  const workerRows = (data.workers ?? []).map(w => w.error
    ? [paint('cyan', w.name), paint('red', 'CONFIG ERROR'), '', '', clip(w.error, 40)]
    : [paint('cyan', w.name), w.model, w.key === 'free' ? paint('green', 'free') : 'straight', w.tier ?? 'auto',
      `${w.effort.min}..${w.effort.max} (${w.effort.default})`]);
  out.push(...table(['worker', 'model', 'key', 'tier', 'effort range (default)'], workerRows, paint)
    .map(line => `${paint('magenta', '║')} ${padEnd(line, INNER)} ${paint('magenta', '║')}`));

  // ── free quota ───────────────────────────────────────────────────────────
  const u = data.usage;
  section(`FREE QUOTA${u?.utcDay ? ` · ${u.utcDay} UTC` : ''}`);
  if (u) {
    const groups = [['premium', 'astra (premium)'], ['terra', 'terra']].filter(([g]) => u.groups?.[g]).map(([g, label]) => {
      const item = u.groups[g], spent = item.usedTokens + item.reservedTokens;
      const share = item.softLimitTokens > 0 ? Math.round((spent / item.softLimitTokens) * 100) : 0;
      const style = share >= 90 ? 'red' : share >= 60 ? 'yellow' : 'green';
      return [label, fmt(item.usedTokens), fmt(item.reservedTokens), fmt(item.softLimitTokens),
        `${paint(style, bar(spent, item.softLimitTokens))} ${String(share).padStart(3)}%`, String(u.resetAtUtc ?? '').replace('T', ' ').slice(0, 16)];
    });
    out.push(...table(['group', 'used', 'reserved', 'soft limit', 'load', 'resets (UTC)'], groups, paint)
      .map(line => `${paint('magenta', '║')} ${padEnd(line, INNER)} ${paint('magenta', '║')}`));
    row(paint('dim', `headroom ${u.overrunPercent ?? '?'}% over the daily target · only astra6free / terra5-6free draw on this quota`));
  } else wrap(`usage unavailable: ${data.usageError ?? 'unknown error'} (the ledger fails closed for free workers)`, 'red');

  // ── month ────────────────────────────────────────────────────────────────
  section('MONTH');
  if (u) {
    out.push(...table(['metric', 'value'], [
      ['free-key workers, estimated', usd(u.monthlyEstimatedUsd)],
      ['committed, both keys', usd(u.monthlyCommittedUsd)],
      ['spend limit', u.monthlyLimitUsd == null ? paint('yellow', 'not set (OPENAI_WORKER_MONTHLY_LIMIT_USD)') : usd(u.monthlyLimitUsd)],
      ...(u.monthlyAllowanceUsd == null ? [] : [['credit reference', `${usd(u.monthlyAllowanceUsd)} (informational)`]]),
    ], paint).map(line => `${paint('magenta', '║')} ${padEnd(line, INNER)} ${paint('magenta', '║')}`));
    row(paint('dim', 'local estimates only, never an authoritative OpenAI bill'));
  } else row(paint('dim', 'no ledger data'));
  for (const note of data.notes ?? []) if (note) wrap(note, 'yellow');

  // ── ultra ────────────────────────────────────────────────────────────────
  section('ULTRA');
  wrap(data.ultra?.enabled ? data.ultra.state : 'disabled · workers run directly, unchanged', data.ultra?.enabled ? '' : 'dim');

  // ── active ───────────────────────────────────────────────────────────────
  section('ACTIVE');
  const active = data.active ?? [];
  if (active.length) {
    out.push(...table(['worker', 'status', 'task'], active.map(a => [paint('cyan', a.type), a.status, a.description ?? '']), paint)
      .map(line => `${paint('magenta', '║')} ${padEnd(line, INNER)} ${paint('magenta', '║')}`));
  } else row(paint('dim', 'no OpenAI workers dispatched in this session'));

  // ── footer ───────────────────────────────────────────────────────────────
  rule();
  row(`${paint('cyan', '»')} /oai:a <worker> [low|medium|high|xhigh|max] <task>   ${paint('dim', 'e.g.')} /oai:a sol6-2 xhigh fix the test`);
  row(`${paint('cyan', '»')} OAI_TRACE=1 + scripts/oai-trace.ps1   ${paint('dim', 'live transcript of OpenAI traffic')}`);
  row(`${paint('cyan', '»')} /oai:config   ${paint('dim', 'web config panel: efforts, tiers, guardrails, quotas, trace')}`);
  row(paint('dim', 'main conversation stays on Claude · keys are never displayed'));
  out.push(paint('magenta', `╚${'═'.repeat(WIDTH - 2)}╝`));
  return out.join('\n');
}
