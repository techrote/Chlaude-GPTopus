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

Unknown model prices, incomplete continuation history bounds, unreconciled historical estimates and unknown settled costs block dollar-guarded admission. They never count as verified zero. This is deliberately conservative; changing a price table or accepting a billing reconciliation requires a trusted local administrator, not an agent claiming that a request was free.

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

Version 1 migration preserves every record still present. Older versions may already have pruned monthly history. The migration therefore reports `historicalTotalsMayBeIncomplete: true`; it cannot reconstruct missing bills. An enabled dollar guard blocks until the local history has been explicitly reconciled. Free daily operation can continue with the preserved counters when no dollar limit is configured.

## Diagnostics

The snapshot reports:

- Free group verified tokens, outstanding reservations, remaining local allowance and UTC reset time.
- Per-key monthly totals, outstanding estimated dollars, unknown-price reservations and unknown-usage requests.
- The separate informational allowance and enforceable monthly limit.
- Response IDs with their recorded key profile for safe reconciliation after a restart.
- Migration uncertainty and retained unresolved requests.

API credentials are never recorded in this ledger. Treat the local state directory as private: request IDs, model choices and timestamps are operational metadata.

## Automated evidence

Run the accounting tests without API credentials:

```sh
node --test plugins/openai-workers/tests/usage.test.mjs plugins/openai-workers/tests/accounting.test.mjs
```

The tests exercise monthly retention, UTC rollover, malformed/missing usage, unknown pricing, a shared cross-key spending limit, request and response deduplication, interrupted requests, actual concurrent Node processes, dead-owner lock recovery, live-lock protection, migration and corrupt-state rejection. They make no live API requests. Windows CI and physical Windows/Desktop acceptance are separate qualification gates.
