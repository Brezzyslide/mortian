-- One-time setup links for staff: first-time invite, and access reset after a forgotten
-- password or a lost authenticator. Only the SHA-256 of the token is stored.

CREATE TABLE staff_setup_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    uuid NOT NULL REFERENCES person (id),
  token_hash   text NOT NULL UNIQUE,
  purpose      text NOT NULL CHECK (purpose IN ('invite', 'reset')),
  created_by   uuid REFERENCES person (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  revoked_at   timestamptz
);
-- At most one usable link per person: issuing a new one revokes the old.
CREATE UNIQUE INDEX staff_setup_token_one_open ON staff_setup_token (person_id) WHERE used_at IS NULL AND revoked_at IS NULL;
