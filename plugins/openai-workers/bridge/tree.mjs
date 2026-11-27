/**
 * Delegation tree for hierarchical OpenAI workers (a worker spawning workers). Pure bookkeeping, no I/O except the
 * optional git-worktree helper: grants, owner ceilings, atomic admission with a global concurrency limit (waiting
 * parents count), budget attenuation, cascade cancel, file ownership, and concise structured reports.
 *
 * NOTE: this is the policy/accounting core. A spawn tool for workers additionally needs a host that can run the
 * child's Read/Edit/Write/Bash tool calls; see README "Delegation" for what is and is not wired.
 */
import { execFileSync } from 'node:child_process';
import { resolve, sep } from 'node:path';

export const NODE_STATES = Object.freeze(['queued', 'running', 'waiting', 'completed', 'failed', 'stopped', 'cancelled']);
const LIVE = new Set(['running', 'waiting']);           // hold a global slot (a parent waiting on children still holds one)
const FINAL = new Set(['completed', 'failed', 'stopped', 'cancelled']);
export const REASONS = Object.freeze(['concurrency', 'tpm_limit', 'quota_free_daily', 'monthly_soft_limit', 'task_budget', 'step_cap', 'api_error', 'cancelled', 'not_granted', 'depth', 'type_not_allowed', 'budget_exceeds_parent', 'owner_ceiling']);
const num = v => v === undefined || v === null ? Infinity : Number(v);
const finite = v => Number.isFinite(v) && v >= 0;

/** Owner ceilings (from /oai:config). Defaults are conservative: depth 1, 6 live workers in total, free types only. */
export function ownerCeilings(env = process.env) {
  const int = (v, d, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };
  const types = String(env.OAI_DELEGATION_TYPES ?? 'astra6free,terra5-6free').split(',').map(s => s.trim()).filter(Boolean);
  return { maxDepth: int(env.OAI_DELEGATION_MAX_DEPTH, 1, 0, 6), maxTotal: int(env.OAI_DELEGATION_MAX_TOTAL, 6, 1, 64), types };
}

/** Parse `delegation: {maxConcurrent: 3, types: ['terra5-6free'], maxDepth: 1}` out of a launch prompt. Null when absent or invalid. */
export function parseDelegation(text) {
  const m = /delegation\s*:\s*(\{[^{}]*\})/i.exec(String(text ?? ''));
  if (!m) return null;
  try {
    const json = m[1].replace(/'/g, '"').replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":');
    const g = JSON.parse(json);
    const maxConcurrent = Number(g.maxConcurrent ?? 0), maxDepth = Number(g.maxDepth ?? 1);
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 0 || !Number.isInteger(maxDepth) || maxDepth < 0) return null;
    const types = Array.isArray(g.types) ? g.types.filter(t => typeof t === 'string') : [];
    return { maxConcurrent, maxDepth, types, budget: g.budget && typeof g.budget === 'object' ? g.budget : undefined };
  } catch { return null; }
}

/** A child budget can never exceed what remains of its parent's; undefined fields inherit the remainder. */
export function attenuateBudget(parentRemaining, requested = {}) {
  const out = {};
  for (const k of ['steps', 'tokens', 'usd']) {
    const left = num(parentRemaining?.[k]);
    if (requested?.[k] === undefined || requested?.[k] === null) { out[k] = left; continue; } // unspecified: inherit what remains
    const want = num(requested[k]);
    if (requested?.[k] !== undefined && !finite(want)) return { error: `invalid ${k} budget` };
    if (want > left) return { error: `requested ${k} ${want} exceeds the parent's remaining ${left}` };
    out[k] = Math.min(left, want);
  }
  return { budget: out };
}

/** Path ownership: a node with a files list may write only inside those paths (prefix match on resolved paths). */
export function ownsPath(files, path, cwd = process.cwd()) {
  if (!files?.length) return true;
  const target = resolve(cwd, path);
  return files.some(f => { const root = resolve(cwd, f); return target === root || target.startsWith(root + sep); });
}

export class WorkerTree {
  constructor({ ceilings = ownerCeilings({}), now = () => Date.now(), onPromote = () => {}, onCancel = () => {} } = {}) {
    this.ceilings = ceilings; this.now = now; this.onPromote = onPromote; this.onCancel = onCancel;
    this.nodes = new Map(); this.queue = []; this.seq = 0;
  }
  #id(prefix) { return `${prefix}${++this.seq}`; }
  get(id) { const n = this.nodes.get(id); if (!n) throw new Error(`Unknown worker ${String(id).slice(0, 40)}`); return n; }
  /** Slots held across the WHOLE forest (waiting parents included). */
  liveCount() { let n = 0; for (const x of this.nodes.values()) if (LIVE.has(x.state)) n++; return n; }

