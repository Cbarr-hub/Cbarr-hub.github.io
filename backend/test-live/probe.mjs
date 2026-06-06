// Ad-hoc live RCON probe: send arbitrary commands to one game and print the output.
// Run in the app container (has DOCKER_HOST + RCON env + network):
//   docker cp backend/test-live/probe.mjs cbarr-hubgithubio-app-1:/app/probe.mjs
//   docker exec cbarr-hubgithubio-app-1 node /app/probe.mjs gmod "sv_maxspeed" "sv_airaccelerate"
import { DockerClient } from './src/docker/client.js';
import { buildConnectors } from './src/servers/connectors/index.js';

const [game, ...cmds] = process.argv.slice(2);
const docker = new DockerClient({ host: process.env.DOCKER_HOST });
const conns = buildConnectors({ docker }, null);
const conn = conns.get(game);
if (!conn) { console.error(`unknown game: ${game}`); process.exit(2); }

for (const c of cmds) {
  try {
    const r = await conn.sendCommand(c);
    console.log(`[ok ] ${c}\n      → ${String(r?.output ?? '').replace(/\r?\n/g, '\n        ').trim() || '(no output)'}`);
  } catch (e) { console.log(`[ERR] ${c} → ${e.message}`); }
}
process.exit(0);
