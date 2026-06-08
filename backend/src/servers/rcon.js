// Live command transport (Phase 3). CS2 and Factorio both speak the Source RCON
// protocol (CS2 on the game TCP port 27015; Factorio on rcon-port 27015), so we
// run a tiny embedded Source-RCON client in the guest via the QEMU guest agent.
//
// Safety: the command text is passed as a single argv element (never through a
// shell, so it can't break out), and the password is passed on stdin
// (input-data), so it never appears in argv or the process list. Minecraft has
// no RCON here and uses tmux instead (see MinecraftConnector).

// Embedded client. `\\n`/`\\x00` are escaped so the JS string carries the literal
// Python escapes. Reads password from stdin, takes host/port/command as argv.
export const RCON_PY = `import sys, socket, struct
host = sys.argv[1]; port = int(sys.argv[2])
command = sys.argv[3] if len(sys.argv) > 3 else ""
password = sys.stdin.read().split("\\n")[0]
def pkt(i, t, body):
    p = struct.pack("<ii", i, t) + body.encode("utf-8") + b"\\x00\\x00"
    return struct.pack("<i", len(p)) + p
def readpkt(s):
    ln = b""
    while len(ln) < 4:
        c = s.recv(4 - len(ln))
        if not c: raise EOFError("closed")
        ln += c
    n = struct.unpack("<i", ln)[0]
    d = b""
    while len(d) < n:
        c = s.recv(n - len(d))
        if not c: break
        d += c
    rid, rtyp = struct.unpack("<ii", d[:8])
    return rid, rtyp, d[8:-2].decode("utf-8", "replace")
try:
    s = socket.create_connection((host, port), timeout=8)
except Exception as e:
    sys.exit("rcon: connect failed: %s" % e)
s.settimeout(8)
s.sendall(pkt(1, 3, password))
try:
    while True:
        rid, rtyp, body = readpkt(s)
        if rtyp == 2: break
except EOFError:
    sys.exit("rcon: connection closed")
if rid == -1:
    sys.exit("rcon: auth failed")
if command:
    s.sendall(pkt(2, 2, command))
    out = []
    s.settimeout(1.5)  # first reply; many commands (exec, sv_*) send none
    try:
        while True:
            rid, rtyp, body = readpkt(s)
            out.append(body)
            s.settimeout(0.3)  # drain any follow-up packets, then stop on quiet
    except Exception:
        pass
    sys.stdout.write("".join(out))
s.close()`;

const PYTHON = '/usr/bin/python3';

/** Validate a user-supplied live command. Returns the trimmed command. */
export function validateLiveCommand(command) {
  const c = String(command ?? '').trim();
  if (!c) { const e = new Error('command is required'); e.code = 'BAD_SETTING'; throw e; }
  if (c.length > 512) { const e = new Error('command too long (max 512 chars)'); e.code = 'BAD_SETTING'; throw e; }
  if (/[\r\n]/.test(c)) { const e = new Error('command may not contain newlines'); e.code = 'BAD_SETTING'; throw e; }
  return c;
}

/**
 * Run one RCON command in-guest and return its text output.
 * @param {import('./connectors/base.js').BaseConnector} connector
 * @returns {Promise<{ output: string }>}
 */
export async function rconCommand(connector, { host = '127.0.0.1', port, password, command, timeoutMs = 15_000 }) {
  if (!password) { const e = new Error('rcon password is not configured'); e.code = 'NO_RCON'; throw e; }
  // command is an argv element (no shell); password goes on stdin.
  const argv = [PYTHON, '-c', RCON_PY, host, String(port), command ?? ''];
  const res = await connector.runCommand(argv, { input: password, timeoutMs });
  if (res.exitCode !== 0) {
    const msg = (res.stderr || res.stdout || 'rcon command failed').trim();
    const e = new Error(msg);
    e.code = /auth/i.test(msg) ? 'RCON_AUTH' : 'RCON_ERROR';
    throw e;
  }
  return { output: res.stdout ?? '' };
}
