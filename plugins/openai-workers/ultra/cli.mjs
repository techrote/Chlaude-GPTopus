#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile } from 'node:fs/promises';
import { dispatch } from '../bridge/server.mjs';
import { profileConfig, resolveConfig, validateConfig, policyHash } from './config.mjs';
import { createService, readOwnerConfig, writeOwnerConfig, ownerPaths } from './service.mjs';
import { invariant, digest } from './store.mjs';

export const HELP = `ULTRA — governed OpenAI orchestration (not API reasoning effort)

Configuration (local owner commands):
  node plugins/openai-workers/ultra/cli.mjs init Lite
  node plugins/openai-workers/ultra/cli.mjs show
  node plugins/openai-workers/ultra/cli.mjs validate [policy.json]
  node plugins/openai-workers/ultra/cli.mjs set enabled true
  node plugins/openai-workers/ultra/cli.mjs set recruitment.mode '"REPLICATOR"'
  node plugins/openai-workers/ultra/cli.mjs project-add C:/Projects/Synthetic B

Mission operations:
  node plugins/openai-workers/ultra/cli.mjs start "A bounded engineering task"
  node plugins/openai-workers/ultra/cli.mjs status [MISSION_ID]
  node plugins/openai-workers/ultra/cli.mjs recruit MISSION_ID proposal.json REQUEST_KEY
  node plugins/openai-workers/ultra/cli.mjs step MISSION_ID
  node plugins/openai-workers/ultra/cli.mjs cancel MISSION_ID [NODE_ID]
  node plugins/openai-workers/ultra/cli.mjs review MISSION_ID AUTHOR_ID source.json risk.json
  node plugins/openai-workers/ultra/cli.mjs approve MISSION_ID REQUEST_ID
  node plugins/openai-workers/ultra/cli.mjs approve-action MISSION_ID ACTION_ID
  node plugins/openai-workers/ultra/cli.mjs approve-batch MISSION_ID request-ids.json
  node plugins/openai-workers/ultra/cli.mjs approve-plan MISSION_ID bounded-plan.json
  node plugins/openai-workers/ultra/cli.mjs escalate MISSION_ID REQUEST_ID changes.json
  node plugins/openai-workers/ultra/cli.mjs risk-override MISSION_ID NODE_ID override.json
  node plugins/openai-workers/ultra/cli.mjs record-test MISSION_ID WORKFLOW_ID evidence.json
  node plugins/openai-workers/ultra/cli.mjs promote MISSION_ID NODE_ID promotion.json
  node plugins/openai-workers/ultra/cli.mjs propose-action MISSION_ID NODE_ID action.json

Approval commands require a real interactive terminal and show the exact request.
No --yes switch is provided. Code approval never implies execution or merge.
Live ULTRA calls additionally require OPENAI_ULTRA_ALLOW_API=1.
Native Code integration additionally requires OPENAI_ULTRA_ENABLED=1.
Desktop Chat defaults to A; B reads approved roots; C only edits private stages.
General shell and live-project patch application require a separately qualified executor.

Offline acceptance: node scripts/ultra-evaluate.mjs --output <report-directory>
Policy location can be selected with OPENAI_ULTRA_CONFIG.
`;

