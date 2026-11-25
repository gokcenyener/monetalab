/**
 * Rewarded ads (PRD §3.1, §3.2; D-032).
 *   GET  /ads/quota?action=STANDARD   today's UTC quota and whether the ad option is available for that blocked action
 *   POST /ads/rewards { adEventId, action, mockOutcome: COMPLETED|INCOMPLETE|FAILED }
 *
 * Rules enforced server-side, in one transaction under the per-user lock:
 * - Only a provider-verified COMPLETED ad grants exactly 100 REWARD credits and uses one quota slot.
 * - INCOMPLETE / FAILED attempts are recorded, grant nothing and use no quota.
 * - Eligibility: available credits must be insufficient for the requested action (free, trial, expired and subscribed
 *   users alike). Ads are not offered outside that paywall context (PRD §7 #5).
 * - At most 10 rewarded ads per user per UTC calendar day of the server clock. The DB enforces it independently with
 *   UNIQUE (user, utc_day, reward_slot) and CHECK (slot 1..10).
 * - adEventId is idempotent: a duplicate grants nothing and uses no quota; reuse with a different payload is a 409.
 * Every attempt (rewarded, not rewarded, over the limit, not eligible) is kept as an immutable audit row.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { recordAnalyticsEvent } from '../analytics/events.ts';
import { authOf, requireAuth } from '../auth/require-auth.ts';
import { OPERATION_ACTIONS, OPERATION_COSTS, type OperationAction } from '../catalog.ts';
import { nextUtcMidnight, utcDay, type Clock } from '../clock.ts';
import { readWallet, type Wallet } from '../credits/wallet.ts';
import { withTransaction } from '../db/tx.ts';
import { ApiError } from '../http/errors.ts';
import { lockUser, reconcileUser } from '../subscriptions/service.ts';
import { AD_OUTCOMES, type AdOutcome, type AdProvider } from './provider.ts';

export const DAILY_AD_LIMIT = 10;
export const AD_REWARD_CREDITS = 100;

type Tx = Pick<pg.PoolClient, 'query'>;
type Status = 'REWARDED' | 'NOT_REWARDED' | 'LIMIT_REACHED' | 'NOT_ELIGIBLE';

async function quotaFor(tx: Tx, userId: string, now: Date) {
  const day = utcDay(now);
  const { rows } = await tx.query<{ used: number }>(
    `SELECT count(*)::int AS used FROM ad_rewards WHERE user_id = $1 AND utc_day = $2 AND status = 'REWARDED'`,
    [userId, day],
  );
  const used = rows[0]!.used;
  return {
    utcDay: day,
    used,
    limit: DAILY_AD_LIMIT,
    remaining: Math.max(0, DAILY_AD_LIMIT - used),
    resetsAt: nextUtcMidnight(now).toISOString(),
    rewardCredits: AD_REWARD_CREDITS,
  };
}

function eligibility(wallet: Wallet, action: OperationAction, remaining: number) {
  const required = OPERATION_COSTS[action];
  if (wallet.total >= required) return { eligible: false, reason: 'CREDITS_SUFFICIENT', required, available: wallet.total };
  if (remaining <= 0) return { eligible: false, reason: 'DAILY_LIMIT_REACHED', required, available: wallet.total };
  return { eligible: true, reason: 'INSUFFICIENT_CREDITS', required, available: wallet.total };
}

const actionQuery = {
  type: 'object', additionalProperties: false,
  properties: { action: { type: 'string', enum: OPERATION_ACTIONS } },
} as const;
const rewardBody = {
  type: 'object', additionalProperties: false, required: ['adEventId', 'action'],
  properties: {
    adEventId: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9._:-]+$' },
    action: { type: 'string', enum: OPERATION_ACTIONS },
    mockOutcome: { type: 'string', enum: [...AD_OUTCOMES] },
  },
} as const;

/** `ads: null` (API_EXPOSURE=tunnel): no ad network exists, so the quota stays readable but nothing is ever eligible and
 *  the mock reward route is not registered at all. */
