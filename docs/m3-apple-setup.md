# MonetaLab M3: Apple Developer / App Store Connect setup (owner checklist)

These steps need the owner's Apple accounts. Claude Code has **not** done any of them: no account, agreement, payment, tax, banking, certificate, key, upload or enrollment was created, accepted or changed. Nothing here should be committed to Git (keys, certificates, profiles, tester credentials).

Status on 2026-11-19 (checked on the development Mac): **no signing identity** (`security find-identity -v -p codesigning` → 0), **no provisioning profiles**, **no Apple account in Xcode**, and `DEVELOPMENT_TEAM` is not set in the project. Bundle id in the project: `dev.monetalab.qa.MonetaLab` (a proposal; change it if the team owns a different reverse-DNS prefix, then update `APPLE_BUNDLE_ID` and the product ids).

## 1. Team, App ID, signing
1. Apple Developer Program membership for the team that will own the app.
2. Xcode → Settings → Accounts: add the Apple ID; select the team for the **MonetaLab** target (Signing & Capabilities). This sets `DEVELOPMENT_TEAM`.
3. Register the explicit App ID `dev.monetalab.qa.MonetaLab` with the **In-App Purchase** capability (automatic signing can create it).

## 2. App Store Connect app record and agreements
1. Create the app record (platform iOS, the bundle id above, an SKU).
2. Business → **Paid Applications Agreement**: the Account Holder must accept it and complete banking and tax information. In-app purchases cannot be tested in Sandbox without it.

## 3. Products (D-039: these exact ids)
- **Consumables** (In-App Purchases → Consumable): `dev.monetalab.qa.credits.5000`, `dev.monetalab.qa.credits.7000`, `dev.monetalab.qa.credits.10000`.
- **Subscription group** "MonetaLab Weekly", auto-renewable, duration **1 week**, levels (highest first):
  1. `dev.monetalab.qa.sub.ultra.weekly`
  2. `dev.monetalab.qa.sub.premium.weekly`
  3. `dev.monetalab.qa.sub.basic.weekly`
