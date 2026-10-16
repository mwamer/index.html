# The website API

The admin panel writes to `mwamer/index.html` through this Worker, and nowhere else. The Worker holds the GitHub token and the Cloudflare API token; the browser never sees either.

Authentication is Cloudflare Access. The Worker verifies the Access JWT itself, so a request that skips Access still fails. Authorisation is the **editor registry** in D1: a verified account may read the panel, and only an `active` record may write.

## The editor registry

D1 holds one row per editor.

| Column | Values |
| --- | --- |
| `email` | the address Access signs in with |
| `role` | `owner` or `news-editor` |
| `status` | `pending`, `active`, or `suspended` |

Rules the registry enforces:

- A new editor starts `pending`, so they can sign in and read the panel but cannot publish.
- Only the owner may add, activate, suspend, or remove an editor.
- An `owner` record can never be suspended or removed, and the last active owner can never be demoted. Without this, one wrong click leaves the site with nobody who can publish.
- The registry **fails closed**. If `DB` is missing or a query fails, every protected route answers `503`. It never falls back to a list of allowed addresses, because that list is not a permission the registry granted.

`ALLOWED_EMAILS` is a **bootstrap secret only**: it seeds the owner record the first time an allowlisted account signs in. Adding an address there does not make anyone an editor.

## One save, one commit

A save is a single commit, built through the GitHub Git Data API:

1. read the branch head and compare it with the `base` the panel sent
2. upload each changed file as a blob
3. create one tree on top of the head's tree, with deletions expressed as an entry whose `sha` is `null`
4. create one commit with that tree
5. move the branch to it with `force: false`

The last step is the compare-and-swap: GitHub refuses anything that is not a fast-forward. A refusal is answered as `409` and the panel keeps the draft.

This replaced one commit per file, which could leave the site readable in a state the panel never meant to publish — a card removed before the page it pointed at. A save now lands entirely or not at all.

## What the panel may touch

| Path | Rule |
| --- | --- |
| `news-engagement.html` | this one file |
| `.panel-state.json` | the record of what has been published |
| `engagement-<name>.html` | lowercase letters, numbers and dashes only |
| `images/<name>-YYYYMMDD.<ext>` | `jpeg`, `jpg`, `png`, `webp`, `avif`; date required; bytes must be a real image |

Everything else — `index.html`, `about.html`, `worker/worker.js` — is refused with `400`.

## Endpoints

Cloudflare Access sits in front of the whole hostname, so every route is reached through Access. The **Who** column is what the Worker checks itself, which is the half an attacker who skipped Access would also have to satisfy.

| Route | Who | What it does |
| --- | --- | --- |
| `/`, `/api/signed-in` | any session | the sign-in landing page; does not need a registry record |
| `/api/health` | no session | reports which secrets are configured; booleans only |
| `/api/verify` | any session | the caller's email, GitHub permission, editor record, and the current head |
| `/api/head` | any editor | the revision a save must name as its base |
| `/api/read`, `/api/read-at`, `/api/history` | any editor | read a permitted file, at the branch or at a revision |
| `/api/commit` | active editor | one save as one commit |
| `/api/write`, `/api/remove` | active editor | a single file; both require the revision being changed |
| `/api/admin/editors` | owner | list, add, update, remove |
| `/api/admin/access` | owner | what Access is being told, and a way to reconcile now |

`/api/write` and `/api/remove` no longer look the current sha up for you. Doing so wrote over whatever the file held at that moment, which is exactly the overwrite a second editor must never suffer.

## Keeping Cloudflare Access in step

Cloudflare Access holds its own copy of who may sign in, and it must agree with the registry. After every editor change the Worker reconciles the policy:

- the policy is identified by `ACCESS_AUD`, then by `ACCESS_POLICY_ID` or a policy named by `ACCESS_POLICY_NAME` (default `Editors`)
- it refuses to write a policy whose allow-list would be empty, so a broken registry cannot lock everyone out
- it never creates or deletes an application or policy
- it **never throws** for a normal save: the registry write has already happened, and a Cloudflare outage must not be reported as the editor change failing

Every attempt is recorded in `access_sync` with `ok`, `skipped`, or `failed`. With no `CF_API_TOKEN` the result is `skipped` and the panel says so. The safe direction to drift is registry-ahead-of-Access, because Access is the stricter gate; the panel surfaces the difference instead of hiding it.

## Deployment order

The registry fails closed, so a deploy that lands before its migration is a Worker that refuses every write. Apply migrations first.

```bash
cd worker
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

Secrets, in `wrangler.toml` or as secrets:

| Name | Purpose |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | `<team>.cloudflareaccess.com`, as the dashboard shows it |
| `ACCESS_AUD` | the Access application's Audience tag |
| `GITHUB_TOKEN` | fine-grained token, `Contents: Read and write` on `mwamer/index.html` only |
| `ALLOWED_EMAILS` | bootstrap only (see above) |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | optional; enables Access reconciliation |
| `ACCESS_POLICY_ID` or `ACCESS_POLICY_NAME` | optional; pins which policy is reconciled |

### The panel and the API ship together

A save changes shape on both sides at once, so the two cannot be released apart:

- the new panel calls `POST /api/commit`, which an older Worker does not have
- the new Worker insists on an explicit `sha` for `/api/write`, which an older panel does not send

Either way, saves fail until the other side lands. Deploy the Worker and push the panel back to back, and expect saving to be unavailable in the gap. Publishing is not something the site depends on to keep serving, so the gap costs nothing but the delay.

The editor registry is a further reason to migrate first. `access_sync` arrives in `0002`, and until it exists the panel's editor view reports the registry as unavailable — it does not invent an answer.

## If something goes wrong

- **Roll back the bundle:** `npx wrangler rollback`.
- **Stop all writes at once:** `npx wrangler secret delete GITHUB_TOKEN`. Every write answers `503` and the site keeps serving from GitHub.
- **A write the panel cannot make:** the Worker explains why in the response body, and the panel shows that sentence.

## Tests

Two Node harnesses, both offline — they replace `fetch` with a fake GitHub, a fake Cloudflare API, and a fake Access key set. Nothing touches Cloudflare, GitHub, or the live site.

| Harness | Checks | Proves |
| --- | --- | --- |
| `worker.test.mjs` | 61 | token verification, CORS, path policy, the fail-closed registry, the one-commit save and its compare-and-swap, editor rules, what Access is being told, deletion auditing |
| `access.test.mjs` | 15 | reconciliation: skipped, dry run, add, remove, the empty-list refusal, a pinned policy, and that a failure is reported rather than thrown |

```bash
node --test worker/          # this directory
node --test admin/ tools/ worker/   # everything, from the repository root
```

## Parked: password authentication

`attic/0002_auth.sql` is a password-auth migration that was written before the registry design settled. It was moved out of `migrations/` because `wrangler d1 migrations apply` applies every file in that directory, and applying it would have added tables nothing reads. `attic/README.md` records why. Remove it when the design is no longer in doubt.
