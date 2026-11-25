import SwiftUI

@main
struct MonetaLabApp: App {
    @StateObject private var app: AppModel

    init() {
        let store = KeychainTokenStore()
        // QA fixture convenience: UI tests launch with --reset-session to start signed out.
        // It only clears the locally stored token; it has no effect on the server.
        if ProcessInfo.processInfo.arguments.contains("--reset-session") { store.clear() }
        #if DEBUG
        // TEMPORARY Sandbox troubleshooting: independent StoreKit probe, before any sign-in or backend call.
        if ProcessInfo.processInfo.arguments.contains(StoreKitProbe.launchArgument) { StoreKitProbe.runDetached() }
        #endif
        _app = StateObject(wrappedValue: AppModel(api: HTTPAPIClient(baseURL: HTTPAPIClient.configuredBaseURL()), tokenStore: store))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(app)
                .task { await app.restore() }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var app: AppModel

    var body: some View {
        switch app.state {
        case .restoring:
            ProgressView("Loading…").accessibilityIdentifier("root.loading")
        case .signedOut:
            AuthView()
        case let .signedIn(user):
            MainView(app: app).id(user.id) // fresh per-user state; nothing leaks between accounts
        }
    }
}
