// Dockerized Prop Hunt connector — the X2Z gamemode in a LinuxGSM gmodserver
// container. Applies the shared GMOD-family Docker overrides (dockerizeGmod) on top
// of PropHuntConnector, so all the PH specifics (ph_ map list, X2Z cvars, the
// gamertown/active.cfg escape hatch, the curated live actions) are inherited; only
// the container locator, lifecycle, and TCP RCON differ.

import { dockerizeGmod } from './gmod.js';
import { PropHuntConnector } from '../prophunt.js';

export class DockerPropHuntConnector extends dockerizeGmod(PropHuntConnector) {
  rconEnvKey = 'PROPHUNT_RCON_PASSWORD';
}
