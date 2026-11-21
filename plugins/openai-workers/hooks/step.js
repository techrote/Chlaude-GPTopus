import { filterToolArgs } from './tools.js';

export const newRun = () => ({ responseId: null, pending: [], seenPrompts: 0, steps: 0, estimatedUsd: 0, finished: false, handback: null });
export const toolId = (callId) => `toolu_${callId}`.replace(/[^a-zA-Z0-9_-]/g, '_');

export function nextInput(messages, run) {
  const prompts = messages.filter(m => m.role === 'user' && !(m.toolResults?.length) && typeof m.text === 'string' && m.text.trim())
    .map(m => m.text.trim());
  const recent = prompts.slice(run.seenPrompts);
  const results = new Map(messages.flatMap(m => m.toolResults ?? []).map(t => [t.tool_use_id, t]));
  if (run.handback && !recent.length && results.get(run.handback.id)?.isError) return { kind: 'report', text: run.handback.message };
  if (run.finished && recent.length === 0) return { kind: 'done' };
  if (!run.responseId) return { kind: 'openai', input: prompts.join('\n\n'), seenPrompts: prompts.length };
  const outputs = run.pending.map(callId => {
    const r = results.get(toolId(callId));
    return { type: 'function_call_output', call_id: callId,
      output: !r ? 'ERROR: Claude Code did not record a result for this tool call' :
        r.isError ? `ERROR: ${r.text ?? ''}` : String(r.text ?? '') };
  });
  return { kind: 'openai', input: [...outputs, ...recent.map(text => ({ role: 'user', content: text }))],
    previous_response_id: run.responseId, seenPrompts: prompts.length };
}

export function stopStep(text = '') {
  return { chunks: [...(text ? [{ kind: 'text', index: 0, text }] : []), { kind: 'stop', stopReason: 'end_turn', usage: null }],
    answer: text, toolUses: [], stopReason: 'end_turn', pending: [], finished: true, handback: null };
}
export function finalStep(text, seed, handback) {
  if (!handback) return stopStep(text);
  const id = toolId(`handback_${seed}`);
  const input = { message: text };
  return { chunks: [{ kind: 'tool', index: 0, id, name: 'SubagentHandback' },
      { kind: 'input', index: 0, json: JSON.stringify(input) }, { kind: 'stop', stopReason: 'tool_use', usage: null }],
    answer: '', toolUses: [{ name: 'SubagentHandback', input }], stopReason: 'tool_use',
    pending: [], finished: true, handback: { id, message: text } };
}
export function responseStep(response, seed, handback) {
  if (response.status !== 'completed') return finalStep(`OpenAI worker ended with status ${response.status}: ${response.reason ?? 'no further information'}`, seed, handback);
  const calls = response.calls ?? [];
  if (!calls.length) return finalStep(response.text?.trim() || '(OpenAI returned no text.)', seed, handback);
  const prefix = response.text || '';
  const chunks = prefix ? [{ kind: 'text', index: 0, text: prefix }] : [];
  const toolUses = [];
  const pending = [];
  for (const call of calls) {
    // Unknown or malformed calls are never executed; return a clearly reported error instead.
    let args;
    try { args = filterToolArgs(call.name, call.args); }
    catch (error) { return finalStep(`OpenAI produced a tool call the bridge refused: ${String(error.message)}.`, seed, handback); }
    const index = toolUses.length + (prefix ? 1 : 0);
    chunks.push({ kind: 'tool', index, id: toolId(call.call_id), name: call.name });
    chunks.push({ kind: 'input', index, json: JSON.stringify(args) });
    toolUses.push({ name: call.name, input: args });
    pending.push(call.call_id);
  }
  chunks.push({ kind: 'stop', stopReason: 'tool_use', usage: null });
  return { chunks, answer: prefix, toolUses, stopReason: 'tool_use', pending, finished: false, handback: null };
}
