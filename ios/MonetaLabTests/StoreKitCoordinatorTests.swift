import Combine
import XCTest
@testable import MonetaLab

/// Scripted StoreKit double: records finishes and purchase options, serves configurable results. (MOCK environment:
/// these tests check MonetaLab's purchase/fulfillment logic, not StoreKit itself; see StoreKitTestSessionTests.)
final class FakeStoreClient: StoreClient {
    var productsResult: [StoreProduct] = []
    var purchaseResults: [Result<StorePurchaseResult, Error>] = []
    var unfinished: [StoreTransactionEvent] = []
    var entitlements: [StoreTransactionEvent] = []
    var introEligible = true
    var renewalJWS: String?
    var syncError: Error?
    private(set) var purchaseCalls: [(productID: String, token: UUID)] = []
    private(set) var finished: [String] = []
    private(set) var syncCalls = 0
    private var continuation: AsyncStream<StoreTransactionEvent>.Continuation?

    var productsError: Error?
    private(set) var productsCalls: [[String]] = []
    func products(ids: [String]) async throws -> [StoreProduct] {
        productsCalls.append(ids)
        if let productsError { throw productsError }
        return productsResult.filter { ids.contains($0.id) }
    }
    func purchase(productID: String, appAccountToken: UUID) async throws -> StorePurchaseResult {
        purchaseCalls.append((productID, appAccountToken))
        return try purchaseResults.removeFirst().get()
    }
    func finish(transactionID: String) async {
        finished.append(transactionID)
        unfinished.removeAll { if case let .verified(t) = $0 { return t.id == transactionID }; return false }
    }
    func unfinishedTransactions() async -> [StoreTransactionEvent] { unfinished }
    func currentEntitlements() async -> [StoreTransactionEvent] { entitlements }
    func transactionUpdates() -> AsyncStream<StoreTransactionEvent> { AsyncStream { self.continuation = $0 } }
    func sync() async throws { syncCalls += 1; if let syncError { throw syncError } }
    func isEligibleForIntroOffer(productID: String) async -> Bool { introEligible }
    func renewalInfoJWS(productID: String, originalTransactionID: String) async -> String? { renewalJWS }
    func emit(_ event: StoreTransactionEvent) { continuation?.yield(event) }
}

@MainActor
final class StoreKitCoordinatorTests: XCTestCase {
    private var api: FakeAPI!
    private var store: FakeStoreClient!
    private var wallets: [Wallet] = []
    private var signedOut = 0

    static func tx(_ id: String, product: String = "dev.monetalab.qa.credits.5000", subscription: Bool = false) -> StoreTransaction {
        StoreTransaction(id: id, originalID: id, productID: product, jws: "jws-\(id)", appAccountToken: nil, isSubscription: subscription, revoked: false)
    }
    private func wallet(_ consumable: Int) -> Wallet { Wallet(balances: Balances(subscription: 0, consumable: consumable, reward: 0, promotional: 0), total: consumable) }

    override func setUp() async throws {
        api = FakeAPI()
        api.billingProvider = "apple"
        store = FakeStoreClient()
        wallets = []
        signedOut = 0
    }

    private func coordinator() async -> StoreKitPurchaseCoordinator {
        let c = StoreKitPurchaseCoordinator(api: api, store: store, token: { "tok" }, onWallet: { [weak self] in self?.wallets.append($0) },
                                            onUnauthenticated: { [weak self] in self?.signedOut += 1 })
        await c.start()
        return c
    }

    func testVerifiedPurchaseIsSentWithTheAccountTokenAndFinishedOnlyAfterTheServerAccepts() async {
        let c = await coordinator()
        store.purchaseResults = [.success(.success(.verified(Self.tx("t1"))))]
        api.appleSyncResults = [.success(FakeAPI.appleResponse("FULFILLED", credits: 5000, wallet: wallet(5000)))]
        let outcome = await c.buy(productID: "dev.monetalab.qa.credits.5000")
        guard case let .delivered(response) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(response.creditsGranted, 5000)
        XCTAssertEqual(store.purchaseCalls.map(\.token), [UUID(uuidString: FakeAPI.appleAccount.appAccountToken)!])
        XCTAssertEqual(api.appleSyncCalls.map(\.signedTransaction), ["jws-t1"])
        XCTAssertEqual(store.finished, ["t1"])
        XCTAssertEqual(wallets.last?.balances.consumable, 5000, "the balance shown is the server's")
    }

