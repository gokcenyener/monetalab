/**
 * Pure mapping of VERIFIED Apple subscription data onto the M2 lifecycle (D-041, D-042, D-043). No I/O.
 *
 * The M2 rules are kept (PRD §2.1, SUB-01..06): a new verified period expires the previous period's remaining
 * subscription credits and grants the plan allotment once; downgrades never change credits until they take effect;
 * cancelling auto-renew keeps the entitlement; refunds/revocations remove remaining subscription credits; consumed
 * credits are never clawed back; nothing restores a revoked period.
 *
 * What differs from the mock: Apple's signed transaction decides the period. Its purchaseDate/expiresDate are the
 * effective billing transition (not the server's 7-day arithmetic and never the client clock), and the plan comes
 * from the signed productId. Effective plan changes are derived from the verified transaction, not from a UI tap.
 */
import {
  decide, isEntitled, PLANS, TRIAL_OFFER, trialEligibility,
  type AnalyticsEvent, type Decision, type History, type NewPeriod, type Period, type PlanId, type State,
} from '../../subscriptions/lifecycle.ts';

/**
 * A verified transaction whose period has not started yet (F-M3-04): Apple signs and notifies renewals ahead of the
 * period. It is recorded and scheduled; credits are granted only once `startsAt <= now` (no clock tolerance).
 */
export type ScheduleDecision = { kind: 'schedule'; result: 'RENEWAL_SCHEDULED'; startsAt: Date };

export type AppleSubscriptionFact = {
  /** Stored transaction id: "<environment>:<transactionId>". */
  key: string;
  planId: PlanId;
  purchaseDate: Date;
  expiresDate: Date;
  /** Verified introductory offer (offerType 1). Such a period never receives paid-plan credits. */
  introOffer: boolean;
  /** The introductory offer is explicitly a FREE_TRIAL (offerDiscountType). Only then can trial credits be funded. */
  freeTrial: boolean;
  /** Apple replaced this transaction with an upgrade (isUpgraded). */
  isUpgraded: boolean;
  revocation: { reason: 'REFUNDED' | 'REVOKED' } | null;
};

const ignore = (result: string, message: string, newPeriod?: NewPeriod): Decision =>
  ({ kind: 'ignore', result, message, ...(newPeriod && { newPeriod }) });

/**
 * Decide what one verified subscription transaction means for this customer.
 * `known` is the period already recorded for this exact transaction (idempotency), if any.
 */
