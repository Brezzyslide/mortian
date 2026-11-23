-- Ledger: append-only double-entry, four books.
-- Guarantees enforced by the database, not only by application code:
--   * an entry and all its lines belong to one book (composite foreign keys)
--   * every entry balances and has at least two lines (deferred constraint trigger, checked at commit)
--   * lines can only be added in the transaction that created their entry
--   * entries and lines can never be updated, deleted or truncated
--   * an idempotency key is used once; an entry is reversed at most once

CREATE TABLE ledger_account (
  code        text PRIMARY KEY,
  book        text NOT NULL CHECK (book IN ('financing', 'dispatch', 'merchant', 'platform')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, book),
  CHECK (
    (book = 'financing' AND code LIKE 'fin:_%') OR
    (book = 'dispatch'  AND code LIKE 'dsp:_%') OR
    (book = 'merchant'  AND code LIKE 'mer:_%') OR
    (book = 'platform'  AND code LIKE 'plt:_%')
  )
);

CREATE TABLE ledger_entry (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key    text NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) > 0),
  payload_hash       text NOT NULL,
  book               text NOT NULL CHECK (book IN ('financing', 'dispatch', 'merchant', 'platform')),
  source             text NOT NULL CHECK (source IN ('webhook', 'admin', 'scheduler', 'system')),
  actor_id           text NOT NULL,
  description        text NOT NULL,
  occurred_at        timestamptz NOT NULL,
  posted_at          timestamptz NOT NULL DEFAULT now(),
  reverses_entry_id  uuid UNIQUE REFERENCES ledger_entry (id),
  UNIQUE (id, book)
);

CREATE TABLE ledger_line (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id      uuid   NOT NULL,
  book          text   NOT NULL,
  account_code  text   NOT NULL,
  side          text   NOT NULL CHECK (side IN ('debit', 'credit')),
  amount        bigint NOT NULL CHECK (amount > 0),
  FOREIGN KEY (entry_id, book)     REFERENCES ledger_entry (id, book),
  FOREIGN KEY (account_code, book) REFERENCES ledger_account (code, book)
);

CREATE INDEX ledger_line_account_idx ON ledger_line (account_code);
CREATE INDEX ledger_line_entry_idx   ON ledger_line (entry_id);

-- Immutability -------------------------------------------------------------

CREATE FUNCTION ledger_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are immutable (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END
$$;

CREATE TRIGGER ledger_entry_no_update_delete BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();
CREATE TRIGGER ledger_entry_no_truncate BEFORE TRUNCATE ON ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_change();
CREATE TRIGGER ledger_line_no_update_delete BEFORE UPDATE OR DELETE ON ledger_line
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();
CREATE TRIGGER ledger_line_no_truncate BEFORE TRUNCATE ON ledger_line
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_change();

-- Lines only in the entry's own transaction ----------------------------------

CREATE FUNCTION ledger_line_same_tx() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_xmin text;
BEGIN
  SELECT xmin::text INTO entry_xmin FROM ledger_entry WHERE id = NEW.entry_id;
  IF entry_xmin IS DISTINCT FROM (txid_current() % 4294967296)::text THEN
    RAISE EXCEPTION 'lines can only be added in the transaction that created entry %', NEW.entry_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ledger_line_same_tx BEFORE INSERT ON ledger_line
  FOR EACH ROW EXECUTE FUNCTION ledger_line_same_tx();

-- Balanced at commit -------------------------------------------------------------

CREATE FUNCTION ledger_check_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  debits  bigint;
  credits bigint;
  n       int;
BEGIN
  SELECT coalesce(sum(amount) FILTER (WHERE side = 'debit'), 0),
         coalesce(sum(amount) FILTER (WHERE side = 'credit'), 0),
         count(*)
    INTO debits, credits, n
    FROM ledger_line
   WHERE entry_id = NEW.id;

  IF n < 2 THEN
    RAISE EXCEPTION 'ledger entry % has % line(s); at least 2 required', NEW.id, n
      USING ERRCODE = 'P0001';
  END IF;
  IF debits <> credits THEN
    RAISE EXCEPTION 'ledger entry % is unbalanced: debits % credits %', NEW.id, debits, credits
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER ledger_entry_balanced AFTER INSERT ON ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_entry_balanced();
