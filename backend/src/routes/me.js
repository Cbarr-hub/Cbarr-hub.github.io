export default async function meRoutes(app) {
  app.get('/me', async (req, reply) => {
    if (!req.currentUser) {
      return reply.code(401).send({ error: 'not signed in' });
    }
    return {
      username: req.currentUser.username,
      displayName: req.currentUser.displayName,
      isAdmin: req.currentUser.isAdmin,
    };
  });
}
