#!/usr/bin/env node
import readline from 'node:readline';
import { basename } from 'node:path';
import { configuredKey, keyProfileForWorker, createTurn, pollTurn, cancelTurn, validateTurnArgs, mayHaveIncurredUsage } from './openai.mjs';
import { WORKER_TYPES, workerSettings, selectWorkerEffort, workerEnvSuffix, canonicalWorker, isProviderWorker } from './workers.mjs';
import { chat as defaultChat, providerUrl } from './chat.mjs';
import { rotationSnapshot } from './rotation.mjs';
import { traceRequest, traceResponse, writeTrace } from './trace.mjs';
import * as steer from './steer.mjs';
import * as direct from './direct-run.mjs';
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
  { name: 'health', description: 'Workers are native subagents: use the Agent tool with subagent_type oai:<worker>. Report whether the bridge has a configured API key (never returns it).', inputSchema: { type: 'object', properties: {} } },
  { name: 'create', description: 'INTERNAL plugin transport, refused for model calls. To use an OpenAI worker, spawn it with the Agent tool: subagent_type oai:<sol6-2|astra6-2|luna6|luna6fast|luna6flex|sol6-1flex|astra6free|terra5-6free>. Start a Responses API model step for the plugin.', inputSchema: { type: 'object', properties: {
    model: { type: 'string' }, worker_type: { type: 'string' }, input: {}, instructions: { type: 'string' }, tools: { type: 'array' }, effort: { type: 'string' }, previous_response_id: { type: 'string' }, max_output_tokens: { type: 'integer' }, request_id: { type: 'string' }, agent_id: { type: 'string' },
    service_tier: { type: 'string', enum: ['auto', 'default', 'flex', 'fast', 'priority'] } }, required: ['worker_type', 'model', 'input', 'instructions', 'tools'] } },
  { name: 'usage', description: 'Show local free-key daily tokens, reservations and UTC rollover; these are not authoritative API billing counters.', inputSchema: { type: 'object', properties: {} } },
  { name: 'poll', description: 'INTERNAL plugin transport, refused for model calls. To use an OpenAI worker, spawn it with the Agent tool: subagent_type oai:<sol6-2|astra6-2|luna6|luna6fast|luna6flex|sol6-1flex|astra6free|terra5-6free>. Poll an in-progress OpenAI response, up to five seconds.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, worker_type: { type: 'string' }, wait_ms: { type: 'integer' } }, required: ['id', 'worker_type'] } },
  { name: 'page', description: 'INTERNAL plugin transport, refused for model calls. To use an OpenAI worker, spawn it with the Agent tool: subagent_type oai:<sol6-2|astra6-2|luna6|luna6fast|luna6flex|sol6-1flex|astra6free|terra5-6free>. Fetch a page of an oversized completed response.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, page: { type: 'integer' } }, required: ['id', 'page'] } },
  { name: 'steer', description: 'INTERNAL plugin transport for operator steering, refused for model calls. Operators steer workers with /oai:s or the /oai:config console.', inputSchema: { type: 'object', properties: {
    op: { type: 'string', enum: ['reserve', 'sync', 'wait', 'send', 'list', 'hard', 'reply', 'end'] }, agentId: { type: 'string' }, worker: { type: 'string' }, description: { type: 'string' },
    step: { type: 'integer' }, status: { type: 'string' }, callsign: { type: 'string' }, peek: { type: 'boolean' }, args: { type: 'string' }, workers: { type: 'array' }, ms: { type: 'integer' }, tools: { type: 'array' }, text: { type: 'string' }, tipIds: { type: 'array' } }, required: ['op'] } },
  { name: 'run', description: 'INTERNAL plugin transport for /oai:run, refused for model calls.', inputSchema: { type: 'object', properties: { args: { type: 'string' } } } },
  { name: 'cancel', description: 'INTERNAL plugin transport, refused for model calls. To use an OpenAI worker, spawn it with the Agent tool: subagent_type oai:<sol6-2|astra6-2|luna6|luna6fast|luna6flex|sol6-1flex|astra6free|terra5-6free>. Request cancellation of an active OpenAI response.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, worker_type: { type: 'string' } }, required: ['id', 'worker_type'] } },
];
const has = (o, key) => Object.prototype.hasOwnProperty.call(o ?? {}, key);
/** Mark an error as raised before any POST (unless something more specific already classified it). */
function notSent(error) { if (error && typeof error === 'object' && error.usageDisposition === undefined) error.usageDisposition = 'not_started'; return error; }
function ambiguous(error) { if (error && typeof error === 'object') error.usageDisposition = 'ambiguous'; return error; }
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
/** /oai:run: start (args set), show one run (id) or list recent runs. */
function runOp(args, options) {
  const env = options.env ?? process.env, workers = Object.keys(WORKER_TYPES);
  const text = String(args.args ?? '').trim();
  if (!text) return { runs: direct.listDirect(env) };
  if (/^D\d{1,6}$/i.test(text)) { const run = direct.getDirect(text, env); return run ? { run } : { error: `No run ${text}.` }; }
  const parsed = direct.parseRun(text, workers);
  if (parsed.error) return parsed;
  const started = direct.startDirect(parsed, { env, workers, call: (n, a) => dispatch(n, a, options) });
  return { started };
}
export async function dispatch(name, args = {}, options = {}) {
  if (typeof name === 'string' && name.startsWith('ultra_native_')) {
    // Reaching this dispatcher is NOT authority: stdio carries no caller identity,
    // so the model, a hook, another mod or another process look exactly like the
    // ULTRA mod. The request must prove possession of the owner channel key
    // (bridge/native-channel.mjs); nothing below runs, and no ULTRA service is
    // even constructed, for an unauthenticated caller. Hiding the names from
    // tools/list or denying them in mod hooks is defence in depth, not the control.
    const env = options.env ?? process.env;
    const { openNativeChannel } = await import('./native-channel.mjs');
    const gateway = await openNativeChannel(env, nativeChannels);
    return gateway.call(name, args, async (channel, operation) => {
      const { key, service } = await ultraService(options);
      // A disabled owner policy refuses everything except what winds a session down: diagnostics and cancel.
      if (!service.config.enabled && !['ultra_native_cancel', 'ultra_native_diagnostics'].includes(operation)) throw new Error('Owner ULTRA policy is disabled');
      // A key that lies inside a readable project root could be returned to a worker or Chat reader; never run native authority on it.
      const { keyFileExposure } = await import('../ultra/service.mjs');
      const exposed = keyFileExposure(service.config, env);
      if (exposed.length) throw new Error('The owner channel key file lies inside a configured project root; move it outside every root (and rotate it with provision-ultra-channel.mjs --rotate) before using native ULTRA');
      const slot = `${key}:${channel.epoch}`; // a new owner key or bridge epoch never inherits a controller
      if (!nativeControllers.has(slot)) {
        const { NativeController } = await import('../ultra/native-controller.mjs');
        const { ownerProtectedPaths } = await import('../ultra/service.mjs');
        nativeControllers.set(slot, new NativeController(service.broker, { backend: service.backend, env, live: env.OPENAI_ULTRA_ALLOW_API === '1', protectedPaths: ownerProtectedPaths(env), supervisorTick: missionId => service.runtime.tick(missionId, { maxAgents: 1 }) }));
      }
      return nativeControllers.get(slot);
    });
  }
  if (typeof name === 'string' && name.startsWith('ultra_')) return (await ultraService(options)).service.invoke(name, args);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Bridge arguments must be an object.');
  // Pre-rename worker names (sol, daily-astrafree, ...) still route to their current worker.
  if (typeof args.worker_type === 'string') args = { ...args, worker_type: canonicalWorker(args.worker_type) };
  const env = options.env ?? process.env;
  const ledgerOptions = { ...options, env };
  const transport = options.transport ?? { create: createTurn, poll: pollTurn, cancel: cancelTurn };
  // Chat-completions provider workers (NVIDIA Build, LM Studio): no OpenAI key, ledger, price guard, tier or response binding.
  if (['create', 'poll', 'cancel'].includes(name) && isProviderWorker(args.worker_type)) return providerDispatch(name, args, env, options);
  switch (name) {
    case 'health': return {
      standard: { configured: Boolean(configuredKey(env, 'standard')), source: configuredKey(env, 'standard') || 'none' },
      free: { configured: Boolean(configuredKey(env, 'free')), source: configuredKey(env, 'free') || 'none' },
      nvidia: { configured: Boolean(configuredKey(env, 'nvidia')), source: configuredKey(env, 'nvidia') || 'none' },
      lmstudio: { url: providerUrl('lmstudio', env) },
      nvidiaBudget: (() => { try { return rotationSnapshot(env); } catch { return null; } })(),
      platform: process.platform,
    };
    case 'create': {
      // Everything up to and including the ledger reservation runs BEFORE the transport is called, so
      // any refusal here (validation, price guard, spending guard, daily allowance, unknown continuation,
      // ledger admission) proves that no POST was sent. The error carries that fact for in-process callers
      // (the native controller releases its step on it); an error that already names a disposition keeps it.
      let selected, effective, ticket;
      try {
        ({ selected, effective } = checkedCreate(args, env));
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
        ticket = await reserveRequest({ workerType: selected.name, model: selected.model, profile: selected.key_profile,
          serviceTier: effective.service_tier, ...(args.request_id && { requestId: args.request_id }), ...quote }, ledgerOptions);
      } catch (error) { throw notSent(error); }
      traceRequest(selected, effective, { env });
      let response;
      try {
        response = await transport.create(effective, { profile: selected.key_profile, env });
      } catch (error) {
        if (mayHaveIncurredUsage(error)) await markRequestAmbiguous(ticket, ledgerOptions);
        else await releaseRequest(ticket, { ...ledgerOptions, reason: error.usageDisposition });
        traceResponse(selected.name, { status: 'error', reason: String(error?.message ?? error) }, { env });
        throw error;
      }
      traceResponse(selected.name, response, { env });
      // The provider answered: whatever fails from here on is NOT a refusal before the send.
      try { await accountResponse(ticket, response, ledgerOptions); }
      catch (error) { await markRequestAmbiguous(ticket, ledgerOptions); throw ambiguous(error); }
      return pack(response);
    }
    case 'poll': {
      const binding = await boundResponse(args, ledgerOptions);
      const response = await transport.poll(args.id, { wait_ms: args.wait_ms, profile: binding.profile, env });
      if (response.id !== args.id) throw new Error('Poll response ID differs from the requested response.');
      if (response.status !== 'in_progress') traceResponse(binding.workerType, response, { env });
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
    case 'steer': return steerOp(args, options.env ?? process.env);
    case 'run': return runOp(args, options);
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
const PROVIDER_ID = /^chat_c[a-f0-9]{16}_\d{1,9}$/;
/** Provider workers: the caller may not substitute the model; effort is clamped to the worker's policy. */
async function providerDispatch(name, args, env, options) {
  const chat = options.chat ?? defaultChat;
  const selected = workerSettings(args.worker_type, env);
  const chatOptions = { env, ...(options.chatOptions ?? {}) };
  if (name === 'create') {
    let effective;
    try {
      if (args.model !== selected.model) throw new Error(`Worker ${selected.name} is configured for ${selected.model}; caller model substitution is not permitted.`);
      if (typeof args.instructions !== 'string' || !args.instructions) throw new Error('Instructions are required.');
      if (!Array.isArray(args.tools)) throw new Error('Tool manifest required.');
      const effort = selectWorkerEffort(selected.name, args.effort, env, selected.model).effective;
      const { service_tier, request_id, ...rest } = args; // tiers and ledger request ids do not apply
      effective = { ...rest, model: selected.model, effort };
    } catch (error) { throw notSent(error); }
    traceRequest(selected, effective, { env });
    const response = await chat.create(effective, chatOptions);
    if (response.status !== 'in_progress') traceResponse(selected.name, response, { env });
    return pack(response);
  }
  if (typeof args.id !== 'string' || !PROVIDER_ID.test(args.id)) throw new Error('Invalid provider response id.');
  if (name === 'poll') {
    const response = await chat.poll(args.id, { ...chatOptions, wait_ms: args.wait_ms, worker_type: selected.name });
    if (response.id !== args.id) throw new Error('Poll response ID differs from the requested response.');
    if (response.status !== 'in_progress') traceResponse(selected.name, response, { env });
    return pack(response);
  }
  const response = await chat.cancel(args.id, { ...chatOptions, worker_type: selected.name });
  if (response.id !== args.id) throw new Error('Cancellation response ID differs from the requested response.');
  return response;
}
/** Operator steering (see steer.mjs). Text is the operator's own; nothing here widens worker capability. */
async function steerOp(args, env) {
  const op = String(args.op ?? '');
  if (op === 'reserve') return { callsign: steer.nextCallsign(args.worker, env) };
  if (op === 'list') return { runs: steer.listRuns(env), log: steer.readLog(env, 20), pause: steer.pausePolicy(env) };
  if (op === 'send') {
    const parsed = steer.parseSteer(args.args, Array.isArray(args.workers) ? args.workers : []);
    const runs = steer.listRuns(env, { includeEnded: false });
    if (!parsed.text) return { usage: true, runs };
    const targets = steer.resolveTarget(parsed.target, runs);
    if (!targets.length) return { error: parsed.target ? `No running worker matches "${parsed.target}".` : runs.length ? 'Several workers are running: name one (callsign, worker name or *).' : 'No OpenAI worker is running.', runs };
    const sent = targets.map(r => ({ callsign: r.callsign, worker: r.worker, step: r.step ?? 0, tip: steer.enqueueTip(r.agentId, { ...parsed, from: 'oai:s' }, env) }));
    for (const s of sent) writeTrace({ type: 'steer', worker: s.worker, callsign: s.callsign, text: s.tip.text, flags: s.tip }, { env });
    return { sent, parsed };
  }
  const agentId = String(args.agentId ?? '');
  if (op === 'sync') {
    const run = steer.upsertRun(agentId, { callsign: args.callsign, worker: args.worker, description: args.description, step: args.step, status: args.status ?? 'running' }, env);
    const tips = steer.takeTips(agentId, args.step ?? 0, env);
    for (const t of tips) writeTrace({ type: 'steer-delivered', worker: run.worker, callsign: run.callsign, step: args.step, text: t.text }, { env });
    return { callsign: run.callsign, tips: tips.map(t => ({ ...t, message: steer.tipMessage(t) })), pinned: steer.pinnedMessage(run.pinned ?? []), pause: steer.pausePolicy(env) };
  }
  if (op === 'hard') return { hard: steer.hasHardTip(agentId, env) };
  if (op === 'wait') {
    const pause = steer.pausePolicy(env);
    const used = (Array.isArray(args.tools) ? args.tools : []).filter(t => pause.tools.includes(t));
    if (!pause.ms || !used.length) return { waited: false };
    steer.upsertRun(agentId, { status: 'paused' }, env);
    const got = await steer.waitForTip(agentId, pause.ms, env);
    steer.upsertRun(agentId, { status: 'running' }, env);
    return { waited: true, tip: got };
  }
  if (op === 'reply') {
    const run = steer.getRun(agentId, env);
    steer.appendLog({ kind: 'reply', agentId, callsign: run?.callsign, worker: run?.worker, step: args.step, text: String(args.text ?? '').slice(0, 2000) }, env);
    return { ok: true };
  }
  if (op === 'end') { steer.upsertRun(agentId, { status: 'ended' }, env); return { ok: true }; }
  throw new Error('Unknown steer op');
}
const refusedLegacy = new Set();
function legacyRefusal(name) {
  if (refusedLegacy.has(name)) return; refusedLegacy.add(name);
  process.stderr.write(`[oai] raw bridge tool "${name}" refused: OPENAI_ULTRA_ENABLED=1 is set for this bridge, so it needs the owner channel proof. ULTRA workers use ultra_native_*; if the mod does not see OPENAI_ULTRA_ENABLED=1 too, set it identically for Claude Code and the bridge, or unset it.
`);
}
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
// tools/call is not restricted by what tools/list advertises in MCP, so this
// transport restricts it itself: the advertised legacy tools, plus the private
// native namespace, which authenticates every request on its own (see dispatch).
const advertised = new Set(defs.map(d => d.name));
// With ULTRA enabled for this bridge process, the legacy tools that spend or alter provider state are no longer open to
// whoever reaches the transport: the ULTRA mod never calls them (it uses ultra_native_*), so each must carry the same
// owner-key proof as the private namespace. health and usage stay open (read-only local status and accounting). Without
// OPENAI_ULTRA_ENABLED=1 the original unauthenticated integration is unchanged. In-process callers (dispatch) are trusted.
const PROOF_REQUIRED_WHEN_ULTRA = new Set(['create', 'poll', 'cancel', 'page']);
async function authenticateLegacy(name, args, env) {
  const { openNativeChannel } = await import('./native-channel.mjs');
  const gateway = await openNativeChannel(env, nativeChannels);
  return gateway.authenticate(name, args);
}
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
      let args = message.params?.arguments ?? {};
      if (PROOF_REQUIRED_WHEN_ULTRA.has(name) && process.env.OPENAI_ULTRA_ENABLED === '1') {
        try { args = await authenticateLegacy(name, args, process.env); }
        catch (error) { if (error?.name === 'ChannelDenied') legacyRefusal(name); throw error; }
      }
      const value = await dispatch(name, args);
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
