/**
 * Proposed App Store Connect product catalog (D-039). The same ids are used by the local StoreKit configuration
 * (ios/MonetaLabTests/MonetaLab.storekit) and must be created with exactly these ids in App Store Connect.
 * Credits are decided here, on the server; the product id is the only thing the server takes from a verified
 * transaction to decide what to grant. Prices are NOT defined anywhere in MonetaLab (PRD open decision #1): the app
 * shows StoreKit's localized displayPrice.
 */
import type { PlanId } from '../../subscriptions/lifecycle.ts';

export const APPLE_SUBSCRIPTION_GROUP_NAME = 'MonetaLab Weekly';

export const APPLE_CONSUMABLE_PRODUCTS = {
  'dev.monetalab.qa.credits.5000': 'CREDITS_S',
  'dev.monetalab.qa.credits.7000': 'CREDITS_M',
  'dev.monetalab.qa.credits.10000': 'CREDITS_L',
} as const satisfies Record<string, string>;

export const APPLE_SUBSCRIPTION_PRODUCTS = {
  'dev.monetalab.qa.sub.basic.weekly': 'BASIC_WEEKLY',
  'dev.monetalab.qa.sub.premium.weekly': 'PREMIUM_WEEKLY',
  'dev.monetalab.qa.sub.ultra.weekly': 'ULTRA_WEEKLY',
} as const satisfies Record<string, PlanId>;

export type AppleProductKind =
  | { kind: 'CONSUMABLE'; packageId: string }
  | { kind: 'SUBSCRIPTION'; planId: PlanId };

export function appleProduct(productId: string): AppleProductKind | null {
  if (Object.hasOwn(APPLE_CONSUMABLE_PRODUCTS, productId)) {
    return { kind: 'CONSUMABLE', packageId: APPLE_CONSUMABLE_PRODUCTS[productId as keyof typeof APPLE_CONSUMABLE_PRODUCTS] };
  }
  if (Object.hasOwn(APPLE_SUBSCRIPTION_PRODUCTS, productId)) {
    return { kind: 'SUBSCRIPTION', planId: APPLE_SUBSCRIPTION_PRODUCTS[productId as keyof typeof APPLE_SUBSCRIPTION_PRODUCTS] };
  }
  return null;
}

/** Catalog view for clients: which StoreKit product ids to load for each server package/plan. */
export function appleCatalog() {
  const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));
  return {
    subscriptionGroupName: APPLE_SUBSCRIPTION_GROUP_NAME,
    consumables: invert(APPLE_CONSUMABLE_PRODUCTS),
    subscriptions: invert(APPLE_SUBSCRIPTION_PRODUCTS),
  };
}
