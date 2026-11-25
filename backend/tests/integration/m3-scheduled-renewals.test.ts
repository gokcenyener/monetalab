/**
 * F-M3-04: Apple renewals delivered BEFORE their period starts (real Sandbox: DID_RENEW 16-44 s early, refused with
 * 409 before this fix). They are now verified, recorded and scheduled; credits are granted exactly once, only when the
 * period has started (no clock tolerance), by the next read/spend or by the sweeper with no further delivery.
 * In-process (inject) with a controlled clock, disposable database, MOCK-SIGNED fixtures. Categories: [BR] [INT] [NEG].
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { buildApp } from '../../src/app.ts';
import { sweepDueAppleRenewals } from '../../src/billing/apple/service.ts';
import { AppStoreSignedDataVerifier } from '../../src/billing/apple/verifier.ts';
import type { Clock } from '../../src/clock.ts';
import { AppleTestSigner, newTransactionId, PRODUCT, TEST_BUNDLE_ID } from '../support/apple-signing.ts';
import { createMigratedDatabase, expectPgError, type TestDb } from './helpers/test-db.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
let db: TestDb;
const signer = AppleTestSigner.create();
const verifier = new AppStoreSignedDataVerifier({ environment: 'Sandbox', bundleId: TEST_BUNDLE_ID, rootCertificates: [signer.root], onlineChecks: false });
let nowMs = Date.now();
const clock: Clock = { now: () => new Date(nowMs) };
let app: ReturnType<typeof buildApp>;
before(async () => {
  db = await createMigratedDatabase();
  app = buildApp({ pool: db.pool, clock, billing: { name: 'apple', verifier } });
  await app.ready();
});
after(async () => {
  await app?.close();
  await db?.drop();
});

type U = { token: string; userId: string; appAccountToken: string };
async function user(): Promise<U> {
  const email = `sched-${randomUUID()}@test.invalid`;
  const password = 'correct horse battery staple';
  const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password } });
  const token = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } })).json().token as string;
  const appAccountToken = (await app.inject({ method: 'GET', url: '/billing/apple/account', headers: { authorization: `Bearer ${token}` } })).json().appAccountToken as string;
  return { token, userId: reg.json().user.id as string, appAccountToken };
}
const sync = async (u: U, signedTransaction: string) => {
  const r = await app.inject({ method: 'POST', url: '/billing/apple/transactions', headers: { authorization: `Bearer ${u.token}` }, payload: { signedTransaction } });
  return { status: r.statusCode, body: r.json() as { result: string; creditsGranted: number; finishTransaction: boolean } };
};
const notify = async (signedPayload: string) => {
  const r = await app.inject({ method: 'POST', url: '/apple/notifications', payload: { signedPayload } });
  return { status: r.statusCode, body: r.json() as { result: string; duplicate: boolean } };
};
const readWallet = (u: U) => app.inject({ method: 'GET', url: '/wallet', headers: { authorization: `Bearer ${u.token}` } });
const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => (await db.pool.query<T>(sql, params)).rows;
const subBalance = async (userId: string) => Number((await q<{ balance: number }>(`SELECT balance FROM bucket_balances WHERE user_id = $1 AND bucket = 'SUBSCRIPTION'`, [userId]))[0]?.balance ?? 0);
const grants = async (userId: string) => (await q<{ delta: number }>(`SELECT delta FROM credit_ledger WHERE user_id = $1 AND entry_type = 'SUBSCRIPTION_GRANT' ORDER BY id`, [userId])).map((r) => r.delta);
const scheduled = (userId: string) => q<{ transaction_id: string; first_source: string; result: string | null }>(
  `SELECT transaction_id, first_source, result FROM apple_scheduled_renewals WHERE user_id = $1 ORDER BY starts_at`, [userId]);
async function ledgerReconciles(userId: string) {
  const rows = await q<{ n: string }>(`SELECT count(*) AS n FROM bucket_balances b WHERE b.user_id = $1
    AND b.balance <> COALESCE((SELECT sum(delta) FROM credit_ledger l WHERE l.user_id = b.user_id AND l.bucket = b.bucket), 0)`, [userId]);
  assert.equal(rows[0]!.n, '0');
}

/** A user with an active Basic period [T-1d, T+6d] and a verified renewal transaction for the next period. */
async function subscribed(product: string = PRODUCT.BASIC) {
  const T = nowMs;
  const u = await user();
  const O = newTransactionId();
  const first = signer.transaction({ productId: product, transactionId: O, purchaseDate: T - DAY, expiresDate: T + 6 * DAY, appAccountToken: u.appAccountToken });
  assert.equal((await sync(u, first)).status, 201);
  const end = T + 6 * DAY;
  const renewalId = newTransactionId();
  const renewal = signer.transaction({ productId: product, transactionId: renewalId, originalTransactionId: O, purchaseDate: end, expiresDate: end + 7 * DAY, appAccountToken: u.appAccountToken });
  return { u, O, first, end, renewal, renewalId };
}

