/**
 * Mock subscription API (PRD §2.1, §4; D-027..D-031). All routes require a session and act only on the caller's own
 * subscription. The mock provider is refused with NODE_ENV=production (billingProviderFromEnv).
 *
 * Customer actions (what StoreKit / the App Store would initiate in M3):
 *   GET  /subscriptions/current           state, entitlement, renewal date, trial eligibility (+ message when eligible)
 *   GET  /subscriptions/history           verified periods and every lifecycle event received
 *   POST /subscriptions/purchase          { planId, transactionId, mockOutcome }   start (trial if eligible for Basic)
 *   POST /subscriptions/change-plan       { planId, transactionId, mockOutcome? }  upgrade now / schedule downgrade
 *   POST /subscriptions/cancel            { requestId }  turn auto-renew off (entitlement kept until period end)
 *   POST /subscriptions/resume            { requestId }  turn auto-renew back on
 *   POST /subscriptions/restore           re-sync the authoritative state for this account
 * Mock provider notifications (App Store Server Notifications in M3), deterministic test input:
 *   POST /subscriptions/mock-notifications { eventId, type: RENEWED|EXPIRED|REFUNDED|REVOKED, transactionId, periodStart? }
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authOf, requireAuth } from '../auth/require-auth.ts';
import { PURCHASE_OUTCOMES, type MockBillingProvider, type PurchaseOutcome } from '../billing/provider.ts';
import type { Clock } from '../clock.ts';
import { readWallet } from '../credits/wallet.ts';
import { withTransaction } from '../db/tx.ts';
import { ApiError } from '../http/errors.ts';
import { PLAN_IDS, type PlanId } from './lifecycle.ts';
import { lockUser, reconcileUser, runLifecycle, subscriptionView, type LifecycleInput } from './service.ts';

const ID = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const PLAN = { type: 'string', enum: [...PLAN_IDS] } as const;
const OUTCOME = { type: 'string', enum: [...PURCHASE_OUTCOMES] } as const;
const ISO = { type: 'string', maxLength: 40, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$' } as const;

const purchaseBody = {
  type: 'object', additionalProperties: false, required: ['planId', 'transactionId'],
  properties: { planId: PLAN, transactionId: ID, mockOutcome: OUTCOME },
} as const;
const requestBody = {
  type: 'object', additionalProperties: false, required: ['requestId'], properties: { requestId: ID },
} as const;
const notificationBody = {
  type: 'object', additionalProperties: false, required: ['eventId', 'type', 'transactionId'],
  properties: {
    eventId: ID,
    type: { type: 'string', enum: ['RENEWED', 'EXPIRED', 'REFUNDED', 'REVOKED'] },
    transactionId: ID,
    periodStart: ISO,
  },
} as const;

type PurchaseBody = { planId: PlanId; transactionId: string; mockOutcome?: PurchaseOutcome };
type NotificationBody = { eventId: string; type: 'RENEWED' | 'EXPIRED' | 'REFUNDED' | 'REVOKED'; transactionId: string; periodStart?: string };

/**
 * Read routes (current, history, restore) exist for every provider. The mock mutation routes (purchase, change-plan,
 * cancel, resume, mock-notifications) are registered ONLY when the server runs the mock provider (`deps.mock`): in
 * Apple mode, subscription changes come exclusively from Apple-signed data (src/billing/apple/routes.ts).
 */
