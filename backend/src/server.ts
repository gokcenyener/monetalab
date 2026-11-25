import pg from 'pg';
import { buildApp, type Exposure } from './app.ts';
import { adProviderFromEnv, type AdProvider } from './ads/provider.ts';
import { billingProviderFromEnv, type BillingProvider } from './billing/provider.ts';
import { clockFromEnv, type Clock } from './clock.ts';
import { apiHost, databaseUrl } from './config.ts';
import { startScheduledRenewalSweeper } from './billing/apple/service.ts';

const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** PORT=0 asks the OS for a free ephemeral port (used by the API test harness). */
function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65_535) {
    throw new Error(`Invalid PORT "${value}": expected an integer from 0 to 65535`);
  }
  return Number(value);
}

let host: string;
let exposure: Exposure;
let port: number;
let billing: BillingProvider;
let ads: AdProvider;
let clock: Clock;
try {
  host = apiHost(); // loopback unless API_HOST opts in (development on a physical iPhone)
  // API_EXPOSURE=tunnel: reachable from the internet only through a local HTTPS tunnel (TestFlight QA, D-051).
  const rawExposure = process.env.API_EXPOSURE ?? 'local';
  if (rawExposure !== 'local' && rawExposure !== 'tunnel') throw new Error(`Invalid API_EXPOSURE "${rawExposure}": use local or tunnel`);
  exposure = rawExposure;
  if (exposure === 'tunnel' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error('API_EXPOSURE=tunnel requires a loopback API_HOST: only the local tunnel may connect');
  }
  port = parsePort(process.env.PORT);
  billing = billingProviderFromEnv(); // refuses the mock provider when NODE_ENV=production
  ads = adProviderFromEnv(); // same
  clock = clockFromEnv(); // a test clock file is refused when NODE_ENV=production
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl() });
let app: ReturnType<typeof buildApp>;
try {
  app = buildApp({ pool, billing, ads, clock, exposure }); // refuses tunnel exposure without Apple billing
} catch (error) {
  console.error((error as Error).message);
  await pool.end().catch(() => {});
  process.exit(1);
}

try {
  await app.listen({ host, port });
} catch (error) {
  // Never print DATABASE_URL: it contains credentials.
  console.error(`Failed to start MonetaLab API: ${(error as Error).message}`);
  await pool.end().catch(() => {});
  process.exit(1);
}

// Report the port actually bound (it differs from the requested one when PORT=0) and our PID.
// The API test harness parses this exact line from its own child's stdout.
const address = app.server.address();
const boundPort = typeof address === 'object' && address !== null ? address.port : port;
const shown = host.includes(':') ? `[${host}]` : host;
console.log(`MonetaLab API listening on http://${shown}:${boundPort} (pid ${process.pid})`);
if (exposure === 'tunnel') {
  console.log('Tunnel exposure: Apple billing only, no mock or ad routes, rate-limited; expose this port through the HTTPS tunnel only.');
} else if (host !== '127.0.0.1' && host !== '::1') {
  console.log(`Reachable from other devices on this network (development only: use a trusted Wi-Fi network; plain HTTP).`);
}

// F-M3-04: Apple renewals delivered before their period starts are applied when it starts, even if no request or
// notification arrives then (and at startup, so a restart recovers anything that became due while down).
const stopSweeper = billing.name === 'apple'
  ? startScheduledRenewalSweeper(pool, clock, { intervalMs: sweepIntervalMs(), log: (line) => console.log(line) })
  : () => {};

function sweepIntervalMs(): number {
  const raw = process.env.SCHEDULED_RENEWAL_SWEEP_MS ?? '15000';
  return /^\d{3,7}$/.test(raw) ? Number(raw) : 15_000;
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => {
    console.error(`Forced exit: graceful shutdown after ${signal} exceeded ${SHUTDOWN_TIMEOUT_MS} ms`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  try {
    stopSweeper();
    await app.close(); // stop accepting connections, finish in-flight requests
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error(`Shutdown error after ${signal}: ${(error as Error).message}`);
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
