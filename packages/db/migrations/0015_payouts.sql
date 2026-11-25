-- Rider payouts: bank accounts, payout rules, and each transfer. Money lives in the dispatch book.

-- Pricing versions get the same strictly increasing order (created_at can tie).
ALTER TABLE dispatch_pricing ADD COLUMN version bigint GENERATED ALWAYS AS IDENTITY UNIQUE;

CREATE TABLE payout_setting (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Strictly increasing: the latest version wins even when two share a timestamp.
  version                      bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  -- ISO weekday of the automatic payout (1 = Monday ... 7 = Sunday), in Lagos time.
  weekly_weekday               int    NOT NULL CHECK (weekly_weekday BETWEEN 1 AND 7),
  min_payout_kobo              bigint NOT NULL CHECK (min_payout_kobo > 0),
  instant_enabled              boolean NOT NULL,
  -- Instant withdrawals: who bears the provider's transfer fee. Weekly payouts: always the platform.
  instant_fee_paid_by_rider    boolean NOT NULL,
  instant_daily_limit_kobo     bigint NOT NULL CHECK (instant_daily_limit_kobo > 0),
  max_loan_share_bps           int    NOT NULL CHECK (max_loan_share_bps BETWEEN 0 AND 10000),
  -- After a bank account change, payouts wait this long (the rider is texted about the change).
  cooling_off_hours            int    NOT NULL CHECK (cooling_off_hours BETWEEN 0 AND 168),
  is_placeholder               boolean NOT NULL DEFAULT false,
  created_by                   uuid REFERENCES person (id),
  created_at                   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rider
  ADD COLUMN loan_share_bps int NOT NULL DEFAULT 0 CHECK (loan_share_bps BETWEEN 0 AND 10000),
  ADD COLUMN loan_share_updated_at timestamptz,
  ADD CONSTRAINT rider_loan_share_needs_loan CHECK (loan_share_bps = 0 OR finance_account_id IS NOT NULL);

CREATE TABLE rider_bank_account (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id        uuid NOT NULL REFERENCES rider (person_id),
  bank_code        text NOT NULL CHECK (bank_code ~ '^[0-9A-Za-z]{3,10}$'),
  bank_name        text NOT NULL,
  account_number   text NOT NULL CHECK (account_number ~ '^[0-9]{10}$'),
  -- The name the bank holds for the account, as returned by the provider's account check.
  account_name     text NOT NULL,
  recipient_code   text NOT NULL,
  -- matched: account name matches the rider's verified name. needs_review: it does not; finance decides.
  name_check       text NOT NULL CHECK (name_check IN ('matched', 'needs_review', 'approved', 'rejected')),
  reviewed_by      uuid REFERENCES person (id),
  reviewed_at      timestamptz,
  review_note      text,
  -- Payouts to this account start at this time (cooling-off after a change).
  usable_from      timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  replaced_at      timestamptz,
  CHECK (reviewed_by IS NULL OR reviewed_by <> person_id),
  CHECK (name_check NOT IN ('approved', 'rejected') OR reviewed_by IS NOT NULL)
);
CREATE UNIQUE INDEX rider_bank_account_one_current ON rider_bank_account (person_id) WHERE replaced_at IS NULL;

CREATE SEQUENCE payout_ref_seq;
CREATE TABLE payout (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference              text NOT NULL UNIQUE DEFAULT ('PO-' || lpad(nextval('payout_ref_seq')::text, 6, '0')),
  person_id              uuid NOT NULL REFERENCES rider (person_id),
  kind                   text NOT NULL CHECK (kind IN ('earnings', 'loan_repayment')),
  trigger                text NOT NULL CHECK (trigger IN ('weekly', 'instant')),
  -- Taken from the rider's earnings.
  gross_kobo             bigint NOT NULL CHECK (gross_kobo > 0),
  -- Part of gross kept to cover the transfer fee (instant withdrawals, when the rider pays it).
  rider_fee_kobo         bigint NOT NULL CHECK (rider_fee_kobo >= 0 AND rider_fee_kobo < gross_kobo),
  -- What the provider charges us for this transfer.
  provider_fee_kobo      bigint NOT NULL CHECK (provider_fee_kobo >= 0),
  -- gross - rider fee: what lands in the destination account.
  net_kobo               bigint NOT NULL CHECK (net_kobo = gross_kobo - rider_fee_kobo),
  bank_account_id        uuid REFERENCES rider_bank_account (id),
  destination_bank       text NOT NULL,
  destination_account    text NOT NULL CHECK (destination_account ~ '^[0-9]{10}$'),
  recipient_code         text NOT NULL,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'succeeded', 'failed')),
  provider_transfer_id   text UNIQUE,
  failure_reason         text,
  idempotency_key        text NOT NULL UNIQUE,
  created_entry_id       uuid NOT NULL,
  settled_entry_id       uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  CHECK ((kind = 'earnings') = (bank_account_id IS NOT NULL)),
  CHECK (status NOT IN ('succeeded', 'failed') OR (settled_entry_id IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX payout_person_idx ON payout (person_id, created_at DESC);
CREATE INDEX payout_status_idx ON payout (status, created_at);

-- A finished payout never changes.
CREATE FUNCTION payout_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'payout % is final', OLD.reference USING ERRCODE = 'P0001';
  END IF;
  IF NEW.gross_kobo IS DISTINCT FROM OLD.gross_kobo OR NEW.net_kobo IS DISTINCT FROM OLD.net_kobo
     OR NEW.destination_account IS DISTINCT FROM OLD.destination_account OR NEW.person_id IS DISTINCT FROM OLD.person_id THEN
    RAISE EXCEPTION 'payout amounts and destination are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payout_final BEFORE UPDATE ON payout FOR EACH ROW EXECUTE FUNCTION payout_final();
CREATE TRIGGER payout_no_delete BEFORE DELETE ON payout FOR EACH ROW EXECUTE FUNCTION asset_refuse_change();
