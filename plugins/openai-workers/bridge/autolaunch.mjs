// Opens the OAI config panel in the default browser the first time a worker is spawned.
// "First" means once per install: a marker file in the state dir records it.
// Opt out with OAI_CONFIG_AUTOLAUNCH=0. Never throws; a failure just skips the launch.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../scripts/oai-config-core.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'oai-config.mjs');

export function autoLaunchPanel(env = process.env, { launch = defaultLaunch } = {}) {
  try {
    if (env.OAI_CONFIG_AUTOLAUNCH === '0') return false;
    const dir = stateDir(env), marker = join(dir, 'panel-autolaunched');
    if (existsSync(marker)) return false;
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, new Date().toISOString());
    launch();
    return true;
  } catch { return false; }
}

function defaultLaunch() {
  // The panel script opens the browser itself and exits when the page closes or after 30 idle minutes.
  spawn(process.execPath, [script], { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
}
