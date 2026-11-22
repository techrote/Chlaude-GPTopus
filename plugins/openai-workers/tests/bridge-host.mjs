// Shared harness helper (not a test file). It drives the REAL bridge dispatcher
// (bridge/server.mjs `dispatch`) as the ULTRA mod would: a temporary owner state
// directory, a real provisioned owner channel key, a real owner policy file, and
// every private request signed with the production signer. Nothing is trusted by a
// flag. No provider is contacted: `options.transport` is a recording test double
// that stands in only for the OpenAI HTTPS call, so what reaches it IS a POST.
import { mkdtemp, rm, realpath, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../bridge/server.mjs';
import { provisionChannelKey } from '../bridge/native-channel.mjs';
import { resolveConfig } from '../ultra/config.mjs';
import { writeOwnerConfig } from '../ultra/service.mjs';
import { ExecutionStore } from '../ultra/store.mjs';
import { signedDispatcher } from './native-host.mjs';

export const nativeRisk = { complexity: 'low', impact: 'low', verifiability: 'high', confidence: 0.95, rationale: 'Deterministic offline fixture.' };
export const nativePrompt = (task = 'Synthetic bounded work', ultra = {}) => JSON.stringify({ task, ultra: { role: 'implementation', risk: nativeRisk, budget: { tokens: 40000, usd: 4 }, ...ultra } });

/** A recording stand-in for the OpenAI HTTPS transport. Every call to `create` is one POST. */
export function recordingTransport(behaviour = {}) {
  const calls = { create: [], poll: [], cancel: [] };
  let counter = 0;
  const completed = (args, over = {}) => ({ id: `resp_host_${++counter}`, status: 'completed', model: args.model, text: 'Synthetic work complete.', calls: [],
    usage: { input: 20, cached: 0, output: 10, total: 30 }, usageStatus: 'verified', estimatedUsd: 0.001, priceStatus: 'estimated', serviceTier: null, ...over });
  return { calls,
    async create(args, options) { calls.create.push(structuredClone(args)); return behaviour.create ? behaviour.create(args, options, completed) : completed(args); },
    async poll(id) { calls.poll.push(id); if (behaviour.poll) return behaviour.poll(id); throw new Error('unexpected poll'); },
    async cancel(id) { calls.cancel.push(id); if (behaviour.cancel) return behaviour.cancel(id); throw new Error('unexpected cancel'); } };
}

/**
 * A running bridge host for one temporary owner state directory.
 * `env` is the shared, mutable process-environment view (the bridge reads it on every request).
 */
export async function bridgeHost(t, { policy = {}, env: extraEnv = {}, transport = recordingTransport(), now, project: projectFiles = {}, key = true } = {}) {
  const dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-host-')));
  // A project root OUTSIDE the owner state directory (which is itself a protected path).
  const project = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-project-')));
  t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(project, { recursive: true, force: true })]));
  const env = { OPENAI_ULTRA_ENABLED: '1', OPENAI_ULTRA_ALLOW_API: '1', OPENAI_ULTRA_STATE_DIR: dir, OPENAI_ULTRA_CONFIG: join(dir, 'ultra-policy.json'),
    OPENAI_WORKER_USAGE_DIR: join(dir, 'usage'), ...extraEnv };
  for (const [name, text] of Object.entries(projectFiles)) { await mkdir(join(project, name, '..'), { recursive: true }); await writeFile(join(project, name), text); }
  const writePolicy = async overrides => writeOwnerConfig(resolveConfig({ enabled: true, ...overrides }), env);
  await writePolicy(policy);
  let keyHex = null;
  if (key) keyHex = (await readFile((await provisionChannelKey(env)).path, 'utf8')).trim();
  const options = { env, transport, ...(now && { now }) };
  const call = signedDispatcher(dispatch, options, keyHex);
  const ledger = async () => new ExecutionStore(join(dir, 'ultra-execution.json')).read();
  /** Open a native session and admit + bind one worker, as session.start / agent.spawn / turn.start do. */
  async function session(sessionId = 'host-session', { worker = 'luna6', surfaces = ['terminal'], prompt = nativePrompt(), toolUseId = 'spawn-1', hostAgentId = 'host-agent-1', model = 'opus' } = {}) {
    const init = await call('ultra_native_init', { sessionId, model, version: '2.1.326', platform: 'linux', isHosted: false, surfaces });
    const common = { sessionId, capability: init.capability };
    const admitted = await call('ultra_native_admit', { ...common, toolUseId, primaryModel: model, parentModel: model, subagentType: `oai:${worker}`, prompt });
    if (!admitted.allowed) return { init, common, admitted, missionId: init.missionId };
    await call('ultra_native_bind', { ...common, toolUseId, nodeId: admitted.nodeId, hostAgentId, bindingTicket: admitted.bindingTicket, hostWorker: worker });
    return { init, common, admitted, missionId: init.missionId, nodeId: admitted.nodeId, hostAgentId, worker };
  }
  return { dir, project, env, keyHex, options, call, writePolicy, ledger, session, transport };
}