async function terminalApproval(record, kind, io = { input: stdin, output: stdout }) {
  invariant(io.input.isTTY && io.output.isTTY, 'Human approval requires an interactive local terminal; no redirected or automatic approval is accepted');
  io.output.write(`\n${kind} — exact proposal\n${JSON.stringify(record, null, 2)}\n`);
  const phrase = `APPROVE ${record.id}`;
  const rl = createInterface(io);
  try { const answer = await rl.question(`Type ${phrase} to approve; anything else rejects: `); return answer === phrase; }
  finally { rl.close(); }
}
export async function main(argv = process.argv.slice(2), { env = process.env, print = value => stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`) } = {}) {
  const [command = 'help', ...args] = argv;
  if (command === 'help' || command === '--help') { print(HELP); return; }
  if (command === 'init') { const config = profileConfig(args[0] ?? 'Lite'); print({ file: await writeOwnerConfig(config, env), enabled: false, next: 'Run offline evaluator, inspect policy, then set enabled true when ready.' }); return; }
  if (command === 'show') { print({ paths: ownerPaths(env), policy: await readOwnerConfig(env) }); return; }
  if (command === 'validate') { const config = args[0] ? resolveConfig(JSON.parse(await readFile(resolve(args[0]), 'utf8'))) : await readOwnerConfig(env); print({ valid: true, policyHash: policyHash(config), enabled: config.enabled }); return; }
  if (command === 'set') {
    invariant(args.length === 2, 'set requires a dotted field name and one JSON value');
    const parts = args[0].split('.'); invariant(parts.every(p => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(p) && !['constructor', 'prototype', '__proto__'].includes(p)), 'Invalid policy field');
    const config = await readOwnerConfig(env); let target = config;
    for (const p of parts.slice(0, -1)) { invariant(target[p] && typeof target[p] === 'object' && !Array.isArray(target[p]), 'Unknown configuration path'); target = target[p]; }
    invariant(Object.hasOwn(target, parts.at(-1)), 'Unknown configuration field'); target[parts.at(-1)] = JSON.parse(args[1]); validateConfig(config);
    print({ file: await writeOwnerConfig(config, env), policyHash: policyHash(config) }); return;
  }
  if (command === 'project-add') {
    invariant(args.length >= 1 && args.length <= 2, 'project-add requires an absolute project path and optional B/C profile');
    const root = resolve(args[0]), profile = args[1] ?? 'B'; invariant(['B', 'C'].includes(profile), 'Choose B or C');
    const config = await readOwnerConfig(env); config.desktop.profile = profile; config.desktop.enableExecutionBridge = profile === 'C';
    config.desktop.roots = [...new Set([...config.desktop.roots, root])]; config.permissions.roots = [...new Set([...config.permissions.roots, root])];
    config.permissions.tools = [...new Set([...config.permissions.tools, 'read_file', ...(profile === 'C' ? ['stage_write'] : [])])];
    print({ file: await writeOwnerConfig(config, env), profile, root, execution: 'Private stages only; live writes and arbitrary commands remain unavailable.' }); return;
  }
  const backend = async (name, input) => {
    const result = await dispatch(name, input, { env });
    if (!result.paged) return result;
    let content = ''; for (let i = 0; i < result.pages; i++) content += (await dispatch('page', { id: result.id, page: i }, { env })).chunk;
    invariant(content.length === result.length, 'Incomplete response pages'); return JSON.parse(content);
  };
  const service = await createService({ env, backend });
  if (command === 'approve-plan' || command === 'approve-batch') {
    invariant(args.length === 2, 'Plan/batch approval requires a mission ID and JSON file');
    const proposal = JSON.parse(await readFile(resolve(args[1]), 'utf8')), m = await service.store.snapshot(args[0]);
    const description = command === 'approve-plan' ? { warning: 'This authorises future recruitment without inspecting each individual spawn.', plan: proposal } : { requests: proposal.map(id => m.requests[id]) };
    const approved = await terminalApproval({ id: digest(description), ...description }, command === 'approve-plan' ? 'FUTURE RECRUITMENT PLAN' : 'Exact recruitment batch');
    const principal = { source: 'local-user', trusted: true, authority: 'user' };
    if (command === 'approve-plan') { invariant(approved, 'Owner declined future recruitment plan'); print(await service.broker.grantPlan(m.id, { ...proposal, acknowledgeFutureRecruitment: true }, principal)); }
    else print(await service.broker.decideBatch(m.id, proposal, { decision: approved ? 'APPROVE' : 'REJECT', rationale: 'Explicit local terminal batch decision' }, principal));
    return;
  }
  if (command === 'start') { invariant(args.length === 1, 'start requires one quoted task'); print(await service.invoke('ultra_start', { task: args[0] })); return; }
  if (command === 'status') { print(args[0] ? await service.broker.diagnostics(args[0]) : await service.invoke('ultra_diagnostics', {})); return; }
  if (command === 'recruit') { invariant(args.length === 3, 'recruit requires mission ID, proposal file and idempotency key'); const proposal = JSON.parse(await readFile(resolve(args[1]), 'utf8')); print(await service.invoke('ultra_recruit', { ...proposal, mission_id: args[0], request_key: args[2] })); return; }
  if (command === 'step') { print(await service.invoke('ultra_step', { mission_id: args[0] })); return; }
  if (command === 'cancel') { print(await service.broker.cancel(args[0], args[1] ?? 'root')); return; }
  if (command === 'review') {
    invariant(args.length === 4, 'review requires mission ID, completed author ID, source JSON and risk JSON files');
    print(await service.runtime.reviews.start(args[0], { authorId: args[1], source: JSON.parse(await readFile(resolve(args[2]), 'utf8')), risk: JSON.parse(await readFile(resolve(args[3]), 'utf8')) })); return;
  }
  if (['risk-override', 'record-test', 'promote'].includes(command)) {
    invariant(args.length === 3, `${command} requires mission ID, exact allocation/workflow ID and a JSON file`);
    const proposal = JSON.parse(await readFile(resolve(args[2]), 'utf8')), m = await service.store.snapshot(args[0]);
    invariant(command === 'record-test' ? m.workflows[args[1]] : m.nodes[args[1]], 'Unknown scoped authority target');
    invariant(await terminalApproval({ id: args[1], operation: command, proposal }, 'Explicit owner evidence or scoped authority'), 'Owner declined scoped operation');
    const principal = { source: 'local-user', authority: 'user', trusted: true };
    if (command === 'risk-override') print(await service.broker.overrideRisk(m.id, args[1], proposal.assessment, { rationale: proposal.rationale, ttlMs: proposal.ttlMs }, principal));
    else if (command === 'record-test') print(await service.runtime.reviews.recordTest(m.id, args[1], proposal, principal));
    else print(await service.broker.promote(m.id, args[1], proposal, principal));
    return;
  }
  if (command === 'propose-action') {
    invariant(args.length === 3, 'propose-action requires mission ID, actor ID and the exact action JSON');
    print(await service.runtime.actions.propose(args[0], args[1], JSON.parse(await readFile(resolve(args[2]), 'utf8')))); return;
  }
  if (command === 'escalate') {
    invariant(args.length === 3, 'escalate requires mission ID, held request ID and revised proposal JSON');
    const changes = JSON.parse(await readFile(resolve(args[2]), 'utf8')), m = await service.store.snapshot(args[0]);
    invariant(m.requests[args[1]], 'Unknown escalation target');
    invariant(await terminalApproval({ id: args[1], original: m.requests[args[1]], changes }, 'Bounded escalation; all governing permissions will be rechecked'), 'Owner declined escalation');
    print(await service.broker.escalate(m.id, args[1], changes, `owner-escalation:${args[1]}:${digest(changes)}`, { source: 'local-user', authority: 'user', trusted: true })); return;
  }
  if (command === 'approve' || command === 'approve-action') {
    invariant(args.length === 2, 'Approval requires exact mission and request IDs');
    const m = await service.store.snapshot(args[0]), record = command === 'approve' ? m.requests[args[1]] : m.actions[args[1]];
    invariant(record, 'Unknown approval target');
    const approved = await terminalApproval(record, command === 'approve' ? 'Recruitment approval' : 'Consequential execution approval');
    const principal = { source: 'local-user', trusted: true, authority: 'user' };
    print(command === 'approve' ? await service.broker.decide(m.id, record.id, { decision: approved ? 'APPROVE' : 'REJECT', rationale: 'Explicit local terminal owner decision' }, principal)
      : await service.runtime.actions.decide(m.id, record.id, { approved, actionHash: record.hash, rationale: 'Explicit local terminal owner decision' }, principal)); return;
  }
  throw new Error(`Unknown command ${command}. Run --help.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`ULTRA: ${error.message}\n`); process.exitCode = 1; });
