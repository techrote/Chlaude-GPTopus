import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ExecutionStore } from '../ultra/store.mjs';
import { RecruitmentBroker } from '../ultra/broker.mjs';
import { UltraRuntime } from '../ultra/runtime.mjs';
import { SCENARIOS, evaluate, provenance, LOW_RISK } from '../../../scripts/ultra-evaluate.mjs';

for (const scenario of SCENARIOS) test(`acceptance ${scenario.id}: ${scenario.title}`, async () => {
  const result = await scenario.run();
  assert.equal(result.status, 'PASS');
  assert.equal(result.realApiRequests, 0);
  const leaves = result.runs ?? [result];
  for (const leaf of leaves) {
    assert.ok(leaf.diagnostics?.policyHash, 'Real broker policy identity is reported');
    assert.ok(leaf.events?.length, 'The actual durable event ledger is inspected');
    assert.ok(leaf.events.every((event, i) => event.sequence === i + 1));
  }
});

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ultra-integration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory;
}
function child(source) {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; process.stdout.on('data', chunk => stdout += chunk); process.stderr.on('data', chunk => stderr += chunk);
    process.on('error', reject); process.on('exit', code => resolve({ code, stdout, stderr }));
  });
}

test('actual execution-store transactions remain atomic across independent processes', async t => {
  const directory = await temporary(t), ledger = path.join(directory, 'execution.json');
  const module = new URL('../ultra/store.mjs', import.meta.url).href;
  const code = `import { ExecutionStore } from ${JSON.stringify(module)}; const store = new ExecutionStore(${JSON.stringify(ledger)}); for(let i=0;i<8;i++) await store.transaction((state,event)=>{ state.fixtureCounter=(state.fixtureCounter??0)+1; event('fixture.increment','synthetic',{value:state.fixtureCounter}); });`;
  const results = await Promise.all(Array.from({ length: 6 }, () => child(code)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const snapshot = await new ExecutionStore(ledger).snapshot();
  assert.equal(snapshot.fixtureCounter, 48); assert.equal(snapshot.events.length, 48);
  assert.deepEqual(snapshot.events.map(e => e.data.value), Array.from({ length: 48 }, (_, i) => i + 1));
});

test('execution store recovers a dead owner and rejects corrupted audit evidence', async t => {
  const directory = await temporary(t), ledger = path.join(directory, 'execution.json'), store = new ExecutionStore(ledger);
  const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }); assert.equal(exited.status, 0);
  await fs.writeFile(`${ledger}.lock`, JSON.stringify({ pid: exited.pid, nonce: 'dead-process-fixture' }));
  await store.transaction((state, event) => { state.fixture = 'preserved'; event('fixture.accepted', 'synthetic', { result: 'preserved' }); });
  const before = await fs.readFile(ledger, 'utf8'), modified = JSON.parse(before);
  modified.events[0].data.result = 'tampered'; await fs.writeFile(ledger, JSON.stringify(modified));
  await assert.rejects(store.snapshot(), /audit chain is corrupt/);
  assert.match(await fs.readFile(ledger, 'utf8'), /tampered/);
});

test('evaluator writes source-qualified evidence and refuses report overwrite', async t => {
  const directory = await temporary(t), output = path.join(directory, 'report');
  const result = await evaluate({ outputDirectory: output, scenarios: ['F'] });
  assert.equal(result.status, 'PASS'); assert.equal(result.realApiSpendUsd, 0);
  const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
  assert.equal(report.liveDesktopUi, 'NOT RUN'); assert.equal(report.liveOpenAiApi, 'NOT RUN');
  assert.match(report.source.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.ok((await fs.readFile(path.join(output, 'activity.jsonl'), 'utf8')).includes('agent.recovered'));
  assert.ok((await fs.readFile(path.join(output, 'budgets.json'), 'utf8')).includes('Synthetic estimates'));
  await assert.rejects(evaluate({ outputDirectory: output, scenarios: ['F'] }), error => error.code === 'EEXIST');
});

test('Windows wrapper remains offline, PowerShell 5 compatible and source-aware', async () => {
  const script = await fs.readFile(new URL('../../../scripts/Evaluate-ULTRA.ps1', import.meta.url), 'utf8');
  assert.match(script, /#requires -Version 5\.1/); assert.match(script, /ExpectedSha/);
  assert.match(script, /NonInteractive/); assert.match(script, /owner-observations\.json/);
  assert.doesNotMatch(script, /Invoke-WebRequest|Invoke-RestMethod|DownloadString|OPENAI_API_KEY\s*=/i);
  const source = await provenance(); assert.match(source.sourceFingerprint, /^[a-f0-9]{64}$/);
});

test('real runtime applies supervisor APPROVE REJECT MODIFY ESCALATE without spawning approval chains', async t => {
  const directory = await temporary(t);
  for (const decision of ['APPROVE', 'REJECT', 'MODIFY', 'ESCALATE']) {
    const store = new ExecutionStore(path.join(directory, `${decision}.json`));
    const broker = new RecruitmentBroker(store, { config: { enabled: true, recruitment: { mode: 'REPLICATOR' } } });
    const mission = await broker.createMission({ id: `decision_${decision}`, task: `Synthetic supervisor decision ${decision}`, orchestrator: { model: 'opus', trusted: true } });
    const parent = await broker.request(mission.id, 'root', { worker: 'sol', role: 'exploration', task: 'Keep parent active for recruitment.', risk: LOW_RISK }, 'parent');
    const active = await broker.claim(mission.id, 'fixture-parent', { nodeId: parent.nodeId }); assert.equal(active.id, parent.nodeId);
    const childRequest = await broker.request(mission.id, parent.nodeId, { worker: 'sol', role: 'exploration', task: 'Proposed peer.', risk: LOW_RISK }, 'peer');
    assert.equal(childRequest.status, 'pending');
    const backend = async (method, args) => {
      assert.equal(method, 'create'); assert.match(args.instructions, /Role: supervisor/); assert.deepEqual(args.tools, []);
      const content = { decision, rationale: `Deterministic independent ${decision} fixture.` };
      if (decision === 'MODIFY') content.modification = { worker: 'luna', task: 'Narrow revised scope.', budget: { tokens: 16000, usd: 1 } };
      return { id: `resp_supervisor_${decision}`, status: 'completed', text: JSON.stringify(content), usage: { input: 20, output: 12, total: 32, total_tokens: 32 }, estimatedUsd: 0.00001 };
    }; backend.offline = true;
    const runtime = new UltraRuntime(broker, { backend });
    await runtime.tick(mission.id);
    const state = await store.snapshot(mission.id);
    assert.equal(state.requests[childRequest.id].status, { APPROVE: 'queued', REJECT: 'rejected', MODIFY: 'modify', ESCALATE: 'escalated' }[decision]);
    assert.equal(Object.values(state.nodes).filter(n => n.role === 'supervisor').length, 1);
    if (decision !== 'APPROVE') assert.equal(state.requests[childRequest.id].nodeId, null);
    if (decision === 'MODIFY') {
      const revised = await broker.revise(mission.id, childRequest.id, parent.nodeId, { worker: 'luna', task: 'Narrow revised scope.', budget: { tokens: 16000, usd: 1 } }, 'revised');
      assert.equal(revised.status, 'queued'); assert.equal(revised.evaluation.family, 'luna');
    }
  }
});
