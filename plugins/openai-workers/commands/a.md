---
description: Delegate a task to an OpenAI, NVIDIA Build or local LM Studio worker subagent. Usage: /oai:a <worker> [none|low|medium|high|xhigh|max] <task>
argument-hint: <sol6-2|astra6-2|luna6|luna6fast|luna6flex|sol6-1flex|astra6free|terra5-6free|kimik3-1pro|mistral4large|nemo3-5supervl|nemo3-5lightning|sprocket0-5|lfm2-5mini|lfm3heretic|lfm3vl|lfm2-5turbo8b|lfm2-5turbo24b|inkling2mini|katcoder2-5> [none|low|medium|high|xhigh|max] <task>
---

Delegate this task to the worker named by the first word of the arguments below.

Arguments: $ARGUMENTS

Do exactly this:

1. Take the first word of the arguments as WORKER. It must be one of these names:
   - OpenAI: sol6-2, astra6-2, luna6, luna6fast, luna6flex, sol6-1flex, astra6free, terra5-6free
   - NVIDIA Build (free, remote): kimik3-1pro, mistral4large, nemo3-5supervl, nemo3-5lightning
   - LM Studio (local models on this PC): sprocket0-5, lfm2-5mini, lfm3heretic, lfm3vl, lfm2-5turbo8b, lfm2-5turbo24b, inkling2mini, katcoder2-5

   If it is not, stop and list those names grouped as above.
2. If the second word is exactly one of none, low, medium, high, xhigh, max, it is EFFORT: drop it from the task. Call the **Agent** tool with `subagent_type` set to `oai:WORKER`. The prompt is the remaining task text; when EFFORT was given, the prompt must start with its own first line `[oai-effort:EFFORT]` followed by a newline and then the task. (The plugin strips that line and clamps the effort to the worker's allowed range; `none` switches thinking off on NVIDIA and LM Studio workers that support it and is ignored by OpenAI workers.) If the task is large, split it into a few bounded pieces and spawn one subagent of the same type per piece.
3. Do not do the task yourself. Do not search the codebase for the worker. Never call the `mcp__plugin_oai_bridge__*` tools: they are internal plugin transport and are refused for model calls.
4. When the subagents finish, report their results briefly. If they wrote files, give the paths.