export function registerAdRoutes(app: FastifyInstance, pool: pg.Pool, deps: { ads: AdProvider | null; clock: Clock }): void {
  const guard = requireAuth(pool);

  app.get<{ Querystring: { action?: OperationAction } }>('/ads/quota', { onRequest: guard, schema: { querystring: actionQuery } }, async (request) => {
    const userId = authOf(request).user.id;
    const now = deps.clock.now();
    return withTransaction(pool, async (tx) => {
      await lockUser(tx, userId);
      await reconcileUser(tx, userId, now);
      const quota = await quotaFor(tx, userId, now);
      const wallet = await readWallet(tx, userId);
      const action = request.query.action;
      const unavailable = deps.ads ? {} : { eligible: false, reason: 'ADS_UNAVAILABLE' };
      return { quota, ...(action && { eligibility: { action, ...eligibility(wallet, action, quota.remaining), ...unavailable } }), wallet, serverTime: now.toISOString() };
    });
  });

  if (!deps.ads) return;
  const ads = deps.ads;
  app.post<{ Body: { adEventId: string; action: OperationAction; mockOutcome?: AdOutcome } }>(
    '/ads/rewards',
    { onRequest: guard, schema: { body: rewardBody } },
    async (request, reply) => {
      const userId = authOf(request).user.id;
      const { adEventId, action, mockOutcome } = request.body;
      const now = deps.clock.now();

      const outcome = await withTransaction(pool, async (tx) => {
        await lockUser(tx, userId);
        type Row = { id: string; user_id: string; action: string; ad_outcome: AdOutcome; status: Status; utc_day: string; credits: number; requested_outcome: string };
        const existing = await tx.query<Row>(
          `SELECT a.id, a.user_id, a.action, a.ad_outcome, a.status, a.utc_day::text AS utc_day, a.credits
             FROM ad_rewards a WHERE a.provider = $1 AND a.ad_event_id = $2`,
          [ads.name, adEventId],
        );
        const verified = await ads.verifyReward({ adEventId, mockOutcome });
        if (existing.rows[0]) {
          const row = existing.rows[0];
          if (row.user_id !== userId || row.action !== action || row.ad_outcome !== verified.outcome) return { kind: 'conflict' as const };
          return { kind: 'done' as const, row, replayed: true, quota: await quotaFor(tx, userId, now), wallet: await readWallet(tx, userId) };
        }

        await reconcileUser(tx, userId, now);
        const wallet = await readWallet(tx, userId, true);
        const quota = await quotaFor(tx, userId, now);
        let status: Status;
        if (wallet.total >= OPERATION_COSTS[action]) status = 'NOT_ELIGIBLE';
        else if (verified.outcome !== 'COMPLETED') status = 'NOT_REWARDED';
        else if (quota.used >= DAILY_AD_LIMIT) status = 'LIMIT_REACHED';
        else status = 'REWARDED';

        const inserted = await tx.query<Row>(
          `INSERT INTO ad_rewards (user_id, provider, ad_event_id, action, ad_outcome, status, utc_day, reward_slot, credits, business_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (provider, ad_event_id) DO NOTHING
           RETURNING id, user_id, action, ad_outcome, status, utc_day::text AS utc_day, credits`,
          [userId, ads.name, adEventId, action, verified.outcome, status, quota.utcDay,
            status === 'REWARDED' ? quota.used + 1 : null, status === 'REWARDED' ? AD_REWARD_CREDITS : 0, now],
        );
        const row = inserted.rows[0];
        if (!row) return { kind: 'conflict' as const }; // another user's concurrent request took this adEventId
        if (status === 'REWARDED') {
          await tx.query(
            `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, ad_reward_id) VALUES ($1, 'REWARD', $2, 'REWARD_GRANT', $3)`,
            [userId, AD_REWARD_CREDITS, row.id],
          );
          await recordAnalyticsEvent(tx, {
            userId, name: 'reward_granted', dedupeKey: `ad:${adEventId}`, occurredAt: now,
            properties: { credits: AD_REWARD_CREDITS, utcDay: quota.utcDay, slot: quota.used + 1, action },
          });
        }
        return { kind: 'done' as const, row, replayed: false, quota: await quotaFor(tx, userId, now), wallet: await readWallet(tx, userId) };
      });

      if (outcome.kind === 'conflict') throw new ApiError(409, 'AD_EVENT_CONFLICT', 'This adEventId was already used with a different request');
      const { row, replayed, quota, wallet } = outcome;
      // The attempt is committed (audit) before an error is returned.
      if (row.status === 'LIMIT_REACHED') {
        throw new ApiError(429, 'DAILY_AD_LIMIT_REACHED', `The daily limit of ${DAILY_AD_LIMIT} rewarded ads is reached (UTC day ${row.utc_day})`, { quota, replayed });
      }
      if (row.status === 'NOT_ELIGIBLE') {
        throw new ApiError(409, 'AD_NOT_ELIGIBLE', 'Rewarded ads are only available when credits are insufficient for the requested action', {
          required: OPERATION_COSTS[action], available: wallet.total, replayed,
        });
      }
      return reply.code(replayed ? 200 : 201).send({
        result: row.status,
        replayed,
        creditsGranted: replayed ? 0 : row.credits,
        attempt: { id: row.id, adEventId, action: row.action, outcome: row.ad_outcome, status: row.status, utcDay: row.utc_day, credits: row.credits },
        quota,
        wallet,
      });
    },
  );
}
