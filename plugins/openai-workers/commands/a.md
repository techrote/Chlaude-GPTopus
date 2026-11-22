---
description: Delegate a task to an OpenAI worker subagent. Usage: /oai:a <worker> [low|medium|high|xhigh|max] <task>
argument-hint: <sol6-2|astra6-2|luna6|luna6fast|luna6flex|sol6-1flex|astra6free|terra5-6free> [low|medium|high|xhigh|max] <task>
---

Delegate this task to the OpenAI worker named by the first word of the arguments below.

Arguments: $ARGUMENTS

Do exactly this:

1. Take the first word of the arguments as WORKER. It must be one of: sol6-2, astra6-2, luna6, luna6fast, luna6flex, sol6-1flex, astra6free, terra5-6free. If it is not, stop and list those eight names.
2. If the second word is exactly one of low, medium, high, xhigh, max, it is EFFORT: drop it from the task. Call the **Agent** tool with `subagent_type` set to `oai:WORKER`. The prompt is the remaining task text; when EFFORT was given, the prompt must start with its own first line `[oai-effort:EFFORT]` followed by a newline and then the task. (The plugin strips that line and clamps the effort to the worker's allowed range.) If the task is large, split it into a few bounded pieces and spawn one subagent of the same type per piece.
3. Do not do the task yourself. Do not search the codebase for the worker. Never call the `mcp__plugin_oai_bridge__*` tools: they are internal plugin transport and are refused for model calls.
4. When the subagents finish, report their results briefly. If they wrote files, give the paths.
