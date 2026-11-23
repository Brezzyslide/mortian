-- Risk-tier presets, frozen term snapshots, repayment schedules, allocations and fees.
-- Tier presets are versioned: a change is a new version, never an edit. Accounts copy the
-- terms they were approved on into an immutable snapshot, which drives both the contract
-- and the schedule. Amounts paid are derived from allocation rows, never stored as counters.

CREATE TABLE product_tier (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code    text NOT NULL,
  tier            text NOT NULL CHECK (tier ~ '^[A-Z]$'),
  version         int  NOT NULL CHECK (version >= 1),
  config          jsonb NOT NULL,
  is_placeholder  boolean NOT NULL,
  note            text,
  created_by      uuid REFERENCES person (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_code, tier, version)
);
CREATE TRIGGER product_tier_immutable BEFORE UPDATE OR DELETE ON product_tier
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();

CREATE VIEW product_tier_current AS
  SELECT DISTINCT ON (product_code, tier) *
    FROM product_tier
   ORDER BY product_code, tier, version DESC;

CREATE TABLE term_snapshot (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finance_account_id  uuid NOT NULL REFERENCES finance_account (id),
  version             int  NOT NULL CHECK (version >= 1),
  product_tier_id     uuid NOT NULL REFERENCES product_tier (id),
  tier                text NOT NULL,
  terms               jsonb NOT NULL,
  overridden          text[] NOT NULL DEFAULT '{}',
  out_of_bounds       text[] NOT NULL DEFAULT '{}',
  is_placeholder      boolean NOT NULL,
  created_by          uuid NOT NULL REFERENCES person (id),
  approved_by         uuid REFERENCES person (id),
  reason              text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (finance_account_id, version),
  -- Anything outside the tier's floor/ceiling needs a second person and a reason.
  CHECK (cardinality(out_of_bounds) = 0 OR (approved_by IS NOT NULL AND approved_by <> created_by AND reason IS NOT NULL))
);
CREATE TRIGGER term_snapshot_immutable BEFORE UPDATE OR DELETE ON term_snapshot
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();

ALTER TABLE finance_account
  ADD COLUMN current_snapshot_id uuid REFERENCES term_snapshot (id),
  ADD COLUMN activated_on date,
  ADD COLUMN settled_on date;

CREATE TABLE instalment (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finance_account_id         uuid   NOT NULL REFERENCES finance_account (id),
  snapshot_id                uuid   NOT NULL REFERENCES term_snapshot (id),
  seq                        int    NOT NULL CHECK (seq >= 1),
  due_date                   date   NOT NULL,
  principal_due              bigint NOT NULL CHECK (principal_due >= 0),
  interest_due               bigint NOT NULL CHECK (interest_due >= 0),
  interest_accrued_entry_id  uuid REFERENCES ledger_entry (id),
  UNIQUE (finance_account_id, snapshot_id, seq)
);
CREATE INDEX instalment_due_idx ON instalment (finance_account_id, due_date);

-- Schedule amounts are fixed once generated; only the accrual link may be set, once.
CREATE FUNCTION instalment_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.finance_account_id IS DISTINCT FROM OLD.finance_account_id
     OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
     OR NEW.seq IS DISTINCT FROM OLD.seq
     OR NEW.due_date IS DISTINCT FROM OLD.due_date
     OR NEW.principal_due IS DISTINCT FROM OLD.principal_due
     OR NEW.interest_due IS DISTINCT FROM OLD.interest_due
     OR (OLD.interest_accrued_entry_id IS NOT NULL
         AND NEW.interest_accrued_entry_id IS DISTINCT FROM OLD.interest_accrued_entry_id) THEN
    RAISE EXCEPTION 'instalment amounts and dates are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER instalment_freeze BEFORE UPDATE ON instalment FOR EACH ROW EXECUTE FUNCTION instalment_freeze();
CREATE TRIGGER instalment_no_delete BEFORE DELETE ON instalment FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();

CREATE TABLE fee_charge (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finance_account_id   uuid   NOT NULL REFERENCES finance_account (id),
  code                 text   NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  amount               bigint NOT NULL CHECK (amount > 0),
  charged_entry_id     uuid   NOT NULL REFERENCES ledger_entry (id),
  charged_by           uuid   NOT NULL REFERENCES person (id),
  charged_at           timestamptz NOT NULL DEFAULT now(),
  status               text   NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waived')),
  waiver_requested_by  uuid REFERENCES person (id),
  waiver_approved_by   uuid REFERENCES person (id),
  waiver_reason        text,
  waiver_entry_id      uuid REFERENCES ledger_entry (id),
  waived_at            timestamptz,
  CHECK (status <> 'waived' OR (
    waiver_requested_by IS NOT NULL AND waiver_approved_by IS NOT NULL
    AND waiver_requested_by <> waiver_approved_by AND waiver_reason IS NOT NULL AND waived_at IS NOT NULL))
);

CREATE TABLE allocation (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finance_account_id  uuid   NOT NULL REFERENCES finance_account (id),
  ledger_entry_id     uuid   NOT NULL REFERENCES ledger_entry (id),
  component           text   NOT NULL CHECK (component IN ('fee', 'penalty', 'interest', 'principal')),
  instalment_id       bigint REFERENCES instalment (id),
  fee_charge_id       uuid   REFERENCES fee_charge (id),
  amount              bigint NOT NULL CHECK (amount > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((component IN ('interest', 'principal')) = (instalment_id IS NOT NULL)),
  CHECK ((component = 'fee') = (fee_charge_id IS NOT NULL))
);
CREATE INDEX allocation_instalment_idx ON allocation (instalment_id);
CREATE INDEX allocation_fee_idx ON allocation (fee_charge_id);
CREATE TRIGGER allocation_immutable BEFORE UPDATE OR DELETE ON allocation
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();
