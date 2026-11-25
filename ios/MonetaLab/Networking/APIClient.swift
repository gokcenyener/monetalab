import Foundation

enum APIError: Error, Equatable {
    case unauthenticated
    case insufficientCredits(required: Int, available: Int)
    case server(status: Int, code: String, message: String)
    case transport(String)
    case invalidResponse

    var userMessage: String {
        switch self {
        case .unauthenticated: return "Your session has ended. Please sign in again."
        case let .insufficientCredits(required, available):
            return "Not enough credits: \(required.credits) needed, \(available.credits) available."
        case let .server(_, _, message): return message
        case .transport: return "Cannot reach the MonetaLab server. Check that the backend is running."
        case .invalidResponse: return "Unexpected response from the server."
        }
    }
}

protocol MonetaLabAPI {
    func register(email: String, password: String) async throws -> User
    func login(email: String, password: String) async throws -> LoginResponse
    func me(token: String) async throws -> User
    func logout(token: String) async throws
    func catalog() async throws -> Catalog
    func wallet(token: String) async throws -> Wallet
    func history(token: String) async throws -> [HistoryEntry]
    func purchases(token: String) async throws -> [PurchaseRecord]
    func purchase(token: String, packageId: String, transactionId: String, mockOutcome: MockOutcome) async throws -> PurchaseResponse
    func runOperation(token: String, action: String, requestId: String) async throws -> OperationResponse
    // M2
    func subscriptionState(token: String) async throws -> SubscriptionStateResponse
    func purchaseSubscription(token: String, planId: String, transactionId: String, mockOutcome: MockOutcome) async throws -> SubscriptionActionResponse
    func changePlan(token: String, planId: String, transactionId: String, mockOutcome: MockOutcome) async throws -> SubscriptionActionResponse
    func setAutoRenew(token: String, enabled: Bool, requestId: String) async throws -> SubscriptionActionResponse
    func restoreSubscription(token: String) async throws -> SubscriptionStateResponse
    func mockNotification(token: String, eventId: String, type: MockNotificationType, transactionId: String) async throws -> SubscriptionActionResponse
    func adQuota(token: String, action: String?) async throws -> AdQuotaResponse
    func watchAd(token: String, adEventId: String, action: String, mockOutcome: MockAdOutcome) async throws -> AdRewardResponse
    // M3
    func billingConfig() async throws -> BillingConfig
    func appleAccount(token: String) async throws -> AppleAccount
    func syncAppleTransaction(token: String, signedTransaction: String, signedRenewalInfo: String?) async throws -> AppleTransactionResponse
}

/// Talks to the real MonetaLab backend over HTTP. No responses are faked.
final class HTTPAPIClient: MonetaLabAPI {
    let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    /// Resolution order: launch environment (UI tests) → Info.plist `MonetaLabAPIBaseURL` → http://127.0.0.1:3000.
    static func configuredBaseURL(bundle: Bundle = .main, environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let value = environment["MONETALAB_API_BASE_URL"], let url = URL(string: value) { return url }
        if let value = bundle.object(forInfoDictionaryKey: "MonetaLabAPIBaseURL") as? String, let url = URL(string: value) { return url }
        return URL(string: "http://127.0.0.1:3000")!
    }

    private struct ErrorEnvelope: Decodable {
        struct Body: Decodable { let code: String; let message: String; let required: Int?; let available: Int? }
        let error: Body
    }
    private struct Empty: Decodable {}

    private func send<T: Decodable>(_ method: String, _ path: String, token: String? = nil, body: [String: Any]? = nil) async throws -> T {
        // `path` may carry a query ("ads/quota?action=BASIC"); appendingPathComponent alone would encode the "?".
        let parts = path.split(separator: "?", maxSplits: 1).map(String.init)
        var components = URLComponents(url: baseURL.appendingPathComponent(parts[0]), resolvingAgainstBaseURL: false)!
        if parts.count == 2 { components.percentEncodedQuery = parts[1] }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if (200..<300).contains(http.statusCode) {
            if T.self == Empty.self { return Empty() as! T }
            guard let decoded = try? JSONDecoder().decode(T.self, from: data) else { throw APIError.invalidResponse }
            return decoded
        }
        try Self.throwError(status: http.statusCode, data: data)
    }

    static func throwError(status: Int, data: Data) throws -> Never {
        let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
        if status == 401 { throw APIError.unauthenticated }
        if status == 402, let body = envelope?.error, body.code == "INSUFFICIENT_CREDITS" {
            throw APIError.insufficientCredits(required: body.required ?? 0, available: body.available ?? 0)
        }
        if let body = envelope?.error { throw APIError.server(status: status, code: body.code, message: body.message) }
        throw APIError.invalidResponse
    }

