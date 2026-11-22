// REQ-01 / F3: the owner-facing production routes for the required-test manifest.
//
// High-, critical- and unknown-impact work can only reach code_approved with a registered plan and executed (or, where the
// owner allows it, owner-attested) evidence, or a waiver of a non-executable test. These tests prove those routes exist in
// production code and nowhere else: every state change below is made by the real `ultra/cli.mjs` main() function (typing the
// confirmation phrase on a terminal), the real ReviewController, the real execution ledger and, for run-test, a real child
// process. Only the review MODELS are absent: reviewers are genuine broker allocations whose reports are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, rm, writeFile, realpath, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionStore, digest } from '../ultra/store.mjs';
import { RecruitmentBroker } from '../ultra/broker.mjs';
import { ReviewController } from '../ultra/review.mjs';
import { resolveConfig } from '../ultra/config.mjs';
import { writeOwnerConfig, ownerPaths } from '../ultra/service.mjs';
import { main as cli } from '../ultra/cli.mjs';
import { ULTRA_NATIVE_SPECS } from '../hooks/ultra.js';
import { resolveExecutable, minimalEnvironment, commandSpec, runCommand, evidenceDetails } from '../scripts/ultra-test-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_RISK = { complexity: 'low', verifiability: 'high', confidence: 1, rationale: 'Synthetic fixture.', blastRadius: 'local', reversibility: 'reversible', testsAvailable: true, independentEvidence: true };
const RISK = { high: { ...BASE_RISK, impact: 'high', destructive: true }, critical: { ...BASE_RISK, impact: 'critical', destructive: true }, low: { ...BASE_RISK, impact: 'low' }, medium: { ...BASE_RISK, impact: 'medium' } };
const NODE = process.execPath;
const OWNER = { trusted: true, source: 'local-user', authority: 'user' };

async function fixture(t, { impact = 'high', policy = {} } = {}) {
  const dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-owner-tests-')));
  const project = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-owner-project-')));
  t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(project, { recursive: true, force: true })]));
  const env = { OPENAI_ULTRA_STATE_DIR: dir, OPENAI_ULTRA_CONFIG: join(dir, 'ultra-policy.json'), OPENAI_WORKER_USAGE_DIR: join(dir, 'usage'), PATH: process.env.PATH, ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }) };
  const config = resolveConfig({ enabled: true, permissions: { tools: [], roots: [project] }, risk: { uncertainAuthority: 'user' }, ...policy });
  await writeOwnerConfig(config, env);
  const store = new ExecutionStore(ownerPaths(env).ledger), broker = new RecruitmentBroker(store, { config });
  const mission = await broker.createMission({ id: 'owner_tests', task: 'Synthetic required-test routes', orchestrator: { model: 'opus', trusted: true, source: 'test-host' } });
  const f = { dir, project, env, config, store, broker, mid: mission.id, reviews: new ReviewController(broker), impact };
  const request = await broker.request(f.mid, 'root', { worker: 'luna', role: 'implementation', task: 'Author the synthetic change', risk: RISK[impact] }, 'author');
  f.author = request.nodeId; await complete(f, f.author);
  await writeFile(join(dir, 'source.json'), JSON.stringify({ id: 'change.js', content: 'export const change = 1;\n' }));
  await writeFile(join(dir, 'risk.json'), JSON.stringify(RISK[impact]));
  // The production CLI starts the review exactly as the production adapters do: no plan and no principal.
  const printed = []; await cli(['review', f.mid, f.author, join(dir, 'source.json'), join(dir, 'risk.json')], { env, print: v => printed.push(v) });
  f.wid = printed[0].id;
  return f;
}
async function complete(f, nodeId) {
  const node = await f.broker.claim(f.mid, 'owner-tests-fixture', { nodeId });
  assert.ok(node, `agent ${nodeId} must be claimable`);
  await f.broker.finish(f.mid, nodeId, { result: { text: 'fixture' }, usage: { tokens: 10, usd: 0.0001 }, lease: node.lease.token });
}
const workflow = async f => (await f.store.snapshot(f.mid)).workflows[f.wid];
async function stage(f) {
  const assigned = await f.reviews.assign(f.mid, f.wid);
  for (const a of assigned) {
    let nodeId = a.nodeId;
    if (!nodeId) { await f.broker.decide(f.mid, a.requestId, { decision: 'APPROVE', rationale: 'Owner approves this synthetic review allocation.' }, OWNER); nodeId = (await f.store.snapshot(f.mid)).requests[a.requestId].nodeId; }
    await complete(f, nodeId);
    await f.reviews.submit(f.mid, f.wid, nodeId, a.sourceHash, { findings: [], coverage: [{ area: 'all', status: 'examined' }] });
  }
  return workflow(f);
}
async function toAdjudication(f) { let w = await workflow(f); for (let i = 0; i < 5 && w.status !== 'adjudication'; i++) w = await stage(f); assert.equal(w.status, 'adjudication'); return w; }
const judge = f => stage(f);

