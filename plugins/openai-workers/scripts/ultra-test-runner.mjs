/**
 * Owner-run test executor for ULTRA's required-test manifest.
 *
 * This is the ONLY code in the distribution that starts a process on behalf of the
 * review workflow, and it is reachable only from the interactive owner CLI
 * (`ultra/cli.mjs run-test`) after the owner has read the exact command and typed a
 * confirmation. It is not imported by the bridge, the mod, the Desktop extension or
 * any MCP tool, and it lives outside `ultra/` so the Desktop MCPB bundle never
 * contains a process-spawning module.
 *
 * What it guarantees (and what it does not):
 *  - The command is an argv ARRAY supplied by the owner. Nothing is ever joined into
 *    a shell string, no shell is used, and no model-supplied value is an argument.
 *  - argv[0] is resolved here, against ABSOLUTE PATH entries only, and the absolute
 *    result is what is spawned. A relative path, a working-directory-relative name
 *    or a `.`/relative PATH entry can therefore never select a file planted in the
 *    project. .bat/.cmd files are refused (they need a shell).
 *  - The working directory must be an approved project root (or a directory inside
 *    one), canonical and link-free.
 *  - The child gets a minimal environment (no API keys, no ULTRA variables, nothing
 *    but what a toolchain needs to start), a wall-clock timeout that kills the
 *    process tree, and a hard cap on retained output.
 *  - It does NOT sandbox the command: the owner's declared command runs with the
 *    owner's privileges. And it cannot prove that the tree under the root contains
 *    the reviewed source snapshot; the confirmation says so and the owner asserts it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

export const RUNNER_ID = 'ultra-cli-test-runner/1';
export const DEFAULT_TIMEOUT_MS = 120_000, MAX_TIMEOUT_MS = 3_600_000;
export const DEFAULT_OUTPUT_BYTES = 262_144, MAX_OUTPUT_BYTES = 4_194_304;
const MAX_ARGS = 64, MAX_ARG_CHARS = 4096;
// The only variables a child receives. Everything else (API keys, ULTRA switches, tokens, proxies) is dropped.
const ENV_ALLOWLIST = ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TERM'];
const sha256 = text => createHash('sha256').update(text).digest('hex');
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const insideOf = (parent, child) => { const rel = relative(parent, child); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const same = (a, b, platform = process.platform) => platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export function minimalEnvironment(parent = process.env) {
  const env = {};
  for (const name of ENV_ALLOWLIST) if (typeof parent[name] === 'string' && parent[name] !== '' && !parent[name].includes('\0')) env[name] = parent[name];
  return env;
}

/**
 * Resolve argv[0] to an absolute executable. A name with a path separator must already be absolute; a bare name is searched
 * ONLY in absolute PATH entries. Returns the absolute path or throws a clear error.
 */
export function resolveExecutable(name, env = process.env, { platform = process.platform } = {}) {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw new Error('The test command needs a non-empty program name');
  const windows = platform === 'win32', pathApi = windows ? win32 : { isAbsolute: value => value.startsWith('/'), join };
  const extensions = windows ? ['.exe', '.com'] : [''];
  if (windows && /\.(?:bat|cmd)$/i.test(name)) throw new Error('A .bat/.cmd program needs a shell, which the runner never uses; name the program or `node script.js` directly');
  const usable = candidate => {
    try { const info = statSync(candidate); if (!info.isFile()) return false; if (!windows) accessSync(candidate, constants.X_OK); return true; }
    catch { return false; }
  };
  const tryAll = base => extensions.map(ext => (windows && /\.(?:exe|com)$/i.test(base) ? base : `${base}${ext}`)).find(usable);
  if (/[\\/]/.test(name) || (windows && /^[a-zA-Z]:/.test(name))) {
    if (!pathApi.isAbsolute(name) || (windows && !/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(name))) throw new Error('A program with a path separator must be an absolute path (a relative one would resolve inside the project)');
    const found = tryAll(name);
    if (!found) throw new Error(`Program not found or not executable: ${name}`);
    return found;
  }
  const dirs = String(env.PATH ?? env.Path ?? '').split(delimiter).filter(dir => dir && pathApi.isAbsolute(dir));
  for (const dir of dirs) { const found = tryAll(pathApi.join(dir, name)); if (found) return found; }
  throw new Error(`Program "${name}" was not found in any absolute PATH entry`);
}

async function canonicalDirectory(path, what) {
  let info, real;
  try { info = await stat(path); real = await realpath(path); } catch { throw new Error(`${what} does not exist`); }
  if (!info.isDirectory()) throw new Error(`${what} is not a directory`);
  return real;
}

/**
 * Validate an owner-typed command declaration against the owner's approved roots and normalise it. Pure apart from
 * filesystem checks of the root and working directory. Returns { argv, program, root, cwd, cwdRelative, timeoutMs, maxOutputBytes, digest }.
 */
