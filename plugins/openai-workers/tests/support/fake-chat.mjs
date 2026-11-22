/** Test helpers: a fake OpenAI-compatible chat-completions server for bridge/chat.mjs (no network). Not a test file. */
export const sse = chunks => chunks.map(c => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`).join('');
export const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

/**
 * A streamed response. parts: strings (raw SSE text pieces, deliberately split anywhere) or { wait: ms } pauses
 * or { hang: true } (never ends until the request is aborted).
 */
export function streamResponse(parts, signal) {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (signal?.aborted) { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
        if (i >= parts.length) { controller.close(); return; }
        const part = parts[i++];
        if (typeof part === 'string') { controller.enqueue(enc.encode(part)); return; }
        if (part.hang) {
          await new Promise(resolve => { if (signal?.aborted) resolve(); signal?.addEventListener('abort', resolve, { once: true }); });
          continue;
        }
        if (part.wait) await new Promise(r => setTimeout(r, part.wait));
      }
    },
  });
  return { ok: true, status: 200, statusText: 'OK', headers: { get: () => 'text/event-stream' }, body };
}
export const jsonResponse = (status, json) => ({ ok: status >= 200 && status < 300, status, statusText: 'x',
  headers: { get: () => 'application/json' }, body: null, json: async () => json });

/** fetchFn that answers each POST /chat/completions with the next scripted responder and records every request. */
export function scriptedFetch(responders) {
  const requests = [];
  const fn = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, method: init.method, headers: init.headers ?? {}, body });
    const next = responders.shift();
    if (!next) throw new Error('unexpected request');
    return next({ url, init, body, signal: init.signal });
  };
  fn.requests = requests;
  return fn;
}

export async function settle(chat, id, opts = {}) {
  for (let n = 0; n < 100; n++) {
    const r = await chat.poll(id, { wait_ms: 200, ...opts });
    if (r.status !== 'in_progress') return r;
  }
  throw new Error('turn did not settle');
}
