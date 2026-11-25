/**
 * M3 Apple mode (BILLING_PROVIDER=apple, Sandbox) over HTTP, with trusted signed fixtures from a per-run test CA
 * (tests/support/apple-signing.ts) and tampered/forged/mismatched negatives. Environment label: MOCK-SIGNED FIXTURES
 * on Apple's real verification code path. NOT Apple Sandbox evidence (docs/m3-verification.md).
 * Oracles: the DB (purchases, ledger, balances, apple_* tables), computed from PRD amounts, never from responses.
 * Categories (D-005): [BR], [INT], [NEG].
 */
import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import type pg from 'pg';
import { AppleTestSigner, newTransactionId, PRODUCT, transactionPayload } from '../support/apple-signing.ts';
import { expect, test } from './support/fixtures.ts';
import { bearer, dbBalances, newUser, type TestUser } from './support/helpers.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

async function tokenOf(api: APIRequestContext, user: TestUser): Promise<string> {
  const r = await api.get('/billing/apple/account', { headers: bearer(user.token) });
  expect(r.status()).toBe(200);
  return (await r.json()).appAccountToken;
}
const sync = (api: APIRequestContext, user: TestUser, signedTransaction: string, signedRenewalInfo?: string) =>
  api.post('/billing/apple/transactions', { headers: bearer(user.token), data: { signedTransaction, ...(signedRenewalInfo && { signedRenewalInfo }) } });
const notify = (api: APIRequestContext, signedPayload: string) => api.post('/apple/notifications', { data: { signedPayload } });

async function ledger(db: pg.Pool, userId: string) {
  const { rows } = await db.query<{ entry_type: string; bucket: string; delta: number; expiration_reason: string | null }>(
    `SELECT entry_type, bucket::text AS bucket, delta, expiration_reason FROM credit_ledger WHERE user_id = $1 ORDER BY id`, [userId]);
  return rows;
}
const count = async (db: pg.Pool, sql: string, params: unknown[]) => Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);

/** A live subscription transaction: started `agoMs` ago, lasting `lengthMs`. */
function sub(signer: AppleTestSigner, p: { productId: string; token?: string; ago?: number; length?: number; original?: string; id?: string; extra?: object }) {
  const purchaseDate = Date.now() - (p.ago ?? MIN);
  return signer.transaction({
    productId: p.productId, purchaseDate, expiresDate: purchaseDate + (p.length ?? 7 * DAY),
    ...(p.token && { appAccountToken: p.token }), ...(p.original && { originalTransactionId: p.original }), ...(p.id && { transactionId: p.id }),
    ...p.extra,
  });
}

test.describe('Apple mode: route surface', () => {
  test('[NEG] the mock purchase/subscription mutation routes do not exist in Apple mode; read routes and Apple routes do', async ({ apple, api }) => {
    expect(await (await apple.api.get('/billing/config')).json()).toEqual({ provider: 'apple' });
    expect(await (await api.get('/billing/config')).json()).toEqual({ provider: 'mock' });
    const user = await newUser(apple.api, 'apple-surface');
    for (const path of ['/purchases', '/subscriptions/purchase', '/subscriptions/change-plan', '/subscriptions/cancel', '/subscriptions/mock-notifications']) {
      const r = await apple.api.post(path, { headers: bearer(user.token), data: {} });
      expect(r.status(), path).toBe(404);
    }
    expect((await apple.api.get('/subscriptions/current', { headers: bearer(user.token) })).status()).toBe(200);
    expect((await apple.api.get('/billing/apple/account')).status()).toBe(401);
    expect((await apple.api.post('/billing/apple/transactions', { data: { signedTransaction: 'a.b.c' } })).status()).toBe(401);
    // The Apple routes do not exist on the mock server.
    expect((await api.post('/apple/notifications', { data: { signedPayload: 'a.b.c' } })).status()).toBe(404);
  });

  test('[BR] each user gets a distinct, stable appAccountToken and the StoreKit product ids', async ({ apple }) => {
    const a = await newUser(apple.api, 'apple-token-a');
    const b = await newUser(apple.api, 'apple-token-b');
    const ta = await tokenOf(apple.api, a);
    expect(ta).toMatch(/^[0-9a-f-]{36}$/);
    expect(await tokenOf(apple.api, a)).toBe(ta);
    expect(await tokenOf(apple.api, b)).not.toBe(ta);
    const account = await (await apple.api.get('/billing/apple/account', { headers: bearer(a.token) })).json();
    expect(account.environment).toBe('Sandbox');
    expect(account.products.consumables).toEqual({ CREDITS_S: PRODUCT.S, CREDITS_M: PRODUCT.M, CREDITS_L: PRODUCT.L });
    expect(account.products.subscriptions).toEqual({ BASIC_WEEKLY: PRODUCT.BASIC, PREMIUM_WEEKLY: PRODUCT.PREMIUM, ULTRA_WEEKLY: PRODUCT.ULTRA });
  });
});

