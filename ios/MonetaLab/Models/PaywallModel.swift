import Combine
import Foundation

/// Paywall state: Subscription | Credits tabs (PRD §3.1), M2.
/// - Subscription tab: weekly plans through the backend's deterministic MOCK subscription provider. The trial message is
///   shown only when the server says this customer is eligible. An active subscriber can upgrade here.
/// - Credits tab: consumable packs through the mock billing provider.
/// - "Watch an Ad — Earn 100 Credits" (mock ad provider) is enabled only when the SERVER reports the customer eligible
///   for the blocked operation (insufficient credits, daily quota left). It is never offered without a blocked action.
/// The caller decides what happens with the returned wallet; this model never runs the blocked operation.
@MainActor
final class PaywallModel: ObservableObject {
    enum Tab: String, CaseIterable, Identifiable {
        case subscription = "Subscription", credits = "Credits"
        var id: String { rawValue }
    }

    @Published var tab: Tab = .credits
    /// Selections are frozen while a request is in flight: a pending idempotency id must stay bound to what was sent,
    /// so a retry after an unknown outcome stays idempotent on the server.
    /// (`@Published` re-runs `didSet` on a write-back inside the observer, so the revert is guarded.)
    @Published var selectedPackageId: String? {
        didSet {
            guard !isReverting, oldValue != selectedPackageId else { return }
            if isBusy { revert { selectedPackageId = oldValue } } else { pendingTransactionId = nil }
        }
    }
    @Published var selectedPlanId: String? {
        didSet {
            guard !isReverting, oldValue != selectedPlanId else { return }
            if isBusy { revert { selectedPlanId = oldValue } } else { pendingSubscriptionId = nil }
        }
    }
    @Published var mockOutcome: MockOutcome = .approved {
        didSet {
            guard !isReverting, oldValue != mockOutcome else { return }
            if isBusy { revert { mockOutcome = oldValue } } else { pendingTransactionId = nil; pendingSubscriptionId = nil }
        }
    }
    @Published var adOutcome: MockAdOutcome = .completed {
        didSet {
            guard !isReverting, oldValue != adOutcome else { return }
            if isBusy { revert { adOutcome = oldValue } } else { pendingAdEventId = nil }
        }
    }
    private var isReverting = false
    private func revert(_ body: () -> Void) {
        isReverting = true
        body()
        isReverting = false
    }
    @Published private(set) var isPurchasing = false
    @Published private(set) var isWatchingAd = false
    @Published private(set) var message: String?
    @Published private(set) var adMessage: String?
    @Published private(set) var subscriptionState: SubscriptionStateResponse?
    @Published private(set) var adQuota: AdQuota?
    @Published private(set) var adEligibility: AdEligibility?
    @Published private(set) var loadError: String?

    var isBusy: Bool { isPurchasing || isWatchingAd }

    /// StoreKit purchases (server BILLING_PROVIDER=apple). nil = the M1/M2 mock provider with its test controls.
    let storeKit: StoreKitPurchaseCoordinator?
    /// StoreKit's introductory-offer eligibility for Basic (StoreKit mode only).
    @Published private(set) var storeTrialEligible: Bool?
    var isStoreKit: Bool { storeKit != nil }

    let required: Int?
    /// The blocked operation (e.g. "STANDARD"). Ads are only offered in that context (PRD §3.1, §7 #5).
    let action: String?
    private let api: MonetaLabAPI
    private let token: () -> String?
    private let onUnauthenticated: () -> Void
    private let makeTransactionId: () -> String
    /// Reused only when an outcome is unknown (network failure), so the retry is idempotent on the server.
    private(set) var pendingTransactionId: String?
    private(set) var pendingSubscriptionId: String?
    private(set) var pendingAdEventId: String?
    /// Re-renders the paywall when StoreKit products arrive after it opened.
    private var storeKitChanges: AnyCancellable?

    init(required: Int?, action: String? = nil, api: MonetaLabAPI, token: @escaping () -> String?, onUnauthenticated: @escaping () -> Void,
         makeTransactionId: @escaping () -> String = { "ios-\(UUID().uuidString)" }, storeKit: StoreKitPurchaseCoordinator? = nil) {
        self.storeKit = storeKit
        self.required = required
        self.action = action
        self.api = api
        self.token = token
        self.onUnauthenticated = onUnauthenticated
        self.makeTransactionId = makeTransactionId
        storeKitChanges = storeKit?.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
    }

