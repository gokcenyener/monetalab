import SwiftUI

struct MainView: View {
    @ObservedObject var app: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var wallet: WalletModel
    @StateObject private var operation: OperationModel
    @StateObject private var subscription: SubscriptionModel

    init(app: AppModel) {
        self.app = app
        let walletModel = WalletModel(api: app.api, token: { [weak app] in app?.token },
                                      onUnauthenticated: { [weak app] in app?.endSession(message: "Your session has ended. Please sign in again.") })
        _wallet = StateObject(wrappedValue: walletModel)
        _operation = StateObject(wrappedValue: OperationModel(
            api: app.api,
            token: { [weak app] in app?.token },
            onWallet: { [weak walletModel] w in
                walletModel?.apply(w)
                Task { await walletModel?.refresh() } // keep history in sync with the server
            },
            onUnauthenticated: { [weak app] in app?.endSession(message: "Your session has ended. Please sign in again.") }
        ))
        _subscription = StateObject(wrappedValue: SubscriptionModel(
            api: app.api,
            token: { [weak app] in app?.token },
            onWallet: { [weak walletModel] w in
                walletModel?.apply(w)
                Task { await walletModel?.refresh() }
            },
            onUnauthenticated: { [weak app] in app?.endSession(message: "Your session has ended. Please sign in again.") }
        ))
    }

    var body: some View {
        TabView {
            WalletView(wallet: wallet, app: app)
                .tabItem { Label("Wallet", systemImage: "creditcard") }
            OperationView(operation: operation, wallet: wallet, app: app)
                .tabItem { Label("Process", systemImage: "wand.and.stars") }
            SubscriptionView(model: subscription, plans: wallet.catalog?.subscriptions ?? [])
                .tabItem { Label("Plan", systemImage: "star.circle") }
            HistoryView(wallet: wallet)
                .tabItem { Label("History", systemImage: "list.bullet.rectangle") }
            AccountView(app: app)
                .tabItem { Label("Account", systemImage: "person.crop.circle") }
        }
        .task {
            await wallet.refresh()
            // M3: StoreKit only when the server runs BILLING_PROVIDER=apple; otherwise the mock provider stays.
            // The coordinator lives on AppModel only while this user is signed in (cleared by endSession).
            await app.configureBilling(store: AppleStoreClient(), onWallet: { [wallet] w in
                wallet.apply(w)
                Task { await wallet.refresh() }
            })
            subscription.storeKit = app.storeKit
        }
        .onChange(of: scenePhase) { _, phase in
            // Deliver anything left unfinished while the app was in the background (e.g. Ask to Buy approved).
            if phase == .active, let storeKit = app.storeKit { Task { await storeKit.deliverUnfinished() } }
        }
    }
}

struct AccountView: View {
    @ObservedObject var app: AppModel

    var body: some View {
        NavigationStack {
            Form {
                Section("Signed in as") {
                    Text(app.user?.email ?? "").accessibilityIdentifier("account.email")
                }
                Section {
                    Button("Sign Out", role: .destructive) { Task { await app.signOut() } }
                        .accessibilityIdentifier("account.signOut")
                }
                Section {
                    Text(app.storeKit == nil
                         ? "QA fixture. Purchases, subscriptions and rewarded ads use deterministic mock providers: no real payments, StoreKit or ad network."
                         : "QA fixture. Purchases use the App Store (StoreKit 2) and are verified by the server. Rewarded ads are still a mock.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Account")
        }
    }
}
