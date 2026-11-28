#!/usr/bin/env node
/**
 * Build the dependency-free Desktop MCP bundle using Node built-ins only.
 *
 * ZIP entries are stored (not deflated) with fixed metadata so the byte stream
 * is deterministic across supported Node versions and operating systems. CI
 * uses --check to prove the committed distributable matches reviewed source.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `Usage: node scripts/build-desktop.mjs [--check] [--help] [--] [output.mcpb]

  (no arguments)   write dist/Chlaude-GPTopus-Desktop.mcpb from the current sources
  output.mcpb      write (or, with --check, compare against) this path instead
  --check          verify that the existing file equals a deterministic build; write nothing
  --help, -h       print this text
  --               end of options (a path that starts with "-" may follow)
`;
// Only the documented flags exist: anything else that looks like a flag is an error, never a file name.
function parseArguments(argv) {
  let check = false, outArg = null, options = true;
  for (const arg of argv) {
    if (options && arg === '--') { options = false; continue; }
    if (options && (arg === '--help' || arg === '-h')) return { help: true };
    if (options && arg === '--check') { if (check) return { error: '--check was given more than once' }; check = true; continue; }
    if (options && arg.startsWith('-')) return { error: `Unknown option ${arg}` };
    if (outArg !== null) return { error: 'Only one output path may be given' };
    outArg = arg;
  }
  return { check, outArg };
}
const parsed = parseArguments(process.argv.slice(2));
// Flush before exiting: a pipe may still hold the text when process.exit() is called.
const finish = (stream, text, code) => new Promise(done => stream.write(text, done)).then(() => process.exit(code));
if (parsed.help) await finish(process.stdout, USAGE, 0);
if (parsed.error) await finish(process.stderr, `build-desktop: ${parsed.error}\n\n${USAGE}`, 2);
const { check, outArg } = parsed;
const out = resolve(outArg || join(root, 'dist', 'Chlaude-GPTopus-Desktop.mcpb'));
const SOURCES = {
  'manifest.json': 'desktop-extension/manifest.json',
  'server/desktop-server.mjs': 'plugins/openai-workers/bridge/desktop-server.mjs',
  'server/server.mjs': 'plugins/openai-workers/bridge/server.mjs',
  'server/openai.mjs': 'plugins/openai-workers/bridge/openai.mjs',
  'server/usage.mjs': 'plugins/openai-workers/bridge/usage.mjs',
  'server/workers.mjs': 'plugins/openai-workers/bridge/workers.mjs',
  'server/trace.mjs': 'plugins/openai-workers/bridge/trace.mjs',
  'server/steer.mjs': 'plugins/openai-workers/bridge/steer.mjs',
  'server/direct-run.mjs': 'plugins/openai-workers/bridge/direct-run.mjs',
  'server/chat.mjs': 'plugins/openai-workers/bridge/chat.mjs',
  'server/convo.mjs': 'plugins/openai-workers/bridge/convo.mjs',
  'server/rotation.mjs': 'plugins/openai-workers/bridge/rotation.mjs',
  'server/panel.mjs': 'plugins/openai-workers/bridge/panel.mjs',
  'server/live-env.mjs': 'plugins/openai-workers/bridge/live-env.mjs',
  'server/native-channel.mjs': 'plugins/openai-workers/bridge/native-channel.mjs',
  'server/policy.mjs': 'plugins/openai-workers/bridge/policy.mjs',
  'server/tree.mjs': 'plugins/openai-workers/bridge/tree.mjs',
  'scripts/oai-config-core.mjs': 'plugins/openai-workers/scripts/oai-config-core.mjs',
  'scripts/oai-colour.mjs': 'plugins/openai-workers/scripts/oai-colour.mjs',
  'scripts/read-openai-key.ps1': 'plugins/openai-workers/scripts/read-openai-key.ps1',
};
// Preserve source-relative imports for the shared policy/runtime used by both
// facades. Mirrors are deterministic copies of the same canonical bridge files.
for (const name of ['workers.mjs', 'usage.mjs', 'openai.mjs', 'server.mjs', 'trace.mjs', 'steer.mjs', 'chat.mjs', 'convo.mjs', 'rotation.mjs', 'direct-run.mjs', 'panel.mjs', 'live-env.mjs', 'native-channel.mjs', 'policy.mjs', 'tree.mjs']) SOURCES[`bridge/${name}`] = `plugins/openai-workers/bridge/${name}`;
for (const name of readdirSync(join(root, 'plugins/openai-workers/ultra')).filter(name => name.endsWith('.mjs')).sort()) SOURCES[`ultra/${name}`] = `plugins/openai-workers/ultra/${name}`;
SOURCES['hooks/channel.js'] = 'plugins/openai-workers/hooks/channel.js';
SOURCES['hooks/ultra.js'] = 'plugins/openai-workers/hooks/ultra.js';
SOURCES['package.json'] = 'plugins/openai-workers/package.json';
const manifest = JSON.parse(readFileSync(join(root, SOURCES['manifest.json']), 'utf8'));
if (manifest.server.entry_point !== 'server/desktop-server.mjs' || manifest.manifest_version !== '0.3') {
  throw new Error('Unexpected MCPB manifest entry point or version.');
}
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c >>> 0;
}
function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function localHeader(file, crc, size) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6);
  h.writeUInt16LE(0, 8);
  h.writeUInt16LE(33, 12);
  h.writeUInt32LE(crc, 14); h.writeUInt32LE(size, 18); h.writeUInt32LE(size, 22);
  h.writeUInt16LE(file.length, 26);
  return h;
}
function centralHeader(file, crc, size, offset) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(0, 10);
  h.writeUInt16LE(33, 14); h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(size, 20); h.writeUInt32LE(size, 24);
  h.writeUInt16LE(file.length, 28); h.writeUInt32LE(offset, 42);
  return h;
}
const local = [], central = [];
let offset = 0;
for (const [name, source] of Object.entries(SOURCES)) {
  const filename = Buffer.from(name, 'utf8');
  const raw = readFileSync(join(root, source));
  const crc = crc32(raw);
  const header = localHeader(filename, crc, raw.length);
  local.push(header, filename, raw);
  central.push(centralHeader(filename, crc, raw.length, offset), filename);
  offset += header.length + filename.length + raw.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(Object.keys(SOURCES).length, 8);
end.writeUInt16LE(Object.keys(SOURCES).length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...local, directory, end]);

if (check) {
  if (!existsSync(out)) throw new Error(`Committed MCPB is missing: ${out}`);
  if (!readFileSync(out).equals(archive)) {
    throw new Error('Committed MCPB does not match deterministic source build. Run node scripts/build-desktop.mjs and commit the result.');
  }
  process.stdout.write(`Verified reproducible MCPB: ${out}\n`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, archive);
  process.stdout.write(`${out}\n`);
}
