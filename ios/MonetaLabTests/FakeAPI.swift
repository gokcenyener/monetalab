import Foundation
@testable import MonetaLab

/// Scriptable in-memory API for view-model tests. It records every call so tests can prove what did NOT happen
/// (for example, that the operation was never re-run automatically).
final class FakeAPI: MonetaLabAPI {
    var wallet = Wallet(balances: .zero, total: 0)
    var operationResults: [Result<OperationResponse, APIError>] = []
    var purchaseResults: [Result<PurchaseResponse, APIError>] = []
    var meResult: Result<User, APIError> = .success(User(id: "u1", email: "qa@test.invalid", createdAt: "2026-11-17T00:00:00Z"))
    var loginResult: Result<LoginResponse, APIError> = .success(
        LoginResponse(token: "tok", expiresAt: "2026-11-24T00:00:00Z", user: User(id: "u1", email: "qa@test.invalid", createdAt: "2026-11-17T00:00:00Z")))

    private(set) var runOperationCalls: [(action: String, requestId: String)] = []
    private(set) var purchaseCalls: [(packageId: String, transactionId: String, outcome: MockOutcome)] = []
    private(set) var logoutCalls = 0
    private(set) var registerCalls = 0
    /// When set, purchase() suspends after recording the call until the gate is opened (simulates an in-flight request).
    var purchaseGate: Gate?

    func register(email: String, password: String) async throws -> User { registerCalls += 1; return try meResult.get() }
    func login(email: String, password: String) async throws -> LoginResponse { try loginResult.get() }
    func me(token: String) async throws -> User { try meResult.get() }
    func logout(token: String) async throws { logoutCalls += 1 }
    func catalog() async throws -> Catalog { Self.catalog }
    func wallet(token: String) async throws -> Wallet { wallet }
    func history(token: String) async throws -> [HistoryEntry] { [] }
    func purchases(token: String) async throws -> [PurchaseRecord] { [] }

    func purchase(token: String, packageId: String, transactionId: String, mockOutcome: MockOutcome) async throws -> PurchaseResponse {
        purchaseCalls.append((packageId, transactionId, mockOutcome))
        if let purchaseGate { await purchaseGate.wait() }
        let response = try purchaseResults.removeFirst().get()
        wallet = response.wallet
        return response
    }

    // MARK: M2 (scriptable; every call recorded)
    var subscriptionStateResult: Result<SubscriptionStateResponse, APIError> = .success(FakeAPI.state())
    var subscriptionResults: [Result<SubscriptionActionResponse, APIError>] = []
    var quotaResults: [Result<AdQuotaResponse, APIError>] = []
    var defaultQuota = AdQuotaResponse(quota: FakeAPI.quota(used: 0), eligibility: FakeAPI.eligibility(true), wallet: Wallet(balances: .zero, total: 0))
    var adResults: [Result<AdRewardResponse, APIError>] = []
    private(set) var subscriptionCalls: [(kind: String, planId: String?, id: String, outcome: String?)] = []
    private(set) var adCalls: [(adEventId: String, action: String, outcome: MockAdOutcome)] = []
    private(set) var quotaCalls = 0

    // MARK: M3 (scriptable; every call recorded)
    var billingProvider = "mock"
    var appleAccountResult: Result<AppleAccount, APIError> = .success(FakeAPI.appleAccount)
    var appleSyncResults: [Result<AppleTransactionResponse, APIError>] = []
    private(set) var appleSyncCalls: [(signedTransaction: String, signedRenewalInfo: String?)] = []
    private(set) var billingConfigCalls = 0

    func billingConfig() async throws -> BillingConfig { billingConfigCalls += 1; return BillingConfig(provider: billingProvider) }
    func appleAccount(token: String) async throws -> AppleAccount { try appleAccountResult.get() }
    func syncAppleTransaction(token: String, signedTransaction: String, signedRenewalInfo: String?) async throws -> AppleTransactionResponse {
        appleSyncCalls.append((signedTransaction, signedRenewalInfo))
        let response = try appleSyncResults.removeFirst().get()
        wallet = response.wallet
        return response
    }

    static let appleAccount = AppleAccount(
        environment: "Sandbox", bundleId: "dev.monetalab.qa.MonetaLab", appAccountToken: "6F9619FF-8B86-D011-B42D-00C04FC964FF",
        products: AppleProducts(
            subscriptionGroupName: "MonetaLab Weekly",
            consumables: ["CREDITS_S": "dev.monetalab.qa.credits.5000", "CREDITS_M": "dev.monetalab.qa.credits.7000", "CREDITS_L": "dev.monetalab.qa.credits.10000"],
            subscriptions: ["BASIC_WEEKLY": "dev.monetalab.qa.sub.basic.weekly", "PREMIUM_WEEKLY": "dev.monetalab.qa.sub.premium.weekly", "ULTRA_WEEKLY": "dev.monetalab.qa.sub.ultra.weekly"]))

