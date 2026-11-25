/**
 * Mock consumable purchases (PRD §2.2, BUY-01..03, D-006, DV-001, DV-002).
 *
 * POST /purchases { packageId, transactionId, mockOutcome }
 * - New transaction: the provider verifies it; the purchase is recorded with its outcome. APPROVED grants the
 *   package's catalog credits into CONSUMABLE through one ledger entry (the DB trigger updates the balance in the
 *   same transaction). DECLINED and CANCELLED grant nothing. Response 201.
 * - Replay with an identical payload by the same user: 200 with the original result, nothing granted again.
 * - Same transaction id with a different payload, or by another user: 409 TRANSACTION_CONFLICT (no data leaked).
 * Concurrency: INSERT … ON CONFLICT DO NOTHING on (provider, provider_transaction_id). Racing duplicates wait for the
 * first transaction, then replay. The DB also enforces one grant per purchase.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authOf, requireAuth } from '../auth/require-auth.ts';
import { PURCHASE_OUTCOMES, type MockBillingProvider, type PurchaseOutcome } from '../billing/provider.ts';
import { withTransaction } from '../db/tx.ts';
import { ApiError } from '../http/errors.ts';
import { readWallet } from './wallet.ts';

const body = {
  type: 'object',
  required: ['packageId', 'transactionId'],
  additionalProperties: false,
  properties: {
    packageId: { type: 'string', minLength: 1, maxLength: 50 },
    transactionId: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9._:-]+$' },
    mockOutcome: { type: 'string', enum: [...PURCHASE_OUTCOMES] },
  },
} as const;

type Body = { packageId: string; transactionId: string; mockOutcome?: PurchaseOutcome };
type PurchaseRow = {
  id: string;
  user_id: string;
  provider_transaction_id: string;
  package_id: string;
  credits: number;
  outcome: PurchaseOutcome;
  created_at: Date;
};

export function registerPurchaseRoutes(app: FastifyInstance, pool: pg.Pool, billing: MockBillingProvider): void {
  app.post<{ Body: Body }>('/purchases', { onRequest: requireAuth(pool), schema: { body } }, async (request, reply) => {
    const userId = authOf(request).user.id;
    const { packageId, transactionId, mockOutcome } = request.body;

    const pkg = await pool.query<{ credits: number }>('SELECT credits FROM credit_packages WHERE id = $1', [packageId]);
    if (!pkg.rows[0]) throw new ApiError(400, 'UNKNOWN_PACKAGE', 'Unknown credit package');
    const credits = pkg.rows[0].credits;

    const result = await withTransaction(pool, async (tx) => {
      const existing = await tx.query<PurchaseRow>(
        'SELECT * FROM purchases WHERE provider = $1 AND provider_transaction_id = $2',
        [billing.name, transactionId],
      );
      if (existing.rows[0]) return { purchase: existing.rows[0], replayed: true };

      const { outcome } = await billing.verifyConsumablePurchase({ transactionId, packageId, mockOutcome });
      const inserted = await tx.query<PurchaseRow>(
        `INSERT INTO purchases (user_id, provider, provider_transaction_id, package_id, credits, outcome)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (provider, provider_transaction_id) DO NOTHING
         RETURNING *`,
        [userId, billing.name, transactionId, packageId, credits, outcome],
      );
      if (!inserted.rows[0]) {
        // A concurrent request committed this transaction id first: replay its result.
        const winner = await tx.query<PurchaseRow>(
          'SELECT * FROM purchases WHERE provider = $1 AND provider_transaction_id = $2',
          [billing.name, transactionId],
        );
        return { purchase: winner.rows[0]!, replayed: true };
      }
      const purchase = inserted.rows[0];
      if (purchase.outcome === 'APPROVED') {
        await tx.query(
          `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, purchase_id)
           VALUES ($1, 'CONSUMABLE', $2, 'PURCHASE_GRANT', $3)`,
          [userId, purchase.credits, purchase.id],
        );
      }
      return { purchase, replayed: false };
    });

    const { purchase, replayed } = result;
    // Idempotency is per payload: the replay must match the original owner, package and requested outcome.
    const samePayload =
      purchase.user_id === userId &&
      purchase.package_id === packageId &&
      (mockOutcome ?? 'DECLINED') === purchase.outcome;
    if (replayed && !samePayload) {
      throw new ApiError(409, 'TRANSACTION_CONFLICT', 'This transaction id was already used with a different request');
    }

    return reply.code(replayed ? 200 : 201).send({
      purchase: {
        id: purchase.id,
        transactionId: purchase.provider_transaction_id,
        packageId: purchase.package_id,
        credits: purchase.credits,
        outcome: purchase.outcome,
        createdAt: purchase.created_at.toISOString(),
      },
      creditsGranted: purchase.outcome === 'APPROVED' ? purchase.credits : 0,
      replayed,
      wallet: await readWallet(pool, userId),
    });
  });
}
