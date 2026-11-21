import test from 'node:test';
import assert from 'node:assert/strict';
import { retryWindowsFileOperation } from '../ultra/store.mjs';

test('Windows delete-pending/share faults retry the exclusive operation without claiming ownership', async () => {
  let time = 0, attempts = 0, acquired = 0;
  const value = await retryWindowsFileOperation(async () => {
    attempts++;
    if (attempts <= 3) throw Object.assign(new Error('Simulated Windows delete-pending handle'), { code: ['EPERM', 'EACCES', 'EBUSY'][attempts - 1] });
    acquired++; return 'exclusive descriptor';
  }, { platform: 'win32', timeoutMs: 100, clock: () => time, pause: async ms => { time += ms; } });
  assert.equal(value, 'exclusive descriptor'); assert.equal(attempts, 4); assert.equal(acquired, 1);
});

test('Windows file retries are bounded and never reinterpret EEXIST or integrity failures', async () => {
  let time = 0, attempts = 0;
  await assert.rejects(() => retryWindowsFileOperation(async () => { attempts++; throw Object.assign(new Error('Persistent access denial'), { code: 'EPERM' }); },
    { platform: 'win32', timeoutMs: 20, clock: () => time, pause: async ms => { time += ms; } }), /Persistent access denial/);
  assert.equal(attempts, 3);
  for (const [platform, code] of [['win32', 'EEXIST'], ['linux', 'EPERM'], ['win32', 'INTEGRITY']]) {
    let calls = 0;
    await assert.rejects(() => retryWindowsFileOperation(async () => { calls++; throw Object.assign(new Error(code), { code }); }, { platform }), new RegExp(code));
    assert.equal(calls, 1);
  }
});
