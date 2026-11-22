// BUILD-01: scripts/build-desktop.mjs used to treat ANY first argument (including --help) as the output path and wrote a
// 440 KB MCPB under that name. These tests run the real script as a process, in an empty directory, and prove that flags are
// parsed as flags and can never become a file name.
import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, realpath, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'build-desktop.mjs');
const build = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
async function emptyDirectory(t) {
  const dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-build-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('BUILD-01: --help and -h print usage, exit 0 and create nothing', async t => {
  const dir = await emptyDirectory(t);
  for (const flag of ['--help', '-h', '--check --help', '--help --bogus']) {
    const result = build(dir, ...flag.split(' '));
    assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
    assert.match(result.stdout, /Usage: node scripts\/build-desktop\.mjs/);
    assert.deepEqual(await readdir(dir), [], `${flag} must not create a file`);
  }
});

test('BUILD-01: an unknown flag or a typo is an error (exit 2) and never a file name', async t => {
  const dir = await emptyDirectory(t);
  for (const argv of [['--chek'], ['--out'], ['-x'], ['--check', '--bogus'], ['--check', '--check'], ['a.mcpb', 'b.mcpb'], ['--', 'a.mcpb', 'b.mcpb']]) {
    const result = build(dir, ...argv);
    assert.equal(result.status, 2, `${argv.join(' ')}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /build-desktop: .*\n\nUsage:/);
    assert.deepEqual(await readdir(dir), [], `${argv.join(' ')} must not create a file`);
  }
});

test('BUILD-01: a normal build writes the named output, --check verifies it in either argument order, and -- allows a path that starts with a dash', async t => {
  const dir = await emptyDirectory(t);
  const made = build(dir, 'out.mcpb');
  assert.equal(made.status, 0, made.stderr); assert.equal(made.stdout.trim(), join(dir, 'out.mcpb'));
  assert.ok((await stat(join(dir, 'out.mcpb'))).size > 100000, 'a real bundle was written');
  for (const argv of [['--check', 'out.mcpb'], ['out.mcpb', '--check']]) {
    const checked = build(dir, ...argv);
    assert.equal(checked.status, 0, `${argv.join(' ')}: ${checked.stderr}`); assert.match(checked.stdout, /Verified reproducible MCPB/);
  }
  const bytes = await readFile(join(dir, 'out.mcpb'));
  const dashed = build(dir, '--', '--dash.mcpb');
  assert.equal(dashed.status, 0, dashed.stderr);
  assert.deepEqual((await readdir(dir)).sort(), ['--dash.mcpb', 'out.mcpb']);
  assert.deepEqual(await readFile(join(dir, '--dash.mcpb')), bytes, 'the same deterministic bytes');
  const missing = build(dir, '--check', 'absent.mcpb');
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /Committed MCPB is missing/);
});
