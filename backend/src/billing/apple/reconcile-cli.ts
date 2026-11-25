/**
 * Operator CLI: reconcile one user's Apple purchases with the App Store Server API (D-044). Local/server shell only;
 * there is no HTTP route for this. Usage: npm run apple:reconcile -- --user <uuid>
 * Requires BILLING_PROVIDER=apple configuration (config.ts) and APPLE_API_KEY_ID, APPLE_API_ISSUER_ID,
 * APPLE_API_PRIVATE_KEY_PATH. The private key is read from disk at run time and never logged.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { AppStoreServerAPIClient, Environment, GetTransactionHistoryVersion, Order } from '@apple/app-store-server-library';
import { systemClock } from '../../clock.ts';
import { databaseUrl } from '../../config.ts';
import { appleVerifierFromEnv } from './config.ts';
import { reconcileUserWithAppStore, type AppStoreServerApi } from './reconcile.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const userId = arg('user');
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('usage: npm run apple:reconcile -- --user <uuid>');
  const verifier = appleVerifierFromEnv(process.env);
  if (verifier.environment === 'Xcode') throw new Error('The App Store Server API has no Xcode environment');
  const { APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER_ID: issuerId, APPLE_API_PRIVATE_KEY_PATH: keyPath } = process.env;
  if (!keyId || !issuerId || !keyPath) throw new Error('APPLE_API_KEY_ID, APPLE_API_ISSUER_ID and APPLE_API_PRIVATE_KEY_PATH are required');
  const client = new AppStoreServerAPIClient(readFileSync(keyPath, 'utf8'), keyId, issuerId, verifier.bundleId,
    verifier.environment === 'Production' ? Environment.PRODUCTION : Environment.SANDBOX);
  const api: AppStoreServerApi = {
    getTransactionHistory: (id, revision, request) =>
      client.getTransactionHistory(id, revision, { sort: request.sort === 'DESCENDING' ? Order.DESCENDING : Order.ASCENDING }, GetTransactionHistoryVersion.V2),
    getAllSubscriptionStatuses: (id) => client.getAllSubscriptionStatuses(id),
  };
  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    console.log(JSON.stringify(await reconcileUserWithAppStore(pool, { verifier, clock: systemClock, api }, userId), null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