/** A real interactive-terminal stand-in: both streams report isTTY, and the owner "types" the phrase the prompt asks for. */
function terminal({ answer = phrase => phrase, tty = true } = {}) {
  const input = Object.assign(new PassThrough(), { isTTY: tty }), output = Object.assign(new PassThrough(), { isTTY: tty });
  const session = { input, output, transcript: '', phrase: null, prompted: false };
  output.on('data', async chunk => {
    session.transcript += chunk;
    const found = /Type (APPROVE [0-9a-f]+) to approve/.exec(session.transcript);
    if (found && !session.prompted) { session.prompted = true; session.phrase = found[1]; const typed = await answer(found[1], session); input.write(`${typed}\n`); }
  });
  return session;
}
async function run(f, argv, { answer, tty, env } = {}) {
  const io = terminal({ answer, tty }), printed = []; let error = null;
  try { await cli(argv, { env: env ?? f.env, io, print: v => printed.push(v) }); } catch (e) { error = e; }
  return { printed, error, transcript: io.transcript, io, last: printed.at(-1) };
}
const file = async (f, name, value) => { const path = join(f.dir, name); await writeFile(path, JSON.stringify(value)); return path; };
const ledgerRevision = async f => (await f.store.read()).revision;
const status = async f => (await run(f, ['test-status', f.mid, f.wid])).last;
const exit = code => ['--', NODE, '-e', `process.exit(${code})`];

test('REQ-01: high-impact work reaches code_approved only through the owner CLI: plan-add, then run-test (executed evidence), then re-adjudication', async t => {
  const f = await fixture(t);
  await toAdjudication(f);
  // Exactly what production produces today: no plan, no evidence. The hold names the route.
  let w = await judge(f);
  assert.equal(w.status, 'held'); assert.equal(w.requiredTests.mode, 'unplanned');
  assert.match(w.reason, /plan-add/);
  const before = await status(f);
  assert.ok(before.next.some(line => /plan-add/.test(line)), `test-status tells the owner what to do: ${before.next.join(' | ')}`);

  // 1. Register the plan. The owner sees the exact entries and the plan hash before and after, and confirms.
  const planFile = await file(f, 'plan.json', { entries: [{ id: 'unit:scope', description: 'Scope unit tests' }] });
  const added = await run(f, ['plan-add', f.mid, f.wid, planFile]);
  assert.equal(added.error, null, added.error?.message);
  assert.ok(added.transcript.includes(before.plan.hash) && added.transcript.includes('unit:scope') && /planHashAfter/.test(added.transcript), 'the displayed record names the exact plan hash and entry');
  assert.equal(added.last.registered[0], 'unit:scope');
  w = await workflow(f);
  assert.equal(w.testPlan.history.at(-1).principal.source, 'local-user'); assert.deepEqual(w.testPlan.entries.map(e => e.id), ['unit:scope']);
  assert.equal(w.requiredTests.mode, 'manifest'); assert.equal(w.requiredTests.state, 'missing');

  // 2. An owner-attested record is stored but is NOT accepted at high impact; the owner is warned before confirming.
  const attested = await run(f, ['record-test', f.mid, f.wid, await file(f, 'attested.json', { name: 'unit:scope', testId: 'unit:scope', passed: true, details: 'I ran it by hand' })]);
  assert.match(attested.transcript, /WARNING: owner-attested records are NOT accepted at high impact/);
  assert.equal(attested.last.provenance, 'owner-attested'); assert.equal(attested.last.gate.accepted, false);
  assert.equal((await workflow(f)).requiredTests.state, 'missing', 'it did not satisfy the test');

  // 3. run-test: a real child process; the evidence is executed by principal test-runner, bound to this source and plan.
  const ran = await run(f, ['run-test', f.mid, f.wid, 'unit:scope', '--root', f.project, ...exit(0)]);
  assert.equal(ran.error, null, ran.error?.message);
  assert.deepEqual([ran.last.provenance, ran.last.passed, ran.last.exitCode], ['executed', true, 0]);
  w = await workflow(f);
  const evidence = w.tests.find(x => x.provenance === 'executed');
  assert.equal(evidence.principal.source, 'test-runner'); assert.equal(evidence.attestation.qualification, 'trusted-executor');
  assert.equal(evidence.sourceHash, w.source.hash); assert.equal(evidence.planHash, w.requiredTests.planHash);
  assert.match(ran.transcript, new RegExp(evidence.attestation.commandDigest), 'the digest the owner confirmed is the digest that was attested');
  assert.match(ran.transcript, /not sandboxed|does not verify|cannot verify/i);
  assert.equal(w.requiredTests.state, 'satisfied');
  assert.equal(w.status, 'adjudication', 'complete evidence re-opens adjudication once');

  // 4. The judge approves; the approval record carries what it rested on.
  w = await judge(f);
  assert.equal(w.status, 'code_approved');
  assert.equal(w.approval.requiredTests.tests[0].state, 'satisfied');
  assert.equal(w.approval.planHash, w.requiredTests.planHash);
});

