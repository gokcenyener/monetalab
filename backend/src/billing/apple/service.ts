/**
 * Apple fulfillment (D-040, D-041, D-044, D-045). Every function here takes data that verifier.ts has ALREADY
 * verified. One database transaction per verified fact, under the per-user lock (D-031):
 *
 *   1. Ownership: the purchase chain (environment, originalTransactionId) is bound to one MonetaLab user. A new chain
 *      is bound only through Apple's signed appAccountToken, which must be the user's own token. Every later
 *      transaction of that chain belongs to the same user, whatever the caller (no cross-account replay, no restore
 *      reassignment).
 *   2. The verified transaction is recorded once (immutable apple_transactions); a verified revocation once.
 *   3. Consumable: exactly one APPROVED purchase + one CONSUMABLE grant per Apple transaction (M1 constraints).
 *      Subscription: lifecycle mapping (lifecycle.ts) applied with the same accounting as M2 (applyDecision).
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { recordAnalyticsEvent } from '../../analytics/events.ts';
import { readWallet } from '../../credits/wallet.ts';
import { ApiError } from '../../http/errors.ts';
import { decide, isEntitled, SUBSCRIPTION_GROUP, type PlanId } from '../../subscriptions/lifecycle.ts';
import {
  applyDecision, loadHistory, loadState, lockUser, reconcileUser, setScheduledPeriodActivator, subscriptionView,
} from '../../subscriptions/service.ts';
import { decideAppleRenewalInfo, decideAppleStatus, decideAppleTransaction, introOfferOf, type AppleSubscriptionStatus } from './lifecycle.ts';
import { appleProduct } from './products.ts';
import type { JWSTransactionDecodedPayload } from '@apple/app-store-server-library';
import type { Clock } from '../../clock.ts';
import { withTransaction } from '../../db/tx.ts';
import { toVerifiedTransaction, type AppleEnvironment, type VerifiedRenewalInfo, type VerifiedTransaction } from './verifier.ts';

type Tx = pg.PoolClient;
export type Source = 'CLIENT' | 'NOTIFICATION' | 'SERVER_API';

export const storedId = (environment: string, transactionId: string) => `${environment}:${transactionId}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type Owner = { userId: string; linked: boolean } | { unmatched: true };

/**
 * Who owns this verified transaction? `caller` is the authenticated user (client sync / reconciliation) or null
 * (server notification). Throws 409 when a caller presents another account's purchase.
 */
export async function resolveOwner(db: Pick<Tx, 'query'>, t: VerifiedTransaction, caller: string | null): Promise<Owner> {
  const link = await db.query<{ user_id: string }>(
    'SELECT user_id FROM apple_account_links WHERE environment = $1 AND original_transaction_id = $2',
    [t.environment, t.originalTransactionId],
  );
  if (link.rows[0]) {
    if (caller && link.rows[0].user_id !== caller) throw otherAccount();
    return { userId: link.rows[0].user_id, linked: true };
  }
  if (!t.appAccountToken) {
    if (caller) {
      // A purchase without MonetaLab's token (e.g. made outside the app) cannot be proven to belong to this account.
      // Claiming such purchases needs an approved account-linking policy (PRD open decision #7, D-040).
      throw new ApiError(409, 'APPLE_ACCOUNT_TOKEN_MISSING', 'This purchase is not linked to a MonetaLab account and cannot be claimed');
    }
    return { unmatched: true };
  }
  const user = await db.query<{ id: string }>('SELECT id FROM users WHERE app_account_token = $1', [t.appAccountToken]);
  const owner = user.rows[0]?.id;
  if (!owner) {
    if (caller) throw otherAccount();
    return { unmatched: true };
  }
  if (caller && owner !== caller) throw otherAccount();
  return { userId: owner, linked: false };
}

const otherAccount = () => new ApiError(409, 'APPLE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT', 'This purchase belongs to a different MonetaLab account');

