import Foundation

/// Boundary between MonetaLab and the App Store (M3, D-038). `AppleStoreClient` implements it with StoreKit 2; unit
/// tests use a scripted fake. Nothing behind this protocol grants credits: it only produces Apple-signed transaction
/// data (JWS), which the MonetaLab server verifies before any fulfillment (CLAUDE.md rule 1).
protocol StoreClient: AnyObject {
    /// Localized products from the App Store (prices are never hard-coded in MonetaLab; PRD open decision #1).
    func products(ids: [String]) async throws -> [StoreProduct]
    /// Starts a purchase bound to the MonetaLab account through Apple's appAccountToken.
    func purchase(productID: String, appAccountToken: UUID) async throws -> StorePurchaseResult
    /// Finishes a transaction. Called only after the server durably accepted it.
    func finish(transactionID: String) async
    /// Transactions the app has not finished yet (e.g. the app was terminated before the server answered).
    func unfinishedTransactions() async -> [StoreTransactionEvent]
    /// The customer's current entitlements (restore / sync).
    func currentEntitlements() async -> [StoreTransactionEvent]
    /// Transactions completed outside the purchase call: renewals, Ask to Buy approvals, other devices, offer codes.
    func transactionUpdates() -> AsyncStream<StoreTransactionEvent>
    /// AppStore.sync(): asks the App Store for the latest transactions (shows a sign-in prompt if needed).
    func sync() async throws
    /// StoreKit's per-Apple-ID introductory-offer eligibility for the product's subscription group.
    func isEligibleForIntroOffer(productID: String) async -> Bool
    /// The signed renewal info of the purchase chain `originalTransactionID`, when StoreKit has verified one.
    func renewalInfoJWS(productID: String, originalTransactionID: String) async -> String?
}

struct StoreProduct: Equatable, Identifiable {
    enum Kind: Equatable { case consumable, autoRenewable, other }
    let id: String
    let displayName: String
    /// StoreKit's localized price string; displayed as-is.
    let displayPrice: String
    let kind: Kind
    /// The configured introductory offer, if any (e.g. "3-day free trial"). Eligibility is a separate question.
    let introOffer: String?
}

/// A transaction that StoreKit has verified locally (signature check on device). The server re-verifies the JWS.
struct StoreTransaction: Equatable {
    let id: String
    let originalID: String
    let productID: String
    let jws: String
    let appAccountToken: UUID?
    let isSubscription: Bool
    let revoked: Bool
}

enum StoreTransactionEvent: Equatable {
    case verified(StoreTransaction)
    /// StoreKit could not verify it. Never sent as proof of purchase and never finished as fulfilled.
    case unverified(transactionID: String, productID: String, reason: String)
}

enum StorePurchaseResult: Equatable {
    case success(StoreTransactionEvent)
    /// Ask to Buy / Strong Customer Authentication etc.: completes later through `transactionUpdates()`.
    case pending
    case userCancelled
}
