-- Two-person approvals. One staff member proposes; a different staff member confirms from
-- their own session. Used for out-of-bounds terms and fee waivers; reusable for write-offs,
-- repossession and release.

CREATE TABLE approval_request (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('terms_out_of_bounds', 'fee_waiver')),
  finance_account_id  uuid NOT NULL REFERENCES finance_account (id),
  payload             jsonb NOT NULL,
  reason              text NOT NULL CHECK (length(btrim(reason)) >= 5),
  requested_by        uuid NOT NULL REFERENCES person (id),
  requested_at        timestamptz NOT NULL DEFAULT now(),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by          uuid REFERENCES person (id),
  decided_at          timestamptz,
  decision_note       text,
  CHECK (status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX approval_request_pending_idx ON approval_request (requested_at) WHERE status = 'pending';
-- At most one pending request of a kind per account, so approvals cannot be stacked or raced.
CREATE UNIQUE INDEX approval_request_one_pending ON approval_request (finance_account_id, kind) WHERE status = 'pending';

-- Per-product live switch. Applications are refused for products that are not live.
CREATE TABLE product_setting (
  product_code  text PRIMARY KEY CHECK (product_code IN (
                  'motorcycle_ride_to_own', 'phone_financing', 'school_fee_financing',
                  'business_equipment_finance', 'purchase_and_deliver', 'dispatch')),
  live          boolean NOT NULL DEFAULT false,
  updated_by    uuid REFERENCES person (id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO product_setting (product_code) VALUES
  ('motorcycle_ride_to_own'), ('phone_financing'), ('school_fee_financing'),
  ('business_equipment_finance'), ('purchase_and_deliver'), ('dispatch');
