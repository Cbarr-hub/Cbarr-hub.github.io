// GOLDEN TABLES — the pinned per-game behavioral canon for the five Docker game
// connectors, asserted by connector-goldens.test.mjs.
//
// These tables were transcribed from the CURRENT connectors (the code is canon);
// the declarative engine that replaces them must reproduce byte-identical
// behavior to keep this suite green. Every value below is a LITERAL — never
// import an action/command map from production code into this file, or the
// goldens stop pinning anything.
//
// Shape of one entry:
//   id              registry id (also the server-row id)
//   build           (row, client, store) -> the connector under test
//   serverRow       the registry-shaped row the per-game tests construct
//                   (container is swapped for '127.0.0.1' by the RCON capture)
//   rcon            { passwordSource: {env}|{file}, port: 'server.port'|'server.rconPort' }
//   getLiveGate     { reason } — getLive()'s unavailable report when creds are missing
//   configFiles     exact logical-name -> in-container path whitelist
//   liveActions     EVERY advertised action key -> its exact RCON command
//   liveControls    EVERY advertised control key, with samples: in-range,
//                   below-min clamp, above-max clamp (+ empty-input default
//                   where the per-game tests pinned it) -> exact commands
//   changeMap       [{ value, cmd }] samples, or null when the game has none
//   sendCommand     { input, cmd } — the trim/forward sample
//   profileDefaults exact defaultProfileSettings() document
//   schemaGroups    profileSchema() group keys in order + each group's field
//                   keys + which fields carry basic:true
//   update          { kind:'exec', argv, timeoutMs } | { kind:'reboot' }

import { buildConnector } from '../src/servers/connectors/engine.js';
import { factorioSpec } from '../src/servers/connectors/specs/factorio.js';
import { minecraftSpec } from '../src/servers/connectors/specs/minecraft.js';
import { counterstrikeSpec } from '../src/servers/connectors/specs/counterstrike.js';
import { gmodSpec } from '../src/servers/connectors/specs/gmod.js';
import { prophuntSpec } from '../src/servers/connectors/specs/prophunt.js';

