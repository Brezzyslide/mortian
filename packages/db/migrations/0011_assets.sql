-- Asset register: every financed bike, phone or piece of equipment, where it is, and its history.

CREATE TABLE asset (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('motorcycle', 'phone', 'equipment', 'other')),
  make               text NOT NULL CHECK (length(make) BETWEEN 1 AND 60),
  model              text NOT NULL CHECK (length(model) BETWEEN 1 AND 60),
  year               int CHECK (year IS NULL OR year BETWEEN 1990 AND 2100),
  -- The identifier that proves which unit this is: chassis/VIN for bikes, IMEI for phones, serial otherwise.
  id_kind            text NOT NULL CHECK (id_kind IN ('chassis', 'imei', 'serial')),
  identifier         text NOT NULL CHECK (identifier ~ '^[A-Z0-9]{5,40}$'),
  engine_number      text CHECK (engine_number IS NULL OR engine_number ~ '^[A-Z0-9]{3,40}$'),
  plate_number       text CHECK (plate_number IS NULL OR plate_number ~ '^[A-Z0-9]{3,12}$'),
  cost_kobo          bigint NOT NULL CHECK (cost_kobo >= 0),
  status             text NOT NULL DEFAULT 'in_stock' CHECK (status IN (
                       'in_stock', 'assigned', 'with_customer', 'recovered', 'for_sale', 'sold',
                       'paid_off', 'title_transferred', 'written_off')),
  location           text NOT NULL CHECK (length(location) BETWEEN 2 AND 200),
  -- The finance account it is (or was last) financed under. Kept after sale or payoff for history.
  finance_account_id uuid REFERENCES finance_account (id),
  created_by         uuid NOT NULL REFERENCES person (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id_kind, identifier),
  CHECK (id_kind <> 'imei' OR identifier ~ '^[0-9]{15}$'),
  CHECK (status IN ('in_stock', 'written_off') OR finance_account_id IS NOT NULL)
);
-- One asset per finance account.
CREATE UNIQUE INDEX asset_one_per_account ON asset (finance_account_id) WHERE finance_account_id IS NOT NULL;
CREATE UNIQUE INDEX asset_plate ON asset (plate_number) WHERE plate_number IS NOT NULL;
CREATE INDEX asset_status_idx ON asset (status);

-- Every change to an asset, append-only.
CREATE TABLE asset_event (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  asset_id           uuid NOT NULL REFERENCES asset (id),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  kind               text NOT NULL CHECK (kind IN (
                       'registered', 'assigned', 'unassigned', 'handed_over', 'moved', 'recovered',
                       'returned', 'listed_for_sale', 'sold', 'paid_off', 'title_transferred', 'written_off')),
  from_status        text,
  to_status          text NOT NULL,
  location           text,
  finance_account_id uuid REFERENCES finance_account (id),
  actor_id           uuid REFERENCES person (id),
  note               text,
  details            jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX asset_event_asset_idx ON asset_event (asset_id, id);

CREATE FUNCTION asset_refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be %d', TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = 'P0001';
END
$$;
CREATE TRIGGER asset_event_no_update BEFORE UPDATE OR DELETE ON asset_event FOR EACH ROW EXECUTE FUNCTION asset_refuse_change();

-- The identity of a unit never changes once registered; a mistake is written off and re-registered.
CREATE FUNCTION asset_identity_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.id_kind IS DISTINCT FROM OLD.id_kind
     OR NEW.identifier IS DISTINCT FROM OLD.identifier OR NEW.cost_kobo IS DISTINCT FROM OLD.cost_kobo
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'asset identity is immutable' USING ERRCODE = 'P0001';
  END IF;
  -- Once sold or written off, nothing changes.
  IF OLD.status IN ('sold', 'written_off', 'title_transferred') THEN
    RAISE EXCEPTION 'asset is final (%)', OLD.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER asset_identity_frozen BEFORE UPDATE ON asset FOR EACH ROW EXECUTE FUNCTION asset_identity_frozen();
CREATE TRIGGER asset_no_delete BEFORE DELETE ON asset FOR EACH ROW EXECUTE FUNCTION asset_refuse_change();

-- Selling a recovered asset is a two-person decision.
ALTER TABLE approval_request DROP CONSTRAINT approval_request_kind_check;
ALTER TABLE approval_request ADD CONSTRAINT approval_request_kind_check
  CHECK (kind IN ('terms_out_of_bounds', 'fee_waiver', 'repossession', 'release', 'close_recovered', 'asset_sale'));
