import Foundation

// Wire models for the MonetaLab M1 REST API. The backend is the system of record (CLAUDE.md rule 1):
// the app only displays balances returned by the server and never computes or grants credits itself.

struct User: Codable, Equatable {
    let id: String
    let email: String
    let createdAt: String
}

struct LoginResponse: Codable, Equatable {
    let token: String
    let expiresAt: String
    let user: User
}

struct Balances: Codable, Equatable {
    var subscription: Int
    var consumable: Int
    var reward: Int
    var promotional: Int

    enum CodingKeys: String, CodingKey {
        case subscription = "SUBSCRIPTION", consumable = "CONSUMABLE", reward = "REWARD", promotional = "PROMOTIONAL"
    }

    static let zero = Balances(subscription: 0, consumable: 0, reward: 0, promotional: 0)
}

struct Wallet: Codable, Equatable {
    var balances: Balances
    var total: Int
}

struct WalletResponse: Codable { let wallet: Wallet }

struct HistoryEntry: Codable, Equatable, Identifiable {
    struct PurchaseRef: Codable, Equatable { let id: String; let packageId: String; let transactionId: String }
    struct OperationRef: Codable, Equatable { let id: String; let action: String; let requestId: String; let cost: Int }
    let id: Int
    let createdAt: String
    let type: String
    let bucket: String
    let delta: Int
    let purchase: PurchaseRef?
    let operation: OperationRef?
    let seedReason: String?
    struct PeriodRef: Codable, Equatable { let id: String; let planId: String; let kind: String; let transactionId: String }
    struct AdRef: Codable, Equatable { let id: String; let adEventId: String }
    var subscriptionPeriod: PeriodRef? = nil
    var expirationReason: String? = nil
    var adReward: AdRef? = nil
}

struct HistoryResponse: Codable { let entries: [HistoryEntry]; let nextBefore: Int? }

struct PurchaseRecord: Codable, Equatable, Identifiable {
    let id: String
    let transactionId: String
    let packageId: String
    let credits: Int
    let outcome: String
    let createdAt: String
    let creditsGranted: Int
}

struct PurchasesResponse: Codable { let purchases: [PurchaseRecord] }

struct CreditPackage: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    let credits: Int
    let available: Bool
}

/// PRD §2.1 weekly plans, purchasable through the backend's deterministic MOCK subscription provider (M2).
struct SubscriptionPlan: Codable, Equatable, Identifiable {
    struct IntroductoryOffer: Codable, Equatable { let kind: String; let days: Int; let credits: Int }
    let id: String
    let name: String
    let period: String
    let periodDays: Int
    let creditsPerPeriod: Int
    let tier: Int
    let introductoryOffer: IntroductoryOffer?
    let available: Bool
    let availability: String
}

struct RewardedAdInfo: Codable, Equatable {
    let label: String
    let credits: Int
    let dailyLimit: Int
    let available: Bool
    let availability: String
}

struct OperationOption: Codable, Equatable, Identifiable, Hashable {
    let id: String
    let name: String
    let cost: Int
}

struct Catalog: Codable, Equatable {
    let consumables: [CreditPackage]
    let subscriptions: [SubscriptionPlan]
    let rewardedAd: RewardedAdInfo
    let operations: [OperationOption]
}

/// Deterministic outcome requested from the backend's **mock** billing provider (never real payments).
enum MockOutcome: String, Codable, CaseIterable, Identifiable {
    case approved = "APPROVED", declined = "DECLINED", cancelled = "CANCELLED"
    var id: String { rawValue }
    var label: String {
        switch self {
        case .approved: return "Approved"
        case .declined: return "Declined"
        case .cancelled: return "Cancelled"
        }
    }
}

struct PurchaseInfo: Codable, Equatable {
    let id: String
    let transactionId: String
    let packageId: String
    let credits: Int
    let outcome: String
    let createdAt: String
}

struct PurchaseResponse: Codable, Equatable {
    let purchase: PurchaseInfo
    let creditsGranted: Int
    let replayed: Bool
    let wallet: Wallet
}

struct OperationResult: Codable, Equatable {
    struct Output: Codable, Equatable { let status: String; let output: String }
    let id: String
    let requestId: String
    let action: String
    let cost: Int
    let createdAt: String
    let debits: Balances
    let result: Output
}

struct OperationResponse: Codable, Equatable {
    let operation: OperationResult
    let replayed: Bool
    let wallet: Wallet
}

// MARK: - M2 subscriptions

