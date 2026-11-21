# Chlaude-GPTopus

**Give Claude Code six OpenAI-powered subagents — now in the Claude Desktop app too.**

Chlaude-GPTopus includes a Claude Code **mod + plugin marketplace** and a **Claude Desktop Chat extension (`.mcpb`)**. Claude remains the top-level orchestrator. When you ask it to delegate to an `openai-workers:*` agent, that subagent's model steps are served by the OpenAI Responses API. File and shell actions go through Claude Code's usual tool permission checks.

The design deliberately keeps **two API keys** and **local daily-quota controls**:

- **Free-programme key:** both `daily-astrafree` and `daily-terrafree`. Independent 250k / 2.5M daily token groups with persistent, configurable local guardrails.
- **Straight API key:** `sol`, `astra`, `luna` and `flex6-1`. These never consume the free-key ledger.

> [!IMPORTANT]
> “Free” describes the **intended API programme**, not a billing guarantee. Your account needs the appropriate OpenAI entitlement. The plugin's ledger is a best-effort local stopping rule, not OpenAI's authoritative quota meter. In particular, calls outside this plugin are not counted.

## Claude Desktop (Code and Chat)

**Desktop Code tab:** the native Claude Code plugin works in local Code sessions with full tool permissions. **Desktop Chat tab:** install the text-only [one-click desktop extension](dist/Chlaude-GPTopus-Desktop.mcpb) and delegate to the same six OpenAI model profiles through MCP tools. The desktop extension cannot read/write local files or run shell commands for OpenAI; use the Code tab for that. Both paths share one local free-key quota ledger.

**[Desktop setup walkthrough →](docs/DESKTOP.md)** (no CLI required for regular Chat; masked two-key settings in the extension installer).

## Quick start: Windows 11

**Requirements:** Claude Code **2.1.299+**, Node.js **20.11+**, PowerShell 5.1+ and two OpenAI API keys (or one key if you intend to use only one set of workers).

```powershell
# Clone this repository, then install the Claude Code plugin.
git clone https://github.com/techrote/Chlaude-GPTopus.git
cd Chlaude-GPTopus
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The installer checks prerequisites, validates the marketplace, prompts only for missing keys, saves each key using Windows DPAPI, and registers `openai-workers` at user scope. **Restart Claude Code** after installation.

In Claude Code:

```text
/openai-workers
```

You should see six worker profiles, whether each key is configured, and Astra/Terra local daily usage. For a quick smoke test:

> Ask `openai-workers:daily-terrafree` to inspect this repository, identify three low-risk improvements, and report findings without modifying files.

### The six workers

| Agent name in Claude Code | Default OpenAI model | Service tier | API key | Local free-key guardrail |
|---|---|---|---|---|
| `openai-workers:daily-terrafree` | `gpt-5.6-terra` | `default` | Free key | 2,500,000 tokens/day |
| `openai-workers:daily-astrafree` | `gpt-6-astra` | `default` | Free key | 250,000 tokens/day |
| `openai-workers:flex6-1` | `gpt-6.1-sol` | `flex` | Straight key | No |
| `openai-workers:luna` | `gpt-6-luna` | Project default | Straight key | No |
| `openai-workers:sol` | `gpt-6.2-sol` | Project default | Straight key | No |
| `openai-workers:astra` | `gpt-6.2-astra` | Project default | Straight key | No |

For `flex6-1`, the agent name uses a hyphen because Claude Code agent names cannot contain `.`. The tier and model IDs can be overridden; unsupported API combinations fail rather than silently switching tier.

## Everyday controls

From this repository's root in PowerShell:

```powershell
# Replace either key without displaying it on screen.
.\plugins\openai-workers\scripts\set-openai-key.ps1 -Profile free
.\plugins\openai-workers\scripts\set-openai-key.ps1 -Profile standard

