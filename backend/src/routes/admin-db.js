// Admin-only, READ-ONLY database viewer. Powers the servers panel's "Data" tab.
//
// Hard safety contract (see BUILD SPEC §A):
//   - admin-gated (requireAdmin) on every route;
//   - read-only: no INSERT/UPDATE/DELETE/DDL path exists here, ever;
//   - the free-form query box runs on a dedicated READ-ONLY connection and is
//     gated on stmt.readonly (the authoritative sqlite read-only flag — rejects
//     writes including "… RETURNING", which stmt.reader does NOT);
//   - identifiers (table + sort column) are ALLOWLISTED against the LIVE schema —
//     a client identifier is never interpolated into SQL until it has been
//     verified to be a real table/column name from sqlite_master / PRAGMA;
//   - `password_hash` (and anything in MASKED) is value-masked to "[masked]" in
//     the structured grid and excluded from search; the free-form box additionally
//     REJECTS any query that names a masked column (output-name masking can't be
//     trusted once the caller controls aliases/expressions).
//
// All routes are GET → no CSRF (mutation-free). DB handle is app.db
// (better-sqlite3, decorated in server.js).

import Database from 'better-sqlite3';
import { requireAdmin } from '../middleware/auth.js';

// Columns whose value must never be sent to the client. Emitted as "[masked]"
// and excluded from `q` search so a filter can't leak them either.
const MASKED = new Set(['password_hash']);
const MASK = '[masked]';

// Hard server-side ceiling on rows returned, regardless of the requested limit.
const MAX_ROWS = 200;
const DEFAULT_LIMIT = 25;

// ── schema introspection (built per-request from the live DB) ──────────────────

// The allowlist for every :table param. Excludes sqlite internal tables.
function listTableNames(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}

// PRAGMA rows for a table. ONLY call after `table` is confirmed ∈ listTableNames;
// the double-quote wrap is then a no-op against any injection because the value
// is a known schema identifier.
function tableInfo(db, table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all();
}

// The column metadata we expose, derived from PRAGMA table_info. `masked` is set
// only for MASKED columns (key omitted otherwise — matches the spec shape).
function columnMeta(info) {
  return info.map((row) => {
    const col = {
      name: row.name,
      type: row.type, // verbatim PRAGMA type (may be '' for typeless cols)
      pk: row.pk > 0,
      notnull: row.notnull === 1,
    };
    if (MASKED.has(row.name)) col.masked = true;
    return col;
  });
}

// The allowlist for the `sort` column param.
function columnNames(info) {
  return info.map((r) => r.name);
}

