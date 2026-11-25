import StoreKit
import StoreKitTest
import XCTest
@testable import MonetaLab

/// XCODE STOREKIT environment: the real StoreKit 2 adapter (`AppleStoreClient`) against Xcode's local StoreKit test
/// session and `MonetaLab.storekit`. Transactions here are signed by Xcode's local certificate, NOT by Apple: this is
/// not Apple Sandbox evidence, and the MonetaLab server never trusts it outside APPLE_ENVIRONMENT=Xcode with a pinned
/// certificate.
@MainActor
final class StoreKitTestSessionTests: XCTestCase {
    private var session: SKTestSession!
    private var client: AppleStoreClient!
    private let token = UUID(uuidString: "6F9619FF-8B86-D011-B42D-00C04FC964FF")!

    static let consumables = ["dev.monetalab.qa.credits.5000", "dev.monetalab.qa.credits.7000", "dev.monetalab.qa.credits.10000"]
    static let basic = "dev.monetalab.qa.sub.basic.weekly"
    static let premium = "dev.monetalab.qa.sub.premium.weekly"
    static let ultra = "dev.monetalab.qa.sub.ultra.weekly"

    override func setUp() async throws {
        session = try SKTestSession(configurationFileNamed: "MonetaLab")
        session.resetToDefaultState()
        session.disableDialogs = true
        session.clearTransactions()
        client = AppleStoreClient()
    }

    override func tearDown() async throws {
        // A simulated error left set keeps the hosted test process from exiting (observed on iOS 27.2).
        try? await session.setSimulatedError(nil, forAPI: .purchase)
        session.askToBuyEnabled = false
        session.clearTransactions()
        session = nil
    }

    private func verified(_ result: StorePurchaseResult, file: StaticString = #filePath, line: UInt = #line) -> StoreTransaction? {
        guard case let .success(.verified(t)) = result else { XCTFail("expected a verified purchase, got \(result)", file: file, line: line); return nil }
        return t
    }

    func testCatalogLoadsAllSixProductsWithStoreKitPricesAndOnlyBasicHasTheFreeTrial() async throws {
        let products = try await client.products(ids: Self.consumables + [Self.basic, Self.premium, Self.ultra])
        XCTAssertEqual(Set(products.map(\.id)), Set(Self.consumables + [Self.basic, Self.premium, Self.ultra]))
        XCTAssertTrue(products.allSatisfy { !$0.displayPrice.isEmpty }, "prices come from StoreKit, not from MonetaLab")
        XCTAssertEqual(products.filter { $0.kind == .consumable }.count, 3)
        XCTAssertEqual(products.filter { $0.kind == .autoRenewable }.count, 3)
        XCTAssertEqual(products.first { $0.id == Self.basic }?.introOffer, "3-day free trial")
        XCTAssertNil(products.first { $0.id == Self.premium }?.introOffer)
        XCTAssertNil(products.first { $0.id == Self.ultra }?.introOffer)
    }

    func testConsumablePurchaseIsVerifiedCarriesTheAccountTokenAndStaysUnfinishedUntilFinished() async throws {
        let tResult = try await client.purchase(productID: Self.consumables[0], appAccountToken: token)
        let t = try XCTUnwrap(verified(tResult))
        XCTAssertEqual(t.productID, Self.consumables[0])
        XCTAssertEqual(t.appAccountToken, token, "Apple signs MonetaLab's account token into the transaction")
        XCTAssertEqual(t.jws.split(separator: ".").count, 3, "a compact JWS for the server to verify")
        XCTAssertFalse(t.isSubscription)

        // Not finished yet: still delivered as unfinished (what a relaunch after termination sees).
        let unfinished = await client.unfinishedTransactions()
        XCTAssertTrue(unfinished.contains { if case let .verified(u) = $0 { return u.id == t.id }; return false })
        await client.finish(transactionID: t.id)
        let after = await client.unfinishedTransactions()
        XCTAssertFalse(after.contains { if case let .verified(u) = $0 { return u.id == t.id }; return false })
    }

