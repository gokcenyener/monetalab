/**
 * Notification gateway process (M3). Usage:
 *   APPLE_ENVIRONMENT=Sandbox APPLE_BUNDLE_ID=... APPLE_ROOT_CERTIFICATES=... npm run notifications:start
 * Binds to 127.0.0.1 only (NOTIFICATIONS_PORT, default 3100). Expose it over HTTPS with a tunnel that points at this
 * port only; the main API (port 3000) stays private. Refuses APPLE_ENVIRONMENT=Xcode.
 */
import pg from 'pg';
import { appleVerifierFromEnv } from './billing/apple/config.ts';
import type { AppleVerifier } from './billing/apple/verifier.ts';
import { systemClock } from './clock.ts';
import { databaseUrl } from './config.ts';
import { buildNotificationsApp } from './notifications-app.ts';
import { startScheduledRenewalSweeper } from './billing/apple/service.ts';

const HOST = '127.0.0.1';

let port: number;
let verifier: AppleVerifier;
try {
  const raw = process.env.NOTIFICATIONS_PORT ?? '3100';
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65_535) throw new Error(`Invalid NOTIFICATIONS_PORT "${raw}"`);
  port = Number(raw);
  verifier = appleVerifierFromEnv(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl() });
let app: ReturnType<typeof buildNotificationsApp>;
try {
  app = buildNotificationsApp({ pool, verifier, clock: systemClock, log: (line) => console.log(line) });
  await app.listen({ host: HOST, port });
} catch (error) {
  console.error(`Failed to start the notification gateway: ${(error as Error).message}`);
  await pool.end().catch(() => {});
  process.exit(1);
}
const address = app.server.address();
const boundPort = typeof address === 'object' && address !== null ? address.port : port;
console.log(`MonetaLab notification gateway (${verifier.environment}, ${verifier.bundleId}) listening on http://${HOST}:${boundPort}/apple/notifications (pid ${process.pid})`);

// F-M3-04: renewals this gateway scheduled are applied when their period starts, even if the main API is not running.
const stopSweeper = startScheduledRenewalSweeper(pool, systemClock, { intervalMs: 15_000, log: (line) => console.log(line) });

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  stopSweeper();
  await app.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
