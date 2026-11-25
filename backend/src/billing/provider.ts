/**
 * Billing provider boundary (CLAUDE.md rule 7). Fulfillment code depends only on this interface.
 *
 * Two providers exist, selected per deployment with BILLING_PROVIDER (D-038):
 * - 'mock' (M1/M2): deterministic, test-controlled outcomes (CLAUDE.md rule 6). Refused with NODE_ENV=production, so
 *   it can never become a public backdoor that grants credits. Used by all deterministic M1/M2 regression tests.
 * - 'apple' (M3): StoreKit 2. Nothing is ever granted from a client claim: the app sends Apple-signed transaction
 *   data, which the server verifies (src/billing/apple/verifier.ts) before any fulfillment. Per D-004, StoreKit does
 *   NOT implement the mock's "verify by requested outcome" methods; it has its own verified-data methods instead.
 * A server runs exactly one provider; the mock purchase/subscription routes do not exist in 'apple' mode.
 */
import type { AppleVerifier } from './apple/verifier.ts';
import { appleVerifierFromEnv } from './apple/config.ts';

export type PurchaseOutcome = 'APPROVED' | 'DECLINED' | 'CANCELLED';
export const PURCHASE_OUTCOMES: readonly PurchaseOutcome[] = ['APPROVED', 'DECLINED', 'CANCELLED'];

export type VerifyRequest = { transactionId: string; packageId: string; mockOutcome: PurchaseOutcome | undefined };

export type SubscriptionVerifyRequest = { transactionId: string; planId: string; mockOutcome: PurchaseOutcome | undefined };

/**
 * M2 subscription boundary. Lifecycle code depends only on these verified results, never on how they were obtained.
 * - verifySubscriptionTransaction: a purchase/upgrade the customer initiated (StoreKit 2 in M3: a signed transaction
 *   verified server-side).
 * - verifyNotification: a lifecycle notification (renewal, expiry, refund/revocation). In M3 this becomes App Store
 *   Server Notifications v2 with JWS signature verification; the mock trusts its own deterministic test input.
 * Trial eligibility stays a backend record here; M3 must also require Apple-verified intro-offer eligibility.
 */
export interface MockBillingProvider {
  readonly name: 'mock';
  verifyConsumablePurchase(request: VerifyRequest): Promise<{ outcome: PurchaseOutcome }>;
  verifySubscriptionTransaction(request: SubscriptionVerifyRequest): Promise<{ outcome: PurchaseOutcome }>;
  verifyNotification<T extends { eventId: string }>(notification: T): Promise<{ verified: true; notification: T }>;
}

/** Deterministic: the outcome is exactly the requested mock scenario. Without one, the purchase is DECLINED (fail closed). */
export interface AppleBillingProvider {
  readonly name: 'apple';
  readonly verifier: AppleVerifier;
}

export type BillingProvider = MockBillingProvider | AppleBillingProvider;

export const mockBillingProvider: MockBillingProvider = {
  name: 'mock',
  async verifyConsumablePurchase({ mockOutcome }) {
    return { outcome: mockOutcome ?? 'DECLINED' };
  },
  async verifySubscriptionTransaction({ mockOutcome }) {
    return { outcome: mockOutcome ?? 'DECLINED' };
  },
  async verifyNotification(notification) {
    return { verified: true, notification };
  },
};

export function billingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): BillingProvider {
  const name = env.BILLING_PROVIDER ?? 'mock';
  if (name === 'apple') return { name: 'apple', verifier: appleVerifierFromEnv(env) };
  if (name !== 'mock') throw new Error(`Unsupported BILLING_PROVIDER "${name}": use "mock" or "apple"`);
  if (env.NODE_ENV === 'production') {
    throw new Error('The mock billing provider must not run with NODE_ENV=production');
  }
  return mockBillingProvider;
}
