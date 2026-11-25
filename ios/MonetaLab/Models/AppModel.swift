import Foundation

/// Authentication state and the signed-in session (AUTH-01).
@MainActor
final class AppModel: ObservableObject {
    enum State: Equatable {
        case restoring
        case signedOut
        case signedIn(User)
    }

    @Published private(set) var state: State = .restoring
    @Published var authError: String?
    @Published private(set) var isWorking = false
    /// Set only when the server runs BILLING_PROVIDER=apple (M3). nil = deterministic mock billing (M1/M2).
    @Published private(set) var storeKit: StoreKitPurchaseCoordinator?
    @Published private(set) var billingProvider: String?

    let api: MonetaLabAPI
    private let tokenStore: TokenStore
    private(set) var token: String?

    init(api: MonetaLabAPI, tokenStore: TokenStore) {
        self.api = api
        self.tokenStore = tokenStore
    }

    var user: User? {
        if case let .signedIn(user) = state { return user }
        return nil
    }

    /// Restores a stored session. Invalid, expired or revoked tokens are discarded.
    func restore() async {
        guard let stored = tokenStore.load() else { state = .signedOut; return }
        do {
            let user = try await api.me(token: stored)
            token = stored
            state = .signedIn(user)
        } catch APIError.unauthenticated {
            tokenStore.clear()
            state = .signedOut
        } catch {
            // Server unreachable: keep the token for a later retry, but show the sign-in screen with a clear message.
            authError = (error as? APIError)?.userMessage ?? error.localizedDescription
            state = .signedOut
        }
    }

    func signIn(email: String, password: String) async {
        await perform {
            let response = try await self.api.login(email: email, password: password)
            self.tokenStore.save(response.token)
            self.token = response.token
            self.state = .signedIn(response.user)
        }
    }

    /// Creates the account, then signs in. The server doesn't log in automatically on register (D-S3-02).
    func register(email: String, password: String) async {
        await perform {
            _ = try await self.api.register(email: email, password: password)
            let response = try await self.api.login(email: email, password: password)
            self.tokenStore.save(response.token)
            self.token = response.token
            self.state = .signedIn(response.user)
        }
    }

    func signOut() async {
        if let token { try? await api.logout(token: token) } // revoke server-side, then clear locally regardless
        endSession()
    }

    /// Asks the server which billing provider it runs, and starts StoreKit only for "apple". Called once per signed-in
    /// session (MainView). The server decides; the app never switches to real purchases on its own.
    func configureBilling(store: @autoclosure () -> StoreClient, onWallet: @escaping (Wallet) -> Void) async {
        guard billingProvider == nil, let config = try? await api.billingConfig() else { return }
        billingProvider = config.provider
        guard config.provider == "apple" else { return }
        let coordinator = StoreKitPurchaseCoordinator(
            api: api, store: store(), token: { [weak self] in self?.token }, onWallet: onWallet,
            onUnauthenticated: { [weak self] in self?.endSession(message: "Your session has ended. Please sign in again.") })
        storeKit = coordinator
        await coordinator.start()
    }

    /// Called whenever any request returns 401.
    func endSession(message: String? = nil) {
        storeKit = nil
        billingProvider = nil
        tokenStore.clear()
        token = nil
        authError = message
        state = .signedOut
    }

    private func perform(_ work: @escaping () async throws -> Void) async {
        isWorking = true
        authError = nil
        defer { isWorking = false }
        do {
            try await work()
        } catch let error as APIError {
            switch error {
            case .unauthenticated: authError = "Email or password is incorrect."
            default: authError = error.userMessage
            }
        } catch {
            authError = error.localizedDescription
        }
    }
}