test.describe('Apple consumables (BUY-01..03 on verified StoreKit transactions)', () => {
  test('[BR][BUY-01] each verified pack grants its exact catalog credits once; the app may then finish the transaction', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-packs');
    const token = await tokenOf(apple.api, user);
    const expected = { [PRODUCT.S]: 5000, [PRODUCT.M]: 7000, [PRODUCT.L]: 10000 };
    let total = 0;
    for (const [productId, credits] of Object.entries(expected)) {
      const r = await sync(apple.api, user, apple.signer.transaction({ productId, appAccountToken: token }));
      expect(r.status(), await r.text()).toBe(201);
      const body = await r.json();
      expect(body).toMatchObject({ result: 'FULFILLED', productType: 'CONSUMABLE', creditsGranted: credits, finishTransaction: true });
      total += credits;
    }
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(total);
    expect(await count(db, `SELECT count(*) AS n FROM purchases WHERE user_id = $1 AND provider = 'apple' AND outcome = 'APPROVED' AND provider_transaction_id LIKE 'Sandbox:%'`, [user.id])).toBe(3);
  });

  test('[BR][BUY-03] replays (same JWS, or the same transaction re-signed later) never grant again', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-replay');
    const token = await tokenOf(apple.api, user);
    const payload = transactionPayload({ productId: PRODUCT.M, appAccountToken: token });
    const jws = apple.signer.jws(payload);
    expect((await sync(apple.api, user, jws)).status()).toBe(201);
    const replay = await sync(apple.api, user, jws);
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toMatchObject({ result: 'ALREADY_FULFILLED', creditsGranted: 0, finishTransaction: true });
    const resigned = await sync(apple.api, user, apple.signer.jws({ ...payload, signedDate: Date.now() + 1000 }));
    expect(resigned.status()).toBe(200);
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(7000);
    expect(await count(db, `SELECT count(*) AS n FROM credit_ledger WHERE user_id = $1 AND entry_type = 'PURCHASE_GRANT'`, [user.id])).toBe(1);
  });

  test('[INT][CR-03] 10 concurrent deliveries of the same verified transaction produce exactly one grant', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-race');
    const jws = apple.signer.transaction({ productId: PRODUCT.L, appAccountToken: await tokenOf(apple.api, user) });
    const statuses = (await Promise.all(Array.from({ length: 10 }, () => sync(apple.api, user, jws)))).map((r) => r.status()).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(10000);
    expect(await count(db, `SELECT count(*) AS n FROM credit_ledger WHERE user_id = $1 AND entry_type = 'PURCHASE_GRANT'`, [user.id])).toBe(1);
  });

  test('[NEG] cross-account replay: B presenting A\'s verified transaction gets 409 and nothing; A keeps ownership', async ({ apple, db }) => {
    const a = await newUser(apple.api, 'apple-owner');
    const b = await newUser(apple.api, 'apple-thief');
    const jws = apple.signer.transaction({ productId: PRODUCT.S, appAccountToken: await tokenOf(apple.api, a) });
    // B first (before A ever synced), then concurrently with A.
    const first = await sync(apple.api, b, jws);
    expect(first.status()).toBe(409);
    expect((await first.json()).error.code).toBe('APPLE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT');
    const [ra, rb] = await Promise.all([sync(apple.api, a, jws), sync(apple.api, b, jws)]);
    expect(ra.status()).toBe(201);
    expect(rb.status()).toBe(409);
    // Deterministic: after A owns the purchase chain, B's replay is still refused (ownership comes from the link).
    const afterLink = await sync(apple.api, b, jws);
    expect(afterLink.status()).toBe(409);
    expect((await afterLink.json()).error.code).toBe('APPLE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT');
    // A later transaction of A's chain re-signed without any token is also refused for B (restore reassignment).
    const sameChain = apple.signer.transaction({ productId: PRODUCT.S, originalTransactionId: JSON.parse(Buffer.from(jws.split('.')[1]!, 'base64url').toString()).originalTransactionId });
    expect((await sync(apple.api, b, sameChain)).status()).toBe(409);
    expect((await dbBalances(db, b.id)).CONSUMABLE).toBe(0);
    expect((await dbBalances(db, a.id)).CONSUMABLE).toBe(5000);
    expect(await count(db, `SELECT count(*) AS n FROM apple_transactions WHERE user_id = $1`, [b.id])).toBe(0);
  });

  test('[NEG] a purchase without MonetaLab\'s appAccountToken, or with an unknown token, cannot be claimed', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-notoken');
    const none = await sync(apple.api, user, apple.signer.transaction({ productId: PRODUCT.S }));
    expect(none.status()).toBe(409);
    expect((await none.json()).error.code).toBe('APPLE_ACCOUNT_TOKEN_MISSING');
    const unknown = await sync(apple.api, user, apple.signer.transaction({ productId: PRODUCT.S, appAccountToken: randomUUID() }));
    expect(unknown.status()).toBe(409);
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(0);
  });

  test('[NEG] forged, tampered, unsigned, wrong-app, wrong-environment and unknown-product data grant nothing', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-forged');
    const token = await tokenOf(apple.api, user);
    const good = apple.signer.transaction({ productId: PRODUCT.S, appAccountToken: token });
    const [h, p] = good.split('.');
    const cases: Array<[string, string, number, string]> = [
      ['forged signature', `${h}.${p}.${Buffer.alloc(64, 9).toString('base64url')}`, 400, 'APPLE_SIGNATURE_INVALID'],
      ['tampered payload', `${h}.${Buffer.from(JSON.stringify(transactionPayload({ productId: PRODUCT.L, appAccountToken: token }))).toString('base64url')}.${good.split('.')[2]}`, 400, 'APPLE_SIGNATURE_INVALID'],
      ['unsigned', `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.AA`, 400, 'APPLE_SIGNATURE_INVALID'],
      ['wrong bundle', apple.signer.transaction({ productId: PRODUCT.S, appAccountToken: token, bundleId: 'com.example.other' }), 400, 'APPLE_APP_MISMATCH'],
      ['production data', apple.signer.transaction({ productId: PRODUCT.S, appAccountToken: token, environment: 'Production' }), 400, 'APPLE_ENVIRONMENT_MISMATCH'],
      ['xcode data', apple.signer.transaction({ productId: PRODUCT.S, appAccountToken: token, environment: 'Xcode' }), 400, 'APPLE_ENVIRONMENT_MISMATCH'],
      ['unknown product', apple.signer.transaction({ productId: 'dev.monetalab.qa.credits.999999', appAccountToken: token }), 422, 'APPLE_UNKNOWN_PRODUCT'],
    ];
    for (const [name, jws, status, code] of cases) {
      const r = await sync(apple.api, user, jws);
      expect(r.status(), name).toBe(status);
      expect((await r.json()).error.code, name).toBe(code);
    }
    // A client "success" flag or decoded JSON is not an accepted input.
    expect((await apple.api.post('/billing/apple/transactions', { headers: bearer(user.token), data: { signedTransaction: good, approved: true } })).status()).toBe(400);
    expect((await apple.api.post('/billing/apple/transactions', { headers: bearer(user.token), data: { transaction: transactionPayload({ productId: PRODUCT.S }) } })).status()).toBe(400);
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(0);
    expect(await count(db, `SELECT count(*) AS n FROM apple_transactions WHERE user_id = $1`, [user.id])).toBe(0);
  });

  test('[NEG][PRD §7 #2] a consumable refund is recorded without clawback; balances never go negative', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-cons-refund');
    const payload = transactionPayload({ productId: PRODUCT.S, appAccountToken: await tokenOf(apple.api, user) });
    expect((await sync(apple.api, user, apple.signer.jws(payload))).status()).toBe(201);
    const refund = await notify(apple.api, apple.signer.notification({
      notificationType: 'REFUND', signedTransactionInfo: apple.signer.jws({ ...payload, revocationDate: Date.now(), revocationReason: 0, signedDate: Date.now() }),
    }));
    expect(refund.status()).toBe(200);
    expect((await refund.json()).result).toBe('REFUND_RECORDED_NO_CLAWBACK');
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(5000);
    expect(await count(db, `SELECT count(*) AS n FROM apple_revocations WHERE user_id = $1 AND handling = 'CONSUMABLE_RECORDED_NO_CLAWBACK'`, [user.id])).toBe(1);
  });

  test('[BR][PW-02] journey: 402 insufficient -> verified Apple purchase -> balance sufficient -> operation only on explicit request', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-journey');
    const blocked = await apple.api.post('/operations', { headers: bearer(user.token), data: { action: 'STANDARD', requestId: randomUUID() } });
    expect(blocked.status()).toBe(402);
    const bought = await sync(apple.api, user, apple.signer.transaction({ productId: PRODUCT.S, appAccountToken: await tokenOf(apple.api, user) }));
    expect(bought.status()).toBe(201);
    expect(await count(db, `SELECT count(*) AS n FROM operations WHERE user_id = $1`, [user.id])).toBe(0);
    const run = await apple.api.post('/operations', { headers: bearer(user.token), data: { action: 'STANDARD', requestId: randomUUID() } });
    expect(run.status()).toBe(201);
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(4500);
  });
});

