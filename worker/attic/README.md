# Parked files

`0002_auth.sql` is not a migration and must not be applied.

It was written for an approach that was not taken: passwords and sessions inside
the Worker. Authentication is Cloudflare Access with a one-time PIN, and the
editor registry in D1 decides what a signed-in person may do. Nothing in the
Worker reads a password, so this file would add six unused columns to `editors`
and an unused `sessions` table.

It sat in `migrations/`, where `wrangler d1 migrations apply` would have picked
it up on the next run and changed the production database for nothing. It is
parked here instead, so the migration directory contains exactly what the
deployed schema is.

Delete this directory once you are sure nothing needs the file.
