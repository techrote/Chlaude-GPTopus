// Shared harness helper (not a test file). It routes a mod's `$.mcp.call` to a
// NativeController through the PRODUCTION authenticator (NativeChannel /
// NativeGateway), instead of asserting trust with a flag, so the legitimate flows
// in the hook/controller suites exercise the real owner-key verification. The
// owner key never leaves this object except as the file content the mod reads.
import { randomBytes } from 'node:crypto';
import { NativeChannel, NativeGateway } from '../bridge/native-channel.mjs';
import { signRequest, CHANNEL_HELLO, HELLO_EPOCH } from '../hooks/channel.js';

export function nativeTransport(controller, { keyHex = randomBytes(32).toString('hex'), keyPath = '/synthetic/owner/ultra-channel.key', now } = {}) {
  const channel = new NativeChannel({ key: Buffer.from(keyHex, 'hex'), ...(now && { now }) });
  const gateway = new NativeGateway(channel, { controller });
  const signed = async (name, args) => gateway.call(name, await signRequest({ keyHex, epoch: channel.epoch, name, args, ...(now && { now: now() }) }));
  return {
    keyHex, keyPath, channel, gateway, signed,
    /** Values the mod reads through $.env.get / $.fs.read. */
    env: name => name === 'OPENAI_ULTRA_CHANNEL_KEY_FILE' ? keyPath : undefined,
    read: async path => { if (path === keyPath) return `${keyHex}\n`; throw new Error('ENOENT'); },
    /** What $.mcp.call does for a private operation. */
    call: async (name, args) => gateway.call(name, args),
  };
}

/** Sign requests for the in-process `dispatch` entry point (the real bridge dispatcher). */
export function signedDispatcher(dispatch, options, keyHex) {
  return async (name, args) => {
    const { epoch } = await dispatch(CHANNEL_HELLO, await signRequest({ keyHex, epoch: HELLO_EPOCH, name: CHANNEL_HELLO, args: {} }), options);
    return dispatch(name, await signRequest({ keyHex, epoch, name, args }), options);
  };
}
