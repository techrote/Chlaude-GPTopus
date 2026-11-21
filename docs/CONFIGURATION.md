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

## Daily ledger and quotas (free key only)

| Variable | Default | Notes |
|---|---:|---|
| `OPENAI_WORKER_PREMIUM_DAILY_TOKENS` | `250000` | Astra-group target |
| `OPENAI_WORKER_TERRA_DAILY_TOKENS` | `2500000` | Terra-group target |
| `OPENAI_WORKER_DAILY_OVERRUN_PERCENT` | `10` | Local headroom beyond target, 0–100% |
| `OPENAI_WORKER_DAILY_RESERVE_TOKENS` | `12000` | Conservative per in-flight call reservation, can be 0 |
| `OPENAI_WORKER_DAILY_MAX_INFLIGHT` | `16` | Maximum simultaneous reserved calls per group |
| `OPENAI_WORKER_MONTHLY_ALLOWANCE_USD` | unset | Informational monthly reference only |
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