    /// StoreKit mode: true when StoreKit returned this App Store product (only then can it be shown or bought).
    func isAvailableInStore(packageId: String) -> Bool {
        guard let storeKit else { return true }
        return storeKit.storeProductID(packageId: packageId).map { storeKit.products[$0] != nil } ?? false
    }
    func isAvailableInStore(planId: String) -> Bool {
        guard let storeKit else { return true }
        return storeKit.storeProductID(planId: planId).map { storeKit.products[$0] != nil } ?? false
    }
    /// StoreKit mode: the last product request was empty, partial or failed.
    var storeProductsIncomplete: Bool { storeKit.map { $0.productReport?.isComplete != true } ?? false }

    /// Server-decided trial message, present only when eligible. With StoreKit it also needs Apple's eligibility for
    /// this Apple ID (D-042): both must agree before any trial messaging is shown (PRD §3.1).
    var trialMessage: String? {
        guard let message = subscriptionState?.trial.offer?.message else { return nil }
        if isStoreKit { return storeTrialEligible == true ? message : nil }
        return message
    }
    var currentSubscription: SubscriptionInfo? { subscriptionState?.subscription }
    var canWatchAd: Bool { action != nil && adEligibility?.eligible == true && !isBusy }
    /// false when the server has no ad network (API_EXPOSURE=tunnel, e.g. TestFlight): the ad section is hidden.
    var adsAvailable: Bool { adEligibility?.reason != "ADS_UNAVAILABLE" }

    /// Loads subscription state and (for a blocked action) the ad quota. Safe to call repeatedly (re-opened paywall).
    func load() async {
        guard let token = token() else { return }
        await storeKit?.loadProductsIfIncomplete()
        do {
            subscriptionState = try await api.subscriptionState(token: token)
            if let storeKit, let planId = subscriptionState?.trial.offer?.planId {
                storeTrialEligible = await storeKit.isEligibleForIntroOffer(planId: planId)
            }
            if let action {
                let quota = try await api.adQuota(token: token, action: action)
                adQuota = quota.quota
                adEligibility = quota.eligibility
            }
            loadError = nil
        } catch APIError.unauthenticated {
            onUnauthenticated()
        } catch {
            loadError = (error as? APIError)?.userMessage ?? error.localizedDescription
        }
    }

    /// Credits tab Continue: purchase the selected pack. Returns the server's wallet after the attempt.
    func continueTapped() async -> Wallet? {
        guard let packageId = selectedPackageId, let token = token(), !isBusy else { return nil }
        if let storeKit {
            guard let productID = storeKit.storeProductID(packageId: packageId) else {
                message = "This pack is not available in the App Store."
                return nil
            }
            return await buyWithStoreKit(storeKit, productID: productID)
        }
        isPurchasing = true
        message = nil
        defer { isPurchasing = false }
        let transactionId = pendingTransactionId ?? makeTransactionId()
        pendingTransactionId = transactionId
        do {
            let response = try await api.purchase(token: token, packageId: packageId, transactionId: transactionId, mockOutcome: mockOutcome)
            pendingTransactionId = nil
            switch response.purchase.outcome {
            case "APPROVED": message = "Added \(response.creditsGranted.credits) credits."
            case "CANCELLED": message = "Purchase cancelled. Your balance is unchanged."
            default: message = "Payment declined. Your balance is unchanged."
            }
            appendShortfall(response.wallet)
            await refreshAdEligibility()
            return response.wallet
        } catch APIError.unauthenticated {
            pendingTransactionId = nil
            onUnauthenticated()
        } catch APIError.transport(let detail) {
            message = APIError.transport(detail).userMessage
        } catch {
            pendingTransactionId = nil
            message = (error as? APIError)?.userMessage ?? error.localizedDescription
        }
        return nil
    }

