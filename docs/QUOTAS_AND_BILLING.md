# Daily quota controls and billing

[← Overview](../README.md) · [Configuration →](CONFIGURATION.md)

The two `daily-*` agents use **one free-programme API key** but **two independently tracked token groups**. The other four agents use the straight key and do not touch this ledger.

| Group | Worker | Daily target | Soft stop with default 10% headroom |
|---|---|---:|---:|
| Astra / premium group | `astra6free` | 250,000 | 275,000 |
| Terra group | `terra5-6free` | 2,500,000 | 2,750,000 |

These are **configured local targets**, not a claim that every account receives free tokens. OpenAI's programme eligibility, model group membership, actual usage, and billing are defined by OpenAI. A *different* key alone does not make calls free.

## How a request is accounted

1. Before a free-key request, the plugin checks the group's daily total and all currently reserved requests.
2. It reserves 12,000 tokens by default (adjustable) and blocks new requests if a group is already at its soft limit or concurrent reservation cap.
3. Once OpenAI reports a final response, the plugin replaces the reservation with the response's **input + output tokens** and records an estimated dollar value. The response ID prevents duplicate accounting.
4. If a network timeout makes it impossible to determine whether OpenAI accepted a request, the reservation **remains**; the plugin never assumes an ambiguous request cost zero.
5. At **00:00 UTC**, new calls use the next day's counters. A call initiated before midnight is attributed to its original UTC day, even when it finishes later.

Thus a request may legitimately exceed 275k / 2.75M if it uses more tokens than reserved. This is a **soft admission control**, not a strict ceiling. Other tools using the same key are invisible to it. It does not automatically cap account spending.

## Where the ledger lives

- Windows: `%LOCALAPPDATA%\ClaudeOpenAIWorkers\free-usage-ledger.json`
- Linux/macOS: `$XDG_STATE_HOME/claude-openai-workers/free-usage-ledger.json`, or `~/.local/state/claude-openai-workers/free-usage-ledger.json`
- Set `OPENAI_WORKER_USAGE_DIR` to use another directory.

The ledger stores UTC-day totals, requests, response IDs and pending reservations — **not API keys**. Its lock file coordinates separate Claude Code sessions. If unreadable/corrupted, **free-key calls are blocked** to avoid silently clearing your budget; straight-key calls still work.

The old v0.3 `usage-ledger.json` is not automatically migrated because it predates the present key split.

A v1 `free-usage-ledger.json` is upgraded in place on the first write. The original file is first copied byte-for-byte (`free-usage-ledger.v1-<sha256>.json`, same folder) and the upgrade records the unknown period and affected months. v1 never tracked the straight (standard) key, so for that period only you can supply the real figure. If you set `OPENAI_WORKER_MONTHLY_LIMIT_USD`, requests in the upgrade month are refused until you reconcile once from a local terminal (`scripts\reconcile-usage.ps1`; see [ULTRA accounting](ULTRA_ACCOUNTING.md#owner-reconciliation-after-a-v1-upgrade)). The next UTC month is fully tracked and needs nothing. The terminal's `status` prints the ledger file it resolved and says whether a monthly limit is set; check that it is the same ledger and environment the bridge uses. A reconciliation figure must be read from the dashboard just before you run the command; an older `--as-of` (at most three days) is accepted but the local spend recorded since is added, and anything the ledger could not see in that gap is still missed. The confirmation is a terminal check plus a typed phrase, not authentication: run it yourself, never hand your terminal to an agent for it. Never edit the ledger by hand to lift the block.

## What `/oai` shows

- Whether each of the two key profiles is configured (never the secret itself)
- All eight agent names, model IDs and effective service tiers
- UTC day and next reset time
- Daily tokens **used** plus tokens **reserved** in flight, per free-key group
- Daily targets, soft limits, and an **estimated** monthly free-key worker cost
- Optional informational `MonthlyAllowanceUsd` reference (for example `$88`)
- The separately enforced monthly limit (`OPENAI_WORKER_MONTHLY_LIMIT_USD`), or a line saying it is **not set** (in which case the ledger blocks nothing on cost), and the spend committed so far this UTC month
- After a v1 upgrade: one line with the upgrade time, the unreconciled months and whether the current month is blocked (a block only applies when a limit is set)

`/oai` is read-only: it never reconciles anything. The raw `usage` bridge result (the Desktop `openai_worker_daily_usage` tool returns the same data) carries the complete scope, `monthlyCommittedUsd` and `historicalTotalsMayBeIncomplete`. The only setting that enforces a cost limit is the environment variable `OPENAI_WORKER_MONTHLY_LIMIT_USD`; no installer script or Desktop setting writes it (`set-daily-budgets.ps1` sets only the informational allowance), so set it yourself where Claude Code and the Desktop bridge can see it.

An `$88` allowance reference does **not** grant credits, query account billing, or stop paid API usage. Consult the [OpenAI usage dashboard](https://platform.openai.com/usage) and [billing settings](https://platform.openai.com/settings/organization/billing/overview) for actual entitlements and charges.

## Shared model groups

Astra/premium-group models can share one underlying OpenAI complimentary limit, even if requested by different tools. The local ledger counts only `astra6free` calls through its free key; it **does not** count `sol6-1flex` or other clients, even if those models belong to the same programme group in OpenAI's billing system. The two-key design intentionally keeps straight-key calls independent.

Changing a daily worker's model is restricted to locally allowlisted model groups. Group membership may change upstream and should be reviewed against current OpenAI documentation.

## Recommended operation

Use `terra5-6free` for low-risk high-volume reading and extraction, `astra6free` for difficult reviews, and `sol6-1flex` for time-insensitive straight-key overflow. Check `/oai` before large batches; check your OpenAI account usage dashboard periodically; do not manually zero the ledger to bypass a stop.

For a lower overrun tolerance, run `set-daily-budgets.ps1 -OverrunPercent 0` and reduce `-MaxInFlight`. Be aware that any single large response can still exceed the local admission estimate.

## Reservation sizing and unbilled failures

A free-ledger reservation counts at most **128,000 input tokens plus the request's `max_output_tokens`**, even when a continuation's full prior-context bound is larger (often ~350K). Settlement still records the measured usage. A response that OpenAI reports as `failed` or `cancelled` **without usage** (for example a rate-limit refusal, which is not billed) is settled as 0 tokens / $0 and its reservation is released with reason `failed-without-usage`. `incomplete` responses without usage and ambiguous transport failures stay held until reconciled.
