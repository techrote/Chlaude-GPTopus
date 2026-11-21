# ULTRA accounting and recovery

The shared local ledger records participating Claude Code, Desktop and ULTRA requests. It does not report an authoritative OpenAI bill, an account-wide balance, or guaranteed free-programme eligibility. Other clients are invisible to it. Price estimates use the repository's explicit local price table and the service tier returned by the API.

## Separate keys, shared admission

`daily-astrafree` and `daily-terrafree` use the free-programme key. `sol`, `astra`, `luna` and `flex6-1` use the standard key. A missing free key never falls back to the standard key. Unknown named workers and an explicitly conflicting key profile are rejected before transport.

Both keys share one ledger file, retaining the historical filename `free-usage-ledger.json` so older installation paths remain useful. Free daily group counters exclude standard-key requests. `profiles.standard` and `allKeysMonthlyEstimatedUsd` report the additional paid accounting. `monthlyEstimatedUsd` retains its historical meaning: the free-key local monthly cost estimate.

The default daily targets and configurable headroom remain unchanged. Admission now includes the proposed reservation:

```text
used tokens + outstanding reservations + proposed reservation <= soft daily limit
```

The `$88/month` reference, when configured with `OPENAI_WORKER_MONTHLY_ALLOWANCE_USD=88`, remains informational. A separate `OPENAI_WORKER_MONTHLY_LIMIT_USD` enables an enforceable local estimate guard across both participating keys. Zero is an effective zero-spend limit. A guard includes outstanding reservations from previous months because those requests can still have incurred charges.

Unknown model prices, incomplete continuation history bounds, unreconciled historical estimates and unknown settled costs block dollar-guarded admission. They never count as verified zero. This is deliberately conservative; changing a price table or accepting a billing reconciliation requires a trusted local administrator, not an agent claiming that a request was free. Historical estimates are cleared only by the owner reconciliation below, never by a model.

## Request lifecycle

The shared `bridge/server.mjs` dispatcher reserves before POST, then attaches the returned response ID. It validates the configured worker/model/tier, rejects caller substitutions, and binds polling/cancellation to the recorded key profile. For a continuation it derives the history bound from the prior settled record; it never trusts a caller's claimed zero-sized history. Trusted alternative adapters must preserve these same checks. For every subsequent poll or cancellation result it must call accounting with the same response and key identity.

```js
const quote = quoteRequest({
  model, input, instructions, tools, max_output_tokens, service_tier,
  // For Responses continuations, this must include server-side history:
  ...(previous_response_id && { previous_response_id, inputTokenUpperBound }),
});
const ticket = await reserveRequest({
  workerType,
  model,
  profile: keyProfileForWorker(workerType),
  serviceTier: service_tier,
  requestId: immutableLogicalRequestId,
  ...quote,
});
```

`quoteRequest` uses a conservative text byte count plus framing allowance and the requested maximum output. The caller must supply a complete input bound for server-side Responses history; the most recent message alone is insufficient. Quotes are local estimates, not invoices or hard provider limits. No cache discount is assumed before measured evidence arrives. Dollar reservations use the highest multiplier in the local price table, including for Flex requests, so a provider-reported processing-tier change does not make the reservation smaller than the local estimate. Settlement uses the actual reported tier.

`requestId` may be omitted for legacy calls. When supplied it is retained permanently: replay rejects rather than permitting a second POST. The durable orchestration broker must reconcile an existing request instead of retrying an ambiguous request with a fresh ID. This ledger supplies accounting idempotency, not a claim of exactly-once execution by the upstream API.

Successful final responses must contain internally consistent input/output usage. Explicit measured zero is valid. Missing, partial, negative, or inconsistent usage stays in `usage_unknown` with its reservation intact. A later poll may supply measured usage and settle it. Model mismatches remain blocked for explicit reconciliation, including unexpected provider aliases; an alias must be intentionally classified rather than silently accepted as another model.

The transport helper marks network failures, timeouts, accepted malformed JSON and server errors as ambiguous. A cancellation without confirmed usage is also unresolved. Adapters must call `markRequestAmbiguous` and retain the reservation. `mayHaveIncurredUsage(error)` defaults to conservative ambiguity for unclassified errors. `releaseRequest` is for requests proved not to have started or definitively rejected; it refuses requests already linked to an API response or marked ambiguous.

