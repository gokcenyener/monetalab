/**
 * Apple StoreKit 2 routes (registered only when BILLING_PROVIDER=apple). D-038..D-046.
 *
 *   GET  /billing/apple/account        (session) the caller's appAccountToken, environment and product ids
 *   POST /billing/apple/transactions   (session) { signedTransaction, signedRenewalInfo? } from StoreKit 2
 *        → verifies the JWS, binds/checks ownership, fulfills idempotently, returns finishTransaction. The app calls
 *          Transaction.finish() only when finishTransaction is true.
 *   POST /apple/notifications          (PUBLIC) App Store Server Notifications V2 { signedPayload }
 *        → no trust in the caller's origin: only the verified signature counts. Idempotent by notificationUUID.
 *
 * Error contract for the app: 4xx = definitive (do not retry the same data), 503 APPLE_VERIFICATION_UNAVAILABLE and
 * 5xx = retry later. Apple retries notifications that do not get HTTP 200.
 *
 * Notification hardening (before any public exposure): 64 KB body cap, schema-checked compact JWS, per-IP + global
 * rate limit (429), signedDate window (not in the future beyond CLOCK_SKEW, not older than MAX_NOTIFICATION_AGE),
 * outer and nested JWS verified for this deployment's environment/bundle before any database access, replay =
 * duplicate notificationUUID (acknowledged, nothing applied). The route can be served alone by the notification
 * gateway (src/notifications-server.ts) so a tunnel never reaches the rest of the API.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authOf, requireAuth } from '../../auth/require-auth.ts';
import type { Clock } from '../../clock.ts';
import { withTransaction } from '../../db/tx.ts';
import { ApiError } from '../../http/errors.ts';
import { fixedWindowRateLimit, type RateLimitOptions } from '../../http/rate-limit.ts';
import { lockUser } from '../../subscriptions/service.ts';
import { appleCatalog } from './products.ts';
import { appleStatusOfNotification } from './lifecycle.ts';
import {
  applyExpiry, applyRenewalInfo, customerState, fulfillVerifiedTransaction, recordAppleStatus, recordClientSync, storedId,
} from './service.ts';
import { AppleVerificationError, type AppleVerifier, type VerifiedRenewalInfo, type VerifiedTransaction } from './verifier.ts';

const JWS = { type: 'string', minLength: 20, maxLength: 60_000, pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$' } as const;
// Signed data carries a 3-certificate chain per JWS (a notification nests two more JWS), so these routes accept more
// than the 16 KB default. Still bounded.
const SIGNED_BODY_LIMIT = 256 * 1024;
/** A Notifications V2 body: one compact JWS (schema max 60,000 chars) in a small JSON object. */
export const NOTIFICATION_BODY_LIMIT = 64 * 1024;
/** Apple retries undelivered notifications for up to 3 days; older ones are refused (reconciliation recovers them). */
export const MAX_NOTIFICATION_AGE_MS = 7 * 24 * 3600 * 1000;
export const NOTIFICATION_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const DEFAULT_NOTIFICATION_RATE_LIMIT: RateLimitOptions = { windowMs: 60_000, perKey: 60, global: 600 };

export function toApiError(error: unknown): unknown {
  if (error instanceof AppleVerificationError) {
    return new ApiError(error.retryable ? 503 : 400, error.code, error.message);
  }
  return error;
}

async function verify<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (error) {
    throw toApiError(error);
  }
}

export function registerAppleRoutes(app: FastifyInstance, pool: pg.Pool, deps: { verifier: AppleVerifier; clock: Clock }): void {
  registerAppleClientRoutes(app, pool, deps);
  registerAppleNotificationRoute(app, pool, deps);
}

