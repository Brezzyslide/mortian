-- Arrears: daily penalty interest, review and repossession tracking, ordered daily job,
-- and a deduplicated notification log.

-- One penalty posting per account per day. The base is overdue principal + interest past the
-- grace period (never fees or penalty, so penalty does not compound on itself).
CREATE TABLE penalty_accrual (
  finance_account_id  uuid   NOT NULL REFERENCES finance_account (id),
  accrual_date        date   NOT NULL,
  base_amount         bigint NOT NULL CHECK (base_amount > 0),
  rate_bps_per_day    int    NOT NULL CHECK (rate_bps_per_day > 0),
  amount              bigint NOT NULL CHECK (amount > 0),
  ledger_entry_id     uuid   NOT NULL REFERENCES ledger_entry (id),
  PRIMARY KEY (finance_account_id, accrual_date)
);
CREATE TRIGGER penalty_accrual_immutable BEFORE UPDATE OR DELETE ON penalty_accrual
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();

ALTER TABLE finance_account
  ADD COLUMN arrears_since       date,
  ADD COLUMN review_started_on   date,
  ADD COLUMN cure_deadline       date,
  ADD COLUMN repossessed_on      date,
  ADD COLUMN closed_on           date;

-- The daily job processes dates strictly in order, once each. A missed day is caught up
-- by the next run before today is processed.
CREATE TABLE job_run (
  job           text NOT NULL,
  run_date      date NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  accounts      int,
  PRIMARY KEY (job, run_date)
);

CREATE TABLE notification_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finance_account_id  uuid REFERENCES finance_account (id),
  person_id           uuid NOT NULL REFERENCES person (id),
  template            text NOT NULL,
  dedupe_key          text NOT NULL UNIQUE,
  channel             text NOT NULL,
  provider_message_id text,
  sent_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE approval_request DROP CONSTRAINT approval_request_kind_check;
ALTER TABLE approval_request ADD CONSTRAINT approval_request_kind_check
  CHECK (kind IN ('terms_out_of_bounds', 'fee_waiver', 'repossession', 'release', 'close_recovered'));
