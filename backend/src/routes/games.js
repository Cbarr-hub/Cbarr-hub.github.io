export default async function gamesRoutes(app) {
  app.get('/', async () => {
    return app.db.prepare(`
      SELECT id, name, players, minplayers, maxplayers, time_minutes
      FROM games ORDER BY name ASC
    `).all();
  });
}
