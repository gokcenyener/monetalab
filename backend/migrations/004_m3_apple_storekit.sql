-- M3: Apple StoreKit 2 / App Store Server verification (PRD §1 M3, §2.1, §2.2, §4; decisions D-038..D-047).
--
-- Principles kept from M1/M2: credits move only through the append-only credit_ledger; every source record is
-- immutable; grants are exactly-once per source record (DB-enforced); balances never go negative.
--
-- New records:
--   users.app_account_token   per-user UUID the app passes to StoreKit as appAccountToken. Apple signs it into every
--                             transaction, so the server can bind a verified transaction to the right MonetaLab user.
--   apple_account_links       IMMUTABLE: (environment, originalTransactionId) -> user. The first verified binding wins;
--                             every later transaction of the same purchase chain must belong to the same user. This is
--                             what stops cross-account replay and restore reassignment.
--   apple_transactions        IMMUTABLE: every Apple-signed transaction the server verified and accepted (first sighting).
--   apple_revocations         IMMUTABLE: verified refunds/revocations (revocationDate present), per transaction.
--   apple_notifications       IMMUTABLE: every verified App Store Server Notification V2, by notificationUUID (idempotency),
--                             with what the server did with it.
-- Apple transaction ids are stored in purchases/subscription_periods as '<environment>:<transactionId>', so Sandbox and
-- Production ids can never collide or be replayed across environments.

-- Account binding token -------------------------------------------------------------
ALTER TABLE users ADD COLUMN app_account_token uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE users ADD CONSTRAINT users_app_account_token_uq UNIQUE (app_account_token);

-- Providers: 'apple' joins 'mock' -----------------------------------------------------
ALTER TABLE purchases DROP CONSTRAINT purchases_provider_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_provider_check CHECK (provider IN ('mock', 'apple'));
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_provider_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_provider_check CHECK (provider IN ('mock', 'apple'));
ALTER TABLE subscription_periods DROP CONSTRAINT subscription_periods_provider_check;
ALTER TABLE subscription_periods ADD CONSTRAINT subscription_periods_provider_check CHECK (provider IN ('mock', 'apple'));
ALTER TABLE subscription_events DROP CONSTRAINT subscription_events_provider_check;
ALTER TABLE subscription_events ADD CONSTRAINT subscription_events_provider_check CHECK (provider IN ('mock', 'apple'));
ALTER TABLE subscription_events DROP CONSTRAINT subscription_events_type_check;
ALTER TABLE subscription_events ADD CONSTRAINT subscription_events_type_check CHECK (type IN (
  'PURCHASE', 'CHANGE_PLAN', 'CANCEL_AUTO_RENEW', 'RESUME_AUTO_RENEW', 'RENEWED', 'EXPIRED', 'REFUNDED', 'REVOKED',
  'APPLE_TRANSACTION', 'APPLE_RENEWAL_INFO', 'APPLE_NOTIFICATION'));
ALTER TABLE trial_redemptions DROP CONSTRAINT trial_redemptions_source_check;
ALTER TABLE trial_redemptions ADD CONSTRAINT trial_redemptions_source_check CHECK (source IN ('MOCK_PROVIDER', 'APPLE_VERIFIED'));