    func testNetworkFailureKeepsTheTransactionUnfinishedAndTheNextLaunchDeliversIt() async {
        let c = await coordinator()
        let t = Self.tx("t2")
        store.purchaseResults = [.success(.success(.verified(t)))]
        api.appleSyncResults = [.failure(.transport("offline"))]
        let first = await c.buy(productID: t.productID)
        guard case .deferred = first else { return XCTFail("\(first)") }
        XCTAssertTrue(store.finished.isEmpty, "never finished before the server accepted it")
        XCTAssertTrue(wallets.isEmpty, "no local grant")
        XCTAssertEqual(c.undelivered, ["t2"])

        // App terminated; on relaunch StoreKit still lists it as unfinished.
        store.unfinished = [.verified(t)]
        api.appleSyncResults = [.success(FakeAPI.appleResponse("FULFILLED", credits: 5000, wallet: wallet(5000)))]
        let relaunched = await coordinator()
        XCTAssertEqual(api.appleSyncCalls.count, 2)
        XCTAssertEqual(store.finished, ["t2"])
        XCTAssertTrue(relaunched.undelivered.isEmpty)
    }

    func testServerErrorAndNotYetEffectivePeriodAreRetryableNotFinished() async {
        let c = await coordinator()
        api.appleSyncResults = [
            .failure(.server(status: 503, code: "APPLE_VERIFICATION_UNAVAILABLE", message: "retry")),
            .failure(.server(status: 409, code: "APPLE_PERIOD_NOT_STARTED", message: "not yet")),
            .failure(.server(status: 500, code: "INTERNAL_ERROR", message: "boom")),
        ]
        for id in ["a", "b", "c"] {
            let outcome = await c.deliver(.verified(Self.tx(id)))
            guard case .deferred = outcome else { return XCTFail("\(id): \(outcome)") }
        }
        XCTAssertTrue(store.finished.isEmpty)
    }

    func testRenewalScheduledByTheServerIsFinishedAndGrantsNothingLocally() async {
        // F-M3-04: a renewal delivered before its period starts is durably scheduled by the server (202).
        let c = await coordinator()
        let before = FakeAPI.wallet(subscription: 6000)
        api.appleSyncResults = [.success(FakeAPI.appleResponse("RENEWAL_SCHEDULED", credits: 0, wallet: before, type: "SUBSCRIPTION"))]
        let outcome = await c.deliver(.verified(Self.tx("renewal-1", product: "dev.monetalab.qa.sub.premium.weekly", subscription: true)))
        guard case let .delivered(response) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(response.creditsGranted, 0)
        XCTAssertEqual(store.finished, ["renewal-1"], "the server owns it now: finished, not resent")
        XCTAssertEqual(wallets.last, before, "the wallet shown is the server's; nothing added locally")
        XCTAssertEqual(c.lastMessage, "Renewal confirmed. Its credits are added when the new period starts.")
    }

    func testAnotherAccountsPurchaseIsRejectedNotFinishedAndGrantsNothing() async {
        let c = await coordinator()
        api.appleSyncResults = [.failure(.server(status: 409, code: "APPLE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT", message: "This purchase belongs to a different MonetaLab account"))]
        let outcome = await c.deliver(.verified(Self.tx("t3")))
        XCTAssertEqual(outcome, .rejected(code: "APPLE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT", message: "This purchase belongs to a different MonetaLab account"))
        XCTAssertTrue(store.finished.isEmpty)
        XCTAssertTrue(wallets.isEmpty)
    }

    func testPendingAndCancelledPurchasesCallNothingAndGrantNothing() async {
        let c = await coordinator()
        store.purchaseResults = [.success(.pending), .success(.userCancelled)]
        let pending = await c.buy(productID: "dev.monetalab.qa.credits.7000")
        let cancelled = await c.buy(productID: "dev.monetalab.qa.credits.7000")
        XCTAssertEqual(pending, .pending)
        XCTAssertEqual(cancelled, .cancelled)
        XCTAssertTrue(api.appleSyncCalls.isEmpty)
        XCTAssertTrue(store.finished.isEmpty)
        XCTAssertTrue(wallets.isEmpty)
    }

    func testUnverifiedTransactionsAreNeverSentOrFinished() async {
        let c = await coordinator()
        store.purchaseResults = [.success(.success(.unverified(transactionID: "u1", productID: "dev.monetalab.qa.credits.5000", reason: "invalidSignature")))]
        let outcome = await c.buy(productID: "dev.monetalab.qa.credits.5000")
        XCTAssertEqual(outcome, .failed("unverified"))
        XCTAssertTrue(api.appleSyncCalls.isEmpty)
        XCTAssertTrue(store.finished.isEmpty)
    }

