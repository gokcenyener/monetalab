/**
 * Verification of Apple-signed data (JWS, ES256 with an x5c certificate chain), D-038.
 *
 * Sandbox / Production: Apple's official App Store Server Library (SignedDataVerifier). It checks the x5c chain up to
 * a configured trusted root (Apple Root CA - G3 in a real deployment), the Apple-specific certificate extension OIDs,
 * certificate dates, the ES256 signature, and the bundle id / environment / appAppleId. With online checks enabled it
 * also checks OCSP revocation and uses the current date.
 *
 * Xcode (local StoreKit testing in Xcode): the library deliberately SKIPS signature verification for this
 * environment, so this module never relies on it. Instead the JWS must be signed by one pinned local certificate
 * (exported from Xcode with "Editor > Save Public Certificate"), checked here with Node's crypto. The Xcode mode is
 * refused with NODE_ENV=production.
 *
 * Nothing here ever trusts decoded-but-unverified JSON, a client "success" flag, or an `alg` from the token header.
 */
import { verify as cryptoVerify, X509Certificate } from 'node:crypto';
import {
  Environment, SignedDataVerifier, VerificationException, VerificationStatus,
  type JWSRenewalInfoDecodedPayload, type JWSTransactionDecodedPayload, type ResponseBodyV2DecodedPayload,
} from '@apple/app-store-server-library';

export type AppleEnvironment = 'Sandbox' | 'Production' | 'Xcode';
export const APPLE_ENVIRONMENTS: readonly AppleEnvironment[] = ['Sandbox', 'Production', 'Xcode'];

export type VerifiedTransaction = {
  environment: AppleEnvironment;
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  productType: 'SUBSCRIPTION' | 'CONSUMABLE';
  purchaseDate: Date;
  expiresDate: Date | null;
  appAccountToken: string | null;
  revocationDate: Date | null;
  revocationReason: number | null;
  isUpgraded: boolean;
  offerType: number | null;
  offerDiscountType: string | null;
  signedDate: Date;
  payload: Record<string, unknown>;
};

export type VerifiedRenewalInfo = {
  environment: AppleEnvironment;
  originalTransactionId: string;
  productId: string;
  autoRenewProductId: string | null;
  autoRenewStatus: boolean;
  isInBillingRetryPeriod: boolean;
  gracePeriodExpiresDate: Date | null;
  /** Apple expirationIntent (1..5), present once the subscription expired; null otherwise or when out of range. */
  expirationIntent: number | null;
  signedDate: Date;
  payload: Record<string, unknown>;
};

export type VerifiedNotification = {
  notificationUUID: string;
  notificationType: string;
  subtype: string | null;
  signedDate: Date;
  environment: AppleEnvironment;
  signedTransactionInfo: string | null;
  signedRenewalInfo: string | null;
  payload: Record<string, unknown>;
};

export type AppleVerificationCode =
  | 'APPLE_SIGNATURE_INVALID' | 'APPLE_ENVIRONMENT_MISMATCH' | 'APPLE_APP_MISMATCH' | 'APPLE_PAYLOAD_INVALID'
  | 'APPLE_VERIFICATION_UNAVAILABLE';

