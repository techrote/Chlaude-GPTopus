import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveConfig, profileConfig, validateConfig, policyHash } from './config.mjs';
import { ExecutionStore, invariant } from './store.mjs';
import { RecruitmentBroker } from './broker.mjs';
import { UltraRuntime } from './runtime.mjs';
import { PermissionBoundary, isSecretPathComponent } from './permissions.mjs';
import { OPENAI_WORKERS, workerSettings } from '../bridge/workers.mjs';
import { usagePath } from '../bridge/usage.mjs';

/** Name of the owner channel key inside the state directory (the mod's hooks/channel.js uses the same name; a test pins the agreement). */
export const OWNER_KEY_FILE = 'ultra-channel.key';
/** A path an owner override must spell absolutely: a relative one resolves against whichever process cwd happens to read it (often the project). */
export function isAbsoluteSpelling(value, platform = process.platform) {
  return platform === 'win32' ? /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value) : value.startsWith('/');
}
export function ownerPaths(env = process.env) {
  const configured = (value, name) => {
    if (typeof value !== 'string' || !value.trim() || value.includes('${user_config.')) return null;
    if (!isAbsoluteSpelling(value.trim())) throw new Error(`${name} must be an absolute path (a relative path resolves against the working directory of whichever process reads it)`);
    return value.trim();
  };
  const base = configured(env.OPENAI_ULTRA_STATE_DIR, 'OPENAI_ULTRA_STATE_DIR') || (process.platform === 'win32' ? join(env.LOCALAPPDATA || homedir(), 'ClaudeOpenAIWorkers') : join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'claude-openai-workers'));
  const key = configured(env.OPENAI_ULTRA_CHANNEL_KEY_FILE, 'OPENAI_ULTRA_CHANNEL_KEY_FILE');
  return { base: resolve(base), config: resolve(configured(env.OPENAI_ULTRA_CONFIG, 'OPENAI_ULTRA_CONFIG') || join(base, 'ultra-policy.json')), ledger: resolve(join(base, 'ultra-execution.json')),
    key: key ? resolve(key) : resolve(join(base, OWNER_KEY_FILE)) };
}
/**
 * Every owner-controlled control or credential location a worker-visible reader must refuse: the state directory
 * (ledger, policy, default key), the policy file, the channel key wherever it lives, and the usage ledger directory.
 * Only paths this process can know about are listed (see ULTRA_HOSTS.md for the Desktop-extension caveat).
 */
export function ownerProtectedPaths(env = process.env) {
  const paths = ownerPaths(env);
  return [...new Set([paths.base, paths.config, paths.key, dirname(resolve(usagePath(env)))])];
}
/**
 * Configured project roots through which the owner channel key could be READ: the key lies inside the root and no path
 * component under it (for example the default *.key file name or a .claude directory) is one the permission boundary
 * refuses by name. A reader that is told the key location also refuses it by path (ownerProtectedPaths); this catches
 * the case where it is not, such as a Desktop extension that never saw the Code bridge's override.
 */