## Durable storage

Version 2 adds independent monthly aggregates, per-key estimates, request IDs, response tombstones and unresolved-state records. Daily detail is retained for 62 days. Monthly aggregates, unresolved reservations and deduplication tombstones do not age out. A duplicate response ID cannot be counted again after a restart or a retention cutoff.

Updates use a short cross-process directory lock, an owner PID/hostname record, a temporary file, `fsync`, and atomic rename. POSIX also syncs the parent directory. A dead local PID's lock can be reclaimed; elapsed time alone never steals a lock from a live process. Cross-machine shared/network storage is not supported. Use a local per-user state directory shared by that user's interfaces.

A crash during the very small dead-lock recovery operation can leave a `.recovery` directory. That case fails closed rather than risking two simultaneous writers. Stop all participating bridges, inspect owner/process evidence, preserve a copy of the ledger, and remove the abandoned recovery directory only after confirming no process is using it. Never delete the ledger to clear a spending block.

Version 1 migration preserves every record still present. Older versions may already have pruned monthly history, and v1 never tracked the standard key at all. The migration cannot reconstruct missing bills, so it records the uncertainty durably instead of guessing (see below). Free daily operation continues with the preserved counters when no dollar limit is configured.

## Owner reconciliation after a v1 upgrade

**What is preserved.** On the first durable write after an upgrade, before the v2 file replaces it, the exact v1 bytes are copied to `free-usage-ledger.v1-<sha256>.json` beside the ledger (temp file, `fsync`, atomic rename; content-addressed, so a crash and retry cannot duplicate or corrupt it). The v2 `migration` record holds `migratedAt`, the evidence file name/size/digest, the **unknown period** (oldest surviving v1 day 00:00Z through the migration instant; `standardKeyTracked: false`), the affected UTC months, the v1 free-key totals per month and the v1 pending/processed counts.

**What is blocked.** Only the migration month and earlier months are unreconciled-unknown, and only while `OPENAI_WORKER_MONTHLY_LIMIT_USD` is set. The month containing the migration instant is affected even when that instant is exactly 00:00:00.000Z (the unknown period is a closed interval); a migration at 23:59:59.999Z leaves the next month fully tracked from its first instant. Every later UTC month is fully tracked and is not blocked by the migration. Unknown-price requests, unverified input bounds and ambiguous or unknown-price pending reservations keep blocking exactly as before; reconciliation does not clear them.

**Owner procedure** (a local, interactive terminal on the machine that owns the ledger; stop other Claude sessions first so the totals do not move while you read them):

```powershell
# 1. Show the unknown period, evidence digest, per-month local totals and the status digest.
.\plugins\openai-workers\scripts\reconcile-usage.ps1 -Command status
# 2. Read the authoritative month-to-date USD for BOTH worker keys from the OpenAI billing dashboard, then:
.\plugins\openai-workers\scripts\reconcile-usage.ps1 -Command reconcile -Month 2026-11 -Usd 12.34 -Source 'OpenAI billing dashboard'
# 3. The script re-displays the status and your figures, then asks you to type RECONCILE <16 hex digits>.
```

The portable equivalent is `node plugins/openai-workers/scripts/reconcile-usage.mjs status|reconcile --month YYYY-MM --usd AMOUNT --source TEXT [--as-of YYYY-MM-DD]`. Pass one `--month/--usd` pair for each month you reconcile; only the current month has to be reconciled to unblock the guard. Amounts are plain digits with a dot decimal (at most six decimals); `NaN`, negatives, exponents and anything else are rejected. The figure must be current as of the moment you read it: the guard adds only what this ledger records after reconciliation, so dashboard lag is your risk (add margin; a higher figure is always accepted). `status` is read-only apart from persisting the pending upgrade and its evidence copy, which any first write would do anyway.

**Why it cannot be driven by a model.** `reconcile` refuses unless stdin and stdout are a real terminal (checked before the ledger is read and again inside the library), has no `--yes` switch, and takes the figures only from its own arguments, never from an environment variable or file. The consent phrase is a digest of the exact status shown plus the exact months, amounts, source and date, so editing any of them, or replaying an old phrase after the ledger changed, is refused. The module is not imported by the MCP bridge, the Desktop facade or the Desktop bundle, and no tool, hook or environment variable names it (covered by tests). This is the same human-gesture pattern as the local ULTRA CLI approvals. It is not an operating-system sandbox: any code already running as you could edit the ledger file directly.