test('REQ-01: a non-executable required test is satisfied only by the owner waiver CLI, with a rationale bound to source and plan', async t => {
  const f = await fixture(t, { policy: { review: { requiredTests: [{ id: 'manual:ui', description: 'Manual UI pass', executable: false }] } } });
  await toAdjudication(f);
  let w = await judge(f);
  assert.equal(w.status, 'held'); assert.match(w.reason, /missing \[manual:ui\]/);
  assert.ok((await status(f)).next.some(line => /manual:ui.*waive-test/.test(line)));
  // Executable-only routes cannot satisfy it.
  const refused = await run(f, ['run-test', f.mid, f.wid, 'manual:ui', '--root', f.project, ...exit(0)]);
  assert.match(refused.error.message, /not executable/);
  const revision = await ledgerRevision(f);
  const bare = await run(f, ['waive-test', f.mid, f.wid, await file(f, 'w0.json', { testId: 'manual:ui', rationale: '   ' })]);
  assert.match(bare.error.message, /rationale/); assert.equal(await ledgerRevision(f), revision);
  const done = await run(f, ['waive-test', f.mid, f.wid, await file(f, 'w1.json', { testId: 'manual:ui', rationale: 'Verified by hand on Windows 11 build 26300.' })]);
  assert.equal(done.error, null, done.error?.message);
  assert.match(done.transcript, /Windows 11 build 26300/); assert.ok(done.transcript.includes((await workflow(f)).source.hash), 'the displayed record binds the source hash');
  w = await workflow(f);
  assert.equal(w.waivers[0].principal.source, 'local-user'); assert.equal(w.requiredTests.state, 'waived'); assert.equal(w.status, 'adjudication');
  w = await judge(f);
  assert.equal(w.status, 'code_approved'); assert.match(w.approval.waivers[0].rationale, /Windows 11/);
});

test('REQ-01: critical-impact waivers are refused unless owner policy allows them; an executable test cannot be waived', async t => {
  const policy = { review: { requiredTests: [{ id: 'manual:ui', executable: false }, { id: 'unit:x' }] } };
  const strict = await fixture(t, { impact: 'critical', policy });
  const revision = await ledgerRevision(strict);
  const one = await run(strict, ['waive-test', strict.mid, strict.wid, await file(strict, 'w.json', { testId: 'manual:ui', rationale: 'because' })]);
  assert.match(one.error.message, /critical-impact/); assert.equal(one.io.prompted, false, 'refused before any prompt');
  const two = await run(strict, ['waive-test', strict.mid, strict.wid, await file(strict, 'w2.json', { testId: 'unit:x', rationale: 'because' })]);
  assert.match(two.error.message, /executable/);
  assert.equal(await ledgerRevision(strict), revision);
  const lenient = await fixture(t, { impact: 'critical', policy: { ...policy, review: { ...policy.review, allowCriticalWaivers: true } } });
  const ok = await run(lenient, ['waive-test', lenient.mid, lenient.wid, await file(lenient, 'w.json', { testId: 'manual:ui', rationale: 'Owner accepts the residual risk for the synthetic fixture.' })]);
  assert.equal(ok.error, null, ok.error?.message);
});

