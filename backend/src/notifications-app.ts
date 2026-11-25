/**
 * Notification gateway app (M3): ONLY `POST /apple/notifications`. Nothing else of the MonetaLab API (auth, wallet,
 * operations, purchases, health, config) exists in this app, so an HTTPS tunnel or ingress pointed at it exposes
 * a single, signature-verified, rate-limited, idempotent endpoint. Every other path is 404.
 * It shares the database and the exact notification code path with the main API (routes.ts).
 */
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { registerAppleNotificationRoute } from './billing/apple/routes.ts';
import type { AppleVerifier } from './billing/apple/verifier.ts';
import { systemClock, type Clock } from './clock.ts';
import { installErrorHandling } from './http/errors.ts';
import type { RateLimitOptions } from './http/rate-limit.ts';

export type NotificationsAppDeps = {
  pool: pg.Pool;
  verifier: AppleVerifier;
  clock?: Clock;
  rateLimit?: RateLimitOptions;
  /** One line per request: method, path, status, duration. Never headers or bodies. */
  log?: (line: string) => void;
};

export function buildNotificationsApp(deps: NotificationsAppDeps): FastifyInstance {
  if (deps.verifier.environment === 'Xcode') {
    throw new Error('The notification gateway serves App Store notifications only (Sandbox or Production), not Xcode');
  }
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    // The gateway binds to loopback; a local tunnel/ingress is the only client, so its X-Forwarded-For is trusted for
    // per-client rate limiting. Direct remote access is impossible while bound to 127.0.0.1.
    trustProxy: '127.0.0.1',
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: true } },
  });
  installErrorHandling(app);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  });
  if (deps.log) {
    const log = deps.log;
    app.addHook('onResponse', async (request, reply) => {
      const path = request.url.split('?')[0];
      log(`${new Date().toISOString()} ${request.method} ${path} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`);
    });
  }
  registerAppleNotificationRoute(app, deps.pool, {
    verifier: deps.verifier,
    clock: deps.clock ?? systemClock,
    ...(deps.rateLimit && { rateLimit: deps.rateLimit }),
  });
  return app;
}
