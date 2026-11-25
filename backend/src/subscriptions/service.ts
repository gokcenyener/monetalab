/**
 * Database layer of the subscription lifecycle. Applies lifecycle.ts decisions atomically.
 *
 * Concurrency (D-031): every lifecycle change, credit spend and ad reward for a user first takes the per-user lock
 * (users row, FOR NO KEY UPDATE) and then the user's four bucket rows (FOR UPDATE), always in that order.
 * Idempotency: every request/notification has a namespaced key in subscription_events (UNIQUE). A replay by the same
 * user with the same payload returns the stored result; any other reuse is a 409 conflict.
 */
import { isDeepStrictEqual } from 'node:util';
import type pg from 'pg';
import { recordAnalyticsEvent } from '../analytics/events.ts';
import type { MockBillingProvider, PurchaseOutcome } from '../billing/provider.ts';
import { readWallet, type Wallet } from '../credits/wallet.ts';
import { ApiError } from '../http/errors.ts';
import {
  decide, isEntitled, PLANS, SUBSCRIPTION_GROUP, TRIAL_OFFER, trialEligibility,
  type Command, type Decision, type ExpirationReason, type History, type Period, type PlanId, type State,
} from './lifecycle.ts';

type Tx = pg.PoolClient;

export async function lockUser(tx: Tx, userId: string): Promise<void> {
  const { rowCount } = await tx.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
  if (rowCount !== 1) throw new Error('user not found');
}

type PeriodRow = {
  id: string; transaction_id: string; plan_id: PlanId; kind: Period['kind'];
  starts_at: Date; ends_at: Date; credits: number; revoked: boolean;
};
const toPeriod = (r: PeriodRow): Period => ({
  id: r.id, transactionId: r.transaction_id, planId: r.plan_id, kind: r.kind,
  startsAt: r.starts_at, endsAt: r.ends_at, credits: r.credits, revoked: r.revoked,
});
const PERIOD_COLUMNS = `p.id, p.transaction_id, p.plan_id, p.kind, p.starts_at, p.ends_at, p.credits,
  EXISTS (SELECT 1 FROM subscription_revocations r WHERE r.period_id = p.id) AS revoked`;

export type LoadedState = { subscriptionId: string; state: State } | null;

export async function loadState(db: Pick<Tx, 'query'>, userId: string): Promise<LoadedState> {
  const { rows } = await db.query<PeriodRow & { subscription_id: string; status: State['status']; sub_plan_id: PlanId; pending_plan_id: PlanId | null; auto_renew: boolean }>(
    `SELECT s.id AS subscription_id, s.status, s.plan_id AS sub_plan_id, s.pending_plan_id, s.auto_renew, ${PERIOD_COLUMNS}
       FROM subscriptions s JOIN subscription_periods p ON p.id = s.current_period_id
      WHERE s.user_id = $1 AND s.group_id = $2`,
    [userId, SUBSCRIPTION_GROUP],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    subscriptionId: r.subscription_id,
    state: { status: r.status, planId: r.sub_plan_id, pendingPlanId: r.pending_plan_id, autoRenew: r.auto_renew, current: toPeriod(r) },
  };
}

