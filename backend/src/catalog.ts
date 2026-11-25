/**
 * Server-side product catalog (PRD §2.1–2.3). Clients never send prices or costs; the server decides them.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { appleCatalog } from './billing/apple/products.ts';
import { PLAN_IDS, PLANS, TRIAL_OFFER } from './subscriptions/lifecycle.ts';

/** PRD §2.3. Placeholder action names; costs are authoritative here. */
export const OPERATION_COSTS = { BASIC: 100, STANDARD: 500, ADVANCED: 800 } as const;
export type OperationAction = keyof typeof OPERATION_COSTS;
export const OPERATION_ACTIONS = Object.keys(OPERATION_COSTS) as OperationAction[];
const OPERATION_NAMES: Record<OperationAction, string> = {
  BASIC: 'Basic processing',
  STANDARD: 'Standard processing',
  ADVANCED: 'Advanced processing',
};

/**
 * PRD §2.1 subscription plans, purchasable through the deterministic mock provider in M2 (D-027). No prices (PRD open
 * decision #1). The catalog states the offer's terms only; whether THIS customer may use the trial, and the trial
 * message, come from GET /subscriptions/current (PRD §3.1: trial messaging only when genuinely eligible).
 */
export const SUBSCRIPTION_PLANS = PLAN_IDS.map((id) => ({
  id,
  name: PLANS[id].name,
  period: 'WEEKLY',
  periodDays: PLANS[id].periodDays,
  creditsPerPeriod: PLANS[id].credits,
  tier: PLANS[id].tier,
  introductoryOffer: id === TRIAL_OFFER.planId ? { kind: TRIAL_OFFER.kind, days: TRIAL_OFFER.days, credits: TRIAL_OFFER.credits } : null,
  available: true,
  availability: 'Mock subscription (test provider). No real payment is made.',
}));

export const REWARDED_AD = {
  label: 'Watch an Ad — Earn 100 Credits',
  credits: 100,
  dailyLimit: 10,
  available: true,
  availability: 'Mock rewarded ad (test provider). Offered only when credits are insufficient for an operation.',
};

export function registerCatalogRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/catalog', async () => {
    const { rows } = await pool.query<{ id: string; credits: number; display_name: string }>(
      'SELECT id, credits, display_name FROM credit_packages ORDER BY sort_order',
    );
    return {
      consumables: rows.map((r) => ({ id: r.id, name: r.display_name, credits: r.credits, available: true })),
      subscriptionGroup: 'MONETALAB_WEEKLY',
      subscriptions: SUBSCRIPTION_PLANS,
      rewardedAd: REWARDED_AD,
      operations: OPERATION_ACTIONS.map((id) => ({ id, name: OPERATION_NAMES[id], cost: OPERATION_COSTS[id] })),
      // M3 (D-039): StoreKit product ids per package/plan. Credits are still decided by the server, never by the store.
      appleProducts: appleCatalog(),
    };
  });
}
