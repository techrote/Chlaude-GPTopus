import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerTree, ownerCeilings, parseDelegation, attenuateBudget, ownsPath, createWorktree } from '../bridge/tree.mjs';

const grant = { maxConcurrent: 3, types: ['terra5-6free'], maxDepth: 1 };
const tree = (maxTotal = 6, extra = {}) => new WorkerTree({ ceilings: { maxDepth: 1, maxTotal, types: ['astra6free', 'terra5-6free'] }, ...extra });

test('delegation directive parses from a prompt and rejects garbage', () => {
  assert.deepEqual(parseDelegation("Lead it. delegation: {maxConcurrent: 3, types: ['terra5-6free'], maxDepth: 1}"), { maxConcurrent: 3, maxDepth: 1, types: ['terra5-6free'], budget: undefined });
  assert.equal(parseDelegation('no directive here'), null);
  assert.equal(parseDelegation('delegation: {maxConcurrent: -2}'), null);
});

test('no delegation unless granted; owner ceilings clamp the grant (a worker cannot grant itself more)', () => {
  const t = tree();
  const bare = t.addRoot({ type: 'astra6free' }).node;
  assert.equal(t.spawn(bare.id, { type: 'terra5-6free' }).reason, 'not_granted');
  const greedy = t.addRoot({ type: 'astra6free', grant: { maxConcurrent: 99, maxDepth: 9, types: ['terra5-6free', 'sol6-2'] } }).node;
  assert.deepEqual(greedy.grant, { maxConcurrent: 6, maxDepth: 1, types: ['terra5-6free'] });
  assert.equal(t.spawn(greedy.id, { type: 'sol6-2' }).reason, 'type_not_allowed');
});