/** Records the binding and the verified transaction (idempotent). Caller holds the owner's user lock. */
async function recordVerified(tx: Tx, userId: string, t: VerifiedTransaction, source: Source): Promise<void> {
  await tx.query(
    `INSERT INTO apple_account_links (environment, original_transaction_id, user_id, product_type, linked_via)
     VALUES ($1, $2, $3, $4, 'APP_ACCOUNT_TOKEN') ON CONFLICT DO NOTHING`,
    [t.environment, t.originalTransactionId, userId, t.productType],
  );
  // Re-check under the lock: a concurrent request may have bound the chain to someone else first.
  const link = await tx.query<{ user_id: string }>(
    'SELECT user_id FROM apple_account_links WHERE environment = $1 AND original_transaction_id = $2',
    [t.environment, t.originalTransactionId],
  );
  if (link.rows[0]!.user_id !== userId) throw otherAccount();
  await tx.query(
    `INSERT INTO apple_transactions (environment, transaction_id, original_transaction_id, user_id, product_id, product_type,
       purchase_date, expires_date, offer_type, offer_discount_type, app_account_token, signed_date, source, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT DO NOTHING`,
    [t.environment, t.transactionId, t.originalTransactionId, userId, t.productId, t.productType, t.purchaseDate,
      t.expiresDate, t.offerType, t.offerDiscountType, t.appAccountToken, t.signedDate, source, JSON.stringify(t.payload)],
  );
}

