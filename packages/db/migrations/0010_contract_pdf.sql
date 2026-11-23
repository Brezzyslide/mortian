-- Executed agreement as a PDF, archived next to the text and certificate.
ALTER TABLE contract
  ADD COLUMN archive_pdf_key text,
  ADD COLUMN pdf_sha256      text CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$');

-- Once executed, the archive pointers and hashes are as permanent as the wording.
CREATE FUNCTION contract_freeze_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'fully_executed' AND (
       NEW.archive_document_key IS DISTINCT FROM OLD.archive_document_key
    OR NEW.archive_certificate_key IS DISTINCT FROM OLD.archive_certificate_key
    OR NEW.archive_pdf_key IS DISTINCT FROM OLD.archive_pdf_key
    OR NEW.certificate_sha256 IS DISTINCT FROM OLD.certificate_sha256
    OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256
    OR NEW.executed_at IS DISTINCT FROM OLD.executed_at) THEN
    RAISE EXCEPTION 'an executed contract''s archive is immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER contract_freeze_archive BEFORE UPDATE ON contract FOR EACH ROW EXECUTE FUNCTION contract_freeze_archive();
