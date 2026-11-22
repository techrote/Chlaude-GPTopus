/**
 * Test isolation. Import this module FIRST in every tests/*.test.mjs file.
 *
 * The production code falls back to a per-user state directory (the owner's REAL
 * usage ledger) whenever OPENAI_WORKER_USAGE_DIR is unset, and a write there can
 * migrate a real v1 ledger as a side effect of `npm test`. Importing this module:
 *   1. records what the real default ledger directory looks like (before any override),
 *   2. points every location the code can fall back to (usage dir, LOCALAPPDATA,
 *      XDG_STATE_HOME, HOME, USERPROFILE) at a private temporary directory, so a test
 *      that forgets its own fixture lands there and child processes inherit it, and
 *   3. registers a suite-level hook that FAILS the file if the real default ledger
 *      directory gained, lost or changed any ledger file while the tests ran.
 *
 * Individual tests still create their own OPENAI_WORKER_USAGE_DIR fixtures; this is
 * the safety net, not the fixture. This file is not itself a test (no *.test.mjs name).
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { usagePath } from '../../bridge/usage.mjs';

/** Ledger, lock, recovery, temp and evidence files all start with this prefix. */
const LEDGER_PREFIX = 'free-usage-ledger';

/** Where production code would write with NO override: computed from the pristine environment. */
export const realStateDir = dirname(usagePath({ ...process.env }));

export function snapshotStateDir(dir) {
  if (!existsSync(dir)) return null;
  const files = {};
  for (const name of readdirSync(dir).filter(n => n.startsWith(LEDGER_PREFIX)).sort()) {
    try { const s = statSync(join(dir, name)); files[name] = `${s.isDirectory() ? 'dir' : 'file'}:${s.size}:${s.mtimeMs}`; }
    catch { files[name] = 'unreadable'; }
  }
  return files;
}

const before = snapshotStateDir(realStateDir);
export const testRoot = mkdtempSync(join(tmpdir(), 'gptopus-test-'));
const home = join(testRoot, 'home');
mkdirSync(home, { recursive: true });
Object.assign(process.env, {
  OPENAI_WORKER_USAGE_DIR: join(testRoot, 'usage'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
  XDG_STATE_HOME: join(home, '.local', 'state'),
  HOME: home,
  USERPROFILE: home,
});
// A developer shell with OAI_TRACE=1 must not make tests write live trace files.
delete process.env.OAI_TRACE; delete process.env.OAI_TRACE_DIR;

/** Throws if the developer's real ledger directory was touched. Exported so a test can assert it directly. */
export function assertRealStateUntouched() {
  const now = snapshotStateDir(realStateDir);
  if (JSON.stringify(now) !== JSON.stringify(before)) {
    throw new Error(`Test run touched the real usage ledger directory ${realStateDir}. Every test must set OPENAI_WORKER_USAGE_DIR to a temporary directory.\nbefore: ${JSON.stringify(before)}\nafter:  ${JSON.stringify(now)}`);
  }
}

after(() => {
  try { assertRealStateUntouched(); }
  finally { rmSync(testRoot, { recursive: true, force: true }); }
});
