import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PermissionBoundary, relativePath, sha256 } from '../ultra/permissions.mjs';

async function fixture(t, overrides = {}, dependencies = {}) {
  const tmp = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(tmp, 'ultra-permission-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'app.js'), 'export const value = 1;\n');
  await fs.writeFile(path.join(root, 'README.md'), 'safe text\n');
  const boundary = new PermissionBoundary({ profile: 'C', roots: [{ path: root, read: ['src', 'README.md'], write: ['src'] }], principal: { id: 'author-1', role: 'author' }, ...overrides }, { stageDirectory: dir, ...dependencies });
  return { boundary, root, dir };
}
const code = expected => error => error?.code === expected;

test('think-only A denies all project reads, B reads bounded exact scope', async t => {
  const { root } = await fixture(t);
  const a = new PermissionBoundary({ roots: [root] });
  await assert.rejects(a.readFile('0', 'README.md'), code('PROFILE'));
  const b = new PermissionBoundary({ profile: 'B', roots: [{ path: root, read: ['src'] }] });
  assert.match((await b.readFile('0', 'src/app.js')).content, /value = 1/);
  await assert.rejects(b.readFile('0', 'README.md'), code('SCOPE'));
  await assert.rejects(b.createStage([{ path: 'src/app.js' }]), code('PROFILE'));
});

test('portable path rejection covers traversal, ADS, device paths, case tricks and secrets', () => {
  for (const name of ['../x', 'src/../x', '/etc/passwd', 'C:/x', 'src\\x', 'file:stream', 'x\0y', './x', 'src//x', 'src/con.txt', 'src/COM1', 'x. ', 'x.', 'src/..', 'SRC/../x', '.EnV', '.env.local', '.git/config', '.SSH/config', 'key.dpapi', 'ClaudeOpenAIWorkers/foo', 'PROGRA~1/x', 'x?y']) assert.throws(() => relativePath(name), undefined, name);
  assert.equal(relativePath('src/a-b_1.js'), 'src/a-b_1.js');
});

test('read boundary rejects symlinks, junctions and hardlinks', async t => {
  const { boundary, root, dir } = await fixture(t);
  const outside = path.join(dir, 'outside.txt'); await fs.writeFile(outside, 'secret');
  await fs.link(outside, path.join(root, 'src', 'linked.txt'));
  await assert.rejects(boundary.readFile('0', 'src/linked.txt'), code('HARDLINK'));
  // Junctions do not require Developer Mode on Windows.
  await fs.mkdir(path.join(dir, 'outside'));
  await fs.writeFile(path.join(dir, 'outside', 'file.txt'), 'secret');
  await fs.symlink(path.join(dir, 'outside'), path.join(root, 'src', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(boundary.readFile('0', 'src/escape/file.txt'), code('LINK'));
});

test('protected absolute paths remain blocked even inside explicitly selected root', async t => {
  const { root } = await fixture(t);
  const b = new PermissionBoundary({ profile: 'B', roots: [root], protectedPaths: [path.join(root, 'src')] });
  await assert.rejects(b.readFile('0', 'src/app.js'), code('SECRET'));
  assert.throws(() => new PermissionBoundary({ profile: 'B', roots: [path.join(root, '.ssh')] }), code('SECRET'));
});

test('bounded file reads reject oversized, binary and invalid UTF-8 content', async t => {
  const { boundary, root } = await fixture(t, { maxReadBytes: 32 });
  await fs.writeFile(path.join(root, 'src', 'large.txt'), 'a'.repeat(33));
  await fs.writeFile(path.join(root, 'src', 'binary.txt'), Buffer.from([65, 0, 66]));
  await fs.writeFile(path.join(root, 'src', 'invalid.txt'), Buffer.from([0xff]));
  await assert.rejects(boundary.readFile('0', 'src/large.txt'), code('SIZE'));
  await assert.rejects(boundary.readFile('0', 'src/binary.txt'), code('ENCODING'));
  await assert.rejects(boundary.readFile('0', 'src/invalid.txt'));
});

test('staged writes produce source-bound patches without changing live files', async t => {
  const { boundary, root } = await fixture(t);
  const stage = await boundary.createStage([{ path: 'src/app.js' }]);
  const file = await boundary.stageRead(stage.id, 'src/app.js');
  const changed = 'export const value = 2;\n';
  await boundary.stageWrite(stage.id, 'src/app.js', changed, file.sha256);
  const patch = await boundary.stagePatch(stage.id);
  assert.equal(patch.applied, false); assert.equal(patch.patches.length, 1);
  assert.equal(patch.patches[0].beforeSha256, file.sha256);
  assert.equal(patch.patches[0].afterSha256, sha256(changed));
  assert.equal(patch.patches[0].content, changed);
  assert.match(await fs.readFile(path.join(root, 'src', 'app.js'), 'utf8'), /value = 1/);
  assert.throws(() => boundary.applyToProject(), code('LIVE_WRITE'));
});

test('stale edits and concurrent conflicting edits cannot silently overwrite', async t => {
  const { boundary } = await fixture(t);
  const stage = await boundary.createStage([{ path: 'src/app.js' }]);
  const { sha256: before } = await boundary.stageRead(stage.id, 'src/app.js');
  const results = await Promise.allSettled([
    boundary.stageWrite(stage.id, 'src/app.js', 'first', before),
    boundary.stageWrite(stage.id, 'src/app.js', 'second', before),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'STALE');
  assert.equal((await boundary.stageRead(stage.id, 'src/app.js')).content, 'first');
});

test('restart recovers accepted patches on read-only hold without replaying execution', async t => {
  const { boundary, root, dir } = await fixture(t);
  const stage = await boundary.createStage([{ path: 'src/app.js' }]);
  const before = await boundary.stageRead(stage.id, 'src/app.js');
  await boundary.stageWrite(stage.id, 'src/app.js', 'preserved work', before.sha256);
  await boundary.stageWrite(stage.id, 'src/new.js', 'new work', null);
  const restarted = new PermissionBoundary({ profile: 'C', roots: [{ path: root, write: ['src'] }], principal: { id: 'author-1', role: 'author' } }, { stageDirectory: dir });
  const recovered = await restarted.recoverStage(stage.id);
  assert.equal(recovered.executionResumed, false);
  assert.equal((await restarted.stageRead(stage.id, 'src/app.js')).content, 'preserved work');
  assert.equal((await restarted.stagePatch(stage.id)).patches.length, 2);
  await assert.rejects(restarted.stageWrite(stage.id, 'src/app.js', 'unexpected resume', sha256('preserved work')), code('RECOVERY_HOLD'));
  await assert.rejects(restarted.recoverStage('../outside'), code('STAGE'));
});

test('reviewer cannot consume review capacity to write implementation', async t => {
  const { boundary } = await fixture(t, { principal: { id: 'reviewer', role: 'reviewer' } });
  await assert.rejects(boundary.createStage([{ path: 'src/app.js' }]), code('ROLE'));
  await assert.rejects(boundary.stageWrite('x', 'src/app.js', 'oops', null), code('ROLE'));
});

test('stage writes enforce root scope, path exclusions and byte/population limits', async t => {
  const { boundary } = await fixture(t, { maxStageFiles: 2, maxStageBytes: 60 });
  const stage = await boundary.createStage([{ path: 'src/app.js' }]);
  await assert.rejects(boundary.stageWrite(stage.id, 'README.md', 'no', null), code('SCOPE'));
  await assert.rejects(boundary.stageWrite(stage.id, 'src/.env', 'no', null), code('SECRET'));
  await boundary.stageWrite(stage.id, 'src/new.js', 'new', null);
  await assert.rejects(boundary.stageWrite(stage.id, 'src/other.js', 'other', null), code('SIZE'));
  await assert.rejects(boundary.stageWrite(stage.id, 'src/new.js', 'a'.repeat(60), sha256('new')), code('SIZE'));
  await boundary.stageDelete(stage.id, 'src/new.js', sha256('new'));
  assert.equal((await boundary.stagePatch(stage.id)).patches.length, 0);
});

test('commands deny without trusted sandbox even when caller claims approval', async t => {
  const { root, dir } = await fixture(t);
  const executable = path.join(dir, 'fake-executable'); await fs.writeFile(executable, 'not executable');
  const boundary = new PermissionBoundary({ profile: 'C', roots: [{ path: root, write: ['src'] }], principal: { id: 'a', role: 'author' }, commands: [{ id: 'test', effect: 'test', executable, sha256: sha256('not executable'), args: [] }] }, { stageDirectory: dir });
  const stage = await boundary.createStage([{ path: 'src/app.js' }]);
  await assert.rejects(boundary.runApprovedTest(stage.id, 'test', { approved: true }), code('SANDBOX_UNAVAILABLE'));
  await assert.rejects(boundary.runApprovedTest(stage.id, 'rm -rf /', 'token'), code('COMMAND'));
  assert.throws(() => boundary.executeConsequential({ approved: true }), code('EXECUTION_GATE'));
});

test('trusted test adapter gets fixed argv and action-bound single-use approval', async t => {
  const { root, dir } = await fixture(t);
  const executable = path.join(dir, 'fake-executable'); await fs.writeFile(executable, 'fixture-only');
  let used = false, executed = 0, seen;
  const boundary = new PermissionBoundary({ profile: 'C', roots: [{ path: root, write: ['src'] }], principal: { id: 'a', role: 'author' }, commands: [{ id: 'test', effect: 'test', executable, sha256: sha256('fixture-only'), args: ['--check', 'src/app.js'] }] }, {
    stageDirectory: dir,
    attestIsolation: async () => ({ stageOnly: true, hostReadOnly: true, networkDenied: true, secretsRemoved: true, processTreeCleanup: true }),
    consumeApproval: async request => { seen = request; if (used || request.token !== 'single-use') return false; used = true; return true; },
    executeIsolated: async request => { executed++; assert.deepEqual(request.args, ['--check', 'src/app.js']); return { exitCode: 0, synthetic: true }; },
  });
  const stage = await boundary.createStage([{ path: 'src/app.js' }]);
  const result = await boundary.runApprovedTest(stage.id, 'test', 'single-use');
  assert.equal(executed, 1); assert.equal(result.actionHash, seen.actionHash);
  assert.equal(seen.action.sourceHash, stage.sourceHash);
  await assert.rejects(boundary.runApprovedTest(stage.id, 'test', 'single-use'), code('APPROVAL'));
  assert.equal(executed, 1);
});

test('changed executable and incomplete sandbox attestations fail closed', async t => {
  const { root, dir } = await fixture(t);
  const executable = path.join(dir, 'fake-executable'); await fs.writeFile(executable, 'changed');
  const configuration = { profile: 'C', roots: [{ path: root, write: ['src'] }], principal: { id: 'a', role: 'author' }, commands: [{ id: 'test', effect: 'test', executable, sha256: sha256('original'), args: [] }] };
  const dependencies = { stageDirectory: dir, executeIsolated: async () => assert.fail('must not execute'), consumeApproval: async () => assert.fail('must not approve'), attestIsolation: async () => ({ stageOnly: true, hostReadOnly: true, networkDenied: true, secretsRemoved: true, processTreeCleanup: true }) };
  const boundary = new PermissionBoundary(configuration, dependencies);
  const stage = await boundary.createStage([{ path: 'src/app.js' }]);
  await assert.rejects(boundary.runApprovedTest(stage.id, 'test', 'token'), code('COMMAND_CHANGED'));
  const missing = new PermissionBoundary(configuration, { ...dependencies, attestIsolation: async () => ({ stageOnly: true }) });
  const second = await missing.createStage([{ path: 'src/app.js' }]);
  await assert.rejects(missing.runApprovedTest(second.id, 'test', 'token'), code('SANDBOX_UNAVAILABLE'));
});
