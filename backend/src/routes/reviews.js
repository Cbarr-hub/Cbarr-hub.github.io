// Reviews ("testimony registry", reviews.html). Public + anonymous: a review
// carries a free-text name, not a user id, so listing and posting need no login
// (this preserves the page's original behavior, when it talked to Supabase
// directly). POST is CSRF-protected and covered by the app's global rate limit.

export default async function reviewsRoutes(app) {
  app.get('/', async () => {
    return app.db.prepare(
      'SELECT id, name, rating, message, created_at FROM reviews ORDER BY created_at DESC'
    ).all();
  });

  app.post('/', {
    onRequest: app.csrfProtection,
    schema: {
      body: {
        type: 'object',
        required: ['name', 'rating', 'message'],
        properties: {
          name:    { type: 'string', minLength: 1, maxLength: 80 },
          rating:  { type: 'integer', minimum: 1, maximum: 5 },
          message: { type: 'string', minLength: 10, maxLength: 5000 },
        },
        additionalProperties: false,
      },
    },
  }, async (req) => {
    const result = app.db.prepare(
      'INSERT INTO reviews (name, rating, message) VALUES (?, ?, ?)'
    ).run(req.body.name.trim(), req.body.rating, req.body.message.trim());
    return { id: result.lastInsertRowid };
  });
}
