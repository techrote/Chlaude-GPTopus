# Install, update, and remove

[← Overview](../README.md) · [Configuration →](CONFIGURATION.md)

> **Using Claude Desktop instead of the terminal?** Follow [Desktop installation](DESKTOP.md) for the Chat-tab one-click `.mcpb` installer or the native Code-tab plugin.

## Before starting

You need Claude Code 2.1.299 or newer, Node.js 20.11 or newer and an API key for each profile you plan to use. On Windows, use **PowerShell** (not the legacy `cmd.exe` shell). Neither key belongs in the repository or a screenshot.

The straight API key and complimentary/free-programme API key may belong to different OpenAI projects or organisations. The plugin keeps them separate; no silent fallback from one to the other.

Check your tools:

```powershell
claude --version
node --version
git --version
```

## Recommended: guided Windows installation

```powershell
git clone https://github.com/techrote/Chlaude-GPTopus.git
Set-Location .\Chlaude-GPTopus
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

What it does:

1. Confirms Claude Code and Node.js are available and validates the plugin and marketplace.
2. Checks for each existing environment key or Windows encrypted key and does **not** overwrite it.
3. Prompts separately for the **straight API** and the **Astra/Terra free** key if absent. Keystrokes are hidden.
4. Stores each using Windows DPAPI for the current Windows user at `%LOCALAPPDATA%\ClaudeOpenAIWorkers`.
5. Registers the local marketplace (`openai-worker-local`) and installs `openai-workers` at user scope.

Restart all Claude Code sessions and the terminal. Run `/openai-workers` inside Claude Code. You should see “configured” for both keys. The plugin does not verify permissions or real API access without making a paid/eligible API request.

### Only one key right now?

If you have only one key ready, set it before installation, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -NoKeyPrompt
```

The command installs without prompting. Workers whose required key is absent will fail **closed**; they do not borrow the other key. Later, from the repository root:

```powershell
.\plugins\openai-workers\scripts\set-openai-key.ps1 -Profile standard
.\plugins\openai-workers\scripts\set-openai-key.ps1 -Profile free
```

### Native ULTRA owner key (optional)

Only if you intend to enable protected native ULTRA: add `-ProvisionUltraChannel` to `install.ps1` (or run `plugins/openai-workers/scripts/set-ultra-channel.ps1`) to create the private owner key that authenticates the mod to the local bridge. It enables nothing by itself; ULTRA stays disabled until owner policy and `OPENAI_ULTRA_ENABLED=1` say otherwise. See [the private channel](ULTRA_HOSTS.md#private-native-control-channel).

### Which key is which?

| When asked for | This key is used by |
|---|---|
| Straight API / standard | `sol`, `astra`, `luna`, `flex6-1` |
| Astra/Terra free | `daily-astrafree`, `daily-terrafree` |

OpenAI does **not** automatically make a key complimentary. Eligibility is account- and programme-dependent; see [quotas and billing](QUOTAS_AND_BILLING.md).

## Alternative: install marketplace directly from GitHub

If Claude Code can access GitHub and you already configured keys via environment variables or a prior DPAPI setup:

```powershell
claude plugin marketplace add techrote/Chlaude-GPTopus
claude plugin install openai-workers@openai-worker-local --scope user
```

The marketplace identifier stays `openai-worker-local` for compatibility with older v0.x installations, even when the source is GitHub. If that name is *already* registered from a local folder, update that source instead or remove and re-add the marketplace according to Claude Code's `/plugin` manager; do not try to register two marketplaces with the same name. The guided install above is easier if you are upgrading from a local ZIP.

## Upgrading v0.1–v0.5 ZIP installations

Keep your old extracted folder until you've verified the new install. The easiest upgrade preserves the existing local marketplace path:

```powershell
# From your pre-existing marketplace directory, replace its source files
# with this repository's contents, then:
claude plugin marketplace update openai-worker-local
claude plugin update openai-workers@openai-worker-local --scope user
```

Restart Claude Code. DPAPI keys and the free-key ledger live in `%LOCALAPPDATA%\ClaudeOpenAIWorkers`, **outside** the plugin folder, and remain there when files are replaced. `usage-ledger.json` from the older single-key experiment is deliberately not imported; `free-usage-ledger.json` is the active two-key ledger.

If you switch from a locally registered marketplace to a GitHub-hosted one, check the current source in `/plugin` before removing or replacing it; marketplace source changes can affect installed plugin resolution.

## Other operating systems

The Node bridge and mod use portable JavaScript, but **the bundled installer and secure-key scripts target Windows**. On Linux/macOS, use the marketplace CLI directly and supply keys through your OS's secret-management solution into Claude Code's environment:

```bash
export OPENAI_API_KEY='YOUR_STANDARD_KEY_HERE'
export OPENAI_FREE_API_KEY='YOUR_FREE_PROGRAMME_KEY_HERE'
claude plugin marketplace add techrote/Chlaude-GPTopus
claude plugin install openai-workers@openai-worker-local --scope user
```

`export` is shown to explain the variable names, **not** as advice to paste secrets into shell history or hard-code them into profiles. Prefer a credential helper or secret manager. DPAPI decryption will not operate on non-Windows systems.

## Verifying without risking writes

In Claude Code run `/openai-workers`, then delegate a read-only, bounded task to one worker. Check that the report identifies the intended subagent and that the main conversation remains Claude. This is an actual API call and may consume usage/credits. A more detailed checklist is in [Workflows](WORKFLOWS.md).

## Uninstallation

From Claude Code, remove the plugin in `/plugin` (or use your version's `claude plugin uninstall` command). Removing the plugin does **not** automatically delete Windows DPAPI credentials or your local usage ledger. Delete those separately only when you intentionally want to remove their data. Consult [Troubleshooting](TROUBLESHOOTING.md) before deleting a ledger that has an unresolved reservation.
