import Foundation
import StoreKit

/// StoreKit 2 implementation of `StoreClient` (async/await). Works against the App Store, Apple Sandbox, TestFlight and
/// Xcode's local StoreKit testing (the environment is decided by how the app is built and run, not by this code).
final class AppleStoreClient: StoreClient {
    /// StoreKit `Transaction` values seen this session, so they can be finished after the server accepted them.
    private let pending = TransactionCache()

    func products(ids: [String]) async throws -> [StoreProduct] {
        try await Product.products(for: ids).map { product in
            StoreProduct(
                id: product.id,
                displayName: product.displayName,
                displayPrice: product.displayPrice,
                kind: product.type == .consumable ? .consumable : product.type == .autoRenewable ? .autoRenewable : .other,
                introOffer: product.subscription?.introductoryOffer.map(Self.describe)
            )
        }
    }

    func purchase(productID: String, appAccountToken: UUID) async throws -> StorePurchaseResult {
        guard let product = try await Product.products(for: [productID]).first else {
            throw StoreClientError.productUnavailable(productID)
        }
        switch try await product.purchase(options: [.appAccountToken(appAccountToken)]) {
        case let .success(verification):
            return .success(await event(for: verification))
        case .pending:
            return .pending
        case .userCancelled:
            return .userCancelled
        @unknown default:
            return .pending
        }
    }

    func finish(transactionID: String) async {
        if let transaction = await pending.take(transactionID) {
            await transaction.finish()
            return
        }
        // Not seen in this session (e.g. after relaunch): find it among the unfinished transactions.
        for await result in Transaction.unfinished {
            if case let .verified(transaction) = result, String(transaction.id) == transactionID {
                await transaction.finish()
                return
            }
        }
    }

    func unfinishedTransactions() async -> [StoreTransactionEvent] {
        var events: [StoreTransactionEvent] = []
        for await result in Transaction.unfinished { events.append(await event(for: result)) }
        return events
    }

    func currentEntitlements() async -> [StoreTransactionEvent] {
        var events: [StoreTransactionEvent] = []
        for await result in Transaction.currentEntitlements { events.append(await event(for: result)) }
        return events
    }

    func transactionUpdates() -> AsyncStream<StoreTransactionEvent> {
        AsyncStream { continuation in
            let task = Task {
                for await result in Transaction.updates {
                    continuation.yield(await self.event(for: result))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func sync() async throws {
        try await AppStore.sync()
    }

    func isEligibleForIntroOffer(productID: String) async -> Bool {
        guard let product = try? await Product.products(for: [productID]).first,
              let subscription = product.subscription,
              subscription.introductoryOffer != nil else { return false }
        return await subscription.isEligibleForIntroOffer
    }

    func renewalInfoJWS(productID: String, originalTransactionID: String) async -> String? {
        guard let product = try? await Product.products(for: [productID]).first,
              let statuses = try? await product.subscription?.status else { return nil }
        for status in statuses {
            if case let .verified(info) = status.renewalInfo, String(info.originalTransactionID) == originalTransactionID {
                return status.renewalInfo.jwsRepresentation
            }
        }
        return nil
    }

    private func event(for result: VerificationResult<Transaction>) async -> StoreTransactionEvent {
        switch result {
        case let .verified(transaction):
            await pending.put(transaction)
            return .verified(StoreTransaction(
                id: String(transaction.id),
                originalID: String(transaction.originalID),
                productID: transaction.productID,
                jws: result.jwsRepresentation,
                appAccountToken: transaction.appAccountToken,
                isSubscription: transaction.productType == .autoRenewable,
                revoked: transaction.revocationDate != nil
            ))
        case let .unverified(transaction, error):
            return .unverified(transactionID: String(transaction.id), productID: transaction.productID, reason: String(describing: error))
        }
    }

    static func describe(_ offer: Product.SubscriptionOffer) -> String {
        let unit: String
        switch offer.period.unit {
        case .day: unit = "day"
        case .week: unit = "week"
        case .month: unit = "month"
        case .year: unit = "year"
        @unknown default: unit = "period"
        }
        let length = "\(offer.period.value)-\(unit)"
        return offer.paymentMode == .freeTrial ? "\(length) free trial" : "\(length) introductory offer"
    }
}

enum StoreClientError: Error, Equatable {
    case productUnavailable(String)
}

private actor TransactionCache {
    private var items: [String: Transaction] = [:]
    func put(_ transaction: Transaction) { items[String(transaction.id)] = transaction }
    func take(_ id: String) -> Transaction? { items.removeValue(forKey: id) }
}
