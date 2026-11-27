import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register, EFFORT_MARKER } from '../hooks/register.js';
import { newRun } from '../hooks/step.js';
import { renderStatus, visibleLength, WIDTH, modelCell } from '../hooks/status-art.js';
import { WORKER_TYPES, PROVIDER_WORKERS, OPENAI_WORKERS, effortPolicy, workerEnvSuffix } from '../bridge/workers.mjs';

// Mod side of the NVIDIA Build / LM Studio provider workers: what the mod sends, registers and shows.
function makeEngine(responses, agent, config = {}) {
  const handlers = new Map();
  register((event, filter, handler) => {
    if (typeof filter === 'function') handler = filter;
    // Keep the first command.run handler per command name apart from the rest.
    const key = event === 'command.run' && filter?.command ? `command.run:${filter.command}` : event;
    handlers.set(key, handler);
    return { catch() { return this; } };
  });
  let state = {};
  let messages = [{ role: 'user', text: 'Read /tmp/a and report' }];
  const sent = [], registered = [];
  const context = {
    agent: { list: async () => [{ id: 'ag_1', type: agent, status: 'running' }], register: async x => { registered.push(x); } },
    session: { cwd: async () => '/tmp', messages: async args => args.as === 'api' ? [] : messages },
    fs: { read: async () => '' },
    state: { get: async () => ({ value: state.run }), set: async (_, s) => { state.run = s; } },
    env: { get: async name => config[name] },
    mcp: { call: async (_server, name, args) => {
      sent.push({ name, args });
      return { content: [{ type: 'text', text: JSON.stringify(responses.shift()) }] };
    } },
    command: { register: async () => {} },
    tool: { register: async () => {} },
  };
  return { handlers, context, sent, registered, setMessages: m => { messages = m; }, setState: s => { state.run = s; }, getState: () => state.run };
}
async function consume(generator) {
  const chunks = [];
  let r = await generator.next();
  while (!r.done) { chunks.push(r.value); r = await generator.next(); }
  return { result: r.value, chunks };
}
const noFallback = async function* () { throw new Error('must not fall back to the Anthropic model'); };

test('provider worker step: agent_id sent, no service tier even when one is configured globally, free (no USD guardrail)', async () => {
  const fake = makeEngine([{ id: 'chat_c1_2', status: 'completed', text: 'Local answer.', calls: [], usage: { input: 10, output: 5, total: 15 }, estimatedUsd: 0 }],
    'oai:lfm3heretic', { OPENAI_WORKER_SERVICE_TIER: 'priority', OPENAI_WORKER_MAX_USD: '0.01' });
  // A run that already "spent" far beyond the paid guardrail still continues: provider workers cost nothing.
  fake.setState({ ...newRun(), estimatedUsd: 5 });
  const out = await consume(fake.handlers.get('turn.step')(fake.context, { agentId: 'ag_1', turnId: 't1', index: 0 }, noFallback));
  const create = fake.sent.find(s => s.name === 'create');
  assert.ok(create, 'a create call was sent');
  assert.equal(create.args.worker_type, 'lfm3heretic');
  assert.equal(create.args.model, WORKER_TYPES.lfm3heretic.model);
  assert.equal(create.args.agent_id, 'ag_1');
  assert.equal('service_tier' in create.args, false);
  assert.equal(out.result.answer, 'Local answer.');
  assert.equal(fake.getState().responseId, 'chat_c1_2');
});

test('OpenAI worker step is unchanged: no agent_id, configured tier still sent', async () => {
  const fake = makeEngine([{ id: 'resp_same', status: 'completed', text: 'Done.', estimatedUsd: 0.001 }], 'oai:sol6-2', { OPENAI_WORKER_SERVICE_TIER: 'priority' });
  await consume(fake.handlers.get('turn.step')(fake.context, { agentId: 'ag_1', turnId: 't1', index: 0 }, noFallback));
  const create = fake.sent.find(s => s.name === 'create').args;
  assert.equal('agent_id' in create, false);
  assert.equal(create.service_tier, 'priority');
});

