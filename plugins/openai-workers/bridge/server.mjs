#!/usr/bin/env node
import readline from 'node:readline';
import { basename } from 'node:path';
import { configuredKey, keyProfileForWorker, createTurn, pollTurn, cancelTurn } from './openai.mjs';
import { reserveRequest, releaseRequest, accountResponse, accountByResponseId, usageSnapshot } from './usage.mjs';

const PAGESIZE = 22000;
const cache = new Map(); // only large, completed, redacted responses, never keys
const defs = [
  { name: 'health', description: 'Report whether the bridge has a configured API key (never returns it).', inputSchema: { type: 'object', properties: {} } },
  { name: 'create', description: 'Start a Responses API model step for the plugin.', inputSchema: { type: 'object', properties: {
    model: { type: 'string' }, worker_type: { type: 'string' }, input: {}, instructions: { type: 'string' }, tools: { type: 'array' }, effort: { type: 'string' }, previous_response_id: { type: 'string' }, max_output_tokens: { type: 'integer' },
    service_tier: { type: 'string', enum: ['auto', 'default', 'flex', 'fast', 'priority'] } }, required: ['model', 'input', 'instructions', 'tools'] } },
  { name: 'usage', description: 'Show local free-key daily tokens, reservations and UTC rollover; these are not authoritative API billing counters.', inputSchema: { type: 'object', properties: {} } },
  { name: 'poll', description: 'Poll an in-progress OpenAI response, up to five seconds.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, worker_type: { type: 'string' }, wait_ms: { type: 'integer' } }, required: ['id'] } },
  { name: 'page', description: 'Fetch a page of an oversized completed response.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, page: { type: 'integer' } }, required: ['id', 'page'] } },
  { name: 'cancel', description: 'Request cancellation of an active OpenAI response.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, worker_type: { type: 'string' } }, required: ['id'] } },
];
const has = (o, key) => Object.prototype.hasOwnProperty.call(o ?? {}, key);
function pack(value) {
  const str = JSON.stringify(value);
  if (str.length <= PAGESIZE) return value;
  const id = value.id;
  if (!id) throw new Error('Oversized response without id.');
  cache.set(id, str);
  if (cache.size > 80) cache.delete(cache.keys().next().value);
  return { id, status: value.status, paged: true, pages: Math.ceil(str.length / PAGESIZE), length: str.length };
}
export async function dispatch(name, args = {}) {
  switch (name) {
    case 'health': return {
      standard: { configured: Boolean(configuredKey(process.env, 'standard')), source: configuredKey(process.env, 'standard') || 'none' },
      free: { configured: Boolean(configuredKey(process.env, 'free')), source: configuredKey(process.env, 'free') || 'none' },
      platform: process.platform,
    };
    case 'create': {
      const profile = keyProfileForWorker(args.worker_type);
      // Straight-key calls never consume or block on complimentary-key ledger.
      if (profile === 'standard') return pack(await createTurn(args, { profile }));
      const ticket = await reserveRequest({ workerType: args.worker_type, model: args.model });
      let response;
      try {
        response = await createTurn(args, { profile: 'free' });
      } catch (err) {
        // An ambiguous transport failure could have been accepted and billed.
        // Hold its reservation rather than incorrectly recording zero tokens.
        if (!/network error|timeout/i.test(String(err?.message))) {
          await releaseRequest(ticket).catch(() => {});
        }
        throw err;
      }
      await accountResponse(ticket, response);
      return pack(response);
    }
    case 'poll': {
      const profile = keyProfileForWorker(args.worker_type);
      const response = await pollTurn(args.id, { wait_ms: args.wait_ms, profile });
      if (profile === 'free') await accountByResponseId(response);
      return pack(response);
    }
    case 'cancel': {
      const profile = keyProfileForWorker(args.worker_type);
      const response = await cancelTurn(args.id, { profile });
      if (profile === 'free' && ['completed', 'failed', 'incomplete', 'cancelled'].includes(response.status)) {
        await accountByResponseId(response);
      }
      return response;
    }
    case 'usage': {
      const initial = await usageSnapshot();
      // Reconcile already-accepted responses after an interrupted session.
      // Read-only GETs against the free key; no new generation requests.
      for (const id of initial.pendingResponseIds.slice(0, 8)) {
        try { await accountByResponseId(await pollTurn(id, { wait_ms: 0, profile: 'free' })); }
        catch { /* retain conservative reservation until next reconciliation */ }
      }
      return usageSnapshot();
    }
    case 'page': {
      const str = cache.get(args.id);
      if (str === undefined) throw new Error('Paged response not found (bridge may have restarted).');
      const page = Number(args.page);
      if (!Number.isInteger(page) || page < 0 || page * PAGESIZE >= str.length) throw new Error('Invalid page.');
      return { chunk: str.slice(page * PAGESIZE, (page + 1) * PAGESIZE) };
    }
    default: throw new Error(`Unknown bridge tool ${String(name).slice(0, 50)}`);
  }
}
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
export async function handle(message) {
  if (!has(message, 'id')) return; // ignore notifications
  const id = message.id;
  if (message.method === 'initialize') return send({ jsonrpc: '2.0', id, result: {
    protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'openai-workers-bridge', version: '0.6.0' },
  } });
  if (message.method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: defs } });
  if (message.method === 'tools/call') {
    try {
      const value = await dispatch(message.params?.name, message.params?.arguments ?? {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
    } catch (err) {
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(err?.message ?? 'Unknown error').slice(0, 500) }] } });
    }
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}
if (process.argv[1] && basename(process.argv[1]) === 'server.mjs') {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    try { void handle(JSON.parse(line)); }
    catch { /* invalid JSON on the protocol stream is discarded; stdout must remain clean */ }
  });
}
