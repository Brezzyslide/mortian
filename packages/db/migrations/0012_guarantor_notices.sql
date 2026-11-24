-- Notices can go to a guarantor (who has no account of their own) as well as to a person.
ALTER TABLE notification_log
  ALTER COLUMN person_id DROP NOT NULL,
  ADD COLUMN guarantor_id uuid REFERENCES guarantor (id),
  ADD CONSTRAINT notification_log_one_recipient CHECK ((person_id IS NULL) <> (guarantor_id IS NULL));
CREATE INDEX notification_log_account_idx ON notification_log (finance_account_id, sent_at);
