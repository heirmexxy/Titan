-- Admin/Ops dashboard: sessions and login tracking.
BEGIN;

CREATE TABLE sessions (
  id          text PRIMARY KEY,              -- sha256 of the session token
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ip          text
);
CREATE INDEX ON sessions (user_id);

ALTER TABLE users ADD COLUMN last_login_at timestamptz;
ALTER TABLE users ADD COLUMN disabled_at timestamptz;

ALTER TABLE devices ADD COLUMN notes text;

COMMIT;