**Effect.** For each reconciled month the guard assumes `committed = max(local, baseline + local growth since reconciliation)`, where `baseline = max(your figure, what the guard already assumed)`. Reconciliation can only raise the assumed spend. It never resets or edits local totals, never deletes or releases a pending, ambiguous or unknown-price reservation, and a repeated attestation with a lower figure is recorded but cannot lower the baseline (a mistyped high figure only affects that month; the next month starts clean). A baseline belongs to its UTC month and is not carried forward.

**Audit.** Every accepted reconciliation is appended to `reconciliations` in the ledger with its source, scope (months, keys `free+standard`), `asOf` and recorded-at dates, decision, status digest, the supplied and applied figures with the local free/standard/total at that moment, the pre-reconcile ledger copy (`free-usage-ledger.pre-reconcile-<sha>.json`) and a hash chain; `status` reports a broken chain. The source text is an owner attestation, not something the software can verify. Declined or refused attempts write nothing.

**Crash safety.** Evidence copies are durable before the ledger is replaced, the ledger is replaced atomically under the cross-process lock, and an identical repeated request is a no-op. A crash between evidence and ledger write leaves the previous ledger intact; rerun the command (a dead owner's lock is recovered). A reservation arriving during reconciliation waits for the lock and then sees the new baseline. If settled usage changes the displayed totals before you confirm, the digest no longer matches and you must review the new status.

**Ledgers upgraded by the first v2 revision** (a bare `historicalTotalsMayBeIncomplete` flag, no scope or evidence) are treated conservatively: every month already in the ledger plus the month of first observation is unknown, the true migration time and original v1 file are reported as unavailable, and the scope is fixed at the first `status` or write. Months after that are tracked.

**Limitations.** Reconciliation attests only to the figure you typed; it cannot reach OpenAI. It does not unblock unknown-price or ambiguous reservations (resolve those by polling the response). A clock set earlier than the migration month stays blocked and unreconcilable. Months older than the 60 most recent in the scope are not offered for reconciliation. An older v1-era client running against a v2 ledger is unsupported.

## Diagnostics

The snapshot reports:

- Free group verified tokens, outstanding reservations, remaining local allowance and UTC reset time.
- Per-key monthly totals, outstanding estimated dollars, unknown-price reservations and unknown-usage requests.
- The separate informational allowance and enforceable monthly limit.
- Response IDs with their recorded key profile for safe reconciliation after a restart.
- Migration scope (`migration`: unknown period, affected, reconciled and unreconciled months, whether the current month is blocking), the guard's committed spend (`monthlyCommittedUsd`) and retained unresolved requests.

API credentials are never recorded in this ledger. Treat the local state directory as private: request IDs, model choices and timestamps are operational metadata.

## Automated evidence

Run the accounting tests without API credentials:

```sh
node --test plugins/openai-workers/tests/usage.test.mjs plugins/openai-workers/tests/accounting.test.mjs plugins/openai-workers/tests/usage-reconcile.test.mjs
```

The tests exercise monthly retention, UTC rollover, malformed/missing usage, unknown pricing, a shared cross-key spending limit, request and response deduplication, interrupted requests, actual concurrent Node processes, dead-owner lock recovery, live-lock protection, migration and corrupt-state rejection. The reconciliation tests cover evidence preservation, the UTC midnight boundary, rollover, lower-than-local figures, scope, refusals (non-interactive, wrong or stale digest, garbage amounts/months/sources, model-style text), crash and repeat safety, the ledger lock during reconciliation, and that the `$88` allowance is never read. They make no live API requests.

**Not verified:** the interactive confirmation was exercised with injected terminal streams and a real piped child process (which must refuse), not inside a physical Windows console, ConPTY or Desktop session; the PowerShell wrapper was run only for `status` and for the non-interactive refusal. The Desktop bundle (`dist/*.mcpb`) embeds `usage.mjs` and must be rebuilt from this source before release. Windows CI and physical Windows/Desktop acceptance remain separate qualification gates.