test.describe('Apple subscriptions (TRIAL-01/02, SUB-01..06)', () => {
  test('[BR][TRIAL-01] a verified Basic FREE_TRIAL grants 1,000 SUBSCRIPTION credits once, recorded as APPLE_VERIFIED', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-trial');
    const token = await tokenOf(apple.api, user);
    const r = await sync(apple.api, user, sub(apple.signer, { productId: PRODUCT.BASIC, token, length: 3 * DAY, extra: { offerType: 1, offerDiscountType: 'FREE_TRIAL' } }));
    expect(r.status(), await r.text()).toBe(201);
    const body = await r.json();
    expect(body.result).toBe('TRIAL_STARTED');
    expect(body.subscription).toMatchObject({ status: 'TRIAL', planId: 'BASIC_WEEKLY', entitled: true });
    expect(body.trial).toMatchObject({ eligible: false, source: 'BACKEND_RECORD_AND_APPLE', offer: null });
    expect(await dbBalances(db, user.id)).toMatchObject({ SUBSCRIPTION: 1000 });
    expect((await db.query(`SELECT source FROM trial_redemptions WHERE user_id = $1`, [user.id])).rows).toEqual([{ source: 'APPLE_VERIFIED' }]);
  });

  test('[BR] before a trial, the server offers the trial message only as "when the App Store confirms eligibility"', async ({ apple }) => {
    const user = await newUser(apple.api, 'apple-offer');
    const state = await (await apple.api.get('/subscriptions/current', { headers: bearer(user.token) })).json();
    expect(state.trial.eligible).toBe(true);
    expect(state.trial.offer.message).toMatch(/when the App Store confirms you're eligible/);
  });

  test('[NEG][TRIAL-02] a second Apple trial (e.g. another Apple ID) after the first ended is entitled but funds 0 credits', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-trial2');
    const token = await tokenOf(apple.api, user);
    // First trial already ended (3 days, ended 1 hour ago): redeemed, nothing spendable remains.
    expect((await sync(apple.api, user, sub(apple.signer, { productId: PRODUCT.BASIC, token, ago: 3 * DAY + 60 * MIN, length: 3 * DAY, extra: { offerType: 1, offerDiscountType: 'FREE_TRIAL' } }))).status()).toBe(201);
    const second = await sync(apple.api, user, sub(apple.signer, { productId: PRODUCT.BASIC, token, length: 3 * DAY, extra: { offerType: 1, offerDiscountType: 'FREE_TRIAL' } }));
    expect(second.status(), await second.text()).toBe(201);
    expect((await second.json()).result).toBe('TRIAL_STARTED_NOT_FUNDED');
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(0);
    expect(await count(db, `SELECT count(*) AS n FROM credit_ledger WHERE user_id = $1 AND entry_type = 'SUBSCRIPTION_GRANT'`, [user.id])).toBe(0);
  });

  test('[BR][SUB-01] trial conversion: the verified paid renewal expires the trial remainder and grants 3,000', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-convert');
    const token = await tokenOf(apple.api, user);
    const original = newTransactionId();
    const trialEnd = Date.now() + 4000;
    const trialStart = trialEnd - 3 * DAY;
    // Trial still running (ends in 4 seconds): funded.
    expect((await sync(apple.api, user, apple.signer.transaction({ productId: PRODUCT.BASIC, transactionId: original, purchaseDate: trialStart, expiresDate: trialEnd, appAccountToken: token, offerType: 1, offerDiscountType: 'FREE_TRIAL' }))).status()).toBe(201);
    // Apple delivers the paid period before it starts (F-M3-04): verified and scheduled (202), nothing granted yet.
    const renewal = apple.signer.transaction({ productId: PRODUCT.BASIC, originalTransactionId: original, purchaseDate: trialEnd, expiresDate: trialEnd + 7 * DAY, appAccountToken: token });
    const early = await sync(apple.api, user, renewal);
    expect(early.status()).toBe(202);
    expect(await early.json()).toMatchObject({ result: 'RENEWAL_SCHEDULED', creditsGranted: 0, finishTransaction: true });
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(1000);
    expect(await count(db, `SELECT count(*) AS n FROM apple_scheduled_renewals WHERE user_id = $1 AND resolved_at IS NULL`, [user.id])).toBe(1);
    // Once the verified period has started (server clock vs Apple's date, never the client clock), the next read
    // converts it with no further delivery from the app or Apple.
    await expect.poll(() => Date.now() > trialEnd, { timeout: 15_000 }).toBe(true);
    expect((await apple.api.get('/wallet', { headers: bearer(user.token) })).status()).toBe(200);
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(3000);
    expect((await db.query(`SELECT result FROM apple_scheduled_renewals WHERE user_id = $1`, [user.id])).rows).toEqual([{ result: 'TRIAL_CONVERTED' }]);
    // A later delivery of the same renewal is a duplicate.
    const again = await sync(apple.api, user, renewal);
    expect((await again.json()).result).toBe('IGNORED_DUPLICATE_TRANSACTION');
    // The trial had already ended when the renewal arrived, so its remainder expires as PERIOD_ENDED (D-029), once.
    expect(await ledger(db, user.id)).toEqual([
      { entry_type: 'SUBSCRIPTION_GRANT', bucket: 'SUBSCRIPTION', delta: 1000, expiration_reason: null },
      { entry_type: 'SUBSCRIPTION_EXPIRATION', bucket: 'SUBSCRIPTION', delta: -1000, expiration_reason: 'PERIOD_ENDED' },
      { entry_type: 'SUBSCRIPTION_GRANT', bucket: 'SUBSCRIPTION', delta: 3000, expiration_reason: null },
    ]);
  });

  test('[BR][SUB-03] an effective upgrade replaces the remainder with the full Premium allotment; consumables untouched', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-upgrade');
    const token = await tokenOf(apple.api, user);
    expect((await sync(apple.api, user, apple.signer.transaction({ productId: PRODUCT.S, appAccountToken: token }))).status()).toBe(201);
    const original = newTransactionId();
    expect((await sync(apple.api, user, sub(apple.signer, { productId: PRODUCT.BASIC, token, id: original, ago: DAY }))).status()).toBe(201);
    const up = await sync(apple.api, user, sub(apple.signer, { productId: PRODUCT.PREMIUM, token, original, ago: 1000 }));
    expect((await up.json()).result).toBe('UPGRADED');
    expect(await dbBalances(db, user.id)).toMatchObject({ SUBSCRIPTION: 6000, CONSUMABLE: 5000 });
    // The replaced Basic transaction redelivered as isUpgraded changes nothing.
    const again = await sync(apple.api, user, apple.signer.transaction({ productId: PRODUCT.BASIC, transactionId: original, purchaseDate: Date.now() - DAY, expiresDate: Date.now() + 6 * DAY, appAccountToken: token, isUpgraded: true }));
    expect(again.status()).toBe(200);
    expect(await dbBalances(db, user.id)).toMatchObject({ SUBSCRIPTION: 6000, CONSUMABLE: 5000 });
  });

  test('[BR][SUB-04/05] downgrade: scheduled from renewal info without credit change, effective at the verified renewal', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-downgrade');
    const token = await tokenOf(apple.api, user);
    const original = newTransactionId();
    const ultra = sub(apple.signer, { productId: PRODUCT.ULTRA, token, id: original, ago: DAY });
    const scheduled = await sync(apple.api, user, ultra, apple.signer.renewalInfo({ originalTransactionId: original, productId: PRODUCT.ULTRA, autoRenewProductId: PRODUCT.BASIC }));
    expect((await scheduled.json()).subscription.pendingPlanId).toBe('BASIC_WEEKLY');
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(12000);

    // Separate customer whose Ultra period just ended and whose renewal is Basic: the downgrade takes effect.
    const other = await newUser(apple.api, 'apple-downgrade-effective');
    const t2 = await tokenOf(apple.api, other);
    const o2 = newTransactionId();
    const end = Date.now() - 1000;
    expect((await sync(apple.api, other, apple.signer.transaction({ productId: PRODUCT.ULTRA, transactionId: o2, purchaseDate: end - 7 * DAY, expiresDate: end, appAccountToken: t2 }))).status()).toBe(201);
    const renewed = await sync(apple.api, other, apple.signer.transaction({ productId: PRODUCT.BASIC, originalTransactionId: o2, purchaseDate: end, expiresDate: end + 7 * DAY, appAccountToken: t2 }));
    expect((await renewed.json()).result).toBe('RENEWED_DOWNGRADED');
    expect((await dbBalances(db, other.id)).SUBSCRIPTION).toBe(3000);
  });

  test('[NEG][PRD §7 #7] a different purchase chain while entitled is refused and changes nothing', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-second-chain');
    const token = await tokenOf(apple.api, user);
    expect((await sync(apple.api, user, sub(apple.signer, { productId: PRODUCT.BASIC, token }))).status()).toBe(201);
    const second = await sync(apple.api, user, sub(apple.signer, { productId: PRODUCT.ULTRA, token, ago: 1000 }));
    expect(second.status()).toBe(409);
    expect((await second.json()).error.code).toBe('ALREADY_SUBSCRIBED');
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(3000);
  });
});

