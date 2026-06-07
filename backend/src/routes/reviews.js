// Reviews ("testimony registry", reviews.html). Public + anonymous: a review
// carries a free-text name, not a user id, so listing and posting need no login
// (this preserves the page's original behavior, when it talked to Supabase
// directly). POST is CSRF-protected and route-rate-limited.

export default async function reviewsRoutes(app) {
  app.get('/', async () => {
    return app.db.prepare(
      'SELECT id, name, rating, message, created_at FROM reviews ORDER BY created_at DESC'
    ).all();
  });

  app.post('/', {
    onRequest: app.csrfProtection,
    config: {
      rateLimit: { max: 20, timeWindow: '1 minute' },
    },
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
  }, async (req, reply) => {
    const name = req.body.name.trim();
    const message = req.body.message.trim();
    if (!name || message.length < 10) {
      return reply.code(400).send({ error: 'invalid review' });
    }
    const result = app.db.prepare(
      'INSERT INTO reviews (name, rating, message) VALUES (?, ?, ?)'
    ).run(name, req.body.rating, message);
    return { id: result.lastInsertRowid };
  });
}
