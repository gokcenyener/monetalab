# MonetaLab

A small, reproducible **QA portfolio fixture** for mobile monetization: a SwiftUI iOS app and a Node.js/TypeScript REST API on PostgreSQL. It demonstrates credit-wallet business rules through independently verifiable API, database, iOS and CI tests.

> **Two billing modes, chosen by the server.** By default (`BILLING_PROVIDER=mock`) consumable purchases, weekly subscriptions (with the Basic free trial) and rewarded ads use deterministic, test-controlled *mock* providers, as in M1/M2. With `BILLING_PROVIDER=apple` (M3) the app buys through **StoreKit 2** and the server grants credits only after verifying Apple-signed transaction data. **Real Apple Sandbox, App Store Server API, Server Notifications delivery and TestFlight are NOT verified yet**: they need the owner's Apple Developer/App Store Connect setup ([`docs/m3-apple-setup.md`](docs/m3-apple-setup.md)). Rewarded ads remain a mock. There is no ad network, external analytics SDK or AI processing.

**Status:** M1 (PR #2) and M2 (PR #3) are merged. M3 is implemented locally on `m3-storekit-testflight` and awaits the owner's QA review.
- Evidence: [`docs/m1-verification.md`](docs/m1-verification.md), [`docs/m2-verification.md`](docs/m2-verification.md) and [`docs/m3-verification.md`](docs/m3-verification.md).
- Decisions: [`docs/decisions.md`](docs/decisions.md).

## Architecture

```
ios/ (SwiftUI, iOS 17+)  ──HTTP/JSON──►  backend/ (Node 24, TypeScript, Fastify)  ──►  PostgreSQL 16
  register/login/logout                    auth (scrypt, SHA-256 session tokens)        users, sessions
  wallet + history                         wallet / history / catalog                   bucket_balances (CHECK ≥ 0)
  operations + paywall                     purchases (mock BillingProvider)             credit_ledger (append-only)
  mock purchases                           operations (allocator, row locks)            purchases, operations (immutable)
  plan tab + trial                         subscriptions (mock provider, lifecycle)     subscriptions (state), periods,
  rewarded ads                             ads (mock provider, UTC daily cap)           events, trial_redemptions, revocations,
                                           analytics events + reports                   ad_rewards, analytics_events (immutable)
```

- **The backend is the system of record.** The app never computes or grants credits. Costs and pack sizes are decided by the server.
- **Four credit buckets** are spent in the fixed order **SUBSCRIPTION → CONSUMABLE → REWARD → PROMOTIONAL**. One operation may span buckets. Insufficient total credit rejects the whole operation (`402 INSUFFICIENT_CREDITS`) without debiting anything.
- **Integrity is enforced in the database** (migration `002`):
  - every ledger insert updates its balance in the same statement (balance = SUM(ledger)), and the non-negative CHECK rejects overdrafts
  - grants are allowed only for `APPROVED` purchases, at exactly the package amount
  - the ledger, purchases and operations can't be updated or deleted
- **Idempotency:** purchase `transactionId`, operation `requestId`, subscription `transactionId`/`requestId`, notification `eventId` and ad `adEventId`. An identical replay returns 200 with the original result; a conflicting replay returns 409.
- **Subscriptions (M2):**
  - The lifecycle rules are a pure, unit-tested module; each verified provider transaction becomes one immutable period.
  - Subscription credits never roll over. A renewal, upgrade, expiry or refund expires the remainder and records it in the ledger; nothing is ever deleted.
  - CONSUMABLE, REWARD and PROMOTIONAL credits are never touched by subscription events.
- **Business time:** the server clock decides periods and the rewarded-ad UTC day, never the device.

### API (M1)
| Method & path | Auth | Purpose |
|---|---|---|
| `POST /auth/register` | – | Create an account (email normalized, password 8–128 characters). 201, or 409 on a duplicate. |
| `POST /auth/login` | – | 200 `{ token, expiresAt, user }`. The session lasts 7 days (absolute). A wrong password and an unknown email give the identical 401. |
| `GET /me` | Bearer | Current user |
| `POST /auth/logout` | Bearer | Revoke the current session (204). A repeat logout returns 401. |
| `GET /catalog` | – | Credit packs, subscription previews (unavailable), ad preview (unavailable), operation costs |
| `GET /wallet` | Bearer | Four balances + total |
| `GET /history?limit=&before=` | Bearer | Itemized ledger, newest first |
| `GET /purchases` | Bearer | All purchase attempts, including declined/cancelled |
| `POST /purchases` | Bearer | `{ packageId, transactionId, mockOutcome: APPROVED\|DECLINED\|CANCELLED }` |
| `POST /operations` | Bearer | `{ action: BASIC\|STANDARD\|ADVANCED, requestId }`, costing 100 / 500 / 800 credits |
| `GET /subscriptions/current` | Bearer | Subscription status, entitlement, renewal/expiry date, trial eligibility. The trial message appears only when eligible. |
| `GET /subscriptions/history` | Bearer | Verified periods (granted/expired credits, revocations) and every lifecycle event |
| `POST /subscriptions/purchase` | Bearer | `{ planId: BASIC_WEEKLY\|PREMIUM_WEEKLY\|ULTRA_WEEKLY, transactionId, mockOutcome }`. Basic starts the 3-day / 1,000-credit trial if eligible. |
| `POST /subscriptions/change-plan` | Bearer | Upgrade now (new full allotment) or schedule a downgrade for the next renewal |
| `POST /subscriptions/cancel` / `resume` | Bearer | `{ requestId }`: turn auto-renew off or on. The entitlement lasts until the period end. |
| `POST /subscriptions/restore` | Bearer | Re-sync the authoritative state for this account |
| `POST /subscriptions/mock-notifications` | Bearer | **Mock provider** notifications: `{ eventId, type: RENEWED\|EXPIRED\|REFUNDED\|REVOKED, transactionId, periodStart? }` |
| `GET /ads/quota?action=` | Bearer | Today's UTC quota (10/day) and whether the ad is offered for that blocked action |
| `POST /ads/rewards` | Bearer | `{ adEventId, action, mockOutcome: COMPLETED\|INCOMPLETE\|FAILED }`. A verified completion grants +100 REWARD credits. |

Errors always have the shape `{ "error": { "code", "message" } }`.

M2 error codes:
- `ALREADY_SUBSCRIBED`, `NO_ACTIVE_SUBSCRIPTION`, `SAME_PLAN`, `AUTO_RENEW_DISABLED`
- `RENEWAL_NOT_DUE`, `PERIOD_NOT_ENDED`, `UNKNOWN_TRANSACTION`
- `TRANSACTION_CONFLICT`, `EVENT_CONFLICT`, `REQUEST_ID_CONFLICT`
- `DAILY_AD_LIMIT_REACHED` (429), `AD_NOT_ELIGIBLE` (409), `AD_EVENT_CONFLICT`

## Prerequisites
- Node.js **24.20.0** (`.nvmrc`)
- Docker Desktop (or another Docker engine with Compose)
- For iOS: an Xcode that supports your macOS. Verified on 2026-11-18 with Xcode 27.2 on macOS 27.2.1 (iPhone 17 / iOS 27.2 and iPhone 16 / iOS 18.3). Xcode 16.2's test runner fails on macOS 27.2.1, see `docs/m2-verification.md` §4.

## Run the backend locally
```bash
cd backend
npm ci
npm run db:up        # PostgreSQL 16.16 on 127.0.0.1:55432 (local-only credentials, not secrets)
npm run db:migrate   # applies pending migrations (001..005; additive, existing data is kept)
npm start            # API on http://127.0.0.1:3000
```
`npm run db:down` stops the database. The data volume is kept.

Optional demo credits for the non-consumable buckets (local only, refuses production and non-local DBs; there's no HTTP route for this):
```bash
npm run db:seed:demo -- --email you@example.test --subscription 200 --reward 400 --promotional 1000
```

## Run the tests
| Command (in `backend/`) | What it runs |
|---|---|
| `npm run typecheck` | Strict TypeScript |
| `npm run test:unit` | `node:test` unit tests: allocator, password hashing, tokens |
| `npm run test:integration` | `node:test` + PostgreSQL: schema constraints, migrations, money integrity (DV-001..003), API test harness |
| `npm run test:api` | Playwright HTTP API tests against the real server on a **disposable database** and an OS-assigned port (no browsers needed). A second server with a **controlled business clock** runs the time-dependent M2 spec (`lifecycle-time.spec.ts`). |
| `npm run test:*:ci` | The same tests plus JUnit XML (`test-results/`) and the Playwright HTML report |

Test isolation:
- Integration and API tests create throwaway databases (`monetalab_test_*`, `monetalab_api_test_*`) and drop them afterwards.
- The dev database and Docker volume are never modified by tests.
- Every test uses its own unique users.

Test names carry a category (`[BR]` business rule, `[INT]` integration, `[NEG]` negative/edge) and the PRD acceptance ID.

### Reproducing M2 time-dependent behavior
There is no HTTP endpoint for time.
- **Automated tests:** the harness gives the second server a temp file through `MONETALAB_TEST_CLOCK_FILE` and rewrites it.
- **Manual QA:**
  1. Run `E2E_TEST_CLOCK=1 npm run e2e:server`. It prints `E2E_CLOCK_FILE=<path>`.
  2. Write an ISO instant into that file, for example `echo 2031-01-08T00:00:00.000Z > <path>`, to move the server's business time. Then a renewal or expiry becomes due.
- **Safeguard:** the server refuses a clock file when `NODE_ENV=production`.

### Analytics report (local only)
```bash
npm run analytics:report -- --from 2026-11-01T00:00:00Z --to 2026-11-08T00:00:00Z
```
- Prints trial-to-paid conversion, paid churn and event counts.
- The churn formula is the PRD's **working definition** (open decision #10) and is not an approved KPI.
- The command refuses `NODE_ENV=production` and non-local databases.

## iOS app
```bash
open ios/MonetaLab.xcodeproj   # scheme MonetaLab
```
- Start the backend with `npm start` first. The simulator reaches it at `http://127.0.0.1:3000`. ATS allows local networking only.
- Override the URL with the launch environment variable `MONETALAB_API_BASE_URL`.

### Apple Sandbox notifications (local QA, owner approval required)
`npm run notifications:start` runs a separate **notification gateway** with only `POST /apple/notifications` on `127.0.0.1:3100` (rate-limited, 64 KB cap, verified Sandbox JWS only). Expose that port, never the main API, through an HTTPS tunnel, then check delivery with `npm run apple:test-notification`. Steps: `docs/m3-apple-setup.md` §5b.

### Physical iPhone (development only)
A device can't use `127.0.0.1` (that is the iPhone itself), and the backend binds loopback by default. On the same Wi-Fi:
1. Backend, bound to all interfaces (`API_HOST` is refused with `NODE_ENV=production`):
   ```bash
   cd backend && npm run db:up && npm run db:migrate
   API_HOST=:: npm start                          # mock billing; :: = IPv4 + IPv6 (needed for .local)
   # or, App Store Sandbox prices/purchases (Apple Root CA - G3 from apple.com/certificateauthority):
   API_HOST=:: BILLING_PROVIDER=apple APPLE_ENVIRONMENT=Sandbox APPLE_BUNDLE_ID=dev.monetalab.qa.MonetaLab \
     APPLE_ROOT_CERTIFICATES=/path/to/AppleRootCA-G3.cer npm start
   ```
   Check from the Mac: `curl http://$(scutil --get LocalHostName).local:3000/health`.
2. `cp ios/Config/Local.xcconfig.example ios/Config/Local.xcconfig` (git-ignored) and set `http://<LocalHostName>.local:3000` (`scutil --get LocalHostName`). Prefer it to the Wi-Fi IP, which can change. It applies to Debug **device** builds only; the Simulator and Release keep `127.0.0.1`.
3. Run the **MonetaLab** scheme on the iPhone. Allow **Local Network** access when iOS asks (otherwise: Settings → Privacy & Security → Local Network → MonetaLab).
4. If it still can't connect: same Wi-Fi (no guest/client isolation, VPN off), macOS firewall allows incoming connections for `node`, and (if you used an IP) it hasn't changed.

The backend serves plain HTTP on the LAN with no rate limiting (D-S3-09): use a trusted network and stop it afterwards. ATS allows only local-network HTTP (`NSAllowsLocalNetworking`); there is no arbitrary-loads exception.

**Flows:**
- register, sign in and sign out; the session persists in the Keychain
- wallet (four balances + total)
- credit and purchase history
- "Get Credits" mock purchases
- **Process** tab:
  1. choose Basic, Standard or Advanced, then **Run**, then **Confirm**
  2. on insufficient credits, the paywall opens with **Subscription | Credits** tabs
     - **Subscription:** the weekly plans. The trial message appears only when the server says you're eligible. Active subscribers can upgrade here.
     - **Credits:** packs.
     - **Below both:** *Watch an Ad — Earn 100 Credits*, with today's UTC quota. It's enabled only when the server says you're eligible.
  3. when a purchase or ad makes the balance sufficient, the paywall closes and you're back on the operation screen
  4. the operation is **never run automatically**: you confirm it again
- **Plan** tab:
  - status, renewal or end date, auto-renew, and a scheduled downgrade
  - subscribe, upgrade or downgrade; cancel or resume auto-renew; restore
  - **Mock provider test controls** (simulate renewal, expiry or refund). These are labelled test-only and are not App Store events.
- **Test-only mock outcome pickers:** purchases (Approved / Declined / Cancelled) and ads (Completed / Closed early / Failed to load).

### iOS tests
```bash
# Unit tests (view models, API mapping; no backend needed)
xcodebuild -project ios/MonetaLab.xcodeproj -scheme MonetaLab \
  -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:MonetaLabTests test

# UI journey against a REAL backend on a disposable database:
cd backend && npm run e2e:server      # prints E2E_API_BASE_URL=http://127.0.0.1:<port>; Ctrl-C cleans up
TEST_RUNNER_MONETALAB_API_BASE_URL=<that URL> xcodebuild -project ios/MonetaLab.xcodeproj -scheme MonetaLab \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
# On Xcode 27.2, 'name=iPhone 17' runs the same suite on iOS 27.2.
```
On iOS 26+ each UI journey waits for iOS's own "Save Password?" prompt after Create Account and answers "Not Now". This takes up to 90 s per journey; `docs/m2-verification.md` §4 explains why.

## Apple StoreKit 2 (M3)

**Environment modes** (every test and evidence item is labelled with one of these):

| Label | What it is | Who signs the data | Status here |
|---|---|---|---|
| MOCK | `BILLING_PROVIDER=mock` (default): M1/M2 deterministic providers | nobody (test-controlled outcomes) | tested |
| MOCK-SIGNED FIXTURES | `BILLING_PROVIDER=apple`, `APPLE_ENVIRONMENT=Sandbox`, trusting a throwaway test CA generated per test run | test CA (not Apple) | tested (API/DB) |
| XCODE STOREKIT | Xcode local StoreKit testing with `ios/MonetaLabTests/MonetaLab.storekit` | Xcode's local certificate | tested (iOS StoreKitTest); server path needs the pinned cert |
| APPLE SANDBOX | Sandbox account on a signed build, server with Apple Root CA - G3 | Apple | **BLOCKED** (no Apple account access) |
| TESTFLIGHT | uploaded build | Apple | **BLOCKED** |

**Flow:** the app gets the user's `appAccountToken` from `GET /billing/apple/account`, calls `Product.purchase(options: [.appAccountToken(token)])`, and sends the verified result's JWS to `POST /billing/apple/transactions`. The server verifies the signature chain, bundle id, environment and product, binds the purchase chain to that user, fulfills idempotently, and answers `finishTransaction`. Only then does the app call `Transaction.finish()`. Unfinished transactions are re-delivered at sign-in, on foreground and from `Transaction.updates`. App Store Server Notifications V2 arrive at the public `POST /apple/notifications` (signature-verified, idempotent). `npm run apple:reconcile -- --user <uuid>` recovers missed notifications from the App Store Server API.

**Products** (proposed App Store Connect ids, D-039; credits are decided by the server, prices by the App Store):

| Product id | Type | MonetaLab |
|---|---|---|
| `dev.monetalab.qa.credits.5000` / `.7000` / `.10000` | Consumable | CREDITS_S / M / L: 5,000 / 7,000 / 10,000 CONSUMABLE |
| `dev.monetalab.qa.sub.ultra.weekly` | Auto-renewable, group "MonetaLab Weekly", level 1 | ULTRA_WEEKLY: 12,000 SUBSCRIPTION per period |
| `dev.monetalab.qa.sub.premium.weekly` | level 2 | PREMIUM_WEEKLY: 6,000 |
| `dev.monetalab.qa.sub.basic.weekly` | level 3, 3-day free introductory offer | BASIC_WEEKLY: 3,000; trial 1,000 when Apple and the backend record agree (D-042) |

**Server configuration** (environment variables only; nothing secret is in Git):
```
BILLING_PROVIDER=apple
APPLE_ENVIRONMENT=Sandbox            # or Production (one per deployment; mismatches are refused) or Xcode (local only)
APPLE_BUNDLE_ID=dev.monetalab.qa.MonetaLab
APPLE_ROOT_CERTIFICATES=/secure/path/AppleRootCA-G3.cer   # download from https://www.apple.com/certificateauthority/
APPLE_APP_APPLE_ID=<numeric app id>  # required for Production
APPLE_ONLINE_CHECKS=true             # OCSP + current-date certificate checks (default)
APPLE_XCODE_CERTIFICATE=/path/StoreKitTestCertificate.cer  # Xcode mode only: Xcode > Editor > Save Public Certificate
# reconciliation CLI only:
APPLE_API_KEY_ID=...  APPLE_API_ISSUER_ID=...  APPLE_API_PRIVATE_KEY_PATH=/secure/path/AuthKey.p8
```

**Local StoreKit in Xcode (manual):** Edit Scheme → Run → Options → StoreKit Configuration → `MonetaLabTests/MonetaLab.storekit`. The prices in that file are **local test placeholders**, not proposed prices (PRD open decision #1). Local StoreKit data is signed by Xcode, not Apple: it is never proof of a real purchase.

**Test accounts:** none are stored anywhere in this repository. Sandbox testers are created by the owner in App Store Connect.

## CI
`.github/workflows/api-regression.yml` runs on every PR to `main` (required check **`api-db-regression`**):
1. `npm ci`, typecheck, migrations on a fresh `postgres:16.16-alpine` service
2. unit, integration and Playwright API tests
3. a job summary
4. an artifact with JUnit XML, the Playwright HTML report and logs

It uses read-only permissions, SHA-pinned official actions, no secrets and no deployment.
- In M2 the same job also runs the subscription, ad and controlled-clock specs, plus an analytics-report smoke step whose output goes into the artifact.
- In M3 the same job also starts an Apple-mode server and runs the signed-fixture specs (`tests/api/apple.spec.ts`) and M3 DB/unit tests. They need no Apple credentials: the test CA is generated per run.
- iOS isn't built in CI (see `docs/m3-verification.md` for why and what runs locally).

## Known limitations (local QA fixture only)
These are accepted for this local M1 fixture only (D-S3-09, D-021). They are **not acceptable for any public or production deployment**:
- no login rate limiting or account lockout
- `POST /auth/register` returns 409 for an existing email, which reveals that it exists
- plain HTTP, on localhost only
- expired and revoked sessions aren't cleaned up
- the database has no CHECK enforcing email normalization: the app normalizes emails and a case-insensitive unique index prevents duplicates (intentionally deferred, D-021)
- billing, subscriptions and ads are mock-only. The mock providers and the test clock file refuse to start with `NODE_ENV=production`.
- the mock provider notification route (`/subscriptions/mock-notifications`) lets an authenticated user simulate their **own** renewals, expiries and refunds. It exists only in mock mode; in Apple mode only signed App Store Server Notifications change state.
- trial eligibility: Apple decides it per Apple ID; the backend adds its own anti-duplication record. MonetaLab can't detect the same Apple ID across different app accounts (PRD §7 #9).
- Apple mode: consumable refunds are recorded without clawback (PRD §7 #2); billing grace period is not applied (PRD §7 #6); purchases made outside the app without MonetaLab's `appAccountToken` can't be claimed (PRD §7 #7). See D-040..D-046.

## M1 feature matrix
| PRD M1 requirement | Status |
|---|---|
| Create account, sign in/out, identify current user (AUTH-01) | Implemented + tested |
| Wallet with four buckets and itemized history | Implemented + tested |
| Mock consumable purchases: approved / declined / cancelled / duplicate (BUY-01..03) | Implemented + tested |
| Spend credits on 100/500/800 actions, ordered and atomic, blocking insufficient credit (CR-01..03) | Implemented + tested |
| Insufficient credit opens the paywall (Subscription \| Credits), return without auto-run (PW-01/02) | Implemented + tested (iOS) |
| API + DB tests and GitHub Actions PR regression (CI-01) | Implemented. The extended workflow still needs a GitHub run. |
| Basic iOS app exercising the core paths | Implemented + UI-tested on the simulator |
| **M2** Mock subscriptions: activation, renewal, cancellation, expiration, upgrade/downgrade, restore, refund (SUB-01..06) | Implemented + API/DB/unit tested |
| **M2** Basic 3-day / 1,000-credit trial, once per customer (TRIAL-01/02) | Implemented + tested (DB-enforced) |
| **M2** Rewarded ads: +100 REWARD, 10 per UTC day, duplicates and concurrency (ADS-01..04) | Implemented + tested (DB-enforced cap) |
| **M2** Lifecycle analytics events and conversion/churn reports (PRD §4) | Implemented + tested. The churn definition isn't approved. |
| **M2** iOS subscription, trial and ad flows | Implemented and tested: 36 unit + 3 UI tests pass on the simulator against the real backend (`docs/m2-verification.md` §4) |
| **M3** StoreKit 2 purchases, Transaction.updates, unfinished recovery, restore | Implemented; tested with fake StoreKit and Xcode StoreKitTest. Apple Sandbox **BLOCKED** |
| **M3** Server-side Apple JWS verification, ownership binding, idempotent fulfillment | Implemented; tested with signed fixtures (not Apple-signed) |
| **M3** App Store Server Notifications V2 + reconciliation | Implemented; tested with signed fixtures and a fake API. Real delivery/API **BLOCKED** |
| **M3** TestFlight | **BLOCKED** (no signing team or App Store Connect access) |

Full evidence, counts and every PASS / FAIL / NOT VERIFIED item: [`docs/m1-verification.md`](docs/m1-verification.md).

## Repository layout
```
backend/   src/ (auth, credits, billing incl. billing/apple, subscriptions, ads, analytics, db, http), migrations/, tests/{unit,integration,api,support}
ios/       MonetaLab.xcodeproj, MonetaLab/ (app, Billing/ = StoreKit 2), MonetaLabTests/ (incl. MonetaLab.storekit), MonetaLabUITests/, Config/Info.plist
docs/      plans, decision log, per-slice verification reports, m1-verification.md
```
