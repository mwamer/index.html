-- The editor registry, and what has been done to it.
--
-- D1 is authoritative for who may edit the website. The Cloudflare Access policy
-- is a copy of this table, reconciled after every change, because Access decides
-- who may sign in while this decides what they may then do.
--
-- Addresses are stored lowercased. Email is the identity, so it is the primary
-- key, and the database itself refuses two editors at one address.

CREATE TABLE IF NOT EXISTS editors (
    email       TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'news-editor')),
    status      TEXT NOT NULL CHECK (status IN ('active', 'pending', 'suspended')),
    added_at    TEXT NOT NULL,
    added_by    TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    modified_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS audit_recent ON audit (id DESC);