struct SubscriptionPeriod: Codable, Equatable {
    let id: String
    let transactionId: String
    let planId: String
    let kind: String
    let startsAt: String
    let endsAt: String
    let credits: Int
    var revoked: Bool? = nil
    var disposition: String? = nil
}

struct SubscriptionInfo: Codable, Equatable {
    let id: String
    let planId: String
    let planName: String
    /// TRIAL | ACTIVE | EXPIRED | REVOKED (server-derived).
    let status: String
    /// Whether the entitlement is valid right now on the SERVER clock.
    let entitled: Bool
    let autoRenew: Bool
    let pendingPlanId: String?
    let renewsAt: String?
    let expiresAt: String
    let currentPeriod: SubscriptionPeriod
}

struct TrialInfo: Codable, Equatable {
    struct Offer: Codable, Equatable { let planId: String; let days: Int; let credits: Int; let message: String }
    let eligible: Bool
    let reason: String
    let source: String
    /// Present only when eligible (PRD §3.1: trial messaging only when genuinely eligible).
    let offer: Offer?
}

struct SubscriptionStateResponse: Codable, Equatable {
    let subscription: SubscriptionInfo?
    let trial: TrialInfo
    let wallet: Wallet
}

struct SubscriptionActionResponse: Codable, Equatable {
    let result: String
    let replayed: Bool
    let period: SubscriptionPeriod?
    let subscription: SubscriptionInfo?
    let trial: TrialInfo
    let wallet: Wallet
}

/// Mock App Store server notifications (test controls only; M3 replaces them with real signed notifications).
enum MockNotificationType: String, CaseIterable, Identifiable {
    case renewed = "RENEWED", expired = "EXPIRED", refunded = "REFUNDED"
    var id: String { rawValue }
    var label: String {
        switch self {
        case .renewed: return "Simulate renewal"
        case .expired: return "Simulate expiry"
        case .refunded: return "Simulate refund"
        }
    }
}

// MARK: - M2 rewarded ads

/// Deterministic outcome requested from the backend's MOCK ad provider (no real ad network).
enum MockAdOutcome: String, Codable, CaseIterable, Identifiable {
    case completed = "COMPLETED", incomplete = "INCOMPLETE", failed = "FAILED"
    var id: String { rawValue }
    var label: String {
        switch self {
        case .completed: return "Completed"
        case .incomplete: return "Closed early"
        case .failed: return "Failed to load"
        }
    }
}

struct AdQuota: Codable, Equatable {
    let utcDay: String
    let used: Int
    let limit: Int
    let remaining: Int
    let resetsAt: String
    let rewardCredits: Int
}

struct AdEligibility: Codable, Equatable {
    let action: String
    let eligible: Bool
    let reason: String
    let required: Int
    let available: Int
}

struct AdQuotaResponse: Codable, Equatable {
    let quota: AdQuota
    let eligibility: AdEligibility?
    let wallet: Wallet
}

struct AdRewardResponse: Codable, Equatable {
    struct Attempt: Codable, Equatable { let id: String; let adEventId: String; let outcome: String; let status: String; let utcDay: String; let credits: Int }
    let result: String
    let replayed: Bool
    let creditsGranted: Int
    let attempt: Attempt
    let quota: AdQuota
    let wallet: Wallet
}

// MARK: - M3 Apple StoreKit

/// Which billing provider the server runs. "mock" keeps the M1/M2 deterministic test controls; "apple" uses StoreKit 2.
struct BillingConfig: Codable, Equatable { let provider: String }

struct AppleProducts: Codable, Equatable {
    let subscriptionGroupName: String
    /// Server package/plan id -> StoreKit product id.
    let consumables: [String: String]
    let subscriptions: [String: String]
}

struct AppleAccount: Codable, Equatable {
    let environment: String
    let bundleId: String
    /// Passed to StoreKit as appAccountToken; Apple signs it into the transaction so the server can prove ownership.
    let appAccountToken: String
    let products: AppleProducts
}

struct AppleTransactionResponse: Codable, Equatable {
    let result: String
    let productType: String
    let transactionId: String
    let creditsGranted: Int
    /// The server durably accepted the transaction: only then does the app call Transaction.finish().
    let finishTransaction: Bool
    let subscription: SubscriptionInfo?
    let trial: TrialInfo
    let wallet: Wallet
}

extension Int {
    /// "5,000"-style formatting for credit amounts.
    var credits: String { formatted(.number.grouping(.automatic)) }
}
