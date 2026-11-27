import './support/isolate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { repairInput } from '../bridge/policy.mjs';
import { filterToolArgs } from '../hooks/tools.js';
import { nextInput } from '../hooks/step.js';

const ok = { call_id: 'c1', name: 'Write', args: { file_path: 'C:/x', content: 'hi' } };

test('a healthy tool-call or text response needs no repair', () => {
  assert.equal(repairInput({ status: 'completed', text: '', calls: [ok] }, filterToolArgs), null);
  assert.equal(repairInput({ status: 'completed', text: 'done', calls: [] }, filterToolArgs), null);
});

test('an empty completed reply is repaired, not reported as done', () => {
  const r = repairInput({ status: 'completed', text: '  ', calls: [] }, filterToolArgs);
  assert.equal(r.reason, 'empty');
  assert.equal(r.input.at(-1).role, 'user');
});

test('a malformed call (truncated JSON -> null args) is answered with an error for EVERY call in the turn', () => {
  const bad = { call_id: 'c2', name: 'Write', args: null };
  const r = repairInput({ status: 'completed', text: '', calls: [ok, bad] }, filterToolArgs);
  assert.equal(r.reason, 'rejected_call');
  const outs = r.input.filter(i => i.type === 'function_call_output');
  assert.deepEqual(outs.map(o => o.call_id), ['c1', 'c2']);
  assert.match(outs[1].output, /rejected/);
});

test('an output-limit cut is repaired; other incompletes are not looped', () => {
  assert.equal(repairInput({ status: 'incomplete', reason: 'max_output_tokens', calls: [] }, filterToolArgs).reason, 'truncated');
  assert.equal(repairInput({ status: 'incomplete', reason: 'content_filter', calls: [] }, filterToolArgs), null);
});

test('a finished run that still holds unanswered calls resumes with outputs for them (no HTTP 400)', () => {
  const run = { responseId: 'resp_1', pending: ['c1'], seenPrompts: 1, finished: true, handback: null };
  const messages = [{ role: 'user', text: 'task' }, { role: 'user', text: 'please continue' }];
  const plan = nextInput(messages, run);
  assert.equal(plan.previous_response_id, 'resp_1');
  assert.equal(plan.input[0].type, 'function_call_output');
  assert.equal(plan.input[0].call_id, 'c1');
});