export function keyFileExposure(config, env = process.env) {
  const key = ownerPaths(env).key;
  const readable = root => {
    const rel = relative(resolve(root), key);
    if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return rel === '';
    return !rel.split(sep).some(isSecretPathComponent);
  };
  return [...new Set([...config.permissions.roots, ...config.desktop.roots])].filter(root => isAbsolute(root) && readable(root));
}
export async function readOwnerConfig(env = process.env) {
  const paths = ownerPaths(env);
  let input;
  try { input = JSON.parse(await readFile(paths.config, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return resolveConfig(); throw new Error(`Owner ULTRA policy is invalid: ${e.message}`); }
  return resolveConfig(input);
}
export async function writeOwnerConfig(config, env = process.env) {
  validateConfig(config); const path = ownerPaths(env).config;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path); return path;
}
function exactArgs(args, allowed) {
  invariant(args && typeof args === 'object' && !Array.isArray(args), 'Tool arguments must be an object');
  invariant(Object.keys(args).every(k => allowed.includes(k)), 'Unknown or privileged tool argument');
}

/** Public MCP caller cannot supply parent identity, permissions, authority or a transport. */
export class UltraService {
  constructor({ config, store, backend, env = process.env, live = false, protectedPaths = [] }) {
    this.config = resolveConfig(config); this.env = env; this.backend = backend; this.store = store;
    this.broker = new RecruitmentBroker(store, { config: this.config });
    this.runtime = new UltraRuntime(this.broker, { backend, env, live,
      boundaryFactory: (options, m, n) => new PermissionBoundary({ ...options, protectedPaths: [...options.protectedPaths, ...protectedPaths] }, { stageDirectory: `${store.path}.stages/${m.id}/${n.id}` }) });
    this.readBoundary = new PermissionBoundary({ profile: this.config.desktop.profile, roots: this.config.permissions.roots.filter(p => this.config.desktop.roots.includes(p)).map((path, i) => ({ id: String(i), path, read: ['.'], write: [] })), principal: { id: 'desktop-reader', role: 'reviewer' }, protectedPaths: [store.path, ...protectedPaths] });
  }
  async invoke(name, args = {}) {
    if (args?.mission_id && name !== 'ultra_start') {
      const mission = await this.store.snapshot(args.mission_id);
      invariant(mission.surface === 'desktop-chat', 'Public Chat tools cannot reuse another host surface\'s mission authority');
      if (!['ultra_cancel', 'ultra_diagnostics'].includes(name)) invariant(mission.policyHash === policyHash(this.config), 'Owner policy changed; create a newly authorised mission');
    }
    if (name === 'ultra_diagnostics') {
      exactArgs(args, ['mission_id']);
      return args.mission_id ? this.broker.diagnostics(args.mission_id) : {
        enabled: this.config.enabled, policyHash: policyHash(this.config), profile: this.config.profile, recruitment: this.config.recruitment,
        desktop: this.config.desktop, surfaces: this.config.surfaces, fleets: this.config.fleets, liveApiAuthorised: this.runtime.live,
        grants: { sharedAcrossSurfaces: true, tools: this.config.permissions.tools, roots: this.config.permissions.roots, note: "permissions.tools and permissions.roots are ONE owner grant shared by every surface. Each surface (Desktop Chat via desktop.profile, Claude Code CLI via surfaces.codeCli, Desktop Code via surfaces.desktopCode) has only its own A/B/C ceiling over that grant, and there are no per-surface root lists: a root added for one surface is readable by every other surface whose ceiling is B or higher. Only the public Chat read tool ultra_read_project additionally requires desktop.roots." },
        workers: OPENAI_WORKERS.map(w => workerSettings(w, this.env)),
        trustedIdentity: this.config.authority.configuredIdentity ? 'Explicit owner configuration; expiry enforced per decision' : 'Unavailable in Desktop Chat; restricted authority applies',
        consequentialExecution: 'Separate explicit authority and actual capability required; no general shell or live-project patch executor is installed',
      };
    }
    invariant(this.config.enabled, 'ULTRA is disabled. Use the local configuration command to enable it.');
    if (name === 'ultra_start') {
      exactArgs(args, ['task', 'mission_id']);
      if (args.mission_id) { const existing = (await this.store.read()).missions[args.mission_id]; invariant(!existing || existing.surface === 'desktop-chat', 'Mission ID belongs to another host surface'); }
      const m = await this.broker.createMission({ id: args.mission_id, task: args.task, surface: 'desktop-chat', orchestrator: { model: 'unknown', trusted: false, source: 'desktop-chat' } });
      return { mission_id: m.id, policyHash: m.policyHash, authority: 'restricted or explicitly owner-configured', next: 'ultra_recruit' };
    }
    if (name === 'ultra_recruit') {
      exactArgs(args, ['mission_id', 'worker', 'task', 'role', 'risk', 'mode', 'budget', 'request_key', 'planId']);
      const { mission_id, request_key, ...proposal } = args;
      return this.broker.request(mission_id, 'root', proposal, request_key);
    }
    if (name === 'ultra_step') {
      exactArgs(args, ['mission_id']);
      invariant(this.runtime.live || this.backend.offline === true, 'Live ULTRA API requests are disabled. Owner must set OPENAI_ULTRA_ALLOW_API=1 locally after offline acceptance.');
      return { steps: await this.runtime.tick(args.mission_id), diagnostics: await this.broker.diagnostics(args.mission_id) };
    }
    if (name === 'ultra_cancel') {
      exactArgs(args, ['mission_id', 'node_id']);
      const before = await this.store.snapshot(args.mission_id), ids = await this.broker.cancel(args.mission_id, args.node_id ?? 'root');
      const cancellations = [];
      for (const id of ids) {
        const n = before.nodes[id];
        if (n.runtime?.phase === 'poll' && n.runtime.responseId) {
          try { await this.backend('cancel', { worker_type: n.worker, id: n.runtime.responseId }); cancellations.push({ id, requested: true }); }
          catch { cancellations.push({ id, requested: false, usageHeld: true }); }
        }
      }
      return { cancelled: ids, cancellations, workAndUsagePreserved: true };
    }
    if (name === 'ultra_read_project') {
      exactArgs(args, ['root', 'path']);
      invariant(this.config.permissions.tools.includes('read_file'), 'Owner policy does not grant project reading');
      return this.readBoundary.readFile(args.root, args.path);
    }
    if (name === 'ultra_review') {
      exactArgs(args, ['mission_id', 'author_id', 'source', 'risk']);
      return this.runtime.reviews.start(args.mission_id, { authorId: args.author_id, source: args.source, risk: args.risk });
    }
    throw new Error(`Unknown public ULTRA operation: ${String(name).slice(0, 80)}`);
  }
}
export const publicDefinitions = [
  ['ultra_diagnostics', 'Inspect ULTRA policy, budgets, lineage, approvals, review state and blocked-operation reasons.', { mission_id: { type: 'string' } }, []],
  ['ultra_start', 'Create a governed mission using owner configuration. Caller-supplied model identity cannot confer authority.', { task: { type: 'string' }, mission_id: { type: 'string' } }, ['task']],
  ['ultra_recruit', 'Request a root child under the shared policy; pending approval is not permission to run.', { mission_id: { type: 'string' }, worker: { type: 'string', enum: [...OPENAI_WORKERS] }, task: { type: 'string' }, role: { type: 'string' }, risk: { type: 'object' }, mode: { type: 'string', enum: ['SWARM', 'REPLICATOR', 'SKYNET', 'CUSTOM'] }, budget: { type: 'object' }, request_key: { type: 'string' }, planId: { type: 'string' } }, ['mission_id', 'worker', 'task', 'risk', 'request_key']],
  ['ultra_step', 'Run one bounded cooperative scheduler tick. Live API requests require separate local owner opt-in.', { mission_id: { type: 'string' } }, ['mission_id']],
  ['ultra_cancel', 'Cancel a mission or descendant subtree. Preserve accepted work and uncertain incurred usage.', { mission_id: { type: 'string' }, node_id: { type: 'string' } }, ['mission_id']],
  ['ultra_read_project', 'Read a non-secret source file from a configured root in Desktop B/C. Root and permissions cannot be supplied by the caller.', { root: { type: 'string' }, path: { type: 'string' } }, ['root', 'path']],
  ['ultra_review', 'Start independent review/rework for a completed author and immutable source/evidence snapshot.', { mission_id: { type: 'string' }, author_id: { type: 'string' }, source: { type: 'object' }, risk: { type: 'object' } }, ['mission_id', 'author_id', 'source', 'risk']],
].map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));

export async function createService({ env = process.env, backend, config, store, live } = {}) {
  const paths = ownerPaths(env), policy = config ?? await readOwnerConfig(env);
  return new UltraService({ config: policy, store: store ?? new ExecutionStore(paths.ledger), backend, env, live: live ?? ['1', 'true'].includes(env.OPENAI_ULTRA_ALLOW_API), protectedPaths: ownerProtectedPaths(env) });
}
