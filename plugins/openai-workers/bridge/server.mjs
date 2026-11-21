#!/usr/bin/env node
import readline from 'node:readline';
import { basename } from 'node:path';
import { configuredKey, keyProfileForWorker, createTurn, pollTurn, cancelTurn, validateTurnArgs, mayHaveIncurredUsage } from './openai.mjs';
import { workerSettings, selectWorkerEffort, workerEnvSuffix } from './workers.mjs';
import { reserveRequest, releaseRequest, accountResponse, accountByResponseId, usageSnapshot, quoteRequest,
  markRequestAmbiguous, responseRecord } from './usage.mjs';

const PAGESIZE = 22000;
const cache = new Map(); // only large, completed, redacted responses, never keys
const ultraServices = new Map();
const nativeControllers = new Map();
const nativeChannels = new Map(); // owner key file -> { keyId, gateway }; one bridge process, one epoch per key
async function ultraService(options = {}) {
  const { createService, readOwnerConfig, ownerPaths } = await import('../ultra/service.mjs');
  const { policyHash } = await import('../ultra/config.mjs');
  const env = options.env ?? process.env, config = await readOwnerConfig(env);
  const key = `${ownerPaths(env).config}:${policyHash(config)}:${['1', 'true'].includes(env.OPENAI_ULTRA_ALLOW_API)}`;
  if (!ultraServices.has(key)) {
    const backend = async (name, input) => {
      const r = await dispatch(name, input, options); if (!r.paged) return r;
      if (r.pages > 256 || r.length > 4000000) throw new Error('Response exceeds runtime paging bound');
      let value = ''; for (let i = 0; i < r.pages; i++) value += (await dispatch('page', { id: r.id, page: i }, options)).chunk;
      if (value.length !== r.length) throw new Error('Incomplete runtime response pages'); return JSON.parse(value);
    };
    ultraServices.set(key, await createService({ env, config, backend }));
  }
  return { key, service: ultraServices.get(key) };
}
const defs = [
  { name: 'health', description: 'Report whether the bridge has a configured API key (never returns it).', inputSchema: { type: 'object', properties: {} } },
  { name: 'create', description: 'Start a Responses API model step for the plugin.', inputSchema: { type: 'object', properties: {
    model: { type: 'string' }, worker_type: { type: 'string' }, input: {}, instructions: { type: 'string' }, tools: { type: 'array' }, effort: { type: 'string' }, previous_response_id: { type: 'string' }, max_output_tokens: { type: 'integer' }, request_id: { type: 'string' },
    service_tier: { type: 'string', enum: ['auto', 'default', 'flex', 'fast', 'priority'] } }, required: ['worker_type', 'model', 'input', 'instructions', 'tools'] } },
  { name: 'usage', description: 'Show local free-key daily tokens, reservations and UTC rollover; these are not authoritative API billing counters.', inputSchema: { type: 'object', properties: {} } },
  { name: 'poll', description: 'Poll an in-progress OpenAI response, up to five seconds.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, worker_type: { type: 'string' }, wait_ms: { type: 'integer' } }, required: ['id', 'worker_type'] } },
  { name: 'page', description: 'Fetch a page of an oversized completed response.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, page: { type: 'integer' } }, required: ['id', 'page'] } },
  { name: 'cancel', description: 'Request cancellation of an active OpenAI response.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, worker_type: { type: 'string' } }, required: ['id', 'worker_type'] } },
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
async function boundResponse(args, options) {
  const selected = workerSettings(args.worker_type, options.env);
  const binding = await responseRecord(args.id, options);
  if (!binding || binding.legacy || !binding.workerType) throw new Error('Response ownership is unknown; reconcile this response locally before polling or continuing.');
  if (binding.workerType !== selected.name || binding.profile !== selected.key_profile) throw new Error('Response worker/key identity mismatch.');
  return binding;
}
function checkedCreate(args, env) {
  const selected = workerSettings(args.worker_type, env);
  if (args.model !== selected.model) throw new Error(`Worker ${selected.name} is configured for ${selected.model}; caller model substitution is not permitted.`);
  const requestedTier = args.service_tier;
  const configuredTier = selected.service_tier;
  // An unconfigured tier means the provider's ordinary project/default route.
  // It never authorises a caller to request Flex or premium processing.
  if (configuredTier ? requestedTier !== undefined && requestedTier !== configuredTier : requestedTier !== undefined && !['auto', 'default'].includes(requestedTier)) {
    throw new Error('Caller service-tier substitution is not permitted; configure the worker tier locally.');
  }
  const effort = selectWorkerEffort(selected.name, args.effort, env, selected.model).effective;
  const effective = { ...args, model: selected.model, effort, service_tier: configuredTier ?? requestedTier };
  validateTurnArgs(effective); // All preflight failures occur before reservation.
  const pricedGuard = selected.key_profile === 'standard' || Number(env[`OPENAI_WORKER_${workerEnvSuffix(selected.name)}_MAX_USD`]) > 0;
  if (pricedGuard && quoteRequest(effective, { env }).reservationUsd === null) throw new Error('Unknown model prices cannot pass the worker spending guard. Configure a known-price model; no request was sent.');
  return { selected, effective };
}
/** options are trusted in-process adapter configuration, never MCP arguments. */
export async function dispatch(name, args = {}, options = {}) {
  if (typeof name === 'string' && name.startsWith('ultra_native_')) {
    // Reaching this dispatcher is NOT authority: stdio carries no caller identity,
    // so the model, a hook, another mod or another process look exactly like the
    // ULTRA mod. The request must prove possession of the owner channel key
    // (bridge/native-channel.mjs); nothing below runs, and no ULTRA service is
    // even constructed, for an unauthenticated caller. Hiding the names from
    // tools/list or denying them in mod hooks is defence in depth, not the control.
    const env = options.env ?? process.env;
    const { openNativeChannel, keyFilePath } = await import('./native-channel.mjs');
    const gateway = await openNativeChannel(env, nativeChannels);
    return gateway.call(name, args, async channel => {
      const { key, service } = await ultraService(options);
      if (!service.config.enabled) throw new Error('Owner ULTRA policy is disabled');
      const slot = `${key}:${channel.epoch}`; // a new owner key or bridge epoch never inherits a controller
      if (!nativeControllers.has(slot)) {
        const { NativeController } = await import('../ultra/native-controller.mjs');
        const { ownerPaths } = await import('../ultra/service.mjs');
        const paths = ownerPaths(env);
        nativeControllers.set(slot, new NativeController(service.broker, { backend: service.backend, env, live: env.OPENAI_ULTRA_ALLOW_API === '1', protectedPaths: [paths.base, paths.config, keyFilePath(env)], supervisorTick: missionId => service.runtime.tick(missionId, { maxAgents: 1 }) }));
      }
      return nativeControllers.get(slot);
    });
  }
  if (typeof name === 'string' && name.startsWith('ultra_')) return (await ultraService(options)).service.invoke(name, args);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Bridge arguments must be an object.');
  const env = options.env ?? process.env;
  const ledgerOptions = { ...options, env };
  const transport = options.transport ?? { create: createTurn, poll: pollTurn, cancel: cancelTurn };
  switch (name) {
    case 'health': return {
      standard: { configured: Boolean(configuredKey(env, 'standard')), source: configuredKey(env, 'standard') || 'none' },
      free: { configured: Boolean(configuredKey(env, 'free')), source: configuredKey(env, 'free') || 'none' },
      platform: process.platform,
    };
    case 'create': {
      const { selected, effective } = checkedCreate(args, env);
      // Never accept an agent-supplied claim about invisible Responses history.
      const freshQuote = quoteRequest({ ...effective, previous_response_id: undefined, inputTokenUpperBound: undefined }, ledgerOptions);
      let inputTokenUpperBound;
      if (effective.previous_response_id) {
        const previous = await boundResponse({ worker_type: selected.name, id: effective.previous_response_id }, ledgerOptions);
        if (!previous.settled || !Number.isSafeInteger(previous.contextTokenUpperBound)) throw new Error('Previous response has no verified complete history bound; reconcile it before continuing.');
        if (previous.model !== selected.model) throw new Error('Continuation model differs from the stored response model.');
        inputTokenUpperBound = previous.contextTokenUpperBound + freshQuote.inputTokens;
      }
      const quote = quoteRequest({ ...effective, inputTokenUpperBound }, ledgerOptions);
      const ticket = await reserveRequest({ workerType: selected.name, model: selected.model, profile: selected.key_profile,
        serviceTier: effective.service_tier, ...(args.request_id && { requestId: args.request_id }), ...quote }, ledgerOptions);
      let response;
      try {
        response = await transport.create(effective, { profile: selected.key_profile, env });
      } catch (error) {
        if (mayHaveIncurredUsage(error)) await markRequestAmbiguous(ticket, ledgerOptions);
        else await releaseRequest(ticket, { ...ledgerOptions, reason: error.usageDisposition });
        throw error;
      }
      try { await accountResponse(ticket, response, ledgerOptions); }
      catch (error) { await markRequestAmbiguous(ticket, ledgerOptions); throw error; }
      return pack(response);
    }
    case 'poll': {
      const binding = await boundResponse(args, ledgerOptions);
      const response = await transport.poll(args.id, { wait_ms: args.wait_ms, profile: binding.profile, env });
      if (response.id !== args.id) throw new Error('Poll response ID differs from the requested response.');
      if (response.model && response.model !== binding.model) throw new Error('Poll response model differs from its stored binding.');
      await accountByResponseId(response, ledgerOptions);
      return pack(response);
    }
    case 'cancel': {
      const binding = await boundResponse(args, ledgerOptions);
      const response = await transport.cancel(args.id, { profile: binding.profile, env });
      if (response.id !== args.id) throw new Error('Cancellation response ID differs from the requested response.');
      if (response.model && response.model !== binding.model) throw new Error('Cancellation response model differs from its stored binding.');
      if (['completed', 'failed', 'incomplete', 'cancelled'].includes(response.status)) await accountByResponseId(response, ledgerOptions);
      else if (binding.ticket) await markRequestAmbiguous(binding.ticket, ledgerOptions);
      return response;
    }
    case 'usage': {
      const initial = await usageSnapshot(ledgerOptions);
      // Reconcile accepted responses for either fixed key without new generation.
      for (const item of initial.pendingResponses.slice(0, 8)) {
        try {
          const response = await transport.poll(item.id, { wait_ms: 0, profile: item.profile, env });
          if (response.id === item.id) await accountByResponseId(response, ledgerOptions);
        } catch { /* Keep conservative reservations; no automatic POST retry. */ }
      }
      return usageSnapshot(ledgerOptions);
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
// tools/call is not restricted by what tools/list advertises in MCP, so this
// transport restricts it itself: the advertised legacy tools, plus the private
// native namespace, which authenticates every request on its own (see dispatch).
const advertised = new Set(defs.map(d => d.name));
export async function handle(message, write = send) {
  if (!has(message, 'id')) return; // ignore notifications and unsupported batch envelopes
  const id = message.id;
  if (message.method === 'initialize') return write({ jsonrpc: '2.0', id, result: {
    protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'openai-workers-bridge', version: '0.8.0' },
  } });
  if (message.method === 'ping') return write({ jsonrpc: '2.0', id, result: {} });
  if (message.method === 'tools/list') return write({ jsonrpc: '2.0', id, result: { tools: defs } });
  if (message.method === 'tools/call') {
    try {
      const name = message.params?.name;
      if (typeof name !== 'string' || !(advertised.has(name) || name.startsWith('ultra_native_'))) throw new Error('Unknown bridge tool');
      const value = await dispatch(name, message.params?.arguments ?? {});
      return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });
    } catch (err) {
      return write({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(err?.message ?? 'Unknown error').slice(0, 500) }] } });
    }
  }
  write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}
if (process.argv[1] && basename(process.argv[1]) === 'server.mjs') {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    try { void handle(JSON.parse(line)); }
    catch { /* invalid JSON on the protocol stream is discarded; stdout must remain clean */ }
  });
}
