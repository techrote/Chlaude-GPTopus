#!/usr/bin/env node
/**
 * Owner setup for native ULTRA: create the private channel key that authenticates
 * the Claude Code mod to the local bridge. Nothing in ULTRA is enabled by this;
 * with no key every private native request is refused. The key is 256 bits of
 * OS randomness in <owner state directory>/ultra-channel.key (mode 0600), is
 * never printed, and is never placed in an environment variable, prompt or log.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionChannelKey, keyFilePath } from '../bridge/native-channel.mjs';

export const HELP = `Create the owner key that authenticates the ULTRA native mod to the bridge.

  node plugins/openai-workers/scripts/provision-ultra-channel.mjs            create (refuses to overwrite)
  node plugins/openai-workers/scripts/provision-ultra-channel.mjs --rotate   replace; closes every open native session
  node plugins/openai-workers/scripts/provision-ultra-channel.mjs --print-path

The location follows OPENAI_ULTRA_STATE_DIR (or OPENAI_ULTRA_CHANNEL_KEY_FILE). On Windows prefer
set-ultra-channel.ps1, which also restricts the file's ACL to the current user.
Restart Claude Code afterwards. ULTRA stays disabled until owner policy and OPENAI_ULTRA_ENABLED=1 enable it.`;

export async function main(argv = process.argv.slice(2), { env = process.env, print = line => process.stdout.write(`${line}\n`) } = {}) {
  const flags = new Set(argv);
  for (const flag of flags) if (!['--rotate', '--print-path', '--help'].includes(flag)) throw new Error(`Unknown option ${flag}. Run with --help.`);
  if (flags.has('--help')) { print(HELP); return; }
  if (flags.has('--print-path')) { print(keyFilePath(env)); return; }
  const result = await provisionChannelKey(env, { rotate: flags.has('--rotate') });
  print(`Owner channel key ${result.rotated ? 'rotated' : 'created'}: ${result.path}`);
  print('The key is not displayed. Restart Claude Code (and any running bridge) so both sides use it.');
  if (process.platform === 'win32') print('Windows: run set-ultra-channel.ps1 to restrict this file to your account, or confirm the state directory is private.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`ULTRA channel: ${error.message}\n`); process.exitCode = 1; });
