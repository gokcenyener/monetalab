/**
 * Playwright fixtures for HTTP API tests.
 * - `api`: request context bound to the harness-owned server (base URL from global setup).
 * - `harness`: identity of the owned server and disposable DB, for ownership assertions.
 * - `db`: a direct connection to the disposable test DB, for assertions only. Any future direct DB writes must
 *   be scoped to rows created by the same test (D-017b), and must never be unscoped UPDATE/DELETE/TRUNCATE.
 */
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { AppleTestSigner } from '../../support/apple-signing.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: global setup did not run or failed`);
  return value;
}

export type Harness = { baseUrl: string; pid: number; port: number; serverAppName: string; dbName: string };

/**
 * Controlled business clock of the second server (D-033). Only specs that run serially may use it, because the
 * clock is shared by everything that talks to that server.
 */
export type ControlledClock = { api: APIRequestContext; set: (iso: string) => void };

/** The Apple-mode server (BILLING_PROVIDER=apple, Sandbox) and the signer its trusted test root belongs to. */
export type AppleMode = { api: APIRequestContext; signer: AppleTestSigner };

export const test = base.extend<{ api: APIRequestContext; harness: Harness; clock: ControlledClock; apple: AppleMode }, { db: pg.Pool }>({
  apple: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({ baseURL: requireEnv('API_APPLE_BASE_URL') });
    await use({ api: context, signer: AppleTestSigner.load(requireEnv('API_APPLE_SIGNER_DIR')) });
    await context.dispose();
  },
  harness: async ({}, use) => {
    await use({
      baseUrl: requireEnv('API_BASE_URL'),
      pid: Number(requireEnv('API_SERVER_PID')),
      port: Number(requireEnv('API_SERVER_PORT')),
      serverAppName: requireEnv('API_SERVER_APP_NAME'),
      dbName: requireEnv('API_TEST_DB_NAME'),
    });
  },
  api: async ({ playwright, harness }, use) => {
    const context = await playwright.request.newContext({ baseURL: harness.baseUrl });
    await use(context);
    await context.dispose();
  },
  clock: async ({ playwright }, use) => {
    const file = requireEnv('API_CLOCK_FILE');
    const context = await playwright.request.newContext({ baseURL: requireEnv('API_CLOCK_BASE_URL') });
    await use({
      api: context,
      set: (iso: string) => {
        if (Number.isNaN(new Date(iso).getTime())) throw new Error(`invalid clock value ${iso}`);
        writeFileSync(file, iso);
      },
    });
    await context.dispose();
  },
  db: [
    async ({}, use) => {
      const pool = new pg.Pool({ connectionString: requireEnv('API_TEST_DATABASE_URL'), max: 4 });
      await use(pool);
      await pool.end();
    },
    { scope: 'worker' },
  ],
});

export { expect };
