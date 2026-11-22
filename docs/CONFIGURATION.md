# Configuration reference

[← Overview](../README.md) · [Daily usage →](QUOTAS_AND_BILLING.md)

Configuration is intentionally simple: **two keys**, six worker presets and a handful of optional overrides. The Windows helper scripts write **user-scoped environment variables**. Close and reopen Claude Code and your terminal after changing them.

## Keys

| Variable | Purpose | Used by |
|---|---|---|
| `OPENAI_API_KEY` | Straight API key | `sol`, `astra`, `luna`, `flex6-1` |
| `OPENAI_FREE_API_KEY` | Complimentary-programme key | `daily-astrafree`, `daily-terrafree` |

On Windows the scripts instead store credentials as separate encrypted files in `%LOCALAPPDATA%\ClaudeOpenAIWorkers`. An environment variable overrides that profile's stored file. Missing free keys never fall back to the straight key or vice versa. Inspect presence **without showing keys** by running `/openai-workers`.

```powershell
.\plugins\openai-workers\scripts\set-openai-key.ps1 -Profile standard
.\plugins\openai-workers\scripts\set-openai-key.ps1 -Profile free
```

## Agent models

| Worker | Model variable | Default |
|---|---|---|
| `sol` | `OPENAI_WORKER_SOL_MODEL` | `gpt-6.2-sol` |
| `astra` | `OPENAI_WORKER_ASTRA_MODEL` | `gpt-6.2-astra` |
| `luna` | `OPENAI_WORKER_LUNA_MODEL` | `gpt-6-luna` |
| `flex6-1` | `OPENAI_WORKER_FLEX6_1_MODEL` | `gpt-6.1-sol` |
| `daily-astrafree` | `OPENAI_WORKER_DAILY_ASTRAFREE_MODEL` | `gpt-6-astra` |
| `daily-terrafree` | `OPENAI_WORKER_DAILY_TERRAFREE_MODEL` | `gpt-5.6-terra` |

**Caution:** Daily workers enforce model-group eligibility locally; an arbitrary replacement model might be rejected *before* the API call. A successful override does **not** grant complimentary entitlement to that model. For new or renamed models, update the group allowlist in `bridge/usage.mjs` and add tests rather than disabling quota safety.

### Service tiers

| Tier | What it means |
|---|---|
| `auto` | Let the API choose tier according to its rules |
| `default` | Request standard processing |
| `flex` | Discounted, slower / capacity-dependent processing when supported |
| `fast` | Faster-priced processing where supported |
| `priority` | Legacy/API alias for Fast, where accepted |

Original workers (`sol`, `astra`, `luna`) inherit optional `OPENAI_WORKER_SERVICE_TIER`, or use the OpenAI project's API default when not set. Named presets (`flex6-1`, `daily-astrafree`, `daily-terrafree`) keep their built-in tier unless specifically overridden. The per-worker pattern is:

```text
OPENAI_WORKER_<AGENT_IN_UPPERCASE_UNDERSCORES>_SERVICE_TIER
```

Examples:

```powershell
.\plugins\openai-workers\scripts\set-worker-tier.ps1 -Agent flex6-1 -Tier flex
.\plugins\openai-workers\scripts\set-worker-tier.ps1 -Agent sol -Tier default
.\plugins\openai-workers\scripts\set-worker-tier.ps1 -Agent astra -Tier priority
.\plugins\openai-workers\scripts\set-worker-tier.ps1 -Agent all -Tier auto
```

To set a specific model as well:

```powershell
.\plugins\openai-workers\scripts\set-worker-tier.ps1 -Agent sol -Tier flex -Model gpt-6.1-sol
```

