import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';

import { rconExchange } from '../src/servers/rcon-tcp.js';

function encodeRcon(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const size = 4 + 4 + b.length + 2; // size is the utf8 byte length, so the frame stays valid for multibyte bodies
  const buf = Buffer.allocUnsafe(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  buf.writeInt8(0, 12 + b.length);
  buf.writeInt8(0, 13 + b.length);
  return buf;
}

async function withServer(handler, run) {
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    handler(sock);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(port);
  } finally {
    for (const sock of sockets) sock.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('rconExchange reports missing password as NO_RCON', async () => {
  await assert.rejects(
    () => rconExchange({ host: '127.0.0.1', port: 1, password: '', command: 'status', timeoutMs: 10 }),
    (e) => e.code === 'NO_RCON',
  );
});

test('rconExchange reports bad password as RCON_AUTH', async () => {
  await withServer((sock) => {
    sock.once('data', () => sock.write(encodeRcon(-1, 2, '')));
  }, async (port) => {
    await assert.rejects(
      () => rconExchange({ host: '127.0.0.1', port, password: 'bad', command: 'status', timeoutMs: 200 }),
      (e) => e.code === 'RCON_AUTH',
    );
  });
});

test('rconExchange reports timeouts as RCON_ERROR', async () => {
  await withServer(() => {}, async (port) => {
    await assert.rejects(
      () => rconExchange({ host: '127.0.0.1', port, password: 'pw', command: 'status', timeoutMs: 20 }),
      (e) => e.code === 'RCON_ERROR',
    );
  });
});

// Reassemble the client's incoming RCON packets from a socket and invoke `onPacket`
// per fully-framed packet (so the fake server can react to the exec packet, id===2).
function onRconPackets(sock, onPacket) {
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const size = buf.readInt32LE(0);
      if (buf.length < 4 + size) break;
      const id = buf.readInt32LE(4);
      const type = buf.readInt32LE(8);
      buf = buf.subarray(4 + size);
      onPacket(id, type);
    }
  });
}

// FINDING A: a slow first response packet (>700ms) must NOT resolve to '' — the
// first-byte grace (min(timeoutMs, 3000)) keeps the exchange open until data flows.
test('rconExchange waits past 700ms for a slow first response packet (sentinel server)', async () => {
  const body = 'There are 2 of a max of 20 players online: dheagman, Alex_2';
  await withServer((sock) => {
    onRconPackets(sock, (id) => {
      if (id === 1) sock.write(encodeRcon(1, 2, '')); // auth-ok
      else if (id === 2) {
        // The exec packet: stall ~800ms (past the old 700ms idle window) before replying.
        setTimeout(() => {
          sock.write(encodeRcon(2, 0, body));
          sock.write(encodeRcon(3, 0, '')); // END_ID sentinel echo
        }, 800);
      }
    });
  }, async (port) => {
    const out = await rconExchange({ host: '127.0.0.1', port, password: 'pw', command: 'status', timeoutMs: 5000 });
    assert.equal(out, body);
  });
});

// FINDING A: same slow first packet, but a Factorio-style server that never echoes the
// END_ID sentinel — must still resolve to the body via the post-data idle window.
test('rconExchange waits past 700ms for a slow first response packet (no-echo/Factorio server)', async () => {
  const body = 'There are 2 of a max of 20 players online: dheagman, Alex_2';
  await withServer((sock) => {
    onRconPackets(sock, (id) => {
      if (id === 1) sock.write(encodeRcon(1, 2, '')); // auth-ok
      else if (id === 2) {
        setTimeout(() => sock.write(encodeRcon(2, 0, body)), 800); // no END_ID echo
      }
    });
  }, async (port) => {
    const out = await rconExchange({ host: '127.0.0.1', port, password: 'pw', command: 'status', timeoutMs: 5000 });
    assert.equal(out, body);
  });
});

// FINDING B: multibyte UTF-8 names must round-trip exactly (no ASCII '?' substitution
// or truncation) — CS2 status names are name-keyed in the session tracker.
test('rconExchange preserves multibyte UTF-8 response bodies', async () => {
  const body = 'José Ångström';
  await withServer((sock) => {
    onRconPackets(sock, (id) => {
      if (id === 1) sock.write(encodeRcon(1, 2, '')); // auth-ok
      else if (id === 2) {
        sock.write(encodeRcon(2, 0, body));
        sock.write(encodeRcon(3, 0, '')); // END_ID sentinel echo
      }
    });
  }, async (port) => {
    const out = await rconExchange({ host: '127.0.0.1', port, password: 'pw', command: 'status', timeoutMs: 2000 });
    assert.equal(out, body);
  });
});
