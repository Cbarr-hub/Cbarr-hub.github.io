// Minimal Source-RCON client over a raw TCP socket, for talking to a game server
// the app can reach directly (e.g. a Minecraft container on the compose network).
//
// This is the Docker-world counterpart to rcon.js's in-guest python helper: there
// the app has no network path to the server's RCON port and must exec inside the
// VM; here the container's RCON port is reachable by service name, so we speak the
// protocol straight from Node.
//
// Source RCON packet (little-endian): int32 size | int32 id | int32 type |
// ASCII body + NUL | NUL.  type 3 = auth, 2 = exec / auth-response, 0 = response.

import net from 'node:net';

function encode(id, type, body) {
  const bodyBuf = Buffer.from(body, 'ascii');
  const size = 4 + 4 + bodyBuf.length + 2; // id + type + body + two NULs
  const buf = Buffer.allocUnsafe(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf.writeInt8(0, 12 + bodyBuf.length);
  buf.writeInt8(0, 13 + bodyBuf.length);
  return buf;
}

/**
 * Authenticate, run one command, and resolve its (possibly multi-packet) text
 * response. A trailing empty "sentinel" command marks where the response ends,
 * the standard trick for reassembling responses split across packets.
 *
 * @returns {Promise<string>}
 */
export function rconExchange({ host, port = 25575, password, command, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    if (!password) { reject(rconErr('RCON password is not set')); return; }

    const AUTH_ID = 1, CMD_ID = 2, END_ID = 3;
    const socket = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let authed = false;
    let out = '';
    let idle = null;
    let settled = false;

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      socket.destroy();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(rconErr(`RCON timeout after ${timeoutMs}ms`)), timeoutMs);

    socket.on('connect', () => socket.write(encode(AUTH_ID, 3, password)));
    socket.on('error', (e) => finish(rconErr(`RCON connection failed: ${e.message}`)));
    socket.on('end', () => finish(authed ? null : rconErr('RCON closed before auth'), out));

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0);
        if (buf.length < 4 + size) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.toString('ascii', 12, 4 + size - 2); // strip the two NULs
        buf = buf.subarray(4 + size);

        if (!authed) {
          if (id === -1) { finish(rconErr('RCON auth failed (bad password)')); return; }
          if (type === 2) {
            authed = true;
            socket.write(encode(CMD_ID, 2, command));
            socket.write(encode(END_ID, 2, '')); // sentinel: its echo ends the response
            // Fallback for servers that DON'T echo the empty sentinel (e.g. Factorio):
            // finish once the response stream has gone quiet.
            idle = setTimeout(() => finish(null, out), 700);
          }
          continue;
        }
        if (id === END_ID) { finish(null, out); return; }
        out += body;
        clearTimeout(idle);
        idle = setTimeout(() => finish(null, out), 700);
      }
    });
  });
}

function rconErr(message) {
  const e = new Error(message);
  e.code = 'NO_RCON';
  return e;
}