test('REQ-01: every state-changing command is a human gesture: no terminal, a wrong phrase or a changed plan records nothing', async t => {
  const f = await fixture(t);
  await toAdjudication(f); await judge(f);
  const planFile = await file(f, 'plan.json', [{ id: 'unit:scope' }]), evidence = await file(f, 'e.json', { name: 'unit:scope', passed: true, details: 'x' });
  const revision = await ledgerRevision(f);
  for (const argv of [['plan-add', f.mid, f.wid, planFile], ['record-test', f.mid, f.wid, evidence], ['run-test', f.mid, f.wid, 'unit:scope', '--root', f.project, ...exit(0)], ['waive-test', f.mid, f.wid, await file(f, 'w.json', { testId: 'unit:scope', rationale: 'r' })]]) {
    const piped = await run(f, argv, { tty: false });
    assert.match(piped.error?.message ?? 'ACCEPTED', /interactive local terminal|not executable|Unknown|not a required/, `${argv[0]} without a terminal`);
    const wrong = await run(f, argv, { answer: () => 'yes' });
    assert.ok(wrong.error, `${argv[0]} with a wrong phrase must not proceed`);
    assert.equal(await ledgerRevision(f), revision, `${argv[0]} left the ledger untouched`);
  }
  // The plan changes between display and confirmation (a reviewer-style addition): the confirmation no longer binds, nothing is added.
  const racing = await run(f, ['plan-add', f.mid, f.wid, planFile], { answer: async phrase => { await f.reviews.addRequiredTests(f.mid, f.wid, [{ id: 'other:late' }], OWNER); return phrase; } });
  assert.match(racing.error.message, /changed after it was displayed/);
  assert.deepEqual((await workflow(f)).testPlan.entries.map(e => e.id), ['other:late'], 'only the concurrent change landed');
});