  /** Start a root task. A grant is optional: without one the root cannot spawn anything. */
  addRoot({ type, grant = null, budget = {}, files = [], id = this.#id('root') }) {
    if (this.liveCount() >= this.ceilings.maxTotal) return { status: 'deferred', reason: 'concurrency', detail: `${this.ceilings.maxTotal} workers already live` };
    const g = grant && {
      maxConcurrent: Math.min(grant.maxConcurrent ?? 0, this.ceilings.maxTotal),
      maxDepth: Math.min(grant.maxDepth ?? 1, this.ceilings.maxDepth),
      types: (grant.types ?? []).filter(t => this.ceilings.types.includes(t)),
    };
    const node = { id, rootId: id, parentId: null, type, depth: 0, grant: g, budget: { steps: num(budget.steps), tokens: num(budget.tokens), usd: num(budget.usd) },
      spent: { steps: 0, tokens: 0, usd: 0 }, own: { steps: 0, tokens: 0, usd: 0 }, files, state: 'running', reason: null, summary: '', filesTouched: [], children: [], branch: null, createdAt: this.now() };
    this.nodes.set(id, node);
    return { status: 'admitted', node };
  }

  /** Atomic spawn decision. Returns admitted | deferred(concurrency) | refused(reason). Never exceeds a limit. */
  spawn(parentId, { type, task = '', budget = {}, files = [], queue = true, isolation = null } = {}) {
    const parent = this.get(parentId);
    if (!LIVE.has(parent.state)) return { status: 'refused', reason: 'cancelled', detail: 'parent is not running' };
    const g = parent.grant;
    if (!g || g.maxConcurrent < 1) return { status: 'refused', reason: 'not_granted', detail: 'delegation was not granted for this task' };
    if (parent.depth + 1 > g.maxDepth) return { status: 'refused', reason: 'depth', detail: `maxDepth ${g.maxDepth}` };
    if (!g.types.includes(type)) return { status: 'refused', reason: 'type_not_allowed', detail: `${type} not in [${g.types.join(', ')}]` };
    const mine = parent.children.filter(c => ['queued', ...LIVE].includes(this.nodes.get(c).state)).length;
    if (mine >= g.maxConcurrent) return { status: 'refused', reason: 'not_granted', detail: `maxConcurrent ${g.maxConcurrent} children already active` };
    const att = attenuateBudget(this.remaining(parentId), budget);
    if (att.error) return { status: 'refused', reason: 'budget_exceeds_parent', detail: att.error };
    const child = { id: this.#id('w'), rootId: parent.rootId, parentId, type, depth: parent.depth + 1, task: String(task).slice(0, 2000),
      grant: { maxConcurrent: Math.min(g.maxConcurrent, g.maxDepth > parent.depth + 1 ? g.maxConcurrent : 0), maxDepth: g.maxDepth, types: [...g.types] },
      budget: att.budget, spent: { steps: 0, tokens: 0, usd: 0 }, own: { steps: 0, tokens: 0, usd: 0 }, files, isolation, state: 'queued', reason: null, summary: '', filesTouched: [], children: [], branch: null, createdAt: this.now() };
    if (this.liveCount() < this.ceilings.maxTotal) { child.state = 'running'; this.#attach(parent, child); return { status: 'admitted', childId: child.id, node: child }; }
    if (!queue) return { status: 'deferred', reason: 'concurrency', detail: `${this.ceilings.maxTotal} workers already live across the tree` };
    this.#attach(parent, child); this.queue.push(child.id); this.#breakDeadlock();
    return child.state === 'queued' ? { status: 'deferred', reason: 'concurrency', childId: child.id, queued: true } : { status: 'refused', reason: 'concurrency', childId: child.id, detail: 'cancelled to avoid deadlock' };
  }
  #attach(parent, child) { this.nodes.set(child.id, child); parent.children.push(child.id); }

  /** Remaining budget of a node: its limit minus what it and its descendants spent. */
  remaining(id) {
    const n = this.get(id), left = {};
    for (const k of ['steps', 'tokens', 'usd']) left[k] = n.budget[k] - n.spent[k];
    return left;
  }
  /** Charge usage to a node and every ancestor (so a parent's budget covers its subtree). */
  charge(id, { steps = 0, tokens = 0, usd = 0 }) {
    const own = this.get(id).own; own.steps += steps; own.tokens += tokens; own.usd += usd;
    for (let n = this.get(id); n; n = n.parentId ? this.nodes.get(n.parentId) : null) { n.spent.steps += steps; n.spent.tokens += tokens; n.spent.usd += usd; }
  }
  /** Parent blocks on children (still holds its slot) / resumes. */
  setWaiting(id, waiting) { const n = this.get(id); if (LIVE.has(n.state)) { n.state = waiting ? 'waiting' : 'running'; this.#breakDeadlock(); } }

  /** Finish a node. Frees its slot, cascades to unfinished children per policy ('cancel' | 'orphan'), promotes the queue. */
  finish(id, { status = 'completed', reason = null, summary = '', filesTouched = [], childPolicy = 'cancel' } = {}) {
    const n = this.get(id);
    if (FINAL.has(n.state)) return n;
    n.state = status; n.reason = reason; n.summary = String(summary).slice(0, 2000); n.filesTouched = filesTouched.slice(0, 50);
    if (childPolicy === 'cancel') for (const c of n.children) this.cancel(c, 'cancelled');
    this.#promote();
    return n;
  }
  /** Cancel a node and ALL descendants (queued ones are simply dropped). Returns the ids cancelled. */
  cancel(id, reason = 'cancelled') {
    const out = [], visit = nid => {
      const n = this.get(nid);
      for (const c of n.children) visit(c);
      if (FINAL.has(n.state)) return;
      n.state = 'cancelled'; n.reason = reason; out.push(nid); this.queue = this.queue.filter(q => q !== nid); this.onCancel(n);
    };
    visit(id); this.#promote(); return out;
  }
  #promote() {
    while (this.queue.length && this.liveCount() < this.ceilings.maxTotal) {
      const n = this.nodes.get(this.queue.shift());
      if (!n || n.state !== 'queued') continue;
      n.state = 'running'; this.onPromote(n);
    }
  }
  /** If every live node is a parent waiting on queued children, nothing can ever progress: cancel the newest queued child. */
  #breakDeadlock() {
    for (;;) {
      const live = [...this.nodes.values()].filter(x => LIVE.has(x.state));
      if (!this.queue.length || this.liveCount() < this.ceilings.maxTotal || !live.length || !live.every(x => x.state === 'waiting')) return;
      const victim = this.queue.pop(); const n = this.nodes.get(victim);
      n.state = 'cancelled'; n.reason = 'concurrency'; this.onCancel(n);
    }
  }

  /** Write guard: the node's file ownership list. Denies writes outside it so parallel children do not collide. */
  checkWrite(id, path, cwd) {
    const n = this.get(id);
    return ownsPath(n.files, path, cwd) ? { allowed: true } : { allowed: false, reason: `outside this worker's file ownership [${n.files.join(', ')}]` };
  }
  list(parentId) { return this.get(parentId).children.map(c => this.#brief(this.nodes.get(c))); }
  #brief(n) { return { id: n.id, type: n.type, state: n.state, reason: n.reason, steps: n.own.steps, tokens: n.own.tokens, usd: Number(n.own.usd.toFixed(6)), branch: n.branch }; }
  /** Concise structured report handed to the parent: never a transcript. */
  report(id) {
    const n = this.get(id);
    return { ...this.#brief(n), status: n.state === 'cancelled' ? 'stopped' : n.state, summary: n.summary, files: n.filesTouched, children: n.children.length };
  }
  /** One tree summary per root task for the orchestrator notification. */
  treeSummary(rootId) {
    const nodes = [...this.nodes.values()].filter(n => n.rootId === rootId);
    const root = this.get(rootId);
    return { rootId, status: root.state === 'cancelled' ? 'stopped' : root.state, reason: root.reason, slotsHeld: nodes.filter(n => LIVE.has(n.state)).length,
      totals: { tokens: nodes.reduce((s, n) => s + n.own.tokens, 0), usd: Number(nodes.reduce((s, n) => s + n.own.usd, 0).toFixed(6)), steps: nodes.reduce((s, n) => s + n.own.steps, 0) },
      nodes: nodes.map(n => ({ ...this.#brief(n), parentId: n.parentId, depth: n.depth })) };
  }
}

/** Optional isolation: one git worktree + branch per child. Returns { path, branch } or throws with git's message. */
export function createWorktree({ cwd, rootId, childId, git = 'git' }) {
  const branch = `oai/${rootId}-${childId}`.replace(/[^\w./-]/g, '_'), path = resolve(cwd, '..', `.oai-worktrees`, `${rootId}-${childId}`);
  execFileSync(git, ['worktree', 'add', '-b', branch, path, 'HEAD'], { cwd, stdio: 'pipe' });
  return { path, branch };
}
