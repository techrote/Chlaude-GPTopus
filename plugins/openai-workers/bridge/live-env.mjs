// Live configuration: re-reads the panel's store (Windows USER environment, or OAI_CONFIG_STORE json)
// and applies it to this process's env, so panel changes take effect on the next call without a restart.
// Only panel-allowlisted names are touched; keys and OPENAI_ULTRA_* are never in that list.
// An empty/missing stored value means "unset", exactly as the panel writes it.
import { ALLOWED, defaultStore, stateDir, writeLiveConfig } from '../scripts/oai-config-core.mjs';

const SAFE = ALLOWED.filter(n => !/KEY|TOKEN|SECRET/i.test(n) && !n.startsWith('OPENAI_ULTRA_'));
let last = 0, lastValues = null;

export function refreshLiveEnv(env = process.env, { ttlMs = 5000, now = Date.now(), store, platform = process.platform } = {}) {
  try {
    if (env.OAI_LIVE_CONFIG === '0') return false;
    if (!store && env.NODE_TEST_CONTEXT) return false; // never touch the real user environment from `node --test`
    if (now - last < ttlMs) return false;
    // Only where the store IS the source of truth: Windows user env or an explicit json store.
    if (!store && platform !== 'win32' && !env.OAI_CONFIG_STORE) return false;
    last = now;
    const values = (store ?? defaultStore(env, platform)).read(SAFE);
    for (const n of SAFE) {
      const v = values[n];
      if (typeof v === 'string' && v !== '') env[n] = v; else delete env[n];
    }
    lastValues = values;
    writeLiveConfig(stateDir(env), values);
    return true;
  } catch { return false; } // keep the last applied configuration
}
export const liveValues = () => lastValues;
export function resetLiveEnvForTests() { last = 0; lastValues = null; }
