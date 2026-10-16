-- What Cloudflare Access was last told, and what came of it.
--
-- The Access policy is a copy of the editor registry, so it is reconciled after
-- every change to it. A reconciliation can fail — the API token can be missing,
-- a request can time out — and when it does, the registry is still the truth.
-- This table is how that is known rather than guessed: the newest row says
-- whether the policy matched the registry, so the panel can warn, and the owner
-- can retry, instead of the two drifting apart silently.
--
-- Rows are append-only. The history is short and it answers "did this ever work
-- on this deployment", which a single mutable row would not.

CREATE TABLE IF NOT EXISTS access_sync (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    state  TEXT NOT NULL CHECK (state IN ('ok', 'skipped', 'failed')),
    detail TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS access_sync_recent ON access_sync (id DESC);
