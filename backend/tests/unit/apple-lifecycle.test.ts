/**
 * Apple -> MonetaLab lifecycle mapping (pure). Expectations are written from the PRD rules (§2.1, SUB-01..06,
 * TRIAL-01/02) and Apple's verified dates, not from the implementation. Categories (D-005): [BR], [NEG].
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appleStatusOf, appleStatusOfNotification, decideAppleRenewalInfo, decideAppleStatus, decideAppleTransaction, introOfferOf, type AppleSubscriptionFact,
} from '../../src/billing/apple/lifecycle.ts';
import type { History, Period, PlanId, State } from '../../src/subscriptions/lifecycle.ts';

const T0 = new Date('2031-03-01T10:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const fresh: History = { trialRedeemed: false, hadAnyPeriod: false };
const used: History = { trialRedeemed: true, hadAnyPeriod: true };

function fact(p: Partial<AppleSubscriptionFact> & { planId?: PlanId }): AppleSubscriptionFact {
  const purchaseDate = p.purchaseDate ?? T0;
  return {
    key: p.key ?? `Sandbox:${Math.random()}`, planId: p.planId ?? 'BASIC_WEEKLY', purchaseDate,
    expiresDate: p.expiresDate ?? new Date(purchaseDate.getTime() + 7 * DAY), introOffer: false, freeTrial: false,
    isUpgraded: false, revocation: null, ...p,
  };
}
function state(p: { planId?: PlanId; status?: State['status']; kind?: Period['kind']; start?: Date; end?: Date; autoRenew?: boolean; pending?: PlanId | null; credits?: number }): State {
  const startsAt = p.start ?? T0;
  return {
    status: p.status ?? 'ACTIVE', planId: p.planId ?? 'BASIC_WEEKLY', pendingPlanId: p.pending ?? null, autoRenew: p.autoRenew ?? true,
    current: { id: 'cur', transactionId: 'Sandbox:cur', planId: p.planId ?? 'BASIC_WEEKLY', kind: p.kind ?? 'INITIAL', startsAt, endsAt: p.end ?? new Date(startsAt.getTime() + 7 * DAY), credits: p.credits ?? 3000, revoked: false },
  };
}
const applied = (d: ReturnType<typeof decideAppleTransaction>) => {
  assert.equal(d.kind, 'apply', JSON.stringify(d));
  return d as Extract<typeof d, { kind: 'apply' }>;
};

describe('Apple subscription transactions', () => {
  it('[BR][TRIAL-01] a verified Basic FREE_TRIAL for a first-time customer: 1,000 credits, period = Apple dates', () => {
    const d = applied(decideAppleTransaction(null, fresh, fact({ introOffer: true, freeTrial: true, expiresDate: at(3) }), null, at(0.01)));
    assert.equal(d.result, 'TRIAL_STARTED');
    assert.equal(d.newPeriod!.credits, 1000);
    assert.equal(d.newPeriod!.endsAt.toISOString(), at(3).toISOString());
    assert.equal(d.redeemTrial, true);
    assert.equal(d.grant, true);
  });

  it('[BR][TRIAL-02] Apple grants a trial but the backend record says it was used: entitled, 0 credits, no redemption', () => {
    const d = applied(decideAppleTransaction(null, used, fact({ introOffer: true, freeTrial: true, expiresDate: at(3) }), null, at(0.01)));
    assert.equal(d.result, 'TRIAL_STARTED_NOT_FUNDED');
    assert.equal(d.newPeriod!.credits, 0);
    assert.equal(d.redeemTrial, false);
    assert.equal(d.next.status, 'TRIAL');
  });

  it('[NEG] an intro offer on Premium (no approved offer) or a non-FREE_TRIAL intro: 0 credits, never the paid allotment', () => {
    for (const f of [fact({ planId: 'PREMIUM_WEEKLY', introOffer: true, freeTrial: true }), fact({ introOffer: true, freeTrial: false })]) {
      const d = applied(decideAppleTransaction(null, fresh, f, null, at(0.01)));
      assert.equal(d.newPeriod!.credits, 0);
      assert.equal(d.redeemTrial, false);
    }
    assert.deepEqual(introOfferOf(1, 'FREE_TRIAL'), { introOffer: true, freeTrial: true });
    assert.deepEqual(introOfferOf(1, null), { introOffer: true, freeTrial: false });
    assert.deepEqual(introOfferOf(2, 'FREE_TRIAL'), { introOffer: false, freeTrial: false });
  });

  it('[BR][SUB-01] trial conversion: the paid Basic renewal at the trial end expires the remainder and grants 3,000', () => {
    const s = state({ status: 'TRIAL', kind: 'TRIAL', end: at(3), credits: 1000 });
    const d = applied(decideAppleTransaction(s, used, fact({ purchaseDate: at(3), expiresDate: at(10) }), null, at(3.001)));
    assert.equal(d.result, 'TRIAL_CONVERTED');
    assert.equal(d.expireCurrent, 'SUPERSEDED');
    assert.equal(d.newPeriod!.credits, 3000);
    assert.ok(d.analytics.some((e) => e.name === 'subscription_started' && e.properties.fromTrial === true));
  });

  it('[BR][SUB-02] renewal: new period from Apple dates, remainder expires, one grant', () => {
    const d = applied(decideAppleTransaction(state({}), used, fact({ purchaseDate: at(7), expiresDate: at(14) }), null, at(7.01)));
    assert.equal(d.result, 'RENEWED');
    assert.equal(d.newPeriod!.kind, 'RENEWAL');
    assert.equal(d.newPeriod!.startsAt.toISOString(), at(7).toISOString());
  });

  it('[BR][SUB-03] an upgrade inside the current period is effective now with the full new allotment', () => {
    const d = applied(decideAppleTransaction(state({}), used, fact({ planId: 'ULTRA_WEEKLY', purchaseDate: at(2), expiresDate: at(9) }), null, at(2.01)));
    assert.equal(d.result, 'UPGRADED');
    assert.equal(d.newPeriod!.credits, 12000);
    assert.equal(d.expireCurrent, 'SUPERSEDED');
  });

  it('[BR][SUB-05] the downgrade takes effect at renewal: lower-tier renewal grants the lower allotment', () => {
    const d = applied(decideAppleTransaction(state({ planId: 'ULTRA_WEEKLY', pending: 'BASIC_WEEKLY' }), used, fact({ planId: 'BASIC_WEEKLY', purchaseDate: at(7), expiresDate: at(14) }), null, at(7.01)));
    assert.equal(d.result, 'RENEWED_DOWNGRADED');
    assert.equal(d.newPeriod!.credits, 3000);
    assert.equal(d.next.pendingPlanId, null);
    assert.ok(d.analytics.some((e) => e.name === 'subscription_downgraded'));
  });

  it('[NEG][SUB-04] a lower tier overlapping the current period changes nothing (audit only)', () => {
    const d = decideAppleTransaction(state({ planId: 'ULTRA_WEEKLY' }), used, fact({ planId: 'BASIC_WEEKLY', purchaseDate: at(2) }), null, at(2.01));
    assert.equal(d.kind, 'ignore');
    assert.equal(d.kind === 'ignore' && d.newPeriod?.disposition, 'SUPERSEDED');
  });

  it('[NEG] out-of-order: a period older than the current one is SUPERSEDED with no credits', () => {
    const d = decideAppleTransaction(state({ start: at(7), end: at(14) }), used, fact({ purchaseDate: at(0), expiresDate: at(7) }), null, at(8));
    assert.equal(d.kind, 'ignore');
    assert.equal(d.kind === 'ignore' && d.result, 'IGNORED_SUPERSEDED');
  });

  it('[BR][F-M3-04] a period that has not started yet is scheduled for its start, never granted early', () => {
    const d = decideAppleTransaction(state({}), used, fact({ purchaseDate: at(7), expiresDate: at(14) }), null, at(6));
    assert.deepEqual(d, { kind: 'schedule', result: 'RENEWAL_SCHEDULED', startsAt: at(7) });
  });

  it('[NEG][F-M3-04] no clock tolerance: one millisecond before the start is still scheduled; at the start it applies', () => {
    const start = at(7);
    const early = decideAppleTransaction(state({}), used, fact({ purchaseDate: start, expiresDate: at(14) }), null, new Date(start.getTime() - 1));
    assert.equal(early.kind, 'schedule');
    const onTime = decideAppleTransaction(state({}), used, fact({ purchaseDate: start, expiresDate: at(14) }), null, start);
    assert.equal(onTime.kind === 'apply' && onTime.result, 'RENEWED');
  });

  it('[NEG][F-M3-04] superseded, upgraded, duplicate and revoked transactions are never scheduled', () => {
    const future = fact({ purchaseDate: at(7), expiresDate: at(14) });
    assert.equal(decideAppleTransaction(state({}), used, { ...future, isUpgraded: true }, null, at(6)).kind, 'ignore');
    assert.equal(decideAppleTransaction(state({}), used, { ...future, revocation: { reason: 'REFUNDED' } }, null, at(6)).kind, 'ignore');
    const known = { id: 'p', transactionId: future.key, planId: 'BASIC_WEEKLY' as const, kind: 'RENEWAL' as const, startsAt: at(7), endsAt: at(14), credits: 3000, revoked: false };
    assert.equal(decideAppleTransaction(state({}), used, future, known, at(6)).kind, 'ignore');
    assert.equal(decideAppleTransaction(state({ start: at(7), end: at(14) }), used, fact({ purchaseDate: at(5), expiresDate: at(12) }), null, at(6)).kind, 'ignore');
  });

  it('[BR] a renewal delivered after its own period ended records the period but grants nothing', () => {
    const d = applied(decideAppleTransaction(state({}), used, fact({ purchaseDate: at(7), expiresDate: at(14) }), null, at(15)));
    assert.equal(d.grant, false);
  });

  it('[NEG] duplicates, upgraded-away transactions and unknown revocations grant nothing', () => {
    const known: Period = { id: 'p', transactionId: 'Sandbox:x', planId: 'BASIC_WEEKLY', kind: 'INITIAL', startsAt: T0, endsAt: at(7), credits: 3000, revoked: false };
    assert.equal(decideAppleTransaction(state({}), used, fact({ key: 'Sandbox:x' }), known, at(1)).kind, 'ignore');
    assert.equal(decideAppleTransaction(state({}), used, fact({ isUpgraded: true, purchaseDate: at(1) }), null, at(1)).kind, 'ignore');
    assert.equal(decideAppleTransaction(state({}), used, fact({ revocation: { reason: 'REFUNDED' } }), null, at(1)).kind, 'ignore');
  });

  it('[BR][SUB-06] refund of the current period revokes it now; a REVOKED subscription is only left by a newer purchase', () => {
    const s = state({});
    const d = applied(decideAppleTransaction(s, used, fact({ key: 'Sandbox:cur', revocation: { reason: 'REFUNDED' } }), s.current, at(1)));
    assert.equal(d.result, 'REVOKED_CURRENT');
    assert.equal(d.expireCurrent, 'REVOKED');
    const revoked = state({ status: 'REVOKED', start: at(0) });
    assert.equal(decideAppleTransaction(revoked, used, fact({ purchaseDate: at(0) }), null, at(1)).kind, 'ignore', 'an older/same-start period cannot reactivate it');
    assert.equal(applied(decideAppleTransaction(revoked, used, fact({ purchaseDate: at(2) }), null, at(2.01))).result, 'SUBSCRIPTION_STARTED');
  });
});

describe('Apple renewal info', () => {
  const now = at(1);
  it('[BR] auto-renew off = cancellation (entitlement kept), analytics subscription_cancelled', () => {
    const d = decideAppleRenewalInfo(state({}), { autoRenew: false, autoRenewPlanId: 'BASIC_WEEKLY', signedDate: now }, null, now);
    assert.equal(d.kind === 'apply' && d.result, 'AUTO_RENEW_DISABLED');
    assert.ok(d.kind === 'apply' && d.analytics.some((e) => e.name === 'subscription_cancelled'));
  });
  it('[BR][SUB-04] a lower-tier next product schedules a downgrade; the current plan again cancels it', () => {
    const s = state({ planId: 'ULTRA_WEEKLY' });
    const d = decideAppleRenewalInfo(s, { autoRenew: true, autoRenewPlanId: 'PREMIUM_WEEKLY', signedDate: now }, null, now);
    assert.equal(d.kind === 'apply' && d.pendingPlanId, 'PREMIUM_WEEKLY');
    const back = decideAppleRenewalInfo({ ...s, pendingPlanId: 'PREMIUM_WEEKLY' }, { autoRenew: true, autoRenewPlanId: 'ULTRA_WEEKLY', signedDate: now }, null, now);
    assert.equal(back.kind === 'apply' && back.result, 'DOWNGRADE_CANCELLED');
  });
  it('[NEG] older (out-of-order) or duplicate renewal info, and renewal info without a subscription, are ignored', () => {
    assert.equal(decideAppleRenewalInfo(state({}), { autoRenew: false, autoRenewPlanId: null, signedDate: at(0.5) }, now, now).kind, 'ignore');
    assert.equal(decideAppleRenewalInfo(state({}), { autoRenew: false, autoRenewPlanId: null, signedDate: now }, now, now).kind, 'ignore', 'same signedDate = duplicate');
    assert.equal(decideAppleRenewalInfo(state({ status: 'EXPIRED' }), { autoRenew: true, autoRenewPlanId: null, signedDate: at(0.5) }, now, now).kind, 'ignore');
    assert.equal(decideAppleRenewalInfo(null, { autoRenew: true, autoRenewPlanId: null, signedDate: now }, null, now).kind, 'ignore');
  });
  it('[BR][F-M3-03] ended subscriptions: the newest renewal info is recorded as Apple intent only (no lifecycle change, analytics or downgrade)', () => {
    // Expired, with Apple still reporting auto-renew ON (e.g. billing error): not assumed to be OFF.
    const on = decideAppleRenewalInfo(state({ status: 'EXPIRED', autoRenew: false }), { autoRenew: true, autoRenewPlanId: 'BASIC_WEEKLY', signedDate: now }, null, now);
    assert.deepEqual(on, { kind: 'intent', result: 'RENEWAL_INTENT_RECORDED_AUTO_RENEW_ON' });
    // Lifecycle still ACTIVE but the period has ended (credits already expired at the end): intent only, no cancellation event.
    const off = decideAppleRenewalInfo(state({ end: at(0.5) }), { autoRenew: false, autoRenewPlanId: 'PREMIUM_WEEKLY', signedDate: now }, null, now);
    assert.deepEqual(off, { kind: 'intent', result: 'RENEWAL_INTENT_RECORDED_AUTO_RENEW_OFF' });
    assert.equal(decideAppleRenewalInfo(state({ status: 'REVOKED', autoRenew: false }), { autoRenew: false, autoRenewPlanId: null, signedDate: now }, null, now).kind, 'intent');
  });
});

describe('Apple subscription status (F-M3-02)', () => {
  const end = at(7);
  const after = at(7.01);
  const ended = () => state({ end });
  const f = (status: Parameters<typeof decideAppleStatus>[1]['status'], key = 'Sandbox:cur', signedDate = after) => ({ status, latestTransactionKey: key, signedDate });

  it('[BR] App Store Server API status codes map to Apple statuses; unknown codes map to nothing', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(appleStatusOf), ['ACTIVE', 'EXPIRED', 'BILLING_RETRY', 'GRACE_PERIOD', 'REVOKED']);
    assert.equal(appleStatusOf(0), null);
    assert.equal(appleStatusOf(undefined), null);
  });
  it('[BR] EXPIRED for the current period after its end applies the M2 expiry; before the end it is deferred', () => {
    assert.deepEqual(decideAppleStatus(ended(), f('EXPIRED'), null, after), { kind: 'record', result: 'EXPIRED', expire: true });
    assert.deepEqual(decideAppleStatus(ended(), f('EXPIRED'), null, at(6)), { kind: 'record', result: 'APPLE_EXPIRED_PERIOD_NOT_ENDED', expire: false });
  });
  it('[NEG] EXPIRED for another transaction than MonetaLab\'s current period expires nothing (out-of-order / missing history)', () => {
    assert.deepEqual(decideAppleStatus(ended(), f('EXPIRED', 'Sandbox:older'), null, after), { kind: 'record', result: 'APPLE_EXPIRED_LATEST_PERIOD_NOT_APPLIED', expire: false });
  });
  it('[BR] already ended (EXPIRED/REVOKED) subscriptions: the status is recorded, nothing is applied twice', () => {
    for (const status of ['EXPIRED', 'REVOKED'] as const) {
      assert.deepEqual(decideAppleStatus(state({ status, end, autoRenew: false }), f('EXPIRED'), null, after), { kind: 'record', result: 'APPLE_EXPIRED_RECORDED', expire: false });
    }
  });
  it('[BR][D-046] billing retry and grace period are recorded only: no expiry, no extension, no credits', () => {
    assert.deepEqual(decideAppleStatus(ended(), f('BILLING_RETRY'), null, after), { kind: 'record', result: 'BILLING_RETRY_RECORDED', expire: false });
    assert.deepEqual(decideAppleStatus(ended(), f('GRACE_PERIOD'), null, after), { kind: 'record', result: 'GRACE_PERIOD_NOT_APPLIED', expire: false });
  });
  it('[BR] ACTIVE and REVOKED statuses are recorded only (periods and revocations come from verified transactions)', () => {
    assert.equal(decideAppleStatus(state({}), f('ACTIVE'), null, at(1)).kind, 'record');
    assert.deepEqual(decideAppleStatus(state({}), f('REVOKED'), null, at(1)), { kind: 'record', result: 'APPLE_REVOKED_RECORDED', expire: false });
  });
  it('[NEG] older or duplicate status (by Apple signedDate) and statuses without a subscription are ignored', () => {
    assert.deepEqual(decideAppleStatus(ended(), f('ACTIVE', 'Sandbox:cur', at(6)), after, after), { kind: 'ignore', result: 'IGNORED_STALE_STATUS' });
    assert.deepEqual(decideAppleStatus(ended(), f('EXPIRED'), after, after), { kind: 'ignore', result: 'IGNORED_STALE_STATUS' });
    assert.deepEqual(decideAppleStatus(null, f('EXPIRED'), null, after), { kind: 'ignore', result: 'IGNORED_NO_SUBSCRIPTION' });
  });
  it('[BR] notification types imply a status; informational types imply none', () => {
    assert.equal(appleStatusOfNotification('EXPIRED', 'VOLUNTARY'), 'EXPIRED');
    assert.equal(appleStatusOfNotification('GRACE_PERIOD_EXPIRED', null), 'EXPIRED');
    assert.equal(appleStatusOfNotification('DID_FAIL_TO_RENEW', 'GRACE_PERIOD'), 'GRACE_PERIOD');
    assert.equal(appleStatusOfNotification('DID_FAIL_TO_RENEW', null), 'BILLING_RETRY');
    assert.equal(appleStatusOfNotification('DID_RENEW', null), 'ACTIVE');
    assert.equal(appleStatusOfNotification('REVOKE', null), 'REVOKED');
    for (const type of ['DID_CHANGE_RENEWAL_STATUS', 'REFUND', 'TEST', 'CONSUMPTION_REQUEST']) assert.equal(appleStatusOfNotification(type, null), null);
  });
});