// Escape LIKE wildcards in a user search term so they're treated literally.
// Paired with `ESCAPE '\'` in the SQL.
function escapeLike(term) {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// Replace MASKED column values in a row object with the mask literal (in place
// of the real value — the column slot is kept so the grid still renders it).
function maskRow(row) {
  for (const key of Object.keys(row)) {
    if (MASKED.has(key)) row[key] = MASK;
  }
  return row;
}

export default async function adminDbRoutes(app) {
  // A dedicated READ-ONLY connection for the free-form query box: even if a gate
  // slips, SQLite physically rejects any write on this handle. Opened lazily so
  // route registration doesn't depend on app.db decoration order.
  let _rodb = null;
  function roDb() {
    if (!_rodb) {
      _rodb = new Database(app.db.name, { readonly: true });
      _rodb.pragma('query_only = 1');
    }
    return _rodb;
  }
  app.addHook('onClose', async () => {
    if (_rodb) { try { _rodb.close(); } catch { /* ignore */ } }
  });

  // Resolve + allowlist-check a :table param. Returns the validated table name,
  // or null after having already sent a 404 (caller should just return).
  function resolveTable(req, reply) {
    const tables = listTableNames(app.db);
    if (!tables.includes(req.params.table)) {
      reply.code(404).send({ error: 'no such table' });
      return null;
    }
    return req.params.table;
  }

  // ── (1) schema overview: table list + per-table column metadata + row counts ──
  app.get('/tables', { preHandler: requireAdmin }, async () => {
    const names = listTableNames(app.db);
    return names.map((name) => {
      // name is from the allowlist → safe to interpolate.
      const rows = app.db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c;
      const columns = columnMeta(tableInfo(app.db, name));
      return { name, rows, columns };
    });
  });

  // ── (2) paged / sorted / searched rows for the grid ──────────────────────────
  app.get('/tables/:table', {
    preHandler: requireAdmin,
    schema: {
      params: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS },
          offset: { type: 'integer', minimum: 0 },
          sort: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
          dir: { type: 'string', enum: ['asc', 'desc'] },
          q: { type: 'string', maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const table = resolveTable(req, reply);
    if (!table) return;

    const info = tableInfo(app.db, table);
    const cols = columnNames(info);
    const columns = columnMeta(info);

    // Defense in depth: clamp even if the schema bound is bypassed somehow.
    const limit = Math.min(req.query.limit ?? DEFAULT_LIMIT, MAX_ROWS);
    const offset = req.query.offset ?? 0;
    const dir = req.query.dir === 'desc' ? 'DESC' : 'ASC';

    // sort: only when it names a REAL column (allowlist check).
    let sort;
    if (req.query.sort !== undefined) {
      if (!cols.includes(req.query.sort)) {
        return reply.code(400).send({ error: 'bad sort column' });
      }
      sort = req.query.sort;
    }

    // Search across all NON-masked columns (masked excluded so a filter can't
    // probe a hidden value). Value is always a bound `?`.
    const searchCols = cols.filter((c) => !MASKED.has(c));
    let where = '';
    const whereParams = [];
    if (req.query.q !== undefined && req.query.q !== '' && searchCols.length > 0) {
      const like = `%${escapeLike(req.query.q)}%`;
      const ors = searchCols.map((c) => `CAST("${c}" AS TEXT) LIKE ? ESCAPE '\\'`);
      where = ` WHERE (${ors.join(' OR ')})`;
      for (let i = 0; i < searchCols.length; i++) whereParams.push(like);
    }

    // total reflects the FILTERED set (same WHERE + bound q).
    const total = app.db.prepare(`SELECT COUNT(*) c FROM "${table}"${where}`).get(...whereParams).c;

    const orderBy = sort ? ` ORDER BY "${sort}" ${dir}` : '';
    const rows = app.db
      .prepare(`SELECT * FROM "${table}"${where}${orderBy} LIMIT ? OFFSET ?`)
      .all(...whereParams, limit, offset)
      .map(maskRow);

    return {
      table,
      columns,
      rows,
      total,
      limit,
      offset,
      sort: sort ?? null,
      dir: req.query.dir === 'desc' ? 'desc' : 'asc',
    };
  });

  // ── (3) read-only SELECT box ──────────────────────────────────────────────────
  app.get('/query', {
    preHandler: requireAdmin,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } }, // ignored if rate-limit isn't registered
    schema: {
      querystring: {
        type: 'object',
        additionalProperties: false,
        required: ['sql'],
        properties: { sql: { type: 'string', minLength: 1, maxLength: 2000 } },
      },
    },
  }, async (req, reply) => {
    const sql = req.query.sql.trim();

    // (1) No multi-statement — a single read-only statement only.
    if (sql.includes(';')) {
      return reply.code(400).send({ error: 'single statement only' });
    }

    // (2) Forbid naming a masked column. Output-name masking can't catch
    // `SELECT password_hash AS x` / `substr(password_hash,…)`, so reject any query
    // that mentions a masked column at all (SELECT * is still value-masked below).
    for (const col of MASKED) {
      if (new RegExp(`\\b${col}\\b`, 'i').test(sql)) {
        return reply.code(400).send({ error: 'that column is not viewable' });
      }
    }

    // (3) Prepare on the READ-ONLY connection (catch syntax/unknown-table → 400).
    let stmt;
    try {
      stmt = roDb().prepare(sql);
    } catch (err) {
      return reply.code(400).send({ error: String(err.message) });
    }

    // (4) Authoritative gate: stmt.readonly is sqlite's read-only flag — true ONLY
    // for statements that cannot write (rejects INSERT/UPDATE/DELETE/DDL AND
    // "… RETURNING"). The read-only connection is the physical backstop.
    if (!stmt.readonly) {
      return reply.code(400).send({ error: 'SELECT only' });
    }

    // Execute under the hard row cap. Any execution error → 400 (never 500).
    let all;
    try {
      all = stmt.all();
    } catch (err) {
      return reply.code(400).send({ error: String(err.message) });
    }

    const capped = all.length > MAX_ROWS;
    const rows = (capped ? all.slice(0, MAX_ROWS) : all).map(maskRow);

    // Column names straight from the prepared statement metadata.
    let columns;
    try {
      columns = stmt.columns().map((c) => c.name);
    } catch {
      columns = rows.length ? Object.keys(rows[0]) : [];
    }

    return { columns, rows, total: rows.length, capped };
  });
}