- **Introductory offer** on Basic only: Free, 3 days, for new subscribers (PRD §2.1; open decision #4 says do not assume other offers).
- **Prices**: owner decision (PRD open decision #1). The app shows StoreKit's localized price; MonetaLab never stores prices.
- Billing grace period: recommended **off** until PRD open decision #6 is decided (D-046).
- Family Sharing: off (no approved credit rule; the server rejects family-shared transactions).

## 4. Sandbox
1. Users and Access → Sandbox → create a tester (a new email address not used for any Apple ID). Never put its credentials in the repository.
2. Run a signed development build on a device (or a simulator signed into the Sandbox account in Settings → Developer), with the scheme's StoreKit configuration **unset** so StoreKit talks to Apple Sandbox.

## 5. App Store Server API and Notifications V2
1. Users and Access → Integrations → **In-App Purchase** key: download the `.p8` once; note the Key ID and Issuer ID. Store them in the server's secret store only (`APPLE_API_PRIVATE_KEY_PATH`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`).
2. Download **Apple Root CA - G3** from https://www.apple.com/certificateauthority/ for `APPLE_ROOT_CERTIFICATES`.
3. Deploy the backend behind **HTTPS** with a public URL (not done: MonetaLab is a local fixture; D-S3-09 gaps must be fixed before any public deployment). Then App Information → App Store Server Notifications: **Version 2**, Sandbox URL and Production URL → `https://<host>/apple/notifications`.
4. Verify delivery with the App Store Server API "Request a Test Notification" (expected server result: `RECORDED` for `TEST`).
5. Decide D-048 (how App Review's Sandbox purchases reach a production deployment).

## 5b. Local QA: Sandbox notifications through the isolated gateway (owner approval required)
Only the **notification gateway** is exposed, never the main API:
- `npm run notifications:start` (in `backend/`) serves ONLY `POST /apple/notifications`, bound to `127.0.0.1:3100` (every other path is 404; no health, auth, wallet or billing routes).
- Hardening: 64 KB body cap, schema-checked JWS, per-client 60/min + global 600/min rate limit (429), outer and nested JWS verified for **Sandbox** + `dev.monetalab.qa.MonetaLab` before any database access, signedDate window (≤ 5 min in the future, ≤ 7 days old), replays acknowledged as `DUPLICATE`, request log = method/path/status/duration only.
- HTTPS: a tunnel from this Mac to `127.0.0.1:3100` only. Proposed: Cloudflare quick tunnel (`cloudflared`, not installed yet). The public URL is random per run (`https://<random>.trycloudflare.com`); a stable name needs a named tunnel on an owner domain.

Steps (each needs the owner's approval; none has been done):
1. `brew install cloudflared`
2. Terminal A: `cd backend && APPLE_ENVIRONMENT=Sandbox APPLE_BUNDLE_ID=dev.monetalab.qa.MonetaLab APPLE_ROOT_CERTIFICATES=<AppleRootCA-G3.cer> npm run notifications:start`
3. Terminal B: `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3100` → note `https://<random>.trycloudflare.com`
4. App Store Connect → the app → App Information → App Store Server Notifications → **Sandbox Server URL**: `https://<random>.trycloudflare.com/apple/notifications`, **Version 2**. Leave the **Production Server URL** unchanged/empty.
5. Terminal C: `npm run apple:test-notification` with the same `APPLE_*` variables plus `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_PRIVATE_KEY_PATH`. Expected verdict `DELIVERED_AND_RECORDED` (Apple's send attempt `SUCCESS`, verified TEST payload, row in `apple_notifications` with result `RECORDED`).
6. Afterwards: stop the tunnel and the gateway, and clear or replace the Sandbox URL (a quick-tunnel URL dies with the tunnel).

## 5c. Physical subscription checklist with real notifications (MT-03..MT-11)
Prerequisites: notification gateway + tunnel running and the Sandbox URL saved (§5b); iPhone with the current Debug build; dev API in Sandbox mode. Sandbox weekly periods last minutes (Apple's Sandbox renewal rate); if the iPhone offers a slower **Renewal Rate** for the Sandbox account (Settings → Developer → Sandbox Apple Account), a slower rate leaves time for MT-06 before the renewal.

| ID | Action on the iPhone | Expected MonetaLab result | Expected notification (V2) |
|---|---|---|---|
| MT-03 | Plan tab → Basic → buy | `SUBSCRIPTION_STARTED`, SUBSCRIPTION +3,000, consumables unchanged | SUBSCRIBED (RESUBSCRIBE) |
| MT-04 | Paywall → Subscription → Premium → Continue | `UPGRADED`: −remainder `SUPERSEDED`, +6,000 | DID_CHANGE_RENEWAL_PREF (UPGRADE) |
| MT-05 | Paywall → Ultra → Continue | `UPGRADED`: +12,000 | DID_CHANGE_RENEWAL_PREF (UPGRADE) |
| MT-06 | Plan tab → Premium (or Manage Subscription → Premium) | no credit change; Plan shows "Changes to Premium at the next renewal" | DID_CHANGE_RENEWAL_PREF (DOWNGRADE) |
| MT-07 | Wait for the renewal | `RENEWED_DOWNGRADED`: −Ultra remainder `PERIOD_ENDED`, +6,000 | DID_RENEW |
| MT-08 | Downgrade to Basic, wait for the renewal | no change, then +3,000 | DID_CHANGE_RENEWAL_PREF (DOWNGRADE), DID_RENEW |
| MT-09 | Manage Subscription → Cancel | auto-renew off, still entitled, credits kept | DID_CHANGE_RENEWAL_STATUS (AUTO_RENEW_DISABLED) |
| MT-10 | Wait past the end; run a Basic operation | not entitled, SUBSCRIPTION 0, operation uses CONSUMABLE | EXPIRED (VOLUNTARY) |
| MT-11 | Plan tab → Restore Purchases | nothing changes | none required |

Evidence: `apple_notifications` rows (type, subtype, `version` 2.0, result) prove delivery; `apple_transactions.source` shows which path recorded each transaction first (CLIENT / NOTIFICATION / SERVER_API). A client-submitted transaction is not notification evidence.

## 6. TestFlight
1. Product → Archive with the team's distribution signing; upload (needs the owner's explicit approval).
2. Internal testing first; external testing needs Beta App Review.
3. TestFlight purchases use the Sandbox environment: the server for TestFlight must run `APPLE_ENVIRONMENT=Sandbox`.

## 7. Evidence to collect afterwards (for docs/m3-verification.md)
- A Sandbox purchase of each pack and of Basic (trial), with the server log line, the `apple_transactions` row (environment `Sandbox`) and the ledger grant.
- A delivered Sandbox notification (`apple_notifications` row with a real notificationUUID).
- `npm run apple:reconcile -- --user <uuid>` output against Sandbox.
- The TestFlight build number and its processing status.

## 7b. TestFlight with real Sandbox purchases (D-051; each step needs owner approval)
1. API for testers outside the LAN: `cd backend && API_EXPOSURE=tunnel PORT=3200 BILLING_PROVIDER=apple APPLE_ENVIRONMENT=Sandbox APPLE_BUNDLE_ID=dev.monetalab.qa.MonetaLab APPLE_ROOT_CERTIFICATES=<AppleRootCA-G3.cer> npm start` (loopback only, no mock/ad routes, rate-limited), then `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:3200` (public HTTPS; stays up for the whole TestFlight session: the quick-tunnel URL is baked into the build and changes on every run; a stable URL needs a named tunnel on an owner domain).
2. `ios/Config/Local.Release.xcconfig`: `MONETALAB_API_BASE_URL = https:/$()/<api-tunnel-host>`; then `ios/scripts/testflight-preflight.sh <build-number>` must print no FAIL.
3. Xcode → Organizer → the archive → Distribute App → App Store Connect (creates/uses an Apple Distribution certificate; answer export compliance; upload).
4. App Store Connect → TestFlight: internal testing group, add the tester; install with TestFlight; purchases use the Sandbox environment (TestFlight account), verified against Apple Root CA - G3 by the server.

### 7c. TestFlight execution plan and approval gates (2026-11-25)
Ready: Release preflight passes with an HTTPS URL (validation archive only); `API_EXPOSURE=tunnel` profile tested; notification gateway + tunnel already deliver Sandbox notifications (TestFlight purchases use Sandbox, so the same Sandbox Server URL applies).

| Gate | What happens | Persistent / public effect |
|---|---|---|
| **A1** TestFlight API exposure | start `API_EXPOSURE=tunnel PORT=3200 BILLING_PROVIDER=apple APPLE_ENVIRONMENT=Sandbox …` (loopback only, no mock/ad routes, rate-limited, same dev database) and a second Cloudflare Quick Tunnel to `127.0.0.1:3200` only | public HTTPS endpoint for auth/wallet/operations/StoreKit sync while the tunnel runs; URL random per run |
| **A2** Apple Distribution signing | Xcode Organizer → Distribute App → App Store Connect lets Xcode create (or use cloud-managed) an Apple Distribution certificate and an App Store profile for `dev.monetalab.qa.MonetaLab` (needs Account Holder/Admin, or the cloud-managed distribution certificate permission) | new certificate/profile in the developer account |
| **A3** Upload | upload build 0.1.0 (build number ≥ 1, unique) to App Store Connect; answer export compliance (`ITSAppUsesNonExemptEncryption` is not set, so App Store Connect asks) | build stored in App Store Connect; processing |
| **A4** TestFlight distribution | internal testing group and tester in App Store Connect (owner action; external testing would need Beta App Review) | testers can install |

Order: A1 → write `ios/Config/Local.Release.xcconfig` with the A1 URL → `ios/scripts/testflight-preflight.sh <build>` (must show no FAIL) → A2 + A3 in Organizer → A4 → test on the TestFlight install. The A1 tunnel must stay up for the whole session (the URL is compiled into the build; a new tunnel needs a new build).

