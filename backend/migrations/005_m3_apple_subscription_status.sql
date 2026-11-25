-- M3 follow-ups F-M3-02 / F-M3-03 (docs/m3-verification.md §8). Additive only: no existing row or column changes.
--
-- MonetaLab keeps four separate facts about an Apple subscription:
--   entitlement          subscriptions.status + the current period's dates (isEntitled); decides spendable credits
--   MonetaLab renewal    subscriptions.auto_renew: whether MonetaLab expects the period to renew (always false once the
--                        subscription has ended: subscriptions_ended_shape, M2)
--   Apple renewal intent apple_auto_renew / apple_expiration_intent from the newest verified renewal info. Apple may
--                        report auto-renew ON for an expired subscription (e.g. billing failure), so it is stored as-is
--   Apple status         apple_status from the App Store Server API (Get All Subscription Statuses) or the newest
--                        status-bearing notification; ordered by Apple's signedDate (apple_status_signed_at)
-- All four are derived from verified Apple data; the ledger stays the only record of credits.

ALTER TABLE subscriptions
  ADD COLUMN apple_status text CHECK (apple_status IN ('ACTIVE', 'EXPIRED', 'BILLING_RETRY', 'GRACE_PERIOD', 'REVOKED')),
  ADD COLUMN apple_status_signed_at timestamptz,
  ADD COLUMN apple_auto_renew boolean,
  -- Apple expirationIntent: 1 customer cancelled, 2 billing error, 3 price increase not consented, 4 product unavailable, 5 other
  ADD COLUMN apple_expiration_intent smallint CHECK (apple_expiration_intent BETWEEN 1 AND 5),
  ADD CONSTRAINT subscriptions_apple_fields_only_for_apple CHECK (
    provider = 'apple' OR (apple_status IS NULL AND apple_status_signed_at IS NULL AND apple_auto_renew IS NULL AND apple_expiration_intent IS NULL)
  ),
  ADD CONSTRAINT subscriptions_apple_status_dated CHECK ((apple_status IS NULL) = (apple_status_signed_at IS NULL));
