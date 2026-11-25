/**
 * "Request a Test Notification" / "Get Test Notification Status" check against a fake App Store Server API and
 * signed test fixtures (MOCK-SIGNED; no Apple call). Categories (D-005): [BR], [NEG].
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { runTestNotificationCheck, type TestNotificationApi } from '../../src/billing/apple/test-notification.ts';
import { AppStoreSignedDataVerifier } from '../../src/billing/apple/verifier.ts';
import { AppleTestSigner, TEST_BUNDLE_ID } from '../support/apple-signing.ts';

const signer = AppleTestSigner.create();
const verifier = new AppStoreSignedDataVerifier({ environment: 'Sandbox', bundleId: TEST_BUNDLE_ID, rootCertificates: [signer.root], onlineChecks: false });
const noSleep = async () => {};

function fakeApi(statuses: Array<Awaited<ReturnType<TestNotificationApi['getTestNotificationStatus']>>>) {
  const calls: string[] = [];
  const api: TestNotificationApi = {
    async requestTestNotification() { calls.push('request'); return { testNotificationToken: 'token-1' }; },
    async getTestNotificationStatus(token) { calls.push(`status:${token}`); return statuses.shift() ?? {}; },
  };
  return { api, calls };
}

describe('Apple test notification check', () => {
  it('[BR] SUCCESS attempt + verified TEST payload + row in apple_notifications = DELIVERED_AND_RECORDED', async () => {
    const uuid = randomUUID();
    const { api, calls } = fakeApi([{}, { signedPayload: signer.notification({ notificationType: 'TEST', notificationUUID: uuid }), sendAttempts: [{ attemptDate: Date.UTC(2026, 10, 24), sendAttemptResult: 'SUCCESS' }] }]);
    const report = await runTestNotificationCheck({ api, verifier, sleep: noSleep, findRecorded: async (id) => (id === uuid ? { result: 'RECORDED' } : null) });
    assert.deepEqual(calls, ['request', 'status:token-1', 'status:token-1'], 'polls until an attempt is reported');
    assert.equal(report.verdict, 'DELIVERED_AND_RECORDED');
    assert.equal(report.notificationUUID, uuid);
    assert.deepEqual(report.sendAttempts, [{ attemptDate: '2026-11-24T00:00:00.000Z', result: 'SUCCESS' }]);
    assert.doesNotMatch(JSON.stringify(report), /eyJ|token-1/, 'no JWS or token in the report');
  });
  it('[NEG] Apple reached the URL but MonetaLab has no record = DELIVERED_NOT_RECORDED', async () => {
    const { api } = fakeApi([{ signedPayload: signer.notification({ notificationType: 'TEST' }), sendAttempts: [{ sendAttemptResult: 'SUCCESS' }] }]);
    assert.equal((await runTestNotificationCheck({ api, verifier, sleep: noSleep, findRecorded: async () => null })).verdict, 'DELIVERED_NOT_RECORDED');
  });
  it('[NEG] failed attempts (TLS, timeout, HTTP error) = NOT_DELIVERED, with Apple\'s reasons', async () => {
    const { api } = fakeApi([{ signedPayload: signer.notification({ notificationType: 'TEST' }), sendAttempts: [{ sendAttemptResult: 'TLS_ISSUE' }, { sendAttemptResult: 'UNSUCCESSFUL_HTTP_RESPONSE_CODE' }] }]);
    const report = await runTestNotificationCheck({ api, verifier, sleep: noSleep, findRecorded: async () => ({ result: 'RECORDED' }) });
    assert.equal(report.verdict, 'NOT_DELIVERED');
    assert.deepEqual(report.sendAttempts.map((a) => a.result), ['TLS_ISSUE', 'UNSUCCESSFUL_HTTP_RESPONSE_CODE']);
  });
  it('[NEG] no attempt before the timeout = NO_ATTEMPT_YET (bounded polling)', async () => {
    const { api, calls } = fakeApi([]);
    const report = await runTestNotificationCheck({ api, verifier, sleep: noSleep, pollMs: 1000, timeoutMs: 5000, findRecorded: async () => null });
    assert.equal(report.verdict, 'NO_ATTEMPT_YET');
    assert.equal(calls.filter((c) => c.startsWith('status')).length, 5);
  });
  it('[NEG] a payload not signed by the trusted chain = PAYLOAD_NOT_VERIFIED, never counted as delivered', async () => {
    const forged = AppleTestSigner.create({ name: 'Forger' }).notification({ notificationType: 'TEST' });
    const { api } = fakeApi([{ signedPayload: forged, sendAttempts: [{ sendAttemptResult: 'SUCCESS' }] }]);
    const report = await runTestNotificationCheck({ api, verifier, sleep: noSleep, findRecorded: async () => ({ result: 'RECORDED' }) });
    assert.equal(report.verdict, 'PAYLOAD_NOT_VERIFIED');
    assert.equal(report.recordedByMonetaLab, null);
  });
});