export class AppleVerificationError extends Error {
  readonly code: AppleVerificationCode;
  /** True when the failure may succeed later (e.g. OCSP unreachable). Callers must not finish/acknowledge then. */
  readonly retryable: boolean;
  constructor(code: AppleVerificationCode, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export interface AppleVerifier {
  readonly environment: AppleEnvironment;
  readonly bundleId: string;
  verifyTransaction(jws: string): Promise<VerifiedTransaction>;
  verifyRenewalInfo(jws: string): Promise<VerifiedRenewalInfo>;
  verifyNotification(jws: string): Promise<VerifiedNotification>;
}

const date = (ms: unknown): Date | null => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function requireString(v: unknown, field: string): string {
  const s = str(v);
  if (!s || s.length > 200) throw new AppleVerificationError('APPLE_PAYLOAD_INVALID', `Signed data has no valid ${field}`);
  return s;
}
function requireDate(v: unknown, field: string): Date {
  const d = date(v);
  if (!d) throw new AppleVerificationError('APPLE_PAYLOAD_INVALID', `Signed data has no valid ${field}`);
  return d;
}

/** Normalizes a VERIFIED transaction payload and rejects shapes MonetaLab has no rule for. */
export function toVerifiedTransaction(p: JWSTransactionDecodedPayload, environment: AppleEnvironment): VerifiedTransaction {
  const type = p.type === 'Auto-Renewable Subscription' ? 'SUBSCRIPTION' : p.type === 'Consumable' ? 'CONSUMABLE' : null;
  if (!type) throw new AppleVerificationError('APPLE_PAYLOAD_INVALID', 'Unsupported product type');
  // One unit per transaction: MonetaLab never requests a quantity, and granting for quantity > 1 has no approved rule.
  if (type === 'CONSUMABLE' && p.quantity !== 1) throw new AppleVerificationError('APPLE_PAYLOAD_INVALID', 'Unsupported purchase quantity');
  // Family Sharing is not enabled for any MonetaLab product and has no approved credit rule.
  if (p.inAppOwnershipType !== undefined && p.inAppOwnershipType !== 'PURCHASED') {
    throw new AppleVerificationError('APPLE_PAYLOAD_INVALID', 'Unsupported ownership type');
  }
  const expiresDate = date(p.expiresDate);
  const purchaseDate = requireDate(p.purchaseDate, 'purchaseDate');
  if (type === 'SUBSCRIPTION' && (!expiresDate || expiresDate <= purchaseDate)) {
    throw new AppleVerificationError('APPLE_PAYLOAD_INVALID', 'A subscription transaction needs an expiry after its purchase date');
  }
  const token = str(p.appAccountToken);
  return {
    environment,
    transactionId: requireString(p.transactionId, 'transactionId'),
    originalTransactionId: requireString(p.originalTransactionId, 'originalTransactionId'),
    productId: requireString(p.productId, 'productId'),
    productType: type,
    purchaseDate,
    expiresDate,
    appAccountToken: token ? token.toLowerCase() : null,
    revocationDate: date(p.revocationDate),
    revocationReason: typeof p.revocationReason === 'number' ? p.revocationReason : null,
    isUpgraded: p.isUpgraded === true,
    offerType: typeof p.offerType === 'number' ? p.offerType : null,
    offerDiscountType: str(p.offerDiscountType),
    signedDate: requireDate(p.signedDate, 'signedDate'),
    payload: p as Record<string, unknown>,
  };
}

export function toVerifiedRenewalInfo(p: JWSRenewalInfoDecodedPayload, environment: AppleEnvironment): VerifiedRenewalInfo {
  return {
    environment,
    originalTransactionId: requireString(p.originalTransactionId, 'originalTransactionId'),
    productId: requireString(p.productId, 'productId'),
    autoRenewProductId: str(p.autoRenewProductId),
    autoRenewStatus: p.autoRenewStatus === 1,
    isInBillingRetryPeriod: p.isInBillingRetryPeriod === true,
    gracePeriodExpiresDate: date(p.gracePeriodExpiresDate),
    expirationIntent: Number.isInteger(p.expirationIntent) && Number(p.expirationIntent) >= 1 && Number(p.expirationIntent) <= 5 ? Number(p.expirationIntent) : null,
    signedDate: requireDate(p.signedDate, 'signedDate'),
    payload: p as Record<string, unknown>,
  };
}

function toVerifiedNotification(p: ResponseBodyV2DecodedPayload, environment: AppleEnvironment): VerifiedNotification {
  const uuid = requireString(p.notificationUUID, 'notificationUUID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new AppleVerificationError('APPLE_PAYLOAD_INVALID', 'notificationUUID is not a UUID');
  }
  if (p.version !== '2.0') throw new AppleVerificationError('APPLE_PAYLOAD_INVALID', 'Only App Store Server Notifications V2 are accepted');
  return {
    notificationUUID: uuid.toLowerCase(),
    notificationType: requireString(p.notificationType, 'notificationType'),
    subtype: str(p.subtype),
    signedDate: requireDate(p.signedDate, 'signedDate'),
    environment,
    signedTransactionInfo: str(p.data?.signedTransactionInfo),
    signedRenewalInfo: str(p.data?.signedRenewalInfo),
    payload: p as Record<string, unknown>,
  };
}

function mapLibraryError(error: unknown): never {
  if (error instanceof AppleVerificationError) throw error;
  if (error instanceof VerificationException) {
    switch (error.status) {
      case VerificationStatus.INVALID_ENVIRONMENT:
        throw new AppleVerificationError('APPLE_ENVIRONMENT_MISMATCH', 'Signed data is from a different App Store environment');
      case VerificationStatus.INVALID_APP_IDENTIFIER:
        throw new AppleVerificationError('APPLE_APP_MISMATCH', 'Signed data is for a different app');
      case VerificationStatus.RETRYABLE_VERIFICATION_FAILURE:
        throw new AppleVerificationError('APPLE_VERIFICATION_UNAVAILABLE', 'Apple certificate status could not be checked; retry later', true);
      case VerificationStatus.FAILURE:
        throw new AppleVerificationError('APPLE_PAYLOAD_INVALID', 'Signed data is malformed');
      default:
        throw new AppleVerificationError('APPLE_SIGNATURE_INVALID', 'Signed data could not be verified');
    }
  }
  throw new AppleVerificationError('APPLE_SIGNATURE_INVALID', 'Signed data could not be verified');
}

/** Sandbox / Production verifier backed by Apple's official library. */
export class AppStoreSignedDataVerifier implements AppleVerifier {
  readonly environment: 'Sandbox' | 'Production';
  readonly bundleId: string;
  private readonly inner: SignedDataVerifier;

  constructor(opts: { environment: 'Sandbox' | 'Production'; bundleId: string; rootCertificates: Buffer[]; appAppleId?: number | undefined; onlineChecks: boolean }) {
    if (opts.rootCertificates.length === 0) throw new Error('At least one trusted Apple root certificate is required');
    this.environment = opts.environment;
    this.bundleId = opts.bundleId;
    const env = opts.environment === 'Production' ? Environment.PRODUCTION : Environment.SANDBOX;
    this.inner = new SignedDataVerifier(opts.rootCertificates, opts.onlineChecks, env, opts.bundleId, opts.appAppleId);
  }

  async verifyTransaction(jws: string): Promise<VerifiedTransaction> {
    const p = await this.inner.verifyAndDecodeTransaction(jws).catch(mapLibraryError);
    return toVerifiedTransaction(p, this.environment);
  }

  async verifyRenewalInfo(jws: string): Promise<VerifiedRenewalInfo> {
    const p = await this.inner.verifyAndDecodeRenewalInfo(jws).catch(mapLibraryError);
    return toVerifiedRenewalInfo(p, this.environment);
  }

  async verifyNotification(jws: string): Promise<VerifiedNotification> {
    const p = await this.inner.verifyAndDecodeNotification(jws).catch(mapLibraryError);
    return toVerifiedNotification(p, this.environment);
  }
}

/**
 * Xcode StoreKit testing verifier: the JWS must carry exactly the pinned local certificate and a valid ES256
 * signature from it. Local development only.
 */
export class XcodePinnedVerifier implements AppleVerifier {
  readonly environment = 'Xcode' as const;
  readonly bundleId: string;
  private readonly pinned: X509Certificate;

  constructor(opts: { bundleId: string; certificate: Buffer }) {
    this.bundleId = opts.bundleId;
    this.pinned = new X509Certificate(opts.certificate);
  }

  private decode(jws: string): Record<string, unknown> {
    const parts = typeof jws === 'string' ? jws.split('.') : [];
    if (parts.length !== 3) throw new AppleVerificationError('APPLE_SIGNATURE_INVALID', 'Not a compact JWS');
    let header: { alg?: unknown; x5c?: unknown };
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    } catch {
      throw new AppleVerificationError('APPLE_SIGNATURE_INVALID', 'Malformed JWS');
    }
    if (header.alg !== 'ES256' || !Array.isArray(header.x5c) || typeof header.x5c[0] !== 'string') {
      throw new AppleVerificationError('APPLE_SIGNATURE_INVALID', 'Unexpected JWS header');
    }
    const leaf = Buffer.from(header.x5c[0], 'base64');
    if (!leaf.equals(this.pinned.raw)) throw new AppleVerificationError('APPLE_SIGNATURE_INVALID', 'Not signed by the pinned Xcode certificate');
    const ok = cryptoVerify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: this.pinned.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2]!, 'base64url'));
    if (!ok) throw new AppleVerificationError('APPLE_SIGNATURE_INVALID', 'Signature does not verify');
    if (payload === null || typeof payload !== 'object') throw new AppleVerificationError('APPLE_PAYLOAD_INVALID', 'Malformed payload');
    return payload;
  }

  private checkEnvironment(env: unknown) {
    if (env !== 'Xcode') throw new AppleVerificationError('APPLE_ENVIRONMENT_MISMATCH', 'Signed data is from a different App Store environment');
  }

  async verifyTransaction(jws: string): Promise<VerifiedTransaction> {
    const p = this.decode(jws) as JWSTransactionDecodedPayload;
    if (p.bundleId !== this.bundleId) throw new AppleVerificationError('APPLE_APP_MISMATCH', 'Signed data is for a different app');
    this.checkEnvironment(p.environment);
    return toVerifiedTransaction(p, 'Xcode');
  }

  async verifyRenewalInfo(jws: string): Promise<VerifiedRenewalInfo> {
    const p = this.decode(jws) as JWSRenewalInfoDecodedPayload;
    this.checkEnvironment(p.environment);
    return toVerifiedRenewalInfo(p, 'Xcode');
  }

  async verifyNotification(jws: string): Promise<VerifiedNotification> {
    const p = this.decode(jws) as ResponseBodyV2DecodedPayload;
    if (p.data?.bundleId !== this.bundleId) throw new AppleVerificationError('APPLE_APP_MISMATCH', 'Signed data is for a different app');
    this.checkEnvironment(p.data?.environment);
    return toVerifiedNotification(p, 'Xcode');
  }
}
