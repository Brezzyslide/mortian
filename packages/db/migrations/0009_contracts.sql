-- Contracts and first-party signing.
-- Templates are versioned and frozen once approved. A contract is rendered from one approved
-- template version and one term snapshot; its SHA-256 is fixed at issue. Signers sign in order:
-- borrower, then each guarantor, then a company signatory. Every step is an append-only event.

CREATE TABLE contract_template (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_code   text NOT NULL,
  version        int  NOT NULL CHECK (version >= 1),
  title          text NOT NULL,
  body           text NOT NULL,
  is_placeholder boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  created_by     uuid REFERENCES person (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_by    uuid REFERENCES person (id),
  approved_at    timestamptz,
  legal_review_note text,
  UNIQUE (product_code, version),
  CHECK (status = 'draft' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND legal_review_note IS NOT NULL)),
  CHECK (approved_by IS NULL OR created_by IS NULL OR approved_by <> created_by)
);

-- Approved wording can never change; only its status may move to retired.
CREATE FUNCTION contract_template_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.version IS DISTINCT FROM OLD.version OR NEW.product_code IS DISTINCT FROM OLD.product_code
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by) THEN
    RAISE EXCEPTION 'approved contract templates are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER contract_template_freeze BEFORE UPDATE ON contract_template FOR EACH ROW EXECUTE FUNCTION contract_template_freeze();
CREATE TRIGGER contract_template_no_delete BEFORE DELETE ON contract_template FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();

CREATE TABLE guarantor (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finance_account_id  uuid NOT NULL REFERENCES finance_account (id),
  full_name           text NOT NULL CHECK (length(btrim(full_name)) >= 2),
  phone               text NOT NULL CHECK (phone ~ '^\+234(70|80|81|90|91)[0-9]{8}$'),
  relationship        text NOT NULL,
  added_by            uuid NOT NULL REFERENCES person (id),
  added_at            timestamptz NOT NULL DEFAULT now(),
  removed_at          timestamptz,
  UNIQUE (finance_account_id, phone)
);

CREATE TABLE contract (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finance_account_id  uuid NOT NULL REFERENCES finance_account (id),
  template_id         uuid NOT NULL REFERENCES contract_template (id),
  snapshot_id         uuid NOT NULL REFERENCES term_snapshot (id),
  rendered_text       text NOT NULL,
  -- the exact values substituted into the template, so key terms shown to signers never drift
  field_values        jsonb NOT NULL,
  document_sha256     text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  is_placeholder      boolean NOT NULL,
  status              text NOT NULL DEFAULT 'issued' CHECK (status IN (
                        'issued', 'partially_signed', 'fully_executed', 'rejected', 'expired', 'revoked')),
  issued_by           uuid NOT NULL REFERENCES person (id),
  issued_at           timestamptz NOT NULL DEFAULT now(),
  executed_at         timestamptz,
  archive_document_key     text,
  archive_certificate_key  text,
  certificate_sha256       text,
  closed_reason       text
);
-- One contract in flight or executed per account at a time.
CREATE UNIQUE INDEX contract_one_live ON contract (finance_account_id)
  WHERE status IN ('issued', 'partially_signed', 'fully_executed');

CREATE FUNCTION contract_freeze_text() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rendered_text IS DISTINCT FROM OLD.rendered_text OR NEW.field_values IS DISTINCT FROM OLD.field_values
     OR NEW.document_sha256 IS DISTINCT FROM OLD.document_sha256
     OR NEW.template_id IS DISTINCT FROM OLD.template_id OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
     OR NEW.finance_account_id IS DISTINCT FROM OLD.finance_account_id THEN
    RAISE EXCEPTION 'contract wording and hash are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('fully_executed', 'rejected', 'expired', 'revoked') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a closed contract cannot change status' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER contract_freeze BEFORE UPDATE ON contract FOR EACH ROW EXECUTE FUNCTION contract_freeze_text();
CREATE TRIGGER contract_no_delete BEFORE DELETE ON contract FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();

CREATE TABLE signing_session (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id       uuid NOT NULL REFERENCES contract (id),
  signer_order      int  NOT NULL CHECK (signer_order >= 1),
  signer_role       text NOT NULL CHECK (signer_role IN ('borrower', 'guarantor', 'company')),
  guarantor_id      uuid REFERENCES guarantor (id),
  signer_person_id  uuid REFERENCES person (id),
  signer_name       text NOT NULL,
  phone             text,
  token_hash        text UNIQUE,
  status            text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'open', 'signed', 'declined', 'expired', 'cancelled')),
  link_sent_at      timestamptz,
  expires_at        timestamptz,
  otp_hash          text,
  otp_expires_at    timestamptz,
  otp_attempts      int NOT NULL DEFAULT 0,
  otp_verified_at   timestamptz,
  signed_at         timestamptz,
  device_id_hash    text,
  evidence          jsonb,
  signature_image   bytea,
  UNIQUE (contract_id, signer_order),
  CHECK ((signer_role = 'guarantor') = (guarantor_id IS NOT NULL)),
  CHECK (signer_role = 'company' OR phone IS NOT NULL),
  CHECK (signature_image IS NULL OR octet_length(signature_image) <= 300000)
);

CREATE TABLE contract_event (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contract_id  uuid NOT NULL REFERENCES contract (id),
  session_id   uuid REFERENCES signing_session (id),
  at           timestamptz NOT NULL DEFAULT now(),
  event        text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX contract_event_contract_idx ON contract_event (contract_id, id);
CREATE TRIGGER contract_event_immutable BEFORE UPDATE OR DELETE ON contract_event
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();
