/**
 * Transport-level authentication for the private native ULTRA control channel.
 *
 * MCP over stdio carries no caller identity: a model tool call, a settings
 * hook, another mod and the ULTRA mod itself arrive on one connection with the
 * same shape, and a second process can simply run its own server. Reaching the
 * dispatcher therefore proves nothing. Every `ultra_native_*` request must
 * carry proof that its sender holds the OWNER CHANNEL KEY: a 256-bit secret in a
 * private file of the owner state directory, which only the installed mod reads.
 * The proof is an HMAC over the whole request (see hooks/channel.js) bound to this
 * process's random epoch and a single-use nonce, so an observed request or leaked
 * capability is useless to anyone else. Nothing is trusted on the caller's word:
 * model, session id, version and platform are caller claims inside a signed
 * request, never authority by themselves.
 *
 * Fail closed: no key, a malformed or over-permissive key file, or ULTRA not
 * enabled yields the same uniform refusal for every caller. Specific reasons go
 * only to the server's own stderr (never any secret) and, after authentication,
 * to the authenticated caller.
 */
import { createHmac, randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ownerPaths } from '../ultra/service.mjs';
import { CHANNEL_VERSION, CHANNEL_HELLO, CHANNEL_KEY_FILE, CHANNEL_STALE, CHANNEL_REJECTED, CHANNEL_DENIED, parseChannelKey, signedMessage } from '../hooks/channel.js';

export const NOT_MEDIATED = 'Native controller is available only on the mediated native host channel';
const HEX32 = /^[0-9a-f]{32}$/, HEX64 = /^[0-9a-f]{64}$/;
const MAX_REQUEST_CHARS = 4_000_000;

/** Uniform refusal for any caller that has not proven possession of the owner key. */
export class ChannelDenied extends Error {
  constructor() { super(CHANNEL_DENIED); this.name = 'ChannelDenied'; }
}
const reported = new Set();
function diagnose(reason) {
  // Owner-facing, once per distinct reason, never a secret and never the key path contents.
  if (reported.has(reason)) return; reported.add(reason);
  process.stderr.write(`[openai-workers] native ULTRA channel unavailable: ${reason}\n`);
}

/** The key file: OPENAI_ULTRA_CHANNEL_KEY_FILE, else <owner state directory>/ultra-channel.key. */
export function keyFilePath(env = process.env) {
  const configured = env.OPENAI_ULTRA_CHANNEL_KEY_FILE;
  return typeof configured === 'string' && configured.trim() && !configured.includes('${user_config.') ? resolve(configured.trim()) : join(ownerPaths(env).base, CHANNEL_KEY_FILE);
}
export const keyIdOfBuffer = key => createHash('sha256').update(`ultra-native/1/key-id:${key.toString('hex')}`).digest('hex').slice(0, 32);

/** Reads and validates the owner key. Throws a diagnostic Error (never shown to a caller). */
export async function loadChannelKey(env = process.env, { platform = process.platform, uid = process.getuid?.() } = {}) {
  const path = keyFilePath(env);
  let info;
  try { info = await lstat(path); }
  catch (error) { throw new Error(error.code === 'ENOENT' ? `no owner channel key at ${path}; run scripts/provision-ultra-channel.mjs` : `owner channel key is not accessible (${error.code})`); }
  if (!info.isFile()) throw new Error('owner channel key is not a regular file');
  if (info.size > 256) throw new Error('owner channel key file is oversized');
  if (platform !== 'win32') {
    if ((info.mode & 0o077) !== 0) throw new Error('owner channel key file is readable by other users; chmod 600 it or re-provision');
    if (typeof uid === 'number' && info.uid !== uid) throw new Error('owner channel key file belongs to another user');
  }
  const hex = parseChannelKey(await readFile(path, 'utf8'));
  if (!hex) throw new Error('owner channel key file is malformed (expected 64 hexadecimal characters of random data)');
  const key = Buffer.from(hex, 'hex');
  return { path, key, keyId: keyIdOfBuffer(key) };
}

