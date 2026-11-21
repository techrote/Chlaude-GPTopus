#!/usr/bin/env node
/**
 * Build the dependency-free Desktop MCP bundle using Node built-ins only.
 * Zip archives created here follow the MCPB/ZIP packaging convention.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] || join(root, 'dist', 'Chlaude-GPTopus-Desktop.mcpb'));
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
// Pre-compute CRC-32 for ZIP headers and directory records.
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
function localHeader(file, crc, compressedSize, rawSize) {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4); b.writeUInt16LE(0x0800, 6); // ZIP 2.0, UTF-8 names
  b.writeUInt16LE(8, 8); b.writeUInt16LE(33, 12); b.writeUInt32LE(crc, 14);
  b.writeUInt32LE(compressedSize, 18); b.writeUInt32LE(rawSize, 22); b.writeUInt16LE(file.length, 26);
  return b;
}
function centralHeader(file, crc, compressedSize, rawSize, offset) {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0); b.writeUInt16LE(20, 4); b.writeUInt16LE(20, 6);
  b.writeUInt16LE(0x0800, 8); b.writeUInt16LE(8, 10); b.writeUInt16LE(33, 14); b.writeUInt32LE(crc, 16);
  b.writeUInt32LE(compressedSize, 20); b.writeUInt32LE(rawSize, 24);
  b.writeUInt16LE(file.length, 28); b.writeUInt32LE(offset, 42);
  return b;
}
const local = [], central = [];
let offset = 0;
for (const [name, source] of Object.entries(SOURCES)) {
  const filename = Buffer.from(name, 'utf8');
  const raw = readFileSync(join(root, source));
  const compressed = deflateRawSync(raw, { level: 9 });
  const crc = crc32(raw);
  const header = localHeader(filename, crc, compressed.length, raw.length);
  local.push(header, filename, compressed);
  central.push(centralHeader(filename, crc, compressed.length, raw.length, offset), filename);
  offset += header.length + filename.length + compressed.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(Object.keys(SOURCES).length, 8);
end.writeUInt16LE(Object.keys(SOURCES).length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([...local, directory, end]));
process.stdout.write(`${out}\n`);