/** Session-authenticated StoreKit routes used by the app. */
export function registerAppleClientRoutes(app: FastifyInstance, pool: pg.Pool, deps: { verifier: AppleVerifier; clock: Clock }): void {
  const guard = requireAuth(pool);
  const { verifier } = deps;

  app.get('/billing/apple/account', { onRequest: guard }, async (request) => {
    const userId = authOf(request).user.id;
    const { rows } = await pool.query<{ app_account_token: string }>('SELECT app_account_token FROM users WHERE id = $1', [userId]);
    return {
      environment: verifier.environment,
      bundleId: verifier.bundleId,
      // Passed to Product.purchase(options: [.appAccountToken(_)]). Apple signs it into the transaction.
      appAccountToken: rows[0]!.app_account_token,
      products: appleCatalog(),
    };
  });

  app.post<{ Body: { signedTransaction: string; signedRenewalInfo?: string } }>('/billing/apple/transactions', {
    onRequest: guard,
    bodyLimit: SIGNED_BODY_LIMIT,
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['signedTransaction'],
        properties: { signedTransaction: JWS, signedRenewalInfo: JWS },
      },
    },
  }, async (request, reply) => {
    const userId = authOf(request).user.id;
    const now = deps.clock.now();
    const t = await verify(verifier.verifyTransaction(request.body.signedTransaction));
    const renewal = request.body.signedRenewalInfo ? await verify(verifier.verifyRenewalInfo(request.body.signedRenewalInfo)) : null;
    if (renewal && renewal.originalTransactionId !== t.originalTransactionId) {
      throw new ApiError(400, 'APPLE_PAYLOAD_INVALID', 'The renewal info belongs to a different purchase');
    }
    const out = await withTransaction(pool, async (tx) => {
      const r = await fulfillVerifiedTransaction(tx, t, { caller: userId, source: 'CLIENT', now });
      if ('unmatched' in r) throw new Error('unreachable: a caller is always matched or rejected');
      const renewalResult = renewal ? await applyRenewalInfo(tx, userId, renewal, `apple-renewal:${renewal.environment}:${renewal.originalTransactionId}:${renewal.signedDate.getTime()}`, now) : null;
      await recordClientSync(tx, userId, request.body.signedTransaction, t, r.result, r.httpStatus, now);
      return { r, renewalResult, state: await customerState(tx, userId, now) };
    });
    return reply.code(out.r.httpStatus).send({
      result: out.r.result,
      productType: out.r.productType,
      transactionId: t.transactionId,
      creditsGranted: out.r.creditsGranted,
      finishTransaction: out.r.finishTransaction,
      renewalInfoResult: out.renewalResult,
      ...out.state,
    });
  });

}