    static func appleResponse(_ result: String, credits: Int, wallet: Wallet, finish: Bool = true, type: String = "CONSUMABLE") -> AppleTransactionResponse {
        AppleTransactionResponse(result: result, productType: type, transactionId: "1", creditsGranted: credits, finishTransaction: finish,
                                 subscription: nil, trial: FakeAPI.state().trial, wallet: wallet)
    }

    func subscriptionState(token: String) async throws -> SubscriptionStateResponse { try subscriptionStateResult.get() }
    func restoreSubscription(token: String) async throws -> SubscriptionStateResponse {
        subscriptionCalls.append(("restore", nil, "", nil))
        return try subscriptionStateResult.get()
    }
    private func nextSubscription() throws -> SubscriptionActionResponse {
        let response = try subscriptionResults.removeFirst().get()
        wallet = response.wallet
        return response
    }
    func purchaseSubscription(token: String, planId: String, transactionId: String, mockOutcome: MockOutcome) async throws -> SubscriptionActionResponse {
        subscriptionCalls.append(("purchase", planId, transactionId, mockOutcome.rawValue))
        return try nextSubscription()
    }
    func changePlan(token: String, planId: String, transactionId: String, mockOutcome: MockOutcome) async throws -> SubscriptionActionResponse {
        subscriptionCalls.append(("change", planId, transactionId, mockOutcome.rawValue))
        return try nextSubscription()
    }
    func setAutoRenew(token: String, enabled: Bool, requestId: String) async throws -> SubscriptionActionResponse {
        subscriptionCalls.append((enabled ? "resume" : "cancel", nil, requestId, nil))
        return try nextSubscription()
    }
    func mockNotification(token: String, eventId: String, type: MockNotificationType, transactionId: String) async throws -> SubscriptionActionResponse {
        subscriptionCalls.append(("notify:\(type.rawValue)", transactionId, eventId, nil))
        return try nextSubscription()
    }
    func adQuota(token: String, action: String?) async throws -> AdQuotaResponse {
        quotaCalls += 1
        return quotaResults.isEmpty ? defaultQuota : try quotaResults.removeFirst().get()
    }
    func watchAd(token: String, adEventId: String, action: String, mockOutcome: MockAdOutcome) async throws -> AdRewardResponse {
        adCalls.append((adEventId, action, mockOutcome))
        if let adGate { await adGate.wait() }
        let response = try adResults.removeFirst().get()
        wallet = response.wallet
        return response
    }
    var adGate: Gate?

    func runOperation(token: String, action: String, requestId: String) async throws -> OperationResponse {
        runOperationCalls.append((action, requestId))
        let response = try operationResults.removeFirst().get()
        wallet = response.wallet
        return response
    }

    static let standard = OperationOption(id: "STANDARD", name: "Standard processing", cost: 500)
    static let catalog = Catalog(
        consumables: [CreditPackage(id: "CREDITS_S", name: "Credits S", credits: 5000, available: true)],
        subscriptions: plans,
        rewardedAd: RewardedAdInfo(label: "Watch an Ad — Earn 100 Credits", credits: 100, dailyLimit: 10, available: true, availability: "mock"),
        operations: [standard])

    static let plans = [
        SubscriptionPlan(id: "BASIC_WEEKLY", name: "Basic", period: "WEEKLY", periodDays: 7, creditsPerPeriod: 3000, tier: 1,
                         introductoryOffer: .init(kind: "FREE_TRIAL", days: 3, credits: 1000), available: true, availability: "mock"),
        SubscriptionPlan(id: "PREMIUM_WEEKLY", name: "Premium", period: "WEEKLY", periodDays: 7, creditsPerPeriod: 6000, tier: 2,
                         introductoryOffer: nil, available: true, availability: "mock"),
        SubscriptionPlan(id: "ULTRA_WEEKLY", name: "Ultra", period: "WEEKLY", periodDays: 7, creditsPerPeriod: 12000, tier: 3,
                         introductoryOffer: nil, available: true, availability: "mock"),
    ]

