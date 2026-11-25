/**
 * Playwright global setup for HTTP API tests.
 *
 * Lifecycle:
 *   1. Create a uniquely named disposable database (monetalab_api_test_<hex>).
 *   2. Apply the real migrations from backend/migrations.
 *   3. Start the real server (node src/server.ts) on an OS-assigned port and verify ownership (server-harness.ts).
 *   4. Publish connection details to the test workers through environment variables.
 *   4b. Start a SECOND owned server on the same database with a controlled business clock: MONETALAB_TEST_CLOCK_FILE
 *       points at a temp file that time-travel specs rewrite (D-033). No HTTP endpoint can change time.
 *   4c. Start a THIRD owned server on the same database with BILLING_PROVIDER=apple (Sandbox). It trusts only a
 *       throwaway test root generated for this run (tests/support/apple-signing.ts), whose keys live in a temp dir.
 *   5. Teardown (the returned function): stop all servers (SIGTERM, then SIGKILL after 5 s), drop the database,
 *      remove the clock file.
 * If any step fails, everything created so far is cleaned up before the error is re-thrown.
 * The developer `monetalab` database and Docker volumes are never modified.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseUrl } from '../../../src/config.ts';
import { migrate } from '../../../src/db/migrate.ts';
import { createDisposableDatabase, dropDisposableDatabase, urlForDatabase } from './disposable-db.ts';
import { startOwnedServer, type OwnedServer } from './server-harness.ts';
import { AppleTestSigner, TEST_BUNDLE_ID } from '../../support/apple-signing.ts';

const BACKEND_DIR = fileURLToPath(new URL('../../../', import.meta.url));

export default async function globalSetup(): Promise<() => Promise<void>> {
  let dbName: string | undefined;
  let server: OwnedServer | undefined;
  let clockServer: OwnedServer | undefined;
  let clockDir: string | undefined;
  let appleServer: OwnedServer | undefined;
  let appleDir: string | undefined;

  const teardown = async () => {
    const problems: string[] = [];
    for (const owned of [server, clockServer, appleServer]) {
      if (!owned) continue;
      const result = await owned.stop();
      if (result.forced) problems.push(`server pid ${owned.pid} ignored SIGTERM and was killed`);
    }
    server = undefined;
    clockServer = undefined;
    appleServer = undefined;
    if (appleDir) {
      rmSync(appleDir, { recursive: true, force: true });
      appleDir = undefined;
    }
    if (clockDir) {
      rmSync(clockDir, { recursive: true, force: true });
      clockDir = undefined;
    }
    if (dbName) {
      try {
        await dropDisposableDatabase(dbName);
      } catch (error) {
        problems.push(`could not drop ${dbName}: ${(error as Error).message}`);
      }
      dbName = undefined;
    }
    if (problems.length) console.warn(`[api-test teardown] ${problems.join('; ')}`);
  };

  try {
    dbName = await createDisposableDatabase();
    await migrate(urlForDatabase(databaseUrl(), dbName));

    // A unique application_name lets tests prove (via pg_stat_activity) that the server answering them
    // is connected to *this* disposable database.
    const serverAppName = `monetalab_api_server_${randomBytes(6).toString('hex')}`;
    server = await startOwnedServer({
      cwd: BACKEND_DIR,
      env: { ...process.env, DATABASE_URL: urlForDatabase(databaseUrl(), dbName, serverAppName) },
    });

    process.env.API_BASE_URL = server.baseUrl;
    process.env.API_SERVER_PID = String(server.pid);
    process.env.API_SERVER_PORT = String(server.port);
    process.env.API_SERVER_APP_NAME = serverAppName;
    process.env.API_TEST_DB_NAME = dbName;
    process.env.API_TEST_DATABASE_URL = urlForDatabase(databaseUrl(), dbName, 'monetalab_api_test_client');

    clockDir = mkdtempSync(join(tmpdir(), 'monetalab-api-clock-'));
    const clockFile = join(clockDir, 'now');
    writeFileSync(clockFile, '2031-01-06T12:00:00.000Z');
    clockServer = await startOwnedServer({
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        DATABASE_URL: urlForDatabase(databaseUrl(), dbName, `${serverAppName}_clock`),
        MONETALAB_TEST_CLOCK_FILE: clockFile,
      },
    });
    process.env.API_CLOCK_BASE_URL = clockServer.baseUrl;
    process.env.API_CLOCK_FILE = clockFile;

    appleDir = mkdtempSync(join(tmpdir(), 'monetalab-api-apple-'));
    const files = AppleTestSigner.create({ name: `MonetaLab API Test ${randomBytes(3).toString('hex')}` }).save(appleDir);
    appleServer = await startOwnedServer({
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        DATABASE_URL: urlForDatabase(databaseUrl(), dbName, `${serverAppName}_apple`),
        BILLING_PROVIDER: 'apple',
        APPLE_ENVIRONMENT: 'Sandbox',
        APPLE_BUNDLE_ID: TEST_BUNDLE_ID,
        APPLE_ROOT_CERTIFICATES: files.rootPath,
        // The test chain has no OCSP responder; verification uses the signed date (library behaviour).
        APPLE_ONLINE_CHECKS: 'false',
      },
    });
    process.env.API_APPLE_BASE_URL = appleServer.baseUrl;
    process.env.API_APPLE_SIGNER_DIR = appleDir;
  } catch (error) {
    await teardown();
    throw error;
  }

  return teardown;
}
