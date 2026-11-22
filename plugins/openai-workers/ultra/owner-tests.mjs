/**
 * Owner entry points for the required-test manifest: the production routes by which
 * high-, critical- and unknown-impact work can ever reach `code_approved`.
 *
 *   test-status   MISSION WORKFLOW                     read-only: what is required, what is missing, what to do next
 *   test-digest   --root ROOT [--cwd REL] -- ARGV...   read-only: the digest a required test can pin for that command
 *   plan-add      MISSION WORKFLOW plan.json            register / extend the verification plan
 *   waive-test    MISSION WORKFLOW waiver.json          waive a NON-executable required test with a rationale
 *   record-test   MISSION WORKFLOW evidence.json        owner-attested evidence (accepted only at tiers the owner allows)
 *   run-test      MISSION WORKFLOW TEST_ID --root ROOT [--cwd REL] [--timeout-ms N] [--max-output-bytes N] -- ARGV...
 *                                                      RUN the owner-typed command and record EXECUTED evidence
 *
 * Every state-changing command is a human gesture: it needs a real interactive terminal, prints the exact record
 * (including its digest and the plan hash it binds), and proceeds only if the owner types the confirmation phrase.
 * None of this is reachable from an MCP tool, the native mod or a model: this module is imported only by
 * ultra/cli.mjs, and the process-spawning executor lives in scripts/ultra-test-runner.mjs, outside the Desktop bundle.
 * The principal `test-runner` is created here and nowhere else.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digest, invariant } from './store.mjs';

export const OWNER_TEST_COMMANDS = Object.freeze(['test-status', 'test-digest', 'plan-add', 'waive-test', 'record-test', 'run-test']);
const OWNER = Object.freeze({ source: 'local-user', trusted: true, authority: 'user' });
const readJson = async file => JSON.parse(await readFile(resolve(file), 'utf8'));
/** A short confirmation id derived from the exact record, so the phrase the owner types is bound to what was displayed. */
const confirmable = (operation, body) => { const full = digest({ operation, ...body }); return { id: full.slice(0, 16), digest: full, operation, ...body }; };

function summary(gate) {
  return { mode: gate.mode, state: gate.state, accepted: gate.accepted, reason: gate.reason, planHash: gate.planHash,
    tests: gate.tests.map(({ id, state, executable, origin, detail }) => ({ id, state, executable, origin, ...(detail && { detail }) })) };
}
function nextSteps(view) {
  const steps = [], { gate } = view;
  if (gate.mode === 'unplanned') steps.push('No required tests are designated for work whose risk demands them: register a plan with plan-add (or list review.requiredTests in owner policy).');
  for (const test of gate.tests) {
    if (['satisfied', 'waived'].includes(test.state)) continue;
    if (test.state === 'missing') steps.push(test.executable
      ? `${test.id}: run it with run-test${view.ownerAttestedAccepted ? ', or record an owner-attested result with record-test' : ` (owner-attested records are not accepted at ${view.impact} impact; review.ownerAttestedImpacts is [${view.ownerAttestedImpacts.join(', ')}])`}.`
      : `${test.id}: cannot be run; the owner may waive it with waive-test and a rationale${view.impact === 'critical' && !view.criticalWaiversAllowed ? ' (refused at critical impact unless review.allowCriticalWaivers is true)' : ''}.`);
    else if (test.state === 'failing') steps.push(`${test.id}: failing. Fix the source (a changed source needs a new review) or record superseding evidence.`);
    else if (test.state === 'contradictory') steps.push(`${test.id}: contradictory evidence (a failure beside an eligible pass). Record evidence that names the superseded record ids and a reason.`);
  }
  if (!steps.length && gate.accepted) steps.push('The required-test gate is satisfied.');
  return steps;
}

/** Split `a b --root X -- cmd args` into positionals, known options and the argv after `--`. */
function split(args, { options = [], needArgv = false } = {}) {
  const positional = [], flags = {}; let argv = null;
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (item === '--') { argv = args.slice(i + 1); break; }
    const eq = /^--([a-z-]+)=(.*)$/.exec(item), name = eq ? eq[1] : item.startsWith('--') ? item.slice(2) : null;
    if (name === null) { positional.push(item); continue; }
    invariant(options.includes(name), `Unknown option --${name}`);
    invariant(!Object.hasOwn(flags, name), `Specify --${name} once`);
    if (eq) flags[name] = eq[2]; else { invariant(i + 1 < args.length, `--${name} needs a value`); flags[name] = args[++i]; }
  }
  invariant(!needArgv || argv?.length, 'The command to run goes after "--" as separate arguments, for example: -- node --test');
  invariant(needArgv || argv === null, 'Unexpected "--" arguments');
  return { positional, flags, argv };
}
const integer = (value, name) => { if (value === undefined) return undefined; invariant(/^[0-9]{1,9}$/.test(value), `${name} must be a whole number`); return Number(value); };