test.describe('App Store Server Notifications V2', () => {
  test('[NEG] forged / wrong-environment / malformed notifications are rejected and leave no record', async ({ apple, db }) => {
    const uuid = randomUUID();
    const forged = apple.signer.notification({ notificationType: 'TEST', notificationUUID: uuid });
    const [h, p] = forged.split('.');
    expect((await notify(apple.api, `${h}.${p}.${Buffer.alloc(64, 3).toString('base64url')}`)).status()).toBe(400);
    expect((await notify(apple.api, apple.signer.notification({ notificationType: 'TEST', notificationUUID: uuid, environment: 'Production' }))).status()).toBe(400);
    expect((await apple.api.post('/apple/notifications', { data: { signedPayload: 'not-a-jws' } })).status()).toBe(400);
    expect(await count(db, `SELECT count(*) AS n FROM apple_notifications WHERE notification_uuid = $1`, [uuid])).toBe(0);
  });

  test('[NEG] a validly signed notification wrapping a FORGED nested transaction or renewal info is rejected; nothing applied', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-nested-forgery');
    const token = await tokenOf(apple.api, user);
    const forger = AppleTestSigner.create({ name: 'Nested Forger' });
    const uuid = randomUUID();
    const forgedTx = forger.transaction({ productId: PRODUCT.ULTRA, appAccountToken: token, purchaseDate: Date.now() - 1000, expiresDate: Date.now() + 7 * DAY });
    const r = await notify(apple.api, apple.signer.notification({ notificationType: 'SUBSCRIBED', notificationUUID: uuid, signedTransactionInfo: forgedTx }));
    expect(r.status()).toBe(400);
    expect((await r.json()).error.code).toBe('APPLE_SIGNATURE_INVALID');
    const tx = sub(apple.signer, { productId: PRODUCT.BASIC, token });
    const forgedRenewal = forger.renewalInfo({ originalTransactionId: '1', productId: PRODUCT.BASIC, autoRenewStatus: 0 });
    expect((await notify(apple.api, apple.signer.notification({ notificationType: 'DID_CHANGE_RENEWAL_STATUS', signedTransactionInfo: tx, signedRenewalInfo: forgedRenewal }))).status()).toBe(400);
    expect(await count(db, `SELECT count(*) AS n FROM apple_notifications WHERE notification_uuid = $1`, [uuid])).toBe(0);
    expect(await dbBalances(db, user.id)).toMatchObject({ SUBSCRIPTION: 0 });
  });

  test('[BR] SUBSCRIBED before the app syncs: applied through the signed appAccountToken; the later app sync is a no-op', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-notif-first');
    const tx = sub(apple.signer, { productId: PRODUCT.PREMIUM, token: await tokenOf(apple.api, user) });
    const r = await notify(apple.api, apple.signer.notification({ notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY', signedTransactionInfo: tx }));
    expect(r.status()).toBe(200);
    expect((await r.json()).result).toBe('SUBSCRIPTION_STARTED');
    const later = await sync(apple.api, user, tx);
    expect(later.status()).toBe(200);
    expect(await later.json()).toMatchObject({ result: 'IGNORED_DUPLICATE_TRANSACTION', finishTransaction: true });
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(6000);
  });

  test('[INT][ADS-04-style] the same notification delivered 8x concurrently is applied exactly once', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-notif-race');
    const n = apple.signer.notification({ notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY', signedTransactionInfo: sub(apple.signer, { productId: PRODUCT.ULTRA, token: await tokenOf(apple.api, user) }) });
    const results = await Promise.all(Array.from({ length: 8 }, () => notify(apple.api, n)));
    expect(results.map((r) => r.status())).toEqual(Array(8).fill(200));
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(bodies.filter((b) => b.result === 'DUPLICATE')).toHaveLength(7);
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(12000);
    expect(await count(db, `SELECT count(*) AS n FROM credit_ledger WHERE user_id = $1 AND entry_type = 'SUBSCRIPTION_GRANT'`, [user.id])).toBe(1);
  });

  test('[BR][SUB-06] REFUND revokes the current period: remaining subscription credits removed, spent ones kept, consumables kept; no restore by late events', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-refund');
    const token = await tokenOf(apple.api, user);
    expect((await sync(apple.api, user, apple.signer.transaction({ productId: PRODUCT.M, appAccountToken: token }))).status()).toBe(201);
    const original = newTransactionId();
    const payload = transactionPayload({ productId: PRODUCT.PREMIUM, transactionId: original, appAccountToken: token, purchaseDate: Date.now() - DAY, expiresDate: Date.now() + 6 * DAY });
    expect((await sync(apple.api, user, apple.signer.jws(payload))).status()).toBe(201);
    expect((await apple.api.post('/operations', { headers: bearer(user.token), data: { action: 'ADVANCED', requestId: randomUUID() } })).status()).toBe(201);
    const revoked = { ...payload, revocationDate: Date.now(), revocationReason: 1, signedDate: Date.now() };
    const uuid = randomUUID();
    const r = await notify(apple.api, apple.signer.notification({ notificationType: 'REFUND', notificationUUID: uuid, signedTransactionInfo: apple.signer.jws(revoked) }));
    expect((await r.json()).result).toBe('REVOKED_CURRENT');
    expect(await dbBalances(db, user.id)).toMatchObject({ SUBSCRIPTION: 0, CONSUMABLE: 7000 });
    expect((await ledger(db, user.id)).at(-1)).toEqual({ entry_type: 'SUBSCRIPTION_EXPIRATION', bucket: 'SUBSCRIPTION', delta: -5200, expiration_reason: 'REVOKED' });
    // Same notification again: duplicate. A new REFUND notification for the same transaction: already revoked.
    expect((await (await notify(apple.api, apple.signer.notification({ notificationType: 'REFUND', notificationUUID: uuid, signedTransactionInfo: apple.signer.jws(revoked) }))).json()).result).toBe('DUPLICATE');
    expect((await (await notify(apple.api, apple.signer.notification({ notificationType: 'REFUND', signedTransactionInfo: apple.signer.jws(revoked) }))).json()).result).toMatch(/^IGNORED_ALREADY_REVOKED/);
    // A delayed renewal from before the refund cannot restore the entitlement.
    const late = await notify(apple.api, apple.signer.notification({ notificationType: 'DID_RENEW', signedTransactionInfo: apple.signer.transaction({ productId: PRODUCT.PREMIUM, originalTransactionId: original, purchaseDate: Date.now() - 2 * DAY, expiresDate: Date.now() + 5 * DAY, appAccountToken: token }) }));
    expect((await late.json()).result).toMatch(/^IGNORED_SUPERSEDED/);
    const state = await (await apple.api.get('/subscriptions/current', { headers: bearer(user.token) })).json();
    expect(state.subscription).toMatchObject({ status: 'REVOKED', entitled: false });
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(0);
  });

  test('[BR] DID_CHANGE_RENEWAL_STATUS off = cancellation only; DID_FAIL_TO_RENEW grace period grants nothing; EXPIRED after the end', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-status');
    const token = await tokenOf(apple.api, user);
    const original = newTransactionId();
    const end = Date.now() + 3000;
    const tx = apple.signer.transaction({ productId: PRODUCT.BASIC, transactionId: original, purchaseDate: end - 7 * DAY, expiresDate: end, appAccountToken: token });
    expect((await sync(apple.api, user, tx)).status()).toBe(201);
    const off = await notify(apple.api, apple.signer.notification({ notificationType: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_DISABLED', signedTransactionInfo: tx, signedRenewalInfo: apple.signer.renewalInfo({ originalTransactionId: original, productId: PRODUCT.BASIC, autoRenewStatus: 0 }) }));
    expect((await off.json()).result).toContain('AUTO_RENEW_DISABLED');
    const s1 = await (await apple.api.get('/subscriptions/current', { headers: bearer(user.token) })).json();
    expect(s1.subscription).toMatchObject({ autoRenew: false, entitled: true });
    expect(s1.wallet.balances.SUBSCRIPTION).toBe(3000);
    const grace = await notify(apple.api, apple.signer.notification({ notificationType: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD', signedTransactionInfo: tx }));
    expect((await grace.json()).result).toBe('GRACE_PERIOD_NOT_APPLIED');
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(3000);
    await expect.poll(() => Date.now() > end, { timeout: 10_000 }).toBe(true);
    const expired = await notify(apple.api, apple.signer.notification({ notificationType: 'EXPIRED', subtype: 'VOLUNTARY', signedTransactionInfo: tx }));
    expect((await expired.json()).result).toBe('EXPIRED');
    const s2 = await (await apple.api.get('/subscriptions/current', { headers: bearer(user.token) })).json();
    expect(s2.subscription).toMatchObject({ status: 'EXPIRED', entitled: false });
    expect(s2.wallet.balances.SUBSCRIPTION).toBe(0);
  });

  test('[BR][F-M3-02/03] EXPIRED with auto-renew ON: status EXPIRED, Apple intent kept; duplicate and older notifications change nothing', async ({ apple, db }) => {
    const user = await newUser(apple.api, 'apple-expired-intent');
    const token = await tokenOf(apple.api, user);
    const original = newTransactionId();
    const end = Date.now() + 3000;
    const tx = apple.signer.transaction({ productId: PRODUCT.BASIC, transactionId: original, purchaseDate: end - 7 * DAY, expiresDate: end, appAccountToken: token });
    expect((await sync(apple.api, user, tx)).status()).toBe(201);
    await expect.poll(() => Date.now() > end, { timeout: 10_000 }).toBe(true);
    const signedDate = Date.now();
    const uuid = randomUUID();
    const expired = apple.signer.notification({
      notificationType: 'EXPIRED', subtype: 'BILLING_RETRY', notificationUUID: uuid, signedDate, signedTransactionInfo: tx,
      signedRenewalInfo: apple.signer.renewalInfo({ originalTransactionId: original, productId: PRODUCT.BASIC, autoRenewStatus: 1, expirationIntent: 2, signedDate }),
    });
    const r = await notify(apple.api, expired);
    expect((await r.json()).result).toBe('EXPIRED|RENEWAL_INTENT_RECORDED_AUTO_RENEW_ON');
    const appleState = async () => (await db.query(
      `SELECT status, auto_renew, apple_status, apple_auto_renew, apple_expiration_intent FROM subscriptions WHERE user_id = $1`, [user.id])).rows[0];
    const expected = { status: 'EXPIRED', auto_renew: false, apple_status: 'EXPIRED', apple_auto_renew: true, apple_expiration_intent: 2 };
    expect(await appleState()).toEqual(expected);
    const view = await (await apple.api.get('/subscriptions/current', { headers: bearer(user.token) })).json();
    expect(view.subscription).toMatchObject({ status: 'EXPIRED', entitled: false, autoRenew: false, apple: { status: 'EXPIRED', autoRenew: true, expirationIntent: 2 } });
    const ledgerBefore = await ledger(db, user.id);
    expect(ledgerBefore.filter((e) => e.bucket === 'SUBSCRIPTION')).toEqual([
      { entry_type: 'SUBSCRIPTION_GRANT', bucket: 'SUBSCRIPTION', delta: 3000, expiration_reason: null },
      { entry_type: 'SUBSCRIPTION_EXPIRATION', bucket: 'SUBSCRIPTION', delta: -3000, expiration_reason: 'PERIOD_ENDED' },
    ]);
    // Duplicate delivery (same notificationUUID): acknowledged, nothing applied.
    expect((await (await notify(apple.api, expired)).json()).result).toBe('DUPLICATE');
    // Out of order: Apple retries an older DID_RENEW / DID_FAIL_TO_RENEW signed before the expiry.
    const lateRenew = await notify(apple.api, apple.signer.notification({ notificationType: 'DID_RENEW', signedDate: signedDate - DAY, signedTransactionInfo: tx }));
    expect(lateRenew.status()).toBe(200);
    const lateFail = await notify(apple.api, apple.signer.notification({
      notificationType: 'DID_FAIL_TO_RENEW', signedDate: signedDate - 1000, signedTransactionInfo: tx,
      signedRenewalInfo: apple.signer.renewalInfo({ originalTransactionId: original, productId: PRODUCT.BASIC, autoRenewStatus: 0, signedDate: signedDate - 1000 }),
    }));
    expect((await lateFail.json()).result).toContain('IGNORED_STALE_RENEWAL_INFO');
    expect(await appleState()).toEqual(expected);
    expect(await ledger(db, user.id)).toEqual(ledgerBefore);
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(0);
  });

  test('[NEG] an unprovable owner (no token, no link) is recorded as UNMATCHED and acknowledged; nothing is granted', async ({ apple, db }) => {
    const uuid = randomUUID();
    const r = await notify(apple.api, apple.signer.notification({ notificationType: 'SUBSCRIBED', notificationUUID: uuid, signedTransactionInfo: sub(apple.signer, { productId: PRODUCT.BASIC }) }));
    expect(r.status()).toBe(200);
    expect((await r.json()).result).toBe('UNMATCHED');
    expect((await db.query(`SELECT user_id, result FROM apple_notifications WHERE notification_uuid = $1`, [uuid])).rows).toEqual([{ user_id: null, result: 'UNMATCHED' }]);
  });

  test('[BR] TEST and other informational notifications are recorded only', async ({ apple }) => {
    const r = await notify(apple.api, apple.signer.notification({ notificationType: 'TEST' }));
    expect(r.status()).toBe(200);
    expect((await r.json()).result).toBe('RECORDED');
  });
});