test('REQ-01: the runner is bounded: approved root, no shell, minimal environment, timeout that kills the tree, output cap, pinned digest', async t => {
  const f = await fixture(t, { policy: { review: { requiredTests: [{ id: 'unit:a' }] } } });
  await toAdjudication(f); await judge(f);
  const outside = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-outside-'))); t.after(() => rm(outside, { recursive: true, force: true }));
  const go = (argv, options) => run(f, ['run-test', f.mid, f.wid, 'unit:a', ...argv], options);
  const revision = await ledgerRevision(f);

  // Working directory limits.
  assert.match((await go(['--root', outside, ...exit(0)])).error.message, /approved project roots/);
  assert.match((await go(['--root', f.project, '--cwd', '..', ...exit(0)])).error.message, /relative path|\.\./);
  assert.match((await go(['--root', f.project, '--cwd', 'no/such', ...exit(0)])).error.message, /does not exist/);
  assert.match((await go(['--root', 'relative/root', ...exit(0)])).error.message, /absolute project root/);
  await mkdir(join(f.project, 'sub')); await symlink(outside, join(f.project, 'link'), process.platform === 'win32' ? 'junction' : 'dir').then(async () => {
    assert.match((await go(['--root', f.project, '--cwd', 'link', ...exit(0)])).error.message, /outside the approved project root/);
  }, () => { /* link creation is not permitted here */ });
  // Program resolution: a relative program is refused; so are shell wrappers' metacharacters being treated as data (below).
  assert.match((await go(['--root', f.project, '--', './planted', 'x'])).error.message, /absolute path/);
  assert.match((await go(['--root', f.project, '--', join(f.project, 'missing-program')])).error.message, /not found|not executable/);
  assert.equal(await ledgerRevision(f), revision, 'every refusal happened before the prompt');

  // No shell: metacharacters in an argument arrive verbatim.
  const hostile = 'a b; echo pwned $(whoami) `x` "q" | & > out.txt';
  const echoed = await go(['--root', f.project, '--', NODE, '-e', 'process.stdout.write(process.argv[1])', hostile]);
  assert.equal(echoed.error, null, echoed.error?.message);
  assert.ok((await workflow(f)).tests.at(-1).details.includes(`\n${hostile}`), 'the argument was passed as one literal argument');
  assert.deepEqual((await readdir(f.project)).filter(name => name === 'out.txt'), []);

  // Minimal environment: no API key, no ULTRA variable, no arbitrary variable reaches the child.
  const leaking = { ...f.env, OPENAI_API_KEY: 'sk-secret-never-forward', OPENAI_ULTRA_ENABLED: '1', ANTHROPIC_API_KEY: 'sk-ant-never', FOO_TOKEN: 'never' };
  const probe = await go(['--root', f.project, '--', NODE, '-e', 'process.stdout.write(Object.keys(process.env).join(","))'], { env: leaking });
  const keys = (await workflow(f)).tests.at(-1).details.split('--- output (tail) ---\n')[1].split(',');
  assert.equal(probe.error, null, probe.error?.message);
  assert.ok(keys.includes('PATH') || keys.some(k => /^path$/i.test(k)));
  assert.deepEqual(keys.filter(k => /OPENAI|ANTHROPIC|FOO|ULTRA|KEY|TOKEN/i.test(k)), []);
  assert.deepEqual(Object.keys(minimalEnvironment(leaking)).filter(k => /OPENAI|ANTHROPIC|FOO/.test(k)), []);

  // Non-zero exit is recorded as a FAILING result with its exit code.
  const failed = await go(['--root', f.project, ...exit(3)]);
  assert.equal(failed.error, null); assert.deepEqual([failed.last.passed, failed.last.exitCode], [false, 3]);
  assert.equal((await workflow(f)).requiredTests.tests[0].state === 'contradictory' || (await workflow(f)).requiredTests.tests[0].state === 'failing', true);

  // A command that cannot start records nothing at all.
  const count = (await workflow(f)).tests.length;
  const absent = join(f.project, process.platform === 'win32' ? 'gone.exe' : 'gone');
  await writeFile(absent, ''); // present but not executable / not a program
  const broken = await go(['--root', f.project, '--', absent]);
  assert.ok(broken.error, 'an unusable program is an error'); assert.equal((await workflow(f)).tests.length, count);
});

test('REQ-01: a timeout kills the whole process tree and is recorded as a failure; output is capped and the tail is kept', async t => {
  const f = await fixture(t, { policy: { review: { requiredTests: [{ id: 'unit:a' }] } } });
  const noisy = await run(f, ['run-test', f.mid, f.wid, 'unit:a', '--root', f.project, '--max-output-bytes', '4096', '--', NODE, '-e', "process.stdout.write('x'.repeat(3000000)); console.log('\\nTAIL-MARKER')"]);
  assert.equal(noisy.error, null, noisy.error?.message);
  const details = (await workflow(f)).tests.at(-1).details;
  assert.ok(details.length <= 20000 && /only the last \d+ retained/.test(details) && details.includes('TAIL-MARKER'), 'bounded evidence that keeps the end of the output');
  assert.match(details, /3000\d{3} bytes produced/);

  // A grandchild that outlives its parent must die with it. The child prints its own and the grandchild's pid first.
  const program = "const { spawn } = require('node:child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); console.log('PIDS ' + process.pid + ' ' + g.pid); setInterval(()=>{},1000);";
  const slow = await run(f, ['run-test', f.mid, f.wid, 'unit:a', '--root', f.project, '--timeout-ms', '1500', '--', NODE, '-e', program]);
  assert.equal(slow.error, null, slow.error?.message);
  assert.deepEqual([slow.last.passed, slow.last.exitCode, slow.last.timedOut], [false, 124, true]);
  const written = (await workflow(f)).tests.at(-1).details;
  assert.match(written, /killed after 1500 ms timeout/);
  const [, parent, grandchild] = /PIDS (\d+) (\d+)/.exec(written) ?? [];
  assert.ok(parent && grandchild, `the child reported its pids: ${written.slice(-200)}`);
  const alive = pid => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && (alive(parent) || alive(grandchild)); i++) await new Promise(done => setTimeout(done, 100));
  assert.deepEqual([alive(parent), alive(grandchild)], [false, false], 'neither the command nor its descendant survived the timeout');
});