export function decideAppleTransaction(state: State | null, history: History, fact: AppleSubscriptionFact, known: Period | null, now: Date): Decision | ScheduleDecision {
  const plan = PLANS[fact.planId];

  // Refund / revocation of a transaction (SUB-06). Same rule as the mock: only an already-recorded period can be
  // revoked; the current one ends now and loses its remaining subscription credits.
  if (fact.revocation) {
    if (!known) return ignore('IGNORED_REVOKED_UNKNOWN', 'A revoked transaction that was never applied grants nothing');
    return decide(state, history, { type: fact.revocation.reason, transactionId: fact.key, period: known }, now);
  }
  if (known) return ignore('IGNORED_DUPLICATE_TRANSACTION', 'This transaction was already applied');

  const credits = fact.introOffer ? 0 : plan.credits;
  const audit = (kind: NewPeriod['kind']): NewPeriod => ({
    transactionId: fact.key, planId: plan.id, kind, startsAt: fact.purchaseDate, endsAt: fact.expiresDate,
    credits, disposition: 'SUPERSEDED',
  });

  if (fact.isUpgraded) {
    // Apple replaced it with a higher tier; the upgrade transaction carries the entitlement.
    return ignore('IGNORED_UPGRADED', 'This transaction was replaced by an upgrade', state ? audit(fact.introOffer ? 'TRIAL' : 'INITIAL') : undefined);
  }
  if (state && fact.purchaseDate <= state.current.startsAt) {
    // Delayed / out-of-order: an older period than the current one (D-030). Audit only, no credits.
    return ignore('IGNORED_SUPERSEDED', 'A newer period is already in effect', audit(fact.introOffer ? 'TRIAL' : 'RENEWAL'));
  }
  if (fact.purchaseDate.getTime() > now.getTime()) {
    // Credits are replenished at the effective transition, never earlier (PRD §2.1). Apple delivers renewals before
    // they start, so the verified transaction is kept and applied when its period starts (F-M3-04).
    return { kind: 'schedule', result: 'RENEWAL_SCHEDULED', startsAt: fact.purchaseDate };
  }
  const grant = fact.expiresDate > now;

  if (fact.introOffer) {
    // D-042: trial credits need BOTH a verified Apple FREE_TRIAL introductory transaction AND the backend
    // anti-duplication record, and only for the approved Basic offer (PRD §2.1, open decisions #4 and #9).
    // Any other introductory period is entitled with 0 credits (never the paid allotment).
    const funded = fact.freeTrial && plan.id === TRIAL_OFFER.planId && trialEligibility(history).eligible;
    return {
      kind: 'apply',
      result: funded ? 'TRIAL_STARTED' : 'TRIAL_STARTED_NOT_FUNDED',
      newPeriod: { ...audit('TRIAL'), credits: funded ? TRIAL_OFFER.credits : 0, disposition: 'APPLIED' },
      grant: funded && grant,
      ...(state && { expireCurrent: 'SUPERSEDED' as const }),
      redeemTrial: funded,
      next: { status: 'TRIAL', planId: plan.id, pendingPlanId: null, autoRenew: true },
      analytics: [{ name: 'trial_started', properties: { planId: plan.id, credits: funded ? TRIAL_OFFER.credits : 0, provider: 'apple', funded } }],
    };
  }

  const active = !!state && (state.status === 'TRIAL' || state.status === 'ACTIVE');
  if (!state || !active) {
    // First paid period, or resubscription after expiry/revocation (a new period; never reactivates the old one).
    return {
      kind: 'apply',
      result: 'SUBSCRIPTION_STARTED',
      newPeriod: { ...audit('INITIAL'), disposition: 'APPLIED' },
      grant,
      ...(state && { expireCurrent: 'SUPERSEDED' as const }),
      next: { status: 'ACTIVE', planId: plan.id, pendingPlanId: null, autoRenew: true },
      analytics: [{ name: 'subscription_started', properties: { planId: plan.id, fromTrial: false, resubscribe: !!state, provider: 'apple' } }],
    };
  }

  const current = PLANS[state.planId];
  const fromTrial = state.current.kind === 'TRIAL';
  if (fact.purchaseDate < state.current.endsAt) {
    // Effective immediately, inside the current period: Apple applies upgrades immediately (SUB-03).
    if (plan.tier > current.tier) {
      return {
        kind: 'apply',
        result: 'UPGRADED',
        newPeriod: { ...audit('UPGRADE'), disposition: 'APPLIED' },
        grant,
        expireCurrent: 'SUPERSEDED',
        next: { status: 'ACTIVE', planId: plan.id, pendingPlanId: null },
        analytics: [
          { name: 'subscription_upgraded', properties: { fromPlanId: current.id, toPlanId: plan.id, fromTrial, provider: 'apple' } },
          ...(fromTrial ? [{ name: 'subscription_started' as const, properties: { planId: plan.id, fromTrial: true, resubscribe: false, provider: 'apple' } }] : []),
        ],
      };
    }
    // A same- or lower-tier period overlapping the current one has no rule in MonetaLab's catalog (downgrades take
    // effect at renewal). Kept for audit; nothing changes. Reported for review (D-043).
    return ignore('IGNORED_UNEXPECTED_OVERLAP', 'A same- or lower-tier period overlaps the current period', audit('RENEWAL'));
  }

  // Renewal at (or after) the end of the current period: trial conversion (SUB-01), renewal (SUB-02) or the
  // effective downgrade (SUB-05) when the renewed product is a lower tier.
  const downgraded = !fromTrial && plan.tier < current.tier;
  const analytics: AnalyticsEvent[] = fromTrial
    ? [{ name: 'subscription_started', properties: { planId: plan.id, fromTrial: true, resubscribe: false, provider: 'apple' } }]
    : [
        ...(downgraded ? [{ name: 'subscription_downgraded' as const, properties: { fromPlanId: current.id, toPlanId: plan.id, provider: 'apple' } }] : []),
        { name: 'subscription_renewed', properties: { planId: plan.id, reactivated: false, provider: 'apple' } },
      ];
  return {
    kind: 'apply',
    result: fromTrial ? 'TRIAL_CONVERTED' : downgraded ? 'RENEWED_DOWNGRADED' : 'RENEWED',
    newPeriod: { ...audit('RENEWAL'), disposition: 'APPLIED' },
    grant,
    expireCurrent: 'SUPERSEDED',
    next: { status: 'ACTIVE', planId: plan.id, pendingPlanId: null },
    analytics,
  };
}