export function registerSubscriptionRoutes(app: FastifyInstance, pool: pg.Pool, deps: { mock: MockBillingProvider | null; clock: Clock }): void {
  const guard = requireAuth(pool);
  const mock = deps.mock;
  const provider = mock ? 'mock' : 'apple';

  async function respond(userId: string, input: LifecycleInput) {
    const now = deps.clock.now();
    return withTransaction(pool, async (tx) => {
      const outcome = await runLifecycle(tx, { billing: mock!, now }, userId, input);
      return {
        status: outcome.status,
        body: {
          result: outcome.result,
          replayed: outcome.replayed,
          period: outcome.period,
          ...(await subscriptionView(tx, userId, now, provider)),
          wallet: await readWallet(tx, userId),
        },
      };
    });
  }

  // Reads reconcile first so an ended period's credits are never shown or spendable (stale entitlement).
  async function currentState(userId: string) {
    const now = deps.clock.now();
    return withTransaction(pool, async (tx) => {
      await lockUser(tx, userId);
      await reconcileUser(tx, userId, now);
      return { ...(await subscriptionView(tx, userId, now, provider)), wallet: await readWallet(tx, userId), serverTime: now.toISOString() };
    });
  }

  app.get('/subscriptions/current', { onRequest: guard }, async (request) => currentState(authOf(request).user.id));

  // Restore (M2 mock): the backend is the record of truth for this account, so restoring re-syncs and returns it.
  // Cross-account restore conflicts are an open product decision (PRD §7 #7) and are not implemented.
  app.post('/subscriptions/restore', { onRequest: guard }, async (request) => ({
    restored: true,
    ...(await currentState(authOf(request).user.id)),
  }));

  app.get('/subscriptions/history', { onRequest: guard }, async (request) => {
    const userId = authOf(request).user.id;
    const periods = await pool.query(
      `SELECT p.id, p.transaction_id AS "transactionId", p.plan_id AS "planId", p.kind, p.starts_at AS "startsAt",
              p.ends_at AS "endsAt", p.credits, p.disposition, r.reason AS "revocation", r.revoked_at AS "revokedAt",
              COALESCE((SELECT l.delta FROM credit_ledger l WHERE l.subscription_period_id = p.id AND l.entry_type = 'SUBSCRIPTION_GRANT'), 0) AS "creditsGranted",
              COALESCE((SELECT -l.delta FROM credit_ledger l WHERE l.subscription_period_id = p.id AND l.entry_type = 'SUBSCRIPTION_EXPIRATION'), 0) AS "creditsExpired"
         FROM subscription_periods p LEFT JOIN subscription_revocations r ON r.period_id = p.id
        WHERE p.user_id = $1 ORDER BY p.starts_at DESC, p.created_at DESC LIMIT 100`,
      [userId],
    );
    const events = await pool.query(
      `SELECT type, result, business_time AS "occurredAt", created_at AS "receivedAt"
         FROM subscription_events WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT 100`,
      [userId],
    );
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
    return {
      periods: periods.rows.map((r) => ({ ...r, startsAt: iso(r.startsAt), endsAt: iso(r.endsAt), revokedAt: iso(r.revokedAt) })),
      events: events.rows.map((r) => ({ ...r, occurredAt: iso(r.occurredAt), receivedAt: iso(r.receivedAt) })),
    };
  });

  // Everything below is the deterministic mock provider only.
  if (!mock) return;

  app.post<{ Body: PurchaseBody }>('/subscriptions/purchase', { onRequest: guard, schema: { body: purchaseBody } }, async (request, reply) => {
    const { planId, transactionId, mockOutcome } = request.body;
    const out = await respond(authOf(request).user.id, {
      eventKey: `transaction:${transactionId}`,
      type: 'PURCHASE',
      request: { kind: 'PURCHASE', planId, transactionId, mockOutcome: mockOutcome ?? 'DECLINED' },
      conflictCode: 'TRANSACTION_CONFLICT',
      mockOutcome,
      command: async () => ({ type: 'PURCHASE', planId, transactionId }),
    });
    return reply.code(out.status).send(out.body);
  });

  app.post<{ Body: PurchaseBody }>('/subscriptions/change-plan', { onRequest: guard, schema: { body: purchaseBody } }, async (request, reply) => {
    const { planId, transactionId, mockOutcome } = request.body;
    const out = await respond(authOf(request).user.id, {
      eventKey: `transaction:${transactionId}`,
      type: 'CHANGE_PLAN',
      request: { kind: 'CHANGE_PLAN', planId, transactionId, mockOutcome: mockOutcome ?? 'DECLINED' },
      conflictCode: 'TRANSACTION_CONFLICT',
      mockOutcome,
      command: async () => ({ type: 'CHANGE_PLAN', planId, transactionId }),
    });
    return reply.code(out.status).send(out.body);
  });

  for (const [path, type] of [['/subscriptions/cancel', 'CANCEL_AUTO_RENEW'], ['/subscriptions/resume', 'RESUME_AUTO_RENEW']] as const) {
    app.post<{ Body: { requestId: string } }>(path, { onRequest: guard, schema: { body: requestBody } }, async (request, reply) => {
      const { requestId } = request.body;
      const out = await respond(authOf(request).user.id, {
        eventKey: `request:${requestId}`,
        type,
        request: { kind: type, requestId },
        conflictCode: 'REQUEST_ID_CONFLICT',
        command: async () => ({ type }),
      });
      return reply.code(out.status).send(out.body);
    });
  }

  app.post<{ Body: NotificationBody }>('/subscriptions/mock-notifications', { onRequest: guard, schema: { body: notificationBody } }, async (request, reply) => {
    const userId = authOf(request).user.id;
    const { notification } = await mock.verifyNotification(request.body);
    const { eventId, type, transactionId, periodStart } = notification;
    const start = periodStart === undefined ? undefined : new Date(periodStart);
    if (start && Number.isNaN(start.getTime())) throw new ApiError(400, 'VALIDATION_ERROR', 'periodStart is not a valid date');
    const out = await respond(userId, {
      eventKey: `notification:${eventId}`,
      type,
      request: { kind: type, eventId, transactionId, periodStart: start?.toISOString() ?? null },
      conflictCode: 'EVENT_CONFLICT',
      command: async (tx) => {
        if (type === 'RENEWED') return { type, transactionId, ...(start && { periodStart: start }) };
        const { rows } = await tx.query(
          `SELECT p.id, p.transaction_id, p.plan_id, p.kind, p.starts_at, p.ends_at, p.credits,
                  EXISTS (SELECT 1 FROM subscription_revocations r WHERE r.period_id = p.id) AS revoked
             FROM subscription_periods p WHERE p.user_id = $1 AND p.provider = 'mock' AND p.transaction_id = $2`,
          [userId, transactionId],
        );
        const r = rows[0];
        if (!r) throw new ApiError(409, 'UNKNOWN_TRANSACTION', 'No period with this transaction id');
        if (type === 'EXPIRED') return { type, transactionId };
        return {
          type, transactionId,
          period: { id: r.id, transactionId: r.transaction_id, planId: r.plan_id, kind: r.kind, startsAt: r.starts_at, endsAt: r.ends_at, credits: r.credits, revoked: r.revoked },
        };
      },
    });
    return reply.code(out.status).send(out.body);
  });
}
