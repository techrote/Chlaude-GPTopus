// The OAI config panel as a bridge service: start one panel server (or reuse the running one) and
// return its URL, so the mod can show it in Claude Code's own browser pane. Opening a system browser
// is only the fallback the mod asks for when that pane is unavailable.
//
// One panel per machine: the panel records { url, pid } in <state>/panel.json while it runs.
// First-spawn autolaunch is once per install (marker <state>/panel-autolaunched); OAI_CONFIG_AUTOLAUNCH=0
// turns it off. Nothing here ever launches a real process under `node --test`.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../scripts/oai-config-core.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'oai-config.mjs');
const URL_LINE = /^OAI config panel: (http:\/\/127\.0\.0\.1:\d+\/\?t=[A-Za-z0-9_-]+)\s*$/m;
const underTest = env => Boolean(env.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT);

export const panelFile = env => join(stateDir(env), 'panel.json');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** The running panel's URL, or null. */
export function runningPanel(env = process.env, { isAlive = alive } = {}) {
  try {
    const doc = JSON.parse(readFileSync(panelFile(env), 'utf8'));
    return Number.isInteger(doc?.pid) && typeof doc.url === 'string' && URL_LINE.test(`OAI config panel: ${doc.url}`) && isAlive(doc.pid) ? doc.url : null;
  } catch { return null; }
}

function startPanel(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--no-open'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true });
    let out = '';
    const done = (err, url) => { clearTimeout(timer); child.stdout.removeAllListeners('data'); child.stdout.on('data', () => {}); child.unref(); child.stdout.unref?.(); err ? reject(err) : resolve(url); };
    const timer = setTimeout(() => done(new Error('The config panel did not start in time.')), timeoutMs);
    child.on('error', err => done(err));
    child.on('exit', code => done(new Error(`The config panel exited early (code ${code}).`)));
    child.stdout.on('data', chunk => { out += chunk; const m = URL_LINE.exec(out); if (m) done(null, m[1]); });
  });
}

export function openSystemBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' }).on('error', () => {}).unref();
}

/** First worker spawn of this install? Claims the marker when it is. */
export function claimAutolaunch(env = process.env) {
  if (env.OAI_CONFIG_AUTOLAUNCH === '0') return false;
  const dir = stateDir(env), marker = join(dir, 'panel-autolaunched');
  if (existsSync(marker)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(marker, new Date().toISOString());
  return true;
}

/**
 * args.auto   - only for the first worker spawn of this install (else { url: null, skipped })
 * args.system - also open the URL in the system browser (fallback when Claude's browser pane is unavailable)
 */
export async function panelOp(args = {}, env = process.env, { start = startPanel, open = openSystemBrowser, isAlive = alive } = {}) {
  if (underTest(env) && (start === startPanel || (args.system && open === openSystemBrowser))) return { url: null, skipped: 'test' };
  if (args.auto && !claimAutolaunch(env)) return { url: null, skipped: 'already-launched' };
  let url = runningPanel(env, { isAlive });
  const reused = Boolean(url);
  if (!url) url = await start();
  if (args.system) open(url);
  return { url, reused };
}
