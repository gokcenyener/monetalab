/**
 * TEST-ONLY Apple-style signer (D-047). Creates a throwaway certificate chain at runtime:
 *   root (self-signed CA) -> intermediate (CA, Apple intermediate OID 1.2.840.113635.100.6.2.1)
 *                         -> leaf (Apple leaf OID 1.2.840.113635.100.6.11.1)
 * and signs JWS exactly like the App Store does (ES256, x5c = [leaf, intermediate, root]). The server under test is
 * configured to trust ONLY this run's root, so these fixtures exercise Apple's real verification code path (the
 * official library) without any Apple credential. They are NOT Apple-signed evidence: real Sandbox verification is a
 * separate, owner-gated step (docs/m3-verification.md).
 *
 * Keys are generated per run, never committed, and (for the API harness) written only to a temp directory that the
 * global teardown removes.
 */
import { createPrivateKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import jsrsasign from 'jsrsasign';

const { KJUR, KEYUTIL } = jsrsasign;

export const TEST_BUNDLE_ID = 'dev.monetalab.qa.MonetaLab';
export const PRODUCT = {
  S: 'dev.monetalab.qa.credits.5000',
  M: 'dev.monetalab.qa.credits.7000',
  L: 'dev.monetalab.qa.credits.10000',
  BASIC: 'dev.monetalab.qa.sub.basic.weekly',
  PREMIUM: 'dev.monetalab.qa.sub.premium.weekly',
  ULTRA: 'dev.monetalab.qa.sub.ultra.weekly',
} as const;

const APPLE_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';
const APPLE_LEAF_OID = '1.2.840.113635.100.6.11.1';
const WEEK = 7 * 24 * 3600 * 1000;

type Keys = { privateKey: KeyObject; publicKey: KeyObject };
const newKeys = (): Keys => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pemPublic = (k: KeyObject) => k.export({ type: 'spki', format: 'pem' }) as string;
const pemPrivate = (k: KeyObject) => k.export({ type: 'pkcs8', format: 'pem' }) as string;
let serial = 1000;

function certificate(opts: {
  subject: string; issuer: string; publicKey: KeyObject; issuerKey: KeyObject; ca: boolean; oid?: string;
  notBefore?: string; notAfter?: string;
}): Buffer {
  const ext: unknown[] = [{ extname: 'basicConstraints', cA: opts.ca, critical: opts.ca }];
  if (opts.oid) ext.push({ extname: opts.oid, extn: '0500' });
  const cert = new KJUR.asn1.x509.Certificate({
    version: 3,
    serial: { int: serial++ },
    issuer: { str: opts.issuer },
    subject: { str: opts.subject },
    notbefore: opts.notBefore ?? '20240101000000Z',
    notafter: opts.notAfter ?? '20400101000000Z',
    sbjpubkey: KEYUTIL.getKey(pemPublic(opts.publicKey)),
    ext,
    sigalg: 'SHA256withECDSA',
    cakey: KEYUTIL.getKey(pemPrivate(opts.issuerKey)),
  } as never);
  return Buffer.from((cert as unknown as { tohex(): string }).tohex(), 'hex');
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export type SignerFiles = { dir: string; rootPath: string };

export class AppleTestSigner {
  readonly root: Buffer;
  readonly intermediate: Buffer;
  readonly leaf: Buffer;
  private readonly leafKey: KeyObject;

  private constructor(parts: { root: Buffer; intermediate: Buffer; leaf: Buffer; leafKey: KeyObject }) {
    this.root = parts.root;
    this.intermediate = parts.intermediate;
    this.leaf = parts.leaf;
    this.leafKey = parts.leafKey;
  }

  /** A fresh chain. `leafValidity` lets a test build an expired leaf certificate. */
  static create(opts: { name?: string; leafNotAfter?: string; withAppleOids?: boolean } = {}): AppleTestSigner {
    const name = opts.name ?? 'MonetaLab Test';
    const oids = opts.withAppleOids ?? true;
    const root = newKeys(), inter = newKeys(), leaf = newKeys();
    const rootDer = certificate({ subject: `/CN=${name} Root CA`, issuer: `/CN=${name} Root CA`, publicKey: root.publicKey, issuerKey: root.privateKey, ca: true });
    const interDer = certificate({ subject: `/CN=${name} Intermediate`, issuer: `/CN=${name} Root CA`, publicKey: inter.publicKey, issuerKey: root.privateKey, ca: true, ...(oids && { oid: APPLE_INTERMEDIATE_OID }) });
    const leafDer = certificate({
      subject: `/CN=${name} Signing`, issuer: `/CN=${name} Intermediate`, publicKey: leaf.publicKey, issuerKey: inter.privateKey, ca: false,
      ...(oids && { oid: APPLE_LEAF_OID }), ...(opts.leafNotAfter && { notAfter: opts.leafNotAfter }),
    });
    return new AppleTestSigner({ root: rootDer, intermediate: interDer, leaf: leafDer, leafKey: leaf.privateKey });
  }

  /** Self-signed single certificate, like the one Xcode uses for local StoreKit testing. */
  static createXcodeLike(): { signer: AppleTestSigner; certificate: Buffer } {
    const k = newKeys();
    const der = certificate({ subject: '/CN=StoreKit Testing in Xcode (test double)', issuer: '/CN=StoreKit Testing in Xcode (test double)', publicKey: k.publicKey, issuerKey: k.privateKey, ca: false });
    const s = new AppleTestSigner({ root: der, intermediate: der, leaf: der, leafKey: k.privateKey });
    return { signer: s, certificate: der };
  }

  save(dir: string): SignerFiles {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'root.der'), this.root);
    writeFileSync(join(dir, 'intermediate.der'), this.intermediate);
    writeFileSync(join(dir, 'leaf.der'), this.leaf);
    writeFileSync(join(dir, 'leaf-key.pem'), pemPrivate(this.leafKey), { mode: 0o600 });
    return { dir, rootPath: join(dir, 'root.der') };
  }

  static load(dir: string): AppleTestSigner {
    return new AppleTestSigner({
      root: readFileSync(join(dir, 'root.der')),
      intermediate: readFileSync(join(dir, 'intermediate.der')),
      leaf: readFileSync(join(dir, 'leaf.der')),
      leafKey: createPrivateKey(readFileSync(join(dir, 'leaf-key.pem'))),
    });
  }

  /** Compact JWS with Apple's header shape. `chain` overrides x5c (for negative tests). */
  jws(payload: object, opts: { chain?: Buffer[]; alg?: string } = {}): string {
    const chain = opts.chain ?? (this.root === this.leaf ? [this.leaf] : [this.leaf, this.intermediate, this.root]);
    const header = { alg: opts.alg ?? 'ES256', x5c: chain.map((c) => c.toString('base64')) };
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
    const signature = sign('sha256', Buffer.from(input), { key: this.leafKey, dsaEncoding: 'ieee-p1363' });
    return `${input}.${b64u(signature)}`;
  }

  transaction(p: Partial<TransactionPayload> & { productId: string }): string {
    return this.jws(transactionPayload(p));
  }

  renewalInfo(p: Partial<RenewalPayload> & { originalTransactionId: string; productId: string }): string {
    return this.jws({ autoRenewStatus: 1, autoRenewProductId: p.productId, signedDate: Date.now(), environment: 'Sandbox', ...p });
  }

  notification(p: {
    notificationType: string; subtype?: string; notificationUUID?: string; signedTransactionInfo?: string; signedRenewalInfo?: string;
    environment?: string; bundleId?: string; version?: string; signedDate?: number; appAppleId?: number;
  }): string {
    return this.jws({
      notificationType: p.notificationType,
      ...(p.subtype && { subtype: p.subtype }),
      notificationUUID: p.notificationUUID ?? randomUUID(),
      version: p.version ?? '2.0',
      signedDate: p.signedDate ?? Date.now(),
      data: {
        bundleId: p.bundleId ?? TEST_BUNDLE_ID,
        environment: p.environment ?? 'Sandbox',
        ...(p.appAppleId !== undefined && { appAppleId: p.appAppleId }),
        ...(p.signedTransactionInfo && { signedTransactionInfo: p.signedTransactionInfo }),
        ...(p.signedRenewalInfo && { signedRenewalInfo: p.signedRenewalInfo }),
      },
    });
  }
}

