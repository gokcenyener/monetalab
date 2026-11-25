import StoreKit
import SwiftUI

/// Plan tab (M2): entitlement status, renewal/expiry date, plan changes, auto-renew, restore, and clearly labelled
/// MOCK provider test controls. Every value shown comes from the server.
struct SubscriptionView: View {
    @ObservedObject var model: SubscriptionModel
    let plans: [SubscriptionPlan]
    @State private var showManage = false

    var body: some View {
        NavigationStack {
            List {
                if let error = model.errorMessage {
                    Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("plan.error") }
                }
                if let message = model.message {
                    Section { Text(message).accessibilityIdentifier("plan.message") }
                }
                statusSection
                if let offer = model.trial?.offer {
                    Section("Introductory offer") {
                        Text(offer.message).accessibilityIdentifier("plan.trialMessage")
                    }
                }
                plansSection
                if let sub = model.subscription, sub.entitled { manageSection(sub) }
                Section {
                    Button("Restore Purchases") { Task { await model.restore() } }
                        .disabled(model.isWorking)
                        .accessibilityIdentifier("plan.restore")
                }
                if model.storeKit == nil { testControls }
            }
            .manageSubscriptionsSheet(isPresented: $showManage)
            .navigationTitle("Plan")
            .refreshable { await model.refresh() }
            .task { await model.refresh() }
            .overlay { if model.isLoading && model.state == nil { ProgressView() } }
        }
    }

    private var statusSection: some View {
        Section("Status") {
            if let sub = model.subscription {
                Text("\(sub.planName) · \(Self.statusText(sub))").accessibilityIdentifier("plan.status")
                if let renews = sub.renewsAt {
                    Text("Renews \(Self.date(renews))").accessibilityIdentifier("plan.renewsAt")
                } else {
                    Text("\(sub.entitled ? "Ends" : "Ended") \(Self.date(sub.expiresAt))").accessibilityIdentifier("plan.expiresAt")
                }
                Text(sub.autoRenew ? "Auto-renew on" : "Auto-renew off").accessibilityIdentifier("plan.autoRenew")
                if let pending = sub.pendingPlanId, let plan = plans.first(where: { $0.id == pending }) {
                    Text("Changes to \(plan.name) at the next renewal").accessibilityIdentifier("plan.pending")
                }
            } else {
                Text("No subscription").accessibilityIdentifier("plan.status")
            }
        }
    }

    private var plansSection: some View {
        Section {
            ForEach(plans) { plan in
                let current = model.subscription.flatMap { $0.entitled ? $0 : nil }
                HStack {
                    VStack(alignment: .leading) {
                        Text("\(plan.name) Weekly").font(.headline)
                        Text("\(plan.creditsPerPeriod.credits) credits per week").font(.footnote)
                    }
                    Spacer()
                    if current?.planId == plan.id {
                        Text("Current").foregroundStyle(.secondary)
                    } else {
                        Button(Self.actionLabel(plan: plan, current: current, plans: plans)) {
                            Task {
                                if current == nil { await model.purchase(planId: plan.id) } else { await model.changePlan(to: plan.id) }
                            }
                        }
                        .buttonStyle(.borderless)
                        .disabled(model.isWorking || model.state == nil)
                        .accessibilityIdentifier("plan.choose.\(plan.id)")
                    }
                }
            }
            if model.storeKit == nil {
                Picker("Mock outcome", selection: $model.mockOutcome) {
                    ForEach(MockOutcome.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("plan.outcome")
            }
        } header: {
            Text("Plans")
        } footer: {
            Text(model.storeKit == nil
                 ? "Mock subscriptions for QA (test only). Upgrades apply now; downgrades apply at the next renewal."
                 : "App Store subscriptions. Upgrades apply now; downgrades apply at the next renewal. Credits are added by the server after it verifies Apple's signed transaction.")
        }
    }

    private func manageSection(_ sub: SubscriptionInfo) -> some View {
        Section("Manage") {
            if model.storeKit != nil {
                // Auto-renew and cancellation are controlled by the customer's App Store account.
                Button("Manage Subscription") { showManage = true }
                    .accessibilityIdentifier("plan.manage")
            } else if sub.autoRenew {
                Button("Cancel Auto-Renew", role: .destructive) { Task { await model.setAutoRenew(false) } }
                    .disabled(model.isWorking)
                    .accessibilityIdentifier("plan.cancel")
            } else {
                Button("Resume Auto-Renew") { Task { await model.setAutoRenew(true) } }
                    .disabled(model.isWorking)
                    .accessibilityIdentifier("plan.resume")
            }
        }
    }

    private var testControls: some View {
        Section {
            ForEach(MockNotificationType.allCases) { type in
                Button(type.label) { Task { await model.simulate(type) } }
                    .disabled(model.isWorking || model.subscription == nil)
                    .accessibilityIdentifier("plan.simulate.\(type.rawValue)")
            }
        } header: {
            Text("Mock provider test controls")
        } footer: {
            Text("Test only. These ask the backend's mock provider to send a lifecycle notification. They are not App Store events. The server rejects renewals and expiries that are not due yet.")
        }
    }

    static func statusText(_ sub: SubscriptionInfo) -> String {
        switch sub.status {
        case "TRIAL": return sub.entitled ? "Free trial" : "Trial ended"
        case "ACTIVE": return sub.entitled ? "Active" : "Period ended"
        case "EXPIRED": return "Expired"
        case "REVOKED": return "Refunded"
        default: return sub.status
        }
    }

    static func actionLabel(plan: SubscriptionPlan, current: SubscriptionInfo?, plans: [SubscriptionPlan]) -> String {
        guard let current, let currentPlan = plans.first(where: { $0.id == current.planId }) else { return "Subscribe" }
        if current.pendingPlanId == plan.id { return "Scheduled" }
        return plan.tier > currentPlan.tier ? "Upgrade" : "Downgrade"
    }

    static func date(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
