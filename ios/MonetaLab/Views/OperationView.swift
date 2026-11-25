import SwiftUI

struct OperationView: View {
    @ObservedObject var operation: OperationModel
    @ObservedObject var wallet: WalletModel
    @ObservedObject var app: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section("Available") {
                    Text("\((wallet.wallet?.total ?? 0).credits) credits").accessibilityIdentifier("operation.available")
                }
                Section("Choose an operation") {
                    ForEach(wallet.catalog?.operations ?? []) { option in
                        Button {
                            operation.selected = option
                        } label: {
                            HStack {
                                Text(option.name)
                                Spacer()
                                Text("\(option.cost.credits) credits").foregroundStyle(.secondary)
                                if operation.selected == option { Image(systemName: "checkmark") }
                            }
                        }
                        .accessibilityIdentifier("operation.option.\(option.id)")
                    }
                    if wallet.catalog == nil { ProgressView() }
                }
                Section {
                    Button(operation.isRunning ? "Running…" : "Run") { operation.requestRun() }
                        .disabled(operation.selected == nil || operation.isRunning)
                        .accessibilityIdentifier("operation.run")
                }
                if let notice = operation.notice {
                    Section { Text(notice).foregroundStyle(.green).accessibilityIdentifier("operation.notice") }
                }
                if let error = operation.errorMessage {
                    Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("operation.error") }
                }
                if let result = operation.lastResult {
                    Section("Last result") {
                        Text("\(result.action) completed: \(result.cost.credits) credits spent")
                            .accessibilityIdentifier("operation.result")
                        Text("Debits: subscription \(result.debits.subscription.credits), consumable \(result.debits.consumable.credits), reward \(result.debits.reward.credits), promotional \(result.debits.promotional.credits)")
                            .font(.footnote).foregroundStyle(.secondary)
                            .accessibilityIdentifier("operation.debits")
                    }
                }
            }
            .navigationTitle("Process")
            .confirmationDialog(
                "Spend \(operation.selected?.cost.credits ?? "0") credits on \(operation.selected?.name ?? "")?",
                isPresented: $operation.isConfirming,
                titleVisibility: .visible
            ) {
                Button("Confirm") { Task { await operation.confirmRun() } }
                    .accessibilityIdentifier("operation.confirm")
                Button("Cancel", role: .cancel) {}
            }
            .sheet(item: $operation.paywall) { [app] context in
                if let catalog = wallet.catalog {
                    PaywallView(
                        model: PaywallModel(required: context.required, action: context.action.id, api: app.api, token: { [weak app] in app?.token },
                                            onUnauthenticated: { [weak app] in app?.endSession() }, storeKit: app.storeKit),
                        catalog: catalog,
                        title: "Not enough credits",
                        subtitle: "\(context.action.name) needs \(context.required.credits) credits. You have \(context.available.credits).",
                        onWalletChanged: { w in operation.paywallWalletChanged(w) },
                        onClose: { operation.closePaywall() }
                    )
                }
            }
        }
    }
}
