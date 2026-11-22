/**
 * Minimal RFC 6455 WebSocket server side (text frames only, no extensions),
 * for the local config panel. No dependencies. The caller authenticates the
 * upgrade request (token + Host/Origin) before calling acceptUpgrade.
 */
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE = 64 * 1024;

export function acceptKey(key) { return createHash('sha1').update(String(key) + GUID).digest('base64'); }

export function encodeFrame(text, opcode = 1) {
  const payload = Buffer.from(String(text), 'utf8'), n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
    : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, payload]);
}

/** Parse complete client frames from buf. Returns { frames, rest } or throws on protocol errors. */
export function decodeFrames(buf) {
  const frames = []; let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1], fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, p = off + 2;
    if (!masked) throw new Error('Client frames must be masked');
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; const big = buf.readBigUInt64BE(p); if (big > BigInt(MAX_MESSAGE)) throw new Error('Frame too large'); len = Number(big); p += 8; }
    if (len > MAX_MESSAGE) throw new Error('Frame too large');
    if (buf.length - p < 4 + len) break;
    const mask = buf.subarray(p, p + 4); p += 4;
    const data = Buffer.alloc(len);
    for (let i = 0; i < len; i++) data[i] = buf[p + i] ^ mask[i & 3];
    frames.push({ fin, opcode, data });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** Complete the handshake on an authenticated upgrade; returns a tiny connection object. */
export function acceptUpgrade(req, socket, { onMessage = () => {}, onClose = () => {} } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return null; }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  let buf = Buffer.alloc(0), parts = [], closed = false;
  const conn = {
    send(obj) { if (!closed) try { socket.write(encodeFrame(typeof obj === 'string' ? obj : JSON.stringify(obj))); } catch { /* peer gone */ } },
    close() { if (closed) return; closed = true; try { socket.end(encodeFrame('', 8)); } catch {} onClose(); },
    get closed() { return closed; },
  };
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > MAX_MESSAGE * 2) return conn.close();
    let out;
    try { out = decodeFrames(buf); } catch { return conn.close(); }
    buf = out.rest;
    for (const f of out.frames) {
      if (f.opcode === 8) return conn.close();
      if (f.opcode === 9) { try { socket.write(Buffer.concat([Buffer.from([0x8a, f.data.length]), f.data])); } catch {} continue; }
      if (f.opcode === 1 || f.opcode === 0) {
        parts.push(f.data);
        if (f.fin) { const text = Buffer.concat(parts).toString('utf8'); parts = []; if (text.length <= MAX_MESSAGE) onMessage(text); }
      }
    }
  });
  socket.on('close', () => { if (!closed) { closed = true; onClose(); } });
  socket.on('error', () => { if (!closed) { closed = true; onClose(); } });
  return conn;
}
