# MonetaLab — M3 Verification Report

**Date:** 2026-11-19
**Branch:** `m3-storekit-testflight` (local; **not committed, not pushed, no PR**). Base: `main` @ `a41f7a7` (M2 merged via PR #3), fast-forwarded from `origin/main`.
**Scope:** PRD M3 (StoreKit 2, server-side Apple verification, App Store Server Notifications V2 and API, trial/plan/refund semantics on verified Apple data, consumables, local StoreKit configuration and tests, App Store Connect/Sandbox/TestFlight readiness), done in one continuous run as authorized. One consolidated owner QA review is pending.
**Environment:** macOS 27.2.1 (Apple Silicon); Xcode 27.2 (27B52); simulators iPhone 17 (iOS 27.2) and iPhone 16 (iOS 18.3.1); Node v24.20.0, npm 11.19.0; Docker `postgres:16.16-alpine`.

**Status labels:** **PASS** executed here with evidence · **FAIL** executed and failing · **NOT VERIFIED** not executed (reason given) · **BLOCKED** needs an external prerequisite the owner must provide.
**Environment labels:** **MOCK** (M1/M2 deterministic providers) · **SIGNED FIXTURES** (Apple's real verification code path, data signed by a per-run test CA, *not* Apple) · **XCODE STOREKIT** (Xcode local StoreKit testing, signed by Xcode's local certificate, *not* Apple) · **APPLE SANDBOX** · **TESTFLIGHT**.

Nothing below is PASS on code alone, and no local or fixture result is presented as Apple Sandbox evidence.

---

## 1. Automated results (all executed)

| # | Command | Env | Exit | Result |
|---|---|---|---|---|
| 1 | `npm run typecheck` | — | 0 | no errors (strict) |
| 2 | `npm run test:unit` | MOCK + SIGNED FIXTURES | 0 | **138 / 138** (M1/M2 104; new: `apple-verifier` 18, `apple-lifecycle` 16) |
| 3 | `npm run test:integration` | MOCK + SIGNED FIXTURES | 0 | **100 / 100** (M1/M2 92, incl. `migrations` updated for `004`; new: `m3-apple-integrity` 8) |
| 4 | `npm run test:api` (Playwright, 3 harness-owned servers: mock, mock + controlled clock, **apple/Sandbox trusting a per-run test CA**) | MOCK + SIGNED FIXTURES | 0 | **170 / 170** (M1/M2 145; new `apple.spec.ts` 25). Run **3×** on the final tree: 170/170 each time |
| 5 | CI reporters (`test:unit:ci`, `test:integration:ci`, `test:api:ci`) | same | 0 | JUnit: unit 138, integration 100, API 170 tests, 0 failures; `playwright-report/index.html` produced |
| 6 | Mutation checks (14 deliberate defects in the Apple code, §3) | — | — | **11 caught, 3 equivalent mutants** (explained) |
| 7 | `xcodebuild … build-for-testing` (app + unit + UI targets), Xcode 27.2 | — | 0 | `TEST BUILD SUCCEEDED`, **0 Swift warnings** |
| 8 | iOS unit tests (`-only-testing:MonetaLabTests`), iPhone 17 / iOS 27.2 | MOCK + XCODE STOREKIT | 0 | **57 total: 56 passed, 0 failed, 1 skipped** (M1/M2 36; `StoreKitCoordinatorTests` 12; `StoreKitTestSessionTests` 9, of which Ask to Buy SKIPPED, §4) |
| 9 | Full iOS suite (unit + UI) against the real disposable backend (`npm run e2e:server`, mock mode), iPhone 17 / iOS 27.2 | MOCK + XCODE STOREKIT | 0 | run A: **60 total: 59 passed, 0 failed, 1 skipped** (3/3 UI journeys). Final run B: see §1b |
| 10 | Real Xcode-signed transaction → Apple-mode server (`APPLE_ENVIRONMENT=Xcode`, pinned certificate) over HTTP | XCODE STOREKIT | — | **PASS**: 201 `FULFILLED` +5,000 CONSUMABLE; replay 200 `ALREADY_FULFILLED` (no second grant); another account 409 `APPLE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT` (§4) |

### 1b. Final full iOS run on the final tree
`xcodebuild … test` (build + all targets) against `npm run e2e:server` (mock mode, disposable DB, dropped afterwards), iPhone 17 / iOS 27.2, exit 0: **61 total: 60 passed, 0 failed, 1 skipped**.
- 58 unit: M1/M2 36, `StoreKitCoordinatorTests` 12, `StoreKitTestSessionTests` 10 (incl. the Xcode JWS header test; Ask to Buy skipped).
- 3 UI journeys (M1 purchase → paywall → explicit confirm; M2 ad + trial + cancel; wrong password): all passed.
- 0 Swift compiler warnings.
- Not re-run on iOS 18.3 in M3 (M2's 18.3 run predates these changes): **NOT VERIFIED** on iOS 18.3.

Diagnostic runs that failed or timed out while the StoreKitTest cases were being fixed (§4) are kept in the evidence folder; none of them is counted above.

## 2. Requirement-by-requirement matrix

### A. StoreKit 2 integration (iOS)
| Requirement | Status | Env | Evidence |
|---|---|---|---|
| Real StoreKit 2 purchase provider | **PASS** | XCODE STOREKIT | `AppleStoreClient` (`Product.products`, `product.purchase(options: [.appAccountToken])`, `Transaction.updates/unfinished/currentEntitlements`, `AppStore.sync`, `isEligibleForIntroOffer`, renewal info JWS); `StoreKitTestSessionTests` |
| Mock provider and deterministic M1/M2 regression preserved | **PASS** | MOCK | server default `BILLING_PROVIDER=mock`; the app switches to StoreKit only when `GET /billing/config` says `apple`; all M1/M2 unit and UI tests pass |
| Mock / Xcode StoreKit / Sandbox / production separated explicitly | **PASS** (design + tests) | all | one Apple environment per server, mismatches refused (unit + API); Xcode mode pinned and refused in production; mock refused in production |
| All Basic/Premium/Ultra weekly + 3 consumables | **PASS** | XCODE STOREKIT, SIGNED FIXTURES | `MonetaLab.storekit` (6 products, one group, levels 1–3); catalog test loads all 6; API grants 5,000/7,000/10,000 and 3,000/6,000/12,000 |
| Products from StoreKit; no hard-coded prices/strings | **PASS** | XCODE STOREKIT | paywall shows `displayPrice` from StoreKit; MonetaLab code has no prices; `.storekit` placeholder prices documented as local-only (D-039) |
| verified / unverified / pending / cancelled / failed | **PASS** (fake) / **PASS** (StoreKitTest: verified, failed) / **SKIPPED** (StoreKitTest Ask to Buy) | MOCK, XCODE STOREKIT | `StoreKitCoordinatorTests` (unverified never sent or finished; pending/cancelled call nothing); `testFailedTransactionsThrow…`; Ask to Buy §4 |
| Transaction.updates, current entitlements, restore/sync, purchases outside the app | **PASS** | XCODE STOREKIT + fake | `testTransactionUpdatesDeliversARenewal…` (forced renewal arrives via updates), `testAskToBuyApprovalArrivesThroughTransactionUpdates…`, `testRestoreSyncsThenDelivers…`. Purchases made outside the app **without** MonetaLab's token can't be claimed (D-040) |
| Finish only after durable server acceptance; no loss on network failure | **PASS** | fake + XCODE STOREKIT | finish only when `finishTransaction` is true; transport/5xx/not-started keep it unfinished; relaunch delivers it (`testNetworkFailureKeepsTheTransactionUnfinished…`, `testFinishAfterRelaunch…`, `testConsumablePurchase…StaysUnfinishedUntilFinished`) |
| Termination, foreground, interruption, duplicates, retries | **PASS** (unit) | fake | unfinished delivered at sign-in and on `scenePhase == .active`; duplicate delivery harmless (server idempotent) |
| Flows accessible from the paywall | **PASS** (unit) / **NOT VERIFIED** (UI in StoreKit mode) | fake | `PaywallModel` StoreKit path; a simulator UI journey in StoreKit mode was not automated (StoreKit's purchase sheet) |
| Never grant locally | **PASS** | fake | every wallet shown comes from the server response; tests assert no wallet change on deferred/rejected |

### B. Backend Apple transaction verification
| Requirement | Status | Env | Evidence |
|---|---|---|---|
| BillingProvider extended, mock kept | **PASS** | — | `BillingProvider = MockBillingProvider \| AppleBillingProvider` (D-038) |
| Apple JWS verification (official library) | **PASS** | SIGNED FIXTURES | `AppStoreSignedDataVerifier` = `SignedDataVerifier` with configured roots |
| Signature, chain, OIDs, dates, bundle, environment, product, ids | **PASS** | SIGNED FIXTURES | unit: forged signature, tampered payload, untrusted root, attacker leaf + trusted chain, missing Apple OIDs, expired leaf, alg none, short chain, wrong bundle, Sandbox↔Production↔Xcode mismatch, quantity, family sharing, unknown type; API: unknown product 422 |
| No client flag / unsigned JSON / forged JWS | **PASS** | SIGNED FIXTURES | API: `approved: true` or decoded JSON → 400; forged/unsigned → 400; DB unchanged |
| Ownership binding (appAccountToken) | **PASS** | SIGNED FIXTURES, XCODE STOREKIT | per-user token; immutable chain link + DB trigger; real Xcode transaction carried the server token |
| Cross-account replay / theft / restore reassignment prevented | **PASS** | SIGNED FIXTURES, XCODE STOREKIT | API: B before/after/concurrently with A → 409; same chain re-signed without token → 409; integration race of two users → one owner; Xcode e2e → 409 |
| Idempotency: transaction, original transaction, notification | **PASS** | SIGNED FIXTURES | replay/re-signed → no second grant; 10 concurrent → 1 grant; notification 8× concurrent → 1 effect |
| Transactional, append-only, concurrency-safe | **PASS** | — | per-user lock → bucket locks (D-031); immutable apple_* tables; balance = SUM(ledger) integration check |
| Four pools and priority preserved | **PASS** | SIGNED FIXTURES | journey spends CONSUMABLE after an Apple purchase; refund test keeps CONSUMABLE |
| Sandbox vs Production refused on mismatch | **PASS** | SIGNED FIXTURES | unit + API |
| Credentials from server env only | **PASS** | — | `config.ts`; diff scan clean (§5) |
| Real Apple server integration | **BLOCKED** | APPLE SANDBOX | B-001..B-004 (`docs/decisions.md`) |

### C. Server API and Notifications V2
| Requirement | Status | Env | Evidence |
|---|---|---|---|
| Notifications V2 ingestion | **PASS** | SIGNED FIXTURES | `POST /apple/notifications` |
| Outer + nested JWS verified before trust | **PASS** | SIGNED FIXTURES | API: forged outer → 400; **valid outer wrapping forged nested transaction or renewal info → 400, no record** (mutation #8 caught) |
| Lifecycle events: purchase, renewal, auto-renew, plan change, expiry, refund/revoke, resubscribe | **PASS** | SIGNED FIXTURES | SUBSCRIBED, DID_RENEW (via transaction), DID_CHANGE_RENEWAL_STATUS, renewal info downgrade, EXPIRED, REFUND, resubscribe after revoke (unit) |
| Billing retry / grace period | **PASS as recorded-only default** | SIGNED FIXTURES | `GRACE_PERIOD_NOT_APPLIED`, no credit change (D-046; PRD open decision #6) |
| Map to M2 without silently changing rules | **PASS** | — | D-041..D-043; shared `applyDecision` |
| Duplicate, delayed, missing, out-of-order | **PASS** | SIGNED FIXTURES | duplicates; late DID_RENEW → `IGNORED_SUPERSEDED`; missing → reconciliation |
| Order cannot restore a revoked entitlement or double-grant | **PASS** | SIGNED FIXTURES | API refund test + unit |
| Reconciliation via App Store Server API | **PASS** (logic, fake API) / **PASS** (real API, 2026-11-24) | SIGNED FIXTURES / APPLE SANDBOX | integration: missed renewal recovered, forged history entry rejected, rerun no-op. Real Sandbox: 10 missed renewals imported, no credits for ended periods, rerun no-op (§8). F-M3-01..03 fixed: fixture-verified and real-Sandbox-verified (§9) |
| Public endpoint, no origin trust, no backdoors | **PASS** | — | Apple-mode route table test (no mock/seed/grant/time/admin routes; no mock mutations) |
| Real delivery from Apple | **BLOCKED** | APPLE SANDBOX | no public HTTPS endpoint, no App Store Connect access (B-003) |

### D. Subscription and trial semantics
| Requirement | Status | Env | Evidence |
|---|---|---|---|
| 3,000 / 6,000 / 12,000 on verified periods | **PASS** | SIGNED FIXTURES | API upgrade/downgrade/renewal ledgers |
| 3-day trial, 1,000 credits only with authoritative eligibility + verified transaction | **PASS** | SIGNED FIXTURES, XCODE STOREKIT | TRIAL-01 API; StoreKitTest: Basic intro offer applied, Apple eligibility false afterwards |
| Apple eligibility in the group; backend anti-replay kept | **PASS** | SIGNED FIXTURES | TRIAL-02: second Apple trial → `TRIAL_STARTED_NOT_FUNDED`, 0 credits; DB: one funded trial per user |
| No claim that a new MonetaLab user resets Apple eligibility | **PASS** (docs + UI rule) | — | D-042; trial message requires both server and StoreKit eligibility |
| Upgrades/downgrades/renewal/cancel/expiry/refund on Apple dates | **PASS** | SIGNED FIXTURES | API SUB-01/03/04/05/06 tests; period not yet started → 409 |
| Expire/replenish at the effective transition, not the client clock | **PASS** | SIGNED FIXTURES | conversion test waits for Apple's trial end (5 s skew); mutation #3 caught |
| Consumable/reward balances preserved | **PASS** | SIGNED FIXTURES | upgrade and refund tests |
| Honest status/eligibility/renewal in SwiftUI | **PASS** (unit) | fake | StoreKit-mode copy; Manage Subscription sheet; mock controls hidden |
| Apple vs M2 discrepancies documented | **PASS** | — | D-041, D-043, D-048 |
| D-034/D-035/D-037 and open decisions not silently approved | **PASS** | — | D-040, D-045, D-046 mark PRD open decisions #2, #6, #7, #9 as still open |

### E. Consumables
| Requirement | Status | Env | Evidence |
|---|---|---|---|
| Three distinct consumable products | **PASS** | XCODE STOREKIT, SIGNED FIXTURES | |
| Server-side verification, exact amount once | **PASS** | SIGNED FIXTURES, XCODE STOREKIT | API + Xcode e2e |
| Persist before finishing | **PASS** | fake, XCODE STOREKIT | `finishTransaction` contract |
| Pending, cancellation, interruption, termination, restore limits | **PASS** (fake) / **SKIPPED** (StoreKitTest Ask to Buy) | | consumables are not restorable by `AppStore.sync`; recovery relies on unfinished delivery |
| Cross-user replay and concurrent duplicate fulfillment | **PASS** | SIGNED FIXTURES | API + integration |

### F. Xcode StoreKit configuration
| Requirement | Status | Evidence |
|---|---|---|
| Local configuration covering all products | **PASS** | `ios/MonetaLabTests/MonetaLab.storekit` (hand-authored, loaded successfully by `SKTestSession`) |
| Ids consistent with the proposed App Store Connect catalog | **PASS** | same ids as the server (`products.ts`) and `docs/m3-apple-setup.md` |
| Group, hierarchy, intro offer | **PASS** | levels Ultra 1 / Premium 2 / Basic 3; Basic `P3D` free |
| Deterministic local StoreKit tests in the test scheme | **PASS** | `SKTestSession(configurationFileNamed:)` in the unit-test bundle. The scheme's **Run** action is not changed (manual step in README; not verifiable headlessly) |
| StoreKitTest: purchase, renewal, upgrade, expiry, refund, failure, relaunch | **PASS** (Ask to Buy **SKIPPED**) | 9 cases, 8 passed + 1 skipped |
| Local StoreKit ≠ Sandbox | **PASS** | labels everywhere |

### G. App Store Connect, Sandbox, TestFlight
| Requirement | Status | Evidence / next action |
|---|---|---|
| Team, App Store Connect app | **BLOCKED** | 0 signing identities, no profiles, no Xcode account, no `DEVELOPMENT_TEAM` (B-001, B-002) |
| Bundle id, capabilities, product catalog | **Proposed** | `dev.monetalab.qa.MonetaLab`, In-App Purchase, D-039 catalog |
| Owner checklist | **PASS** | [`docs/m3-apple-setup.md`](m3-apple-setup.md) |
| No uploads / account changes / agreements / credentials | **PASS** | none performed |
| Signed build and TestFlight | **BLOCKED** | B-005. No claim that a TestFlight build exists |

### H. QA automation
| Requirement | Status | Evidence |
|---|---|---|
| Entire M1/M2 suite preserved and run | **PASS** | §1 rows 2–4, 8–9 |
| Unit: adapters, reconciliation, mapping, lifecycle | **PASS** | §1 |
| PostgreSQL: ownership, replay, ledger, refunds, concurrency | **PASS** | `m3-apple-integrity.test.ts` |
| Playwright with trusted signed fixtures and tampered cases | **PASS** | `apple.spec.ts` |
| Swift unit, StoreKitTest, simulator UI | **PASS** (UI journeys run in MOCK mode) | §1 rows 8–9 |
| Negative scenarios listed in the brief | **PASS** | unsigned, wrong bundle, wrong product, Sandbox/Production mismatch, expired certificate, forged signature, wrong account, replay, out-of-order, concurrent fulfillment |
| Full journey purchase → verification → grant → paywall dismissal → explicit confirmation | **PASS** (API: 402 → verified purchase → explicit operation; iOS: M1/M2 paywall journeys in MOCK) / **NOT VERIFIED** (one UI journey in StoreKit mode) | |
| Deterministic, no live Apple account needed | **PASS** | per-run test CA |
| CI job extended, name stable | **PASS locally / NOT VERIFIED on GitHub** | `api-db-regression` unchanged name; Apple specs run in the same job with no secrets |
| iOS CI job | **NOT ADDED** | no verified macOS runner with Xcode 27.2; the UI journey needs the backend; documented (D-047) |

## 3. Mutation checks (each applied to the file, the target suite run, the file restored from a backup)
| # | Defect | Result |
|---|---|---|
| 1 | Trial funded without the backend record | Caught |
| 2 | Introductory period gets the paid allotment (`credits` variable) | **Equivalent mutant**: the trial branch always sets its own credits; the variable only reaches audit-only SUPERSEDED periods, which never grant |
| 3 | Future period accepted (skew 1 day) | Caught |
| 4 | Out-of-order period applied | Caught |
| 5 | Consumable quantity check removed | Caught |
| 6 | Caller check removed (token path) | Caught |
| 7 | Caller check removed (link path) | First **not caught** (the concurrent test usually ordered B before A's link). Added a deterministic replay-after-link test → **caught** |
| 8 | Nested notification transaction not verified | Caught |
| 9 | Consumable already-fulfilled check removed | Caught (DB uniqueness + tests) |
| 10 | Notification "seen" check removed | **Equivalent mutant**: the unique `notificationUUID` insert still yields `DUPLICATE` |
| 11 | Second purchase chain allowed while entitled | Caught |
| 12 | Missing `appAccountToken` accepted for a caller | Caught |
| 13 | Renewal-info staleness ignored | Caught |
| 14 | Xcode verifier pin check skipped | **Equivalent mutant**: the signature is still checked with the pinned key, so another certificate fails anyway |

Test-design corrections made during the run (none weakens an assertion):
- the conversion test first sent a renewal while its own trial was still running; the server correctly answered `IGNORED_UNEXPECTED_OVERLAP`, so the test now waits for Apple's trial end;
- its expected expiry reason is `PERIOD_ENDED` (D-029: the trial had ended when the renewal arrived), not `SUPERSEDED`;
- the clock-skew tolerance was reduced from 60 s to 5 s (implementation change, stricter);
- the Apple-mode route test first forbade `GET /purchases` (read-only history); it now forbids only the mock mutations.

## 4. iOS / StoreKit details
- **StoreKitTest findings on Xcode 27.2 / iOS 27.2:**
  - `askToBuyEnabled`: `Product.purchase()` never returned (approval sheet not suppressed by `disableDialogs`). The case is **SKIPPED** with that reason; the pending path is covered with the fake StoreKit.
  - A simulated purchase error left set kept the hosted test process from exiting; teardown now clears it.
  - Refund and renewal events arrive asynchronously through `Transaction.updates`; a listener must subscribe before the trigger (updates are not replayed). Tests wait with bounds.
- **Real Xcode-signed data (XCODE STOREKIT → server):** the JWS header is `ES256` with **one** self-signed certificate `CN=StoreKit Testing in Xcode` (SHA-256 `6B:08:92:…:2E:06`). The backend `XcodePinnedVerifier` verified it; a forged signature and a wrong bundle were rejected. Then, over HTTP against an Apple-mode server (`APPLE_ENVIRONMENT=Xcode`, disposable DB, dropped afterwards): purchase bound to the server user's real `appAccountToken` → `201 FULFILLED` +5,000; replay → `200 ALREADY_FULFILLED`; another user → `409`. The pinned certificate for this run was taken from the transaction itself, which proves format and signature compatibility, **not** trust; a real setup pins the certificate exported from Xcode.
- **StoreKit warning in logs:** "Making a purchase without listening for transaction updates" appears in StoreKitTest cases that call the adapter directly. The app itself starts listening when Apple mode starts (after sign-in); transactions completed before sign-in stay unfinished in StoreKit and are delivered at sign-in.
- **Not automated:** a simulator UI journey in StoreKit mode (purchase sheet confirmation) — NOT VERIFIED.

## 5. Security and hygiene
- No Apple credentials, keys, certificates, profiles or tester accounts are in Git. Test CAs are generated at run time; the API harness keeps their keys in a temp directory deleted at teardown.
- Diff scan (paths, emails, private keys, `.p8/.p12/.cer/.der/.mobileprovision`, `.xcresult`, logs, large files): clean.
- In Apple mode: no mock purchase/subscription mutation routes, no seed/grant/time/admin routes (integration route-table test). The public notification route trusts only verified signatures.
- Xcode mode and the mock providers refuse `NODE_ENV=production`; Production requires `APPLE_APP_APPLE_ID`; OCSP online checks default on.
- New dependencies: `@apple/app-store-server-library` 3.1.0 (runtime, Apple, MIT), `jsrsasign` 11.1.5 (dev only). `npm audit --omit=dev`: 0 vulnerabilities.

## 6. Evidence locations (git-ignored, local only)
`local-evidence/m3-2026-11-19/`: iOS result bundles (unit and full runs), StoreKitTest logs, backend logs, the exported Xcode JWS check output, and `MANIFEST.md` with every bundle's `xcresulttool` summary. Not committed.

## 7. Known risks and limitations
- **Notification delivery and TestFlight are still BLOCKED** (no public HTTPS endpoint; no upload approved). Sandbox purchases and the App Store Server API were exercised on 2026-11-24 (§8); the matrix rows above that predate it still describe the fixture evidence.
- **Assumption not verified with Apple:** a renewal transaction's `purchaseDate` equals the start of its period (and is never meaningfully in the future). If Apple signs renewals earlier, they are refused with 409 and retried until effective (D-041).
- `offerDiscountType` must say `FREE_TRIAL` to fund the trial; payloads without it fund nothing (conservative).
- Purchases made outside the app without MonetaLab's token can't be claimed until an account-linking policy exists (PRD #7).
- Consumable refunds: no clawback (PRD #2). Grace period: not applied (PRD #6). `REFUND_REVERSED` does not restore (needs a decision).
- D-048: App Review's Sandbox purchases against a production server need a decision before submission.
- The iOS UI suite still depends on the iOS 26+ workarounds from M2 and isn't in CI.
- D-S3-09 local-fixture gaps (no rate limiting, plain HTTP) must be fixed before any public notification endpoint is deployed.

## 8. Real Apple Sandbox results (2026-11-24, APPLE SANDBOX)
Physical iPhone 17e (Debug build, team K77523YT8C), Sandbox tester, backend `BILLING_PROVIDER=apple APPLE_ENVIRONMENT=Sandbox` verifying against Apple Root CA - G3 (SHA-256 `63:34:3A:BF:…:91:79`), QA user `iphone-qa@monetalab.test`. Evidence: `local-evidence/apple-reconcile-2026-11-24/` (snapshots and both run reports; no keys, JWTs or signed payloads).

| Check | Status | Evidence |
|---|---|---|
| Consumables 5,000 / 7,000 / 10,000 bought in Sandbox and fulfilled once | **PASS** | 3 `apple_transactions` (CLIENT), 3 `PURCHASE_GRANT` (22,000); a duplicate delivery of the first answered `ALREADY_FULFILLED` |
| Basic Weekly free trial funded once, conversion renewal | **PASS** | TRIAL period 1,000 granted, expired `PERIOD_ENDED`; RENEWAL 3,000 granted |
| App Store Server API authorization (JWT with the In-App Purchase key) | **PASS** | Get Transaction History V2 and Get All Subscription Statuses: HTTP 200, `api.storekit-sandbox.apple.com` |
| Real signed history and renewal info verified by MonetaLab's verifier | **PASS** | 15/15 transactions + renewal info verified; every `appAccountToken` matched the QA user |
| Reconciliation imports missed renewals without granting ended periods | **PASS** | run 1: `apple_transactions` 5 → 15 (10 `SERVER_API`), `subscription_periods` 2 → 12, `RENEWED` ×10, no new `SUBSCRIPTION_GRANT` |
| Ended period's credits expire | **PASS** | one `SUBSCRIPTION_EXPIRATION` −3,000 `PERIOD_ENDED` on the 13:48–13:51 renewal; SUBSCRIPTION 3,000 → 0 |
| Consumables untouched | **PASS** | `ALREADY_FULFILLED` ×12; purchases 3; CONSUMABLE 21,900 |
| Balance = ledger sum, every bucket | **PASS** | before and after both runs |
| Re-run is a no-op | **PASS** | run 2: `IGNORED_DUPLICATE_TRANSACTION` ×48, `ALREADY_FULFILLED` ×12; database snapshot identical to run 1 |
| Renewal `purchaseDate` = start of period (D-041 assumption) | **Observed** | each renewal started at (or 1 s–60 s after) the previous `expiresDate` |
| Notifications V2 delivered by Apple | **BLOCKED** | no public HTTPS endpoint |

Apple reported the subscription expired (status 2, auto-renew off) after the Sandbox limit of 12 renewals; the last period ended 14:22:12 UTC, before reconciliation ran.

### Follow-up issues (found 2026-11-24; resolved in code 2026-11-24, see §9)
- **F-M3-01 Redundant history processing.** Get Transaction History returns the customer's whole app history for any transaction id, but `reconcileUserWithAppStore` fetches it once per linked chain. With 4 chains the 15 transactions were processed 60 times (idempotent, but 4× API calls, verifications and lock/transactions, and inflated report counts). Fix: fetch history once per user (from any one chain), then statuses per subscription chain.
- **F-M3-02 Stale `ACTIVE` subscription status.** Reconciliation applies transactions and renewal info but not Apple's status (2 = expired), so `subscriptions.status` stays `ACTIVE` after the last period ended. Credits are correct (the ended period expired `PERIOD_ENDED`; entitlement is judged by period dates), but the stored status, analytics and any status-based reporting are stale until an EXPIRED notification arrives. Fix candidate: apply the M2 EXPIRED rule when Apple's status is expired and the latest period has ended.
- **F-M3-03 Renewal info ignored when not entitled.** Apple's renewal info (auto-renew off) returned `IGNORED_NOT_ENTITLED`, so `auto_renew` stays `true` for the ended subscription. No credit effect; it should be decided together with F-M3-02.
- Note: imported ended periods show `credits = 3000` in `subscription_periods` (the plan allotment) although no ledger grant exists for them. The ledger is the source of truth; reports must not sum `subscription_periods.credits`.

## 9. F-M3-01..03 fixes (2026-11-24)
Code: `migrations/005_m3_apple_subscription_status.sql`, `src/billing/apple/{reconcile,service,lifecycle,routes,verifier}.ts`, `src/subscriptions/service.ts` (view). Decision: D-049 (proposed).

| Issue | Before (real Sandbox evidence, §8) | Fix | Verified (SIGNED FIXTURES) |
|---|---|---|---|
| F-M3-01 repeated history processing | 4 chains → 4 history walks + 4 status calls; 60 processing attempts for 15 transactions; report counts inflated | History and statuses are fetched once per App Store customer (a chain already seen in a fetched history is skipped); each transaction and each subscription chain is applied once per run; chains of another Apple account still get their own fetch. Report: `historyRequests`, `statusRequests`, `transactions` (unique), `subscriptionChains` | integration: 4 chains over 2 Apple accounts → 2 history + 2 status calls, `transactions` = 5 unique, a never-synced pack granted exactly once, rerun adds no rows. Mutation (skip removed) caught |
| F-M3-02 stale `ACTIVE` | Apple status 2 (expired); MonetaLab `status = ACTIVE` | Apple's status is applied per subscription chain (`decideAppleStatus`): EXPIRED for MonetaLab's current period after its end → M2 EXPIRED rule; BILLING_RETRY / GRACE_PERIOD recorded only (no extension, D-046); REVOKED recorded (revocation applied from the verified transaction); ACTIVE recorded. Stored in `apple_status`, newest Apple `signedDate` wins (reconciliation and status-bearing notifications) | unit: every status code, stale/duplicate, wrong transaction, not-yet-ended. integration: EXPIRED → `status EXPIRED`; billing retry keeps the lifecycle, ends entitlement, a recovered renewal applies as RENEWED; REVOKED; older status ignored. API: duplicate and older notifications change nothing. Mutation (no signedDate ordering) caught |
| F-M3-03 auto-renew not updated | Apple auto-renew OFF ignored (`IGNORED_NOT_ENTITLED`); `auto_renew = true` on an ended subscription | Newest verified renewal info is always recorded as Apple intent (`apple_auto_renew`, `apple_expiration_intent`); lifecycle/analytics/downgrades only while entitled. `auto_renew` stays MonetaLab's own state (false once ended, M2 constraint); no assumption that expired means auto-renew OFF | unit + integration + API: EXPIRED with Apple auto-renew ON (expirationIntent 2) → `auto_renew false`, `apple_auto_renew true`. Mutation (intent ignored) caught |

Expired credits cannot be spent: every spend path runs `reconcileUser` first (D-029); integration test spends after the period end and before any reconciliation → debit from CONSUMABLE only, SUBSCRIPTION expired `PERIOD_ENDED`. Ledger rows are only appended; balance = SUM(ledger) asserted in each new test.

Automated results on this tree: backend typecheck clean; unit **152/152**; integration **105/105**; API **171/171** (2 runs); iOS (iPhone 17 simulator, real backend in mock mode) **66: 65 passed, 1 skipped**, 3/3 UI journeys; `npm audit --omit=dev` 0. Changed expectation: the M3 unit test "ended subscriptions are ignored" now asserts the F-M3-03 rule (intent recorded, no lifecycle change); its stale/no-subscription cases are kept.

### Real Sandbox verification of the fixes (2026-11-24 15:25 UTC, APPLE SANDBOX, owner-approved)
Migration 005 applied to the persistent dev database (additive: 4 nullable columns + 2 checks on `subscriptions`; no row changed by it), dev backend restarted on this code, reconciliation run twice for `iphone-qa@monetalab.test`. Evidence: `local-evidence/apple-followups-2026-11-24/` (before/after snapshots, both run reports).

| Check | Before | After run 1 | After run 2 |
|---|---|---|---|
| Migrations | 001..004 | 001..005 | 001..005 |
| API calls (history / status) | (previous code: 4 / 4) | **1 / 1** | 1 / 1 |
| Report | (previous code: 60 transactions) | 15 unique: ALREADY_FULFILLED 3, IGNORED_DUPLICATE_TRANSACTION 12; `status:EXPIRED`; `renewal:RENEWAL_INTENT_RECORDED_AUTO_RENEW_OFF` | 15 unique; `status:APPLE_EXPIRED_RECORDED`; renewal intent re-recorded (same values) |
| `subscriptions.status` / `auto_renew` | ACTIVE / true | **EXPIRED / false** | EXPIRED / false |
| `apple_status` / `apple_auto_renew` / `apple_expiration_intent` | (columns absent) | **EXPIRED / false / 1** (customer cancelled) | EXPIRED / false / 1 |
| Apple transactions / periods / ledger rows | 15 / 12 / 8 | 15 / 12 / 8 (row-for-row identical) | 15 / 12 / 8 |
| Analytics events | 12 | 13 (+1 `subscription_expired`) | 13 |
| Balances SUBSCRIPTION / CONSUMABLE | 0 / 21,900 | 0 / 21,900 | 0 / 21,900 |
| Balance = SUM(ledger), all buckets | yes | yes | yes |

Run 2 changed only `apple_status_signed_at`, `apple_renewal_signed_at` and `updated_at` (Apple signs status data at request time; values identical). F-M3-01, F-M3-02 and F-M3-03: **PASS** (APPLE SANDBOX). Apple reported auto-renew OFF here, so `apple_auto_renew = false`; the auto-renew-ON-while-expired case is verified with signed fixtures only.

- Remaining limitations: Apple notifications still can't reach this machine (no public HTTPS); grace period and billing retry grant no extension (D-046 / PRD open decision #6); `REFUND_REVERSED` restores nothing.


## 10. Manual tests on the physical iPhone (USER-REPORTED, 2026-11-24)
Executed by the owner on the physical iPhone (Debug build, Sandbox backend, QA user `iphone-qa@monetalab.test`) after §9. These are **user-reported results**, not automated verification; Claude Code did not observe the device. Related automated coverage is listed for traceability only.

| ID | Test | Result | Reported by | Related automated coverage |
|---|---|---|---|---|
| MT-01 | Expired subscription is shown as expired in the app UI | **PASS (user-reported)** | owner | API `/subscriptions/current` → `status EXPIRED, entitled false` (§9; integration + API tests) |
| MT-02 | Expired subscription credits cannot be spent: a 100-credit operation used CONSUMABLE credits, not expired SUBSCRIPTION credits | **PASS (user-reported)** | owner | integration: spend after the period end before reconciliation debits CONSUMABLE only (§9) |

## 11. Notifications V2 hardening and isolated gateway (2026-11-24)
Code: `src/http/rate-limit.ts`, `src/billing/apple/routes.ts` (`registerAppleNotificationRoute`), `src/notifications-app.ts`, `src/notifications-server.ts` (`npm run notifications:start`), `src/billing/apple/test-notification{,-cli}.ts` (`npm run apple:test-notification`). Setup: `docs/m3-apple-setup.md` §5b. Decision: D-050 (proposed).

| Requirement | Status | Env | Evidence |
|---|---|---|---|
| Gateway exposes only `POST /apple/notifications` | **PASS** | SIGNED FIXTURES + local process | integration (route table, 9 other paths 404); real process on 127.0.0.1:3100: `/health`, `/auth/login` 404; not reachable on the LAN address |
| Only verified Apple **Sandbox** notifications change state | **PASS** | SIGNED FIXTURES | wrong signature, untrusted chain, tampered, unsigned, Production environment, wrong bundle, version 1.0, forged nested transaction → 400, no row, no ledger change; real process with Apple Root CA - G3 rejects a forged JWS |
| Size limit | **PASS** | SIGNED FIXTURES + local process | > 64 KB → 413 `PAYLOAD_TOO_LARGE` |
| Malformed requests | **PASS** | SIGNED FIXTURES | invalid/empty JSON, missing/extra field, non-JWS, wrong type → 400; form body → 415; errors carry only `{code, message}` |
| Rate limiting | **PASS** | SIGNED FIXTURES | per client (X-Forwarded-For from the local tunnel) and global; 429 + Retry-After; applied before parsing/verification |
| Replay protection | **PASS** | SIGNED FIXTURES | same notificationUUID → `DUPLICATE`, one row; future-dated (> 5 min) and > 7-day-old notifications → 400 after verification; 3-day Apple retry still accepted |
| Idempotency / out-of-order / immutable ledger | **PASS** | SIGNED FIXTURES | via the gateway: SUBSCRIBED grants once, duplicate and older DID_RENEW change nothing; existing API suite (171) unchanged |
| Test-notification flow (request + status + verify + DB check) | **PASS** (logic, fake API) / **NOT VERIFIED** (Apple) | SIGNED FIXTURES | verdicts DELIVERED_AND_RECORDED / DELIVERED_NOT_RECORDED / NOT_DELIVERED / NO_ATTEMPT_YET / PAYLOAD_NOT_VERIFIED; no JWS or token in output |
| Real Apple delivery (TEST notification) | **PASS** (2026-11-25) | APPLE SANDBOX | see §11a |

Mutation checks: removing the signedDate window, the rate-limit hook, or adding a `/health` route to the gateway each failed the gateway suite. Automated results: unit **160/160**, integration **118/118**, API **171/171** (2 runs), typecheck clean, `npm audit --omit=dev` 0. iOS not re-run (no iOS change).

Remaining limitations: the rate limiter is in-memory per process; a quick-tunnel URL is public and random per run (anyone who learns it can send requests, which are rejected unless Apple-signed for this app); D-S3-09 gaps remain for the main API, which must not be exposed.

### 11a. Real Apple Sandbox TEST notification (2026-11-25, APPLE SANDBOX, owner-approved)
Gateway on 127.0.0.1:3100 behind a temporary Cloudflare Quick Tunnel (`cloudflared` 2026.11.2, Developer ID Cloudflare Inc. 68WVV388M8); Sandbox Server URL set by the owner in App Store Connect; Production URL untouched. `npm run apple:test-notification`. Evidence: `local-evidence/notifications-2026-11-24/` (CLI reports, gateway log, tunnel log, before/after snapshots; no JWS, token or key).

| Check | Result |
|---|---|
| Attempt 1 (right after the owner saved the URL) | HTTP 404 `apiError 4040007` "No App Store Server Notification URL found" — not yet propagated; nothing sent |
| Attempt 2 (≈1 min later) | Apple send attempt **SUCCESS** at 2026-11-25T12:27:09Z |
| Gateway response | `POST /apple/notifications 200` (598 ms, includes OCSP online checks) |
| JWS verification | Verified against Apple Root CA - G3 by the gateway and again by the CLI (payloadVerified); environment Sandbox, bundle `dev.monetalab.qa.MonetaLab`, `version 2.0`, type TEST |
| PostgreSQL | one `apple_notifications` row `0df201e1-594f-487f-952f-c27357de33bb`, Sandbox, TEST, `user_id` NULL, result `RECORDED` |
| No billing effect | before/after identical: apple_transactions 15, periods 12, ledger 9 rows (unchanged ids/deltas), analytics 13, purchases 3; balances SUBSCRIPTION 0 / CONSUMABLE 21,800; subscription row unchanged (EXPIRED, Apple EXPIRED) |
| Teardown | tunnel and gateway stopped; public URL returns 530; port 3100 closed |

Notification **version: NOT VERIFIED for regular notifications.** App Store Connect showed no version selector. The TEST payload is V2 (`version 2.0`, signedPayload), but Apple's test notification is a V2 App Store Server API feature, so it does not prove which version regular notifications use. A V1 notification (unsigned JSON body without `signedPayload`) would be refused by the endpoint with 400 `VALIDATION_ERROR`; proof needs one real event (e.g. a Sandbox purchase or renewal) received as `version 2.0` while the URL is configured, or Apple's Get Notification History for it.

## 12. Plan transitions, TestFlight profile and preflight (2026-11-25)
**Expected behavior (PRD §2.1, SUB-01..06; D-041..D-046) — automated, SIGNED FIXTURES:** integration test `[BR][SUB-02..06] full plan ladder via the app path` (controlled clock, one purchase chain):

| Transition | Apple | MonetaLab (ledger) | Result |
|---|---|---|---|
| Basic → Premium | immediate upgrade (new transaction in the current period) | Basic remainder −3,000 `SUPERSEDED`, +6,000 | `UPGRADED` |
| Premium → Ultra | immediate upgrade | −6,000 `SUPERSEDED`, +12,000 | `UPGRADED` |
| Ultra → Premium requested | renewal info `autoRenewProductId` = Premium | no credit change; `pendingPlanId` PREMIUM | `DOWNGRADE_SCHEDULED` |
| (early renewal transaction) | — | refused 409 until the period starts | `APPLE_PERIOD_NOT_STARTED` |
| Ultra → Premium effective | renewal transaction at the period end | −12,000 `PERIOD_ENDED`, +6,000 | `RENEWED_DOWNGRADED` |
| Premium → Basic | requested, then effective at renewal | no change, then −6,000 `PERIOD_ENDED`, +3,000 | `DOWNGRADE_SCHEDULED`, `RENEWED_DOWNGRADED` |
| Cancel auto-renew | renewal info auto-renew off | entitlement and credits kept to the end | `AUTO_RENEW_DISABLED` |
| Expiration | period end passes | −3,000 `PERIOD_ENDED`; not entitled | — |
| Restore (same account) | same transactions re-delivered | no row changes | `IGNORED_DUPLICATE_TRANSACTION` |

Consumable credits unchanged throughout; balance = SUM(ledger). Remainders at a renewal expire `PERIOD_ENDED` (the period already ended, D-029); upgrades mid-period expire `SUPERSEDED`. **Real Apple behavior for these transitions: NOT VERIFIED** (physical checklist MT-03..MT-11, `docs/m3-apple-setup.md` §5c).

**Real Sandbox account (read-only API check 2026-11-25):** subscription group 22605242, Basic chain expired (status 2, auto-renew off), 15/15 transactions in the database. The same tester can resubscribe (same chain, already linked to the QA user); the Basic trial is no longer offered to this tester (already used; TRIAL-01 passed earlier). Group levels (Ultra 1, Premium 2, Basic 3) are to be confirmed by the Debug probe on the device (`groupLevel`).

**TestFlight profile `API_EXPOSURE=tunnel` (D-051):** Apple billing required (mock refused), no ad network (quota readable, always `ADS_UNAVAILABLE`; `POST /ads/rewards` not registered), loopback bind required, X-Forwarded-For trusted only from loopback, rate limits 120/min per client + 1,200/min global on every route and 10/min per client on `/auth/*`. Integration `m3-tunnel-exposure` (6 tests) + local process smoke (LAN bind refused, mock refused, `/purchases`, `/ads/rewards`, `/subscriptions/purchase` 404, 11th login/min → 429). iOS hides the ad section on `ADS_UNAVAILABLE` (unit test). Release builds take the API URL from `Config/Release.xcconfig` + git-ignored `Local.Release.xcconfig`.

**TestFlight preflight (`ios/scripts/testflight-preflight.sh`, archive only, no export/upload):** bundle id, version 0.1.0 (1), app icon (new placeholder `Assets.xcassets/AppIcon`, 1024 px, opaque), no arbitrary-loads ATS, Debug probe/diagnostics absent, no `.storekit` bundled, team K77523YT8C: PASS. API URL HTTPS: **FAIL until an approved HTTPS API tunnel exists**. No Apple Distribution identity on this Mac (needed to export). Upload: NOT DONE (needs owner approval).

Automated results (2026-11-25): backend typecheck clean; unit 160/160; integration 125/125; API 171/171; iOS 67 (66 passed, 1 skipped), 3/3 UI journeys; `npm audit --omit=dev` 0.
Incident: the PostgreSQL container exited cleanly (exit 0, not caused by these tests) during the run; restarted with `npm run db:up` (volume kept, all rows intact: 15 transactions, 12 periods, 9 ledger rows, 1 notification).

## 13. Real Sandbox subscription lifecycle with Notifications V2 (2026-11-25, APPLE SANDBOX) and F-M3-04
Physical iPhone 17e, Debug build, Sandbox tester, Sandbox renewal rate ≈ 10 min, notification gateway behind a Cloudflare Quick Tunnel (Sandbox URL set by the owner), QA user `iphone-qa@monetalab.test`, purchase chain `2000001270573557`. StoreKit probe on the device: group 22605242, **Ultra level 1, Premium 2, Basic 3**, all 7-day, Basic intro FreeTrial/3 days. Evidence: `local-evidence/notifications-2026-11-25/` (live-events.log, gateway.log, Apple notification history, snapshots; no JWS, token or key).

| ID | Step | Apple V2 notification (delivery) | First recorder of the transaction | MonetaLab result (ledger) | Status |
|---|---|---|---|---|---|
| MT-03 | Resubscribe Basic | SUBSCRIBED/RESUBSCRIBE (SUCCESS) | NOTIFICATION; app 2 s later → duplicate | SUBSCRIPTION_STARTED (+3,000) | **PASS** |
| MT-04 | Basic → Premium | DID_CHANGE_RENEWAL_PREF/UPGRADE (SUCCESS) | NOTIFICATION; app → duplicate | UPGRADED (−3,000 SUPERSEDED, +6,000) | **PASS** |
| MT-05 | Premium → Ultra | DID_CHANGE_RENEWAL_PREF/UPGRADE (SUCCESS) | NOTIFICATION; app → duplicate | UPGRADED (−6,000 SUPERSEDED, +12,000); Apple's pre-created Premium renewal (isUpgraded) → IGNORED_UPGRADED, no credits | **PASS** |
| MT-06 | Ultra → Premium requested | DID_CHANGE_RENEWAL_PREF/DOWNGRADE (SUCCESS) | — (renewal info) | DOWNGRADE_SCHEDULED, no ledger change | **PASS** |
| MT-07 | Renewal into Premium | DID_RENEW **refused 409** (UNSUCCESSFUL, 40 s early) | CLIENT, 9.5 min late | RENEWED_DOWNGRADED (−12,000 PERIOD_ENDED, +6,000) | **PASS (credits) / FAIL (notification delivery) → F-M3-04** |
| — | Further renewals 14:04:31, 14:14:31 | DID_RENEW **refused 409** (19-44 s early) | CLIENT (14:04:31); NOTIFICATION via DID_CHANGE_RENEWAL_STATUS (14:14:31) | RENEWED (+6,000 each) | F-M3-04 |
| MT-08/09 | Cancel auto-renew | DID_CHANGE_RENEWAL_STATUS/AUTO_RENEW_DISABLED (SUCCESS) | NOTIFICATION (recovered the missed 14:14:31 renewal) | RENEWED + AUTO_RENEW_DISABLED; auto-renew off (MonetaLab and Apple) | **PASS** |
| MT-10 (expiry) | Period end 14:24:31 | EXPIRED/VOLUNTARY (SUCCESS) | NOTIFICATION | EXPIRED (−6,000 PERIOD_ENDED) | **PASS (server); device check pending** |

Consumable credits stayed 21,800 throughout; balance = SUM(ledger) after every step; no grant was ever made before its period started. Apple's notification history (read-only API) for 13:32-14:24 UTC: 10 notifications; 6 SUCCESS; the 4 DID_RENEW (`3d64d7e2`, `50281230`, `dfa20565`, `096f3df4`) UNSUCCESSFUL_HTTP_RESPONSE_CODE, not yet retried by Apple at 14:38. Their transactions are all in the database (recovered by the app or by a later notification); the notification rows themselves are not, until Apple retries (now after the period start, so a retry is accepted as a duplicate).

### F-M3-04 Early renewal notifications refused (bug, root cause, fix)
- **Bug:** every real DID_RENEW arrived 19-44 s **before** its period started and was refused with 409 `APPLE_PERIOD_NOT_STARTED`; recovery depended on the app (once 9.5 min late, so the customer held that period's credits for 25 s) or on Apple's retries (≥ 1 h). The 5 s tolerance also granted one renewal 1 s early (14:04:30 for 14:04:31).
- **Root cause:** D-041 assumed renewals are delivered at or after their start and could be refused until effective. Disproven: Apple signs and notifies renewals ahead of the period (Sandbox: seconds; production billing can run further ahead).
- **Fix (migration 006, D-052 proposed):** a verified transaction whose period has not started is recorded (apple_transactions + `apple_scheduled_renewals`) and answered `202`/`200 RENEWAL_SCHEDULED` with `finishTransaction: true`; nothing is granted. It is applied through the normal verified path, exactly once, **only when `starts_at <= now`** (no clock tolerance; the 5 s skew is removed): by `reconcileUser` on any read/spend/lifecycle request for that user, and by a background sweeper (every 15 s, and at startup) in the API and the notification gateway, so it works with the app closed, no further notification, and after a restart. A schedule is resolved once (immutable afterwards): applied, superseded/upgraded/duplicate, refunded (`IGNORED_REVOKED_UNKNOWN`; defensively `REVOKED_BEFORE_START`), or `REJECTED_<code>`. iOS finishes a `RENEWAL_SCHEDULED` transaction and shows "Its credits are added when the new period starts."
- **Verification (SIGNED FIXTURES, disposable databases):** `m3-scheduled-renewals` (10 tests): DID_RENEW 40 s and 30 min early; 1 ms before the start still nothing; duplicate notification, second notification and app delivery before the start → one schedule; app before/after the start; sweeper with the app closed (second sweep no-op); fresh process after a "restart"; two periods missed while down (applied in order, only the running period funded); refund before the start; upgrade before the start; spends before/after the start; DB guards (no update after resolution, no delete, owner must match). Updated to the new rule: the unit test for not-started periods, the plan-ladder step and API SUB-01 (early delivery → 202, conversion on the next read). Mutation checks: 5 s early-grant tolerance, removed activation hook, no revocation check, no resolution on delivery — each caught. iOS unit test: RENEWAL_SCHEDULED is finished, grants nothing locally.
- Results: backend typecheck clean; unit 162/162; integration 135/135; API 171/171 (2 runs); iOS 68 (67 passed, 1 skipped), 3/3 UI journeys; `npm audit --omit=dev` 0.
- **Deployed (owner-approved, 2026-11-25 14:44 UTC):** migration 006 applied to the persistent dev database (additive; all existing rows identical before/after), dev API and gateway restarted on the fixed code; tunnel and Sandbox URL unchanged; both sweepers observed querying `apple_scheduled_renewals`.
- **Real Sandbox verification — MT-11 (APPLE SANDBOX, app fully closed after the purchase):** Basic resubscribed 15:23:29 UTC (SUBSCRIBED via notification, +3,000; app copies duplicates). Then, with the app closed (0 app submissions after 15:23:34):

| Renewal | DID_RENEW signed (Apple) | Period start (Apple) | Gateway | Stored result | Schedule resolved (sweeper) | Ledger |
|---|---|---|---|---|---|---|
| 1 `2000001271214852` | 15:33:06.826 (22.2 s early) | 15:33:29 | 200 | RENEWAL_SCHEDULED | 15:33:36.729 RENEWED (dev API sweeper) | −3,000 PERIOD_ENDED, +3,000 at 15:33:36 |
| 2 `2000001271218524` | 15:42:42.985 (46.0 s early) | 15:43:29 | 200 | RENEWAL_SCHEDULED | 15:43:36.762 RENEWED (dev API sweeper) | −3,000 PERIOD_ENDED, +3,000 at 15:43:36 |

| 3-11 | 15:52-17:12, 36-53 s early (one signed 1 s after its start → applied directly, RENEWED) | each +10 min | 200 | RENEWAL_SCHEDULED (8) / RENEWED (1) | 7-8 s after each start (dev API 5, gateway 5 overall) | one −3,000 PERIOD_ENDED, one +3,000 per period |

  Run totals (15:23-17:23 UTC, app closed throughout, 0 app submissions): 11 renewals; 10 scheduled before their start and applied automatically 7-8 s after it (both sweepers took part; never both for the same period); 1 applied on arrival; 12 grants for 12 periods (purchase + 11), 0 periods with more than one grant, 0 credits before a start, 0 unresolved schedules. The last DID_RENEW carried auto-renew OFF (Sandbox renewal limit; no cancellation was made), then EXPIRED/VOLUNTARY at 17:23:33 → status EXPIRED, −3,000 PERIOD_ENDED, Apple auto-renew false, expirationIntent 1. Final: SUBSCRIPTION 0, CONSUMABLE 21,800, balance = SUM(ledger). Every Apple delivery got HTTP 200 (the only gateway 4xx were the owner-approved forged-signature checks before MT-11).
  Acceptance: real DID_RENEW before the start **PASS** (10/10 early ones); gateway 200 + RENEWAL_SCHEDULED **PASS**; no credits before the start **PASS** (no ledger row between scheduling and start); automatic grant after the start without the app or another notification **PASS** (7-8 s after the start, sweeper log line); exactly one grant per period **PASS** (all 12 periods). Repeated app delivery: see MT-12 below.

- **MT-12 Restore Purchases on the physical iPhone (APPLE SANDBOX, owner-performed 2026-11-25 ≈19:23 UTC, after the subscription expired):**

| Evidence | Observed (real device, persistent dev database) |
|---|---|
| App deliveries | 11 `POST /billing/apple/transactions` between 19:23:01.074 and 19:23:13.691 UTC, 11 distinct signed transactions (distinct SHA-256 event keys), each `200 IGNORED_DUPLICATE_TRANSACTION` |
| New rows | 0 apple_transactions, 0 subscription_periods, 0 credit_ledger, 0 notifications |
| Duplicate grants | 0 subscription periods and 0 consumable purchases with more than one grant (whole database) |
| State after | subscription EXPIRED (Apple EXPIRED, auto-renew false); SUBSCRIPTION 0, CONSUMABLE 21,800; balance = SUM(ledger) for every bucket |

  Result: **PASS (observed)**. Limitation: the client-sync audit stores only a SHA-256 of the signed transaction (no payload), so the 11 re-delivered transactions are proven distinct and duplicates but are not named by transaction id; follow-up **F-M3-05**: **resolved in code (2026-11-25)** — the client-sync audit now also stores the verified, non-secret `environment`, `transactionId`, `originalTransactionId` and `productId` (no migration: `request` is JSONB; event key unchanged); regression test `[BR][F-M3-05]` in `m3-scheduled-renewals`. The MT-12 rows above were written before the fix. Fixture coverage of the same rule (separate, SIGNED FIXTURES): duplicate notification, second notification and app delivery before/after the start (`m3-scheduled-renewals`), restore with the same Apple ID (`[BR][SUB-02..06]` ladder), CR-03 concurrent deliveries (API).

