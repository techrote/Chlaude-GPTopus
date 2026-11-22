---
description: Delegate a task to an OpenAI worker subagent. Usage: /openai-workers:ask <worker> <task>
argument-hint: <sol|astra|luna|flex6-1|daily-astrafree|daily-terrafree> <task>
---

Delegate this task to the OpenAI worker named by the first word of the arguments below.

Arguments: $ARGUMENTS

Do exactly this:

1. Take the first word of the arguments as WORKER. It must be one of: sol, astra, luna, flex6-1, daily-astrafree, daily-terrafree. If it is not, stop and list those six names.
2. Call the **Agent** tool with `subagent_type` set to `openai-workers:WORKER` and the rest of the arguments as the prompt. If the task is large, split it into a few bounded pieces and spawn one subagent of the same type per piece.
3. Do not do the task yourself. Do not search the codebase for the worker. Never call the `mcp__plugin_openai-workers_bridge__*` tools: they are internal plugin transport and are refused for model calls.
4. When the subagents finish, report their results briefly. If they wrote files, give the paths.