/** Creates the owner key (mode 0600, never overwritten unless rotate). Returns the path, never the key. */
export async function provisionChannelKey(env = process.env, { rotate = false } = {}) {
  const path = keyFilePath(env), text = `${randomBytes(32).toString('hex')}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!rotate) {
    try { await writeFile(path, text, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('An owner channel key already exists. Re-run with --rotate to replace it; that closes every open native session.');
      throw error;
    }
    return { path, created: true, rotated: false };
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, text, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
  return { path, created: false, rotated: true };
}

const minted = new WeakMap(); // verified-request token -> { channel, name, payload, used }

/**
 * One bridge process's authenticator. The epoch is random per instance, so a
 * request signed for a previous process is recognisable as stale and a captured
 * request can never be replayed into a new process.
 */
export class NativeChannel {
  constructor({ key, now = () => Date.now(), windowMs = 120000, maxNonces = 20000 } = {}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 32-byte owner channel key is required');
    this.key = Buffer.from(key); this.keyId = keyIdOfBuffer(this.key); this.epoch = randomBytes(16).toString('hex');
    this.now = now; this.windowMs = windowMs; this.maxNonces = maxNonces; this.nonces = new Map();
  }
  /** Answer to a SIGNED hello: lets the key holder learn this process's epoch. Nothing is answered unauthenticated. */
  hello() { return { v: CHANNEL_VERSION, epoch: this.epoch }; }
  /**
   * Authenticate one request. Every failure of proof throws the same uniform
   * error; only a caller that already proved possession of the key can learn
   * that it was merely stale, replayed or out of the clock window.
   */
  verify(name, args) {
    if (typeof name !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new ChannelDenied();
    const { channel: envelope, ...payload } = args;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new ChannelDenied();
    const { v, epoch, nonce, ts, mac, ...unknown } = envelope;
    if (v !== CHANNEL_VERSION || Object.keys(unknown).length || !HEX32.test(epoch ?? '') || !HEX32.test(nonce ?? '') || !Number.isSafeInteger(ts) || !HEX64.test(mac ?? '')) throw new ChannelDenied();
    let message;
    try { message = signedMessage({ epoch, nonce, ts, name, args: payload }); } catch { throw new ChannelDenied(); }
    if (message.length > MAX_REQUEST_CHARS) throw new ChannelDenied();
    const expected = createHmac('sha256', this.key).update(message).digest(), supplied = Buffer.from(mac, 'hex');
    if (!timingSafeEqual(expected, supplied)) throw new ChannelDenied();
    // Authenticated from here on.
    if (epoch !== this.epoch && name !== CHANNEL_HELLO) throw new Error(`${CHANNEL_STALE}: the request was signed for a previous bridge process; reopen the native session`);
    const now = this.now();
    if (Math.abs(now - ts) > this.windowMs) throw new Error(`${CHANNEL_REJECTED}: request timestamp is outside the ${this.windowMs / 1000}s window`);
    for (const [seen, expires] of this.nonces) { if (expires > now) break; this.nonces.delete(seen); }
    if (this.nonces.has(nonce)) throw new Error(`${CHANNEL_REJECTED}: replayed request`);
    if (this.nonces.size >= this.maxNonces) throw new Error(`${CHANNEL_REJECTED}: replay window is saturated`);
    this.nonces.set(nonce, now + 2 * this.windowMs);
    const verified = Object.freeze({ kind: 'ultra-native-verified-request' });
    minted.set(verified, { channel: this, name, payload, used: false });
    return { verified, payload };
  }
  /**
   * Controller side: consume the token that verify() minted for exactly this
   * operation and argument object. A boolean, a lookalike object, another
   * channel's token or a reused token cannot satisfy this.
   */
  admit(verified, name, payload) {
    const record = verified && typeof verified === 'object' ? minted.get(verified) : undefined;
    if (!record || record.channel !== this || record.used || record.name !== name || record.payload !== payload) throw new Error(NOT_MEDIATED);
    record.used = true;
    return { epoch: this.epoch, keyId: this.keyId };
  }
}

/**
 * Authenticator plus controller routing. The controller is created lazily and
 * only for an authenticated request, so an unauthenticated caller cannot make
 * the bridge read owner policy, open the ledger or build any ULTRA service.
 */
export class NativeGateway {
  constructor(channel, { controller } = {}) { this.channel = channel; this.fixed = controller ?? null; this.fixed?.bindChannel(channel); }
  async call(name, args, controllerFor) {
    const { verified, payload } = this.channel.verify(name, args);
    if (name === CHANNEL_HELLO) return this.channel.hello();
    const controller = this.fixed ?? await controllerFor(this.channel);
    controller.bindChannel(this.channel);
    return controller.handle(name, payload, { verified });
  }
}

/**
 * Process-wide registry entry for the current owner key. The key is re-read on
 * every request, so deleting or rotating the file revokes the channel at once
 * and a new key starts a new epoch (closing every open native session).
 */
export async function openNativeChannel(env, registry) {
  const path = keyFilePath(env);
  if (env.OPENAI_ULTRA_ENABLED !== '1') throw new ChannelDenied();
  let loaded;
  try { loaded = await loadChannelKey(env); }
  catch (error) { registry.delete(path); diagnose(`${error.message} [${path}]`); throw new ChannelDenied(); }
  const existing = registry.get(path);
  if (existing?.keyId === loaded.keyId) return existing.gateway;
  const gateway = new NativeGateway(new NativeChannel({ key: loaded.key }));
  registry.set(path, { keyId: loaded.keyId, gateway });
  return gateway;
}