`gpt-6.2-sol` and `gpt-6.2-astra` do not support Flex in the version this plugin targets. An invalid combination raises an error; there is **no silent upgrade** to a more expensive tier. [OpenAI pricing and supported tiers](https://platform.openai.com/pricing/).

Use `-Tier inherit` to clear an agent's explicit tier override; that restores the named preset (if any) or global/default behaviour.

## Per-worker reasoning effort (new in v0.7)

Claude can **choose the right effort for a task inside a range you control**. The plugin enforces the bounds before each OpenAI model request — not just in a prompt. The short selection note travels with the worker's description, so Claude has practical guidance when delegating. These defaults are intentionally quality-oriented:

| Worker | Allowed API effort | Default | Guidance given to Claude |
|---|---|---|---|
| `luna` | **max only** | max | Always Max; keep tasks well scoped |
| `daily-terrafree` | **high–max** | high | High for regular inspection, xhigh for multi-file work, max for difficult audits |
| `daily-astrafree` | medium–max | high | Medium for bounded research, high for reviews, xhigh/max for difficult investigations |
| `sol` | medium–max | high | Medium for bounded coding, high for multi-file changes, xhigh/max for deep debugging |
| `astra` | medium–max | high | Medium for straightforward reviews, high for architecture, xhigh/max for critical decisions |
| `flex6-1` | medium–max | high | Medium for routine refactors, high for multi-step work, xhigh/max for difficult work |

**Windows configuration:** from the repository root, run:

```powershell
# Luna may *only* use max; Terra must use at least high.
.\plugins\openai-workers\scripts\set-worker-effort.ps1 -Agent luna -Min max -Max max
.\plugins\openai-workers\scripts\set-worker-effort.ps1 -Agent daily-terrafree -Min high -Max max -Default high

# Change a range and tell Claude when to choose a higher effort.
.\plugins\openai-workers\scripts\set-worker-effort.ps1 -Agent sol -Min medium -Max xhigh -Default high `
  -Note 'Medium for small fixes; high for multiple files; xhigh for difficult regressions.'

# Inspect saved overrides, or restore a worker's built-in policy.
.\plugins\openai-workers\scripts\set-worker-effort.ps1 -Agent sol -Show
.\plugins\openai-workers\scripts\set-worker-effort.ps1 -Agent sol -Reset
```

**Equivalent environment variables:** `OPENAI_WORKER_<NAME>_EFFORT_MIN`, `_EFFORT_MAX`, `_EFFORT_DEFAULT`, and `_EFFORT_NOTE`, where `<NAME>` is the worker ID in uppercase with punctuation replaced by underscores. For example, `OPENAI_WORKER_DAILY_TERRAFREE_EFFORT_MIN=high`. Set them as **user environment variables**, then restart Claude Code or Claude Desktop so the processes inherit the new values. The helper changes one worker at a time; other workers are unaffected.

If you change only the minimum or maximum, an unset built-in default is automatically clamped into the new range. An **explicit** out-of-range default or inverted range is rejected, without making an OpenAI call. Known unsupported model/effort combinations (such as `none` on GPT-6.2 Astra) are also rejected. If you override the underlying model, check its supported effort values.

**How selection works:**

- In native Claude Code (CLI or Desktop **Code** tab), Claude sees the worker's range/note. When supported, it can specify per-invocation subagent `effort`; otherwise the worker gets the session's inherited effort. The plugin clamps either to your allowed range. An omitted effort uses the worker default.
- In the Desktop **Chat** tab, `list_openai_workers` shows each worker's `effort_policy`. Claude can pass `reasoning_effort` to `ask_openai_worker`. An out-of-range request is clamped, and the returned `reasoning_effort` records what the plugin actually sent.
- Your configured range is a **local policy**; it does not add capabilities to an API model. More effort may improve difficult tasks, but uses more time and tokens. `max` can also consume a substantial part of the response token budget before producing text, so max-effort workers default to a 32k output-token ceiling (including hidden reasoning), rather than the normal lower cap. This is a ceiling, not a spending prediction.

**Ultra ≠ Max ≠ Ultrafast:** `max` is the highest **single-model API** `reasoning.effort`. **Ultra** is a ChatGPT Work/Codex harness orchestration level that can use multiple subagents; there is no `reasoning.effort: "ultra"` in the Responses API. If a native host indicates Ultra, this bridge translates its single-model portion to `max`; it does **not** reproduce Ultra orchestration itself. **Ultrafast** is a separately priced API processing speed tier (`service_tier`), not a reasoning effort. Some GPT-5.6 and GPT-6 models additionally support `reasoning.mode: "pro"`; this is another independent API feature, not an alternative name for Ultra. This plugin does not currently expose Pro mode or Ultrafast as worker presets.

Docs: [OpenAI reasoning efforts](https://developers.openai.com/api/docs/guides/reasoning), [OpenAI Ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode), [OpenAI API model limits](https://developers.openai.com/api/docs/models).

## Daily ledger and quotas (free key only)

| Variable | Default | Notes |
|---|---:|---|
| `OPENAI_WORKER_PREMIUM_DAILY_TOKENS` | `250000` | Astra-group target |
| `OPENAI_WORKER_TERRA_DAILY_TOKENS` | `2500000` | Terra-group target |
| `OPENAI_WORKER_DAILY_OVERRUN_PERCENT` | `10` | Local headroom beyond target, 0–100% |
| `OPENAI_WORKER_DAILY_RESERVE_TOKENS` | `12000` | Conservative per in-flight call reservation, can be 0 |
| `OPENAI_WORKER_DAILY_MAX_INFLIGHT` | `16` | Maximum simultaneous reserved calls per group |
| `OPENAI_WORKER_MONTHLY_ALLOWANCE_USD` | unset | Informational monthly reference only |
| `OPENAI_WORKER_MONTHLY_LIMIT_USD` | unset | Enforceable local monthly estimate guard across both keys (`0` = zero spend). After a v1 ledger upgrade it blocks the migration month until the owner runs [`reconcile-usage`](ULTRA_ACCOUNTING.md#owner-reconciliation-after-a-v1-upgrade); later months are unaffected |
| `OPENAI_WORKER_USAGE_DIR` | OS state directory | Custom folder for `free-usage-ledger.json` |

The script applies the normal settings for both token groups:

```powershell
.\plugins\openai-workers\scripts\set-daily-budgets.ps1 `
  -AstraDailyTokens 250000 -TerraDailyTokens 2500000 `
  -OverrunPercent 10 -ReserveTokens 12000 `
  -MaxInFlight 16 -MonthlyAllowanceUsd 88
```

See [Daily usage and billing](QUOTAS_AND_BILLING.md) for the exact accounting semantics. The ledger's soft limit is not a hard API spend cap.

## Execution limits

| Variable | Default | Behaviour |
|---|---:|---|
| `OPENAI_WORKER_MAX_STEPS` | `40` | Maximum OpenAI model steps per subagent run |
| `OPENAI_WORKER_MAX_USD` | `4` | Estimated cost guardrail for straight-key workers |
| `OPENAI_WORKER_<AGENT>_MAX_STEPS` | unset | Per-agent override |
| `OPENAI_WORKER_<AGENT>_MAX_USD` | unset | Per-agent estimated cost override; daily workers have no default dollar cap |
| `OPENAI_WORKER_FLEX_TIMEOUT_MINUTES` | `45` | Flex polling deadline, clamped to 120 minutes |

These limits use model-reported usage and local estimates. They are **not prepaid limits**, and step limits stop further requests only *after* the current request completes. Actual costs may be higher than estimates.

## Example: careful parallel research setup

```powershell
.\plugins\openai-workers\scripts\set-worker-tier.ps1 -Agent flex6-1 -Tier flex
.\plugins\openai-workers\scripts\set-daily-budgets.ps1 -OverrunPercent 10 -MaxInFlight 4 -ReserveTokens 12000
[Environment]::SetEnvironmentVariable('OPENAI_WORKER_MAX_STEPS', '60', 'User')
```

Restart Claude Code and run `/openai-workers`; the diagnostics display the effective model/tier of all workers and the free-key ledger totals, not the actual secret values.


## Claude Desktop Chat configuration

The [desktop extension](DESKTOP.md) exposes **two masked API-key fields** at installation and stores them through Claude Desktop's OS-backed secure configuration. The straight key maps to `OPENAI_API_KEY`; the daily free-programme key maps to `OPENAI_FREE_API_KEY`. On Windows, leaving either field empty allows fallback to its corresponding existing DPAPI key if one is stored for the same Windows user.

The Desktop MCP server and native Claude Code plugin load the **same worker model/tier environment-variable names** and **same quota settings**, although per-worker CLI mod configuration changes only apply to newly started sessions. Restart Claude Desktop after changing Windows user environment variables. The `.mcpb` cannot be configured to silently bypass a missing free key with the paid key.

Regular Desktop Chat only has text-only MCP delegation; the Code tab uses native permission-gated file/shell tools.
