-- Dispatch marketplace: riders, pricing, quotes, jobs. Money lives in the ledger's dispatch book.

-- Pricing versions. A quote records the version it used, so changing prices never changes a quote.
CREATE TABLE dispatch_pricing (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_fare_kobo         bigint NOT NULL CHECK (base_fare_kobo >= 0),
  per_km_kobo            bigint NOT NULL CHECK (per_km_kobo >= 0),
  min_fare_kobo          bigint NOT NULL CHECK (min_fare_kobo > 0),
  commission_bps         int    NOT NULL CHECK (commission_bps BETWEEN 0 AND 5000),
  -- A rider who owes more than this (cash commissions not yet recovered) gets no cash jobs.
  cash_debt_limit_kobo   bigint NOT NULL CHECK (cash_debt_limit_kobo >= 0),
  search_radius_m        int    NOT NULL CHECK (search_radius_m BETWEEN 500 AND 50000),
  is_placeholder         boolean NOT NULL DEFAULT false,
  created_by             uuid REFERENCES person (id),
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE rider_ref_seq;
CREATE TABLE rider (
  person_id          uuid PRIMARY KEY REFERENCES person (id),
  reference          text NOT NULL UNIQUE DEFAULT ('R-' || lpad(nextval('rider_ref_seq')::text, 5, '0')),
  kind               text NOT NULL CHECK (kind IN ('financed', 'own_bike')),
  -- For a financed rider: the ride-to-own account the bike is on.
  finance_account_id uuid REFERENCES finance_account (id),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  online             boolean NOT NULL DEFAULT false,
  last_lat           double precision CHECK (last_lat IS NULL OR last_lat BETWEEN -90 AND 90),
  last_lng           double precision CHECK (last_lng IS NULL OR last_lng BETWEEN -180 AND 180),
  last_seen_at       timestamptz,
  decided_by         uuid REFERENCES person (id),
  decided_at         timestamptz,
  status_note        text,
  applied_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'financed') = (finance_account_id IS NOT NULL)),
  CHECK (NOT online OR status = 'active'),
  CHECK (decided_by IS NULL OR decided_by <> person_id)
);

CREATE TABLE dispatch_quote (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid NOT NULL REFERENCES person (id),
  pricing_id       uuid NOT NULL REFERENCES dispatch_pricing (id),
  pickup_lat       double precision NOT NULL CHECK (pickup_lat BETWEEN -90 AND 90),
  pickup_lng       double precision NOT NULL CHECK (pickup_lng BETWEEN -180 AND 180),
  pickup_address   text NOT NULL CHECK (length(pickup_address) BETWEEN 3 AND 300),
  dropoff_lat      double precision NOT NULL CHECK (dropoff_lat BETWEEN -90 AND 90),
  dropoff_lng      double precision NOT NULL CHECK (dropoff_lng BETWEEN -180 AND 180),
  dropoff_address  text NOT NULL CHECK (length(dropoff_address) BETWEEN 3 AND 300),
  distance_m       int NOT NULL CHECK (distance_m > 0),
  distance_source  text NOT NULL,
  fare_kobo        bigint NOT NULL CHECK (fare_kobo > 0),
  commission_kobo  bigint NOT NULL CHECK (commission_kobo >= 0 AND commission_kobo <= fare_kobo),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);
CREATE INDEX dispatch_quote_customer_idx ON dispatch_quote (customer_id, created_at DESC);

CREATE SEQUENCE dispatch_job_ref_seq;
CREATE TABLE dispatch_job (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text NOT NULL UNIQUE DEFAULT ('DJ-' || lpad(nextval('dispatch_job_ref_seq')::text, 6, '0')),
  customer_id         uuid NOT NULL REFERENCES person (id),
  quote_id            uuid NOT NULL UNIQUE REFERENCES dispatch_quote (id),
  payment_method      text NOT NULL CHECK (payment_method IN ('cash', 'in_app')),
  status              text NOT NULL CHECK (status IN ('awaiting_payment', 'searching', 'accepted', 'picked_up', 'delivered', 'cancelled')),
  rider_id            uuid REFERENCES rider (person_id),
  fare_kobo           bigint NOT NULL,
  commission_kobo     bigint NOT NULL,
  recipient_name      text NOT NULL CHECK (length(btrim(recipient_name)) >= 2),
  recipient_phone     text NOT NULL CHECK (recipient_phone ~ '^\+234(70|80|81|90|91)[0-9]{8}$'),
  package_note        text CHECK (package_note IS NULL OR length(package_note) <= 300),
  pickup_code_hash    text NOT NULL,
  delivery_code_hash  text NOT NULL,
  pickup_attempts     int NOT NULL DEFAULT 0,
  delivery_attempts   int NOT NULL DEFAULT 0,
  payment_reference   text UNIQUE,
  paid_entry_id       uuid,
  settled_entry_id    uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  picked_up_at        timestamptz,
  delivered_at        timestamptz,
  cancelled_at        timestamptz,
  cancel_reason       text,
  CHECK (status IN ('awaiting_payment', 'searching', 'cancelled') OR rider_id IS NOT NULL),
  CHECK (status <> 'awaiting_payment' OR payment_method = 'in_app'),
  -- Every delivery is settled in the ledger, except a cash job with no commission (nothing to post).
  CHECK (status <> 'delivered' OR settled_entry_id IS NOT NULL OR (payment_method = 'cash' AND commission_kobo = 0)),
  CHECK (customer_id <> rider_id)
);
CREATE INDEX dispatch_job_status_idx ON dispatch_job (status, created_at);
CREATE INDEX dispatch_job_rider_idx ON dispatch_job (rider_id, status);
CREATE INDEX dispatch_job_customer_idx ON dispatch_job (customer_id, created_at DESC);
-- One job at a time per rider.
CREATE UNIQUE INDEX dispatch_job_one_live_per_rider ON dispatch_job (rider_id) WHERE status IN ('accepted', 'picked_up');

-- A job only moves forward; delivered and cancelled are final.
CREATE FUNCTION dispatch_job_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rank_old int := array_position(ARRAY['awaiting_payment','searching','accepted','picked_up','delivered'], OLD.status);
  rank_new int := array_position(ARRAY['awaiting_payment','searching','accepted','picked_up','delivered'], NEW.status);
BEGIN
  IF OLD.status IN ('delivered', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'dispatch job % is final', OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status <> 'cancelled' AND rank_new < rank_old THEN
    RAISE EXCEPTION 'dispatch job cannot move from % back to %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'cancelled' AND OLD.status = 'picked_up' THEN
    RAISE EXCEPTION 'a picked-up parcel cannot be cancelled' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.fare_kobo IS DISTINCT FROM OLD.fare_kobo OR NEW.commission_kobo IS DISTINCT FROM OLD.commission_kobo
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
     OR (OLD.rider_id IS NOT NULL AND NEW.rider_id IS DISTINCT FROM OLD.rider_id) THEN
    RAISE EXCEPTION 'dispatch job terms are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dispatch_job_forward_only BEFORE UPDATE ON dispatch_job FOR EACH ROW EXECUTE FUNCTION dispatch_job_forward_only();

CREATE TABLE dispatch_job_event (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES dispatch_job (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,
  actor_id    uuid REFERENCES person (id),
  lat         double precision,
  lng         double precision,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX dispatch_job_event_job_idx ON dispatch_job_event (job_id, id);
CREATE TRIGGER dispatch_job_event_append_only BEFORE UPDATE OR DELETE ON dispatch_job_event FOR EACH ROW EXECUTE FUNCTION asset_refuse_change();

