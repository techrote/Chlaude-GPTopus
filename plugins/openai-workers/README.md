# OpenAI-backed Claude Code subagents — v0.5.0

This plugin (`oai`) registers eight native Claude Code agents. The main Claude Code session remains on Claude, while explicit `oai:*` delegates use OpenAI's Responses API and Claude Code's normal file/shell permission checks.

## Simple two-key setup

| Claude Code agent | Default model / tier | API key |
| --- | --- | --- |
| `oai:astra6free` | `gpt-6-astra`, default | **Free/daily** |
| `oai:terra5-6free` | `gpt-5.6-terra`, default | **Free/daily** |
| `oai:sol6-1flex` | `gpt-6.1-sol`, flex | **Straight API** |
| `oai:sol6-2` | `gpt-6.2-sol` | **Straight API** |
| `oai:astra6-2` | `gpt-6.2-astra` | **Straight API** |
| `oai:luna6` | `gpt-6-luna` | **Straight API** |
| `oai:luna6fast` | `gpt-6-luna`, fast | **Straight API** |
| `oai:luna6flex` | `gpt-6-luna`, flex | **Straight API** |

The two daily agents intentionally use **one and the same key**. All six others use the second key. The two free-key agents share a **persistent local usage ledger**. Astra's group has a 250,000-token daily target and Terra's group 2,500,000. The local soft-stop defaults to 10% above those targets (275,000 / 2,750,000), with 12,000-token reservations for in-flight calls. It resets at 00:00 UTC and survives restarts, using a file lock for concurrent workers. **Straight-key workers (including `sol6-1flex`) never count against this free-key ledger.** No cross-key fallback. OpenAI decides actual complimentary entitlement and billing.

## Installation (Windows 11)


