-- Identity, authentication and audit.
-- One person can hold several roles. Customers, riders and merchants sign in with phone + OTP.
-- Staff sign in with email + password + TOTP. Guarantors sign through per-contract links (no account).

CREATE TABLE person (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nigerian mobile numbers in E.164: +234 then 70x, 80x, 81x, 90x or 91x
  phone       text UNIQUE CHECK (phone ~ '^\+234(70|80|81|90|91)[0-9]{8}$'),
  email       text UNIQUE CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name   text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE person_role (
  person_id   uuid NOT NULL REFERENCES person (id),
  role        text NOT NULL CHECK (role IN (
                'customer', 'rider', 'merchant',
                'underwriter', 'collections', 'dispatch_ops', 'finance', 'manager', 'super_admin')),
  granted_by  uuid REFERENCES person (id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, role)
);

CREATE TABLE otp_challenge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text NOT NULL,
  code_hash     text NOT NULL,
  purpose       text NOT NULL CHECK (purpose IN ('login')),
  expires_at    timestamptz NOT NULL,
  attempts      int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  int NOT NULL DEFAULT 5,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ip            text
);
CREATE INDEX otp_challenge_phone_created_idx ON otp_challenge (phone, created_at DESC);

CREATE TABLE auth_session (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id           uuid NOT NULL REFERENCES person (id),
  family_id           uuid NOT NULL,
  refresh_token_hash  text NOT NULL UNIQUE,
  kind                text NOT NULL CHECK (kind IN ('customer', 'staff')),
  mfa_verified        boolean NOT NULL DEFAULT false,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  rotated_at          timestamptz,
  revoked_at          timestamptz,
  revoke_reason       text,
  ip                  text,
  user_agent          text,
  CHECK (kind = 'customer' OR mfa_verified)
);
CREATE INDEX auth_session_family_idx ON auth_session (family_id);
CREATE INDEX auth_session_person_idx ON auth_session (person_id);

CREATE TABLE staff_credential (
  person_id          uuid PRIMARY KEY REFERENCES person (id),
  password_hash      text NOT NULL,
  totp_secret_enc    text,
  totp_enabled_at    timestamptz,
  totp_last_step     bigint,
  failed_attempts    int NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  password_set_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_mfa_challenge (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    uuid NOT NULL REFERENCES person (id),
  expires_at   timestamptz NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit log ----------------------------------------------------------

CREATE TABLE audit_event (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_id      uuid,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('person', 'system', 'anonymous')),
  action        text NOT NULL,
  subject_type  text,
  subject_id    text,
  ip            text,
  user_agent    text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_event_subject_idx ON audit_event (subject_type, subject_id);
CREATE INDEX audit_event_actor_idx   ON audit_event (actor_id, occurred_at DESC);

CREATE TRIGGER audit_event_no_update_delete BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_change();
