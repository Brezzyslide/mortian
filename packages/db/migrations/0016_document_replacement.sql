-- A new upload of the same document type replaces the customer's earlier one that is still
-- waiting for review. The earlier row and file are kept (for the audit trail) and marked
-- 'replaced', pointing at the upload that replaced it. 'other' documents never replace.
ALTER TABLE customer_document
  -- Deferred: the old row is marked before the replacing row is inserted, in one transaction.
  ADD COLUMN replaced_by uuid REFERENCES customer_document (id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN replaced_at timestamptz;

ALTER TABLE customer_document DROP CONSTRAINT customer_document_status_check;
ALTER TABLE customer_document ADD CONSTRAINT customer_document_status_check
  CHECK (status IN ('submitted', 'accepted', 'rejected', 'replaced'));

-- Reviewed rows have a reviewer; submitted and replaced rows do not.
ALTER TABLE customer_document DROP CONSTRAINT customer_document_check;
ALTER TABLE customer_document ADD CONSTRAINT customer_document_reviewer_check
  CHECK ((status IN ('submitted', 'replaced')) = (reviewed_by IS NULL));

ALTER TABLE customer_document ADD CONSTRAINT customer_document_replaced_check
  CHECK ((status = 'replaced') = (replaced_by IS NOT NULL AND replaced_at IS NOT NULL)
         AND (replaced_by IS NULL OR replaced_by <> id)
         AND (status <> 'replaced' OR kind <> 'other'));

-- Existing data: where a customer already has several pending uploads of one type, keep the
-- newest pending and mark the older ones replaced by it.
UPDATE customer_document d
   SET status = 'replaced', replaced_by = n.id, replaced_at = now()
  FROM (SELECT DISTINCT ON (person_id, kind) id, person_id, kind
          FROM customer_document
         WHERE status = 'submitted' AND kind <> 'other'
         ORDER BY person_id, kind, uploaded_at DESC, id DESC) n
 WHERE d.person_id = n.person_id AND d.kind = n.kind AND d.status = 'submitted' AND d.id <> n.id;
-- Check the deferred reference now: an index cannot be built with checks still pending.
SET CONSTRAINTS ALL IMMEDIATE;

-- At most one upload of each type (other than 'other') waits for review per customer.
CREATE UNIQUE INDEX customer_document_one_pending_per_kind
  ON customer_document (person_id, kind) WHERE status = 'submitted' AND kind <> 'other';

-- The review-once trigger already refuses any change once a row has left 'submitted', so a
-- replaced row can no longer be accepted or rejected, and a reviewed row cannot be replaced.