-- Apple-verified free trials that the backend does NOT fund (D-042) ---------------------
-- Apple decides intro-offer eligibility per Apple ID; the backend decides whether it grants trial credits (PRD §2.1,
-- open decision #9). A verified Apple trial for a customer whose backend record says the trial was already used, or
-- for a plan without an approved offer (PRD open decision #4), is an entitled period with 0 credits.
ALTER TABLE subscription_periods DROP CONSTRAINT subscription_periods_credits_check;
ALTER TABLE subscription_periods ADD CONSTRAINT subscription_periods_credits_check
  CHECK (credits > 0 OR (credits = 0 AND kind = 'TRIAL' AND provider = 'apple'));
-- TRIAL-01/02 stays DB-enforced: at most one FUNDED trial per user, ever.
DROP INDEX subscription_periods_one_trial_per_user_uq;
CREATE UNIQUE INDEX subscription_periods_one_trial_per_user_uq ON subscription_periods (user_id) WHERE kind = 'TRIAL' AND credits > 0;
-- The newest applied renewal info (signedDate) per subscription; older, out-of-order renewal info is ignored.
ALTER TABLE subscriptions ADD COLUMN apple_renewal_signed_at timestamptz;

-- Ownership binding ---------------------------------------------------------------------
CREATE TABLE apple_account_links (
  environment             text NOT NULL CHECK (environment IN ('Sandbox', 'Production', 'Xcode')),
  original_transaction_id text NOT NULL CHECK (length(original_transaction_id) BETWEEN 1 AND 100),
  user_id                 uuid NOT NULL REFERENCES users (id),
  product_type            text NOT NULL CHECK (product_type IN ('SUBSCRIPTION', 'CONSUMABLE')),
  -- How ownership was proven. Only Apple's signed appAccountToken is accepted (D-040).
  linked_via              text NOT NULL CHECK (linked_via IN ('APP_ACCOUNT_TOKEN')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, original_transaction_id)
);
CREATE INDEX apple_account_links_user_idx ON apple_account_links (user_id);

-- Verified transactions (first sighting) -----------------------------------------------
CREATE TABLE apple_transactions (
  environment             text NOT NULL CHECK (environment IN ('Sandbox', 'Production', 'Xcode')),
  transaction_id          text NOT NULL CHECK (length(transaction_id) BETWEEN 1 AND 100),
  original_transaction_id text NOT NULL,
  user_id                 uuid NOT NULL REFERENCES users (id),
  product_id              text NOT NULL CHECK (length(product_id) BETWEEN 1 AND 200),
  product_type            text NOT NULL CHECK (product_type IN ('SUBSCRIPTION', 'CONSUMABLE')),
  purchase_date           timestamptz NOT NULL,
  expires_date            timestamptz,
  offer_type              smallint,
  offer_discount_type     text,
  app_account_token       uuid,
  signed_date             timestamptz NOT NULL,
  -- Where the server first saw it: the app (StoreKit), a server notification, or the App Store Server API.
  source                  text NOT NULL CHECK (source IN ('CLIENT', 'NOTIFICATION', 'SERVER_API')),
  payload                 jsonb NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, transaction_id),
  CONSTRAINT apple_transactions_link_fk FOREIGN KEY (environment, original_transaction_id)
    REFERENCES apple_account_links (environment, original_transaction_id),
  CONSTRAINT apple_transactions_subscription_expiry CHECK (product_type <> 'SUBSCRIPTION' OR expires_date > purchase_date)
);

CREATE TABLE apple_revocations (
  environment       text NOT NULL,
  transaction_id    text NOT NULL,
  user_id           uuid NOT NULL REFERENCES users (id),
  product_type      text NOT NULL CHECK (product_type IN ('SUBSCRIPTION', 'CONSUMABLE')),
  revocation_date   timestamptz NOT NULL,
  revocation_reason smallint,
  -- SUBSCRIPTION: entitlement and remaining subscription credits removed (SUB-06).
  -- CONSUMABLE: recorded only; credit clawback is PRD open decision #2 and is NOT implemented (D-045).
  handling          text NOT NULL CHECK (handling IN ('SUBSCRIPTION_REVOKED', 'CONSUMABLE_RECORDED_NO_CLAWBACK')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment, transaction_id),
  CONSTRAINT apple_revocations_transaction_fk FOREIGN KEY (environment, transaction_id)
    REFERENCES apple_transactions (environment, transaction_id)
);

-- Server notifications V2 (idempotent by notificationUUID) --------------------------------
CREATE TABLE apple_notifications (
  notification_uuid       uuid PRIMARY KEY,
  environment             text NOT NULL CHECK (environment IN ('Sandbox', 'Production', 'Xcode')),
  notification_type       text NOT NULL CHECK (length(notification_type) BETWEEN 1 AND 60),
  subtype                 text CHECK (subtype IS NULL OR length(subtype) BETWEEN 1 AND 60),
  signed_date             timestamptz NOT NULL,
  original_transaction_id text,
  transaction_id          text,
  -- NULL when no MonetaLab user could be proven (UNMATCHED): the effects are applied later, when the app or the
  -- reconciliation job delivers the same verified transaction with a valid binding.
  user_id                 uuid REFERENCES users (id),
  result                  text NOT NULL CHECK (length(result) BETWEEN 1 AND 60),
  payload                 jsonb NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX apple_notifications_original_tx_idx ON apple_notifications (environment, original_transaction_id);

-- Immutability -----------------------------------------------------------------------------
CREATE TRIGGER apple_account_links_immutable BEFORE UPDATE OR DELETE ON apple_account_links
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER apple_transactions_immutable BEFORE UPDATE OR DELETE ON apple_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER apple_revocations_immutable BEFORE UPDATE OR DELETE ON apple_revocations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER apple_notifications_immutable BEFORE UPDATE OR DELETE ON apple_notifications
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

-- A transaction can only be recorded for the user its purchase chain is bound to.
CREATE FUNCTION apple_transaction_matches_link() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  linked uuid;
BEGIN
  SELECT user_id INTO linked FROM apple_account_links
   WHERE environment = NEW.environment AND original_transaction_id = NEW.original_transaction_id;
  IF FOUND AND linked <> NEW.user_id THEN
    RAISE EXCEPTION 'apple transaction belongs to another account'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'apple_transactions_owner_matches_link';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER apple_transactions_owner_matches_link BEFORE INSERT ON apple_transactions
  FOR EACH ROW EXECUTE FUNCTION apple_transaction_matches_link();
