import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { mockAdProvider, type AdProvider } from './ads/provider.ts';
import { registerAdRoutes } from './ads/routes.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { registerAppleRoutes } from './billing/apple/routes.ts';
import { mockBillingProvider, type BillingProvider } from './billing/provider.ts';
import { registerCatalogRoutes } from './catalog.ts';
import { systemClock, type Clock } from './clock.ts';
import { registerOperationRoutes } from './credits/operations.ts';
import { registerPurchaseRoutes } from './credits/purchases.ts';
import { registerWalletRoutes } from './credits/wallet.ts';
import { installErrorHandling } from './http/errors.ts';
import { fixedWindowRateLimit, type RateLimitOptions } from './http/rate-limit.ts';
import { registerSubscriptionRoutes } from './subscriptions/routes.ts';

export const BODY_LIMIT_BYTES = 16 * 1024;

/**
 * `exposure: 'tunnel'` = the API is reachable from the internet through a local HTTPS tunnel (TestFlight QA, D-051):
 * Apple billing only (no mock purchases/subscriptions), no ad network (no mock reward route), the tunnel's
 * X-Forwarded-For trusted from loopback only, and rate limits on every route (stricter on /auth). The process must
 * bind to loopback (server.ts enforces it).
 */
export type Exposure = 'local' | 'tunnel';
export type AppDeps = {
  pool: pg.Pool; billing?: BillingProvider; ads?: AdProvider; clock?: Clock;
  exposure?: Exposure; rateLimit?: { all: RateLimitOptions; auth: RateLimitOptions };
};

export const TUNNEL_RATE_LIMITS = {
  all: { windowMs: 60_000, perKey: 120, global: 1200 },
  auth: { windowMs: 60_000, perKey: 10, global: 100 },
} satisfies AppDeps['rateLimit'];

export function buildApp(deps: AppDeps): FastifyInstance {
  const billing = deps.billing ?? mockBillingProvider;
  const exposure = deps.exposure ?? 'local';
  if (exposure === 'tunnel' && billing.name !== 'apple') {
    throw new Error('API_EXPOSURE=tunnel requires BILLING_PROVIDER=apple: mock billing must never be reachable from outside');
  }
  const ads = exposure === 'tunnel' ? null : (deps.ads ?? mockAdProvider);
  const clock = deps.clock ?? systemClock;
  const app = Fastify({
    logger: false,
    ...(exposure === 'tunnel' && { trustProxy: '127.0.0.1' }),
    bodyLimit: BODY_LIMIT_BYTES,
    // Reject unknown properties and wrong types instead of silently stripping or coercing them.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: true } },
  });
  app.decorateRequest('auth', null);
  installErrorHandling(app);
  if (exposure === 'tunnel') {
    const limits = deps.rateLimit ?? TUNNEL_RATE_LIMITS;
    const all = fixedWindowRateLimit(limits.all);
    const auth = fixedWindowRateLimit(limits.auth);
    app.addHook('onRequest', async (request, reply) => {
      await all(request, reply);
      if (request.url.startsWith('/auth/')) await auth(request, reply);
    });
  }

  // Balances, tokens and history must never be cached by clients or proxies.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  });

  app.get('/health', async (_request, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      return { status: 'ok', database: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'error', database: 'unavailable' });
    }
  });

  // Which billing provider this server runs (D-038). The app uses it to choose StoreKit or the mock test controls.
  app.get('/billing/config', async () => ({ provider: billing.name }));

  registerAuthRoutes(app, deps.pool);
  registerCatalogRoutes(app, deps.pool);
  registerWalletRoutes(app, deps.pool, clock);
  registerOperationRoutes(app, deps.pool, clock);
  if (billing.name === 'mock') {
    // Deterministic mock purchases exist only in mock mode (never alongside real Apple billing).
    registerPurchaseRoutes(app, deps.pool, billing);
    registerSubscriptionRoutes(app, deps.pool, { mock: billing, clock });
  } else {
    registerSubscriptionRoutes(app, deps.pool, { mock: null, clock });
    registerAppleRoutes(app, deps.pool, { verifier: billing.verifier, clock });
  }
  registerAdRoutes(app, deps.pool, { ads, clock });
  return app;
}
