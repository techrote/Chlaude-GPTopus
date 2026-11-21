# Working with OpenAI subagents

[← Overview](../README.md) · [Troubleshooting →](TROUBLESHOOTING.md)

Claude remains the conversation's lead model. Only explicitly delegated `openai-workers:*` subagent model steps use OpenAI. Unlike an independent terminal agent, each worker's `Read`, `Edit`, `Write` and `Bash` requests flow through Claude Code's permission system.

## First test: report only

Start with a **read-only task** to check credentials and routing without risking source edits:

> Delegate to `openai-workers:daily-terrafree`. Inspect the README and source layout. Summarize the project in five sentences, with three suggested improvements. Do not edit files or run network commands.

Then run `/openai-workers` and verify that the free-key Terra usage has increased. The diagnostic reports **local usage only**. If it fails, see [Troubleshooting](TROUBLESHOOTING.md).

## Independent investigation and review

> Give `openai-workers:luna` a targeted investigation of module A and `openai-workers:daily-terrafree` a separate investigation of module B. Ask each for a file-and-line evidence trail. Compare their findings before planning changes.

> Have `openai-workers:daily-astrafree` review the proposed design for regressions and alternative approaches. It should not modify files; return clear PASS/CONCERNS/BLOCKERS findings.

## Implementation with a second opinion

> Delegate implementation of a small, isolated fix to `openai-workers:flex6-1` with a narrow file scope. Require unit tests. When it finishes, ask `openai-workers:astra` to review the diff independently; summarize tests and unresolved concerns.

Because Claude controls delegation and tool approval, **parallelism is not guaranteed** merely by naming several workers. For overlapping writes, use separate branches/worktrees or assign disjoint files.

## Guardrails to use in prompts

- Specify allowed files, scope, and whether edits are permitted.
- Require evidence of tests run vs tests merely proposed.
- Give the worker a stop condition (“report and hand back after X”).
- Prefer independent review for security-sensitive or destructive changes.
- Avoid putting secrets into prompts, `CLAUDE.md` or repository files.

## What happens during a run

The plugin replaces the subagent's `turn.step` through a Claude Code mod. It sends a request to the OpenAI Responses API, polls for completion, translates OpenAI function calls into native Claude tool calls, feeds the tool results back to OpenAI, and finally returns a report to the orchestrator. An OpenAI error stops the worker **without covert fallback to Claude**, protecting the intended cost/accounting boundary.

## Limitations

Workers have only the tools exposed by this plugin (`Read`, `Edit`, `Write`, `Bash`); they are not given the parent Claude session's entire tool catalogue or all integrations. Tool permissions remain subject to Claude Code and any managed policies. Both provider access and tool capabilities may vary by installed version. Unbounded, full-repository parallel changes are not a good first test.


## Regular Claude Desktop Chat

In the Chat tab, ask Claude: "Use the `daily-terrafree` OpenAI worker to critique this plan, then `daily-astrafree` to evaluate the risk. Poll until both finish. Summarize where they disagree." Claude calls `ask_openai_worker` and `poll_openai_worker`; the workers only receive the text Claude supplies, not local files by default. For repository-writing subagents, switch to the native **Code** tab. [Desktop guide](DESKTOP.md).