export const GOLDENS = [
  // ── GMOD (TTT) ────────────────────────────────────────────────────────────────
  {
    id: 'gmod',
    build: (row, client, store) => buildConnector(row, gmodSpec, client, store),
    serverRow: { id: 'gmod', name: 'TTT', backend: 'docker', container: 'gmod', port: 27066 },
    rcon: { passwordSource: { env: 'GMOD_RCON_PASSWORD' }, port: 'server.port' },
    getLiveGate: { reason: 'RCON disabled — set rcon_password in server.cfg and restart' },
    configFiles: {
      'server.cfg':      '/data/serverfiles/garrysmod/cfg/gmodserver.cfg',
      'mapcycle.txt':    '/data/serverfiles/garrysmod/mapcycle.txt',
      'lgsm.cfg':        '/data/lgsm/config-lgsm/gmodserver/gmodserver.cfg',
      'lgsm-common.cfg': '/data/lgsm/config-lgsm/gmodserver/common.cfg',
    },
    liveActions: [
      { key: 'restart_round', cmd: 'ttt_roundrestart' },
      { key: 'cleanup',       cmd: 'gmod_admin_cleanup' },
      { key: 'bhop_on',       cmd: 'sv_cheats 1; sv_airaccelerate 1000' },
      { key: 'bhop_off',      cmd: 'sv_airaccelerate 12' },
      { key: 'alltalk_on',    cmd: 'sv_alltalk 1' },
      { key: 'alltalk_off',   cmd: 'sv_alltalk 0' },
      { key: 'proximity_on',  cmd: 'ttt_locational_voice 1; sv_alltalk 0' },
      { key: 'proximity_off', cmd: 'ttt_locational_voice 0; sv_alltalk 1' },
      { key: 'cheats_on',     cmd: 'sv_cheats 1' },
      { key: 'cheats_off',    cmd: 'sv_cheats 0' },
      { key: 'players',       cmd: 'status' },
    ],
    liveControls: [
      { key: 'gravity', samples: [
        { value: 600,   cmd: 'sv_gravity 600' },
        { value: -1,    cmd: 'sv_gravity 0' },
        { value: 99999, cmd: 'sv_gravity 1000' },
      ] },
      { key: 'timescale', samples: [
        { value: 1,  cmd: 'sv_cheats 1; host_timescale 1' },
        { value: 0,  cmd: 'sv_cheats 1; host_timescale 0.25' },
        { value: 99, cmd: 'sv_cheats 1; host_timescale 3' },
      ] },
      { key: 'traitor_pct', samples: [
        { value: 0.25, cmd: 'ttt_traitor_pct 0.25' },
        { value: 0,    cmd: 'ttt_traitor_pct 0.05' },
        { value: 99,   cmd: 'ttt_traitor_pct 0.5' },
      ] },
      { key: 'round_limit', samples: [
        { value: 6,  cmd: 'ttt_round_limit 6' },
        { value: 0,  cmd: 'ttt_round_limit 1' },
        { value: 99, cmd: 'ttt_round_limit 15' },
      ] },
    ],
    changeMap: [
      { value: 'ttt_minecraft_b5', cmd: 'changelevel ttt_minecraft_b5' },
      { value: 'gm_construct',     cmd: 'changelevel gm_construct' },
    ],
    sendCommand: { input: '  status  ', cmd: 'status' },
    profileDefaults: {
      maxPlayers: 16,
      workshopCollection: '3736674438',
      useMapcycle: '1',
      mapcycle: ['ttt_clue_se', 'ttt_diescraper', 'ttt_dolls', 'ttt_minecraft_b5', 'ttt_waterworld'],
      roundLimit: 6, timeLimit: 75, prepTime: 30, postTime: 30, haste: 1, hasteStart: 5,
      postroundDm: 0, allTalk: 1, proximityVoice: 0,
      traitorPct: 0.25, traitorMax: 32, detectivePct: 0.13, detectiveMax: 32,
      detMinPlayers: 5, minPlayers: 2, creditsStart: 2,
      karma: 1, karmaAutokick: 0, karmaBan: 0,
    },
    schemaGroups: [
      {
        key: 'map',
        fieldKeys: ['workshopCollection', 'syncMaps', 'mapcycle', 'useMapcycle'],
        basicKeys: ['workshopCollection', 'syncMaps', 'mapcycle', 'useMapcycle'],
      },
      {
        key: 'gameplay',
        fieldKeys: ['maxPlayers', 'roundLimit', 'timeLimit', 'prepTime', 'postTime', 'haste', 'hasteStart',
          'postroundDm', 'allTalk', 'proximityVoice', 'traitorPct', 'traitorMax', 'detectivePct', 'detectiveMax',
          'detMinPlayers', 'minPlayers', 'creditsStart', 'karma', 'karmaAutokick', 'karmaBan'],
        basicKeys: ['maxPlayers', 'roundLimit', 'prepTime', 'postTime', 'haste', 'proximityVoice', 'traitorPct',
          'detMinPlayers', 'minPlayers', 'creditsStart', 'karma'],
      },
    ],
    update: { kind: 'exec', argv: ['/bin/bash', '-lc', '/data/gmodserver update'], timeoutMs: 1_800_000 },
  },

  // ── Prop Hunt (X2Z) ───────────────────────────────────────────────────────────
  {
    id: 'prophunt',
    build: (row, client, store) => buildConnector(row, prophuntSpec, client, store),
    serverRow: { id: 'prophunt', name: 'Prop Hunt', backend: 'docker', container: 'prophunt', port: 27067 },
    rcon: { passwordSource: { env: 'PROPHUNT_RCON_PASSWORD' }, port: 'server.port' },
    getLiveGate: { reason: 'RCON disabled — set rcon_password in the game cfg and restart' },
    configFiles: {
      'server.cfg':      '/data/serverfiles/garrysmod/cfg/gmodserver.cfg',
      'mapcycle.txt':    '/data/serverfiles/garrysmod/mapcycle.txt',
      'lgsm.cfg':        '/data/lgsm/config-lgsm/gmodserver/gmodserver.cfg',
      'lgsm-common.cfg': '/data/lgsm/config-lgsm/gmodserver/common.cfg',
      'active.cfg':      '/data/serverfiles/garrysmod/cfg/gamertown/active.cfg',
      'phx-loadout':     '/data/serverfiles/garrysmod/data/phx_data/swep_manager/loadoutinfo.txt',
      'phx-admins':      '/data/serverfiles/garrysmod/data/phx_data/admins.txt',
    },
    liveActions: [
      { key: 'next_round',     cmd: 'ph_force_end_round' },
      { key: 'map_vote',       cmd: 'mv_start' },
      { key: 'luckyballs_on',  cmd: 'ph_enable_lucky_balls 1' },
      { key: 'luckyballs_off', cmd: 'ph_enable_lucky_balls 0' },
      { key: 'autotaunt_on',   cmd: 'ph_autotaunt_enabled 1' },
      { key: 'autotaunt_off',  cmd: 'ph_autotaunt_enabled 0' },
      { key: 'bhop_on',        cmd: 'sv_cheats 1; sv_airaccelerate 1000' },
      { key: 'bhop_off',       cmd: 'sv_airaccelerate 12' },
      { key: 'cheats_on',      cmd: 'sv_cheats 1' },
      { key: 'cheats_off',     cmd: 'sv_cheats 0' },
      { key: 'apply_config',   cmd: 'exec gamertown/active' },
      { key: 'players',        cmd: 'status' },
    ],
    liveControls: [
      { key: 'gravity', samples: [
        { value: 600,  cmd: 'sv_gravity 600' },
        { value: -1,   cmd: 'sv_gravity 0' },
        { value: 9999, cmd: 'sv_gravity 1000' },
      ] },
      { key: 'timescale', samples: [
        { value: 1,  cmd: 'sv_cheats 1; host_timescale 1' },
        { value: 0,  cmd: 'sv_cheats 1; host_timescale 0.25' },
        { value: 99, cmd: 'sv_cheats 1; host_timescale 3' },
      ] },
      // clampNumber semantics: a literal 0 clamps to MIN; an empty value falls
      // back to the control's default.
      { key: 'ph_round_time', samples: [
        { value: 250,    cmd: 'ph_round_time 250' },
        { value: '0',    cmd: 'ph_round_time 60' },
        { value: '9999', cmd: 'ph_round_time 600' },
        { value: '',     cmd: 'ph_round_time 250' },
      ] },
      { key: 'ph_blind_time', samples: [
        { value: 30,  cmd: 'ph_hunter_blindlock_time 30' },
        { value: '0', cmd: 'ph_hunter_blindlock_time 10' },
        { value: 99,  cmd: 'ph_hunter_blindlock_time 60' },
        { value: '',  cmd: 'ph_hunter_blindlock_time 30' },
      ] },
    ],
    changeMap: [
      { value: 'ph_restaurant', cmd: 'changelevel ph_restaurant' },
      { value: 'gm_construct',  cmd: 'changelevel gm_construct' },
    ],
    sendCommand: { input: '  status  ', cmd: 'status' },
    profileDefaults: {
      propHuntMap: 'ph_restaurant',
      workshopCollection: '3737190377',
      maxPlayers: 16,
      rawConfig: '',
      waitForPlayers: '1', teamItemSpawner: '1', swapTeams: '1', luckyBalls: '1',
      freezecam: '1', kickNonAdmin: '0', integrityCheck: '1', verboseLog: '0',
      roundTime: 250, blindTime: 30, roundsPerMap: 10, propJump: 1.4, firePenalty: 10,
    },
    schemaGroups: [
      {
        key: 'map',
        fieldKeys: ['propHuntMap', 'workshopCollection', 'syncMaps', 'maxPlayers'],
        basicKeys: ['propHuntMap', 'maxPlayers'],
      },
      {
        key: 'x2z',
        fieldKeys: ['waitForPlayers', 'teamItemSpawner', 'swapTeams', 'luckyBalls', 'freezecam',
          'kickNonAdmin', 'integrityCheck', 'verboseLog', 'roundTime', 'blindTime',
          'roundsPerMap', 'propJump', 'firePenalty'],
        basicKeys: ['waitForPlayers', 'swapTeams', 'luckyBalls', 'roundTime', 'blindTime',
          'roundsPerMap', 'propJump'],
      },
      {
        key: 'controls',
        fieldKeys: ['doc_xmenu', 'doc_propmenu', 'doc_taunts', 'doc_tp', 'doc_rtv',
          'doc_unstuck', 'doc_forceend', 'doc_move'],
        basicKeys: [],
      },
      {
        key: 'advanced',
        fieldKeys: ['rawConfig'],
        basicKeys: [],
      },
    ],
    update: { kind: 'exec', argv: ['/bin/bash', '-lc', '/data/gmodserver update'], timeoutMs: 1_800_000 },
  },

  // ── Counter-Strike 2 ──────────────────────────────────────────────────────────
  {
    id: 'counterstrike',
    build: (row, client, store) => buildConnector(row, counterstrikeSpec, client, store),
    serverRow: { id: 'counterstrike', name: 'Counter-Strike', backend: 'docker', container: 'cs2', port: 27015 },
    rcon: { passwordSource: { env: 'CS2_RCON_PASSWORD' }, port: 'server.rconPort' },
    getLiveGate: { reason: 'CS2_RCON_PASSWORD is not set' },
    configFiles: {
      'server.cfg':   '/home/steam/cs2-dedicated/game/csgo/cfg/server.cfg',
      'autoexec.cfg': '/home/steam/cs2-dedicated/game/csgo/cfg/autoexec.cfg',
    },
    liveActions: [
      { key: 'restart_round',     cmd: 'mp_restartgame 1' },
      { key: 'cheats_on',         cmd: 'sv_cheats 1' },
      { key: 'cheats_off',        cmd: 'sv_cheats 0' },
      { key: 'bunnyhop_on',       cmd: 'sv_cheats 1; sv_autobunnyhopping 1; sv_enablebunnyhopping 1; sv_staminamax 0; sv_airaccelerate 1000' },
      { key: 'bunnyhop_off',      cmd: 'sv_autobunnyhopping 0; sv_enablebunnyhopping 0; sv_staminamax 14; sv_airaccelerate 12' },
      { key: 'warmup_end',        cmd: 'mp_warmup_end' },
      { key: 'add_bot',           cmd: 'bot_add' },
      { key: 'kick_bots',         cmd: 'bot_kick' },
      { key: 'list_players',      cmd: 'status' },
      { key: 'knife_only',        cmd: 'mp_ct_default_primary ""; mp_t_default_primary ""; mp_ct_default_secondary ""; mp_t_default_secondary ""; mp_free_armor 0; mp_buy_allow_guns 0; mp_restartgame 1' },
      { key: 'zeus_battle',       cmd: 'game_alias competitive; mp_ct_default_primary ""; mp_t_default_primary ""; mp_ct_default_secondary weapon_taser; mp_t_default_secondary weapon_taser; mp_weapons_allow_zeus 1; mp_free_armor 0; mp_max_armor 0; mp_buy_allow_guns 0; mp_buy_allow_grenades 1; mp_startmoney 800; mp_maxmoney 16000; mp_restartgame 1' },
      { key: 'infinite_ammo_on',  cmd: 'sv_cheats 1; sv_infinite_ammo 1' },
      { key: 'infinite_ammo_off', cmd: 'sv_infinite_ammo 0; sv_cheats 0' },
    ],
    liveControls: [
      { key: 'gravity', samples: [
        { value: 250,   cmd: 'sv_cheats 1; sv_gravity 250' },
        { value: 0,     cmd: 'sv_cheats 1; sv_gravity 100' },
        { value: 99999, cmd: 'sv_cheats 1; sv_gravity 2000' },
      ] },
      { key: 'roundtime', samples: [
        { value: 5,  cmd: 'mp_roundtime_defuse 5; mp_roundtime 5' },
        { value: 0,  cmd: 'mp_roundtime_defuse 1; mp_roundtime 1' },
        { value: 99, cmd: 'mp_roundtime_defuse 60; mp_roundtime 60' },
      ] },
      { key: 'startmoney', samples: [
        { value: 1200,  cmd: 'mp_startmoney 1200; mp_maxmoney 16000' },
        { value: -5,    cmd: 'mp_startmoney 0; mp_maxmoney 16000' },
        { value: 99999, cmd: 'mp_startmoney 16000; mp_maxmoney 16000' },
      ] },
      // bot_quota 0 (in-range AND the below-min clamp target) pairs with bot_kick.
      { key: 'bots', samples: [
        { value: 3,  cmd: 'bot_quota 3' },
        { value: 0,  cmd: 'bot_quota 0; bot_kick' },
        { value: -1, cmd: 'bot_quota 0; bot_kick' },
        { value: 99, cmd: 'bot_quota 10' },
      ] },
    ],
    changeMap: [
      { value: 'de_mirage',       cmd: 'changelevel de_mirage' },
      { value: 'ws:3071005299',   cmd: 'host_workshop_map 3071005299' },
    ],
    sendCommand: { input: 'mp_warmup_end', cmd: 'mp_warmup_end' },
    profileDefaults: {
      map: 'de_dust2', gameMode: 'competitive', loadoutMode: 'normal',
      hostname: '', password: '', rawConfig: '',
      maxRounds: 24, roundTime: 1.92, freezeTime: 15, buyTime: 20, startMoney: 800,
      friendlyFire: 1, autoBalance: 1, overtime: 0, warmupTime: 60,
      botQuota: 0, botDifficulty: 2,
    },
    schemaGroups: [
      {
        key: 'map',
        fieldKeys: ['map', 'gameMode', 'loadoutMode'],
        basicKeys: ['map', 'gameMode', 'loadoutMode'],
      },
      {
        key: 'rules',
        fieldKeys: ['maxRounds', 'roundTime', 'freezeTime', 'buyTime', 'startMoney',
          'friendlyFire', 'autoBalance', 'overtime', 'warmupTime', 'botQuota', 'botDifficulty'],
        basicKeys: ['maxRounds', 'roundTime', 'freezeTime', 'buyTime', 'startMoney',
          'friendlyFire', 'overtime', 'botQuota', 'botDifficulty'],
      },
      {
        key: 'advanced',
        fieldKeys: ['hostname', 'password', 'rawConfig'],
        basicKeys: ['hostname', 'password'],
      },
    ],
    update: {
      kind: 'exec',
      argv: ['/bin/bash', '-lc',
        '/home/steam/steamcmd/steamcmd.sh +force_install_dir /home/steam/cs2-dedicated +login anonymous +app_update 730 +quit'],
      timeoutMs: 1_800_000,
    },
  },

  // ── Factorio ──────────────────────────────────────────────────────────────────
  {
    id: 'factorio',
    build: (row, client, store) => buildConnector(row, factorioSpec, client, store),
    serverRow: { id: 'factorio', name: 'Factorio', backend: 'docker', container: 'factorio', port: 34197 },
    rcon: { passwordSource: { file: '/factorio/config/rconpw' }, port: 'server.rconPort' },
    getLiveGate: { reason: 'RCON password file (/factorio/config/rconpw) not readable' },
    configFiles: {
      'server-settings.json':  '/factorio/config/server-settings.json',
      'map-gen-settings.json': '/factorio/config/map-gen-settings.json',
      'map-settings.json':     '/factorio/config/map-settings.json',
    },
    liveActions: [
      { key: 'players',        cmd: '/players' },
      { key: 'time',           cmd: '/time' },
      { key: 'show_evolution', cmd: '/evolution' },
      { key: 'save',           cmd: '/server-save' },
      { key: 'peaceful_on',    cmd: '/sc game.surfaces[1].peaceful_mode=true' },
      { key: 'peaceful_off',   cmd: '/sc game.surfaces[1].peaceful_mode=false' },
      { key: 'alwaysday_on',   cmd: '/sc game.surfaces[1].always_day=true' },
      { key: 'alwaysday_off',  cmd: '/sc game.surfaces[1].always_day=false' },
      { key: 'research_all',   cmd: '/c game.forces.player.research_all_technologies()' },
      { key: 'cheat_mode_on',  cmd: '/c for _,p in pairs(game.players) do p.cheat_mode=true end' },
    ],
    liveControls: [
      // game_speed 0 is a real input that clamps UP to 0.25 (not the default).
      { key: 'game_speed', samples: [
        { value: 2,  cmd: '/sc game.speed=2' },
        { value: -5, cmd: '/sc game.speed=0.25' },
        { value: 0,  cmd: '/sc game.speed=0.25' },
        { value: 99, cmd: '/sc game.speed=4' },
      ] },
      // evolution 0 is preserved (min == 0).
      { key: 'evolution', samples: [
        { value: 0.5, cmd: '/sc game.forces["enemy"].set_evolution_factor(0.5)' },
        { value: -1,  cmd: '/sc game.forces["enemy"].set_evolution_factor(0)' },
        { value: 0,   cmd: '/sc game.forces["enemy"].set_evolution_factor(0)' },
        { value: 5,   cmd: '/sc game.forces["enemy"].set_evolution_factor(1)' },
      ] },
    ],
    changeMap: null, // world switch is restart-only (the profile world picker)
    sendCommand: { input: '  /players  ', cmd: '/players' },
    profileDefaults: {
      saveName: '', serverName: 'Gamertown Factorio', description: '',
      maxPlayers: 0, visibility: 'lan', password: '', autosaveInterval: 10,
      autoPause: '1', evolutionEnabled: '1', pollutionEnabled: '1',
      expansionEnabled: '1', techPriceMultiplier: 1,
    },
    schemaGroups: [
      {
        key: 'world',
        fieldKeys: ['saveName'],
        basicKeys: ['saveName'],
      },
      {
        key: 'server',
        fieldKeys: ['serverName', 'description', 'maxPlayers', 'visibility', 'password', 'autosaveInterval'],
        basicKeys: ['serverName', 'maxPlayers', 'password'],
      },
      {
        key: 'rules',
        fieldKeys: ['autoPause', 'evolutionEnabled', 'pollutionEnabled', 'expansionEnabled', 'techPriceMultiplier'],
        basicKeys: ['autoPause', 'evolutionEnabled', 'pollutionEnabled', 'expansionEnabled', 'techPriceMultiplier'],
      },
    ],
    update: { kind: 'reboot' },
  },

  // ── Minecraft ─────────────────────────────────────────────────────────────────
  {
    id: 'minecraft',
    build: (row, client, store) => buildConnector(row, minecraftSpec, client, store),
    serverRow: { id: 'minecraft', name: 'Minecraft', backend: 'docker', container: 'minecraft', port: 25565 },
    rcon: { passwordSource: { env: 'MINECRAFT_RCON_PASSWORD' }, port: 'server.rconPort' },
    getLiveGate: { reason: 'MINECRAFT_RCON_PASSWORD is not set' },
    configFiles: {
      'server.properties':   '/data/server.properties',
      'whitelist.json':      '/data/whitelist.json',
      'ops.json':            '/data/ops.json',
      'banned-players.json': '/data/banned-players.json',
      'banned-ips.json':     '/data/banned-ips.json',
    },
    liveActions: [
      { key: 'list',  cmd: 'list' },
      { key: 'save',  cmd: 'save-all' },
      { key: 'day',   cmd: 'time set day' },
      { key: 'night', cmd: 'time set night' },
      { key: 'clear', cmd: 'weather clear' },
      { key: 'rain',  cmd: 'weather rain' },
      { key: 'keepinv_on',       cmd: 'gamerule keep_inventory true' },
      { key: 'keepinv_off',      cmd: 'gamerule keep_inventory false' },
      { key: 'mobs_on',          cmd: 'gamerule spawn_mobs true' },
      { key: 'mobs_off',         cmd: 'gamerule spawn_mobs false' },
      { key: 'daycycle_on',      cmd: 'gamerule do_daylight_cycle true' },
      { key: 'daycycle_off',     cmd: 'gamerule do_daylight_cycle false' },
      { key: 'griefing_on',      cmd: 'gamerule mob_griefing true' },
      { key: 'griefing_off',     cmd: 'gamerule mob_griefing false' },
      { key: 'falldmg_on',       cmd: 'gamerule fall_damage true' },
      { key: 'falldmg_off',      cmd: 'gamerule fall_damage false' },
      { key: 'instarespawn_on',  cmd: 'gamerule do_immediate_respawn true' },
      { key: 'instarespawn_off', cmd: 'gamerule do_immediate_respawn false' },
      { key: 'phantoms_on',      cmd: 'gamerule do_insomnia true' },
      { key: 'phantoms_off',     cmd: 'gamerule do_insomnia false' },
      { key: 'firetick_on',      cmd: 'gamerule do_fire_tick true' },
      { key: 'firetick_off',     cmd: 'gamerule do_fire_tick false' },
      { key: 'thunder',          cmd: 'weather thunder' },
    ],
    liveControls: [
      { key: 'time', samples: [
        { value: 12345, cmd: 'time set 12345' },
        { value: -5,    cmd: 'time set 0' },
        { value: 99999, cmd: 'time set 24000' },
        { value: '',    cmd: 'time set 6000' },
      ] },
      { key: 'randomtick', samples: [
        { value: 7,     cmd: 'gamerule random_tick_speed 7' },
        { value: -1,    cmd: 'gamerule random_tick_speed 0' },
        { value: 99,    cmd: 'gamerule random_tick_speed 20' },
        { value: 'abc', cmd: 'gamerule random_tick_speed 3' },
      ] },
      { key: 'sleeppct', samples: [
        { value: 55,   cmd: 'gamerule players_sleeping_percentage 55' },
        { value: -1,   cmd: 'gamerule players_sleeping_percentage 0' },
        { value: 101,  cmd: 'gamerule players_sleeping_percentage 100' },
        { value: null, cmd: 'gamerule players_sleeping_percentage 100' },
      ] },
    ],
    changeMap: null, // world switch is restart-only (the profile world picker)
    sendCommand: { input: '  say hello  ', cmd: 'say hello' },
    profileDefaults: {
      world: '', gamemode: 'survival', difficulty: 'normal', maxPlayers: 20,
      motd: 'Gamertown', pvp: '1', hardcore: '0', whitelist: '0', onlineMode: '1',
      viewDistance: 10, spawnProtection: 16,
      allowNether: '1', spawnMonsters: '1', commandBlocks: '0',
      simulationDistance: 10, playerIdleTimeout: 0,
    },
    schemaGroups: [
      {
        key: 'world',
        fieldKeys: ['world'],
        basicKeys: ['world'],
      },
      {
        key: 'gameplay',
        fieldKeys: ['gamemode', 'difficulty', 'hardcore', 'pvp', 'allowNether', 'spawnMonsters',
          'commandBlocks', 'maxPlayers', 'viewDistance', 'simulationDistance',
          'spawnProtection', 'playerIdleTimeout'],
        basicKeys: ['gamemode', 'difficulty', 'hardcore', 'pvp', 'maxPlayers'],
      },
      {
        key: 'access',
        fieldKeys: ['whitelist', 'onlineMode', 'motd'],
        basicKeys: ['whitelist', 'motd'],
      },
    ],
    update: { kind: 'reboot' },
  },
];