async function recordRevocation(tx: Tx, userId: string, t: VerifiedTransaction): Promise<boolean> {
  if (!t.revocationDate) return false;
  const { rowCount } = await tx.query(
    `INSERT INTO apple_revocations (environment, transaction_id, user_id, product_type, revocation_date, revocation_reason, handling)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [t.environment, t.transactionId, userId, t.productType, t.revocationDate, t.revocationReason,
      t.productType === 'SUBSCRIPTION' ? 'SUBSCRIPTION_REVOKED' : 'CONSUMABLE_RECORDED_NO_CLAWBACK'],
  );
  return rowCount === 1;
}

export type FulfillmentResult = {
  userId: string;
  result: string;
  /** 202 = verified and scheduled: nothing granted yet; the period's credits are granted when it starts. */
  httpStatus: 200 | 201 | 202;
  productType: 'SUBSCRIPTION' | 'CONSUMABLE';
  creditsGranted: number;
  /** The server has durably accepted (or definitively has nothing to deliver for) this transaction. */
  finishTransaction: boolean;
};

/**
 * Applies one verified transaction for its owner. `revocationKind` lets a REVOKE notification record the reason;
 * otherwise a revocation is treated as a refund.
 */
export async function fulfillVerifiedTransaction(
  tx: Tx,
  t: VerifiedTransaction,
  ctx: { caller: string | null; source: Source; now: Date; revocationKind?: 'REFUNDED' | 'REVOKED' },
): Promise<FulfillmentResult | { unmatched: true }> {
  const product = appleProduct(t.productId);
  if (!product || product.kind !== t.productType) {
    throw new ApiError(422, 'APPLE_UNKNOWN_PRODUCT', 'This product is not part of the MonetaLab catalog');
  }
  const owner = await resolveOwner(tx, t, ctx.caller);
  if ('unmatched' in owner) return owner;
  const userId = owner.userId;
  await lockUser(tx, userId);
  await recordVerified(tx, userId, t, ctx.source);
  const newlyRevoked = await recordRevocation(tx, userId, t);
  const key = storedId(t.environment, t.transactionId);

  if (product.kind === 'CONSUMABLE') {
    const existing = await tx.query<{ user_id: string; credits: number }>(
      `SELECT user_id, credits FROM purchases WHERE provider = 'apple' AND provider_transaction_id = $1`, [key],
    );
    if (existing.rows[0]) {
      return {
        userId, productType: 'CONSUMABLE', httpStatus: 200, creditsGranted: 0, finishTransaction: true,
        // Consumable refunds are recorded only: clawback is PRD open decision #2 (D-045). Balances never go negative.
        result: newlyRevoked ? 'REFUND_RECORDED_NO_CLAWBACK' : 'ALREADY_FULFILLED',
      };
    }
    if (t.revocationDate) {
      // Refunded before it was ever fulfilled: nothing to deliver, and the transaction can be finished.
      return { userId, productType: 'CONSUMABLE', httpStatus: 200, creditsGranted: 0, finishTransaction: true, result: 'REVOKED_NOT_FULFILLED' };
    }
    const pkg = await tx.query<{ credits: number }>('SELECT credits FROM credit_packages WHERE id = $1', [product.packageId]);
    const credits = pkg.rows[0]!.credits;
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO purchases (user_id, provider, provider_transaction_id, package_id, credits, outcome)
       VALUES ($1, 'apple', $2, $3, $4, 'APPROVED') ON CONFLICT (provider, provider_transaction_id) DO NOTHING RETURNING id`,
      [userId, key, product.packageId, credits],
    );
    if (!inserted.rows[0]) {
      return { userId, productType: 'CONSUMABLE', httpStatus: 200, creditsGranted: 0, finishTransaction: true, result: 'ALREADY_FULFILLED' };
    }
    await tx.query(
      `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, purchase_id) VALUES ($1, 'CONSUMABLE', $2, 'PURCHASE_GRANT', $3)`,
      [userId, credits, inserted.rows[0].id],
    );
    return { userId, productType: 'CONSUMABLE', httpStatus: 201, creditsGranted: credits, finishTransaction: true, result: 'FULFILLED' };
  }

  // Subscription -------------------------------------------------------------------------------
  await reconcileUser(tx, userId, ctx.now);
  const loaded = await loadState(tx, userId);
  const state = loaded?.state ?? null;
  const history = await loadHistory(tx, userId);
  const known = await tx.query(
    `SELECT p.id, p.transaction_id, p.plan_id, p.kind, p.starts_at, p.ends_at, p.credits,
            EXISTS (SELECT 1 FROM subscription_revocations r WHERE r.period_id = p.id) AS revoked
       FROM subscription_periods p WHERE p.provider = 'apple' AND p.transaction_id = $1 AND p.user_id = $2`,
    [key, userId],
  );
  const k = known.rows[0];
  if (!k && !t.revocationDate && !t.isUpgraded && isEntitled(state, ctx.now)) {
    // One subscription per customer and group. A different purchase chain (e.g. another Apple ID) while this one is
    // entitled must not replace it or wipe its credits: same default as the mock (D-037, PRD open decision #7).
    const chain = await tx.query<{ original_transaction_id: string }>(
      `SELECT original_transaction_id FROM apple_transactions WHERE environment || ':' || transaction_id = $1`,
      [state!.current.transactionId],
    );
    if (chain.rows[0]?.original_transaction_id !== t.originalTransactionId) {
      throw new ApiError(409, 'ALREADY_SUBSCRIBED', 'An active subscription from a different purchase exists for this account');
    }
  }
  const offer = introOfferOf(t.offerType, t.offerDiscountType);
  const decision = decideAppleTransaction(state, history, {
    key,
    planId: product.planId,
    purchaseDate: t.purchaseDate,
    expiresDate: t.expiresDate!,
    ...offer,
    isUpgraded: t.isUpgraded,
    revocation: t.revocationDate ? { reason: ctx.revocationKind ?? 'REFUNDED' } : null,
  }, k ? { id: k.id, transactionId: k.transaction_id, planId: k.plan_id, kind: k.kind, startsAt: k.starts_at, endsAt: k.ends_at, credits: k.credits, revoked: k.revoked } : null, ctx.now);
  if (decision.kind === 'schedule') {
    // F-M3-04: Apple delivered this period before it starts. Keep it (the verified transaction is already recorded)
    // and grant nothing now; applyDueAppleRenewals applies it once startsAt <= now. Idempotent per transaction.
    await tx.query(
      `INSERT INTO apple_scheduled_renewals (environment, transaction_id, user_id, starts_at, first_source)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [t.environment, t.transactionId, userId, decision.startsAt, ctx.source],
    );
    return { userId, productType: 'SUBSCRIPTION', result: decision.result, creditsGranted: 0, finishTransaction: true, httpStatus: 202 };
  }
  if (decision.kind === 'reject') throw new ApiError(decision.status, decision.code, decision.message);
  const applied = await applyDecision(tx, userId, loaded, decision, {
    provider: 'apple',
    analyticsKey: t.revocationDate ? `apple-revocation:${key}` : `apple-transaction:${key}`,
    now: ctx.now,
    trialSource: 'APPLE_VERIFIED',
  });
  const granted = decision.kind === 'apply' && decision.grant && decision.newPeriod?.disposition === 'APPLIED' ? decision.newPeriod.credits : 0;
  // A scheduled copy of this transaction is resolved by this outcome (applied, superseded, upgraded or revoked).
  await resolveScheduled(tx, t.environment, t.transactionId, applied.result, ctx.now);
  return {
    userId, productType: 'SUBSCRIPTION', result: applied.result, creditsGranted: granted, finishTransaction: true,
    httpStatus: applied.httpStatus === 201 ? 201 : 200,
  };
}

async function resolveScheduled(tx: Tx, environment: string, transactionId: string, result: string, now: Date): Promise<void> {
  await tx.query(
    `UPDATE apple_scheduled_renewals SET resolved_at = $3, result = $4
      WHERE environment = $1 AND transaction_id = $2 AND resolved_at IS NULL`,
    [environment, transactionId, now, result.slice(0, 80)],
  );
}

const activating = new WeakSet<object>();

/**
 * F-M3-04: applies this user's scheduled Apple periods whose start has passed, oldest first, through the normal
 * verified-transaction path (exactly-once by transaction, M2 lifecycle rules, immutable ledger). Runs inside the
 * caller's transaction and user lock: from reconcileUser (every read/spend/lifecycle path) and the sweeper.
 * A period revoked before it started is resolved without credits. A definitive rejection (4xx) is resolved and kept
 * for review; each row runs in a savepoint so one failure never blocks the rest.
 */
export async function applyDueAppleRenewals(tx: Tx, userId: string, now: Date): Promise<string[]> {
  if (activating.has(tx)) return [];
  activating.add(tx);
  const results: string[] = [];
  try {
    const due = await tx.query<{ environment: AppleEnvironment; transaction_id: string; payload: JWSTransactionDecodedPayload; first_source: Source; revoked: boolean }>(
      `SELECT s.environment, s.transaction_id, t.payload, s.first_source,
              EXISTS (SELECT 1 FROM apple_revocations r WHERE r.environment = s.environment AND r.transaction_id = s.transaction_id) AS revoked
         FROM apple_scheduled_renewals s
         JOIN apple_transactions t ON t.environment = s.environment AND t.transaction_id = s.transaction_id
        WHERE s.user_id = $1 AND s.resolved_at IS NULL AND s.starts_at <= $2
        ORDER BY s.starts_at, s.transaction_id
        FOR UPDATE OF s`,
      [userId, now],
    );
    for (const row of due.rows) {
      if (row.revoked) {
        await resolveScheduled(tx, row.environment, row.transaction_id, 'REVOKED_BEFORE_START', now);
        results.push('REVOKED_BEFORE_START');
        continue;
      }
      await tx.query('SAVEPOINT apple_scheduled');
      try {
        // The stored payload is the decoded, signature-verified transaction recorded when it was received.
        const t = toVerifiedTransaction(row.payload, row.environment);
        const r = await fulfillVerifiedTransaction(tx, t, { caller: userId, source: row.first_source, now });
        results.push('unmatched' in r ? 'UNMATCHED' : r.result);
        await tx.query('RELEASE SAVEPOINT apple_scheduled');
      } catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT apple_scheduled');
        if (error instanceof ApiError && error.statusCode >= 400 && error.statusCode < 500) {
          await resolveScheduled(tx, row.environment, row.transaction_id, `REJECTED_${error.code}`, now);
          results.push(`REJECTED_${error.code}`);
        } else {
          throw error;
        }
      }
    }
  } finally {
    activating.delete(tx);
  }
  return results;
}

/**
 * One sweep over every user with a due scheduled Apple period (background job; also run at startup so a backend
 * restart recovers anything that became due while it was down). Returns the users and results applied.
 */
export async function sweepDueAppleRenewals(pool: pg.Pool, now: Date): Promise<Array<{ userId: string; results: string[] }>> {
  const users = await pool.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM apple_scheduled_renewals WHERE resolved_at IS NULL AND starts_at <= $1`, [now],
  );
  const out: Array<{ userId: string; results: string[] }> = [];
  for (const { user_id: userId } of users.rows) {
    const results = await withTransaction(pool, async (tx) => {
      await lockUser(tx, userId);
      const applied = await applyDueAppleRenewals(tx, userId, now);
      await reconcileUser(tx, userId, now); // then the normal stale-period expiry (D-029)
      return applied;
    });
    if (results.length > 0) out.push({ userId, results });
  }
  return out;
}