test('child requesting more depth, types or budget than granted is refused with a reason', () => {
  const t = tree();
  const root = t.addRoot({ type: 'astra6free', grant, budget: { steps: 60, usd: 1 } }).node;
  const child = t.spawn(root.id, { type: 'terra5-6free', budget: { steps: 20 } });
  assert.equal(child.status, 'admitted');
  assert.equal(t.spawn(child.childId, { type: 'terra5-6free' }).reason, 'not_granted'); // depth-1 grant: children cannot delegate
  assert.equal(t.spawn(root.id, { type: 'terra5-6free', budget: { steps: 500 } }).reason, 'budget_exceeds_parent');
  assert.match(t.spawn(root.id, { type: 'terra5-6free', budget: { usd: 5 } }).detail, /exceeds the parent's remaining/);
  assert.equal(attenuateBudget({ steps: 10 }, { steps: 3 }).budget.steps, 3);
});

test('budgets attenuate and parent budgets cover their subtree', () => {
  const t = tree();
  const root = t.addRoot({ type: 'astra6free', grant, budget: { tokens: 1000 } }).node;
  const a = t.spawn(root.id, { type: 'terra5-6free', budget: { tokens: 600 } }).childId;
  t.charge(a, { tokens: 500, steps: 4 });
  assert.equal(t.remaining(root.id).tokens, 500);
  assert.equal(t.spawn(root.id, { type: 'terra5-6free', budget: { tokens: 600 } }).reason, 'budget_exceeds_parent');
  assert.equal(t.spawn(root.id, { type: 'terra5-6free', budget: { tokens: 400 } }).status, 'admitted');
});

test('global limit 6 with two roots granted 3 children: never more than 6 live, waiting parents count, extras queue then run', () => {
  const promoted = []; const t = tree(6, { onPromote: n => promoted.push(n.id) });
  const roots = [t.addRoot({ type: 'astra6free', grant }).node, t.addRoot({ type: 'astra6free', grant }).node];
  const results = [];
  for (const r of roots) { t.setWaiting(r.id, true); for (let i = 0; i < 3; i++) results.push(t.spawn(r.id, { type: 'terra5-6free' })); }
  assert.equal(t.liveCount(), 6, 'two waiting parents + four running children');
  assert.deepEqual(results.map(r => r.status), ['admitted', 'admitted', 'admitted', 'admitted', 'deferred', 'deferred']);
  assert.equal(results[4].reason, 'concurrency');
  for (let i = 0; i < 4; i++) { assert.ok(t.liveCount() <= 6); const running = [...t.nodes.values()].find(n => n.state === 'running' && n.parentId); if (running) t.finish(running.id, { summary: 'ok' }); }
  assert.equal(promoted.length, 2, 'queued children ran later');
  assert.ok(t.liveCount() <= 6);
});

test('a parent waiting on a queued child cannot deadlock the tree: the queued child is cancelled so the parent can do the work', () => {
  const t = tree(2);
  const root = t.addRoot({ type: 'astra6free', grant }).node;
  const other = t.addRoot({ type: 'astra6free', grant }).node;
  t.setWaiting(root.id, true); t.setWaiting(other.id, true);
  const r = t.spawn(root.id, { type: 'terra5-6free' });
  assert.deepEqual([r.status, r.reason], ['refused', 'concurrency']);
  assert.equal(t.get(r.childId).state, 'cancelled');
});

test('cancel of a root cascades to every descendant and drops queued spawns', () => {
  const cancelled = []; const t = tree(3, { onCancel: n => cancelled.push(n.id) });
  const root = t.addRoot({ type: 'astra6free', grant }).node;
  const a = t.spawn(root.id, { type: 'terra5-6free' }).childId, b = t.spawn(root.id, { type: 'terra5-6free' }).childId;
  const q = t.spawn(root.id, { type: 'terra5-6free' });
  assert.equal(q.status, 'deferred');
  const ids = t.cancel(root.id);
  assert.deepEqual(new Set(ids), new Set([root.id, a, b, q.childId]));
  assert.equal(t.liveCount(), 0); assert.equal(t.queue.length, 0);
  assert.equal(t.get(a).state, 'cancelled');
});

test('parent finishing cancels or orphans children per explicit policy', () => {
  const t = tree();
  const r1 = t.addRoot({ type: 'astra6free', grant }).node, c1 = t.spawn(r1.id, { type: 'terra5-6free' }).childId;
  t.finish(r1.id, { status: 'failed', reason: 'api_error' });
  assert.equal(t.get(c1).state, 'cancelled');
  const r2 = t.addRoot({ type: 'astra6free', grant }).node, c2 = t.spawn(r2.id, { type: 'terra5-6free' }).childId;
  t.finish(r2.id, { childPolicy: 'orphan' });
  assert.equal(t.get(c2).state, 'running');
});

test("file ownership denies writes outside a child's list", () => {
  const t = tree();
  const root = t.addRoot({ type: 'astra6free', grant }).node;
  const c = t.spawn(root.id, { type: 'terra5-6free', files: ['src/a.js'] }).childId;
  assert.equal(t.checkWrite(c, 'src/a.js', '/repo').allowed, true);
  assert.equal(t.checkWrite(c, 'src/b.js', '/repo').allowed, false);
  assert.equal(ownsPath(['src'], 'src/deep/x.js', '/repo'), true);
  assert.equal(ownsPath(['src'], 'src2/x.js', '/repo'), false);
  assert.equal(ownsPath([], 'anything', '/repo'), true);
});

test('reports are concise and structured; the tree summary totals equal the sum over nodes', () => {
  const t = tree();
  const root = t.addRoot({ type: 'astra6free', grant }).node;
  const kids = [1, 2, 3].map(() => t.spawn(root.id, { type: 'terra5-6free' }).childId);
  kids.forEach((k, i) => { t.charge(k, { tokens: 100 * (i + 1), usd: 0.01, steps: 3 }); t.finish(k, { summary: `done ${i}`, filesTouched: [`f${i}.js`], status: 'completed' }); });
  t.charge(root.id, { tokens: 50, steps: 2 });
  const rep = t.report(kids[0]);
  assert.deepEqual([rep.status, rep.summary, rep.files], ['completed', 'done 0', ['f0.js']]);
  assert.equal('transcript' in rep, false);
  const sum = t.treeSummary(root.id);
  assert.equal(sum.totals.tokens, 650); assert.equal(sum.totals.steps, 11);
  assert.equal(sum.totals.tokens, sum.nodes.reduce((n, x) => n + x.tokens, 0));
  assert.equal(t.cancel(kids[0]).length, 0, 'finished nodes are not re-cancelled');
});

test('ownerCeilings reads /oai:config values with safe defaults', () => {
  assert.deepEqual(ownerCeilings({}), { maxDepth: 1, maxTotal: 6, types: ['astra6free', 'terra5-6free'] });
  assert.equal(ownerCeilings({ OAI_DELEGATION_MAX_TOTAL: '12', OAI_DELEGATION_MAX_DEPTH: '2', OAI_DELEGATION_TYPES: 'terra5-6free' }).maxTotal, 12);
  assert.equal(ownerCeilings({ OAI_DELEGATION_MAX_TOTAL: 'x' }).maxTotal, 6);
});

test('git worktree isolation creates a branch per child', t => {
  const dir = mkdtempSync(join(tmpdir(), 'oai-wt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo'); execFileSync('git', ['init', repo], { stdio: 'pipe' });
  writeFileSync(join(repo, 'a.txt'), 'x');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'pipe' });
  git('add', '.'); git('commit', '-m', 'init');
  const wt = createWorktree({ cwd: repo, rootId: 'root1', childId: 'w2' });
  assert.equal(wt.branch, 'oai/root1-w2'); assert.ok(existsSync(join(wt.path, 'a.txt')));
});
