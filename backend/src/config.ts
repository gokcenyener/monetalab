// Local-only default that matches docker-compose.yml. It is not a secret; override it with DATABASE_URL.
const LOCAL_DEFAULT_DATABASE_URL = 'postgres://monetalab:monetalab_local_only@127.0.0.1:55432/monetalab';

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? LOCAL_DEFAULT_DATABASE_URL;
}

const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];

/**
 * Address the API binds to. Default: loopback only (Simulator, tests, CI).
 * API_HOST=:: (IPv4+IPv6, needed for a .local name), 0.0.0.0 or a specific LAN IP is an opt-in for a physical iPhone on the same Wi-Fi during development.
 * It is refused with NODE_ENV=production: a public deployment needs HTTPS and rate limiting first (D-S3-09).
 */
export function apiHost(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.API_HOST;
  if (value === undefined || value === '') return '127.0.0.1';
  const ipv4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  if (!ipv4.test(value) && !LOOPBACK_HOSTS.includes(value) && value !== '::') {
    throw new Error(`Invalid API_HOST "${value}": expected an IPv4 address, "::" or "::1"`);
  }
  if (!LOOPBACK_HOSTS.includes(value) && env.NODE_ENV === 'production') {
    throw new Error('Refusing a non-loopback API_HOST with NODE_ENV=production');
  }
  return value;
}