    func testAskToBuyApprovalArrivesThroughTransactionUpdatesAndIsDelivered() async throws {
        let c = await coordinator()
        api.appleSyncResults = [.success(FakeAPI.appleResponse("FULFILLED", credits: 10000, wallet: wallet(10000)))]
        store.emit(.verified(Self.tx("t4", product: "dev.monetalab.qa.credits.10000")))
        for _ in 0..<50 where store.finished.isEmpty { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(store.finished, ["t4"])
        XCTAssertEqual(wallets.last?.total, 10000)
        _ = c
    }

    func testDuplicateDeliveryIsHarmless() async {
        let c = await coordinator()
        api.appleSyncResults = [
            .success(FakeAPI.appleResponse("FULFILLED", credits: 5000, wallet: wallet(5000))),
            .success(FakeAPI.appleResponse("ALREADY_FULFILLED", credits: 0, wallet: wallet(5000))),
        ]
        await c.deliver(.verified(Self.tx("t5")))
        await c.deliver(.verified(Self.tx("t5")))
        XCTAssertEqual(wallets.map(\.total), [5000, 5000], "the second delivery does not add credits")
    }

    func testSubscriptionDeliveryIncludesSignedRenewalInfo() async {
        let c = await coordinator()
        store.renewalJWS = "renewal-jws"
        api.appleSyncResults = [.success(FakeAPI.appleResponse("SUBSCRIPTION_STARTED", credits: 3000, wallet: wallet(0), type: "SUBSCRIPTION"))]
        await c.deliver(.verified(Self.tx("s1", product: "dev.monetalab.qa.sub.basic.weekly", subscription: true)))
        XCTAssertEqual(api.appleSyncCalls.first?.signedRenewalInfo, "renewal-jws")
    }

    func testRestoreSyncsThenDeliversEntitlementsAndReportsOtherAccountPurchases() async {
        let c = await coordinator()
        store.entitlements = [.verified(Self.tx("e1", product: "dev.monetalab.qa.sub.premium.weekly", subscription: true))]
        api.appleSyncResults = [.failure(.server(status: 409, code: "APPLE_PURCHASE_OWNED_BY_ANOTHER_ACCOUNT", message: "other"))]
        let outcomes = await c.restore()
        XCTAssertEqual(store.syncCalls, 1)
        XCTAssertEqual(outcomes.count, 1)
        XCTAssertEqual(c.lastMessage, "Some purchases belong to a different MonetaLab account and were not restored here.")
        XCTAssertTrue(store.finished.isEmpty)
    }

    func testPaywallInStoreKitModeShowsTheTrialOnlyWhenServerAndAppleAgreeAndNeverGrantsLocally() async {
        let c = await coordinator()
        store.introEligible = false
        let model = PaywallModel(required: 500, api: api, token: { "tok" }, onUnauthenticated: {}, storeKit: c)
        await model.load()
        XCTAssertNil(model.trialMessage, "server eligible but Apple says no: no trial message")
        store.introEligible = true
        await model.load()
        XCTAssertNotNil(model.trialMessage)

        model.selectedPackageId = "CREDITS_S"
        store.purchaseResults = [.success(.success(.verified(Self.tx("p1"))))]
        api.appleSyncResults = [.failure(.transport("offline"))]
        let none = await model.continueTapped()
        XCTAssertNil(none, "no wallet without the server's answer")
        XCTAssertTrue(api.purchaseCalls.isEmpty, "the mock purchase API is never used in StoreKit mode")
        XCTAssertEqual(store.purchaseCalls.last?.productID, "dev.monetalab.qa.credits.5000")
    }

    func testAppModelStartsStoreKitOnlyWhenTheServerRunsApple() async {
        let mockApp = AppModel(api: FakeAPI(), tokenStore: InMemoryTokenStore())
        await mockApp.configureBilling(store: FakeStoreClient(), onWallet: { _ in })
        XCTAssertNil(mockApp.storeKit)
        XCTAssertEqual(mockApp.billingProvider, "mock")
        let appleApp = AppModel(api: api, tokenStore: InMemoryTokenStore())
        await appleApp.configureBilling(store: store, onWallet: { _ in })
        XCTAssertNotNil(appleApp.storeKit)
    }
    // MARK: Product loading (TN3186: StoreKit returns empty/partial arrays, not errors, for unavailable products)

    private static func product(_ id: String, price: String = "$0.99", kind: StoreProduct.Kind = .consumable) -> StoreProduct {
        StoreProduct(id: id, displayName: id, displayPrice: price, kind: kind, introOffer: nil)
    }
    private static let consumableIDs = ["dev.monetalab.qa.credits.10000", "dev.monetalab.qa.credits.5000", "dev.monetalab.qa.credits.7000"]
    private static let allIDs = (consumableIDs + ["dev.monetalab.qa.sub.basic.weekly", "dev.monetalab.qa.sub.premium.weekly", "dev.monetalab.qa.sub.ultra.weekly"]).sorted()

    func testEmptyProductResponseIsReportedAndNothingIsPricedOrPurchasable() async {
        let c = await coordinator()
        XCTAssertEqual(store.productsCalls.last, Self.allIDs, "every backend-mapped id is requested")
        XCTAssertEqual(c.productReport, ProductLoadReport(requested: Self.allIDs, returned: [], error: nil))
        XCTAssertEqual(c.productReport?.missing, Self.allIDs)
        XCTAssertTrue(c.products.isEmpty)
        XCTAssertNil(c.displayPrice(productID: "dev.monetalab.qa.credits.5000"), "no price without a StoreKit Product")
        let model = PaywallModel(required: nil, api: api, token: { "tok" }, onUnauthenticated: {}, storeKit: c)
        XCTAssertTrue(model.storeProductsIncomplete)
        XCTAssertFalse(model.isAvailableInStore(packageId: "CREDITS_S"), "backend catalog alone never makes a pack buyable")
        XCTAssertFalse(model.isAvailableInStore(planId: "BASIC_WEEKLY"))
    }

    func testPartialProductResponsePricesOnlyWhatStoreKitReturned() async {
        store.productsResult = Self.consumableIDs.map { Self.product($0) } + [Self.product("not.requested")]
        let c = await coordinator()
        XCTAssertEqual(c.productReport?.returned, Self.consumableIDs, "unrequested ids are ignored")
        XCTAssertEqual(c.productReport?.missing, ["dev.monetalab.qa.sub.basic.weekly", "dev.monetalab.qa.sub.premium.weekly", "dev.monetalab.qa.sub.ultra.weekly"])
        XCTAssertEqual(c.displayPrice(productID: c.storeProductID(packageId: "CREDITS_S")), "$0.99")
        XCTAssertNil(c.displayPrice(productID: c.storeProductID(planId: "BASIC_WEEKLY")))
        let model = PaywallModel(required: nil, api: api, token: { "tok" }, onUnauthenticated: {}, storeKit: c)
        XCTAssertTrue(model.isAvailableInStore(packageId: "CREDITS_S"))
        XCTAssertFalse(model.isAvailableInStore(planId: "BASIC_WEEKLY"))
        XCTAssertTrue(model.storeProductsIncomplete)
    }

    func testFailedProductRequestIsReportedAndOpeningThePaywallRequestsAgain() async {
        store.productsError = URLError(.notConnectedToInternet)
        let c = await coordinator()
        XCTAssertNotNil(c.productReport?.error)
        XCTAssertFalse(c.productReport?.isComplete ?? true)
        store.productsError = nil
        store.productsResult = Self.allIDs.map { Self.product($0) }
        let model = PaywallModel(required: nil, api: api, token: { "tok" }, onUnauthenticated: {}, storeKit: c)
        await model.load()
        XCTAssertEqual(store.productsCalls.count, 2, "the paywall retries an incomplete request")
        XCTAssertEqual(c.productReport?.isComplete, true)
        XCTAssertFalse(model.storeProductsIncomplete)
        await model.load()
        XCTAssertEqual(store.productsCalls.count, 2, "a complete product list is not requested again")
    }

    func testAFailedRetryKeepsProductsLoadedEarlier() async {
        store.productsResult = Self.consumableIDs.map { Self.product($0) }
        let c = await coordinator()
        store.productsError = URLError(.timedOut)
        await c.loadProducts()
        XCTAssertNotNil(c.productReport?.error)
        XCTAssertEqual(c.displayPrice(productID: "dev.monetalab.qa.credits.5000"), "$0.99")
    }

    func testPaywallRefreshesWhenProductsArriveAfterItOpened() async {
        let c = await coordinator()
        let model = PaywallModel(required: nil, api: api, token: { "tok" }, onUnauthenticated: {}, storeKit: c)
        var changes = 0
        let sub = model.objectWillChange.sink { changes += 1 }
        store.productsResult = Self.allIDs.map { Self.product($0) }
        await c.loadProducts()
        XCTAssertGreaterThan(changes, 0, "coordinator changes re-render the paywall")
        sub.cancel()
    }
}
