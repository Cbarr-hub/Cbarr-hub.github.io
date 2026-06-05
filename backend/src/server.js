import Fastify from 'fastify';
import secureSession from '@fastify/secure-session';
import rateLimit from '@fastify/rate-limit';
import csrf from '@fastify/csrf-protection';

import { loadEnv } from './env.js';
import { openDb, runMigrations, purgeExpiredSessions } from './db.js';
import { loadOrCreateSessionKey, SESSION_TTL_SECONDS } from './session.js';
import { attachSession } from './middleware/auth.js';
import { DockerClient } from './docker/client.js';
import { createServerService } from './servers/service.js';

import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import balancesRoutes from './routes/balances.js';
import forumRoutes from './routes/forum.js';
import reviewsRoutes from './routes/reviews.js';
import leaderboardRoutes from './routes/leaderboard.js';
import eventsRoutes from './routes/events.js';
import gamesRoutes from './routes/games.js';
import adminRoutes from './routes/admin.js';
import serversRoutes from './routes/servers.js';

export async function buildApp(env = loadEnv()) {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
    trustProxy: true,
  });

  const db = openDb(env.DB_PATH);
  runMigrations(db);
  purgeExpiredSessions(db);
  app.decorate('db', db);
  app.addHook('onClose', async () => db.close());

  await app.register(secureSession, {
    key: loadOrCreateSessionKey(env.SESSION_KEY_PATH),
    cookieName: 'gt_session',
    cookie: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_SECONDS,
    },
  });

  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
  });

  await app.register(csrf, {
    sessionPlugin: '@fastify/secure-session',
    cookieOpts: { signed: false, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: '/' },
  });

  attachSession(app);

  // Game-server control: build a Docker client only when DOCKER_HOST is set,
  // otherwise pass null so /api/servers degrades to 503 ("not configured")
  // instead of crashing the backend.
  const docker = env.DOCKER_HOST
    ? new DockerClient({ host: env.DOCKER_HOST, apiVersion: env.DOCKER_API_VERSION || undefined })
    : null;
  if (!docker) app.log.warn('DOCKER_HOST not configured — game-server control will be unavailable');

  app.decorate('serverService', createServerService({
    dockerClient: docker, publicHost: env.PUBLIC_HOST, db,
  }));

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/csrf', async (req, reply) => {
    return { token: await reply.generateCsrf() };
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(meRoutes,   { prefix: '/api' });
  await app.register(balancesRoutes,   { prefix: '/api/balances' });
  await app.register(forumRoutes,      { prefix: '/api/forum' });
  await app.register(reviewsRoutes,    { prefix: '/api/reviews' });
  await app.register(leaderboardRoutes,{ prefix: '/api/leaderboard' });
  await app.register(eventsRoutes,     { prefix: '/api/events' });
  await app.register(gamesRoutes,      { prefix: '/api/games' });
  await app.register(adminRoutes,      { prefix: '/api/admin' });
  await app.register(serversRoutes,    { prefix: '/api/servers' });

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith('server.js');

if (isMain) {
  const env = loadEnv();
  const app = await buildApp(env);
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
