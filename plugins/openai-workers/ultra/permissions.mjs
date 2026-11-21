import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// This boundary is constructed by trusted server code, never from tool arguments.
// It deliberately has no child_process import and cannot execute an arbitrary shell.
export class PermissionError extends Error {
  constructor(code, message) { super(message); this.name = 'PermissionError'; this.code = code; }
}
const refuse = (code, message) => { throw new PermissionError(code, message); };
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const secret = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.npmrc|\.pypirc|\.netrc|\.claude|\.codex|\.ultra(?:[-.].*)?|\.claude-openai-workers|ClaudeOpenAIWorkers|free-usage-ledger\.json|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|kdbx|dpapi))$/i;
const device = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
const coreRoles = new Set(['author', 'implementation', 'reworker', 'rework']);
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;

/** Portable relative paths only: reject normalization rather than silently repairing it. */
export function relativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) refuse('PATH', 'A bounded relative path is required.');
  if (path.isAbsolute(value) || /^[a-z]:/i.test(value) || value.startsWith('\\') || value.includes('\\') || value.includes(':')) refuse('PATH', 'Absolute paths, alternate streams and backslashes are not accepted.');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || device.test(p) || p.includes('~') || /[<>"|?*]/.test(p))) refuse('PATH', 'Ambiguous, traversing or Windows-reserved paths are not accepted.');
  if (parts.some(p => secret.test(p))) refuse('SECRET', 'Credential, control and secret paths are excluded.');
  return parts.join('/');
}

function allowedScope(relative, scopes) {
  return scopes.some(scope => scope === '.' || relative === scope || relative.startsWith(`${scope}/`));
}

async function noLinks(absolute, { regular = false, allowMissing = false } = {}) {
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let last;
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    try { last = await fs.lstat(cursor, { bigint: true }); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw error;
    }
    if (last.isSymbolicLink()) refuse('LINK', 'Symbolic links and junctions are not accepted.');
    if (await fs.realpath(cursor) !== cursor) refuse('PATH_ALIAS', 'Path spelling must match its canonical case and identity.');
    if (i < parts.length - 1 && !last.isDirectory()) refuse('PATH', 'A path component is not a directory.');
    if (i === parts.length - 1 && regular && !last.isFile()) refuse('TYPE', 'Only regular files are accepted.');
    if (last.isFile() && last.nlink !== 1n) refuse('HARDLINK', 'Multiply linked files are not accepted.');
  }
  return last;
}

/**
 * Reads the inode checked before opening, not merely a path checked earlier.
 * O_NOFOLLOW plus pre/post inode and ancestor checks prevents link replacement
 * from making a different file's bytes reach the caller. A same-user process
 * can still alter authorized file contents; this is not an OS sandbox.
 */
async function verifiedRead(absolute, maxBytes) {
  const before = await noLinks(absolute, { regular: true });
  if (before.size > BigInt(maxBytes)) refuse('SIZE', `File exceeds ${maxBytes} bytes.`);
  const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(before, opened)) refuse('RACE', 'File identity changed while opening.');
    // Bound the actual read, including a file grown after stat().
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) refuse('SIZE', `File exceeds ${maxBytes} bytes.`);
    const after = await noLinks(absolute, { regular: true });
    const finished = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after) || !sameIdentity(before, finished) || before.size !== finished.size || before.mtimeNs !== finished.mtimeNs || before.ctimeNs !== finished.ctimeNs) refuse('RACE', 'File changed during the read; retry after it is stable.');
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

