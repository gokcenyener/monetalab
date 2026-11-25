/**
 * Apple verification configuration, from server-side environment variables only (D-038). No credential, key or
 * certificate is stored in the repository.
 *
 *   APPLE_ENVIRONMENT        Sandbox | Production | Xcode   (one environment per deployment; others are refused)
 *   APPLE_BUNDLE_ID          the app's bundle identifier, e.g. dev.monetalab.qa.MonetaLab
 *   APPLE_APP_APPLE_ID       numeric App Store app id; required for Production
 *   APPLE_ROOT_CERTIFICATES  comma-separated paths to trusted root certificates (DER or PEM), e.g. Apple Root CA - G3
 *                            downloaded from https://www.apple.com/certificateauthority/ (Sandbox/Production)
 *   APPLE_ONLINE_CHECKS      true (default) | false: OCSP revocation + current-date checks (Sandbox/Production)
 *   APPLE_XCODE_CERTIFICATE  path to the public certificate exported from Xcode (Xcode only; never in production)
 */
import { readFileSync } from 'node:fs';
import { APPLE_ENVIRONMENTS, AppStoreSignedDataVerifier, XcodePinnedVerifier, type AppleEnvironment, type AppleVerifier } from './verifier.ts';

function readCertificate(path: string): Buffer {
  const raw = readFileSync(path.trim());
  const text = raw.toString('latin1');
  if (text.includes('-----BEGIN CERTIFICATE-----')) {
    const b64 = text.split('-----BEGIN CERTIFICATE-----')[1]!.split('-----END CERTIFICATE-----')[0]!.replace(/\s+/g, '');
    return Buffer.from(b64, 'base64');
  }
  return raw;
}

export function appleVerifierFromEnv(env: NodeJS.ProcessEnv): AppleVerifier {
  const environment = env.APPLE_ENVIRONMENT as AppleEnvironment | undefined;
  if (!environment || !APPLE_ENVIRONMENTS.includes(environment)) {
    throw new Error('APPLE_ENVIRONMENT must be Sandbox, Production or Xcode');
  }
  const bundleId = env.APPLE_BUNDLE_ID;
  if (!bundleId || !/^[A-Za-z0-9.-]{3,155}$/.test(bundleId)) throw new Error('APPLE_BUNDLE_ID is required');

  if (environment === 'Xcode') {
    if (env.NODE_ENV === 'production') throw new Error('APPLE_ENVIRONMENT=Xcode must not be used with NODE_ENV=production');
    if (!env.APPLE_XCODE_CERTIFICATE) throw new Error('APPLE_XCODE_CERTIFICATE is required for APPLE_ENVIRONMENT=Xcode');
    return new XcodePinnedVerifier({ bundleId, certificate: readCertificate(env.APPLE_XCODE_CERTIFICATE) });
  }

  const roots = (env.APPLE_ROOT_CERTIFICATES ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (roots.length === 0) throw new Error('APPLE_ROOT_CERTIFICATES is required for Sandbox and Production');
  let appAppleId: number | undefined;
  if (env.APPLE_APP_APPLE_ID !== undefined) {
    if (!/^\d{1,15}$/.test(env.APPLE_APP_APPLE_ID)) throw new Error('APPLE_APP_APPLE_ID must be numeric');
    appAppleId = Number(env.APPLE_APP_APPLE_ID);
  }
  if (environment === 'Production' && appAppleId === undefined) throw new Error('APPLE_APP_APPLE_ID is required for Production');
  const online = env.APPLE_ONLINE_CHECKS ?? 'true';
  if (online !== 'true' && online !== 'false') throw new Error('APPLE_ONLINE_CHECKS must be true or false');
  return new AppStoreSignedDataVerifier({
    environment, bundleId, appAppleId, onlineChecks: online === 'true', rootCertificates: roots.map(readCertificate),
  });
}
