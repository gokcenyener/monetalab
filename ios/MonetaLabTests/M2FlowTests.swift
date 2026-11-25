import XCTest
@testable import MonetaLab

/// M2 client behavior: subscription tab, trial messaging, rewarded ads in the paywall, Plan tab actions, retries.
/// The fake API records every call, so tests prove what the client did NOT do (e.g. never re-run the operation).
@MainActor
final class M2FlowTests: XCTestCase {
    private var api: FakeAPI!
    private var counter = 0

    override func setUp() {
        api = FakeAPI()
        counter = 0
    }

    private func nextId() -> String { counter += 1; return "id-\(counter)" }

    private func blockedOperation(required: Int = 500, available: Int = 0) async -> OperationModel {
        let op = OperationModel(api: api, token: { "tok" }, onWallet: { _ in }, onUnauthenticated: {}, makeRequestId: { [unowned self] in nextId() })
        op.selected = FakeAPI.standard
        api.operationResults = [.failure(.insufficientCredits(required: required, available: available))]
        await op.confirmRun()
        XCTAssertNotNil(op.paywall)
        return op
    }

    private func paywall(action: String? = "STANDARD", required: Int? = 500) -> PaywallModel {
        PaywallModel(required: required, action: action, api: api, token: { "tok" }, onUnauthenticated: {}, makeTransactionId: { [unowned self] in nextId() })
    }

    // MARK: Rewarded ads (PRD §3.1, §3.2)

    func testAdIsOfferedOnlyWhenTheServerSaysEligibleAndNeverWithoutABlockedAction() async {
        let pw = paywall()
        await pw.load()
        XCTAssertTrue(pw.canWatchAd)
        XCTAssertEqual(pw.adQuota?.remaining, 10)

        api.defaultQuota = AdQuotaResponse(quota: FakeAPI.quota(used: 3), eligibility: FakeAPI.eligibility(false), wallet: FakeAPI.wallet(subscription: 600))
        await pw.load()
        XCTAssertFalse(pw.canWatchAd, "credits already sufficient: no ad (no ad farm)")

        let store = paywall(action: nil, required: nil)
        let callsBefore = api.quotaCalls
        await store.load()
        XCTAssertFalse(store.canWatchAd)
        XCTAssertEqual(api.quotaCalls, callsBefore, "the generic store never asks for ads")
    }

    func testAdSectionIsHiddenWhenTheServerHasNoAdNetwork() async {
        // API_EXPOSURE=tunnel (TestFlight QA): the server reports ADS_UNAVAILABLE and has no reward route.
        api.defaultQuota = AdQuotaResponse(quota: FakeAPI.quota(used: 0),
                                           eligibility: AdEligibility(action: "STANDARD", eligible: false, reason: "ADS_UNAVAILABLE", required: 500, available: 0),
                                           wallet: Wallet(balances: .zero, total: 0))
        let pw = paywall()
        await pw.load()
        XCTAssertFalse(pw.adsAvailable)
        XCTAssertFalse(pw.canWatchAd)
        api.defaultQuota = AdQuotaResponse(quota: FakeAPI.quota(used: 0), eligibility: FakeAPI.eligibility(true), wallet: Wallet(balances: .zero, total: 0))
        await pw.load()
        XCTAssertTrue(pw.adsAvailable, "local/mock servers keep the ad section")
    }

    func testCompletedAdThatCoversTheCostDismissesThePaywallWithoutRunningTheOperation() async {
        let op = await blockedOperation(required: 500, available: 400)
        let pw = paywall()
        await pw.load()
        api.adResults = [.success(FakeAPI.reward("REWARDED", wallet: FakeAPI.wallet(subscription: 400, reward: 100), used: 1))]
        api.quotaResults = [.success(AdQuotaResponse(quota: FakeAPI.quota(used: 1), eligibility: FakeAPI.eligibility(false), wallet: FakeAPI.wallet(subscription: 400, reward: 100)))]
        let wallet = await pw.watchAdTapped()
        XCTAssertEqual(wallet?.total, 500)
        XCTAssertTrue(op.paywallWalletChanged(wallet!), "PW-02: paywall closes")
        XCTAssertNil(op.paywall)
        XCTAssertEqual(api.runOperationCalls.count, 1, "PW-02: the blocked operation is NOT executed automatically")
        XCTAssertEqual(api.adCalls.map(\.outcome), [.completed])
        XCTAssertEqual(pw.adMessage, "Added 100 reward credits.")
        XCTAssertEqual(pw.adQuota?.used, 1)
    }

