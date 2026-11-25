-- M3 F-M3-04 (docs/m3-verification.md §13): Apple signs and notifies renewal transactions BEFORE their period starts
-- (observed 16-44 s in Sandbox; production billing can run ahead of the period by much more). Such a verified,
-- future-dated transaction is now recorded and SCHEDULED instead of refused with 409; its credits are granted only
-- when the period has actually started (no clock tolerance), by the next read/spend for that user or the background
-- sweeper. Additive only.
--
-- One row per scheduled Apple transaction. The verified transaction itself stays in apple_transactions (immutable).
-- A row is resolved exactly once (resolved_at + result set together, never changed afterwards, never deleted):
-- applied (e.g. RENEWED), superseded/duplicate, or REVOKED_BEFORE_START.
CREATE TABLE apple_scheduled_renewals (
  environment     text NOT NULL,
  transaction_id  text NOT NULL,
  user_id         uuid NOT NULL REFERENCES users (id),
  starts_at       timestamptz NOT NULL,
  first_source    text NOT NULL CHECK (first_source IN ('CLIENT', 'NOTIFICATION', 'SERVER_API')),
  scheduled_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  result          text CHECK (result IS NULL OR length(result) BETWEEN 1 AND 80),
  PRIMARY KEY (environment, transaction_id),
  CONSTRAINT apple_scheduled_renewals_transaction_fk FOREIGN KEY (environment, transaction_id)
    REFERENCES apple_transactions (environment, transaction_id),
  CONSTRAINT apple_scheduled_renewals_resolution_shape CHECK ((resolved_at IS NULL) = (result IS NULL))
);
CREATE INDEX apple_scheduled_renewals_due_idx ON apple_scheduled_renewals (starts_at) WHERE resolved_at IS NULL;

CREATE FUNCTION apple_scheduled_renewals_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'apple_scheduled_renewals rows are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.resolved_at IS NOT NULL
     OR NEW.environment IS DISTINCT FROM OLD.environment OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.first_source IS DISTINCT FROM OLD.first_source OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at THEN
    RAISE EXCEPTION 'a scheduled renewal can only be resolved once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER apple_scheduled_renewals_guard BEFORE UPDATE OR DELETE ON apple_scheduled_renewals
  FOR EACH ROW EXECUTE FUNCTION apple_scheduled_renewals_guard();

-- The owner of a scheduled renewal must be the owner of its verified transaction.
CREATE FUNCTION apple_scheduled_renewal_matches_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM apple_transactions t
                  WHERE t.environment = NEW.environment AND t.transaction_id = NEW.transaction_id
                    AND t.user_id = NEW.user_id AND t.product_type = 'SUBSCRIPTION' AND t.purchase_date = NEW.starts_at) THEN
    RAISE EXCEPTION 'scheduled renewal does not match its verified subscription transaction' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER apple_scheduled_renewals_matches_transaction BEFORE INSERT ON apple_scheduled_renewals
  FOR EACH ROW EXECUTE FUNCTION apple_scheduled_renewal_matches_transaction();
