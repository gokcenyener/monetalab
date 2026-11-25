/**
 * Notification gateway (src/notifications-app.ts): the only app meant to be reachable over a public HTTPS tunnel.
 * In-process (Fastify inject) against a disposable database, Apple's real verification code with a per-run test CA
 * (MOCK-SIGNED FIXTURES, not Apple delivery). Categories (D-005): [BR], [INT], [NEG].
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { AppleVerifier } from '../../src/billing/apple/verifier.ts';
import { AppStoreSignedDataVerifier } from '../../src/billing/apple/verifier.ts';
import type { Clock } from '../../src/clock.ts';
import { buildNotificationsApp } from '../../src/notifications-app.ts';
import { AppleTestSigner, newTransactionId, PRODUCT, TEST_BUNDLE_ID } from '../support/apple-signing.ts';
import { createMigratedDatabase, insertUser, type TestDb } from './helpers/test-db.ts';

const DAY = 24 * 3600 * 1000;
let db: TestDb;
const signer = AppleTestSigner.create();
const verifier = new AppStoreSignedDataVerifier({ environment: 'Sandbox', bundleId: TEST_BUNDLE_ID, rootCertificates: [signer.root], onlineChecks: false });
const clock: Clock = { now: () => new Date() };
const lines: string[] = [];
let app: ReturnType<typeof buildNotificationsApp>;

before(async () => {
  db = await createMigratedDatabase();
  app = buildNotificationsApp({ pool: db.pool, verifier, clock, log: (l) => lines.push(l), rateLimit: { windowMs: 60_000, perKey: 1000, global: 10_000 } });
  await app.ready();
});
after(async () => {
  await app?.close();
  await db?.drop();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/apple/notifications', payload: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
const rows = async (uuid: string) => Number((await db.pool.query<{ n: string }>('SELECT count(*) AS n FROM apple_notifications WHERE notification_uuid = $1', [uuid])).rows[0]!.n);
const errorOf = (r: { json: () => unknown }) => r.json() as { error: { code: string; message: string } };

describe('notification gateway: surface', () => {
  it('[NEG] serves ONLY POST /apple/notifications: health, auth, wallet, operations, billing and GET are 404', async () => {
    const routes = app.printRoutes({ commonPrefix: false });
    assert.match(routes, /\/apple\/notifications \(POST\)/);
    for (const [method, url] of [['GET', '/health'], ['POST', '/auth/login'], ['GET', '/wallet'], ['POST', '/operations'], ['GET', '/billing/config'],
      ['POST', '/billing/apple/transactions'], ['GET', '/subscriptions/current'], ['GET', '/apple/notifications'], ['GET', '/']] as const) {
      const r = await app.inject({ method, url });
      assert.equal(r.statusCode, 404, `${method} ${url}`);
      assert.deepEqual(errorOf(r).error.code, 'NOT_FOUND');
    }
  });
  it('[NEG] refuses to run with the Xcode verifier (Apple never sends Xcode notifications)', () => {
    assert.throws(() => buildNotificationsApp({ pool: db.pool, verifier: { environment: 'Xcode' } as AppleVerifier }), /not Xcode/);
  });
  it('[BR] request log lines carry method, path, status and duration only: no body, header or JWS', async () => {
    const jws = signer.notification({ notificationType: 'TEST' });
    await post({ signedPayload: jws }, { authorization: 'Bearer secret-token' });
    const last = lines.at(-1)!;
    assert.match(last, /^\S+ POST \/apple\/notifications 200 \d+ms$/);
    assert.ok(!lines.some((l) => l.includes('eyJ') || l.includes('secret-token')));
  });
});

describe('notification gateway: only verified Apple Sandbox notifications are accepted', () => {
  it('[BR] a verified TEST notification is recorded once; a replay of the same notification is acknowledged as DUPLICATE', async () => {
    const uuid = randomUUID();
    const jws = signer.notification({ notificationType: 'TEST', notificationUUID: uuid });
    const first = await post({ signedPayload: jws });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), { notificationUUID: uuid, result: 'RECORDED', duplicate: false });
    const replay = await post({ signedPayload: jws });
    assert.deepEqual(replay.json(), { notificationUUID: uuid, result: 'DUPLICATE', duplicate: true });
    assert.equal(await rows(uuid), 1);
  });

  it('[NEG] invalid signature, untrusted chain, tampered payload, unsigned: 400, nothing recorded, no internals in the error', async () => {
    const uuid = randomUUID();
    const good = signer.notification({ notificationType: 'TEST', notificationUUID: uuid });
    const [h, p] = good.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), notificationType: 'REFUND' })).toString('base64url');
    const cases = {
      wrongSignature: `${h}.${p}.${Buffer.alloc(64, 7).toString('base64url')}`,
      untrustedChain: AppleTestSigner.create({ name: 'Forger' }).notification({ notificationType: 'TEST', notificationUUID: uuid }),
      tampered: `${h}.${tamperedPayload}.${good.split('.')[2]}`,
      unsigned: `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.${Buffer.from('x').toString('base64url')}`,
    };
    for (const [name, jws] of Object.entries(cases)) {
      const r = await post({ signedPayload: jws });
      assert.equal(r.statusCode, 400, name);
      const body = errorOf(r);
      assert.match(body.error.code, /^APPLE_/, name);
      assert.doesNotMatch(JSON.stringify(body), /stack|at \/|node_modules|SELECT|eyJ/, `${name}: safe error`);
    }
    assert.equal(await rows(uuid), 0);
  });

  it('[NEG] wrong environment (Production), wrong bundle and a non-V2 version are rejected before any database write', async () => {
    for (const p of [{ environment: 'Production' }, { bundleId: 'com.example.other' }, { version: '1.0' }]) {
      const uuid = randomUUID();
      const r = await post({ signedPayload: signer.notification({ notificationType: 'TEST', notificationUUID: uuid, ...p }) });
      assert.equal(r.statusCode, 400, JSON.stringify(p));
      assert.equal(await rows(uuid), 0);
    }
  });

  it('[NEG] a valid outer notification wrapping a forged nested transaction changes nothing', async () => {
    const userId = await insertUser(db.pool);
    const token = (await db.pool.query('SELECT app_account_token AS t FROM users WHERE id = $1', [userId])).rows[0].t;
    const forgedTx = AppleTestSigner.create({ name: 'Forger' }).transaction({ productId: PRODUCT.ULTRA, appAccountToken: token, purchaseDate: Date.now() - 60_000, expiresDate: Date.now() + 6 * DAY });
    const uuid = randomUUID();
    const r = await post({ signedPayload: signer.notification({ notificationType: 'SUBSCRIBED', notificationUUID: uuid, signedTransactionInfo: forgedTx }) });
    assert.equal(r.statusCode, 400);
    assert.equal(await rows(uuid), 0);
    assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = $1', [userId])).rows[0].n, 0);
  });

  it('[NEG] future-dated and too-old (replayed) notifications are refused after verification; nothing recorded', async () => {
    const future = randomUUID();
    const r1 = await post({ signedPayload: signer.notification({ notificationType: 'TEST', notificationUUID: future, signedDate: Date.now() + 10 * 60_000 }) });
    assert.equal(r1.statusCode, 400);
    assert.equal(errorOf(r1).error.code, 'APPLE_NOTIFICATION_FROM_FUTURE');
    const old = randomUUID();
    const r2 = await post({ signedPayload: signer.notification({ notificationType: 'TEST', notificationUUID: old, signedDate: Date.now() - 8 * DAY }) });
    assert.equal(r2.statusCode, 400);
    assert.equal(errorOf(r2).error.code, 'APPLE_NOTIFICATION_TOO_OLD');
    assert.equal(await rows(future) + await rows(old), 0);
    // Apple's retry window (up to 3 days) is still accepted.
    const retried = await post({ signedPayload: signer.notification({ notificationType: 'TEST', signedDate: Date.now() - 3 * DAY }) });
    assert.equal(retried.statusCode, 200);
  });

  it('[NEG] malformed requests: invalid JSON, wrong content type, missing/extra fields, non-JWS, empty body', async () => {
    const expectations: Array<[string, Promise<{ statusCode: number; json: () => unknown }>, number, string]> = [
      ['invalid JSON', post('{"signedPayload":'), 400, 'VALIDATION_ERROR'],
      ['empty body', post(''), 400, 'VALIDATION_ERROR'],
      ['missing field', post({}), 400, 'VALIDATION_ERROR'],
      ['extra field', post({ signedPayload: signer.notification({ notificationType: 'TEST' }), admin: true }), 400, 'VALIDATION_ERROR'],
      ['not a JWS', post({ signedPayload: 'definitely not a compact jws string' }), 400, 'VALIDATION_ERROR'],
      ['number', post({ signedPayload: 12345 }), 400, 'VALIDATION_ERROR'],
      ['form content type', app.inject({ method: 'POST', url: '/apple/notifications', payload: 'signedPayload=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } }), 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ];
    for (const [name, request, status, code] of expectations) {
      const r = await request;
      assert.equal(r.statusCode, status, name);
      assert.equal(errorOf(r).error.code, code, name);
    }
  });

  it('[NEG] oversized requests are rejected with 413 before parsing (64 KB cap)', async () => {
    const r = await post({ signedPayload: `${'a'.repeat(30_000)}.${'b'.repeat(40_000)}.c` });
    assert.equal(r.statusCode, 413);
    assert.equal(errorOf(r).error.code, 'PAYLOAD_TOO_LARGE');
  });
});

describe('notification gateway: billing state through the shared, idempotent path', () => {
  it('[BR][INT] SUBSCRIBED for a linked account grants once; duplicate delivery and an older out-of-order DID_RENEW change nothing', async () => {
    const userId = await insertUser(db.pool);
    const token = (await db.pool.query('SELECT app_account_token AS t FROM users WHERE id = $1', [userId])).rows[0].t;
    const original = newTransactionId();
    const tx = signer.transaction({ productId: PRODUCT.BASIC, transactionId: original, purchaseDate: Date.now() - 60_000, expiresDate: Date.now() + 7 * DAY, appAccountToken: token });
    const n = signer.notification({ notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY', signedTransactionInfo: tx });
    const first = await post({ signedPayload: n });
    assert.equal(first.json().result, 'SUBSCRIPTION_STARTED');
    assert.equal((await post({ signedPayload: n })).json().result, 'DUPLICATE');
    const late = await post({ signedPayload: signer.notification({ notificationType: 'DID_RENEW', signedDate: Date.now() - DAY, signedTransactionInfo: tx }) });
    assert.equal(late.statusCode, 200);
    const ledger = await db.pool.query(`SELECT entry_type, delta FROM credit_ledger WHERE user_id = $1 ORDER BY id`, [userId]);
    assert.deepEqual(ledger.rows, [{ entry_type: 'SUBSCRIPTION_GRANT', delta: 3000 }]);
    const s = (await db.pool.query(`SELECT status, apple_status FROM subscriptions WHERE user_id = $1`, [userId])).rows[0];
    assert.deepEqual(s, { status: 'ACTIVE', apple_status: 'ACTIVE' });
  });
});

describe('notification gateway: rate limiting', () => {
  it('[NEG] over the per-client limit: 429 with Retry-After; another client (X-Forwarded-For from the local tunnel) is not affected', async () => {
    const limited = buildNotificationsApp({ pool: db.pool, verifier, clock, rateLimit: { windowMs: 60_000, perKey: 2, global: 100 } });
    try {
      const send = (ip: string) => limited.inject({ method: 'POST', url: '/apple/notifications', payload: { signedPayload: signer.notification({ notificationType: 'TEST' }) }, headers: { 'x-forwarded-for': ip } });
      assert.deepEqual([(await send('203.0.113.1')).statusCode, (await send('203.0.113.1')).statusCode], [200, 200]);
      const third = await send('203.0.113.1');
      assert.equal(third.statusCode, 429);
      assert.equal((third.json() as { error: { code: string } }).error.code, 'RATE_LIMITED');
      assert.ok(Number(third.headers['retry-after']) > 0);
      assert.equal((await send('203.0.113.2')).statusCode, 200);
    } finally {
      await limited.close();
    }
  });
  it('[NEG] the global cap protects the database from many source addresses', async () => {
    const limited = buildNotificationsApp({ pool: db.pool, verifier, clock, rateLimit: { windowMs: 60_000, perKey: 100, global: 3 } });
    try {
      const codes = [];
      for (let i = 0; i < 4; i++) {
        codes.push((await limited.inject({ method: 'POST', url: '/apple/notifications', payload: { signedPayload: 'x.y.z-not-verified-anyway' }, headers: { 'x-forwarded-for': `198.51.100.${i}` } })).statusCode);
      }
      assert.deepEqual(codes, [400, 400, 400, 429], 'rate limiting runs before parsing or verification');
    } finally {
      await limited.close();
    }
  });
});
