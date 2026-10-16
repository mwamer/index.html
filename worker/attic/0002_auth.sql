-- App-level authentication (passwords + sessions)
ALTER TABLE editors ADD COLUMN password_hash TEXT;
ALTER TABLE editors ADD COLUMN password_set_at TEXT;
ALTER TABLE editors ADD COLUMN force_password_reset INTEGER DEFAULT 0;
ALTER TABLE editors ADD COLUMN failed_login_attempts INTEGER DEFAULT 0;
ALTER TABLE editors ADD COLUMN locked_until TEXT;
ALTER TABLE editors ADD COLUMN last_login_at TEXT;

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    user_agent TEXT,
    ip_hash TEXT
);

CREATE INDEX IF NOT EXISTS sessions_email ON sessions (email);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);
