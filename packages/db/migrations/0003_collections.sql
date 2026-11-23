-- Finance accounts, virtual accounts and incoming payment events.
-- Incoming money is first posted to the account's suspense; the allocation engine
-- (schedules) moves it to fees, interest and principal. Money that cannot be matched
-- to an account still posts, to unmatched suspense, so the clearing account always
-- mirrors the provider's settlement.

CREATE SEQUENCE finance_account_ref_seq START 1;

CREATE TABLE finance_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference     text NOT NULL UNIQUE DEFAULT ('FA-' || lpad(nextval('finance_account_ref_seq')::text, 6, '0')),
  person_id     uuid NOT NULL REFERENCES person (id),
  product_code  text NOT NULL CHECK (product_code IN (
                  'motorcycle_ride_to_own', 'phone_financing', 'school_fee_financing',
                  'business_equipment_finance', 'purchase_and_deliver')),
  status        text NOT NULL DEFAULT 'applied' CHECK (status IN (
                  'applied', 'approved', 'contracted', 'deposit_paid', 'active', 'in_arrears',
                  'repossession_review', 'repossessed', 'closed_recovered', 'settled',
                  'title_transferred', 'declined', 'withdrawn', 'written_off')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finance_account_person_idx ON finance_account (person_id);

CREATE TABLE virtual_account (
  account_number      text PRIMARY KEY CHECK (account_number ~ '^[0-9]{10}$'),
  bank_name           text NOT NULL,
  provider            text NOT NULL,
  provider_reference  text NOT NULL,
  finance_account_id  uuid NOT NULL UNIQUE REFERENCES finance_account (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_reference)
);

CREATE TABLE payment_event (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL,
  provider_reference  text NOT NULL,
  account_number      text NOT NULL,
  amount              bigint NOT NULL CHECK (amount > 0),
  paid_at             timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  payload             jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'posted', 'unmatched')),
  finance_account_id  uuid REFERENCES finance_account (id),
  ledger_entry_id     uuid REFERENCES ledger_entry (id),
  -- Set when a human must look at it: unmatched account, inactive account, conflicting redelivery.
  problem             text,
  resolved_at         timestamptz,
  resolved_by         uuid REFERENCES person (id),
  UNIQUE (provider, provider_reference),
  CHECK (status <> 'posted' OR ledger_entry_id IS NOT NULL),
  CHECK (status <> 'unmatched' OR (ledger_entry_id IS NOT NULL AND finance_account_id IS NULL))
);
CREATE INDEX payment_event_open_problems_idx ON payment_event (received_at) WHERE problem IS NOT NULL AND resolved_at IS NULL;
CREATE INDEX payment_event_account_idx ON payment_event (finance_account_id, paid_at);

-- Raw payload, amount and provider identity never change after receipt.
CREATE FUNCTION payment_event_freeze_facts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
     OR NEW.account_number IS DISTINCT FROM OLD.account_number
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'payment_event facts are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER payment_event_freeze BEFORE UPDATE ON payment_event
  FOR EACH ROW EXECUTE FUNCTION payment_event_freeze_facts();
CREATE TRIGGER payment_event_no_delete BEFORE DELETE OR TRUNCATE ON payment_event
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_change();