export type AppleRenewalFact = { autoRenew: boolean; autoRenewPlanId: PlanId | null; signedDate: Date };

export type RenewalDecision =
  | { kind: 'ignore'; result: string }
  /** Ended or not entitled: record Apple's renewal intent only; MonetaLab's lifecycle is unchanged (F-M3-03). */
  | { kind: 'intent'; result: string }
  | { kind: 'apply'; result: string; autoRenew: boolean; pendingPlanId: PlanId | null; analytics: AnalyticsEvent[] };

/**
 * Renewal info (auto-renew status and the product that renews next). Only the newest signed renewal info counts.
 * A lower-tier autoRenewProductId is a scheduled downgrade (SUB-04: no credit change now). Turning auto-renew off is
 * a cancellation of auto-renew, not an expiry (PRD §4).
 * For a subscription that is no longer entitled, the newest renewal info is still Apple's renewal intent (it may say
 * auto-renew ON, e.g. after a billing failure), so it is recorded (`intent`) without changing MonetaLab's lifecycle,
 * without analytics and without scheduling a downgrade (F-M3-03).
 */
export function decideAppleRenewalInfo(state: State | null, info: AppleRenewalFact, lastSignedAt: Date | null, now: Date): RenewalDecision {
  if (!state) return { kind: 'ignore', result: 'IGNORED_NO_SUBSCRIPTION' };
  if (lastSignedAt && info.signedDate <= lastSignedAt) return { kind: 'ignore', result: 'IGNORED_STALE_RENEWAL_INFO' };
  if (!(state.status === 'TRIAL' || state.status === 'ACTIVE') || !isEntitled(state, now)) {
    return { kind: 'intent', result: info.autoRenew ? 'RENEWAL_INTENT_RECORDED_AUTO_RENEW_ON' : 'RENEWAL_INTENT_RECORDED_AUTO_RENEW_OFF' };
  }
  const current = PLANS[state.planId];
  const target = info.autoRenewPlanId ? PLANS[info.autoRenewPlanId] : null;
  const pendingPlanId = info.autoRenew && target && target.tier < current.tier ? target.id : null;
  const results: string[] = [];
  const analytics: AnalyticsEvent[] = [];
  if (state.autoRenew && !info.autoRenew) {
    results.push('AUTO_RENEW_DISABLED');
    analytics.push({ name: 'subscription_cancelled', properties: { planId: state.planId, periodEndsAt: state.current.endsAt.toISOString(), duringTrial: state.status === 'TRIAL', provider: 'apple' } });
  } else if (!state.autoRenew && info.autoRenew) {
    results.push('AUTO_RENEW_ENABLED');
  }
  if (pendingPlanId !== state.pendingPlanId) results.push(pendingPlanId ? 'DOWNGRADE_SCHEDULED' : 'DOWNGRADE_CANCELLED');
  return { kind: 'apply', result: results.join('+') || 'RENEWAL_INFO_UNCHANGED', autoRenew: info.autoRenew, pendingPlanId, analytics };
}

/** App Store Server API subscription status codes (Get All Subscription Statuses, `status`). */
export const APPLE_STATUS_CODES = { 1: 'ACTIVE', 2: 'EXPIRED', 3: 'BILLING_RETRY', 4: 'GRACE_PERIOD', 5: 'REVOKED' } as const;
export type AppleSubscriptionStatus = (typeof APPLE_STATUS_CODES)[keyof typeof APPLE_STATUS_CODES];
export function appleStatusOf(code: unknown): AppleSubscriptionStatus | null {
  return (APPLE_STATUS_CODES as Record<number, AppleSubscriptionStatus>)[Number(code)] ?? null;
}