/** Starts the periodic sweep. Returns a stop function. */
export function startScheduledRenewalSweeper(pool: pg.Pool, clock: Clock, options: { intervalMs: number; log: (line: string) => void }): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const r of await sweepDueAppleRenewals(pool, clock.now())) {
        options.log(`scheduled Apple renewals applied for user ${r.userId}: ${r.results.join(', ')}`);
      }
    } catch (error) {
      options.log(`scheduled Apple renewal sweep failed: ${(error as Error).message}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

setScheduledPeriodActivator(async (tx, userId, now) => { await applyDueAppleRenewals(tx, userId, now); });

/** Applies verified renewal info (auto-renew status, scheduled downgrade). Caller holds the user lock. */
export async function applyRenewalInfo(tx: Tx, userId: string, info: VerifiedRenewalInfo, analyticsKey: string, now: Date): Promise<string> {
  const link = await tx.query<{ user_id: string }>(
    'SELECT user_id FROM apple_account_links WHERE environment = $1 AND original_transaction_id = $2',
    [info.environment, info.originalTransactionId],
  );
  if (link.rows[0]?.user_id !== userId) return 'IGNORED_UNLINKED_RENEWAL_INFO';
  const loaded = await loadState(tx, userId);
  const last = await tx.query<{ apple_renewal_signed_at: Date | null }>(
    'SELECT apple_renewal_signed_at FROM subscriptions WHERE user_id = $1', [userId],
  );
  const target = info.autoRenewProductId ? appleProduct(info.autoRenewProductId) : null;
  const decision = decideAppleRenewalInfo(loaded?.state ?? null, {
    autoRenew: info.autoRenewStatus,
    autoRenewPlanId: target?.kind === 'SUBSCRIPTION' ? (target.planId as PlanId) : null,
    signedDate: info.signedDate,
  }, last.rows[0]?.apple_renewal_signed_at ?? null, now);
  if (decision.kind === 'ignore') return decision.result;
  // Apple's renewal intent, from the newest verified renewal info, whatever the entitlement (F-M3-03).
  await tx.query(
    `UPDATE subscriptions SET apple_auto_renew = $2, apple_expiration_intent = $3, apple_renewal_signed_at = $4 WHERE id = $1`,
    [loaded!.subscriptionId, info.autoRenewStatus, info.expirationIntent, info.signedDate],
  );
  if (decision.kind === 'intent') return decision.result;
  await tx.query(
    `UPDATE subscriptions SET auto_renew = $2, pending_plan_id = $3 WHERE id = $1`,
    [loaded!.subscriptionId, decision.autoRenew, decision.pendingPlanId],
  );
  for (const event of decision.analytics) {
    await recordAnalyticsEvent(tx, { userId, name: event.name, dedupeKey: analyticsKey, occurredAt: now, properties: event.properties });
  }
  return decision.result;
}

/**
 * Records Apple's subscription status for the user's subscription, only if it is newer (Apple signedDate) than the one
 * stored. Out-of-order or duplicate inputs never move it backwards. Returns false when nothing was recorded.
 */
export async function recordAppleStatus(tx: Tx, userId: string, status: AppleSubscriptionStatus, signedDate: Date): Promise<boolean> {
  const r = await tx.query(
    `UPDATE subscriptions SET apple_status = $3, apple_status_signed_at = $4
      WHERE user_id = $1 AND group_id = $2 AND provider = 'apple' AND (apple_status_signed_at IS NULL OR apple_status_signed_at < $4)`,
    [userId, SUBSCRIPTION_GROUP, status, signedDate],
  );
  return r.rowCount === 1;
}

/**
 * Apple's subscription status from the App Store Server API (Get All Subscription Statuses) for one purchase chain
 * (F-M3-02). `transaction` is the chain's verified latest transaction, `signedDate` the status data's signing time.
 * Applies the M2 EXPIRED rule when Apple says expired and MonetaLab's current period (that same transaction) has
 * ended; otherwise only records the status (lifecycle.ts decideAppleStatus). Caller holds the user lock.
 */
export async function applyAppleStatus(
  tx: Tx, userId: string, input: { status: AppleSubscriptionStatus; transaction: VerifiedTransaction; signedDate: Date }, analyticsKey: string, now: Date,
): Promise<string> {
  const t = input.transaction;
  if (t.productType !== 'SUBSCRIPTION') return 'IGNORED_NOT_A_SUBSCRIPTION';
  const link = await tx.query<{ user_id: string }>(
    'SELECT user_id FROM apple_account_links WHERE environment = $1 AND original_transaction_id = $2', [t.environment, t.originalTransactionId],
  );
  if (link.rows[0]?.user_id !== userId) return 'IGNORED_UNLINKED_STATUS';
  await reconcileUser(tx, userId, now);
  const loaded = await loadState(tx, userId);
  const last = await tx.query<{ apple_status_signed_at: Date | null }>(
    `SELECT apple_status_signed_at FROM subscriptions WHERE user_id = $1 AND group_id = $2`, [userId, SUBSCRIPTION_GROUP],
  );
  const decision = decideAppleStatus(loaded?.state ?? null, {
    status: input.status, latestTransactionKey: storedId(t.environment, t.transactionId), signedDate: input.signedDate,
  }, last.rows[0]?.apple_status_signed_at ?? null, now);
  if (decision.kind === 'ignore') return decision.result;
  const result = decision.expire ? await applyExpiry(tx, userId, t, analyticsKey, now) : decision.result;
  await recordAppleStatus(tx, userId, input.status, input.signedDate);
  return result;
}

/** EXPIRED / GRACE_PERIOD_EXPIRED notifications: the M2 expiry rule for the period of this transaction. */
export async function applyExpiry(tx: Tx, userId: string, t: VerifiedTransaction, analyticsKey: string, now: Date): Promise<string> {
  await reconcileUser(tx, userId, now);
  const loaded = await loadState(tx, userId);
  const decision = decide(loaded?.state ?? null, await loadHistory(tx, userId), { type: 'EXPIRED', transactionId: storedId(t.environment, t.transactionId) }, now);
  if (decision.kind === 'reject') {
    // E.g. the period has not ended on the server clock yet: nothing changes; stale-entitlement reconciliation
    // (D-029) still expires the credits at the verified period end.
    return `DEFERRED_${decision.code}`;
  }
  const applied = await applyDecision(tx, userId, loaded, decision, { provider: 'apple', analyticsKey, now, trialSource: 'APPLE_VERIFIED' });
  return applied.result;
}

/** Records a client sync request (audit). Idempotent by the exact signed payload. */
/**
 * Audit of an app (CLIENT) submission. Keeps the SHA-256 of the signed data (never the JWS itself) and, since F-M3-05,
 * the verified, non-secret identifiers so a re-delivery (e.g. Restore Purchases) can be traced to its transaction.
 */
export async function recordClientSync(tx: Tx, userId: string, signedTransaction: string, t: VerifiedTransaction, result: string, httpStatus: number, now: Date): Promise<void> {
  const request = {
    kind: 'APPLE_TRANSACTION', sha256: sha256(signedTransaction),
    environment: t.environment, transactionId: t.transactionId, originalTransactionId: t.originalTransactionId, productId: t.productId,
  };
  await tx.query(
    `INSERT INTO subscription_events (user_id, provider, event_key, type, request, result, http_status, response, business_time)
     VALUES ($1, 'apple', $2, 'APPLE_TRANSACTION', $3, $4, $5, '{}'::jsonb, $6) ON CONFLICT (provider, event_key) DO NOTHING`,
    [userId, `client:${request.sha256}`, JSON.stringify(request), result, httpStatus, now],
  );
}

export async function customerState(db: Pick<Tx, 'query'>, userId: string, now: Date) {
  return { ...(await subscriptionView(db, userId, now, 'apple')), wallet: await readWallet(db, userId) };
}

export { sha256 };
