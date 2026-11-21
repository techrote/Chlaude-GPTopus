#!/usr/bin/env node
/**
 * Owner-only reconciliation of the local OpenAI worker usage ledger.
 *
 *   node scripts/reconcile-usage.mjs status
 *   node scripts/reconcile-usage.mjs reconcile --month 2026-11 --usd 12.34 --source "OpenAI billing dashboard" [--as-of 2026-11-21]
 *
 * `reconcile` needs a real interactive terminal and a typed confirmation bound to a
 * digest of the exact status and figures shown. There is no --yes switch, and no
 * environment variable, file, pipe or MCP tool can supply the amounts or the consent.
 * Nothing here reads OPENAI_WORKER_MONTHLY_ALLOWANCE_USD or any API key.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { applyReconciliation, normalizeProposal, reconciliationStatus, renderStatus, parseUsd, proposalId, confirmationPhrase, ReconcileRefusal } from '../bridge/usage-reconcile.mjs';
import { utcDay } from '../bridge/usage.mjs';

export const HELP = `Local usage ledger reconciliation (owner terminal only)

  node plugins/openai-workers/scripts/reconcile-usage.mjs status
  node plugins/openai-workers/scripts/reconcile-usage.mjs reconcile --month YYYY-MM --usd AMOUNT [--month YYYY-MM --usd AMOUNT ...] --source "OpenAI billing dashboard" [--as-of YYYY-MM-DD]

AMOUNT is the authoritative month-to-date USD for BOTH worker keys (plain digits, dot decimals).
Reconciliation never lowers local totals and never removes pending requests. It is an owner
attestation recorded in an append-only audit list, not a bill. Run it in a local terminal.
Ledger location: OPENAI_WORKER_USAGE_DIR (default: the per-user state directory).
`;

function parseReconcileArgs(args) {
  const months = [], amounts = []; let source, asOf;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new ReconcileRefusal(`${flag} requires a value.`, 'bad-arguments');
    if (flag === '--month') months.push(value);
    else if (flag === '--usd') amounts.push(parseUsd(value));
    else if (flag === '--source') { if (source !== undefined) throw new ReconcileRefusal('--source given twice.', 'bad-arguments'); source = value; }
    else if (flag === '--as-of') { if (asOf !== undefined) throw new ReconcileRefusal('--as-of given twice.', 'bad-arguments'); asOf = value; }
    else throw new ReconcileRefusal(`Unknown option ${flag}.`, 'bad-arguments');
  }
  if (!months.length || months.length !== amounts.length) throw new ReconcileRefusal('Provide each --month together with its --usd amount.', 'bad-arguments');
  return { entries: months.map((month, i) => ({ month, authoritativeUsd: amounts[i] })), source, asOf };
}
async function readlineAsk(io, question) {
  const rl = createInterface({ input: io.input, output: io.output, terminal: false });
  try { return await rl.question(question); } finally { rl.close(); }
}

/** `ask(question)` and `io` are injectable for tests; production uses the real terminal. */
export async function main(argv = process.argv.slice(2), { env = process.env, io = { input: stdin, output: stdout }, ask, now = new Date(),
  print = value => stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`), beforeLedgerWrite } = {}) {
  const [command = 'help', ...args] = argv, options = { env, now, io, beforeLedgerWrite };
  if (command === 'help' || command === '--help') { print(HELP); return { command: 'help' }; }
  if (command === 'status') {
    if (args.length) throw new ReconcileRefusal('status takes no arguments.', 'bad-arguments');
    const status = await reconciliationStatus(options); print(renderStatus(status)); return { command, status };
  }
  if (command !== 'reconcile') throw new ReconcileRefusal(`Unknown command ${command}. Run help.`, 'bad-arguments');
  if (io.input?.isTTY !== true || io.output?.isTTY !== true) throw new ReconcileRefusal('Reconciliation requires an interactive local terminal; refusing before reading the ledger.', 'not-interactive');
  const parsed = parseReconcileArgs(args);
  const proposal = normalizeProposal({ entries: parsed.entries, source: parsed.source, asOf: parsed.asOf ?? utcDay(now) }, now);
  const status = await reconciliationStatus(options);
  print(renderStatus(status));
  const id = proposalId(status.digest, proposal.entries, proposal.source, proposal.asOf);
  print(`\nProposed owner attestation (as of ${proposal.asOf}, source: ${proposal.source}):\n` +
    proposal.entries.map(e => `  ${e.month}: authoritative month-to-date $${e.authoritativeUsd}`).join('\n') +
    '\nThis records what YOU read from an authoritative source. It can only raise what the local guard assumes; it cannot lower a local total or clear a reservation.');
  const phrase = confirmationPhrase(id), answer = await (ask ?? (q => readlineAsk(io, q)))(`Type ${phrase} to record this reconciliation; anything else cancels: `);
  if (answer !== phrase) { print('Cancelled; nothing was recorded.'); return { command, recorded: false }; }
  const result = await applyReconciliation({ statusDigest: status.digest, entries: proposal.entries, source: proposal.source, asOf: proposal.asOf, confirmation: answer }, options);
  print(result.alreadyApplied ? 'This exact reconciliation was already recorded; no change.' : `Recorded reconciliation ${result.id.slice(0, 16)} for ${result.entries.map(e => e.month).join(', ')}.`);
  return { command, recorded: result.applied, result };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(r => { if (r?.recorded === false) process.exitCode = 2; }).catch(error => { process.stderr.write(`Reconcile: ${error.message}\n`); process.exitCode = 1; });
}
