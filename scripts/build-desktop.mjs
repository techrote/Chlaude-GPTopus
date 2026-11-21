#!/usr/bin/env node
/**
 * Build the dependency-free Desktop MCP bundle using Node built-ins only.
 *
 * ZIP entries are stored (not deflated) with fixed metadata so the byte stream
 * is deterministic across supported Node versions and operating systems. CI
 * uses --check to prove the committed distributable matches reviewed source.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const check = args[0] === '--check';
const outArg = check ? args[1] : args[0];
if (args.length > (check ? 2 : 1)) throw new Error('Usage: build-desktop.mjs [--check] [output.mcpb]');
const out = resolve(outArg || join(root, 'dist', 'Chlaude-GPTopus-Desktop.mcpb'));
const SOURCES = {
  'manifest.json': 'desktop-extension/manifest.json',
  'server/desktop-server.mjs': 'plugins/openai-workers/bridge/desktop-server.mjs',
  'server/server.mjs': 'plugins/openai-workers/bridge/server.mjs',
  'server/openai.mjs': 'plugins/openai-workers/bridge/openai.mjs',
  'server/usage.mjs': 'plugins/openai-workers/bridge/usage.mjs',
  'server/workers.mjs': 'plugins/openai-workers/bridge/workers.mjs',
  'scripts/read-openai-key.ps1': 'plugins/openai-workers/scripts/read-openai-key.ps1',
};
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
