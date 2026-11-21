# Using Chlaude-GPTopus in Claude Desktop

[← Overview](../README.md) · [Installation](INSTALLATION.md) · [Configuration](CONFIGURATION.md) · [Daily limits](QUOTAS_AND_BILLING.md)

Chlaude-GPTopus supports **both tabs** of the Claude Desktop app, but they use *different* extension mechanisms:

| Where you work | How it works | Can OpenAI workers use Claude Code's file/shell tools? | Install method |
|---|---|---|---|
| **Code tab** (a local Claude Code session) | Native Claude Code `openai-workers:*` subagents via the mod/plugin | **Yes**, through Claude Code permission checks | Install the marketplace plugin once; then use the desktop Code tab |
| **Chat tab** (regular Claude conversation) | Desktop MCP extension; Claude can delegate prompts and read OpenAI answers | **No.** Text-only OpenAI consultation; Claude may use separate approved tools itself | Install a `.mcpb` extension directly in Claude Desktop |

The Code and Chat integrations **share the same on-device Astra/Terra token ledger** when run under the same Windows user (or on the same platform with the same `OPENAI_WORKER_USAGE_DIR`). Both use the same two key *profiles*; keys entered in the desktop extension are stored by Claude Desktop, while Code-tab keys can stay in the existing Windows DPAPI store. You do not need to paste keys into a conversation.

## A. Chat tab: install the desktop extension (no command line)

1. **Download** [Chlaude-GPTopus-Desktop.mcpb](../dist/Chlaude-GPTopus-Desktop.mcpb) from this repository. If GitHub previews it as a binary, use the **Download raw file** option.
2. Open **Claude Desktop** → **Settings** → **Desktop app** → **Extensions: Manage**. In some app versions this is **Settings → Extensions**.
3. Open **Advanced settings** → **Extension Developer** → **Install Extension…**. Select the downloaded `.mcpb` file.
4. Enter the **straight OpenAI API key** (Sol / Astra / Luna / Flex) and **free-programme API key** (daily Astra / Terra). Input is masked and the fields are declared `sensitive: true` so Claude Desktop can use OS-backed secret storage.

> [!CAUTION]
> Treat the installed extension's settings page as sensitive. Some Claude Desktop builds have displayed environment-variable values derived from `sensitive: true` fields in plaintext after installation (tracked upstream as `modelcontextprotocol/mcpb#244`). Avoid screen-sharing or exposing that settings panel when API keys are configured.
5. Finish installation. Open a **Chat** conversation, click **+ → Connectors**, and confirm the `chlaude-gptopus-desktop` tools are connected. Restart Claude Desktop if they do not appear.

> **Already stored keys with `install.ps1` on Windows?** You can leave the two fields blank to use the existing `%LOCALAPPDATA%\ClaudeOpenAIWorkers` DPAPI keys. Key storage is *not* copied between formats. If you installed Claude Desktop under a different Windows user, the DPAPI fallback cannot read your old keys.

### Try it

> Ask `list_openai_workers` to show all OpenAI profiles and which API key profiles are configured. Then use `ask_openai_worker` with `daily-terrafree` to propose three ways to simplify this design. Poll the response using `poll_openai_worker` if the worker is still running.

Claude can call these tools in a normal Chat conversation. Depending on your Claude Desktop settings, tool approval may be requested.

### Desktop Chat tools

| Tool | Purpose |
|---|---|
| `list_openai_workers` | Show six worker names, models, selected tiers and whether both keys are configured |
| `ask_openai_worker` | Start a new OpenAI task; specify `worker` and `task`, optionally `context`, `reasoning_effort`, `max_output_tokens`, `previous_response_id` |
| `poll_openai_worker` | Collect an asynchronous response; use the same worker and returned response ID |
| `cancel_openai_worker` | Request best-effort cancellation of an active response |
| `openai_worker_daily_usage` | Inspect the persistent Astra/Terra daily token ledger, reservations and UTC reset |

**Why polling?** OpenAI uses its background Responses API for these workers, especially important for Flex. A long request may return an ID and `in_progress` instead of keeping a desktop tool call open indefinitely. Claude can poll again until complete. You can continue a completed conversation with `previous_response_id` **using the same worker and key**.

