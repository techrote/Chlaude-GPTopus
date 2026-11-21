import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(v => stable(v ?? null)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
export const clone = value => structuredClone(value);
export function invariant(condition, message) { if (!condition) throw new Error(message); }
const empty = () => ({ version: 1, revision: 0, missions: {}, events: [], lastHash: null });
const wait = ms => new Promise(r => setTimeout(r, ms));
const transientWindows = (error, platform = process.platform) => platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);

/** Windows delete-pending/share violations are retryable, never evidence of ownership. */
export async function retryWindowsFileOperation(operation, { platform = process.platform, timeoutMs = 1000, clock = Date.now, pause = wait } = {}) {
  const began = clock();
  while (true) {
    try { return await operation(); }
    catch (error) { if (!transientWindows(error, platform) || clock() - began >= timeoutMs) throw error; await pause(10); }
  }
}

/** One durable, cross-process transaction boundary. Never steal a live owner's lock. */
export class ExecutionStore {
  constructor(path, { lockTimeoutMs = 10000, now = () => Date.now() } = {}) {
    this.path = resolve(path); this.lockPath = `${this.path}.lock`; this.lockTimeoutMs = lockTimeoutMs; this.now = now;
  }
  async lock() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const start = Date.now(); const nonce = randomUUID();
    while (true) {
      try {
        const fd = await retryWindowsFileOperation(() => open(this.lockPath, 'wx', 0o600), { timeoutMs: Math.max(0, this.lockTimeoutMs - (Date.now() - start)) });
        await fd.writeFile(JSON.stringify({ pid: process.pid, nonce })); await fd.sync(); await fd.close();
        return async () => retryWindowsFileOperation(async () => {
          const owner = JSON.parse(await readFile(this.lockPath, 'utf8'));
          invariant(owner.nonce === nonce, 'Execution ledger lock ownership changed');
          await unlink(this.lockPath);
        }, { timeoutMs: this.lockTimeoutMs });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const owner = JSON.parse(await readFile(this.lockPath, 'utf8'));
          invariant(Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.nonce === 'string', 'Invalid execution lock; inspect locally');
          let dead = false;
          try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') dead = true; }
          if (dead) {
            // A separate recovery lock prevents two recoverers deleting a new owner's lock.
            let recovery;
            try {
              recovery = await open(`${this.lockPath}.recovery`, 'wx', 0o600);
              const again = JSON.parse(await readFile(this.lockPath, 'utf8'));
              if (again.nonce === owner.nonce) await unlink(this.lockPath);
            } catch (e) { if (!['EEXIST', 'ENOENT'].includes(e.code)) throw e; }
            finally { if (recovery) { await recovery.close(); await unlink(`${this.lockPath}.recovery`).catch(() => {}); } }
          }
        } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError) && !transientWindows(e)) throw e; }
        invariant(Date.now() - start < this.lockTimeoutMs, 'Execution ledger busy or incomplete lock; no operation was admitted');
        await wait(10);
      }
    }
  }
  async read() {
    try {
      const state = JSON.parse(await retryWindowsFileOperation(() => readFile(this.path, 'utf8')));
      invariant(state.version === 1 && Number.isInteger(state.revision) && state.missions && Array.isArray(state.events), 'Unsupported or corrupt execution ledger');
      let previous = null;
      for (const event of state.events) {
        const { hash, ...payload } = event;
        invariant(payload.previous === previous && digest(payload) === hash, 'Execution audit chain is corrupt');
        previous = hash;
      }
      invariant(previous === state.lastHash, 'Execution audit head is corrupt');
      const { stateHash, ...snapshot } = state;
      invariant(typeof stateHash === 'string' && digest(snapshot) === stateHash, 'Execution state snapshot is corrupt or lacks its integrity checksum');
      return state;
    } catch (e) { if (e.code === 'ENOENT') return empty(); throw e; }
  }
  async transaction(fn) {
    const unlock = await this.lock();
    let temporary;
    try {
      const state = await this.read();
      const event = (type, missionId, data = {}) => {
        const payload = { sequence: state.events.length + 1, at: this.now(), type, missionId, data: clone(data), previous: state.lastHash };
        const hash = digest(payload); state.events.push({ ...payload, hash }); state.lastHash = hash;
      };
      const result = fn(state, event);
      invariant(!result || typeof result.then !== 'function', 'Ledger transactions must be synchronous; perform external work after reservation');
      state.revision++;
      delete state.stateHash; state.stateHash = digest(state);
      temporary = `${this.path}.${randomUUID()}.tmp`;
      const fd = await open(temporary, 'wx', 0o600);
      try { await fd.writeFile(JSON.stringify(state)); await fd.sync(); } finally { await fd.close(); }
      await retryWindowsFileOperation(() => rename(temporary, this.path)); temporary = null;
      // POSIX directory durability; Windows disallows opening directories.
      if (process.platform !== 'win32') { const dir = await open(dirname(this.path), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
      return clone(result);
    } finally { if (temporary) await unlink(temporary).catch(() => {}); await unlock(); }
  }
  async snapshot(missionId) {
    const state = await this.read();
    if (!missionId) return clone(state);
    invariant(state.missions[missionId], 'Unknown mission'); return clone(state.missions[missionId]);
  }
}
