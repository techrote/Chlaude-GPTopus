// Portable request-authentication primitives for the private native control
// channel. This file is imported by BOTH the Claude Code mod (a non-Node VM) and
// the Node bridge, so there is exactly one implementation of the canonical
// encoding and of the signature. Never import a Node module, use dynamic
// import(), or pass the host `$` here. Only the web APIs the mod VM declares
// are used: crypto.subtle.digest, crypto.getRandomValues, TextEncoder.
//
// The signature is HMAC-SHA256 (hand-built from the one hash primitive the mod
// VM offers) over a canonical encoding of the whole request. The owner key
// itself is never sent anywhere; an observer of one request learns nothing that
// lets it forge another, and cannot replay it (single-use nonce, bridge-process
// epoch, bounded timestamp).

export const CHANNEL_VERSION = 1;
/** The one private operation that returns the bridge epoch. It is signed like every other request, so an unauthenticated caller cannot even learn that a channel exists. */
export const CHANNEL_HELLO = 'ultra_native_hello';
/** Placeholder epoch for the signed hello: the caller cannot know the bridge's epoch until it has asked. */
export const HELLO_EPOCH = '0'.repeat(32);
export const CHANNEL_KEY_FILE = 'ultra-channel.key';
/** Authenticated caller, but the request names a previous bridge process. The mod re-opens its session. */
export const CHANNEL_STALE = 'ULTRA_CHANNEL_STALE';
/** Authenticated caller, but the durable session is not open on this bridge process. */
export const SESSION_CLOSED = 'ULTRA_SESSION_CLOSED';
/** Authenticated caller whose request is a replay or outside the clock window. Never retried. */
export const CHANNEL_REJECTED = 'ULTRA_CHANNEL_REJECTED';
/** The only text an unauthenticated caller can ever learn about a refusal. */
export const CHANNEL_DENIED = 'Native control channel request was not authenticated.';
const REQUEST_TAG = 'ultra-native/1/request';
const KEY_ID_TAG = 'ultra-native/1/key-id';
const encoder = new TextEncoder();

/** JSON-faithful canonical form: sorted keys, undefined/function members omitted, finite numbers only. */
export function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('Non-finite number in a signed request');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(item => item === undefined || typeof item === 'function' || typeof item === 'symbol' ? 'null' : canonicalJson(item)).join(',')}]`;
      const members = [];
      for (const key of Object.keys(value).sort()) {
        const item = value[key];
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
        members.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
      }
      return `{${members.join(',')}}`;
    }
    default: throw new Error(`Unsupported ${typeof value} in a signed request`);
  }
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 || /[^0-9a-f]/.test(hex)) throw new Error('Invalid hexadecimal value');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return bytes;
}
export function bytesToHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }

/** RFC 2104 HMAC over SHA-256 using only crypto.subtle.digest. */
export async function hmacSha256(keyBytes, messageBytes) {
  const block = 64;
  const key = keyBytes.length > block ? await sha256(keyBytes) : keyBytes;
  const inner = new Uint8Array(block + messageBytes.length), outer = new Uint8Array(block + 32);
  for (let i = 0; i < block; i++) { const byte = i < key.length ? key[i] : 0; inner[i] = byte ^ 0x36; outer[i] = byte ^ 0x5c; }
  inner.set(messageBytes, block);
  outer.set(await sha256(inner), block);
  return sha256(outer);
}

/** A 256-bit owner key as lowercase hex, or null. Rejects trivially low-entropy fabricated keys. */
export function parseChannelKey(text) {
  const match = /^\s*([0-9a-fA-F]{64})\s*$/.exec(typeof text === 'string' ? text : '');
  const hex = match?.[1].toLowerCase();
  return hex && new Set(hex).size >= 10 ? hex : null;
}
/** Stable, non-secret identifier of an owner key; stored with a mission so a rotated key cannot reopen it. */
export async function keyIdOf(keyHex) {
  return bytesToHex(await sha256(encoder.encode(`${KEY_ID_TAG}:${keyHex}`))).slice(0, 32);
}

/** Exactly what is signed. The bridge reproduces this from the parsed request. */
export function signedMessage({ epoch, nonce, ts, name, args }) {
  return canonicalJson({ tag: REQUEST_TAG, epoch, nonce, ts, name, args });
}
export function randomHex(bytes = 16) {
  const buffer = new Uint8Array(bytes); crypto.getRandomValues(buffer); return bytesToHex(buffer);
}
/** Returns the request arguments with the authentication envelope attached. */
export async function signRequest({ keyHex, epoch, name, args, now = Date.now(), nonce = randomHex(16) }) {
  const plain = JSON.parse(JSON.stringify(args ?? {}));
  if (!plain || typeof plain !== 'object' || Array.isArray(plain) || Object.hasOwn(plain, 'channel')) throw new Error('Invalid native request arguments');
  const ts = Math.trunc(now);
  const mac = bytesToHex(await hmacSha256(hexToBytes(keyHex), encoder.encode(signedMessage({ epoch, nonce, ts, name, args: plain }))));
  return { ...plain, channel: { v: CHANNEL_VERSION, epoch, nonce, ts, mac } };
}

/**
 * Where the owner key file lives, from already-read environment values, so the
 * mod and the bridge agree. An explicit file or state directory wins; otherwise
 * the platform default state directory is used. Returns null when undecidable.
 */
export function modKeyPath({ file, state, localAppData, userProfile, xdgState, home, windows } = {}) {
  const usable = value => typeof value === 'string' && value.trim() && !value.includes('${user_config.') ? value.trim() : null;
  const join = (...parts) => parts.map((part, i) => i ? part.replace(/^[\\/]+/, '') : part.replace(/[\\/]+$/, '')).join('/');
  if (usable(file)) return usable(file);
  if (usable(state)) return join(usable(state), CHANNEL_KEY_FILE);
  if (windows) { const base = usable(localAppData) ?? usable(userProfile); return base ? join(base, 'ClaudeOpenAIWorkers', CHANNEL_KEY_FILE) : null; }
  const base = usable(xdgState) ?? (usable(home) ? join(usable(home), '.local', 'state') : null);
  return base ? join(base, 'claude-openai-workers', CHANNEL_KEY_FILE) : null;
}
