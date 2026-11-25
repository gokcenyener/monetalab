import SwiftUI

struct WalletView: View {
    @ObservedObject var wallet: WalletModel
    @ObservedObject var app: AppModel
    @State private var showStore = false

    var body: some View {
        NavigationStack {
            List {
                if let error = wallet.errorMessage {
                    Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("wallet.error") }
                }
                if let w = wallet.wallet {
                    Section("Total available") {
                        Text("\(w.total.credits) credits")
                            .font(.largeTitle.bold())
                            .accessibilityIdentifier("wallet.total")
                    }
                    Section("Balances (spent in this order)") {
                        BalanceRow(name: "Subscription", value: w.balances.subscription, id: "subscription")
                        BalanceRow(name: "Consumable", value: w.balances.consumable, id: "consumable")
                        BalanceRow(name: "Reward", value: w.balances.reward, id: "reward")
                        BalanceRow(name: "Promotional", value: w.balances.promotional, id: "promotional")
                    }
                } else if wallet.isLoading {
                    Section { ProgressView("Loading wallet…") }
                }
                Section {
                    Button("Buy Credits") { showStore = true }
                        .accessibilityIdentifier("wallet.buyCredits")
                        .disabled(wallet.catalog == nil)
                }
            }
            .navigationTitle("Wallet")
            .refreshable { await wallet.refresh() }
            .toolbar {
                Button { Task { await wallet.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityIdentifier("wallet.refresh")
            }
            .sheet(isPresented: $showStore) { [app] in
                if let catalog = wallet.catalog {
                    PaywallView(
                        model: PaywallModel(required: nil, api: app.api, token: { [weak app] in app?.token },
                                            onUnauthenticated: { [weak app] in app?.endSession() }, storeKit: app.storeKit),
                        catalog: catalog,
                        title: "Get Credits",
                        onWalletChanged: { w in
                            wallet.apply(w)
                            Task { await wallet.refresh() }
                        },
                        onClose: { showStore = false }
                    )
                }
            }
        }
    }
}

private struct BalanceRow: View {
    let name: String
    let value: Int
    let id: String

    var body: some View {
        HStack {
            Text(name)
            Spacer()
            Text(value.credits).monospacedDigit().accessibilityIdentifier("wallet.balance.\(id)")
        }
    }
}