export async function loadHistory(db: Pick<Tx, 'query'>, userId: string): Promise<History> {
  const { rows } = await db.query<{ trial: boolean; any_period: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM trial_redemptions WHERE user_id = $1 AND group_id = $2) AS trial,
            EXISTS (SELECT 1 FROM subscription_periods WHERE user_id = $1 AND disposition = 'APPLIED') AS any_period`,
    [userId, SUBSCRIPTION_GROUP],
  );
  return { trialRedeemed: rows[0]!.trial, hadAnyPeriod: rows[0]!.any_period };
}

/** Expire the remaining SUBSCRIPTION credits, recorded once against the period they belonged to. Returns the amount. */
export async function expireRemaining(tx: Tx, userId: string, periodId: string, reason: ExpirationReason): Promise<number> {
  const wallet = await readWallet(tx, userId, true);
  const amount = wallet.balances.SUBSCRIPTION;
  if (amount <= 0) return 0;
  const done = await tx.query(
    `SELECT 1 FROM credit_ledger WHERE subscription_period_id = $1 AND entry_type = 'SUBSCRIPTION_EXPIRATION'`,
    [periodId],
  );
  if (done.rowCount) return 0;
  await tx.query(
    `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, subscription_period_id, expiration_reason)
     VALUES ($1, 'SUBSCRIPTION', $2, 'SUBSCRIPTION_EXPIRATION', $3, $4)`,
    [userId, -amount, periodId, reason],
  );
  return amount;
}

/**
 * Stale entitlement (D-029): subscription credits never outlive their period. If the current period has ended and no
 * newer verified period arrived yet, its remaining credits expire now (PERIOD_ENDED). Status and analytics change
 * only on authoritative provider events, so a late renewal still works. Caller holds the user lock.
 */
/**
 * Provider hook (F-M3-04): applies provider periods that were delivered before they started and have now started
 * (Apple scheduled renewals), before the stale-period check. Set by the Apple billing module; null = none.
 */
type ScheduledPeriodActivator = (tx: Tx, userId: string, now: Date) => Promise<void>;
let scheduledPeriodActivator: ScheduledPeriodActivator | null = null;
export function setScheduledPeriodActivator(fn: ScheduledPeriodActivator | null): void {
  scheduledPeriodActivator = fn;
}

export async function reconcileUser(tx: Tx, userId: string, now: Date): Promise<void> {
  if (scheduledPeriodActivator) await scheduledPeriodActivator(tx, userId, now);
  const loaded = await loadState(tx, userId);
  if (!loaded) return;
  const { state } = loaded;
  if ((state.status === 'TRIAL' || state.status === 'ACTIVE') && now >= state.current.endsAt) {
    await expireRemaining(tx, userId, state.current.id, 'PERIOD_ENDED');
  }
}

export type LifecycleInput = {
  eventKey: string;
  type: 'PURCHASE' | 'CHANGE_PLAN' | 'CANCEL_AUTO_RENEW' | 'RESUME_AUTO_RENEW' | 'RENEWED' | 'EXPIRED' | 'REFUNDED' | 'REVOKED';
  /** Normalized request payload; an idempotent replay must match it exactly. */
  request: Record<string, unknown>;
  conflictCode: 'TRANSACTION_CONFLICT' | 'EVENT_CONFLICT' | 'REQUEST_ID_CONFLICT';
  mockOutcome?: PurchaseOutcome | undefined;
  /** Builds the lifecycle command; may look up periods. */
  command: (tx: Tx) => Promise<Command>;
};

export type LifecycleOutcome = { status: number; result: string; replayed: boolean; period: unknown };

function periodView(p: { id: string; transactionId: string; planId: PlanId; kind: string; startsAt: Date; endsAt: Date; credits: number }, extra: Record<string, unknown> = {}) {
  return {
    id: p.id, transactionId: p.transactionId, planId: p.planId, kind: p.kind,
    startsAt: p.startsAt.toISOString(), endsAt: p.endsAt.toISOString(), credits: p.credits, ...extra,
  };
}

export async function runLifecycle(
  tx: Tx,
  deps: { billing: MockBillingProvider; now: Date },
  userId: string,
  input: LifecycleInput,
): Promise<LifecycleOutcome> {
  const { now } = deps;
  await lockUser(tx, userId);

  const existing = await tx.query<{ user_id: string; request: unknown; result: string; http_status: number; response: { period: unknown } }>(
    `SELECT user_id, request, result, http_status, response FROM subscription_events WHERE provider = 'mock' AND event_key = $1`,
    [input.eventKey],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.user_id !== userId || !isDeepStrictEqual(row.request, input.request)) {
      throw new ApiError(409, input.conflictCode, 'This id was already used with a different request');
    }
    return { status: 200, result: row.result, replayed: true, period: row.response.period };
  }

  await reconcileUser(tx, userId, now);
  const loaded = await loadState(tx, userId);
  const state = loaded?.state ?? null;
  const history = await loadHistory(tx, userId);
  const command = await input.command(tx);

  // Transaction ids are unique per provider. A transaction already recorded is the same verified fact delivered
  // again: for a renewal notification it is a no-op; anything else reusing it (or another user) is a conflict.
  // This runs before the lifecycle rules so a redelivered renewal is never re-evaluated as a new one.
  if (command.type === 'PURCHASE' || command.type === 'CHANGE_PLAN' || command.type === 'RENEWED') {
    const taken = await tx.query<{ user_id: string }>(
      `SELECT user_id FROM subscription_periods WHERE provider = 'mock' AND transaction_id = $1`,
      [command.transactionId],
    );
    if (taken.rows[0]) {
      if (taken.rows[0].user_id !== userId || command.type !== 'RENEWED') {
        throw new ApiError(409, 'TRANSACTION_CONFLICT', 'This transaction id was already used');
      }
      return record(tx, userId, input, 'IGNORED_DUPLICATE_TRANSACTION', 200, null, now);
    }
  }

  const decision = decide(state, history, command, now);
  if (decision.kind === 'reject') throw new ApiError(decision.status, decision.code, decision.message);

  const newPeriod = decision.newPeriod;

  // Purchases and upgrades are verified with the provider only when the rules would apply them.
  if (decision.kind === 'apply' && newPeriod && (input.type === 'PURCHASE' || input.type === 'CHANGE_PLAN')) {
    const verified = await deps.billing.verifySubscriptionTransaction({
      transactionId: newPeriod.transactionId, planId: newPeriod.planId, mockOutcome: input.mockOutcome,
    });
    if (verified.outcome !== 'APPROVED') {
      // BUY-02 analogue: a declined/cancelled subscription purchase changes nothing (trial stays unused).
      return record(tx, userId, input, verified.outcome, 201, null, now);
    }
  }

  const applied = await applyDecision(tx, userId, loaded, decision, {
    provider: 'mock', analyticsKey: input.eventKey, now, trialSource: 'MOCK_PROVIDER',
  });
  return record(tx, userId, input, applied.result, applied.httpStatus, applied.period, now);
}

export type ApplyContext = {
  provider: 'mock' | 'apple';
  /** Idempotency key of the source fact; analytics events are deduplicated by it. */
  analyticsKey: string;
  now: Date;
  trialSource: 'MOCK_PROVIDER' | 'APPLE_VERIFIED';
};

/**
 * Applies a lifecycle decision (from lifecycle.ts or the Apple mapping) atomically. Caller holds the user lock and has
 * already rejected 'reject' decisions. Shared by the mock and Apple providers so both obey the same accounting.
 * - A new period is always recorded (APPLIED or SUPERSEDED, immutable).
 * - The current period's remaining SUBSCRIPTION credits expire once, against that period.
 * - Credits are granted once per applied period (DB-enforced), only when the decision says so and the period has credits.
 */
export async function applyDecision(
  tx: Tx,
  userId: string,
  loaded: LoadedState,
  decision: Exclude<Decision, { kind: 'reject' }>,
  ctx: ApplyContext,
): Promise<{ result: string; httpStatus: number; period: unknown }> {
  const { now } = ctx;
  const state = loaded?.state ?? null;
  let result = decision.result;
  let httpStatus = decision.kind === 'apply' ? 201 : 200;
  let periodOut: unknown = null;
  const newPeriod = decision.newPeriod;
  let subscriptionId = loaded?.subscriptionId;
  let newPeriodId: string | null = null;
  if (newPeriod) {
    newPeriodId = crypto.randomUUID();
    if (!subscriptionId) {
      // First subscription for this user: the state row points at the period inserted next (deferred FK).
      const created = await tx.query<{ id: string }>(
        `INSERT INTO subscriptions (user_id, group_id, provider, status, plan_id, auto_renew, current_period_id)
         VALUES ($1, $2, $6, $3, $4, true, $5) RETURNING id`,
        [userId, SUBSCRIPTION_GROUP, decision.kind === 'apply' ? decision.next.status : 'ACTIVE', newPeriod.planId, newPeriodId, ctx.provider],
      );
      subscriptionId = created.rows[0]!.id;
    }
    await tx.query(
      `INSERT INTO subscription_periods (id, subscription_id, user_id, provider, transaction_id, plan_id, kind, starts_at, ends_at, credits, disposition)
       VALUES ($1, $2, $3, $11, $4, $5, $6, $7, $8, $9, $10)`,
      [newPeriodId, subscriptionId, userId, newPeriod.transactionId, newPeriod.planId, newPeriod.kind,
        newPeriod.startsAt, newPeriod.endsAt, newPeriod.credits, newPeriod.disposition, ctx.provider],
    );
    periodOut = periodView({ ...newPeriod, id: newPeriodId }, { disposition: newPeriod.disposition });
  }

  if (decision.kind === 'apply') {
    if (decision.expireCurrent && state) await expireRemaining(tx, userId, state.current.id, decision.expireCurrent);
    if (decision.revokePeriod) {
      await tx.query(
        `INSERT INTO subscription_revocations (period_id, user_id, reason, revoked_at) VALUES ($1, $2, $3, $4)`,
        [decision.revokePeriod.periodId, userId, decision.revokePeriod.reason, now],
      );
    }
    const next = decision.next;
    const applied = newPeriod?.disposition === 'APPLIED';
    await tx.query(
      `UPDATE subscriptions
          SET current_period_id = COALESCE($2, current_period_id),
              status = COALESCE($3, status),
              plan_id = COALESCE($4, plan_id),
              pending_plan_id = CASE WHEN $5 THEN $6 ELSE pending_plan_id END,
              auto_renew = COALESCE($7, auto_renew)
        WHERE id = $1`,
      [subscriptionId, applied ? newPeriodId : null, next.status ?? null, next.planId ?? null,
        'pendingPlanId' in next, next.pendingPlanId ?? null, next.autoRenew ?? null],
    );
    if (newPeriod && applied && decision.grant && newPeriod.credits > 0) {
      await tx.query(
        `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, subscription_period_id)
         VALUES ($1, 'SUBSCRIPTION', $2, 'SUBSCRIPTION_GRANT', $3)`,
        [userId, newPeriod.credits, newPeriodId],
      );
    }
    if (decision.redeemTrial) {
      await tx.query(
        `INSERT INTO trial_redemptions (user_id, group_id, period_id, source, redeemed_at) VALUES ($1, $2, $3, $5, $4)`,
        [userId, SUBSCRIPTION_GROUP, newPeriodId, now, ctx.trialSource],
      );
    }
    for (const event of decision.analytics) {
      await recordAnalyticsEvent(tx, { userId, name: event.name, dedupeKey: ctx.analyticsKey, occurredAt: now, properties: event.properties });
    }
  } else {
    httpStatus = 200;
    result = decision.result;
  }
  return { result, httpStatus, period: periodOut };
}

async function record(tx: Tx, userId: string, input: LifecycleInput, result: string, httpStatus: number, period: unknown, now: Date): Promise<LifecycleOutcome> {
  const inserted = await tx.query(
    `INSERT INTO subscription_events (user_id, provider, event_key, type, request, result, http_status, response, business_time)
     VALUES ($1, 'mock', $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (provider, event_key) DO NOTHING`,
    [userId, input.eventKey, input.type, JSON.stringify(input.request), result, httpStatus, JSON.stringify({ period }), now],
  );
  // Another user's concurrent request claimed this key first (we hold only our own user's lock).
  if (inserted.rowCount !== 1) throw new ApiError(409, input.conflictCode, 'This id was already used with a different request');
  return { status: httpStatus, result, replayed: false, period };
}

/** Customer-facing view of the subscription and trial eligibility. */
export async function subscriptionView(db: Pick<Tx, 'query'>, userId: string, now: Date, provider: 'mock' | 'apple' = 'mock') {
  const loaded = await loadState(db, userId);
  const history = await loadHistory(db, userId);
  const eligibility = trialEligibility(history);
  const state = loaded?.state ?? null;
  const entitled = isEntitled(state, now);
  // Apple mode: Apple's own status and renewal intent, kept apart from MonetaLab's entitlement/lifecycle (migration 005).
  const apple = provider === 'apple' && loaded
    ? (await db.query<{ apple_status: string | null; apple_auto_renew: boolean | null; apple_expiration_intent: number | null; apple_status_signed_at: Date | null }>(
        'SELECT apple_status, apple_auto_renew, apple_expiration_intent, apple_status_signed_at FROM subscriptions WHERE id = $1', [loaded.subscriptionId],
      )).rows[0]
    : undefined;
  return {
    subscription: state && {
      id: loaded!.subscriptionId,
      planId: state.planId,
      planName: PLANS[state.planId].name,
      status: state.status,
      entitled,
      autoRenew: state.autoRenew,
      pendingPlanId: state.pendingPlanId,
      // The renewal date only exists while the period is valid and auto-renew is on.
      renewsAt: entitled && state.autoRenew ? state.current.endsAt.toISOString() : null,
      expiresAt: state.current.endsAt.toISOString(),
      currentPeriod: periodView(state.current, { revoked: state.current.revoked }),
      ...(apple && {
        apple: {
          status: apple.apple_status,
          autoRenew: apple.apple_auto_renew,
          expirationIntent: apple.apple_expiration_intent,
          statusSignedAt: apple.apple_status_signed_at?.toISOString() ?? null,
        },
      }),
    },
    trial: {
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      // mock: the backend's own record decides. apple (D-042): the backend record is only HALF of the rule; Apple decides
      // intro-offer eligibility per Apple ID, and the app must also check StoreKit's isEligibleForIntroOffer before
      // showing an offer. Trial credits are granted only when BOTH agree (verified free-trial transaction + this record).
      source: provider === 'apple' ? 'BACKEND_RECORD_AND_APPLE' : 'BACKEND_RECORD',
      // PRD §3.1: trial messaging is present only when the customer is eligible.
      offer: eligibility.eligible
        ? {
            planId: TRIAL_OFFER.planId,
            days: TRIAL_OFFER.days,
            credits: TRIAL_OFFER.credits,
            message: provider === 'apple'
              ? `Basic includes a ${TRIAL_OFFER.days}-day free trial with ${TRIAL_OFFER.credits.toLocaleString('en-US')} credits when the App Store confirms you're eligible. Then Basic renews weekly with ${PLANS.BASIC_WEEKLY.credits.toLocaleString('en-US')} credits.`
              : `Start a ${TRIAL_OFFER.days}-day free trial with ${TRIAL_OFFER.credits.toLocaleString('en-US')} credits. Then Basic renews weekly with ${PLANS.BASIC_WEEKLY.credits.toLocaleString('en-US')} credits.`,
          }
        : null,
    },
  };
}

export type { Wallet };
