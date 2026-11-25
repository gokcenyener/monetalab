/**
 * Apple signed-data verification (D-038). Uses Apple's official library for Sandbox/Production with a test root, and
 * MonetaLab's pinned-certificate check for the Xcode environment. Categories (D-005): [BR], [NEG].
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { appleVerifierFromEnv } from '../../src/billing/apple/config.ts';
import { AppStoreSignedDataVerifier, XcodePinnedVerifier, type AppleVerificationCode } from '../../src/billing/apple/verifier.ts';
import { billingProviderFromEnv } from '../../src/billing/provider.ts';
import { AppleTestSigner, PRODUCT, TEST_BUNDLE_ID, transactionPayload } from '../support/apple-signing.ts';

const signer = AppleTestSigner.create();
const attacker = AppleTestSigner.create({ name: 'Attacker' });
const sandbox = new AppStoreSignedDataVerifier({ environment: 'Sandbox', bundleId: TEST_BUNDLE_ID, rootCertificates: [signer.root], onlineChecks: false });
const dir = mkdtempSync(join(tmpdir(), 'monetalab-verifier-'));
after(() => rmSync(dir, { recursive: true, force: true }));

async function rejectsWith(p: Promise<unknown>, code: AppleVerificationCode) {
  await assert.rejects(p, (e: { code?: string }) => {
    assert.equal(e.code, code);
    return true;
  });
}
const swapPayload = (jws: string, payload: object) => {
  const [h, , s] = jws.split('.');
  return `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
};

describe('Apple JWS verification (Sandbox, official library)', () => {
  it('[BR] a correctly signed Sandbox consumable transaction verifies and is normalized', async () => {
    const token = crypto.randomUUID();
    const t = await sandbox.verifyTransaction(signer.transaction({ productId: PRODUCT.S, appAccountToken: token.toUpperCase() }));
    assert.equal(t.productType, 'CONSUMABLE');
    assert.equal(t.productId, PRODUCT.S);
    assert.equal(t.environment, 'Sandbox');
    assert.equal(t.appAccountToken, token, 'tokens are compared case-insensitively (lowercased)');
    assert.equal(t.expiresDate, null);
  });

  it('[BR] a subscription transaction carries its verified period and intro-offer fields', async () => {
    const t = await sandbox.verifyTransaction(signer.transaction({ productId: PRODUCT.BASIC, offerType: 1, offerDiscountType: 'FREE_TRIAL' }));
    assert.equal(t.productType, 'SUBSCRIPTION');
    assert.ok(t.expiresDate && t.expiresDate > t.purchaseDate);
    assert.equal(t.offerType, 1);
    assert.equal(t.offerDiscountType, 'FREE_TRIAL');
  });

  it('[NEG] forged signature (valid chain, wrong signature bytes) is rejected', async () => {
    const jws = signer.transaction({ productId: PRODUCT.S });
    const [h, p] = jws.split('.');
    await rejectsWith(sandbox.verifyTransaction(`${h}.${p}.${Buffer.alloc(64, 7).toString('base64url')}`), 'APPLE_SIGNATURE_INVALID');
  });

  it('[NEG] tampered payload (credits product swapped after signing) is rejected', async () => {
    const jws = signer.transaction({ productId: PRODUCT.S });
    await rejectsWith(sandbox.verifyTransaction(swapPayload(jws, transactionPayload({ productId: PRODUCT.L }))), 'APPLE_SIGNATURE_INVALID');
  });

  it('[NEG] a chain from an untrusted root (attacker CA with Apple-like OIDs) is rejected', async () => {
    await rejectsWith(sandbox.verifyTransaction(attacker.transaction({ productId: PRODUCT.S })), 'APPLE_SIGNATURE_INVALID');
  });

  it('[NEG] attacker leaf presented with the trusted intermediate and root is rejected', async () => {
    const jws = attacker.jws(transactionPayload({ productId: PRODUCT.S }), { chain: [attacker.leaf, signer.intermediate, signer.root] });
    await rejectsWith(sandbox.verifyTransaction(jws), 'APPLE_SIGNATURE_INVALID');
  });

  it('[NEG] certificates without the Apple extension OIDs are rejected even under the trusted root', async () => {
    const plain = AppleTestSigner.create({ name: 'No OID', withAppleOids: false });
    const v = new AppStoreSignedDataVerifier({ environment: 'Sandbox', bundleId: TEST_BUNDLE_ID, rootCertificates: [plain.root], onlineChecks: false });
    await rejectsWith(v.verifyTransaction(plain.transaction({ productId: PRODUCT.S })), 'APPLE_SIGNATURE_INVALID');
  });

  it('[NEG] an expired signing certificate (at the signed date) is rejected', async () => {
    const expired = AppleTestSigner.create({ name: 'Expired', leafNotAfter: '20250101000000Z' });
    const v = new AppStoreSignedDataVerifier({ environment: 'Sandbox', bundleId: TEST_BUNDLE_ID, rootCertificates: [expired.root], onlineChecks: false });
    await rejectsWith(v.verifyTransaction(expired.transaction({ productId: PRODUCT.S })), 'APPLE_SIGNATURE_INVALID');
  });

  it('[NEG] unsigned data (alg none, empty signature) and a short chain are rejected', async () => {
    const p = Buffer.from(JSON.stringify(transactionPayload({ productId: PRODUCT.S }))).toString('base64url');
    const h = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    await rejectsWith(sandbox.verifyTransaction(`${h}.${p}.`), 'APPLE_SIGNATURE_INVALID');
    await rejectsWith(sandbox.verifyTransaction(signer.jws(transactionPayload({ productId: PRODUCT.S }), { chain: [signer.leaf, signer.intermediate] })), 'APPLE_SIGNATURE_INVALID');
  });

  it('[NEG] wrong bundle id is rejected', async () => {
    await rejectsWith(sandbox.verifyTransaction(signer.transaction({ productId: PRODUCT.S, bundleId: 'com.example.other' })), 'APPLE_APP_MISMATCH');
  });

  it('[NEG] Sandbox/Production mismatch is refused in both directions', async () => {
    await rejectsWith(sandbox.verifyTransaction(signer.transaction({ productId: PRODUCT.S, environment: 'Production' })), 'APPLE_ENVIRONMENT_MISMATCH');
    const production = new AppStoreSignedDataVerifier({ environment: 'Production', bundleId: TEST_BUNDLE_ID, rootCertificates: [signer.root], onlineChecks: false, appAppleId: 1234567890 });
    await rejectsWith(production.verifyTransaction(signer.transaction({ productId: PRODUCT.S })), 'APPLE_ENVIRONMENT_MISMATCH');
    await rejectsWith(sandbox.verifyTransaction(signer.transaction({ productId: PRODUCT.S, environment: 'Xcode' })), 'APPLE_ENVIRONMENT_MISMATCH');
  });

  it('[NEG] shapes without an approved rule are rejected: quantity 2, family sharing, non-consumable, no expiry', async () => {
    await rejectsWith(sandbox.verifyTransaction(signer.transaction({ productId: PRODUCT.S, quantity: 2 })), 'APPLE_PAYLOAD_INVALID');
    await rejectsWith(sandbox.verifyTransaction(signer.transaction({ productId: PRODUCT.BASIC, inAppOwnershipType: 'FAMILY_SHARED' })), 'APPLE_PAYLOAD_INVALID');
    await rejectsWith(sandbox.verifyTransaction(signer.transaction({ productId: PRODUCT.S, type: 'Non-Consumable' })), 'APPLE_PAYLOAD_INVALID');
    const noExpiry = transactionPayload({ productId: PRODUCT.BASIC });
    delete noExpiry.expiresDate;
    await rejectsWith(sandbox.verifyTransaction(signer.jws(noExpiry)), 'APPLE_PAYLOAD_INVALID');
  });

  it('[BR][NEG] notifications: V2 verifies; V1-style version, wrong bundle and wrong environment are rejected', async () => {
    const n = await sandbox.verifyNotification(signer.notification({ notificationType: 'TEST' }));
    assert.equal(n.notificationType, 'TEST');
    await rejectsWith(sandbox.verifyNotification(signer.notification({ notificationType: 'TEST', version: '1.0' })), 'APPLE_PAYLOAD_INVALID');
    await rejectsWith(sandbox.verifyNotification(signer.notification({ notificationType: 'TEST', bundleId: 'com.example.other' })), 'APPLE_APP_MISMATCH');
    await rejectsWith(sandbox.verifyNotification(signer.notification({ notificationType: 'TEST', environment: 'Production' })), 'APPLE_ENVIRONMENT_MISMATCH');
    await rejectsWith(sandbox.verifyNotification(attacker.notification({ notificationType: 'TEST' })), 'APPLE_SIGNATURE_INVALID');
  });

  it('[BR] renewal info verifies and exposes auto-renew status and the next product', async () => {
    const r = await sandbox.verifyRenewalInfo(signer.renewalInfo({ originalTransactionId: '1', productId: PRODUCT.ULTRA, autoRenewProductId: PRODUCT.BASIC, autoRenewStatus: 0 }));
    assert.equal(r.autoRenewStatus, false);
    assert.equal(r.autoRenewProductId, PRODUCT.BASIC);
    assert.equal(r.expirationIntent, null, 'no expirationIntent while not expired');
  });
  it('[BR][NEG] renewal info carries Apple\'s expirationIntent (1..5); out-of-range values are dropped', async () => {
    const r = await sandbox.verifyRenewalInfo(signer.renewalInfo({ originalTransactionId: '1', productId: PRODUCT.BASIC, autoRenewStatus: 1, expirationIntent: 2 }));
    assert.equal(r.expirationIntent, 2);
    assert.equal(r.autoRenewStatus, true, 'an expired subscription can still report auto-renew ON (billing error)');
    const bad = await sandbox.verifyRenewalInfo(signer.renewalInfo({ originalTransactionId: '1', productId: PRODUCT.BASIC, expirationIntent: 9 }));
    assert.equal(bad.expirationIntent, null);
  });
});

describe('Xcode StoreKit testing verifier (pinned certificate)', () => {
  const xcode = AppleTestSigner.createXcodeLike();
  const other = AppleTestSigner.createXcodeLike();
  const v = new XcodePinnedVerifier({ bundleId: TEST_BUNDLE_ID, certificate: xcode.certificate });

  it('[BR] data signed by the pinned local certificate verifies', async () => {
    const t = await v.verifyTransaction(xcode.signer.transaction({ productId: PRODUCT.M, environment: 'Xcode' }));
    assert.equal(t.environment, 'Xcode');
  });

  it('[NEG] another self-signed certificate, a forged signature, Sandbox data and HS256 headers are rejected', async () => {
    await rejectsWith(v.verifyTransaction(other.signer.transaction({ productId: PRODUCT.M, environment: 'Xcode' })), 'APPLE_SIGNATURE_INVALID');
    const [h, p] = xcode.signer.transaction({ productId: PRODUCT.M, environment: 'Xcode' }).split('.');
    await rejectsWith(v.verifyTransaction(`${h}.${p}.${Buffer.alloc(64, 1).toString('base64url')}`), 'APPLE_SIGNATURE_INVALID');
    await rejectsWith(v.verifyTransaction(xcode.signer.transaction({ productId: PRODUCT.M, environment: 'Sandbox' })), 'APPLE_ENVIRONMENT_MISMATCH');
    await rejectsWith(v.verifyTransaction(xcode.signer.jws(transactionPayload({ productId: PRODUCT.M, environment: 'Xcode' }), { alg: 'HS256' })), 'APPLE_SIGNATURE_INVALID');
  });
});

describe('Apple configuration', () => {
  const rootPath = join(dir, 'root.der');
  writeFileSync(rootPath, signer.root);
  const xcodeCert = join(dir, 'xcode.cer');
  writeFileSync(xcodeCert, AppleTestSigner.createXcodeLike().certificate);
  const base = { BILLING_PROVIDER: 'apple', APPLE_BUNDLE_ID: TEST_BUNDLE_ID };

  it('[BR] BILLING_PROVIDER=apple builds the verifier for the configured environment; mock stays the default', () => {
    const p = billingProviderFromEnv({ ...base, APPLE_ENVIRONMENT: 'Sandbox', APPLE_ROOT_CERTIFICATES: rootPath, APPLE_ONLINE_CHECKS: 'false' });
    assert.equal(p.name, 'apple');
    assert.equal(p.name === 'apple' && p.verifier.environment, 'Sandbox');
    assert.equal(billingProviderFromEnv({}).name, 'mock');
  });

  it('[NEG] missing or unsafe configuration is refused at startup', () => {
    assert.throws(() => appleVerifierFromEnv({ ...base }), /APPLE_ENVIRONMENT/);
    assert.throws(() => appleVerifierFromEnv({ ...base, APPLE_ENVIRONMENT: 'LocalTesting' }), /APPLE_ENVIRONMENT/);
    assert.throws(() => appleVerifierFromEnv({ APPLE_ENVIRONMENT: 'Sandbox', APPLE_ROOT_CERTIFICATES: rootPath }), /APPLE_BUNDLE_ID/);
    assert.throws(() => appleVerifierFromEnv({ ...base, APPLE_ENVIRONMENT: 'Sandbox' }), /APPLE_ROOT_CERTIFICATES/);
    assert.throws(() => appleVerifierFromEnv({ ...base, APPLE_ENVIRONMENT: 'Production', APPLE_ROOT_CERTIFICATES: rootPath }), /APPLE_APP_APPLE_ID/);
    assert.throws(() => appleVerifierFromEnv({ ...base, APPLE_ENVIRONMENT: 'Sandbox', APPLE_ROOT_CERTIFICATES: rootPath, APPLE_ONLINE_CHECKS: 'maybe' }), /APPLE_ONLINE_CHECKS/);
    assert.throws(() => appleVerifierFromEnv({ ...base, APPLE_ENVIRONMENT: 'Xcode' }), /APPLE_XCODE_CERTIFICATE/);
    assert.throws(() => appleVerifierFromEnv({ ...base, APPLE_ENVIRONMENT: 'Xcode', APPLE_XCODE_CERTIFICATE: xcodeCert, NODE_ENV: 'production' }), /production/);
    assert.throws(() => billingProviderFromEnv({ BILLING_PROVIDER: 'storekit' }), /Unsupported BILLING_PROVIDER/);
    assert.equal(appleVerifierFromEnv({ ...base, APPLE_ENVIRONMENT: 'Xcode', APPLE_XCODE_CERTIFICATE: xcodeCert }).environment, 'Xcode');
  });
});
