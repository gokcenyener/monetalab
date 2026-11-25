/**
 * API_EXPOSURE=tunnel (TestFlight QA, D-051): the profile for an API instance reachable from the internet through a
 * local HTTPS tunnel. In-process (inject) against a disposable database. Categories (D-005): [BR], [NEG].
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { buildApp } from '../../src/app.ts';
import { AppStoreSignedDataVerifier } from '../../src/billing/apple/verifier.ts';
import { AppleTestSigner, TEST_BUNDLE_ID } from '../support/apple-signing.ts';
import { createMigratedDatabase, type TestDb } from './helpers/test-db.ts';

let db: TestDb;
const signer = AppleTestSigner.create();
const verifier = new AppStoreSignedDataVerifier({ environment: 'Sandbox', bundleId: TEST_BUNDLE_ID, rootCertificates: [signer.root], onlineChecks: false });
const apple = { name: 'apple' as const, verifier };
before(async () => { db = await createMigratedDatabase(); });
after(async () => { await db?.drop(); });

const generous = { all: { windowMs: 60_000, perKey: 1000, global: 10_000 }, auth: { windowMs: 60_000, perKey: 1000, global: 10_000 } };

describe('API_EXPOSURE=tunnel', () => {
  it('[NEG] refuses to build with mock billing: mock purchases must never be reachable from outside', () => {
    assert.throws(() => buildApp({ pool: db.pool, exposure: 'tunnel' }), /requires BILLING_PROVIDER=apple/);
  });

  it('[NEG] route table: no mock purchase, subscription-mutation, ad-reward, seed, admin or time routes', async () => {
    const app = buildApp({ pool: db.pool, billing: apple, exposure: 'tunnel', rateLimit: generous });
    await app.ready();
    const routes = app.printRoutes({ commonPrefix: false }).split('\n').map((l) => l.replace(/^[\s│├└─]+/, '').trim()).filter(Boolean);
    await app.close();
    const text = routes.join('\n');
    for (const forbidden of ['mock', 'seed', 'grant', 'admin', 'clock', 'debug', 'fixture', '/ads/rewards']) {
      assert.ok(!text.toLowerCase().includes(forbidden), `unexpected route containing "${forbidden}"`);
    }
    for (const mutation of [/^\/purchases .*POST/, /^\/subscriptions\/(purchase|change-plan|cancel|resume)/]) {
      assert.ok(!routes.some((r) => mutation.test(r)), `unexpected mock mutation route ${mutation}`);
    }
    for (const expected of ['/billing/apple/transactions', '/billing/apple/account', '/auth/login', '/wallet', '/operations', '/ads/quota', '/subscriptions/current']) {
      assert.ok(routes.some((r) => r.startsWith(expected)), `missing route ${expected}`);
    }
  });

  it('[BR] ads: the quota stays readable but nothing is ever eligible (ADS_UNAVAILABLE); POST /ads/rewards is 404', async () => {
    const app = buildApp({ pool: db.pool, billing: apple, exposure: 'tunnel', rateLimit: generous });
    try {
      const email = `tunnel-${randomUUID()}@test.invalid`;
      const password = 'correct horse battery staple';
      await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password } });
      const token = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } })).json().token;
      const quota = await app.inject({ method: 'GET', url: '/ads/quota?action=ADVANCED', headers: { authorization: `Bearer ${token}` } });
      assert.equal(quota.statusCode, 200);
      assert.deepEqual({ eligible: quota.json().eligibility.eligible, reason: quota.json().eligibility.reason }, { eligible: false, reason: 'ADS_UNAVAILABLE' });
      const reward = await app.inject({ method: 'POST', url: '/ads/rewards', headers: { authorization: `Bearer ${token}` }, payload: { adEventId: 'x1', action: 'ADVANCED', mockOutcome: 'COMPLETED' } });
      assert.equal(reward.statusCode, 404);
      assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM ad_rewards')).rows[0].n, 0);
    } finally {
      await app.close();
    }
  });

  it('[NEG] rate limits: /auth per client (X-Forwarded-For from the local tunnel), every route per client, global cap', async () => {
    const app = buildApp({
      pool: db.pool, billing: apple, exposure: 'tunnel',
      rateLimit: { all: { windowMs: 60_000, perKey: 5, global: 7 }, auth: { windowMs: 60_000, perKey: 2, global: 100 } },
    });
    try {
      const login = (ip: string) => app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'nobody@test.invalid', password: 'wrong password!' }, headers: { 'x-forwarded-for': ip } });
      assert.deepEqual([(await login('203.0.113.1')).statusCode, (await login('203.0.113.1')).statusCode], [401, 401]);
      const third = await login('203.0.113.1');
      assert.equal(third.statusCode, 429);
      assert.equal(third.json().error.code, 'RATE_LIMITED');
      assert.ok(Number(third.headers['retry-after']) > 0);
      assert.equal((await login('203.0.113.2')).statusCode, 401, 'another client has its own /auth budget');
      const health = (ip: string) => app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': ip } });
      assert.equal((await health('203.0.113.3')).statusCode, 200);
      assert.equal((await health('203.0.113.4')).statusCode, 200);
      assert.equal((await health('203.0.113.5')).statusCode, 200);
      assert.equal((await health('203.0.113.6')).statusCode, 429, 'global cap (7 requests per window: 4 logins + 3 health) across clients');
    } finally {
      await app.close();
    }
  });

  it('[NEG] X-Forwarded-For is trusted only from the loopback tunnel: a remote peer cannot spoof its rate-limit key', async () => {
    const app = buildApp({ pool: db.pool, billing: apple, exposure: 'tunnel', rateLimit: { all: { windowMs: 60_000, perKey: 1, global: 100 }, auth: generous.auth } });
    try {
      const fromRemote = (spoof: string) => app.inject({ method: 'GET', url: '/health', remoteAddress: '198.51.100.7', headers: { 'x-forwarded-for': spoof } });
      assert.equal((await fromRemote('10.0.0.1')).statusCode, 200);
      assert.equal((await fromRemote('10.0.0.2')).statusCode, 429, 'keyed by the real peer, not the spoofed header');
    } finally {
      await app.close();
    }
  });

  it('[BR] local exposure (default) is unchanged: no rate limit, ads available', async () => {
    const app = buildApp({ pool: db.pool, billing: apple });
    try {
      for (let i = 0; i < 30; i++) assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
      await app.ready();
      assert.match(app.printRoutes({ commonPrefix: false }), /\/ads\/rewards/);
    } finally {
      await app.close();
    }
  });
});
