import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';

import { rconExchange } from '../src/servers/rcon-tcp.js';

function encodeRcon(id, type, body) {
  const b = Buffer.from(body, 'ascii');
  const size = 4 + 4 + b.length + 2;
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
