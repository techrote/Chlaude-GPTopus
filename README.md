# Chlaude-GPTopus

**Claude stays in charge. OpenAI lends a hand.**

Sometimes you want another pair of eyes on a tricky bug, a cheap worker for the boring bits, or a second model to challenge an answer. Chlaude-GPTopus lets Claude hand those jobs to OpenAI models using **your own API keys**.

Claude remains the lead. In Claude Code, workers can read, edit and run commands through **Claude Code's existing permissions**. They don't get a secret back door to your machine.

## Pick a worker

| Worker | Model | Good for | API key |
|---|---|---|---|
| `daily-terrafree` | `gpt-5.6-terra` | High-volume everyday work | Free-programme |
| `daily-astrafree` | `gpt-6-astra` | Harder thinking and review | Free-programme |
| `flex6-1` | `gpt-6.1-sol` | Cheaper work that can take its time | Standard |
| `luna` | `gpt-6-luna` | Quick investigations | Standard |
| `sol` | `gpt-6.2-sol` | Coding and implementation | Standard |
| `astra` | `gpt-6.2-astra` | Difficult engineering and second opinions | Standard |

**Set each worker's thinking range.** Luna defaults to **Max only**; daily Terra to **High–Max**. Claude sees a short note explaining when to use each effort, while the plugin enforces the limits. Change a worker with `scripts/set-worker-effort.ps1` or see [configuration](docs/CONFIGURATION.md#per-worker-reasoning-effort-new-in-v07).

There are **two keys**, not six: one for the Astra/Terra free-programme workers, and one for everything else. If a key is missing, the plugin stops; it won't quietly switch to the other one.

## Get started

On Windows, with Claude Code, Node.js and Git installed:

```powershell
git clone https://github.com/techrote/Chlaude-GPTopus.git
cd Chlaude-GPTopus
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The installer prompts for your keys privately and saves them with Windows DPAPI. Restart Claude Code and run `/openai-workers` to see your workers and local usage.

**Claude Desktop works too**, but its tabs have different powers:

- **Code tab (local sessions):** same native workers as Claude Code CLI, including permission-checked file and shell tools.
- **Chat tab:** install the [Desktop extension](dist/Chlaude-GPTopus-Desktop.mcpb) through Claude Desktop's extension settings. Workers can answer questions, but **can't directly read or edit your files**.

See the [Desktop setup guide](docs/DESKTOP.md) for the steps.

For a first try, ask Claude Code:

> Have `daily-terrafree` look for repetitive code, ask `daily-astrafree` to check its findings, then tell me what you'd change. Don't edit anything yet.

## The small print that actually matters

- **“Free” isn't a promise.** Those worker names refer to an intended OpenAI programme. Your account and keys must be eligible; actual billing belongs to OpenAI.
- **The quota ledger is a guardrail, not a wall.** It tracks only this plugin's free-key calls, across sessions on the same machine. Defaults are **250k Astra tokens/day** and **2.5M Terra tokens/day**, with **10% headroom** and a reset at **00:00 UTC**. Large or simultaneous calls can still overshoot.
- **Your $88 monthly credit reference is just a note.** The plugin can't read your real balance or guarantee a spending cap. Its cost estimates can undercount; check the [OpenAI usage dashboard](https://platform.openai.com/usage).
- **Flex can be slow.** Some model/tier combinations aren't supported. The plugin reports an error rather than silently choosing a more expensive tier.
- **Interrupted calls can leave reservations behind.** That's intentional: a request might have been accepted upstream even if your connection dropped. Check usage before clearing anything.
- **Delegated content leaves your machine.** Responses use background processing and storage. Be mindful of private code and the data-sharing terms attached to your API keys.

Claude decides when to delegate; installing the plugin doesn't make every conversation use OpenAI.

## More detail, when you need it

[Installation](docs/INSTALLATION.md) · [Configuration](docs/CONFIGURATION.md) · [Daily limits and billing](docs/QUOTAS_AND_BILLING.md) · [Desktop](docs/DESKTOP.md) · [Examples](docs/WORKFLOWS.md) · [Troubleshooting](docs/TROUBLESHOOTING.md)

The code has automated tests, but **live API calls and the Claude Desktop UI still need testing on your machine**. This is a community project, not an official Claude or OpenAI integration.