export async function commandSpec(declaration, { approvedRoots, env = process.env, platform = process.platform } = {}) {
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) throw new Error('A test command declaration is required');
  for (const key of Object.keys(declaration)) if (!['argv', 'root', 'cwd', 'timeoutMs', 'maxOutputBytes'].includes(key)) throw new Error(`Unknown test command field ${key}`);
  const { argv } = declaration;
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_ARGS || argv.some(item => typeof item !== 'string' || item.length > MAX_ARG_CHARS || item.includes('\0'))) {
    throw new Error(`The test command must be an argv array of 1 to ${MAX_ARGS} strings (no shell string)`);
  }
  if (typeof declaration.root !== 'string' || !isAbsolute(declaration.root)) throw new Error('The test command needs an absolute project root');
  const requested = resolve(declaration.root);
  if (!Array.isArray(approvedRoots) || !approvedRoots.some(root => typeof root === 'string' && same(resolve(root), requested, platform))) {
    throw new Error('The working directory must be one of the approved project roots (permissions.roots in the owner policy)');
  }
  const root = await canonicalDirectory(requested, 'The project root');
  if (!same(root, requested, platform)) throw new Error('The project root must be spelled canonically, without links or aliases');
  let cwdRelative = '.', cwd = root;
  if (declaration.cwd !== undefined && declaration.cwd !== '.') {
    const value = declaration.cwd;
    if (typeof value !== 'string' || !value || isAbsolute(value) || /[\\:\0]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('The working subdirectory must be a plain relative path with forward slashes and no ".." segments');
    }
    cwdRelative = value;
    cwd = await canonicalDirectory(join(root, ...value.split('/')), 'The working directory');
    if (!insideOf(root, cwd)) throw new Error('The working directory resolves outside the approved project root');
  }
  const bounded = (value, fallback, maximum, name) => {
    const chosen = value ?? fallback;
    if (!Number.isInteger(chosen) || chosen < 1 || chosen > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
    return chosen;
  };
  const timeoutMs = bounded(declaration.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'timeoutMs');
  const maxOutputBytes = bounded(declaration.maxOutputBytes, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES, 'maxOutputBytes');
  const program = resolveExecutable(argv[0], env, { platform });
  // The digest names WHAT runs: the argv as typed, the approved root and the subdirectory. It is what a required test may pin.
  const digest = sha256(JSON.stringify({ kind: 'ultra-test-command/1', argv, root, cwd: cwdRelative }));
  return { argv: [...argv], program, root, cwd, cwdRelative, timeoutMs, maxOutputBytes, digest };
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* already gone */ }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/**
 * Run a validated spec. Resolves with { started, exitCode, signal, timedOut, durationMs, output, outputBytes, truncated, outputSha256 }
 * and rejects only when the program could not be started at all (nothing ran, so no evidence may be recorded).
 */
export function runCommand(spec, { env = process.env, clock = Date.now } = {}) {
  return new Promise((done, fail) => {
    const began = clock(), chunks = []; let retained = 0, total = 0, truncated = false, timedOut = false, settled = false;
    const child = spawn(spec.program, spec.argv.slice(1), { cwd: spec.cwd, env: minimalEnvironment(env), shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const keep = chunk => {
      total += chunk.length; chunks.push(chunk); retained += chunk.length;
      // Keep the TAIL: a test failure is reported last. Whole chunks are dropped from the front once over the cap.
      while (retained > spec.maxOutputBytes && chunks.length > 1) { retained -= chunks.shift().length; truncated = true; }
      if (retained > spec.maxOutputBytes) { chunks[0] = chunks[0].subarray(chunks[0].length - spec.maxOutputBytes); retained = spec.maxOutputBytes; truncated = true; }
    };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, spec.timeoutMs);
    child.on('error', error => { clearTimeout(timer); if (!settled) { settled = true; fail(error); } });
    child.on('close', (code, signal) => {
      clearTimeout(timer); if (settled) return; settled = true;
      let buffer = Buffer.concat(chunks);
      if (buffer.length > spec.maxOutputBytes) { buffer = buffer.subarray(buffer.length - spec.maxOutputBytes); truncated = true; }
      const signalled = signal && own(osConstants.signals, signal) ? 128 + osConstants.signals[signal] : 1;
      done({ started: true, exitCode: timedOut ? 124 : Number.isInteger(code) ? code : signalled, signal: signal ?? null, timedOut, durationMs: clock() - began,
        output: buffer.toString('utf8'), outputBytes: total, truncated, outputSha256: sha256(buffer) });
    });
  });
}

/** Bounded, printable evidence text (the review ledger accepts at most 20,000 characters). */
export function evidenceDetails(spec, result, { limit = 19000 } = {}) {
  const printable = text => text.replace(/[^\n\t\x20-\x7e\u00a0-\uffff]/g, '?');
  const head = [`Executed by ${RUNNER_ID}`, `command digest: ${spec.digest}`, `argv: ${JSON.stringify(spec.argv)}`, `root: ${spec.root}`, `cwd: ${spec.cwdRelative}`,
    `exit code: ${result.exitCode}${result.timedOut ? ` (killed after ${spec.timeoutMs} ms timeout)` : ''}${result.signal ? ` (signal ${result.signal})` : ''}`,
    `duration: ${result.durationMs} ms`, `output: ${result.outputBytes} bytes produced${result.truncated ? `, only the last ${Buffer.byteLength(result.output)} retained` : ''}`,
    `retained output sha256: ${result.outputSha256}`, '--- output (tail) ---'].join('\n');
  const room = Math.max(0, limit - head.length - 1), text = printable(result.output);
  return `${head}\n${text.length > room ? text.slice(text.length - room) : text}`;
}
