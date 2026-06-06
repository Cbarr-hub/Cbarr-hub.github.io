export default async function gamesRoutes(app) {
  app.get('/', async () => {
    // Party/gambling games only — the hosted game *servers* (hosted=1) share this
    // table but belong to the servers panel, not the party-games picker.
    return app.db.prepare(`
      SELECT id, name, players, minplayers, maxplayers, time_minutes
      FROM games WHERE hosted = 0 ORDER BY name ASC
    `).all();
  });
}
