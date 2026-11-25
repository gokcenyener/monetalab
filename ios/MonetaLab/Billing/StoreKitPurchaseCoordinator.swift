import Foundation
import os

/// StoreKit purchase flow for BILLING_PROVIDER=apple (M3, D-038/D-044).
///
/// Rules this type enforces:
/// 1. Never grant locally: StoreKit's result is only forwarded (as Apple's signed JWS) to the server, and every balance
///    shown comes back from the server.
/// 2. Finish a transaction ONLY when the server answered `finishTransaction: true` (durably fulfilled, already
///    fulfilled, or definitively nothing to deliver). On a network failure or server error the transaction stays
///    unfinished; StoreKit keeps it in `Transaction.unfinished`, and it is delivered again on the next launch, on
///    foreground, or when `Transaction.updates` reports it. The server is idempotent, so redelivery is safe.
/// 3. Unverified transactions are never sent as proof of purchase and never finished.
/// 4. Purchases are bound to the MonetaLab account with Apple's appAccountToken from the server.
@MainActor
final class StoreKitPurchaseCoordinator: ObservableObject {
    enum Outcome: Equatable {
        /// The server fulfilled (or replayed) it; the wallet is the server's.
        case delivered(AppleTransactionResponse)
        /// Ask to Buy or another approval is outstanding. Nothing was charged or granted yet.
        case pending
        case cancelled
        /// Kept unfinished for a later retry (network/server unavailable).
        case deferred(String)
        /// The server refused it (e.g. another account's purchase). Kept unfinished; nothing granted.
        case rejected(code: String, message: String)
        case failed(String)
    }

    @Published private(set) var account: AppleAccount?
    /// StoreKit `Product` data, keyed by App Store product id. Only what StoreKit returned: the backend catalog
    /// (names, credits) is separate and never supplies a price.
    @Published private(set) var products: [String: StoreProduct] = [:]
    /// Result of the last `Product.products(for:)` request (product ids only; no account data).
    @Published private(set) var productReport: ProductLoadReport?
    @Published private(set) var lastMessage: String?
    /// Transactions the server has not accepted yet (still unfinished in StoreKit).
    @Published private(set) var undelivered: Set<String> = []

    private let api: MonetaLabAPI
    private let store: StoreClient
    private let token: () -> String?
    private let onWallet: (Wallet) -> Void
    private let onUnauthenticated: () -> Void
    private var updatesTask: Task<Void, Never>?
    private(set) var finishedIDs: [String] = []

    init(api: MonetaLabAPI, store: StoreClient, token: @escaping () -> String?, onWallet: @escaping (Wallet) -> Void,
         onUnauthenticated: @escaping () -> Void) {
        self.api = api
        self.store = store
        self.token = token
        self.onWallet = onWallet
        self.onUnauthenticated = onUnauthenticated
    }

    deinit { updatesTask?.cancel() }

    /// Loads the account binding and localized products, starts listening for transaction updates, and delivers any
    /// transaction left unfinished by an earlier run (app terminated, network down). Safe to call again (foreground).
    func start() async {
        guard let token = token() else { return }
        do {
            account = try await api.appleAccount(token: token)
        } catch APIError.unauthenticated {
            onUnauthenticated()
            return
        } catch {
            lastMessage = "The App Store products could not be loaded. \((error as? APIError)?.userMessage ?? "")"
        }
        await loadProducts()
        if updatesTask == nil {
            let stream = store.transactionUpdates()
            updatesTask = Task { [weak self] in
                for await event in stream {
                    guard let self else { return }
                    _ = await self.deliver(event)
                }
            }
        }
        await deliverUnfinished()
    }