    func testIncompleteAdKeepsThePaywallOpenAndBalanceUnchanged() async {
        let op = await blockedOperation()
        let pw = paywall()
        await pw.load()
        pw.adOutcome = .incomplete
        api.adResults = [.success(FakeAPI.reward("NOT_REWARDED", wallet: Wallet(balances: .zero, total: 0), used: 0))]
        let wallet = await pw.watchAdTapped()
        XCTAssertFalse(op.paywallWalletChanged(wallet!), "PW-03: still insufficient, paywall stays")
        XCTAssertNotNil(op.paywall)
        XCTAssertEqual(pw.adMessage, "The ad was not completed. No credits were added.")
        XCTAssertEqual(api.adCalls.first?.outcome, .incomplete)
        XCTAssertTrue(pw.canWatchAd, "quota unchanged, still eligible")
    }

    func testDailyLimitFromServerShowsMessageAndDisablesTheAd() async {
        let pw = paywall()
        await pw.load()
        api.adResults = [.failure(.server(status: 429, code: "DAILY_AD_LIMIT_REACHED", message: "limit"))]
        api.quotaResults = [.success(AdQuotaResponse(quota: FakeAPI.quota(used: 10), eligibility: FakeAPI.eligibility(false, reason: "DAILY_LIMIT_REACHED"), wallet: Wallet(balances: .zero, total: 0)))]
        let wallet = await pw.watchAdTapped()
        XCTAssertNil(wallet)
        XCTAssertEqual(pw.adMessage, "You've reached today's limit of rewarded ads.")
        XCTAssertFalse(pw.canWatchAd, "ADS-03: UI disables the option")
        XCTAssertEqual(pw.adQuota?.remaining, 0)
        XCTAssertNil(pw.pendingAdEventId, "a definitive answer clears the id")
    }

    func testAdNetworkFailureReusesTheSameAdEventIdAndFreezesTheOutcomeWhileInFlight() async {
        let pw = paywall()
        await pw.load()
        let gate = Gate()
        api.adGate = gate
        api.adResults = [.failure(.transport("offline")), .success(FakeAPI.reward("REWARDED", wallet: FakeAPI.wallet(subscription: 0, reward: 100), used: 1))]
        let inFlight = Task { await pw.watchAdTapped() }
        while api.adCalls.isEmpty { await Task.yield() }
        pw.adOutcome = .failed
        XCTAssertEqual(pw.adOutcome, .completed, "outcome frozen while the ad request is in flight")
        let secondTap = await pw.watchAdTapped()
        XCTAssertNil(secondTap, "double tap ignored")
        gate.open()
        _ = await inFlight.value
        XCTAssertNotNil(pw.pendingAdEventId)
        _ = await pw.watchAdTapped()
        XCTAssertEqual(api.adCalls.count, 2)
        XCTAssertEqual(api.adCalls[0].adEventId, api.adCalls[1].adEventId, "ADS-04: retry is idempotent on the server")
    }

    // MARK: Subscription tab in the paywall

    func testTrialMessageIsShownOnlyWhenTheServerSaysEligible() async {
        let pw = paywall()
        await pw.load()
        XCTAssertEqual(pw.trialMessage, "Start a 3-day free trial with 1,000 credits.")
        api.subscriptionStateResult = .success(FakeAPI.state(nil, trial: FakeAPI.usedTrial))
        await pw.load()
        XCTAssertNil(pw.trialMessage, "TRIAL-02: no trial messaging after the trial was used")
    }