    /// Subscription tab Continue: subscribe (trial when the server says eligible), or upgrade an active plan.
    func subscribeTapped(plans: [SubscriptionPlan]) async -> Wallet? {
        guard let planId = selectedPlanId, let plan = plans.first(where: { $0.id == planId }), let token = token(), !isBusy else { return nil }
        let current = currentSubscription.flatMap { sub in sub.entitled ? plans.first(where: { $0.id == sub.planId }) : nil }
        if let current, plan.tier <= current.tier {
            message = plan.id == current.id
                ? "You already have \(current.name)."
                : "Downgrades take effect at your next renewal. Change plans on the Plan tab."
            return nil
        }
        if let storeKit {
            // The App Store applies a higher tier in the same group as an immediate upgrade (SUB-03).
            guard let productID = storeKit.storeProductID(planId: plan.id) else {
                message = "This plan is not available in the App Store."
                return nil
            }
            return await buyWithStoreKit(storeKit, productID: productID)
        }
        isPurchasing = true
        message = nil
        defer { isPurchasing = false }
        let id = pendingSubscriptionId ?? makeTransactionId()
        pendingSubscriptionId = id
        do {
            let response = current == nil
                ? try await api.purchaseSubscription(token: token, planId: plan.id, transactionId: id, mockOutcome: mockOutcome)
                : try await api.changePlan(token: token, planId: plan.id, transactionId: id, mockOutcome: mockOutcome)
            pendingSubscriptionId = nil
            subscriptionState = SubscriptionStateResponse(subscription: response.subscription, trial: response.trial, wallet: response.wallet)
            message = SubscriptionModel.describe(response)
            appendShortfall(response.wallet)
            await refreshAdEligibility()
            return response.wallet
        } catch APIError.unauthenticated {
            pendingSubscriptionId = nil
            onUnauthenticated()
        } catch APIError.transport(let detail) {
            message = APIError.transport(detail).userMessage
        } catch {
            pendingSubscriptionId = nil
            message = (error as? APIError)?.userMessage ?? error.localizedDescription
        }
        return nil
    }

    /// Watch an Ad (mock). Only a server-verified completion grants 100 REWARD credits.
    func watchAdTapped() async -> Wallet? {
        guard let action, let token = token(), canWatchAd else { return nil }
        isWatchingAd = true
        adMessage = nil
        defer { isWatchingAd = false }
        let adEventId = pendingAdEventId ?? makeTransactionId()
        pendingAdEventId = adEventId
        do {
            let response = try await api.watchAd(token: token, adEventId: adEventId, action: action, mockOutcome: adOutcome)
            pendingAdEventId = nil
            adQuota = response.quota
            adMessage = response.result == "REWARDED"
                ? "Added \(response.creditsGranted.credits) reward credits."
                : "The ad was not completed. No credits were added."
            await refreshAdEligibility()
            return response.wallet
        } catch APIError.unauthenticated {
            pendingAdEventId = nil
            onUnauthenticated()
        } catch APIError.transport(let detail) {
            adMessage = APIError.transport(detail).userMessage
        } catch let APIError.server(_, code, message) {
            pendingAdEventId = nil
            adMessage = code == "DAILY_AD_LIMIT_REACHED" ? "You've reached today's limit of rewarded ads." : message
            await refreshAdEligibility()
        } catch {
            pendingAdEventId = nil
            adMessage = (error as? APIError)?.userMessage ?? error.localizedDescription
        }
        return nil
    }

    /// StoreKit purchase: the wallet comes only from the server's answer to Apple's signed transaction.
    private func buyWithStoreKit(_ storeKit: StoreKitPurchaseCoordinator, productID: String) async -> Wallet? {
        isPurchasing = true
        message = nil
        defer { isPurchasing = false }
        let outcome = await storeKit.buy(productID: productID)
        switch outcome {
        case let .delivered(response):
            subscriptionState = SubscriptionStateResponse(subscription: response.subscription, trial: response.trial, wallet: response.wallet)
            message = StoreKitPurchaseCoordinator.describe(response)
            appendShortfall(response.wallet)
            await refreshAdEligibility()
            return response.wallet
        case .pending:
            message = "Purchase pending approval. Credits are added after the App Store completes it."
        case .cancelled:
            message = "Purchase cancelled. Your balance is unchanged."
        case .deferred:
            // Kept unfinished in StoreKit and delivered again later (launch, foreground, Transaction.updates).
            message = "Your purchase is safe and will be added when the server can confirm it." 
        case let .rejected(_, text):
            message = text
        case let .failed(text):
            message = text
        }
        return nil
    }

    private func appendShortfall(_ wallet: Wallet) {
        if let required, wallet.total < required {
            message = (message ?? "") + " You still need \((required - wallet.total).credits) more credits."
        }
    }

    private func refreshAdEligibility() async {
        guard let action, let token = token() else { return }
        if let quota = try? await api.adQuota(token: token, action: action) {
            adQuota = quota.quota
            adEligibility = quota.eligibility
        }
    }
}