    static let eligibleTrial = TrialInfo(eligible: true, reason: "FIRST_TIME_SUBSCRIBER", source: "BACKEND_RECORD",
                                         offer: .init(planId: "BASIC_WEEKLY", days: 3, credits: 1000, message: "Start a 3-day free trial with 1,000 credits."))
    static let usedTrial = TrialInfo(eligible: false, reason: "TRIAL_ALREADY_USED", source: "BACKEND_RECORD", offer: nil)

    static func subscription(planId: String = "BASIC_WEEKLY", status: String = "TRIAL", entitled: Bool = true, autoRenew: Bool = true, pending: String? = nil) -> SubscriptionInfo {
        SubscriptionInfo(id: "s1", planId: planId, planName: plans.first { $0.id == planId }!.name, status: status, entitled: entitled,
                         autoRenew: autoRenew, pendingPlanId: pending, renewsAt: autoRenew && entitled ? "2031-01-04T00:00:00.000Z" : nil,
                         expiresAt: "2031-01-04T00:00:00.000Z",
                         currentPeriod: SubscriptionPeriod(id: "p1", transactionId: "tx-current", planId: planId, kind: status == "TRIAL" ? "TRIAL" : "INITIAL",
                                                           startsAt: "2031-01-01T00:00:00.000Z", endsAt: "2031-01-04T00:00:00.000Z", credits: 1000))
    }

    static func state(_ sub: SubscriptionInfo? = nil, trial: TrialInfo = eligibleTrial, wallet: Wallet = Wallet(balances: .zero, total: 0)) -> SubscriptionStateResponse {
        SubscriptionStateResponse(subscription: sub, trial: trial, wallet: wallet)
    }

    static func action(_ result: String, sub: SubscriptionInfo?, trial: TrialInfo = usedTrial, wallet: Wallet, credits: Int? = nil) -> SubscriptionActionResponse {
        SubscriptionActionResponse(result: result, replayed: false,
                                   period: credits.map { SubscriptionPeriod(id: "p2", transactionId: "t", planId: sub?.planId ?? "BASIC_WEEKLY", kind: "TRIAL", startsAt: "a", endsAt: "b", credits: $0) },
                                   subscription: sub, trial: trial, wallet: wallet)
    }

    static func quota(used: Int) -> AdQuota {
        AdQuota(utcDay: "2031-01-01", used: used, limit: 10, remaining: 10 - used, resetsAt: "2031-01-02T00:00:00.000Z", rewardCredits: 100)
    }
    static func eligibility(_ eligible: Bool, reason: String? = nil) -> AdEligibility {
        AdEligibility(action: "STANDARD", eligible: eligible, reason: reason ?? (eligible ? "INSUFFICIENT_CREDITS" : "CREDITS_SUFFICIENT"), required: 500, available: 0)
    }
    static func reward(_ result: String, wallet: Wallet, used: Int) -> AdRewardResponse {
        AdRewardResponse(result: result, replayed: false, creditsGranted: result == "REWARDED" ? 100 : 0,
                         attempt: .init(id: "a1", adEventId: "ad", outcome: result == "REWARDED" ? "COMPLETED" : "INCOMPLETE", status: result, utcDay: "2031-01-01", credits: result == "REWARDED" ? 100 : 0),
                         quota: quota(used: used), wallet: wallet)
    }
    static func wallet(subscription: Int, reward: Int = 0) -> Wallet {
        Wallet(balances: Balances(subscription: subscription, consumable: 0, reward: reward, promotional: 0), total: subscription + reward)
    }

    static func wallet(consumable: Int) -> Wallet {
        Wallet(balances: Balances(subscription: 0, consumable: consumable, reward: 0, promotional: 0), total: consumable)
    }

    static func purchaseResponse(outcome: String, granted: Int, wallet: Wallet) -> PurchaseResponse {
        PurchaseResponse(purchase: PurchaseInfo(id: "p1", transactionId: "t1", packageId: "CREDITS_S", credits: 5000, outcome: outcome, createdAt: "now"),
                         creditsGranted: granted, replayed: false, wallet: wallet)
    }

    static func operationResponse(requestId: String, wallet: Wallet) -> OperationResponse {
        OperationResponse(operation: OperationResult(id: "o1", requestId: requestId, action: "STANDARD", cost: 500, createdAt: "now",
                                                     debits: Balances(subscription: 0, consumable: 500, reward: 0, promotional: 0),
                                                     result: .init(status: "COMPLETED", output: "simulated")),
                          replayed: false, wallet: wallet)
    }
}

/// A one-shot async gate for holding a fake request in flight.
@MainActor
final class Gate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var isOpen = false
    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func open() {
        isOpen = true
        continuation?.resume()
        continuation = nil
    }
}