    /// Requests every product id the backend maps (consumables + subscriptions) from StoreKit. StoreKit returns an
    /// empty or partial array, not an error, for ids it can't find (TN3186), so the report lists what is missing.
    /// Products loaded earlier are kept if a later request fails.
    func loadProducts() async {
        guard let account else { return }
        let ids = Set(account.products.consumables.values).union(account.products.subscriptions.values).sorted()
        do {
            let returned = try await store.products(ids: ids).filter { ids.contains($0.id) }
            products = Dictionary(returned.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            productReport = ProductLoadReport(requested: ids, returned: products.keys.sorted(), error: nil)
        } catch {
            productReport = ProductLoadReport(requested: ids, returned: [], error: String(describing: error))
        }
        StoreKitDiagnostics.log(productReport!, products: products)
    }

    /// Re-requests products when the last request was incomplete, e.g. on opening the paywall. TN3186: App Store
    /// Connect changes can take up to an hour to reach the sandbox, so a single request at sign-in is not enough.
    func loadProductsIfIncomplete() async {
        if productReport?.isComplete != true { await loadProducts() }
    }

    func deliverUnfinished() async {
        for event in await store.unfinishedTransactions() { _ = await deliver(event) }
    }

    /// StoreKit's per-Apple-ID eligibility for the plan's introductory offer (half of the trial rule, D-042).
    func isEligibleForIntroOffer(planId: String) async -> Bool {
        guard let productID = storeProductID(planId: planId) else { return false }
        return await store.isEligibleForIntroOffer(productID: productID)
    }

    func displayPrice(productID: String?) -> String? { productID.flatMap { products[$0]?.displayPrice } }

    func storeProductID(packageId: String) -> String? { account?.products.consumables[packageId] }
    func storeProductID(planId: String) -> String? { account?.products.subscriptions[planId] }

    /// Buys a StoreKit product for the signed-in MonetaLab account.
    func buy(productID: String) async -> Outcome {
        guard let account, let appAccountToken = UUID(uuidString: account.appAccountToken) else {
            return .failed("The App Store is not ready. Try again in a moment.")
        }
        let result: StorePurchaseResult
        do {
            result = try await store.purchase(productID: productID, appAccountToken: appAccountToken)
        } catch {
            return .failed("The purchase could not be completed. Nothing was charged by MonetaLab.")
        }
        switch result {
        case .pending:
            lastMessage = "Purchase pending approval. Credits are added after the App Store completes it."
            return .pending
        case .userCancelled:
            lastMessage = "Purchase cancelled. Your balance is unchanged."
            return .cancelled
        case let .success(event):
            return await deliver(event)
        }
    }

    /// Restore: sync with the App Store, then deliver the current entitlements and anything unfinished.
    func restore() async -> [Outcome] {
        do {
            try await store.sync()
        } catch {
            lastMessage = "The App Store could not be reached for restore."
            return [.failed("sync failed")]
        }
        var outcomes: [Outcome] = []
        for event in await store.currentEntitlements() { outcomes.append(await deliver(event)) }
        for event in await store.unfinishedTransactions() { outcomes.append(await deliver(event)) }
        if outcomes.contains(where: { if case .rejected = $0 { return true }; return false }) {
            lastMessage = "Some purchases belong to a different MonetaLab account and were not restored here."
        } else {
            lastMessage = "Purchases restored from the App Store."
        }
        return outcomes
    }

    /// Sends one StoreKit transaction to the server and finishes it only when the server says so.
    @discardableResult
    func deliver(_ event: StoreTransactionEvent) async -> Outcome {
        guard case let .verified(transaction) = event else {
            lastMessage = "The App Store could not verify a purchase. It was not used."
            return .failed("unverified")
        }
        guard let token = token() else { return .deferred("signed out") }
        undelivered.insert(transaction.id)
        let renewal = transaction.isSubscription ? await store.renewalInfoJWS(productID: transaction.productID, originalTransactionID: transaction.originalID) : nil
        do {
            let response = try await api.syncAppleTransaction(token: token, signedTransaction: transaction.jws, signedRenewalInfo: renewal)
            if response.finishTransaction {
                await store.finish(transactionID: transaction.id)
                finishedIDs.append(transaction.id)
                undelivered.remove(transaction.id)
            }
            onWallet(response.wallet)
            lastMessage = Self.describe(response)
            return .delivered(response)
        } catch APIError.unauthenticated {
            onUnauthenticated()
            return .deferred("signed out")
        } catch let APIError.server(status, code, message) where status >= 500 || code == "APPLE_VERIFICATION_UNAVAILABLE" || code == "APPLE_PERIOD_NOT_STARTED" {
            lastMessage = "Your purchase is safe and will be added when the server can confirm it."
            return .deferred("\(code): \(message)")
        } catch let APIError.server(_, code, message) {
            lastMessage = message
            return .rejected(code: code, message: message)
        } catch {
            lastMessage = "Your purchase is safe and will be added when the server can be reached."
            return .deferred(String(describing: error))
        }
    }

    static func describe(_ r: AppleTransactionResponse) -> String {
        switch r.result {
        case "FULFILLED": return "Added \(r.creditsGranted.credits) credits."
        case "ALREADY_FULFILLED", "IGNORED_DUPLICATE_TRANSACTION": return "Already added."
        case "TRIAL_STARTED": return "Free trial started. \(r.creditsGranted.credits) credits added."
        case "TRIAL_STARTED_NOT_FUNDED": return "Free trial started. Trial credits were already used on this account."
        case "SUBSCRIPTION_STARTED": return "Subscription started. \(r.creditsGranted.credits) credits added."
        case "UPGRADED": return "Upgraded. Unused subscription credits were replaced. \(r.creditsGranted.credits) credits added."
        case "TRIAL_CONVERTED", "RENEWED", "RENEWED_DOWNGRADED": return "Renewed. \(r.creditsGranted.credits) credits added."
        case "REVOKED_CURRENT": return "Refund processed. Remaining subscription credits were removed."
        // F-M3-04: verified renewal delivered before its period starts; the server adds its credits at the start.
        case "RENEWAL_SCHEDULED": return "Renewal confirmed. Its credits are added when the new period starts."
        default: return "Purchase recorded (\(r.result))."
        }
    }
}

/// What one `Product.products(for:)` request returned. Contains App Store product ids only.
struct ProductLoadReport: Equatable {
    let requested: [String]
    let returned: [String]
    /// The StoreKit/network error, if the request threw (it does not throw for unknown ids).
    let error: String?
    var missing: [String] { requested.filter { !returned.contains($0) } }
    var isComplete: Bool { error == nil && missing.isEmpty }
}

/// Development-only StoreKit diagnostics (Console.app / Xcode console, subsystem = bundle id, category "storekit").
/// Logs product ids, counts, errors and whether a displayPrice exists. Never logs prices for a customer, account
/// tokens, signed transactions, auth tokens or Apple account data.
enum StoreKitDiagnostics {
    #if DEBUG
    private static let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "MonetaLab", category: "storekit")
    #endif

    static func log(_ report: ProductLoadReport, products: [String: StoreProduct]) {
        #if DEBUG
        logger.notice("products(for:) requested \(report.requested.count, privacy: .public): \(report.requested.joined(separator: ","), privacy: .public)")
        logger.notice("products(for:) returned \(report.returned.count, privacy: .public): \(report.returned.joined(separator: ","), privacy: .public)")
        if !report.missing.isEmpty {
            logger.error("products(for:) missing \(report.missing.count, privacy: .public): \(report.missing.joined(separator: ","), privacy: .public)")
        }
        if let error = report.error { logger.error("products(for:) error: \(error, privacy: .public)") }
        for id in report.returned {
            let hasPrice = !(products[id]?.displayPrice.isEmpty ?? true)
            logger.notice("product \(id, privacy: .public) displayPrice available: \(hasPrice, privacy: .public)")
        }
        #endif
    }
}