# Daily token targets, 10% headroom and conservative concurrent reservations.
.\plugins\openai-workers\scripts\set-daily-budgets.ps1 `
  -AstraDailyTokens 250000 -TerraDailyTokens 2500000 `
  -OverrunPercent 10 -ReserveTokens 12000 -MaxInFlight 16 `
  -MonthlyAllowanceUsd 88

# Set tiers and optionally override a model.
.\plugins\openai-workers\scripts\set-worker-tier.ps1 -Agent flex6-1 -Tier flex
.\plugins\openai-workers\scripts\set-worker-tier.ps1 -Agent astra -Tier priority
```

These settings are saved as **Windows user environment variables**. Restart Claude Code and its terminal after changing them. The `$88` setting is **informational only**, not a billing cap.

## Example delegations

> Delegate a broad scan to `openai-workers:daily-terrafree`, request a second opinion from `openai-workers:daily-astrafree`, and summarize their disagreements before you change code.

> Use `openai-workers:flex6-1` for a time-insensitive, bounded refactor. Have `openai-workers:astra` audit the result independently and report unresolved risks.

> Launch two independent `openai-workers:luna` investigations in parallel. Give each a separate target file and ask for findings, not edits.

Claude Code still decides whether and when to delegate, and normal tool authorization applies. The plugin does not automatically distribute work to all agents.

## Documentation

| Guide | What it covers |
|---|---|
| [Claude Desktop support](docs/DESKTOP.md) | Code-tab native subagents, Chat-tab one-click extension, two keys, polling and limitations |
| [Setup and upgrading](docs/INSTALLATION.md) | First install, updates, two-key setup, Windows walkthrough, alternative Linux/macOS configuration |
| [Configuration reference](docs/CONFIGURATION.md) | Every supported environment variable, models, Flex/Fast tiers and per-worker limits |
| [Daily usage and billing](docs/QUOTAS_AND_BILLING.md) | 250k/2.5M groups, 10% headroom, reservations, local ledger, reset behaviour, charging caveats |
| [Examples and workflow](docs/WORKFLOWS.md) | Delegation patterns, parallel reviewers, tool permissions, safe first task |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Missing keys, plugin/bridge errors, quota stops, Flex problems, resets and diagnostics |
| [Architecture and security](docs/ARCHITECTURE.md) | Request path, permission boundary, key handling, failure and privacy model |
| [Developer guide](CONTRIBUTING.md) | Run tests, component map, how to change an agent safely |

## Compatibility and verification

- Claude Desktop **Chat** local MCPB extension (`.mcpb`), plus native **Code** tab support for local sessions.
- Native **Claude Code mod hooks** (`session.start`, `turn.step`) plus a local **MCP stdio bridge** (`node`). The code is designed for Claude Code **2.1.299+**.
- **41 passing local Node tests** cover tool translation, key routing, tier behaviour, daily ledger, concurrent reservations and UTC rollover.
- `claude plugin validate` and a real end-to-end Claude Code + OpenAI run **must still be executed on the target machine**. Local mocked tests are not proof of live API access or final compatibility.
- Works primarily on **Windows** with DPAPI key storage. On macOS/Linux, provide `OPENAI_API_KEY` and `OPENAI_FREE_API_KEY` as secure process environment variables; Windows PowerShell setup scripts do not apply.

## Security and limitations

The OpenAI subagent receives delegated instructions, relevant repository content, and tool results. The bridge uses the **Responses API with `background: true` and `store: true`**. Review OpenAI data retention and any data-sharing eligibility before using a free-programme key with private code. No keys should ever be committed to Git.

The local ledger counts **only requests from this plugin's free-key agents**, including local concurrent reservations, and can be overtaken by unexpectedly large calls or usage elsewhere. An ambiguous network failure retains a reservation rather than pretending a call was free. OpenAI account dashboards remain authoritative for billing and complimentary-token eligibility.

This community project is **not affiliated with OpenAI or Anthropic**. [License](plugins/openai-workers/LICENSE).