    func register(email: String, password: String) async throws -> User {
        struct R: Decodable { let user: User }
        let r: R = try await send("POST", "auth/register", body: ["email": email, "password": password])
        return r.user
    }

    func login(email: String, password: String) async throws -> LoginResponse {
        try await send("POST", "auth/login", body: ["email": email, "password": password])
    }

    func me(token: String) async throws -> User {
        struct R: Decodable { let user: User }
        let r: R = try await send("GET", "me", token: token)
        return r.user
    }

    func logout(token: String) async throws {
        let _: Empty = try await send("POST", "auth/logout", token: token)
    }

    func catalog() async throws -> Catalog { try await send("GET", "catalog") }

    func wallet(token: String) async throws -> Wallet {
        let r: WalletResponse = try await send("GET", "wallet", token: token)
        return r.wallet
    }

    func history(token: String) async throws -> [HistoryEntry] {
        let r: HistoryResponse = try await send("GET", "history", token: token)
        return r.entries
    }

    func purchases(token: String) async throws -> [PurchaseRecord] {
        let r: PurchasesResponse = try await send("GET", "purchases", token: token)
        return r.purchases
    }

    func purchase(token: String, packageId: String, transactionId: String, mockOutcome: MockOutcome) async throws -> PurchaseResponse {
        try await send("POST", "purchases", token: token,
                       body: ["packageId": packageId, "transactionId": transactionId, "mockOutcome": mockOutcome.rawValue])
    }

    func runOperation(token: String, action: String, requestId: String) async throws -> OperationResponse {
        try await send("POST", "operations", token: token, body: ["action": action, "requestId": requestId])
    }

    // MARK: M2

    func subscriptionState(token: String) async throws -> SubscriptionStateResponse {
        try await send("GET", "subscriptions/current", token: token)
    }

    func purchaseSubscription(token: String, planId: String, transactionId: String, mockOutcome: MockOutcome) async throws -> SubscriptionActionResponse {
        try await send("POST", "subscriptions/purchase", token: token,
                       body: ["planId": planId, "transactionId": transactionId, "mockOutcome": mockOutcome.rawValue])
    }

    func changePlan(token: String, planId: String, transactionId: String, mockOutcome: MockOutcome) async throws -> SubscriptionActionResponse {
        try await send("POST", "subscriptions/change-plan", token: token,
                       body: ["planId": planId, "transactionId": transactionId, "mockOutcome": mockOutcome.rawValue])
    }

    func setAutoRenew(token: String, enabled: Bool, requestId: String) async throws -> SubscriptionActionResponse {
        try await send("POST", enabled ? "subscriptions/resume" : "subscriptions/cancel", token: token, body: ["requestId": requestId])
    }

    func restoreSubscription(token: String) async throws -> SubscriptionStateResponse {
        try await send("POST", "subscriptions/restore", token: token, body: [:])
    }

    func mockNotification(token: String, eventId: String, type: MockNotificationType, transactionId: String) async throws -> SubscriptionActionResponse {
        try await send("POST", "subscriptions/mock-notifications", token: token,
                       body: ["eventId": eventId, "type": type.rawValue, "transactionId": transactionId])
    }

    func adQuota(token: String, action: String?) async throws -> AdQuotaResponse {
        try await send("GET", action.map { "ads/quota?action=\($0)" } ?? "ads/quota", token: token)
    }

    func watchAd(token: String, adEventId: String, action: String, mockOutcome: MockAdOutcome) async throws -> AdRewardResponse {
        try await send("POST", "ads/rewards", token: token,
                       body: ["adEventId": adEventId, "action": action, "mockOutcome": mockOutcome.rawValue])
    }

    // MARK: M3

    func billingConfig() async throws -> BillingConfig { try await send("GET", "billing/config") }

    func appleAccount(token: String) async throws -> AppleAccount { try await send("GET", "billing/apple/account", token: token) }

    func syncAppleTransaction(token: String, signedTransaction: String, signedRenewalInfo: String?) async throws -> AppleTransactionResponse {
        var body: [String: Any] = ["signedTransaction": signedTransaction]
        if let signedRenewalInfo { body["signedRenewalInfo"] = signedRenewalInfo }
        return try await send("POST", "billing/apple/transactions", token: token, body: body)
    }
}