export class PermissionBoundary {
  #config; #roots; #stages = new Map(); #serial = Promise.resolve(); #dependencies;
  constructor(config = {}, dependencies = {}) {
    this.#config = clone({ profile: 'A', roots: [], protectedPaths: [], maxReadBytes: 1024 * 1024, maxStageBytes: 16 * 1024 * 1024, maxStageFiles: 256, principal: { id: 'untrusted', role: 'reviewer' }, commands: [], ...config });
    if (!['A', 'B', 'C'].includes(this.#config.profile)) refuse('PROFILE', 'Unknown project-access profile.');
    for (const field of ['maxReadBytes', 'maxStageBytes', 'maxStageFiles']) if (!Number.isSafeInteger(this.#config[field]) || this.#config[field] < 1) refuse('CONFIG', `${field} must be a positive integer.`);
    if (this.#config.maxReadBytes > 16 * 1024 * 1024 || this.#config.maxStageBytes > 256 * 1024 * 1024 || this.#config.maxStageFiles > 4096) refuse('CONFIG', 'File boundary exceeds its supported size ceiling.');
    this.#dependencies = dependencies;
    this.#roots = this.#config.roots.map((entry, index) => {
      const root = typeof entry === 'string' ? { path: entry } : entry;
      if (!root || typeof root.path !== 'string' || !path.isAbsolute(root.path)) refuse('ROOT', 'Project roots must be explicit absolute paths.');
      if (root.path.split(/[\\/]/).some(p => secret.test(p))) refuse('SECRET', 'Credential and control directories cannot be project roots.');
      const scopes = name => (root[name] ?? (name === 'read' ? ['.'] : [])).map(scope => scope === '.' ? '.' : relativePath(scope));
      return { id: root.id ?? String(index), path: path.resolve(root.path), read: scopes('read'), write: scopes('write') };
    });
    if (new Set(this.#roots.map(root => root.id)).size !== this.#roots.length) refuse('ROOT', 'Project root identifiers must be unique.');
    if (!Array.isArray(this.#config.protectedPaths) || this.#config.protectedPaths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) refuse('CONFIG', 'Protected paths must be absolute.');
    if (!Array.isArray(this.#config.commands)) refuse('CONFIG', 'Command allowlist must be an array.');
  }

  async #root(id) {
    if (this.#config.profile === 'A') refuse('PROFILE', 'Think-only profile has no project access.');
    const root = this.#roots.find(r => r.id === String(id));
    if (!root) refuse('ROOT', 'Project root is not configured.');
    const stat = await noLinks(root.path);
    if (!stat?.isDirectory() || await fs.realpath(root.path) !== root.path) refuse('ROOT', 'Project root must be a canonical directory without links.');
    return root;
  }
  #core() {
    if (this.#config.profile !== 'C') refuse('PROFILE', 'Editing and testing require explicit profile C.');
    if (!coreRoles.has(this.#config.principal?.role)) refuse('ROLE', 'Only an authorised Core author or reworker can modify implementation.');
  }
  #locked(callback) {
    const result = this.#serial.then(callback);
    this.#serial = result.catch(() => {});
    return result;
  }
  async #persist(stage) {
    const manifest = JSON.stringify({ version: 1, id: stage.id, owner: stage.owner, createdAt: stage.createdAt, files: [...stage.files] });
    const temporary = path.join(stage.directory, `.ultra-save-${randomUUID()}`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(manifest); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(temporary, path.join(stage.directory, '.ultra-stage.json')); }
    catch (error) { await fs.rm(temporary, { force: true }); throw error; }
    if (process.platform !== 'win32') { const directory = await fs.open(stage.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  }
  async readFile(rootId, requested) {
    const relative = relativePath(requested), root = await this.#root(rootId);
    if (!allowedScope(relative, root.read)) refuse('SCOPE', 'File is outside the permitted read scope.');
    const absolute = path.join(root.path, ...relative.split('/'));
    if (!inside(root.path, absolute)) refuse('SCOPE', 'File is outside the project root.');
    if (this.#config.protectedPaths.some(p => inside(path.resolve(p), absolute))) refuse('SECRET', 'File is a protected control or credential path.');
    const bytes = await verifiedRead(absolute, this.#config.maxReadBytes);
    if (bytes.includes(0)) refuse('ENCODING', 'Only text files can be passed to workers.');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { rootId: root.id, path: relative, content, sha256: sha256(bytes), bytes: bytes.length };
  }
  async inspectPath(rootId, requested, operation = 'read') {
    const relative = relativePath(requested), root = await this.#root(rootId);
    if (operation !== 'read') refuse('LIVE_WRITE', 'Live project edits require a separately trusted host sandbox. Use staged patches.');
    if (!allowedScope(relative, root.read)) refuse('SCOPE', 'File is outside the permitted read scope.');
    if (this.#config.protectedPaths.some(p => inside(path.resolve(p), path.join(root.path, ...relative.split('/'))))) refuse('SECRET', 'File is a protected control or credential path.');
    await noLinks(path.join(root.path, ...relative.split('/')), { regular: true });
    return { rootId: root.id, path: relative, operation };
  }
  async createStage(files) {
    this.#core();
    if (!Array.isArray(files) || !files.length || files.length > this.#config.maxStageFiles) refuse('SIZE', 'Snapshot requires a bounded explicit file list.');
    return this.#locked(async () => {
      const source = [], names = new Set(); let total = 0;
      for (const file of files) {
        const read = await this.readFile(file.rootId ?? '0', file.path);
        if (names.has(read.path.toLowerCase())) refuse('COLLISION', 'Snapshot paths must be unique across selected roots, including case.');
        names.add(read.path.toLowerCase()); total += read.bytes;
        if (total > this.#config.maxStageBytes) refuse('SIZE', 'Snapshot exceeds the configured byte budget.');
        source.push(read);
      }
      if (this.#dependencies.stageDirectory) {
        await noLinks(path.resolve(this.#dependencies.stageDirectory), { allowMissing: true });
        await fs.mkdir(this.#dependencies.stageDirectory, { recursive: true, mode: 0o700 });
      }
      const base = await fs.realpath(this.#dependencies.stageDirectory ?? os.tmpdir());
      await noLinks(base);
      const id = randomUUID(), directory = path.join(base, `ultra-stage-${id}`);
      await fs.mkdir(directory, { mode: 0o700 });
      const stage = { id, directory, owner: this.#config.principal.id, files: new Map(), createdAt: new Date().toISOString(), recovered: false };
      // Failed creation preserves no user files: only this fresh private directory is touched.
      try {
        for (const file of source) {
          const target = path.join(directory, ...file.path.split('/'));
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await fs.writeFile(target, file.content, { flag: 'wx', mode: 0o600 });
          stage.files.set(file.path, { rootId: file.rootId, original: file.content, beforeSha256: file.sha256, deleted: false });
        }
        await this.#persist(stage);
        this.#stages.set(stage.id, stage);
      } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
      return this.#describe(stage);
    });
  }
  #stage(id) { const stage = this.#stages.get(id); if (!stage || stage.owner !== this.#config.principal.id) refuse('STAGE', 'Snapshot is not owned by this principal.'); return stage; }
  #writableStage(id) { const stage = this.#stage(id); if (stage.recovered) refuse('RECOVERY_HOLD', 'Recovered snapshots are preserved read-only. Reallocate a fresh Core stage before modifying or testing.'); return stage; }
  async recoverStage(id) {
    this.#core();
    if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) refuse('STAGE', 'Invalid snapshot identifier.');
    return this.#locked(async () => {
      const base = await fs.realpath(this.#dependencies.stageDirectory ?? os.tmpdir());
      await noLinks(base);
      const directory = path.join(base, `ultra-stage-${id}`);
      const bytes = await verifiedRead(path.join(directory, '.ultra-stage.json'), this.#config.maxStageBytes * 6 + 1024 * 1024);
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (manifest.version !== 1 || manifest.id !== id || manifest.owner !== this.#config.principal.id || !Array.isArray(manifest.files) || manifest.files.length > this.#config.maxStageFiles) refuse('STAGE', 'Snapshot provenance is invalid or belongs to another principal.');
      const entries = [], names = new Set();
      for (const row of manifest.files) {
        if (!Array.isArray(row) || row.length !== 2 || !row[1] || typeof row[1] !== 'object') refuse('STAGE', 'Snapshot manifest is corrupt.');
        const [name, file] = row; relativePath(name);
        if (names.has(name) || typeof file.deleted !== 'boolean' || (file.original !== null && typeof file.original !== 'string') || file.beforeSha256 !== (file.original === null ? null : sha256(file.original))) refuse('STAGE', 'Snapshot baseline is corrupt.');
        await this.#root(file.rootId); names.add(name); entries.push([name, file]);
      }
      const stage = { id, directory, owner: manifest.owner, createdAt: manifest.createdAt, files: new Map(entries), recovered: true };
      const summary = await this.#describe(stage);
      if (summary.files.reduce((n, f) => n + f.bytes, 0) > this.#config.maxStageBytes) refuse('SIZE', 'Recovered snapshot exceeds the byte budget.');
      this.#stages.set(id, stage);
      return { ...summary, recovery: 'held-read-only', executionResumed: false };
    });
  }
  async #describe(stage) {
    const entries = [];
    for (const [name, file] of [...stage.files].sort(([a], [b]) => a.localeCompare(b))) {
      const bytes = file.deleted ? null : await verifiedRead(path.join(stage.directory, ...name.split('/')), this.#config.maxReadBytes);
      entries.push({ rootId: file.rootId, path: name, sha256: bytes === null ? null : sha256(bytes), bytes: bytes?.length ?? 0 });
    }
    return { id: stage.id, owner: stage.owner, createdAt: stage.createdAt, files: entries, sourceHash: sha256(JSON.stringify(entries)) };
  }
  describeStage(id) { return this.#locked(() => this.#describe(this.#stage(id))); }
  async stageRead(id, requested) {
    const name = relativePath(requested), stage = this.#stage(id), entry = stage.files.get(name);
    if (!entry || entry.deleted) refuse('SCOPE', 'File is not present in this snapshot.');
    const bytes = await verifiedRead(path.join(stage.directory, ...name.split('/')), this.#config.maxReadBytes);
    return { path: name, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), sha256: sha256(bytes) };
  }
  async stageWrite(id, requested, content, expectedSha256, rootId = '0') {
    this.#core(); const name = relativePath(requested);
    if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > this.#config.maxReadBytes) refuse('SIZE', 'Edit must contain bounded text.');
    return this.#locked(async () => {
      const stage = this.#writableStage(id), entry = stage.files.get(name), root = await this.#root(entry?.rootId ?? rootId);
      if (!allowedScope(name, root.write)) refuse('SCOPE', 'Edit is outside the authorised write scope.');
      if (this.#config.protectedPaths.some(p => inside(path.resolve(p), path.join(root.path, ...name.split('/'))))) refuse('SECRET', 'Edit targets a protected control or credential path.');
      if ([...stage.files.keys()].some(p => p !== name && p.toLowerCase() === name.toLowerCase())) refuse('COLLISION', 'Case variants cannot identify different snapshot files.');
      const target = path.join(stage.directory, ...name.split('/'));
      if (entry && !entry.deleted) {
        const current = await verifiedRead(target, this.#config.maxReadBytes);
        if (expectedSha256 !== sha256(current)) refuse('STALE', 'Edit does not match the current snapshot file.');
      } else {
        if (expectedSha256 !== null) refuse('STALE', 'A new file requires an explicit null expected hash.');
        try { await fs.lstat(target); refuse('COLLISION', 'An untracked file already exists at the target.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const summary = await this.#describe(stage);
      if (!entry && summary.files.length >= this.#config.maxStageFiles) refuse('SIZE', 'Snapshot file budget exhausted.');
      if (summary.files.reduce((n, f) => n + (f.path === name ? 0 : f.bytes), 0) + Buffer.byteLength(content) > this.#config.maxStageBytes) refuse('SIZE', 'Snapshot byte budget exhausted.');
      await noLinks(stage.directory);
      await noLinks(path.dirname(target), { allowMissing: true });
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await noLinks(path.dirname(target));
      // Atomic replace in our private snapshot. No caller-controlled process runs here.
      const temporary = path.join(path.dirname(target), `.ultra-edit-${randomUUID()}`);
      await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      try { await fs.rename(temporary, target); } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
      stage.files.set(name, { rootId: root.id, original: entry?.original ?? null, beforeSha256: entry?.beforeSha256 ?? null, deleted: false });
      await this.#persist(stage);
      return { path: name, sha256: sha256(content), staged: true, liveProjectModified: false };
    });
  }
  async stageDelete(id, requested, expectedSha256) {
    this.#core(); const name = relativePath(requested);
    return this.#locked(async () => {
      const stage = this.#writableStage(id), file = stage.files.get(name);
      if (!file || file.deleted) refuse('SCOPE', 'File is not present in this snapshot.');
      const root = await this.#root(file.rootId);
      if (!allowedScope(name, root.write)) refuse('SCOPE', 'Deletion is outside the authorised write scope.');
      const target = path.join(stage.directory, ...name.split('/'));
      const current = await verifiedRead(target, this.#config.maxReadBytes);
      if (sha256(current) !== expectedSha256) refuse('STALE', 'Deletion does not match the current snapshot file.');
      await fs.unlink(target); file.deleted = true;
      await this.#persist(stage);
      return { path: name, staged: true, liveProjectModified: false };
    });
  }
  async stagePatch(id) {
    return this.#locked(async () => {
      const stage = this.#stage(id), patches = [];
      for (const [name, file] of stage.files) {
        const content = file.deleted ? null : new TextDecoder('utf-8', { fatal: true }).decode(await verifiedRead(path.join(stage.directory, ...name.split('/')), this.#config.maxReadBytes));
        const afterSha256 = content === null ? null : sha256(content);
        if (afterSha256 !== file.beforeSha256) patches.push({ rootId: file.rootId, path: name, beforeSha256: file.beforeSha256, afterSha256, content });
      }
      return { stageId: stage.id, sourceHash: (await this.#describe(stage)).sourceHash, patches, applied: false };
    });
  }
  async runApprovedTest(id, commandId, approvalToken) {
    this.#core();
    return this.#locked(async () => {
      const stage = this.#writableStage(id), command = this.#config.commands.find(c => c.id === commandId);
      if (!command || command.effect !== 'test' || !path.isAbsolute(command.executable ?? '') || !Array.isArray(command.args) || command.args.some(a => typeof a !== 'string') || !/^[a-f0-9]{64}$/.test(command.sha256 ?? '')) refuse('COMMAND', 'Command is not an exact executable and argument allowlist entry.');
      if (command.timeoutMs !== undefined && (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1)) refuse('COMMAND', 'Test timeout must be a positive integer.');
      const { executeIsolated, attestIsolation, consumeApproval } = this.#dependencies;
      if (typeof executeIsolated !== 'function' || typeof attestIsolation !== 'function' || typeof consumeApproval !== 'function') refuse('SANDBOX_UNAVAILABLE', 'No trusted isolated test executor and approval gate are installed.');
      const attestation = await attestIsolation();
      for (const key of ['stageOnly', 'hostReadOnly', 'networkDenied', 'secretsRemoved', 'processTreeCleanup']) if (attestation?.[key] !== true) refuse('SANDBOX_UNAVAILABLE', `Trusted executor lacks ${key}.`);
      const executable = await verifiedRead(command.executable, 128 * 1024 * 1024);
      if (sha256(executable) !== command.sha256) refuse('COMMAND_CHANGED', 'Allowlisted executable changed.');
      const snapshot = await this.#describe(stage);
      const action = { kind: 'test', principal: this.#config.principal.id, stageId: id, sourceHash: snapshot.sourceHash, executable: command.executable, executableSha256: command.sha256, args: command.args, timeoutMs: Math.min(command.timeoutMs ?? 30000, 300000) };
      const actionHash = sha256(JSON.stringify(action));
      if (await consumeApproval({ token: approvalToken, actionHash, action: clone(action) }) !== true) refuse('APPROVAL', 'Testing requires an unexpired action-bound approval.');
      // The injected executor is part of the trusted computing base. It must
      // reject if its OS sandbox cannot be established, and pin the executable.
      const result = await executeIsolated({ ...action, actionHash, stageDirectory: stage.directory });
      return { actionHash, sourceHash: snapshot.sourceHash, result, qualification: 'trusted-executor', liveProjectModified: false };
    });
  }
  executeConsequential() { refuse('EXECUTION_GATE', 'Code review and recruitment approval do not authorise consequential execution.'); }
  applyToProject() { refuse('LIVE_WRITE', 'Applying patches to a live project requires a separate trusted host transaction and execution approval.'); }
}