/** PUBLIC App Store Server Notifications V2 endpoint (the only route the notification gateway serves). */
export function registerAppleNotificationRoute(
  app: FastifyInstance, pool: pg.Pool, deps: { verifier: AppleVerifier; clock: Clock; rateLimit?: RateLimitOptions },
): void {
  const { verifier } = deps;
  const rateLimit = fixedWindowRateLimit(deps.rateLimit ?? DEFAULT_NOTIFICATION_RATE_LIMIT);
  app.post<{ Body: { signedPayload: string } }>('/apple/notifications', {
    onRequest: rateLimit,
    bodyLimit: NOTIFICATION_BODY_LIMIT,
    schema: { body: { type: 'object', additionalProperties: false, required: ['signedPayload'], properties: { signedPayload: JWS } } },
  }, async (request, reply) => {
    const now = deps.clock.now();
    const n = await verify(verifier.verifyNotification(request.body.signedPayload));
    // Only after the signature is verified is signedDate trusted; replays of very old or future-dated data are refused.
    if (n.signedDate.getTime() > now.getTime() + NOTIFICATION_CLOCK_SKEW_MS) {
      throw new ApiError(400, 'APPLE_NOTIFICATION_FROM_FUTURE', 'The notification is signed in the future');
    }
    if (now.getTime() - n.signedDate.getTime() > MAX_NOTIFICATION_AGE_MS) {
      throw new ApiError(400, 'APPLE_NOTIFICATION_TOO_OLD', 'The notification is too old to apply; reconciliation recovers it');
    }
    // Nested signed data is verified independently: the outer signature does not vouch for it.
    const t: VerifiedTransaction | null = n.signedTransactionInfo ? await verify(verifier.verifyTransaction(n.signedTransactionInfo)) : null;
    const renewal: VerifiedRenewalInfo | null = n.signedRenewalInfo ? await verify(verifier.verifyRenewalInfo(n.signedRenewalInfo)) : null;
    if (t && renewal && t.originalTransactionId !== renewal.originalTransactionId) {
      throw new ApiError(400, 'APPLE_PAYLOAD_INVALID', 'Transaction and renewal info belong to different purchases');
    }

    const result = await withTransaction(pool, async (tx) => {
      const seen = await tx.query<{ result: string }>('SELECT result FROM apple_notifications WHERE notification_uuid = $1', [n.notificationUUID]);
      if (seen.rows[0]) return { result: 'DUPLICATE', duplicate: true };

      let userId: string | null = null;
      let outcome = 'RECORDED';
      const key = `apple-notification:${n.notificationUUID}`;
      if (t) {
        const type = n.notificationType;
        const revocationKind = type === 'REVOKE' ? 'REVOKED' as const : 'REFUNDED' as const;
        try {
          const r = await fulfillVerifiedTransaction(tx, t, { caller: null, source: 'NOTIFICATION', now, revocationKind });
          if ('unmatched' in r) {
            outcome = 'UNMATCHED';
          } else {
            userId = r.userId;
            outcome = r.result;
            if (type === 'EXPIRED' || type === 'GRACE_PERIOD_EXPIRED') outcome = await applyExpiry(tx, userId, t, key, now);
            if (type === 'DID_FAIL_TO_RENEW') {
              // Billing retry / grace period: no entitlement extension and no credits are granted (D-046, PRD open
              // decision #6). The period's credits expire at its verified end; a later DID_RENEW applies normally.
              outcome = n.subtype === 'GRACE_PERIOD' ? 'GRACE_PERIOD_NOT_APPLIED' : 'BILLING_RETRY_RECORDED';
            }
            if (['REFUND_DECLINED', 'REFUND_REVERSED', 'CONSUMPTION_REQUEST', 'RENEWAL_EXTENDED', 'RENEWAL_EXTENSION', 'PRICE_INCREASE', 'TEST'].includes(type)) {
              // Recorded for review; none of these changes credits in MonetaLab (D-046).
              outcome = `RECORDED_${type}`;
            }
            // Apple's subscription status implied by this notification (F-M3-02), newest signedDate wins.
            const appleStatus = t.productType === 'SUBSCRIPTION' ? appleStatusOfNotification(type, n.subtype) : null;
            if (appleStatus) await recordAppleStatus(tx, userId, appleStatus, n.signedDate);
            if (renewal) {
              const renewalResult = await applyRenewalInfo(tx, userId, renewal, `${key}:renewal`, now);
              outcome = `${outcome}|${renewalResult}`.slice(0, 60);
            }
          }
        } catch (error) {
          // A verified notification that MonetaLab cannot apply (e.g. unknown product, purchase bound to another
          // account) is recorded and acknowledged, so Apple stops retrying; the reason is kept for review.
          if (error instanceof ApiError && error.statusCode >= 400 && error.statusCode < 500 && error.code !== 'APPLE_PERIOD_NOT_STARTED') {
            outcome = `REJECTED_${error.code}`.slice(0, 60);
          } else {
            throw error;
          }
        }
      } else if (renewal) {
        outcome = 'RENEWAL_INFO_WITHOUT_TRANSACTION';
      }
      if (userId) await lockUser(tx, userId);
      const inserted = await tx.query(
        `INSERT INTO apple_notifications (notification_uuid, environment, notification_type, subtype, signed_date,
           original_transaction_id, transaction_id, user_id, result, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (notification_uuid) DO NOTHING`,
        [n.notificationUUID, n.environment, n.notificationType, n.subtype, n.signedDate, t?.originalTransactionId ?? null,
          t ? storedId(t.environment, t.transactionId) : null, userId, outcome, JSON.stringify(n.payload)],
      );
      // A concurrent delivery of the same notification won the race: undo this attempt entirely.
      if (inserted.rowCount !== 1) throw new DuplicateDelivery();
      return { result: outcome, duplicate: false };
    }).catch((error) => {
      if (error instanceof DuplicateDelivery) return { result: 'DUPLICATE', duplicate: true };
      throw error;
    });
    return reply.code(200).send({ notificationUUID: n.notificationUUID, ...result });
  });
}

class DuplicateDelivery extends Error {}
