import SwiftUI

/// PRD §3.1 paywall with Subscription | Credits tabs.
struct PaywallView: View {
    @StateObject var model: PaywallModel
    let catalog: Catalog
    var title: String
    var subtitle: String?
    /// Called after every purchase attempt with the wallet returned by the server.
    let onWalletChanged: (Wallet) -> Void
    let onClose: () -> Void

    init(model: PaywallModel, catalog: Catalog, title: String, subtitle: String? = nil,
         onWalletChanged: @escaping (Wallet) -> Void, onClose: @escaping () -> Void) {
        _model = StateObject(wrappedValue: model)
        self.catalog = catalog
        self.title = title
        self.subtitle = subtitle
        self.onWalletChanged = onWalletChanged
        self.onClose = onClose
    }

    var body: some View {
        NavigationStack {
            List {
                if let subtitle {
                    Section { Text(subtitle).accessibilityIdentifier("paywall.required") }
                }
                Section {
                    Picker("Plan type", selection: $model.tab) {
                        ForEach(PaywallModel.Tab.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("paywall.tab")
                }
                switch model.tab {
                case .subscription: subscriptionTab
                case .credits: creditsTab
                }
                if model.action != nil && model.adsAvailable { adSection }
                if let error = model.loadError {
                    Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("paywall.loadError") }
                }
                if model.storeProductsIncomplete {
                    Section {
                        Text("Some App Store prices are unavailable right now. Those items can't be bought until the App Store returns them.")
                            .foregroundStyle(.secondary).accessibilityIdentifier("paywall.storeUnavailable")
                    }
                    #if DEBUG
                    if let storeKit = model.storeKit { StoreKitDiagnosticsSection(storeKit: storeKit, catalog: catalog) }
                    #endif
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", action: onClose).accessibilityIdentifier("paywall.close")
                }
            }
        }
        .interactiveDismissDisabled(model.isBusy)
        // Reloaded on every presentation, so a re-opened paywall never shows a stale entitlement or quota.
        .task { await model.load() }
    }

    private var subscriptionTab: some View {
        Group {
            if let sub = model.currentSubscription, sub.entitled {
                Section {
                    Text("Current plan: \(sub.planName) (\(sub.status == "TRIAL" ? "free trial" : "active"))")
                        .accessibilityIdentifier("paywall.currentPlan")
                }
            }
            Section("Weekly plans") {
                ForEach(catalog.subscriptions) { plan in
                    Button {
                        model.selectedPlanId = plan.id
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(plan.name) Weekly").font(.headline)
                                Text("\(plan.creditsPerPeriod.credits) credits per week")
                                if let price = model.storeKit?.displayPrice(productID: model.storeKit?.storeProductID(planId: plan.id)) {
                                    Text("\(price) per week (App Store)").font(.footnote).accessibilityIdentifier("paywall.price.\(plan.id)")
                                }
                                // PRD §3.1: trial messaging only when the server says this customer is eligible.
                                if plan.introductoryOffer != nil, let trial = model.trialMessage {
                                    Text(trial).font(.footnote).foregroundStyle(.green)
                                        .accessibilityIdentifier("paywall.trialMessage")
                                }
                            }
                            Spacer()
                            if model.selectedPlanId == plan.id { Image(systemName: "checkmark") }
                        }
                    }
                    .disabled(model.isBusy)
                    .accessibilityIdentifier("paywall.plan.\(plan.id)")
                }
            }
            if !model.isStoreKit { mockOutcomeSection }
            Section {
                Button(model.isPurchasing ? "Processing…" : "Continue") {
                    Task {
                        if let wallet = await model.subscribeTapped(plans: catalog.subscriptions) { onWalletChanged(wallet) }
                    }
                }
                .disabled(model.selectedPlanId == nil || model.isBusy || model.subscriptionState == nil
                          || !model.isAvailableInStore(planId: model.selectedPlanId ?? ""))
                .accessibilityIdentifier("paywall.subscriptionContinue")
                if let message = model.message {
                    Text(message).accessibilityIdentifier("paywall.message")
                }
            } footer: {
                Text(model.isStoreKit
                     ? "Purchased through the App Store. Credits are added by the MonetaLab server after it verifies Apple's signed transaction."
                     : "Mock subscription for QA: no real App Store purchase. Prices are not shown.")
            }
        }
    }

    private var mockOutcomeSection: some View {
        Section {
            Picker("Mock outcome", selection: $model.mockOutcome) {
                ForEach(MockOutcome.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .disabled(model.isBusy)
            .accessibilityIdentifier("paywall.outcome")
        } header: {
            Text("Mock billing outcome (test only)")
        } footer: {
            Text("A deterministic mock provider decides the outcome. No real payment is made.")
        }
    }

    /// PRD §3.1/§3.2: beneath Continue, enabled only when the server reports the customer eligible.
    private var adSection: some View {
        Section {
            Button(model.isWatchingAd ? "Watching…" : catalog.rewardedAd.label) {
                Task {
                    if let wallet = await model.watchAdTapped() { onWalletChanged(wallet) }
                }
            }
            .disabled(!model.canWatchAd)
            .accessibilityIdentifier("paywall.watchAd")
            if let quota = model.adQuota {
                Text("\(quota.remaining) of \(quota.limit) rewarded ads left today (UTC)")
                    .font(.footnote)
                    .accessibilityIdentifier("paywall.adQuota")
            }
            Picker("Mock ad outcome", selection: $model.adOutcome) {
                ForEach(MockAdOutcome.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .disabled(model.isBusy)
            .accessibilityIdentifier("paywall.adOutcome")
            if let adMessage = model.adMessage {
                Text(adMessage).accessibilityIdentifier("paywall.adMessage")
            }
        } header: {
            Text("Rewarded ad")
        } footer: {
            Text("Mock ad for QA (test only): no real ad network. Only a verified completion earns credits.")
        }
    }

    private var creditsTab: some View {
        Group {
            Section("Credit packs") {
                ForEach(catalog.consumables) { pack in
                    Button {
                        model.selectedPackageId = pack.id
                    } label: {
                        HStack {
                            Text(pack.name)
                            Spacer()
                            Text("\(pack.credits.credits) credits")
                            if let price = model.storeKit?.displayPrice(productID: model.storeKit?.storeProductID(packageId: pack.id)) {
                                Text(price).foregroundStyle(.secondary).accessibilityIdentifier("paywall.price.\(pack.id)")
                            }
                            if model.selectedPackageId == pack.id { Image(systemName: "checkmark") }
                        }
                    }
                    .disabled(model.isBusy)
                    .accessibilityIdentifier("paywall.package.\(pack.id)")
                }
            }
            if !model.isStoreKit { mockOutcomeSection }
            Section {
                Button(model.isPurchasing ? "Processing…" : "Continue") {
                    Task {
                        if let wallet = await model.continueTapped() { onWalletChanged(wallet) }
                    }
                }
                .disabled(model.selectedPackageId == nil || model.isBusy
                          || !model.isAvailableInStore(packageId: model.selectedPackageId ?? ""))
                .accessibilityIdentifier("paywall.continue")
                // Result feedback directly under the action the user just took.
                if let message = model.message {
                    Text(message).accessibilityIdentifier("paywall.message")
                }
            }
        }
    }
}

#if DEBUG
/// Debug builds only, and only while the last StoreKit product request was incomplete: compares the backend catalog
/// (names, credits, App Store product ids) with what StoreKit actually returned. Product ids only, no account data.
private struct StoreKitDiagnosticsSection: View {
    @ObservedObject var storeKit: StoreKitPurchaseCoordinator
    let catalog: Catalog
    @State private var probeResult: String?

    var body: some View {
        Section {
            if let report = storeKit.productReport {
                Text("Requested \(report.requested.count), StoreKit returned \(report.returned.count)")
                if let error = report.error { Text("StoreKit error: \(error)").foregroundStyle(.red) }
            } else {
                Text("No StoreKit product request yet (account not loaded).")
            }
            Text("Server: \(storeKit.account?.environment ?? "?"), bundle \(storeKit.account?.bundleId ?? "?")")
            Text("App bundle: \(Bundle.main.bundleIdentifier ?? "?")")
            ForEach(catalog.consumables) { pack in row("\(pack.name)", storeKit.storeProductID(packageId: pack.id)) }
            ForEach(catalog.subscriptions) { plan in row("\(plan.name) Weekly", storeKit.storeProductID(planId: plan.id)) }
            Button("Request products again") { Task { await storeKit.loadProducts() } }
            Button("Run independent StoreKit probe (\(StoreKitProbe.productID))") {
                Task { probeResult = await Task.detached { await StoreKitProbe.run() }.value }
            }
            if let probeResult { Text(probeResult).textSelection(.enabled) }
        } header: {
            Text("StoreKit diagnostics (debug build)")
        }
        .font(.footnote)
        .accessibilityIdentifier("paywall.storekitDiagnostics")
    }

    private func row(_ name: String, _ productID: String?) -> some View {
        let product = productID.flatMap { storeKit.products[$0] }
        return VStack(alignment: .leading) {
            Text("\(name) → \(productID ?? "no App Store id")")
            Text(product.map { "StoreKit Product: yes, displayPrice \($0.displayPrice.isEmpty ? "missing" : "available")" }
                 ?? "StoreKit Product: not returned")
                .foregroundStyle(product == nil ? .red : .green)
        }
    }
}
#endif
