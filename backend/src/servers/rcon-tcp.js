// Minimal Source-RCON client over a raw TCP socket, for talking to a game server
// the app can reach directly (e.g. a Minecraft container on the compose network).
//
// This is the Docker-world counterpart to rcon.js's in-guest python helper: there
// the app has no network path to the server's RCON port and must exec inside the
// VM; here the container's RCON port is reachable by service name, so we speak the
// protocol straight from Node.
//
// Source RCON packet (little-endian): int32 size | int32 id | int32 type |
// UTF-8 body + NUL | NUL.  type 3 = auth, 2 = exec / auth-response, 0 = response.

import net from 'node:net';

function encode(id, type, body) {
  const bodyBuf = Buffer.from(body, 'utf8');
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
 * the standard trick for reassembling responses split across packets: we send the
 * real command (id=CMD_ID) immediately followed by an empty command (id=END_ID),
 * and once the server's response to that empty command comes back (a packet with
 * id===END_ID) we know every fragment of the real response has arrived. For servers
 * that DON'T echo the empty sentinel (Factorio), an idle timer finishes the exchange
 * instead, so we never hang waiting for an echo that won't come: it grants the first
 * response packet min(timeoutMs, 3000)ms of grace, then tightens to 700ms of
 * inter-packet quiet once data is flowing.
 *
 * Error codes (on the rejected Error's `.code`):
 *   NO_RCON    — no password configured (rejects before connecting)
 *   RCON_AUTH  — auth packet returned id===-1 (bad password)
 *   RCON_ERROR — socket error, closed-before-auth, or the overall timeout fired
 *
 * @returns {Promise<string>}
 */
export function rconExchange({ host, port = 25575, password, command, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    if (!password) { reject(rconErr('RCON password is not set', 'NO_RCON')); return; }

    const AUTH_ID = 1, CMD_ID = 2, END_ID = 3;
    const socket = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let authed = false;
    let out = '';
    let gotData = false; // any response packet seen after auth
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
    const timer = setTimeout(() => finish(rconErr(`RCON timeout after ${timeoutMs}ms`, 'RCON_ERROR')), timeoutMs);

    socket.on('connect', () => socket.write(encode(AUTH_ID, 3, password)));
    socket.on('error', (e) => finish(rconErr(`RCON connection failed: ${e.message}`, 'RCON_ERROR')));
    // A normal exchange resolves via the END_ID sentinel (or the idle timer for
    // Factorio), so 'end' only fires unsettled when the peer closed early. Resolve
    // only if we authed AND actually received response data; otherwise the peer
    // dropped mid-exchange (crash/restart/kick) — reject instead of returning a
    // phantom empty success that masks the failure.
    socket.on('end', () => finish(
      authed && gotData ? null : rconErr(authed ? 'RCON connection closed before a response' : 'RCON closed before auth', 'RCON_ERROR'),
      out,
    ));

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0);
        // A valid packet is at least 10 bytes (id+type+two NULs) and Source caps
        // responses near 4KB; anything wildly out of range means we're misframed
        // (garbage, or a non-Source service on this port) — fail fast instead of
        // desyncing the stream and hanging until the overall timeout.
        if (size < 10 || size > 4 * 1024 * 1024) { finish(rconErr('RCON framing error (bad packet size)', 'RCON_ERROR')); return; }
        if (buf.length < 4 + size) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.toString('utf8', 12, 4 + size - 2); // strip the two NULs
        buf = buf.subarray(4 + size);

        if (!authed) {
          if (id === -1) { finish(rconErr('RCON auth failed (bad password)', 'RCON_AUTH')); return; }
          if (type === 2) {
            authed = true;
            socket.write(encode(CMD_ID, 2, command));
            socket.write(encode(END_ID, 2, '')); // sentinel: its echo ends the response
            // FIRST-BYTE GRACE: before any response packet arrives, wait up to
            // min(timeoutMs, 3000)ms — a slow first byte (busy container, multi-step
            // apply batch, scheduler jitter) must NOT resolve to an empty body. Once
            // data flows, the post-auth branch below shrinks this to the 700ms
            // inter-packet quiet window (which also finishes no-echo servers like
            // Factorio). A truly silent command falls back to the overall timeout.
            idle = setTimeout(() => finish(null, out), Math.min(timeoutMs, 3000));
          }
          continue;
        }
        if (id === END_ID) { finish(null, out); return; }
        out += body;
        gotData = true;
        clearTimeout(idle);
        idle = setTimeout(() => finish(null, out), 700);
      }
    });
  });
}

function rconErr(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}
