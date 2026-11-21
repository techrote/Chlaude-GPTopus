import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usagePath } from '../bridge/usage.mjs';
import { realStateDir, testRoot, assertRealStateUntouched, snapshotStateDir } from './support/isolate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out }));
  });
}
/** An environment whose DEFAULT state location is `sandbox` and which names no usage override. */
function pristineEnv(sandbox) {
  const env = { ...process.env };
  for (const key of ['OPENAI_WORKER_USAGE_DIR', 'NODE_TEST_CONTEXT']) delete env[key];
  return Object.assign(env, { LOCALAPPDATA: join(sandbox, 'AppData', 'Local'), XDG_STATE_HOME: join(sandbox, 'state'), HOME: sandbox, USERPROFILE: sandbox });
}
const everyFile = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) everyFile(join(dir, entry.name), out); else out.push(join(dir, entry.name));
  }
  return out;
};

test('every test file imports the isolation module before anything else', () => {
  const files = readdirSync(here).filter(f => f.endsWith('.test.mjs'));
  assert(files.length >= 8, 'expected the whole test suite to be present');
  for (const file of files) {
    const firstImport = readFileSync(join(here, file), 'utf8').split(/\r?\n/).find(line => /^import\b/.test(line));
    assert.equal(firstImport, "import './support/isolate.mjs';", `${file} must import ./support/isolate.mjs first`);
  }
});

test('while the suite runs, the default usage ledger path is a private temporary directory, never the real one', () => {
  const env = { ...process.env }; delete env.OPENAI_WORKER_USAGE_DIR;
  assert.ok(usagePath(process.env).startsWith(testRoot), 'OPENAI_WORKER_USAGE_DIR must be redirected');
  assert.ok(usagePath(env).startsWith(testRoot), 'the platform default fallback must be redirected too');
  assertRealStateUntouched();
});

test('a test that forgets its own fixture would leak into the default path (negative control for the detector below)', async t => {
  const sandbox = join(testRoot, 'control'); mkdirSync(sandbox, { recursive: true });
  const code = `import { reserveRequest, releaseRequest } from ${JSON.stringify(new URL('../bridge/usage.mjs', import.meta.url).href)};
    const ticket = await reserveRequest({ workerType: 'daily-astrafree', model: 'gpt-6-astra' }); await releaseRequest(ticket);`;
  const result = await run(['--input-type=module', '-e', code], pristineEnv(sandbox));
  assert.equal(result.code, 0, result.out);
  const touched = snapshotStateDir(dirname(usagePath(pristineEnv(sandbox))));
  assert.ok(touched && Object.keys(touched).some(name => name.endsWith('.json')), 'an unisolated reservation writes the default ledger');
});

test('no test file writes outside its fixtures: each file run on a pristine environment leaves the default ledger path empty', async t => {
  const files = readdirSync(here).filter(f => f.endsWith('.test.mjs') && f !== 'isolation.test.mjs');
  const sandbox = join(testRoot, 'pristine'); mkdirSync(sandbox, { recursive: true });
  const results = await Promise.all(files.map(async file => ({ file, ...(await run([join(here, file)], pristineEnv(sandbox))) })));
  for (const r of results) assert.equal(r.code, 0, `${r.file} failed when run alone:\n${r.out.slice(-2000)}`);
  const leaked = everyFile(sandbox).filter(f => /free-usage-ledger/.test(f));
  assert.deepEqual(leaked.map(f => relative(sandbox, f)), [], 'a test wrote to the default per-user ledger location');
});
