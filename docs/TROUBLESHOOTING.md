# Troubleshooting and diagnostics

[← Overview](../README.md) · [Architecture →](ARCHITECTURE.md)

Start with `/openai-workers` inside Claude Code. It prints effective agent model/tier, configured-key status and local Astra/Terra usage **without revealing either API key**.

| Symptom | Likely reason | Next action |
|---|---|---|
| `claude` not found | Claude Code CLI not installed or missing PATH | Install/update Claude Code; open a new terminal; run `claude --version` |
| `node` not found | Node.js absent | Install Node.js 20.11+; run `node --version` |
| Marketplace validation failed | Wrong folder or unsupported Claude version | Run `claude plugin validate .` in repository root; use Claude Code 2.1.299+ |
| Slash command `/openai-workers` not found | Plugin not loaded | Restart Claude Code; inspect `/plugin` for `openai-workers@openai-worker-local` |
| “OpenAI bridge not connected” | MCP process failed to start or load | Inspect `/mcp` and Node version; run tests from `plugins/openai-workers` |
| “Missing free OpenAI key” | Free key not configured | Run `set-openai-key.ps1 -Profile free` (Windows) or set `OPENAI_FREE_API_KEY` securely |
| “Missing standard OpenAI key” | Straight key not configured | Run `set-openai-key.ps1 -Profile standard` (Windows) or set `OPENAI_API_KEY` securely |
| API `401`/`403` | Key invalid or lacks model/API entitlement | Check the correct OpenAI project, account permission and programme eligibility |
| API `429` | API rate limiting or unavailable capacity | Reduce concurrency; use a supported standard tier; inspect billing limits |
| Flex unavailable | Model incompatible with Flex | Use `flex6-1` (`gpt-6.1-sol`) or select `default` tier for incompatible models |
| Daily worker paused at limit | Used + reserved tokens reached soft threshold | Wait for 00:00 UTC rollover, or inspect genuine in-flight reservations; do not erase ledger |
| Ledger unreadable | Invalid/corrupt `free-usage-ledger.json` | Back up the file; inspect it and repair deliberately; free workers fail closed |
| Large reservations remain after interruption | Network timeout may have created an upstream response | Run `/openai-workers` to reconcile known response IDs; investigate before any manual edit |
| Subagent doesn't edit a file | Claude Code tool permission denied | Inspect Claude Code permission prompts and managed policy; return a suggested patch instead |

## Commands worth knowing

```powershell
claude --version
node --version
claude plugin validate .\plugins\openai-workers
claude plugin validate .
node --test .\plugins\openai-workers\tests\*.test.mjs
```

Inside Claude Code use `/plugin` for installed plugins, `/mcp` for bridge health and `/openai-workers` for agent diagnostics.

## Windows key files

```text
%LOCALAPPDATA%\ClaudeOpenAIWorkers\openai-key.dpapi        (straight key)
%LOCALAPPDATA%\ClaudeOpenAIWorkers\openai-free-key.dpapi   (free key)
%LOCALAPPDATA%\ClaudeOpenAIWorkers\free-usage-ledger.json
```

The encrypted key files are bound to the Windows user profile. To change a key, run the setup script again; copying encrypted files between machines/users normally will **not** work. Restart Claude Code after changing a key because the bridge may cache its decrypted value.

## What to gather for a bug report

Record the Claude Code and Node versions, operating system, plugin version, affected agent, exact tier/model, sanitized error text and whether the failure reproduces with a read-only task. Include the output of local tests and the **key presence indicators**, but **never** paste an API key, Authorization header, plaintext DPAPI decryption output, raw private repository excerpts or confidential tool outputs.

## Resetting local usage

The ledger is intentionally conservative. It is a JSON state file with a short-lived lock directory beside it. If you suspect a stale lock or reservation, stop all Claude Code sessions first, take a backup, and inspect the pending entries and timestamps. Only change or delete entries when you understand what OpenAI may have accepted. Incorrectly resetting it can defeat your free-key guardrail. OpenAI's billing dashboard remains the source of truth.