    func testTrialFromThePaywallCoversTheCostAndDismissesWithoutAutoRun() async {
        let op = await blockedOperation()
        let pw = paywall()
        await pw.load()
        pw.tab = .subscription
        pw.selectedPlanId = "BASIC_WEEKLY"
        api.subscriptionResults = [.success(FakeAPI.action("TRIAL_STARTED", sub: FakeAPI.subscription(), wallet: FakeAPI.wallet(subscription: 1000), credits: 1000))]
        let wallet = await pw.subscribeTapped(plans: FakeAPI.plans)
        XCTAssertEqual(api.subscriptionCalls.map(\.kind), ["purchase"])
        XCTAssertEqual(pw.message, "Free trial started. 1,000 credits added.".replacingOccurrences(of: "1,000", with: 1000.credits))
        XCTAssertNil(pw.trialMessage, "the response's trial info replaces the offer")
        XCTAssertTrue(op.paywallWalletChanged(wallet!))
        XCTAssertEqual(api.runOperationCalls.count, 1, "never auto-executes the blocked operation")
    }

    func testActiveSubscriberCanUpgradeFromThePaywallButNotDowngrade() async {
        api.subscriptionStateResult = .success(FakeAPI.state(FakeAPI.subscription(planId: "PREMIUM_WEEKLY", status: "ACTIVE"), trial: FakeAPI.usedTrial))
        let pw = paywall()
        await pw.load()
        pw.selectedPlanId = "BASIC_WEEKLY"
        let refused = await pw.subscribeTapped(plans: FakeAPI.plans)
        XCTAssertNil(refused)
        XCTAssertEqual(pw.message, "Downgrades take effect at your next renewal. Change plans on the Plan tab.")
        XCTAssertTrue(api.subscriptionCalls.isEmpty)

        pw.selectedPlanId = "ULTRA_WEEKLY"
        api.subscriptionResults = [.success(FakeAPI.action("UPGRADED", sub: FakeAPI.subscription(planId: "ULTRA_WEEKLY", status: "ACTIVE"), wallet: FakeAPI.wallet(subscription: 12000), credits: 12000))]
        let wallet = await pw.subscribeTapped(plans: FakeAPI.plans)
        XCTAssertEqual(api.subscriptionCalls.map(\.kind), ["change"], "an entitled customer upgrades instead of buying again")
        XCTAssertEqual(wallet?.total, 12000)
    }

    func testDeclinedSubscriptionLeavesThePaywallOpenAndRetryAfterNetworkFailureReusesTheTransaction() async {
        let op = await blockedOperation()
        let pw = paywall()
        await pw.load()
        pw.selectedPlanId = "PREMIUM_WEEKLY"
        pw.mockOutcome = .declined
        api.subscriptionResults = [.success(FakeAPI.action("DECLINED", sub: nil, trial: FakeAPI.eligibleTrial, wallet: Wallet(balances: .zero, total: 0)))]
        let declined = await pw.subscribeTapped(plans: FakeAPI.plans)
        XCTAssertFalse(op.paywallWalletChanged(declined!))
        XCTAssertTrue(pw.message?.hasPrefix("Payment declined.") ?? false)

        pw.mockOutcome = .approved
        api.subscriptionResults = [.failure(.transport("offline")),
                                   .success(FakeAPI.action("SUBSCRIPTION_STARTED", sub: FakeAPI.subscription(planId: "PREMIUM_WEEKLY", status: "ACTIVE"), wallet: FakeAPI.wallet(subscription: 6000), credits: 6000))]
        _ = await pw.subscribeTapped(plans: FakeAPI.plans)
        _ = await pw.subscribeTapped(plans: FakeAPI.plans)
        XCTAssertEqual(api.subscriptionCalls[1].id, api.subscriptionCalls[2].id, "same transaction id on retry")
        XCTAssertNotEqual(api.subscriptionCalls[0].id, api.subscriptionCalls[1].id, "a new attempt after a definitive answer gets a new id")
    }

