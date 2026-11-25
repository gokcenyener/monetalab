/**
 * Reconciliation with the App Store Server API (D-044): the safety net for missing or delayed notifications.
 *
 * Get Transaction History returns the App Store customer's whole history for the app (every chain and product), and
 * Get All Subscription Statuses every subscription group, for ANY of the customer's transaction ids. So history and
 * statuses are fetched once per App Store customer: a linked chain already seen in a fetched history is not fetched
 * again (F-M3-01). Chains from another Apple account (not in that history) still get their own fetch, so nothing is
 * lost. Every signed item is VERIFIED exactly like any other input and applied once through the same idempotent
 * paths; report counts are unique transactions/chains, not processing attempts. Re-running it is harmless.
 * Statuses: Apple's subscription status (expired, billing retry, grace period, revoked, active) and renewal intent are
 * recorded; an expired current period gets the M2 EXPIRED rule (F-M3-02/03, applyAppleStatus / applyRenewalInfo).
 *
 * It is an operator CLI (no HTTP route):  npm run apple:reconcile -- --user <uuid>
 * Credentials (server-side env only, never in Git): APPLE_API_KEY_ID, APPLE_API_ISSUER_ID, APPLE_API_PRIVATE_KEY_PATH
 * (the .p8 key from App Store Connect), plus the APPLE_* verification variables (config.ts).
 * Real App Store Server API calls are NOT VERIFIED in this repository: no Apple credentials exist here.
 */
import type pg from 'pg';
import type { Clock } from '../../clock.ts';
import { withTransaction } from '../../db/tx.ts';
import { lockUser } from '../../subscriptions/service.ts';
import { appleStatusOf } from './lifecycle.ts';
import { applyAppleStatus, applyRenewalInfo, fulfillVerifiedTransaction, storedId } from './service.ts';
import type { AppleVerifier, VerifiedTransaction } from './verifier.ts';

/** The subset of Apple's AppStoreServerAPIClient used here (injectable for tests). */
export interface AppStoreServerApi {
  getTransactionHistory(anyTransactionId: string, revision: string | null, request: { sort?: 'ASCENDING' | 'DESCENDING' }): Promise<{ signedTransactions?: string[]; revision?: string; hasMore?: boolean }>;
  getAllSubscriptionStatuses(anyTransactionId: string): Promise<{ data?: Array<{ lastTransactions?: Array<{ status?: number; originalTransactionId?: string; signedTransactionInfo?: string; signedRenewalInfo?: string }> }> }>;
}

export type ReconcileReport = {
  /** Purchase chains linked to the user in this environment. */
  chains: number;
  /** API calls made (one history walk and one status request per App Store customer). */
  historyRequests: number;
  statusRequests: number;
  /** Unique verified transactions applied, and their results (each transaction counted once). */
  transactions: number;
  results: Record<string, number>;
  /** Unique subscription chains whose status / renewal info was applied, with results prefixed status: / renewal:. */
  subscriptionChains: number;
  /** Signed items that failed verification or could not be applied, by error code. */
  rejected: Record<string, number>;
};

const MAX_PAGES = 50;

function codeOf(error: unknown): string {
  return String((error as { code?: string }).code ?? 'ERROR');
}

export async function reconcileUserWithAppStore(
  pool: pg.Pool,
  deps: { verifier: AppleVerifier; clock: Clock; api: AppStoreServerApi },
  userId: string,
): Promise<ReconcileReport> {
  const report: ReconcileReport = { chains: 0, historyRequests: 0, statusRequests: 0, transactions: 0, results: {}, subscriptionChains: 0, rejected: {} };
  const count = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1; };
  const chains = await pool.query<{ original_transaction_id: string }>(
    'SELECT original_transaction_id FROM apple_account_links WHERE user_id = $1 AND environment = $2 ORDER BY created_at',
    [userId, deps.verifier.environment],
  );
  report.chains = chains.rows.length;
  const covered = new Set<string>(); // original transaction ids present in a history already fetched
  const applied = new Set<string>(); // environment:transactionId applied in this run
  const statusApplied = new Set<string>(); // original transaction ids whose status was applied in this run

  const apply = async (t: VerifiedTransaction) => {
    const key = storedId(t.environment, t.transactionId);
    if (applied.has(key)) return;
    applied.add(key);
    report.transactions += 1;
    try {
      const r = await withTransaction(pool, (tx) => fulfillVerifiedTransaction(tx, t, { caller: userId, source: 'SERVER_API', now: deps.clock.now() }));
      count(report.results, 'unmatched' in r ? 'UNMATCHED' : r.result);
    } catch (error) {
      count(report.rejected, codeOf(error));
    }
  };

  for (const { original_transaction_id: root } of chains.rows) {
    if (covered.has(root)) continue; // same App Store customer: its history was already fetched in this run
    covered.add(root);

    // 1. The customer's full transaction history, oldest first (periods applied in effective order).
    let revision: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      report.historyRequests += 1;
      const history = await deps.api.getTransactionHistory(root, revision, { sort: 'ASCENDING' });
      for (const signed of history.signedTransactions ?? []) {
        let t: VerifiedTransaction;
        try {
          t = await deps.verifier.verifyTransaction(signed);
        } catch (error) {
          count(report.rejected, codeOf(error));
          continue;
        }
        covered.add(t.originalTransactionId);
        await apply(t);
      }
      if (!history.hasMore || !history.revision) break;
      revision = history.revision;
    }

    // 2. Current status of every subscription chain of this customer.
    report.statusRequests += 1;
    const statuses = await deps.api.getAllSubscriptionStatuses(root);
    for (const group of statuses.data ?? []) {
      for (const last of group.lastTransactions ?? []) {
        let t: VerifiedTransaction | null = null;
        let renewal = null;
        try {
          t = last.signedTransactionInfo ? await deps.verifier.verifyTransaction(last.signedTransactionInfo) : null;
          renewal = last.signedRenewalInfo ? await deps.verifier.verifyRenewalInfo(last.signedRenewalInfo) : null;
        } catch (error) {
          count(report.rejected, codeOf(error));
          continue;
        }
        const original = t?.originalTransactionId ?? renewal?.originalTransactionId;
        if (!original || statusApplied.has(original)) continue;
        if (t && renewal && renewal.originalTransactionId !== t.originalTransactionId) {
          count(report.rejected, 'APPLE_PAYLOAD_INVALID');
          continue;
        }
        statusApplied.add(original);
        report.subscriptionChains += 1;
        // The latest transaction may be newer than the history walk (renewed in between): applied idempotently.
        if (t) await apply(t);
        const status = appleStatusOf(last.status);
        try {
          await withTransaction(pool, async (tx) => {
            await lockUser(tx, userId);
            const now = deps.clock.now();
            if (t && status) {
              const signedDate = renewal?.signedDate ?? t.signedDate;
              count(report.results, `status:${await applyAppleStatus(tx, userId, { status, transaction: t, signedDate }, `apple-status:${t.environment}:${original}:${signedDate.getTime()}`, now)}`);
            } else if (!status) {
              count(report.results, 'status:IGNORED_UNKNOWN_APPLE_STATUS');
            }
            if (renewal) {
              count(report.results, `renewal:${await applyRenewalInfo(tx, userId, renewal, `apple-status:${renewal.environment}:${renewal.originalTransactionId}:${renewal.signedDate.getTime()}`, now)}`);
            }
          });
        } catch (error) {
          count(report.rejected, codeOf(error));
        }
      }
    }
  }
  return report;
}
