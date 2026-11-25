/**
 * Operator CLI: npm run apple:test-notification
 * Asks Apple (SANDBOX ONLY) to send a TEST notification to the Sandbox URL configured in App Store Connect, waits for
 * Apple's send-attempt result, verifies the signed TEST payload, and checks (read-only) that MonetaLab recorded it.
 * Env: the APPLE_* verification variables (config.ts) + APPLE_API_KEY_ID, APPLE_API_ISSUER_ID, APPLE_API_PRIVATE_KEY_PATH.
 * Exit code 0 only for DELIVERED_AND_RECORDED. Prints no JWS, token, key or credential.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { AppStoreServerAPIClient, Environment } from '@apple/app-store-server-library';
import { databaseUrl } from '../../config.ts';
import { appleVerifierFromEnv } from './config.ts';
import { runTestNotificationCheck } from './test-notification.ts';

async function main() {
  const verifier = appleVerifierFromEnv(process.env);
  if (verifier.environment !== 'Sandbox') throw new Error(`Refusing: APPLE_ENVIRONMENT is ${verifier.environment}; this check runs against Sandbox only`);
  const { APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER_ID: issuerId, APPLE_API_PRIVATE_KEY_PATH: keyPath } = process.env;
  if (!keyId || !issuerId || !keyPath) throw new Error('APPLE_API_KEY_ID, APPLE_API_ISSUER_ID and APPLE_API_PRIVATE_KEY_PATH are required');
  const client = new AppStoreServerAPIClient(readFileSync(keyPath, 'utf8'), keyId, issuerId, verifier.bundleId, Environment.SANDBOX);
  const db = new pg.Client({ connectionString: databaseUrl() });
  await db.connect();
  await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  try {
    const report = await runTestNotificationCheck({
      api: client,
      verifier,
      findRecorded: async (uuid) => (await db.query<{ result: string }>('SELECT result FROM apple_notifications WHERE notification_uuid = $1', [uuid])).rows[0] ?? null,
      timeoutMs: Number(process.env.APPLE_TEST_NOTIFICATION_TIMEOUT_MS ?? 60_000),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.verdict === 'DELIVERED_AND_RECORDED' ? 0 : 2;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  const e = error as { httpStatusCode?: number; apiError?: number; errorMessage?: string; message?: string };
  console.error(e.httpStatusCode ? `App Store Server API error: HTTP ${e.httpStatusCode} apiError=${e.apiError ?? '-'} ${e.errorMessage ?? ''}` : e.message);
  process.exit(1);
});
