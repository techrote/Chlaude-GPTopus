// Pure text formatting for /oai:run replies (no I/O; safe inside the mod).
/** One-screen text for the mod command. */
export function directReply(r) {
  if (r?.error) return r.error === 'usage'
    ? 'Usage: /oai:run <worker> [none|low|medium|high|xhigh|max] <task>   (@C:\\path\\file attaches a file)\n       /oai:run            list recent runs\n       /oai:run D3         show a run\'s full result'
    : r.error;
  if (r?.started) return `Started ${r.started.id}: ${r.started.worker} (${r.started.model}, effort ${r.started.effort}). Text-only, no Claude involved.${r.started.notes?.length ? `\n${r.started.notes.join('\n')}` : ''}\nCheck with /oai:run ${r.started.id}`;
  if (r?.run) {
    const x = r.run;
    return `${x.id} ${x.worker} ${x.status}${x.reason ? `: ${x.reason}` : ''}\nTask: ${x.task}\n\n${x.text ?? (x.status === 'running' ? '(still running)' : '')}`;
  }
  if (r?.runs) return r.runs.length ? r.runs.map(x => `${x.id.padEnd(5)} ${x.worker.padEnd(16)} ${x.status.padEnd(8)} ${x.task.replace(/\s+/g, ' ').slice(0, 60)}`).join('\n') : 'No direct runs yet. ' + directReply({ error: 'usage' });
  return 'Unexpected reply.';
}
