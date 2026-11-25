import { expect, test } from './support/fixtures.ts';

// Categories (D-005): [INT] integration, [NEG] negative/edge case.

test.describe('GET /health (API smoke)', () => {
  test('[INT] returns 200 { status: ok, database: ok }', async ({ api }) => {
    const response = await api.get('/health');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(await response.json()).toEqual({ status: 'ok', database: 'ok' });
  });

  test('[INT] the response comes from the harness-owned server on the disposable database', async ({ api, harness, db }) => {
    const response = await api.get('/health');
    expect(response.status()).toBe(200);

    // 1. The request went to the port the harness read from its own child's stdout.
    const url = new URL(response.url());
    expect(url.hostname).toBe('127.0.0.1');
    expect(Number(url.port)).toBe(harness.port);

    // 2. That child is alive. (Signal 0 only checks existence and permission; it doesn't signal the process.)
    expect(() => process.kill(harness.pid, 0)).not.toThrow();

    // 3. A server connection with the harness's unique application_name exists on *this* disposable DB,
    //    so the answering server is the one the harness started with this database.
    const { rows } = await db.query<{ db: string; connections: number }>(
      `SELECT current_database() AS db,
              (SELECT count(*)::int FROM pg_stat_activity
                WHERE datname = current_database() AND application_name = $1) AS connections`,
      [harness.serverAppName],
    );
    expect(rows[0]!.db).toBe(harness.dbName);
    expect(rows[0]!.db).toMatch(/^monetalab_api_test_[0-9a-f]{12}$/);
    expect(rows[0]!.connections).toBeGreaterThan(0);
  });

  test('[INT] the disposable database has the real migrations applied', async ({ db }) => {
    const { rows } = await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(rows.map((r) => r.version)).toEqual(['001_m1_foundation.sql', '002_m1_credit_integrity.sql', '003_m2_subscriptions_rewards.sql', '004_m3_apple_storekit.sql', '005_m3_apple_subscription_status.sql', '006_m3_apple_scheduled_renewals.sql']);
  });

  test('[NEG] an unknown route returns 404 and does not expose server details', async ({ api }) => {
    const response = await api.get('/definitely-not-a-route');
    expect(response.status()).toBe(404);
    expect(response.headers()['x-powered-by']).toBeUndefined();
  });
});
