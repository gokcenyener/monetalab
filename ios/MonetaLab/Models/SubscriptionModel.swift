import Foundation

/// Subscription status and actions (M2, mock provider). The backend decides entitlement, periods, credits and trial
/// eligibility; this model only displays the server's answer and sends customer actions.
/// Retries: when an action's outcome is unknown (network failure) its idempotency id is kept and reused, so the server
/// can replay the original result instead of applying it twice.
@MainActor
final class SubscriptionModel: ObservableObject {
    @Published private(set) var state: SubscriptionStateResponse?
    @Published private(set) var isLoading = false
    @Published private(set) var isWorking = false
    @Published private(set) var message: String?
    @Published private(set) var errorMessage: String?
    /// Mock provider outcome for purchases and upgrades (test control, not a real App Store purchase).
    @Published var mockOutcome: MockOutcome = .approved {
        didSet { if oldValue != mockOutcome { pending = nil } }
    }

    private let api: MonetaLabAPI
    private let token: () -> String?
    private let onWallet: (Wallet) -> Void
    private let onUnauthenticated: () -> Void
    private let makeId: () -> String
    /// The in-doubt action and its id: reused only for an identical retry.
    private(set) var pending: (key: String, id: String)?

    init(api: MonetaLabAPI, token: @escaping () -> String?, onWallet: @escaping (Wallet) -> Void,
         onUnauthenticated: @escaping () -> Void, makeId: @escaping () -> String = { "ios-\(UUID().uuidString)" }) {
        self.api = api
        self.token = token
        self.onWallet = onWallet
        self.onUnauthenticated = onUnauthenticated
        self.makeId = makeId
    }

    /// Set when the server runs BILLING_PROVIDER=apple (M3). Plan changes then go through the App Store; auto-renew is
    /// managed in Apple's subscription settings, and the mock provider test controls are not shown.
    var storeKit: StoreKitPurchaseCoordinator?

    var subscription: SubscriptionInfo? { state?.subscription }
    var trial: TrialInfo? { state?.trial }

    /// Always re-reads the server state, so a stale entitlement (e.g. a period that ended while the app was in the
    /// background) is never shown as active.
    func refresh() async {
        guard let token = token() else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let fresh = try await api.subscriptionState(token: token)
            state = fresh
            onWallet(fresh.wallet)
            errorMessage = nil
        } catch {
            handle(error, clearPending: false)
        }
    }

    func restore() async {
        guard let token = token(), !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        if let storeKit {
            // AppStore.sync() + current entitlements, each verified and applied by the server. Another account's
            // purchases are refused by the server (no restore reassignment, D-040).
            _ = await storeKit.restore()
            message = storeKit.lastMessage
        }
        do {
            let fresh = try await api.restoreSubscription(token: token)
            state = fresh
            onWallet(fresh.wallet)
            message = "Purchases restored from the server."
            errorMessage = nil
        } catch {
            handle(error, clearPending: false)
        }
    }

    func purchase(planId: String) async {
        if let storeKit { return await buyWithStoreKit(storeKit, planId: planId) }
        await run(key: "purchase:\(planId):\(mockOutcome.rawValue)") { token, id in
            try await self.api.purchaseSubscription(token: token, planId: planId, transactionId: id, mockOutcome: self.mockOutcome)
        }
    }

    func changePlan(to planId: String) async {
        // App Store: a higher tier upgrades now; a lower tier is scheduled by Apple for the next renewal (SUB-04/05).
        if let storeKit { return await buyWithStoreKit(storeKit, planId: planId) }
        await run(key: "change:\(planId):\(mockOutcome.rawValue)") { token, id in
            try await self.api.changePlan(token: token, planId: planId, transactionId: id, mockOutcome: self.mockOutcome)
        }
    }

    func setAutoRenew(_ enabled: Bool) async {
        await run(key: "autoRenew:\(enabled)") { token, id in
            try await self.api.setAutoRenew(token: token, enabled: enabled, requestId: id)
        }
    }

    /// Test control: asks the MOCK provider to deliver a lifecycle notification for the current period.
    func simulate(_ type: MockNotificationType) async {
        guard let transactionId = subscription?.currentPeriod.transactionId else { return }
        await run(key: "notify:\(type.rawValue):\(transactionId)") { token, id in
            try await self.api.mockNotification(token: token, eventId: id, type: type, transactionId: transactionId)
        }
    }

    private func buyWithStoreKit(_ storeKit: StoreKitPurchaseCoordinator, planId: String) async {
        guard let productID = storeKit.storeProductID(planId: planId), !isWorking else { return }
        isWorking = true
        message = nil
        errorMessage = nil
        defer { isWorking = false }
        if case let .rejected(_, text) = await storeKit.buy(productID: productID) { errorMessage = text }
        message = storeKit.lastMessage
        isWorking = false
        await refresh()
    }

    private func run(key: String, _ action: @escaping (String, String) async throws -> SubscriptionActionResponse) async {
        guard let token = token(), !isWorking else { return }
        isWorking = true
        message = nil
        errorMessage = nil
        defer { isWorking = false }
        let id = pending?.key == key ? pending!.id : makeId()
        pending = (key, id)
        do {
            let response = try await action(token, id)
            pending = nil
            state = SubscriptionStateResponse(subscription: response.subscription, trial: response.trial, wallet: response.wallet)
            onWallet(response.wallet)
            message = Self.describe(response)
        } catch {
            handle(error, clearPending: true)
        }
    }

    private func handle(_ error: Error, clearPending: Bool) {
        switch error as? APIError {
        case .unauthenticated?:
            pending = nil
            onUnauthenticated()
        case .transport?:
            // Outcome unknown: keep the id for an idempotent retry.
            errorMessage = (error as? APIError)?.userMessage
        default:
            if clearPending { pending = nil }
            errorMessage = (error as? APIError)?.userMessage ?? error.localizedDescription
        }
    }

    static func describe(_ r: SubscriptionActionResponse) -> String {
        let credits = r.period.map { " \($0.credits.credits) credits added." } ?? ""
        switch r.result {
        case "TRIAL_STARTED": return "Free trial started.\(credits)"
        case "SUBSCRIPTION_STARTED": return "Subscription started.\(credits)"
        case "UPGRADED": return "Upgraded. Unused subscription credits were replaced.\(credits)"
        case "DOWNGRADE_SCHEDULED": return "Downgrade scheduled for your next renewal. Your credits do not change now."
        case "DOWNGRADE_CANCELLED": return "Scheduled downgrade cancelled."
        case "AUTO_RENEW_DISABLED": return "Auto-renew is off. You keep your plan and credits until the period ends."
        case "AUTO_RENEW_ENABLED": return "Auto-renew is on again."
        case "TRIAL_CONVERTED", "RENEWED", "RENEWED_DOWNGRADED": return "Renewed. Unused subscription credits expired.\(credits)"
        case "EXPIRED": return "Subscription expired. Unused subscription credits expired."
        case "REVOKED_CURRENT", "REVOKED_PAST_PERIOD": return "Refund processed. Remaining subscription credits were removed."
        case "DECLINED": return "Payment declined. Nothing changed."
        case "CANCELLED": return "Purchase cancelled. Nothing changed."
        default: return r.replayed ? "Already processed." : "No change (\(r.result))."
        }
    }
}