export type TransactionPayload = {
  transactionId: string; originalTransactionId: string; bundleId: string; productId: string; purchaseDate: number;
  originalPurchaseDate: number; expiresDate?: number; quantity: number; type: string; appAccountToken?: string;
  inAppOwnershipType: string; signedDate: number; environment: string; offerType?: number; offerDiscountType?: string;
  revocationDate?: number; revocationReason?: number; isUpgraded?: boolean; subscriptionGroupIdentifier?: string;
  transactionReason: string; storefront: string; storefrontId: string; currency: string; price: number;
};
export type RenewalPayload = {
  originalTransactionId: string; productId: string; autoRenewProductId: string; autoRenewStatus: number;
  signedDate: number; environment: string; isInBillingRetryPeriod?: boolean; gracePeriodExpiresDate?: number;
  expirationIntent?: number;
};

let txCounter = Math.floor(Math.random() * 1e6);
/** A unique numeric-looking Apple transaction id (Apple ids are decimal strings). */
export const newTransactionId = () => `2000${Date.now()}${String(txCounter++).padStart(7, '0')}`;

export function transactionPayload(p: Partial<TransactionPayload> & { productId: string }): TransactionPayload {
  const subscription = p.productId.includes('.sub.');
  const id = p.transactionId ?? newTransactionId();
  const purchaseDate = p.purchaseDate ?? Date.now() - 1000;
  return {
    transactionId: id,
    originalTransactionId: p.originalTransactionId ?? id,
    bundleId: TEST_BUNDLE_ID,
    purchaseDate,
    originalPurchaseDate: purchaseDate,
    ...(subscription && { expiresDate: purchaseDate + WEEK, subscriptionGroupIdentifier: '21000000' }),
    quantity: 1,
    type: subscription ? 'Auto-Renewable Subscription' : 'Consumable',
    inAppOwnershipType: 'PURCHASED',
    signedDate: Date.now(),
    environment: 'Sandbox',
    transactionReason: 'PURCHASE',
    storefront: 'USA',
    storefrontId: '143441',
    currency: 'USD',
    price: 0,
    ...p,
  };
}

