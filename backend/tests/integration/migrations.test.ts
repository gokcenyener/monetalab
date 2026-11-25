import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.ts';
import { createEmptyDatabase } from './helpers/test-db.ts';

// Categories (D-005): [INT] integration, [NEG] negative/edge case.

// Every migration file in backend/migrations, in the order they must apply. Update when adding a migration.
const ALL_MIGRATIONS = ['001_m1_foundation.sql', '002_m1_credit_integrity.sql', '003_m2_subscriptions_rewards.sql', '004_m3_apple_storekit.sql', '005_m3_apple_subscription_status.sql', '006_m3_apple_scheduled_renewals.sql'];

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

async function freshEmptyDb() {
  const db = await createEmptyDatabase();
  cleanups.push(db.drop);
  return db;
}

async function query<T extends pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

describe('migration runner', () => {
  it('[INT] fresh database: applies all migrations in order and creates exactly the expected M1 + M2 + M3 tables', async () => {
    const db = await freshEmptyDb();
    assert.deepEqual(await migrate(db.url), ALL_MIGRATIONS);

    const tables = await query<{ table_name: string }>(
      db.url,
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.map((t) => t.table_name),
      ['ad_rewards', 'analytics_events', 'apple_account_links', 'apple_notifications', 'apple_revocations', 'apple_scheduled_renewals', 'apple_transactions', 'bucket_balances', 'credit_ledger', 'credit_packages', 'operations', 'purchases',
        'schema_migrations', 'sessions', 'subscription_events', 'subscription_intro_offers', 'subscription_periods',
        'subscription_plans', 'subscription_revocations', 'subscriptions', 'trial_redemptions', 'users'],
    );

    const buckets = await query<{ b: string }>(db.url, `SELECT unnest(enum_range(NULL::credit_bucket))::text AS b`);
    assert.deepEqual(
      buckets.map((r) => r.b),
      ['SUBSCRIPTION', 'CONSUMABLE', 'REWARD', 'PROMOTIONAL'],
      'credit_bucket enum must contain exactly the four PRD buckets',
    );
  });

  it('[INT] re-running is a no-op and records each migration once', async () => {
    const db = await freshEmptyDb();
    await migrate(db.url);
    assert.deepEqual(await migrate(db.url), [], 'second run must apply nothing');
    const rows = await query<{ version: string }>(db.url, 'SELECT version FROM schema_migrations');
    assert.deepEqual(rows.map((r) => r.version).sort(), ALL_MIGRATIONS);
  });

  it('[NEG] concurrent runners on an empty database apply each migration exactly once', async () => {
    const db = await freshEmptyDb();
    const results = await Promise.all([migrate(db.url), migrate(db.url), migrate(db.url)]);
    const appliedCounts = results.map((r) => r.length).sort();
    assert.deepEqual(appliedCounts, [0, 0, ALL_MIGRATIONS.length], `expected exactly one runner to apply, got ${JSON.stringify(results)}`);
  });

  it('[NEG] refuses to run when an applied migration was modified (checksum mismatch)', async () => {
    const db = await freshEmptyDb();
    await migrate(db.url);
    await query(db.url, `UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '001_m1_foundation.sql'`);
    await assert.rejects(migrate(db.url), /modified after being applied/);
  });

  it('[NEG] a failing migration is rolled back completely and not recorded', async () => {
    const db = await freshEmptyDb();
    const dir = await mkdtemp(join(tmpdir(), 'monetalab-migrations-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, '001_ok.sql'), 'CREATE TABLE t_ok (id int);');
    await writeFile(join(dir, '002_bad.sql'), 'CREATE TABLE t_bad (id int); SELECT * FROM table_that_does_not_exist;');

    await assert.rejects(migrate(db.url, dir), /002_bad\.sql failed and was rolled back/);

    const versions = await query<{ version: string }>(db.url, 'SELECT version FROM schema_migrations');
    assert.deepEqual(versions.map((r) => r.version), ['001_ok.sql']);
    const tables = await query<{ t: string | null }>(db.url, `SELECT to_regclass('t_ok')::text AS t UNION ALL SELECT to_regclass('t_bad')::text`);
    assert.deepEqual(tables.map((r) => r.t), ['t_ok', null], 't_bad must not survive the rolled-back migration');
  });
});