test('REQ-01: a plan entry can pin a command digest (test-digest names it); only exactly that command counts', async t => {
  const f = await fixture(t);
  const digestFor = async (fx, code) => (await run(fx, ['test-digest', '--root', fx.project, '--', NODE, '-e', `process.exit(${code})`])).last.commandDigest;
  const mine = await digestFor(f, 0);
  // Register a plan entry that pins this exact command through the CLI (plan-add), then run the same and a different command.
  await toAdjudication(f); await judge(f);
  const plan = await run(f, ['plan-add', f.mid, f.wid, await file(f, 'plan.json', [{ id: 'unit:pinned', commandDigest: mine }])]);
  assert.equal(plan.error, null, plan.error?.message);
  assert.match((await run(f, ['run-test', f.mid, f.wid, 'unit:pinned', '--root', f.project, ...exit(1)])).error.message, /pins a different command digest/);
  const good = await run(f, ['run-test', f.mid, f.wid, 'unit:pinned', '--root', f.project, ...exit(0)]);
  assert.equal(good.error, null, good.error?.message);
  assert.equal((await workflow(f)).requiredTests.state, 'satisfied');
});

test('REQ-01: unchanged semantics: owner-attested evidence still satisfies low and medium impact, and the owner can widen the tier explicitly', async t => {
  for (const impact of ['low', 'medium']) {
    const f = await fixture(t, { impact, policy: { review: { requiredTests: [{ id: 'unit:a' }] } } });
    await toAdjudication(f);
    const recorded = await run(f, ['record-test', f.mid, f.wid, await file(f, 'e.json', { name: 'unit:a', testId: 'unit:a', passed: true, details: 'ran by hand' })]);
    assert.doesNotMatch(recorded.transcript, /WARNING/); assert.equal(recorded.last.gate.accepted, true, impact);
  }
  const widened = await fixture(t, { impact: 'high', policy: { review: { requiredTests: [{ id: 'unit:a' }], ownerAttestedImpacts: ['low', 'medium', 'high'] } } });
  await toAdjudication(widened);
  assert.equal((await run(widened, ['record-test', widened.mid, widened.wid, await file(widened, 'e.json', { name: 'unit:a', passed: true, details: 'by hand' })])).last.gate.accepted, true);
});

// ---- The runner module itself ----

test('runner: programs resolve only from absolute PATH entries; a name planted in the working directory is never chosen', async t => {
  const dir = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-resolve-'))); t.after(() => rm(dir, { recursive: true, force: true }));
  const windows = process.platform === 'win32', name = windows ? 'planted-tool.exe' : 'planted-tool';
  await writeFile(join(dir, name), windows ? 'MZ' : '#!/bin/sh\necho planted\n', { mode: 0o755 });
  const previous = process.cwd();
  try {
    process.chdir(dir);
    assert.throws(() => resolveExecutable('planted-tool', { PATH: '.' }), /not found/, 'a relative PATH entry is ignored');
    assert.throws(() => resolveExecutable('planted-tool', { PATH: '' }), /not found/, 'the working directory is not searched');
    assert.throws(() => resolveExecutable(`.${windows ? '\\' : '/'}planted-tool`, { PATH: dir }), /absolute path/);
    assert.throws(() => resolveExecutable(`sub/planted-tool`, { PATH: dir }), /absolute path/);
    assert.equal(resolveExecutable('planted-tool', { PATH: `.${delimiter}${dir}` }), join(dir, name), 'only the absolute entry is used');
    assert.equal(resolveExecutable(join(dir, name), {}), join(dir, name));
  } finally { process.chdir(previous); }
  assert.throws(() => resolveExecutable('tool.cmd', { PATH: dir }, { platform: 'win32' }), /needs a shell/);
  assert.throws(() => resolveExecutable('x.BAT', {}, { platform: 'win32' }), /needs a shell/);
  assert.throws(() => resolveExecutable('', {}), /non-empty/);
});

