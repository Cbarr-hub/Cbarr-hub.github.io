// Playtime economy: turn tracked game-server sessions into gambling dollars.
//
// Pure DB access over better-sqlite3 (no Fastify, no transport). Three concerns:
//   1. app-settings  — the admin-editable rate ($/hour) + per-session cap.
//   2. player↔account links — which tracked identity (players.id) pays which
//      site user (users.id). Admin-assigned; only linked identities earn.
//   3. the reconciler — credit each CLOSED, uncredited, linked session exactly
//      once (duration × rate, capped), incrementing balances.dollars.
//
// Why credit on close (not live): a closed session has a known duration, the
// award is idempotent (credited_at marks it paid), and a missed-leave session
// closed as 'reconciled' can't overpay because the cap bounds each session.

// Setting keys + fallbacks (mirrored as seed defaults in migration 007).
export const SETTING_KEYS = {
  dollarsPerHour: 'playtime_dollars_per_hour',
  maxSessionMinutes: 'playtime_max_session_minutes',
};
const DEFAULTS = { dollarsPerHour: 100, maxSessionMinutes: 600 };

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function createEconomy(db) {
  const stmts = {
    getSetting: db.prepare('SELECT value FROM app_settings WHERE key = ?'),
    setSetting: db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
    ),
    listPlayers: db.prepare(
      `SELECT p.id, p.identity_kind AS identityKind, p.uid, p.name,
              p.first_seen AS firstSeen, p.last_seen AS lastSeen,
              p.ignored AS ignored,
              pa.user_id AS userId, u.display_name AS userName,
              COUNT(s.id)                                   AS sessions,
              -- per-session 24h clamp mirrors the store's Pulse DUR cap (servers/store.js) so roster hours agree with Pulse
              COALESCE(SUM(MAX(0, MIN(COALESCE(s.left_at, unixepoch()) - s.joined_at, 86400))), 0) AS totalSeconds,
              COALESCE(SUM(s.credited_dollars), 0)          AS earned
         FROM players p
         LEFT JOIN player_accounts pa ON pa.player_id = p.id
         LEFT JOIN users u            ON u.id = pa.user_id
         LEFT JOIN server_sessions s  ON s.player_id = p.id
        GROUP BY p.id
        ORDER BY p.last_seen DESC`,
    ),
    getLink: db.prepare('SELECT user_id AS userId FROM player_accounts WHERE player_id = ?'),
    upsertLink: db.prepare(
      `INSERT INTO player_accounts (player_id, user_id) VALUES (?, ?)
       ON CONFLICT(player_id) DO UPDATE SET user_id = excluded.user_id, created_at = unixepoch()`,
    ),
    deleteLink: db.prepare('DELETE FROM player_accounts WHERE player_id = ?'),
    playerExists: db.prepare('SELECT 1 FROM players WHERE id = ?'),
    userExists: db.prepare('SELECT 1 FROM users WHERE id = ?'),
    // Dismiss / restore a tracked identity in the Activity link queue. Does NOT
    // touch sessions, so playtime keeps counting in Activity + Pulse.
    setIgnored: db.prepare('UPDATE players SET ignored = ? WHERE id = ?'),
    // Settle (mark paid without paying) a player's existing closed sessions at
    // link time, so linking doesn't retroactively dump a pile of currency for
    // playtime that happened before the account existed.
    settlePastSessions: db.prepare(
      `UPDATE server_sessions SET credited_at = unixepoch(), credited_dollars = 0
        WHERE player_id = ? AND left_at IS NOT NULL AND credited_at IS NULL`,
    ),
    // A session still OPEN at first link straddles the link boundary: its whole
    // span (pre- + post-link) would otherwise be paid when it later closes. So
    // at link time we close+settle each open row (settlePastSessions only touches
    // already-closed rows) and re-open a fresh uncredited session from now, so
    // only the post-link remainder earns when it eventually closes.
    closeOpenSessions: db.prepare(
      `UPDATE server_sessions SET left_at = unixepoch(), credited_at = unixepoch(), credited_dollars = 0
        WHERE player_id = ? AND left_at IS NULL`,
    ),
    openSessionsToSplit: db.prepare(
      `SELECT game_id AS gameId, player_id AS playerId, identity_kind AS identityKind,
              uid, name
         FROM server_sessions
        WHERE player_id = ? AND left_at IS NULL`,
    ),
    reopenSession: db.prepare(
      `INSERT INTO server_sessions
         (game_id, player_id, identity_kind, uid, name, joined_at, source)
       VALUES (?, ?, ?, ?, ?, unixepoch(), 'reconciled')`,
    ),
    // The reconciler scan: closed + uncredited + linked sessions only.
    creditable: db.prepare(
      `SELECT s.id, s.joined_at AS joinedAt, s.left_at AS leftAt, pa.user_id AS userId
         FROM server_sessions s
         JOIN player_accounts pa ON pa.player_id = s.player_id
        WHERE s.left_at IS NOT NULL AND s.credited_at IS NULL`,
    ),
    // Stamp a session paid AND record the dollars credited (0 is recorded too, so
    // the per-player earnings aggregate is truthful). credited_at marks it processed.
    markCredited: db.prepare(
      'UPDATE server_sessions SET credited_at = unixepoch(), credited_dollars = ? WHERE id = ?',
    ),
    addDollars: db.prepare(
      `INSERT INTO balances (user_id, dollars) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET dollars = dollars + excluded.dollars`,
    ),
  };

  function getEconomySettings() {
    const dph = toNumber(stmts.getSetting.get(SETTING_KEYS.dollarsPerHour)?.value, DEFAULTS.dollarsPerHour);
    const cap = toNumber(stmts.getSetting.get(SETTING_KEYS.maxSessionMinutes)?.value, DEFAULTS.maxSessionMinutes);
    return {
      dollarsPerHour: Math.max(0, Math.round(dph)),
      maxSessionMinutes: Math.max(1, Math.round(cap)),
    };
  }

  return {
    getEconomySettings,

    // Persist validated settings; callers (the route) validate ranges first.
    setEconomySettings({ dollarsPerHour, maxSessionMinutes } = {}) {
      const tx = db.transaction(() => {
        if (dollarsPerHour !== undefined) {
          stmts.setSetting.run(SETTING_KEYS.dollarsPerHour, String(Math.max(0, Math.round(dollarsPerHour))));
        }
        if (maxSessionMinutes !== undefined) {
          stmts.setSetting.run(SETTING_KEYS.maxSessionMinutes, String(Math.max(1, Math.round(maxSessionMinutes))));
        }
      });
      tx();
      return getEconomySettings();
    },

    // The seen-players roster with their linked account + lifetime playtime.
    listPlayers() {
      return stmts.listPlayers.all().map((r) => ({
        ...r,
        totalMinutes: Math.round((r.totalSeconds || 0) / 60),
      }));
    },

    // Link a tracked identity to a site user (or unlink with userId = null).
    // On first link, settle the player's pre-existing closed sessions and split
    // any still-open session at the link boundary, so only playtime AFTER linking
    // earns. Returns { ok } or throws a coded error.
    linkAccount(playerId, userId) {
      if (!stmts.playerExists.get(playerId)) {
        throw Object.assign(new Error('unknown player'), { code: 'UNKNOWN_PLAYER' });
      }
      if (userId == null) {
        stmts.deleteLink.run(playerId);
        return { ok: true, linked: false };
      }
      if (!stmts.userExists.get(userId)) {
        throw Object.assign(new Error('unknown user'), { code: 'UNKNOWN_USER' });
      }
      const tx = db.transaction(() => {
        const had = stmts.getLink.get(playerId);
        stmts.upsertLink.run(playerId, userId);
        // Only settle-without-paying when this identity had no prior link (a
        // first link). Re-pointing an already-linked identity keeps its pending
        // sessions creditable to the new owner.
        if (!had) {
          stmts.settlePastSessions.run(playerId); // already-closed pre-link rows
          // Split any session still open at link time so only post-link minutes
          // bill: snapshot the open rows (before closing flips left_at), close +
          // settle the pre-link span, then re-open a fresh uncredited session.
          const open = stmts.openSessionsToSplit.all(playerId);
          stmts.closeOpenSessions.run(playerId);
          for (const s of open) {
            stmts.reopenSession.run(s.gameId, s.playerId, s.identityKind, s.uid, s.name);
          }
        }
      });
      tx();
      return { ok: true, linked: true };
    },

    // Dismiss (ignored=true) or restore (false) a tracked identity in the link
    // queue. Purely a to-do-list flag: it never touches sessions, so the identity's
    // playtime still shows in Activity and counts in Pulse. Throws if unknown.
    setPlayerIgnored(playerId, ignored) {
      if (!stmts.playerExists.get(playerId)) {
        throw Object.assign(new Error('unknown player'), { code: 'UNKNOWN_PLAYER' });
      }
      stmts.setIgnored.run(ignored ? 1 : 0, playerId);
      return { ok: true, ignored: !!ignored };
    },

    // Credit every closed, uncredited, linked session. Idempotent: each session
    // is stamped credited_at so a re-run never double-pays. Returns a summary.
    creditPlaytime(now = Math.floor(Date.now() / 1000)) {
      const { dollarsPerHour, maxSessionMinutes } = getEconomySettings();
      const rows = stmts.creditable.all();
      if (!rows.length) return { sessions: 0, dollars: 0, byUser: {} };

      const byUser = {};
      let totalDollars = 0;
      const tx = db.transaction(() => {
        for (const r of rows) {
          const rawMin = Math.max(0, (r.leftAt - r.joinedAt) / 60);
          const minutes = Math.min(rawMin, maxSessionMinutes);
          const dollars = Math.round((minutes / 60) * dollarsPerHour);
          if (dollars > 0) {
            stmts.addDollars.run(r.userId, dollars);
            byUser[r.userId] = (byUser[r.userId] || 0) + dollars;
            totalDollars += dollars;
          }
          stmts.markCredited.run(dollars, r.id); // record award (0 too) + mark processed
        }
      });
      tx();
      return { sessions: rows.length, dollars: totalDollars, byUser };
    },
  };
}
