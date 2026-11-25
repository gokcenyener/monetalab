/**
 * App Store Server API "Request a Test Notification" + "Get Test Notification Status" check (M3).
 * 1. Ask Apple to send a TEST notification to the URL configured in App Store Connect for this environment.
 * 2. Poll Apple's status for that test until a send attempt is reported (or the timeout).
 * 3. Verify the signed TEST payload Apple returns, and look for its notificationUUID in apple_notifications
 *    (read-only) to prove the MonetaLab endpoint received, verified and recorded it.
 * Output contains no JWS, token or credential: only result codes, dates and the notificationUUID.
 */
import type { AppleVerifier } from './verifier.ts';

export interface TestNotificationApi {
  requestTestNotification(): Promise<{ testNotificationToken?: string }>;
  getTestNotificationStatus(token: string): Promise<{ signedPayload?: string; sendAttempts?: Array<{ attemptDate?: number; sendAttemptResult?: string }> }>;
}

export type TestNotificationReport = {
  requested: boolean;
  sendAttempts: Array<{ attemptDate: string | null; result: string }>;
  delivered: boolean;
  notificationUUID: string | null;
  payloadVerified: boolean;
  recordedByMonetaLab: { result: string } | null;
  verdict: 'DELIVERED_AND_RECORDED' | 'DELIVERED_NOT_RECORDED' | 'NOT_DELIVERED' | 'NO_ATTEMPT_YET' | 'PAYLOAD_NOT_VERIFIED';
};

export async function runTestNotificationCheck(deps: {
  api: TestNotificationApi;
  verifier: AppleVerifier;
  findRecorded: (notificationUUID: string) => Promise<{ result: string } | null>;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<TestNotificationReport> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 3000;
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const report: TestNotificationReport = {
    requested: false, sendAttempts: [], delivered: false, notificationUUID: null, payloadVerified: false, recordedByMonetaLab: null, verdict: 'NO_ATTEMPT_YET',
  };
  const { testNotificationToken: token } = await deps.api.requestTestNotification();
  if (!token) throw new Error('Apple returned no testNotificationToken');
  report.requested = true;

  let status: Awaited<ReturnType<TestNotificationApi['getTestNotificationStatus']>> = {};
  for (let waited = 0; ; waited += pollMs) {
    await sleep(pollMs);
    status = await deps.api.getTestNotificationStatus(token);
    if ((status.sendAttempts ?? []).length > 0 || waited + pollMs >= timeoutMs) break;
  }
  report.sendAttempts = (status.sendAttempts ?? []).map((a) => ({
    attemptDate: typeof a.attemptDate === 'number' ? new Date(a.attemptDate).toISOString() : null,
    result: String(a.sendAttemptResult ?? 'UNKNOWN'),
  }));
  report.delivered = report.sendAttempts.some((a) => a.result === 'SUCCESS');

  if (status.signedPayload) {
    try {
      const n = await deps.verifier.verifyNotification(status.signedPayload);
      report.payloadVerified = n.notificationType === 'TEST';
      report.notificationUUID = n.notificationUUID;
    } catch {
      report.payloadVerified = false;
    }
  }
  if (report.notificationUUID) report.recordedByMonetaLab = await deps.findRecorded(report.notificationUUID);

  if (report.sendAttempts.length === 0) report.verdict = 'NO_ATTEMPT_YET';
  else if (!report.payloadVerified) report.verdict = 'PAYLOAD_NOT_VERIFIED';
  else if (!report.delivered) report.verdict = 'NOT_DELIVERED';
  else report.verdict = report.recordedByMonetaLab ? 'DELIVERED_AND_RECORDED' : 'DELIVERED_NOT_RECORDED';
  return report;
}