test('runner: command declarations are validated strictly and the digest is bound to argv, root and subdirectory', async t => {
  const project = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'ultra-spec-'))); t.after(() => rm(project, { recursive: true, force: true }));
  await mkdir(join(project, 'pkg'));
  const env = { PATH: process.env.PATH, ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }) }, good = { argv: [NODE, '-e', '1'], root: project };
  const spec = await commandSpec(good, { approvedRoots: [project], env });
  assert.deepEqual([spec.timeoutMs, spec.cwdRelative, spec.root], [120000, '.', project]);
  assert.notEqual((await commandSpec({ ...good, cwd: 'pkg' }, { approvedRoots: [project], env })).digest, spec.digest);
  assert.notEqual((await commandSpec({ ...good, argv: [NODE, '-e', '2'] }, { approvedRoots: [project], env })).digest, spec.digest);
  for (const bad of [{ argv: 'node --test' }, { argv: [] }, { argv: [NODE, 7] }, { argv: [NODE, 'a\0b'] }, { argv: Array(65).fill('x') }, { ...good, shell: true }, { ...good, timeoutMs: 0 }, { ...good, timeoutMs: 3_600_001 },
    { ...good, maxOutputBytes: 1.5 }, { ...good, cwd: '/abs' }, { ...good, cwd: 'a\\b' }, { ...good, cwd: 'a/../b' }, { ...good, root: 'rel' }, null, []]) {
    await assert.rejects(() => commandSpec(bad === null || Array.isArray(bad) ? bad : { ...good, ...bad }, { approvedRoots: [project], env }), /./, JSON.stringify(bad));
  }
  await assert.rejects(() => commandSpec(good, { approvedRoots: [], env }), /approved project roots/);
  const result = await runCommand(await commandSpec({ argv: [NODE, '-e', 'console.error("err-line"); console.log("out-line"); process.exit(5)'], root: project }, { approvedRoots: [project], env }), { env });
  assert.deepEqual([result.exitCode, result.timedOut, result.truncated], [5, false, false]);
  assert.match(result.output, /err-line/); assert.match(result.output, /out-line/);
  assert.match(evidenceDetails(spec, result), /exit code: 5/);
  assert.ok(evidenceDetails(spec, { ...result, output: 'y'.repeat(100000) }).length <= 19000);
});

// ---- Reachability: owner CLI only ----

test('reachability: no MCP tool, native tool, hook or bridge path can plan, waive, record or run tests; the test-runner principal is created in one place', async () => {
  const { readFile, readdir: list } = await import('node:fs/promises');
  const names = Object.keys(ULTRA_NATIVE_SPECS).join(' ');
  assert.doesNotMatch(names, /plan|waive|record_test|run_test|required_test|test_runner/i, 'the native tool list exposes no such operation');
  const sources = [];
  for (const dir of ['bridge', 'hooks', 'ultra', 'scripts']) for (const entry of await list(join(root, dir))) if (/\.(mjs|js)$/.test(entry)) sources.push([`${dir}/${entry}`, await readFile(join(root, dir, entry), 'utf8')]);
  const creators = sources.filter(([, text]) => /source:\s*'test-runner'/.test(text)).map(([name]) => name);
  assert.deepEqual(creators, ['ultra/owner-tests.mjs'], 'only the owner CLI module builds a test-runner principal');
  for (const [name, text] of sources) {
    if (/^(bridge|hooks)\//.test(name)) assert.ok(!/owner-tests|ultra-test-runner|child_process/.test(text.replace(/^import \{ execFileSync \} from 'node:child_process';$/m, '')), `${name} must not reach the owner test routes`);
  }
  const importers = sources.filter(([, text]) => /from '\.\/owner-tests\.mjs'|owner-tests\.mjs/.test(text)).map(([name]) => name);
  assert.deepEqual(importers, ['ultra/cli.mjs']);
  const runnerUsers = sources.filter(([name, text]) => name !== 'scripts/ultra-test-runner.mjs' && /ultra-test-runner/.test(text)).map(([name]) => name);
  assert.deepEqual(runnerUsers, ['ultra/owner-tests.mjs'], 'the process-spawning executor is imported by the owner test module only (and dynamically)');
  const desktop = await readFile(join(root, '..', '..', 'scripts', 'build-desktop.mjs'), 'utf8');
  assert.ok(!/ultra-test-runner/.test(desktop), 'the executor is not part of the Desktop bundle inputs');
});