From a GitHub marketplace inside Claude Code: `/plugin install oai --marketplace techrote/Chlaude-GPTopus` (then set the keys as below). Locally:
1. Install Claude Code 2.1.299+ and Node.js 20.11+.
2. Extract ZIP and open PowerShell in `openai-worker-marketplace`.
3. Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`.
4. When prompted, provide first your **straight API** key and then your **Astra/Terra free** key. Both are saved with Windows DPAPI for your Windows user. The plugin never prints them.
5. Restart Claude Code and run `/oai` to see which profiles are configured.

If you already installed an older release, extract the archive over your previous marketplace directory and run:

```powershell
claude plugin marketplace update openai-worker-local
claude plugin update oai@openai-worker-local --scope user
```

Your previously stored `openai-key.dpapi` remains the straight API key. Only the new complimentary key must be added:

```powershell
.\plugins\openai-workers\scripts\set-openai-key.ps1 -Profile free
```

To replace the straight API key, run:

```powershell
.\plugins\openai-workers\scripts\set-openai-key.ps1 -Profile standard
```

Optional environment variables (take precedence over Windows DPAPI):

- `OPENAI_API_KEY` — straight API key for four normal workers
- `OPENAI_FREE_API_KEY` — shared free/daily key for Astra and Terra

**Key separation is strict:** when the free key is missing, the two daily workers fail rather than secretly switching to your straight API key. Creation, polling, continuation and cancellation all use the same key as the chosen worker.

On macOS/Linux, set the two environment variables in the Claude Code process environment. The included DPAPI scripts are Windows-only.

## Local daily-quota controls (free API key only)

The quota ledger is stored at `%LOCALAPPDATA%\ClaudeOpenAIWorkers\free-usage-ledger.json` (Windows) or `$XDG_STATE_HOME/claude-openai-workers/free-usage-ledger.json` (Unix, default `~/.local/state`). The older v0.3 `usage-ledger.json` is left untouched, avoiding mixing straight-key history with free-key usage. It stores usage totals and pending response IDs, **never API keys**.

```powershell
.\plugins\openai-workers\scripts\set-daily-budgets.ps1 -AstraDailyTokens 250000 -TerraDailyTokens 2500000 -OverrunPercent 10 -ReserveTokens 12000 -MaxInFlight 16 -MonthlyAllowanceUsd 88
```

`/oai` shows used and reserved tokens, each group’s target and soft limit, UTC reset time and local estimated spending. Environmental overrides are `OPENAI_WORKER_DAILY_OVERRUN_PERCENT`, `OPENAI_WORKER_DAILY_RESERVE_TOKENS`, `OPENAI_WORKER_DAILY_MAX_INFLIGHT`, `OPENAI_WORKER_PREMIUM_DAILY_TOKENS`, `OPENAI_WORKER_TERRA_DAILY_TOKENS` and the informational `OPENAI_WORKER_MONTHLY_ALLOWANCE_USD`. Restart Claude Code after changing user-scope variables.

The guardrail counts input **plus** output tokens reported by OpenAI. Requests from other tools are invisible, and a response with ambiguous network status retains its reservation rather than assuming zero consumption. Reservations are estimates, so actual spending or overrun may exceed the local threshold. Do not manually delete or reset the ledger to bypass the guardrail; review the OpenAI usage dashboard for authoritative figures. A corrupt ledger fails closed for free-key workers, without blocking straight-key agents.

## Configuring tiers and models

Service tiers and model IDs can still be changed independently:

```powershell
.\plugins\openai-workers\scripts\set-worker-tier.ps1 -Agent sol6-1flex -Tier flex
.\plugins\openai-workers\scripts\set-worker-tier.ps1 -Agent astra -Tier priority
.\plugins\openai-workers\scripts\set-worker-tier.ps1 -Agent luna -Tier default
```

`OPENAI_WORKER_SERVICE_TIER` sets a default for original workers. `OPENAI_WORKER_<AGENT>_SERVICE_TIER` overrides one. `sol6-1flex`, `astra6free`, `terra5-6free` preserve their named tier presets unless overridden explicitly. `flex` may be unavailable on some models; an invalid combination causes an error instead of automatically falling back to paid processing.

`OPENAI_WORKER_MAX_STEPS` (default 40) remains an optional execution guardrail. The straight API workers also retain a default estimated `$4` per-worker cost guardrail (`OPENAI_WORKER_MAX_USD`); the two daily workers have no default dollar cap but can have one set per worker. These are independent of OpenAI’s complimentary allowance. The daily models default to standard processing and might incur charges once the API's daily entitlement is exhausted. Verify actual usage and model access in [OpenAI usage](https://platform.openai.com/usage).

## Status panel and live trace

Run `/oai` in Claude Code for the status panel: keys, all workers (model, key, tier, effort range), today's free-key quota with load bars, the month's local estimates, ULTRA state and active workers. It is plain box-drawing text; set `OAI_STATUS_COLOR=1` (user environment, then restart Claude Code) to add ANSI colours if your terminal renders them. The renderer is `plugins/openai-workers/hooks/status-art.js` (`renderStatus`), a pure module you can edit by hand.

Set `OAI_TRACE=1` for Claude Code (and so for its bridge process) to record a live transcript of what each worker sends to and receives from OpenAI. Records are appended as JSON lines to `%LOCALAPPDATA%\ClaudeOpenAIWorkers\trace\YYYY-MM-DD.jsonl` (Windows) or `$XDG_STATE_HOME/claude-openai-workers/trace/` (default `~/.local/state/...`); `OAI_TRACE_DIR` overrides the folder. Each create records time, worker, model, tier, effort, instructions, input messages/tool outputs and tool names; each finished response records id, status, output text, tool calls with arguments, token usage, estimated USD and any failure reason. API keys and auth headers are never written (key-shaped strings are masked). Traces contain your prompts and file contents: delete the folder when you no longer need it.

```powershell
[Environment]::SetEnvironmentVariable('OAI_TRACE', '1', 'User')   # then restart Claude Code
.\plugins\openai-workers\scripts\oai-trace.ps1          # follow new records live (like tail -f)
.\plugins\openai-workers\scripts\oai-trace.ps1 -All     # today's history, then follow
.\plugins\openai-workers\scripts\oai-trace.ps1 -Date 2026-11-22 -NoFollow
```

Portable form: `node plugins/openai-workers/scripts/oai-trace.mjs [--all] [--date YYYY-MM-DD] [--full] [--no-follow] [--no-color]`. Unset `OAI_TRACE` (and restart) to stop tracing.

Old worker names (`sol`, `astra`, `luna`, `flex6-1`, `daily-astrafree`, `daily-terrafree`) were renamed; existing ledger records under the old names are mapped onto the new ones automatically. Rename any `OPENAI_WORKER_<NAME>_*` environment variables you had set (e.g. `OPENAI_WORKER_DAILY_TERRAFREE_MODEL` is now `OPENAI_WORKER_TERRA5_6FREE_MODEL`).

## Delegation

Ask Claude Code to delegate specifically, for example:

> Run the initial investigation with `oai:terra5-6free` and an independent architectural review with `oai:astra6free`. Use `oai:sol6-1flex` for time-insensitive fixes.

The plugin intercepts each native subagent model step, calls OpenAI Responses API in background mode, converts GPT tool calls to Claude Code's `Read`, `Edit`, `Write`, and `Bash` tools (still gated by Claude Code's permissions), and returns the result to Claude. It does not redirect the top-level Claude model or modify default built-in subagents.

## Security and caveats

- Delegated prompts, repository content, tool results and relevant project instructions can be sent to OpenAI. Check data-sharing requirements before using the complimentary-key programme on sensitive code.
- Responses use `background: true`, `store: true` to support polling and continuation. OpenAI billing and data controls apply.
- On Windows, both keys are encrypted at rest with DPAPI in `%LOCALAPPDATA%\ClaudeOpenAIWorkers`. They are not logged by the plugin.
- Bridge tool calls use Claude Code's MCP interface. For restricted permission modes, you may have to allow `mcp__plugin_oai_bridge__create`, `poll`, `cancel`, `page` and `health`. This does not bypass individual file/shell permissions.
- Free-key workers have local shared-group guardrails; the plugin cannot see other clients or enforce server-side complimentary entitlements. Straight-key calls are excluded from the free ledger.
- Local unit tests mock the API and are not a real billing or Claude Code compatibility test. `claude plugin validate` and a live end-to-end call should be run on the target Windows machine.

## Testing

```powershell
cd .\plugins\openai-workers
npm test
claude plugin validate .\plugins\openai-workers
claude plugin validate .
```

Implementation is not affiliated with OpenAI or Anthropic.


## Claude Desktop app

This plugin's native subagents work in **local Desktop Code sessions** as well as the CLI. For the regular Desktop **Chat** tab, install the companion [one-click MCPB extension](../../dist/Chlaude-GPTopus-Desktop.mcpb). The Chat extension provides six text-only worker tools and a shared local daily ledger, but not Claude Code's file/shell authorizations. See the [desktop guide](../../docs/DESKTOP.md).

## Reasoning effort per worker

Each worker now advertises a minimum/maximum API reasoning effort, a default, and a short note helping Claude choose. Luna defaults to **Max only**, and `terra5-6free` to **High–Max**. The enforced range applies in Claude Code CLI, local Desktop Code sessions and the Desktop Chat MCP extension. Edit one worker using `scripts/set-worker-effort.ps1 -Agent luna -Min max -Max max`, or see [the full configuration guide](../../docs/CONFIGURATION.md#per-worker-reasoning-effort-new-in-v07). **Ultra** is host-managed parallel orchestration, not an API `reasoning.effort` value.