    func testReopeningThePaywallReloadsStateAndQuotaEachTime() async {
        let op = await blockedOperation()
        for _ in 1...3 {
            let pw = paywall()
            await pw.load()
            pw.tab = .subscription
            pw.tab = .credits
            op.closePaywall()
            api.operationResults = [.failure(.insufficientCredits(required: 500, available: 0))]
            op.requestRun()
            await op.confirmRun()
        }
        XCTAssertEqual(api.quotaCalls, 3, "each presentation fetches a fresh quota (no stale state)")
        XCTAssertTrue(api.adCalls.isEmpty && api.subscriptionCalls.isEmpty, "navigation alone never buys or watches")
    }

    // MARK: Plan tab

    private func subscriptionModel(walletSink: @escaping (Wallet) -> Void = { _ in }) -> SubscriptionModel {
        SubscriptionModel(api: api, token: { "tok" }, onWallet: walletSink, onUnauthenticated: {}, makeId: { [unowned self] in nextId() })
    }

    func testRefreshShowsTheServersEntitlementIncludingAStaleOne() async {
        api.subscriptionStateResult = .success(FakeAPI.state(FakeAPI.subscription(status: "ACTIVE", entitled: false), trial: FakeAPI.usedTrial))
        var wallets: [Wallet] = []
        let model = subscriptionModel { wallets.append($0) }
        await model.refresh()
        XCTAssertEqual(model.subscription?.entitled, false)
        XCTAssertEqual(SubscriptionView.statusText(model.subscription!), "Period ended")
        XCTAssertNil(model.trial?.offer)
        XCTAssertEqual(wallets.count, 1, "the wallet is re-synced from the same server answer")
    }

    func testCancelKeepsEntitlementAndRetryAfterNetworkFailureReusesTheRequestId() async {
        let model = subscriptionModel()
        await model.refresh()
        api.subscriptionResults = [.failure(.transport("offline")),
                                   .success(FakeAPI.action("AUTO_RENEW_DISABLED", sub: FakeAPI.subscription(status: "ACTIVE", autoRenew: false), wallet: FakeAPI.wallet(subscription: 3000)))]
        await model.setAutoRenew(false)
        XCTAssertNotNil(model.errorMessage)
        await model.setAutoRenew(false)
        XCTAssertEqual(api.subscriptionCalls.map(\.id), ["id-1", "id-1"])
        XCTAssertEqual(model.subscription?.entitled, true, "cancellation keeps the paid entitlement")
        XCTAssertEqual(model.subscription?.autoRenew, false)
        XCTAssertEqual(model.message, "Auto-renew is off. You keep your plan and credits until the period ends.")
    }

    func testSimulatedNotificationTargetsTheCurrentTransactionAndShowsServerRejections() async {
        api.subscriptionStateResult = .success(FakeAPI.state(FakeAPI.subscription(status: "ACTIVE"), trial: FakeAPI.usedTrial))
        let model = subscriptionModel()
        await model.refresh()
        api.subscriptionResults = [.failure(.server(status: 409, code: "RENEWAL_NOT_DUE", message: "A renewal cannot start in the future"))]
        await model.simulate(.renewed)
        XCTAssertEqual(api.subscriptionCalls.first?.kind, "notify:RENEWED")
        XCTAssertEqual(api.subscriptionCalls.first?.planId, "tx-current")
        XCTAssertEqual(model.errorMessage, "A renewal cannot start in the future")
        XCTAssertNil(model.pending, "a definitive rejection clears the id")
    }

    func testPlanActionLabels() {
        let premium = FakeAPI.subscription(planId: "PREMIUM_WEEKLY", status: "ACTIVE", pending: "BASIC_WEEKLY")
        XCTAssertEqual(SubscriptionView.actionLabel(plan: FakeAPI.plans[2], current: premium, plans: FakeAPI.plans), "Upgrade")
        XCTAssertEqual(SubscriptionView.actionLabel(plan: FakeAPI.plans[0], current: premium, plans: FakeAPI.plans), "Scheduled")
        XCTAssertEqual(SubscriptionView.actionLabel(plan: FakeAPI.plans[0], current: nil, plans: FakeAPI.plans), "Subscribe")
    }
}