test('provider failures name the provider; per-worker model override comes from the literal env snapshot', async () => {
  const fake = makeEngine([{ id: 'chat_c2_1', status: 'failed', reason: 'HTTP 404: model not found' }], 'oai:kimik3-1pro',
    { OPENAI_WORKER_KIMIK3_1PRO_MODEL: 'moonshotai/kimi-other' });
  const out = await consume(fake.handlers.get('turn.step')(fake.context, { agentId: 'ag_1', turnId: 't1', index: 0 }, noFallback));
  assert.equal(fake.sent.find(s => s.name === 'create').args.model, 'moonshotai/kimi-other');
  assert.match(out.result.answer, /^NVIDIA Build request failed: HTTP 404/);
});

test('effort marker none switches thinking off on provider workers and is ignored by OpenAI workers', async () => {
  assert.equal(EFFORT_MARKER.exec('[oai-effort:none]\nx')?.[1], 'none');
  const nemo = makeEngine([{ id: 'chat_c3_1', status: 'completed', text: 'ok', estimatedUsd: 0 }], 'oai:nemo3-5lightning');
  nemo.setMessages([{ role: 'user', text: '[oai-effort:none]\nQuick answer' }]);
  await consume(nemo.handlers.get('turn.step')(nemo.context, { agentId: 'ag_1', turnId: 't1', index: 0 }, noFallback));
  assert.equal(nemo.sent.find(s => s.name === 'create').args.effort, 'none');
  const sol = makeEngine([{ id: 'resp_none', status: 'completed', text: 'ok', estimatedUsd: 0.001 }], 'oai:sol6-2');
  sol.setMessages([{ role: 'user', text: '[oai-effort:none]\nTask' }]);
  await consume(sol.handlers.get('turn.step')(sol.context, { agentId: 'ag_1', turnId: 't1', index: 0 }, noFallback));
  const args = sol.sent.find(s => s.name === 'create').args;
  assert.equal(args.effort, effortPolicy('sol6-2', {}).default);
  assert.doesNotMatch(JSON.stringify(args.input), /oai-effort/);
});

test('legacy session registers provider workers with provider-aware descriptions', async () => {
  const fake = makeEngine([], 'oai:sol6-2');
  await fake.handlers.get('session.start')(fake.context, {}, async e => e);
  const names = fake.registered.map(a => a.name);
  assert.deepEqual(names.sort(), [...Object.keys(WORKER_TYPES), 'astra'].sort()); // 'astra' = free->paid entry point
  for (const name of PROVIDER_WORKERS) {
    const agent = fake.registered.find(a => a.name === name), spec = WORKER_TYPES[name];
    assert.match(agent.description, spec.provider === 'nvidia' ? /NVIDIA Build/ : /LM Studio model on this PC/);
    assert.doesNotMatch(agent.description, /when OpenAI is requested/);
    assert.deepEqual(agent.tools, ['Read', 'Edit', 'Write', 'Bash']);
  }
  for (const name of OPENAI_WORKERS) assert.match(fake.registered.find(a => a.name === name).description, /when OpenAI is requested/);
});

test('every env name a provider worker reads is a literal line in each mod env snapshot', () => {
  const source = readFileSync(new URL('../hooks/register.js', import.meta.url), 'utf8');
  for (const name of PROVIDER_WORKERS) for (const f of ['MODEL', 'EFFORT_MIN', 'EFFORT_MAX', 'EFFORT_DEFAULT', 'EFFORT_NOTE', 'MAX_STEPS']) {
    const env = `OPENAI_WORKER_${workerEnvSuffix(name)}_${f}`;
    assert.equal(source.split(`${env}: await $.env.get('${env}')`).length - 1, 3, `${env} must appear in all three snapshots`);
  }
});

test('/oai status panel tags provider workers and shows the NVIDIA key state without overflowing the frame', async () => {
  const fake = makeEngine([
    { standard: { configured: true, source: 'environment' }, free: { configured: false, source: 'none' }, nvidia: { configured: false, source: 'none' }, platform: 'win32' },
    null,
  ], 'oai:sol6-2');
  const out = await fake.handlers.get('command.run:oai')(fake.context, { args: '' });
  const lines = out.text.split('\n');
  for (const line of lines) assert.equal(visibleLength(line), WIDTH, `bad width: ${line}`);
  assert.match(out.text, /nvidia \(NVIDIA_API_KEY\)\s+○ missing/);
  assert.match(out.text, /kimik3-1pro\s+moonshotai\/kimi-k3\.1-pro\s+nvidia\s+—\s+none\.\.max \(high\)/);
  assert.match(out.text, /lfm2-5turbo24b\s+\S+…\s+local\s+—/);
  assert.match(out.text, /sol6-2\s+gpt-6\.2-sol\s+straight\s+auto/);
  assert.doesNotMatch(out.text, /nvapi-/);
});