### What Chat-tab workers cannot do

- They **cannot independently inspect, modify or execute local repository files**, unlike the native Code-tab agents.
- They receive only the task/context that Claude explicitly passes. A file visible to Claude Desktop is **not automatically sent** to OpenAI; Claude must provide relevant excerpts.
- They cannot autonomously spawn Claude Code agents or share a live agent's state. Claude remains responsible for coordination and any changes made by other installed tools.
- The server uses OpenAI's `store: true` and `background: true` Responses API mode. Avoid sending sensitive material without understanding API retention and any free-programme data-sharing conditions.

## B. Code tab: keep full native subagents

The existing Claude Code plugin already runs in **local Code sessions inside Claude Desktop**; native mods are supported there, not just the terminal. Install the marketplace plugin once (for example from a Claude Code session with the plugin manager), and it should be available when you start a local Code session under the same Claude Code configuration.

Using the desktop plugin manager:

1. Open Claude Desktop's **Code** tab and start a **local** Code session.
2. Use the **Plugins** option next to the composer to add the community marketplace from `https://github.com/techrote/Chlaude-GPTopus` if your app version supports that workflow.
3. Install `openai-workers` from the marketplace, restart the Code session, and run `/openai-workers`.

If local marketplace registration is unavailable in your desktop build, do the **one-time** marketplace setup using the [Windows installer](INSTALLATION.md). After that, use the Code tab for normal work; no terminal is required for each delegation.

**Not supported:** native Code-tab mods in cloud/WSL Code sessions or regular Chat tab. Use a **local** Code session for file and shell access. The `.mcpb` Chat extension does not replace the native Code plugin.

## Keys, tiers, and quotas across both tabs

- Both forms use **one straight key** (`sol`, `astra`, `luna`, `flex6-1`) and **one free key** (`daily-astrafree`, `daily-terrafree`). Neither profile silently borrows the other key.
- `flex6-1` defaults to `gpt-6.1-sol` on the `flex` service tier. Free-programme agents default to the `default` tier.
- The free-key daily quota defaults are 250,000 tokens for Astra's shared model group and 2,500,000 for Terra's; local soft limits permit 10% headroom by default.
- The ledger lives outside the extension install directory. On Windows, it is `%LOCALAPPDATA%\ClaudeOpenAIWorkers\free-usage-ledger.json`. The code and Chat tools lock the same ledger file for concurrent reservations.
- Overrun is **not guaranteed free**. A request that crosses OpenAI's complimentary limit can be charged; the local ledger only tracks calls made by this plugin and cannot inspect other clients' usage. Your `$88/month` credit reference is informational, not an account-level spending cap.
- Change the local quota settings and agent model/tier defaults using the Windows user environment settings in [Configuration](CONFIGURATION.md) and [Daily limits](QUOTAS_AND_BILLING.md). Restart Claude Desktop so the new environment reaches its MCP process.

## Updates, troubleshooting, and development

- To **update Chat support**, download and install the latest `.mcpb` again; privately installed extensions do not automatically update from GitHub.
- To **update Code support**, update the marketplace plugin. These are separate installations.
- For missing Chat tools: confirm the extension is enabled, inspect Claude Desktop's local extension logs under Settings → Extensions / Desktop app → Manage, and restart the app.
- For missing keys: review the configured extension fields or save the Windows DPAPI keys through the Code plugin installer. Avoid exposing the installed extension's environment/settings view while keys are configured.
- For a quota stop: use `openai_worker_daily_usage` and check the UTC reset rather than deleting the ledger.
- A real Claude Desktop UI installation and live OpenAI call still need **manual end-to-end acceptance** on the target machine. The source is covered by portable unit and stdio protocol tests.

Developer build command from the repository root:

```powershell
node .\scripts\build-desktop.mjs
```

This creates `dist/Chlaude-GPTopus-Desktop.mcpb` using Node built-ins, without downloading dependencies. The bundle includes only its MCP server, shared OpenAI/ledger code and Windows DPAPI key reader. It has **no shell/file editing capabilities**.

See [official Claude Desktop local-extension installation guidance](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) and [MCPB manifest format](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md).
