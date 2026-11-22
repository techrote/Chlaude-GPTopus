# Working with OpenAI subagents

[← Overview](../README.md) · [Troubleshooting →](TROUBLESHOOTING.md)

Claude remains the conversation's lead model. Only explicitly delegated `oai:*` subagent model steps use OpenAI. Unlike an independent terminal agent, each worker's `Read`, `Edit`, `Write` and `Bash` requests flow through Claude Code's permission system.

## First test: report only

Start with a **read-only task** to check credentials and routing without risking source edits:

> Delegate to `oai:terra5-6free`. Inspect the README and source layout. Summarize the project in five sentences, with three suggested improvements. Do not edit files or run network commands.

Then run `/oai` and verify that the free-key Terra usage has increased. The diagnostic reports **local usage only**. If it fails, see [Troubleshooting](TROUBLESHOOTING.md).

## Independent investigation and review

> Give `oai:luna6` a targeted investigation of module A and `oai:terra5-6free` a separate investigation of module B. Ask each for a file-and-line evidence trail. Compare their findings before planning changes.

> Have `oai:astra6free` review the proposed design for regressions and alternative approaches. It should not modify files; return clear PASS/CONCERNS/BLOCKERS findings.

## Implementation with a second opinion

> Delegate implementation of a small, isolated fix to `oai:sol6-1flex` with a narrow file scope. Require unit tests. When it finishes, ask `oai:astra6-2` to review the diff independently; summarize tests and unresolved concerns.

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

In the Chat tab, ask Claude: "Use the `terra5-6free` OpenAI worker to critique this plan, then `astra6free` to evaluate the risk. Poll until both finish. Summarize where they disagree." Claude calls `ask_openai_worker` and `poll_openai_worker`; the workers only receive the text Claude supplies, not local files by default. For repository-writing subagents, switch to the native **Code** tab. [Desktop guide](DESKTOP.md).

## Selecting effort without guessing

You can now tell Claude: “Use Luna for small independent checks (Max is mandatory). Use Terra at High for scans; choose Extra High or Max for multi-file investigations. For Sol and Astra, follow each worker's effort note and stay within its configured range.”

For native Code subagents, use the per-invocation effort parameter when Claude Code offers it. In Chat, inspect `list_openai_workers` for `effort_policy`, then send `reasoning_effort` with `ask_openai_worker`. The bridge clamps out-of-range values and never sends API `ultra`. See [Configuration](CONFIGURATION.md#per-worker-reasoning-effort-new-in-v07).