async function declared(flags, argv, { service, env }, runner) {
  invariant(flags.root, 'A command needs --root ABSOLUTE_PROJECT_ROOT (one of the policy permissions.roots)');
  return runner.commandSpec({ argv, root: flags.root, ...(flags.cwd !== undefined && { cwd: flags.cwd }), ...(flags['timeout-ms'] !== undefined && { timeoutMs: integer(flags['timeout-ms'], '--timeout-ms') }),
    ...(flags['max-output-bytes'] !== undefined && { maxOutputBytes: integer(flags['max-output-bytes'], '--max-output-bytes') }) }, { approvedRoots: service.config.permissions.roots, env });
}

/** `ctx`: { service, env, print, approve(record, kind) -> boolean }. `runner`: loaded lazily, only by run-test and test-digest. */
export async function ownerTestCommand(command, args, ctx) {
  const { service, env, print, approve } = ctx, reviews = service.runtime.reviews;
  const loadRunner = () => import('../scripts/ultra-test-runner.mjs');

  if (command === 'test-status') {
    invariant(args.length === 2, 'test-status requires a mission ID and a workflow ID');
    const view = await reviews.inspect(args[0], args[1]);
    print({ ...view, next: nextSteps(view) }); return;
  }

  if (command === 'test-digest') {
    const { flags, argv } = split(args, { options: ['root', 'cwd', 'timeout-ms', 'max-output-bytes'], needArgv: true });
    const spec = await declared(flags, argv, ctx, await loadRunner());
    print({ commandDigest: spec.digest, argv: spec.argv, program: spec.program, root: spec.root, cwd: spec.cwdRelative, timeoutMs: spec.timeoutMs, maxOutputBytes: spec.maxOutputBytes,
      note: 'Pin this digest in a required test (review.requiredTests[].commandDigest or a plan entry) so only exactly this command counts as executed evidence.' }); return;
  }

  if (command === 'plan-add') {
    invariant(args.length === 3, 'plan-add requires a mission ID, a workflow ID and a JSON file ([{ id, description?, executable?, commandDigest? }] or { "entries": [...] })');
    const file = await readJson(args[2]), entries = Array.isArray(file) ? file : file?.entries;
    invariant(Array.isArray(entries), 'The plan file must be an array of required tests or { "entries": [...] }');
    const preview = await reviews.previewRequiredTests(args[0], args[1], entries);
    if (preview.unchanged) { print({ unchanged: true, planHash: preview.planHashBefore, note: 'Every listed test is already required exactly as defined.' }); return; }
    const record = confirmable('plan-add', { missionId: args[0], ...preview,
      effect: 'Adds these tests to the workflow\'s required set. The set can grow only through this command (or a reviewer request); removing or redefining an entry needs a separate owner change with a reason. Any code approval is revoked and re-adjudication waits for passing evidence for every required test.' });
    invariant(await approve(record, 'Register required tests (verification plan)'), 'Owner declined the verification plan');
    const w = await reviews.addRequiredTests(args[0], args[1], entries, OWNER, { expectedPlanHash: preview.planHashBefore });
    print({ registered: preview.added.map(entry => entry.id), planHash: w.requiredTests.planHash, gate: summary(w.requiredTests) }); return;
  }

  if (command === 'waive-test') {
    invariant(args.length === 3, 'waive-test requires a mission ID, a workflow ID and a JSON file { "testId", "rationale" }');
    const waiver = await readJson(args[2]);
    invariant(waiver && typeof waiver === 'object' && !Array.isArray(waiver) && Object.keys(waiver).every(key => ['testId', 'rationale'].includes(key)) && typeof waiver.testId === 'string' && typeof waiver.rationale === 'string', 'A waiver is { "testId", "rationale" } and nothing else');
    const view = await reviews.inspect(args[0], args[1]), test = view.gate.tests.find(entry => entry.id === waiver.testId);
    invariant(test, `Unknown required test ${waiver.testId.slice(0, 80)}`);
    invariant(!test.executable, 'Only a non-executable required test can be waived; an executable test needs run-test or record-test evidence');
    invariant(view.impact !== 'critical' || view.criticalWaiversAllowed, 'Owner policy does not allow waivers for critical-impact work (review.allowCriticalWaivers)');
    invariant(waiver.rationale.trim() && waiver.rationale.length <= 2000, 'A waiver needs a rationale of at most 2000 characters');
    const record = confirmable('waive-test', { missionId: args[0], workflowId: args[1], test: { id: test.id, description: test.description, origin: test.origin, state: test.state }, impact: view.impact,
      sourceHash: view.source.hash, planHash: view.plan.hash, rationale: waiver.rationale,
      effect: 'Satisfies this non-executable required test for THIS source and plan only: any change to either voids the waiver. The waiver and your rationale are stored permanently in the approval record.' });
    invariant(await approve(record, 'Waive a non-executable required test'), 'Owner declined the waiver');
    const result = await reviews.waiveTest(args[0], args[1], { testId: test.id, rationale: waiver.rationale, sourceHash: view.source.hash, planHash: view.plan.hash }, OWNER);
    print({ waived: result.testId, waiverId: result.id, gate: summary((await reviews.inspect(args[0], args[1])).gate) }); return;
  }

  if (command === 'record-test') {
    invariant(args.length === 3, 'record-test requires a mission ID, a workflow ID and a JSON file of owner evidence');
    const view = await reviews.inspect(args[0], args[1]), file = await readJson(args[2]);
    invariant(file && typeof file === 'object' && !Array.isArray(file), 'Evidence must be a JSON object');
    // The owner is shown (and binds) the exact source and plan the record will be filed against; omitted bindings default to those.
    const evidence = { ...file, sourceHash: file.sourceHash ?? view.source.hash, planHash: file.planHash ?? view.plan.hash };
    const record = confirmable('record-test', { missionId: args[0], workflowId: args[1], impact: view.impact, ownerAttestedAccepted: view.ownerAttestedAccepted, evidence,
      effect: view.ownerAttestedAccepted ? 'Records an owner-attested result; it can satisfy an executable required test at this impact tier.'
        : `WARNING: owner-attested records are NOT accepted at ${view.impact} impact (review.ownerAttestedImpacts is [${view.ownerAttestedImpacts.join(', ')}]). It will be stored but cannot satisfy the gate; use run-test for executed evidence.` });
    invariant(await approve(record, 'Explicit owner test evidence'), 'Owner declined the evidence');
    const stored = await reviews.recordTest(args[0], args[1], evidence, OWNER);
    print({ recorded: stored.id, provenance: stored.provenance, gate: summary((await reviews.inspect(args[0], args[1])).gate) }); return;
  }

  if (command === 'run-test') {
    const { positional, flags, argv } = split(args, { options: ['root', 'cwd', 'timeout-ms', 'max-output-bytes'], needArgv: true });
    invariant(positional.length === 3, 'run-test requires a mission ID, a workflow ID and the required test ID, then --root ROOT and -- COMMAND...');
    const [missionId, workflowId, testId] = positional, runner = await loadRunner();
    const view = await reviews.inspect(missionId, workflowId), test = view.gate.tests.find(entry => entry.id === testId);
    invariant(test, `${testId.slice(0, 80)} is not a required test of this workflow; register it with plan-add first`);
    invariant(test.executable, 'This required test is not executable; only an owner waiver (waive-test) can satisfy it');
    const spec = await declared(flags, argv, ctx, runner);
    invariant(!test.commandDigest || test.commandDigest === spec.digest, 'This required test pins a different command digest; the declared command would not count (see test-digest)');
    const record = confirmable('run-test', { missionId, workflowId, test: { id: test.id, description: test.description, origin: test.origin, state: test.state, pinnedCommandDigest: test.commandDigest }, impact: view.impact,
      sourceHash: view.source.hash, planHash: view.plan.hash,
      command: { argv: spec.argv, program: spec.program, root: spec.root, cwd: spec.cwdRelative, timeoutMs: spec.timeoutMs, maxOutputBytes: spec.maxOutputBytes, shell: false,
        environment: 'only PATH, temp/home/locale variables and the Windows system root; no API keys and no ULTRA variables', commandDigest: spec.digest },
      willRecordAs: `executed evidence by principal "test-runner" (${runner.RUNNER_ID}) with this command digest, the exit code and the output tail`,
      warning: 'This runs the command above with YOUR privileges and is not sandboxed. The runner cannot verify that the tree under the root contains the reviewed snapshot (source ' + view.source.hash.slice(0, 16)
        + '...); by confirming you assert that it does. A non-zero exit, a timeout or a kill is recorded as a FAILING result.' });
    invariant(await approve(record, 'Run an owner-declared test command'), 'Owner declined to run the command');
    let result;
    try { result = await runner.runCommand(spec, { env }); }
    catch (error) { throw new Error(`The command could not be started, so nothing was recorded: ${String(error.message).slice(0, 300)}`); }
    const passed = result.exitCode === 0 && !result.timedOut, principal = { source: 'test-runner', trusted: true, authority: 'runner', runnerId: runner.RUNNER_ID };
    const stored = await reviews.recordTest(missionId, workflowId, { name: test.id, testId: test.id, passed, details: runner.evidenceDetails(spec, result), sourceHash: view.source.hash, planHash: view.plan.hash,
      attestation: { runnerId: runner.RUNNER_ID, commandDigest: spec.digest, exitCode: result.exitCode, sourceHash: view.source.hash, qualification: 'trusted-executor' } }, principal);
    print({ recorded: stored.id, provenance: stored.provenance, passed, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, outputBytes: result.outputBytes,
      gate: summary((await reviews.inspect(missionId, workflowId)).gate) }); return;
  }
  throw new Error(`Unknown owner test command ${command}`);
}