test('status renderer: model cell drops the publisher prefix only for long ids', () => {
  assert.equal(modelCell('gpt-6.2-sol'), 'gpt-6.2-sol');
  assert.equal(modelCell('moonshotai/kimi-k3.1-pro'), 'moonshotai/kimi-k3.1-pro');
  assert.equal(modelCell('nvidia/nemotron-3.5-super-vl-120b-a12b'), 'nemotron-3.5-super-vl-120b-a12b'.slice(0, 29) + '…');
  const text = renderStatus({ now: new Date('2026-11-22T00:00:00Z'), version: 't', keys: [], usage: null, usageError: 'x', notes: [], ultra: { enabled: false }, active: [],
    workers: PROVIDER_WORKERS.map(name => ({ name, model: WORKER_TYPES[name].model, key: WORKER_TYPES[name].key, provider: WORKER_TYPES[name].provider, tier: '—', effort: effortPolicy(name, {}) })) });
  for (const line of text.split('\n')) assert.equal(visibleLength(line), WIDTH);
});

test('live-config.json overrides the session-start env snapshot for the model sent (no restart)', async () => {
  const fake = makeEngine([{ id: 'chat_c9_1', status: 'completed', text: 'ok', estimatedUsd: 0 }], 'oai:lfm2-5turbo24b',
    { LOCALAPPDATA: 'C:/Users/x/AppData/Local', OPENAI_WORKER_LFM2_5TURBO24B_MODEL: 'old-model' });
  const reads = [];
  fake.context.fs.read = async p => { reads.push(p); return JSON.stringify({ version: 1, values: { OPENAI_WORKER_LFM2_5TURBO24B_MODEL: 'kat-coder' } }); };
  await consume(fake.handlers.get('turn.step')(fake.context, { agentId: 'ag_1', turnId: 't1', index: 0 }, noFallback));
  assert.ok(reads.some(p => /ClaudeOpenAIWorkers\/live-config\.json$/.test(p)), reads.join());
  assert.equal(fake.sent.find(s => s.name === 'create').args.model, 'kat-coder');
});

test('first worker spawn shows the config panel in the Claude Code browser pane, with system-browser fallback', async () => {
  const URL1 = 'http://127.0.0.1:4321/?t=abc';
  for (const paneFails of [false, true]) {
    const fake = makeEngine([], 'oai:katcoder2-5');
    const calls = [], toasts = [];
    fake.context.mcp.call = async (server, name, args) => {
      calls.push({ server, name, args });
      if (server === 'Claude_Browser') { if (paneFails) throw new Error('no pane'); return { content: [] }; }
      return { content: [{ type: 'text', text: JSON.stringify(name === 'panel' ? { url: URL1 } : {}) }] };
    };
    fake.context.ui = { toast: async t => { toasts.push(t); } };
    await fake.handlers.get('session.start')(fake.context, {}, async e => e);
    const spawn = fake.handlers.get('agent.spawn');
    await spawn(fake.context, { subagentType: 'oai:katcoder2-5', description: 'x' }, async e => ({ agentId: 'ag_1' }));
    await spawn(fake.context, { subagentType: 'oai:katcoder2-5', description: 'y' }, async e => ({ agentId: 'ag_2' }));
    assert.deepEqual(calls[0], { server: 'plugin:oai:bridge', name: 'panel', args: { auto: true } });
    assert.deepEqual(calls[1], { server: 'Claude_Browser', name: 'preview_start', args: { url: URL1 } });
    if (paneFails) assert.deepEqual(calls[2].args, { system: true });
    assert.equal(calls.filter(c => c.name === 'panel' && c.args.auto).length, 1, 'checked once per session');
    assert.match(toasts[0], paneFails ? /system browser.*\/oai:config/ : /browser pane.*\/oai:config/);
  }
});
