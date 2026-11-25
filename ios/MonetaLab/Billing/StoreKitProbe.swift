#if DEBUG
import Foundation
import StoreKit
import os

/// TEMPORARY (M3 Sandbox troubleshooting, TN3186). Debug builds only; remove once Sandbox products load.
/// Independent of the MonetaLab backend, session, paywall model, catalog and StoreClient: it asks StoreKit 2 directly
/// for one hard-coded product id. Runs in a detached task, so no view lifecycle can cancel it.
/// Output: Xcode/Console (subsystem = bundle id, category "storekit-probe") and stdout ("STOREKIT_PROBE ...").
/// Contains no account tokens, transactions, auth tokens or Apple account identifiers.
enum StoreKitProbe {
    static let productID = "dev.monetalab.qa.credits.5000"
    static let launchArgument = "-MonetaLabStoreKitProbe"
    static let allProductIDs = [
        "dev.monetalab.qa.credits.5000", "dev.monetalab.qa.credits.7000", "dev.monetalab.qa.credits.10000",
        "dev.monetalab.qa.sub.basic.weekly", "dev.monetalab.qa.sub.premium.weekly", "dev.monetalab.qa.sub.ultra.weekly",
    ]
    private static let logger = Logger(subsystem: Bundle.main.bundleIdentifier ?? "MonetaLab", category: "storekit-probe")

    static func runDetached() {
        Task.detached(priority: .userInitiated) { _ = await run() }
    }

    @discardableResult
    static func run() async -> String {
        var lines: [String] = []
        let info = Bundle.main.infoDictionary ?? [:]
        lines.append("bundle=\(Bundle.main.bundleIdentifier ?? "?") version=\(info["CFBundleShortVersionString"] ?? "?")(\(info["CFBundleVersion"] ?? "?"))")
        lines.append("canMakePayments=\(AppStore.canMakePayments)")
        if let storefront = await Storefront.current {
            lines.append("storefront=\(storefront.countryCode) storefrontId=\(storefront.id)")
        } else {
            lines.append("storefront=nil")
        }
        let started = Date()
        do {
            let products = try await Product.products(for: [productID])
            lines.append("requested=[\(productID)] returned=\(products.count)")
            for product in products {
                lines.append("product=\(product.id) type=\(product.type.rawValue) displayPrice=\(product.displayPrice.isEmpty ? "<empty>" : product.displayPrice)")
            }
        } catch {
            lines.append("error=\(String(reflecting: error))")
        }
        // All six catalog products: subscription group, level (1 = highest; Apple decides upgrade vs downgrade by it),
        // period and introductory offer as App Store Connect configured them.
        do {
            let all = try await Product.products(for: allProductIDs)
            lines.append("catalog requested=\(allProductIDs.count) returned=\(all.count)")
            for product in all.sorted(by: { $0.id < $1.id }) {
                if let sub = product.subscription {
                    let intro = sub.introductoryOffer.map { "\($0.paymentMode.rawValue)/\($0.period.value)\($0.period.unit)" } ?? "none"
                    lines.append("sub=\(product.id) group=\(sub.subscriptionGroupID) level=\(sub.groupLevel) period=\(sub.subscriptionPeriod.value)\(sub.subscriptionPeriod.unit) intro=\(intro) price=\(product.displayPrice.isEmpty ? "<empty>" : "ok")")
                } else {
                    lines.append("product=\(product.id) type=\(product.type.rawValue) price=\(product.displayPrice.isEmpty ? "<empty>" : "ok")")
                }
            }
        } catch {
            lines.append("catalogError=\(String(reflecting: error))")
        }
        lines.append("taskCancelled=\(Task.isCancelled) elapsedMs=\(Int(Date().timeIntervalSince(started) * 1000))")
        let summary = lines.joined(separator: " | ")
        logger.notice("\(summary, privacy: .public)")
        print("STOREKIT_PROBE \(summary)")
        return summary
    }
}
#endif