    /// The server's Xcode-mode verifier (backend XcodePinnedVerifier) expects ES256 with the signing certificate in x5c.
    /// When MONETALAB_EXPORT_JWS_DIR is set (local evidence runs only), the JWS is also written there so the backend
    /// verifier can be checked against REAL Xcode-signed data.
    func testXcodeSignedJWSHasTheHeaderShapeTheServerVerifies() async throws {
        // For the local end-to-end evidence run, the account token can be a real server user's token.
        let accountToken = ProcessInfo.processInfo.environment["MONETALAB_EXPORT_TOKEN"].flatMap(UUID.init(uuidString:)) ?? token
        let r = try await client.purchase(productID: Self.consumables[0], appAccountToken: accountToken)
        let t = try XCTUnwrap(verified(r))
        let headerPart = String(t.jws.split(separator: ".")[0])
        var b64 = headerPart.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        let header = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(Data(base64Encoded: b64))) as? [String: Any])
        XCTAssertEqual(header["alg"] as? String, "ES256")
        let x5c = try XCTUnwrap(header["x5c"] as? [String])
        XCTAssertFalse(x5c.isEmpty, "the signing certificate is embedded for verification")
        if let dir = ProcessInfo.processInfo.environment["MONETALAB_EXPORT_JWS_DIR"] {
            try t.jws.write(toFile: (dir as NSString).appendingPathComponent("xcode-transaction.jws"), atomically: true, encoding: .utf8)
        }
    }

    func testFinishAfterRelaunchFindsTheTransactionWithoutTheInMemoryCache() async throws {
        let tResult = try await client.purchase(productID: Self.consumables[1], appAccountToken: token)
        let t = try XCTUnwrap(verified(tResult))
        let relaunched = AppleStoreClient() // new process state: no cached Transaction values
        await relaunched.finish(transactionID: t.id)
        let after = await relaunched.unfinishedTransactions()
        XCTAssertFalse(after.contains { if case let .verified(u) = $0 { return u.id == t.id }; return false })
    }

    func testAskToBuyReturnsPendingAndNoTransactionUntilApproved() async throws {
        // Observed 2026-11-19 (Xcode 27.2, iOS 27.2 simulator): with askToBuyEnabled, Product.purchase() never returned
        // (the approval sheet is not suppressed by disableDialogs), so this case cannot run unattended. Reported as
        // SKIPPED, not passed. The pending path is covered against the coordinator by
        // StoreKitCoordinatorTests.testPendingAndCancelledPurchasesCallNothingAndGrantNothing and
        // testAskToBuyApprovalArrivesThroughTransactionUpdatesAndIsDelivered (fake StoreKit).
        try XCTSkipIf(true, "Ask to Buy blocks on a system approval sheet in the iOS 27.2 simulator: NOT VERIFIED with StoreKitTest")
        session.askToBuyEnabled = true
        let result = try await client.purchase(productID: Self.consumables[2], appAccountToken: token)
        XCTAssertEqual(result, .pending)
        let unfinished = await client.unfinishedTransactions()
        XCTAssertTrue(unfinished.isEmpty, "nothing to deliver while approval is pending")
    }

    func testFailedTransactionsThrowAndProduceNothingToDeliver() async throws {
        try await session.setSimulatedError(.generic(.notAvailableInStorefront), forAPI: .purchase)
        do {
            _ = try await client.purchase(productID: Self.consumables[0], appAccountToken: token)
            XCTFail("a failed purchase must throw")
        } catch {}
        let unfinished = await client.unfinishedTransactions()
        XCTAssertTrue(unfinished.isEmpty)
    }

    func testBasicTrialIsConsumedOnceAndTheEntitlementCarriesTheIntroOffer() async throws {
        let eligibleBefore = await client.isEligibleForIntroOffer(productID: Self.basic)
        XCTAssertTrue(eligibleBefore)
        let tResult = try await client.purchase(productID: Self.basic, appAccountToken: token)
        let t = try XCTUnwrap(verified(tResult))
        XCTAssertTrue(t.isSubscription)
        let entitlement = await currentTransaction(for: Self.basic)
        XCTAssertEqual(entitlement?.offerType, .introductory)
        let eligibleAfter = await client.isEligibleForIntroOffer(productID: Self.basic)
        XCTAssertFalse(eligibleAfter, "Apple no longer offers the trial to this Apple ID")
        let renewal = await client.renewalInfoJWS(productID: Self.basic, originalTransactionID: t.originalID)
        XCTAssertEqual(renewal?.split(separator: ".").count, 3, "signed renewal info for the same purchase chain")
    }

    func testUpgradeInTheSameGroupReplacesTheEntitlementWithTheHigherTier() async throws {
        let basicResult = try await client.purchase(productID: Self.basic, appAccountToken: token)
        let basic = try XCTUnwrap(verified(basicResult))
        let ultraResult = try await client.purchase(productID: Self.ultra, appAccountToken: token)
        let ultra = try XCTUnwrap(verified(ultraResult))
        XCTAssertEqual(ultra.originalID, basic.originalID, "an upgrade stays in the same purchase chain")
        let entitled = await client.currentEntitlements().compactMap { if case let .verified(t) = $0 { return t.productID }; return nil }
        XCTAssertEqual(entitled, [Self.ultra])
    }

    func testExpiryAndRefundRemoveTheEntitlement() async throws {
        let subResult = try await client.purchase(productID: Self.premium, appAccountToken: token)
        _ = try XCTUnwrap(verified(subResult))
        try session.expireSubscription(productIdentifier: Self.premium)
        // Applied asynchronously by the test session: poll the entitlements (bounded, 10 s).
        var entitled = await client.currentEntitlements()
        for _ in 0..<100 where !entitled.isEmpty {
            try await Task.sleep(nanoseconds: 100_000_000)
            entitled = await client.currentEntitlements()
        }
        XCTAssertTrue(entitled.isEmpty, "expired subscriptions are not current entitlements")

        // SUB-06: a refunded subscription reaches the app as a transaction update carrying the revocation.
        let basicResult = try await client.purchase(productID: Self.basic, appAccountToken: token)
        let b = try XCTUnwrap(verified(basicResult))
        var refundError: Error?
        let revoked = await firstUpdate(within: 10, { $0.id == b.id && $0.revoked }, trigger: {
            do { try self.session.refundTransaction(identifier: UInt(b.id)!) } catch { refundError = error }
        })
        XCTAssertNil(refundError, "SKTestSession.refundTransaction failed: \(String(describing: refundError))")
        XCTAssertNotNil(revoked, "the refund is delivered through Transaction.updates as a revoked transaction")
        let stillEntitled = await client.currentEntitlements().contains { if case let .verified(t) = $0 { return t.productID == Self.basic }; return false }
        XCTAssertFalse(stillEntitled, "a refunded subscription is no longer a current entitlement")
    }

    /// Starts listening, runs `trigger`, and returns the first verified update matching `match` (or nil after `seconds`).
    private func firstUpdate(within seconds: UInt64, _ match: @escaping (StoreTransaction) -> Bool, trigger: () -> Void) async -> StoreTransaction? {
        let stream = client.transactionUpdates()
        let listener = Task { () -> StoreTransaction? in
            for await event in stream { if case let .verified(t) = event, match(t) { return t } }
            return nil
        }
        // Let the listener subscribe to Transaction.updates before the event is triggered (updates are not replayed).
        try? await Task.sleep(nanoseconds: 500_000_000)
        trigger()
        // The timeout cancels the listener itself (a task group cannot cancel an unstructured task, and would otherwise
        // wait for it forever when no matching update arrives).
        let timeout = Task {
            try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            listener.cancel()
        }
        let found = await listener.value
        timeout.cancel()
        return found
    }

    func testTransactionUpdatesDeliversARenewalCompletedOutsideThePurchaseCall() async throws {
        let started = try await client.purchase(productID: Self.basic, appAccountToken: token)
        _ = try XCTUnwrap(verified(started))
        let renewal = await firstUpdate(within: 10, { $0.productID == Self.basic }, trigger: {
            try? self.session.forceRenewalOfSubscription(productIdentifier: Self.basic)
        })
        XCTAssertNotNil(renewal, "a renewal completed outside the purchase call arrives through Transaction.updates")
    }

    // MARK: helpers (StoreKit directly, to assert what the adapter does not expose)

    private func currentTransaction(for productID: String) async -> Transaction? {
        for await result in Transaction.currentEntitlements {
            if case let .verified(t) = result, t.productID == productID { return t }
        }
        return nil
    }

    private func transaction(id: String) async -> Transaction? {
        for await result in Transaction.all {
            if case let .verified(t) = result, String(t.id) == id { return t }
        }
        return nil
    }
}