describe('F-M3-04: renewals delivered before their period starts', () => {
  it('[BR] a DID_RENEW notification 40 s early is recorded (200, RENEWAL_SCHEDULED), grants nothing, and is applied at the start by a read', async () => {
    nowMs = Date.now();
    const s = await subscribed();
    nowMs = s.end - 40_000;
    const uuid = randomUUID();
    const n = await notify(signer.notification({ notificationType: 'DID_RENEW', notificationUUID: uuid, signedDate: nowMs, signedTransactionInfo: s.renewal }));
    assert.deepEqual([n.status, n.body.result], [200, 'RENEWAL_SCHEDULED']);
    assert.deepEqual(await q('SELECT result FROM apple_notifications WHERE notification_uuid = $1', [uuid]), [{ result: 'RENEWAL_SCHEDULED' }], 'notification evidence is kept');
    assert.deepEqual(await scheduled(s.u.userId), [{ transaction_id: s.renewalId, first_source: 'NOTIFICATION', result: null }]);
    assert.deepEqual(await grants(s.u.userId), [3000], 'nothing granted early');
    // 1 ms before the start: still nothing (no clock tolerance).
    nowMs = s.end - 1;
    await readWallet(s.u);
    assert.deepEqual(await grants(s.u.userId), [3000]);
    // At the start, the next read applies it exactly once.
    nowMs = s.end;
    await readWallet(s.u);
    await readWallet(s.u);
    assert.deepEqual(await grants(s.u.userId), [3000, 3000]);
    assert.equal(await subBalance(s.u.userId), 3000);
    assert.deepEqual((await scheduled(s.u.userId))[0]!.result, 'RENEWED');
    await ledgerReconciles(s.u.userId);
  });

  it('[BR] minutes early + duplicate deliveries (same notification, another notification, the app) before the start: one schedule, no grant', async () => {
    nowMs = Date.now();
    const s = await subscribed();
    nowMs = s.end - 30 * MIN;
    const n = signer.notification({ notificationType: 'DID_RENEW', signedDate: nowMs, signedTransactionInfo: s.renewal });
    assert.equal((await notify(n)).body.result, 'RENEWAL_SCHEDULED');
    assert.equal((await notify(n)).body.result, 'DUPLICATE');
    assert.equal((await notify(signer.notification({ notificationType: 'DID_RENEW', signedDate: nowMs + 1000, signedTransactionInfo: s.renewal }))).body.result, 'RENEWAL_SCHEDULED');
    const appEarly = await sync(s.u, s.renewal);
    assert.deepEqual([appEarly.status, appEarly.body.result, appEarly.body.creditsGranted, appEarly.body.finishTransaction], [202, 'RENEWAL_SCHEDULED', 0, true]);
    assert.equal((await scheduled(s.u.userId)).length, 1);
    assert.deepEqual(await grants(s.u.userId), [3000]);
    // After the start, the app's delivery applies it once (no read in between); later deliveries are duplicates.
    nowMs = s.end + 5000;
    const appLate = await sync(s.u, s.renewal);
    assert.equal(appLate.status, 200, 'applied by the scheduled path inside this request; this delivery is then a duplicate');
    assert.equal(appLate.body.result, 'IGNORED_DUPLICATE_TRANSACTION');
    assert.equal((await notify(signer.notification({ notificationType: 'DID_RENEW', signedDate: nowMs, signedTransactionInfo: s.renewal }))).body.result, 'IGNORED_DUPLICATE_TRANSACTION');
    assert.deepEqual(await grants(s.u.userId), [3000, 3000]);
    await ledgerReconciles(s.u.userId);
  });

  it('[BR] the app submits before the start and is then closed: the sweeper applies it with no further delivery; a second sweep is a no-op', async () => {
    nowMs = Date.now();
    const s = await subscribed(PRODUCT.PREMIUM);
    nowMs = s.end - 20_000;
    assert.equal((await sync(s.u, s.renewal)).status, 202);
    assert.deepEqual(await sweepDueAppleRenewals(db.pool, clock.now()), [], 'nothing due yet');
    nowMs = s.end + 1;
    const swept = await sweepDueAppleRenewals(db.pool, clock.now());
    assert.deepEqual(swept, [{ userId: s.u.userId, results: ['RENEWED'] }]);
    assert.deepEqual(await sweepDueAppleRenewals(db.pool, clock.now()), []);
    assert.deepEqual(await grants(s.u.userId), [6000, 6000]);
    const exp = await q<{ delta: number; expiration_reason: string }>(`SELECT delta, expiration_reason FROM credit_ledger WHERE user_id = $1 AND entry_type = 'SUBSCRIPTION_EXPIRATION'`, [s.u.userId]);
    assert.deepEqual(exp, [{ delta: -6000, expiration_reason: 'PERIOD_ENDED' }], 'the previous remainder expires once, at the end');
    await ledgerReconciles(s.u.userId);
  });

  it('[BR] backend restart: a renewal scheduled before the restart is applied by a fresh process (new pool) after the start', async () => {
    nowMs = Date.now();
    const s = await subscribed();
    nowMs = s.end - 10_000;
    assert.equal((await notify(signer.notification({ notificationType: 'DID_RENEW', signedDate: nowMs, signedTransactionInfo: s.renewal }))).body.result, 'RENEWAL_SCHEDULED');
    // "Restart": nothing in memory survives; only the database does.
    const fresh = new pg.Pool({ connectionString: db.url });
    try {
      nowMs = s.end + 2 * MIN;
      const swept = await sweepDueAppleRenewals(fresh, clock.now());
      assert.deepEqual(swept, [{ userId: s.u.userId, results: ['RENEWED'] }]);
    } finally {
      await fresh.end();
    }
    assert.deepEqual(await grants(s.u.userId), [3000, 3000]);
  });

  it('[BR] several periods missed while the backend was down are applied in order; only the running period is funded', async () => {
    nowMs = Date.now();
    const s = await subscribed();
    const r2 = signer.transaction({ productId: PRODUCT.BASIC, originalTransactionId: s.O, purchaseDate: s.end + 7 * DAY, expiresDate: s.end + 14 * DAY, appAccountToken: s.u.appAccountToken });
    // Both renewals delivered early, then nobody reads or spends for two periods (backend down, app closed).
    nowMs = s.end - MIN;
    assert.equal((await sync(s.u, s.renewal)).status, 202);
    assert.equal((await sync(s.u, r2)).status, 202);
    nowMs = s.end + 7 * DAY + MIN;
    const swept = await sweepDueAppleRenewals(db.pool, clock.now());
    assert.deepEqual(swept[0]!.results, ['RENEWED', 'RENEWED']);
    // Both became due unobserved: the already-ended first period is recorded without spendable credits (as for any
    // late delivery), the running second one is funded. Any read or spend in between would have funded the first.
    assert.deepEqual(await grants(s.u.userId), [3000, 3000]);
    assert.equal(await subBalance(s.u.userId), 3000);
    await ledgerReconciles(s.u.userId);
  });

  it('[NEG] refunded before it started: never granted (REVOKED_BEFORE_START); the current period is untouched', async () => {
    nowMs = Date.now();
    const s = await subscribed();
    nowMs = s.end - 5 * MIN;
    assert.equal((await sync(s.u, s.renewal)).status, 202);
    const refunded = signer.transaction({ productId: PRODUCT.BASIC, transactionId: s.renewalId, originalTransactionId: s.O, purchaseDate: s.end, expiresDate: s.end + 7 * DAY, appAccountToken: s.u.appAccountToken, revocationDate: nowMs, revocationReason: 1, signedDate: nowMs });
    const r = await notify(signer.notification({ notificationType: 'REFUND', signedDate: nowMs, signedTransactionInfo: refunded }));
    assert.equal(r.status, 200);
    assert.equal(await subBalance(s.u.userId), 3000, 'the running period keeps its credits');
    nowMs = s.end + 1000;
    await readWallet(s.u);
    assert.deepEqual(await grants(s.u.userId), [3000], 'the refunded renewal never grants');
    assert.equal((await scheduled(s.u.userId))[0]!.result, 'IGNORED_REVOKED_UNKNOWN', 'resolved by the refund itself');
    await ledgerReconciles(s.u.userId);
  });

  it('[NEG] defence in depth: a revocation recorded while the schedule is still open is honoured at activation (REVOKED_BEFORE_START)', async () => {
    nowMs = Date.now();
    const s = await subscribed();
    nowMs = s.end - MIN;
    assert.equal((await sync(s.u, s.renewal)).status, 202);
    // A revocation row without the refund path having resolved the schedule (e.g. recorded by another code path).
    await db.pool.query(
      `INSERT INTO apple_revocations (environment, transaction_id, user_id, product_type, revocation_date, revocation_reason, handling)
       VALUES ('Sandbox', $1, $2, 'SUBSCRIPTION', now(), 1, 'SUBSCRIPTION_REVOKED')`, [s.renewalId, s.u.userId]);
    nowMs = s.end + 1;
    const swept = await sweepDueAppleRenewals(db.pool, clock.now());
    assert.deepEqual(swept, [{ userId: s.u.userId, results: ['REVOKED_BEFORE_START'] }]);
    assert.deepEqual(await grants(s.u.userId), [3000]);
  });

  it('[NEG] superseded before it started: an upgrade made before the scheduled Basic renewal starts keeps Ultra; the renewal grants nothing', async () => {
    nowMs = Date.now();
    const s = await subscribed();
    nowMs = s.end - 2 * MIN;
    assert.equal((await sync(s.u, s.renewal)).status, 202);
    const ultra = signer.transaction({ productId: PRODUCT.ULTRA, originalTransactionId: s.O, purchaseDate: nowMs, expiresDate: nowMs + 7 * DAY, appAccountToken: s.u.appAccountToken });
    assert.equal((await sync(s.u, ultra)).body.result, 'UPGRADED');
    nowMs = s.end + 1000;
    await readWallet(s.u);
    assert.equal(await subBalance(s.u.userId), 12000);
    assert.deepEqual(await grants(s.u.userId), [3000, 12000]);
    assert.match((await scheduled(s.u.userId))[0]!.result ?? '', /^IGNORED_/);
    await ledgerReconciles(s.u.userId);
  });

  it('[BR] spends: before the start they use the current period; after the start the spend itself activates the renewal first', async () => {
    nowMs = Date.now();
    const s = await subscribed();
    const op = () => app.inject({ method: 'POST', url: '/operations', headers: { authorization: `Bearer ${s.u.token}` }, payload: { action: 'ADVANCED', requestId: randomUUID() } });
    nowMs = s.end - MIN;
    assert.equal((await sync(s.u, s.renewal)).status, 202);
    assert.equal((await op()).statusCode, 201);
    assert.equal(await subBalance(s.u.userId), 2200);
    nowMs = s.end + 1;
    assert.equal((await op()).statusCode, 201);
    assert.equal(await subBalance(s.u.userId), 2200, 'old remainder expired PERIOD_ENDED, 3,000 granted, 800 spent');
    await ledgerReconciles(s.u.userId);
  });

  it('[BR][F-M3-05] app submissions are audited with the verified transaction ids (never the signed payload)', async () => {
    nowMs = Date.now();
    const s = await subscribed();
    nowMs = s.end - MIN;
    assert.equal((await sync(s.u, s.renewal)).status, 202);
    const rows = await q<{ request: Record<string, string>; result: string; http_status: number }>(
      `SELECT request, result, http_status FROM subscription_events WHERE user_id = $1 AND type = 'APPLE_TRANSACTION' ORDER BY business_time`, [s.u.userId]);
    const last = rows.at(-1)!;
    assert.deepEqual({ ...last.request, sha256: typeof last.request.sha256 }, {
      kind: 'APPLE_TRANSACTION', sha256: 'string', environment: 'Sandbox', transactionId: s.renewalId, originalTransactionId: s.O,
      productId: PRODUCT.BASIC,
    });
    assert.deepEqual([last.result, last.http_status], ['RENEWAL_SCHEDULED', 202]);
    assert.ok(!JSON.stringify(rows).includes(s.renewal) && !JSON.stringify(rows).includes('eyJ'), 'no signed payload is stored');
  });

  it('[NEG] database guards: a resolved schedule cannot change or be deleted; a schedule must match its verified transaction', async () => {
    nowMs = Date.now();
    const s = await subscribed();
    nowMs = s.end - MIN;
    assert.equal((await sync(s.u, s.renewal)).status, 202);
    nowMs = s.end + 1;
    await readWallet(s.u);
    assert.equal((await expectPgError(db.pool.query(`UPDATE apple_scheduled_renewals SET result = 'X' WHERE user_id = $1`, [s.u.userId]))).code, '23001');
    assert.equal((await expectPgError(db.pool.query(`DELETE FROM apple_scheduled_renewals WHERE user_id = $1`, [s.u.userId]))).code, '23001');
    const other = await user();
    const mismatch = await expectPgError(db.pool.query(
      `INSERT INTO apple_scheduled_renewals (environment, transaction_id, user_id, starts_at, first_source)
       SELECT environment, transaction_id, $2, purchase_date, 'CLIENT' FROM apple_transactions WHERE transaction_id = $1`, [s.renewalId, other.userId]));
    assert.ok(['23503', '23505'].includes(mismatch.code ?? ''), mismatch.code);
  });
});
