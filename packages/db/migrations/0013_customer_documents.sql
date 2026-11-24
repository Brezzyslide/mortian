-- Identity and supporting documents uploaded by customers, reviewed by staff.
CREATE TABLE customer_document (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id          uuid NOT NULL REFERENCES person (id),
  kind               text NOT NULL CHECK (kind IN (
                       'national_id', 'drivers_licence', 'voters_card', 'passport', 'proof_of_address', 'other')),
  content_type       text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes         int  NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 8388608),
  sha256             text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key        text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'accepted', 'rejected')),
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  reviewed_by        uuid REFERENCES person (id),
  reviewed_at        timestamptz,
  review_note        text,
  CHECK ((status = 'submitted') = (reviewed_by IS NULL)),
  CHECK (status <> 'rejected' OR length(btrim(coalesce(review_note, ''))) >= 5),
  -- Staff never review their own documents.
  CHECK (reviewed_by IS NULL OR reviewed_by <> person_id),
  UNIQUE (person_id, sha256)
);
CREATE INDEX customer_document_person_idx ON customer_document (person_id, uploaded_at DESC);

-- A decision is final; a rejected document is replaced by a new upload, not re-reviewed.
CREATE FUNCTION customer_document_review_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'submitted' THEN
    RAISE EXCEPTION 'document already reviewed' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.content_type IS DISTINCT FROM OLD.content_type OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at THEN
    RAISE EXCEPTION 'document content is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER customer_document_review_once BEFORE UPDATE ON customer_document FOR EACH ROW EXECUTE FUNCTION customer_document_review_once();