export type AppleStatusFact = { status: AppleSubscriptionStatus; latestTransactionKey: string; signedDate: Date };
export type AppleStatusDecision =
  | { kind: 'ignore'; result: string }
  /** Record Apple's status; `expire` = also apply the M2 EXPIRED rule to the current period. */
  | { kind: 'record'; result: string; expire: boolean };

/**
 * Apple's subscription status for the purchase chain (F-M3-02). Only the newest status counts (by Apple's signedDate).
 * - EXPIRED for the transaction that is MonetaLab's current period, after that period ended on the server clock:
 *   the M2 EXPIRED rule applies (status EXPIRED; remaining credits were already expired at the period end, D-029).
 *   If MonetaLab's current period is a different transaction, or the period has not ended yet, nothing expires here.
 * - BILLING_RETRY / GRACE_PERIOD: recorded only. No entitlement extension and no credits (D-046, PRD open decision
 *   #6); entitlement ends at the verified period end, and a later renewal still applies as a renewal.
 * - REVOKED: recorded only; the revocation itself is applied from the verified transaction's revocationDate.
 * - ACTIVE: recorded only; periods come from verified transactions, never from the status.
 */
export function decideAppleStatus(state: State | null, fact: AppleStatusFact, lastSignedAt: Date | null, now: Date): AppleStatusDecision {
  if (!state) return { kind: 'ignore', result: 'IGNORED_NO_SUBSCRIPTION' };
  if (lastSignedAt && fact.signedDate <= lastSignedAt) return { kind: 'ignore', result: 'IGNORED_STALE_STATUS' };
  switch (fact.status) {
    case 'EXPIRED': {
      const live = state.status === 'TRIAL' || state.status === 'ACTIVE';
      if (!live) return { kind: 'record', result: 'APPLE_EXPIRED_RECORDED', expire: false };
      if (fact.latestTransactionKey !== state.current.transactionId) {
        return { kind: 'record', result: 'APPLE_EXPIRED_LATEST_PERIOD_NOT_APPLIED', expire: false };
      }
      if (now < state.current.endsAt) return { kind: 'record', result: 'APPLE_EXPIRED_PERIOD_NOT_ENDED', expire: false };
      return { kind: 'record', result: 'EXPIRED', expire: true };
    }
    case 'BILLING_RETRY': return { kind: 'record', result: 'BILLING_RETRY_RECORDED', expire: false };
    case 'GRACE_PERIOD': return { kind: 'record', result: 'GRACE_PERIOD_NOT_APPLIED', expire: false };
    case 'REVOKED': return { kind: 'record', result: 'APPLE_REVOKED_RECORDED', expire: false };
    case 'ACTIVE': return { kind: 'record', result: 'APPLE_ACTIVE_RECORDED', expire: false };
  }
}

/**
 * The subscription status a Notifications V2 type implies (recorded with the notification's signedDate, so a delayed
 * or retried older notification never overrides a newer status). null = the type carries no status.
 */
export function appleStatusOfNotification(type: string, subtype: string | null): AppleSubscriptionStatus | null {
  switch (type) {
    case 'EXPIRED':
    case 'GRACE_PERIOD_EXPIRED': return 'EXPIRED';
    case 'DID_FAIL_TO_RENEW': return subtype === 'GRACE_PERIOD' ? 'GRACE_PERIOD' : 'BILLING_RETRY';
    case 'DID_RENEW':
    case 'SUBSCRIBED': return 'ACTIVE';
    case 'REVOKE': return 'REVOKED';
    default: return null;
  }
}

/** offerType 1 is Apple's introductory offer; FREE_TRIAL must be stated explicitly by offerDiscountType. */
export function introOfferOf(offerType: number | null, offerDiscountType: string | null): { introOffer: boolean; freeTrial: boolean } {
  const introOffer = offerType === 1;
  return { introOffer, freeTrial: introOffer && offerDiscountType === 'FREE_TRIAL' };
}
