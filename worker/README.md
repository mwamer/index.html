# The website API

The news panel writes to `mwamer/index.html` through this Worker, and nowhere else.

The Worker holds two things as secrets: the GitHub token, and the list of addresses allowed to publish. The browser never sees either, stores either, or sends either. Cloudflare Access decides who may call the Worker, and the Worker verifies the Access token itself, so a request that skips Access still fails.

## What the panel may touch

| Path | Rule |
| --- | --- |
| `news-engagement.html` | this one file |
| `engagement-<name>.html` | lowercase letters, numbers and dashes only |
| `images/<name>-YYYYMMDD.jpeg` | `.jpeg`, `.jpg` or `.png`, date required, and the bytes must be a real image |

Everything else — `index.html`, `about.html`, `config.json`, `.git` — is refused with `400`.

## The order that cannot go wrong

Each step is safe on its own, and no step leaves the API open to the world.

1. **Enable Access, if it is not on yet.** Zero Trust needs turning on once per account, and it asks you to pick a team name. That name becomes the team domain, `<team>.cloudflareaccess.com`, and it cannot be changed later. If the Zero Trust dashboard offers to create the Access application first, it will ask for the team name at that point.
2. **Create the Access application.** Zero Trust → Access → Applications → Add an application → Self-hosted. Domain `api.wesamamer.com`. Policy: Allow, rule *Emails* = the address that may edit. Sign-in method: One-time PIN. Session duration: 24 hours.
3. **Copy two values** from that application: the team domain, and the Application Audience (AUD) tag shown on the application's overview page.
4. **Put both into `wrangler.toml`**, exactly as the dashboard shows them. That is where the Worker reads them: the team domain is quoted without a scheme, and an Access JWT always carries one, so the Worker's `iss` comparison adds it.
5. **Deploy.** `npx wrangler deploy` publishes the auth-checking bundle, removes the public `workers.dev` address, and attaches `api.wesamamer.com` with its DNS record. Do this only after the domain is verified in the dashboard.
6. **Set two secrets.** `npx wrangler secret put ALLOWED_EMAILS` for the address the policy allows to publish, comma-separated for more than one. Then `npx wrangler secret put GITHUB_TOKEN` with a fine-grained personal access token carrying `Contents: Read and write` on `mwamer/index.html` and nothing else.

Deploying before the secrets are in place is safe: the Worker fails closed. Setting `ALLOWED_EMAILS` aside, the pieces are independent — except that `GITHUB_TOKEN` before step 5 changes nothing, because the live bundle does not read it yet.

Add no policy that allows *Everyone*, and no bypass policy. Either would undo the gate, because the Worker trusts the Access token it receives.

## Checking it works

The whole hostname sits behind Cloudflare Access, so a request without a session never reaches the Worker: Access itself answers with a redirect to the sign-in page. That redirect is the check that Access is in front. `/api/health` is served by the Worker, so it too needs a session.

```bash
# No session: 302 to fancy-feather-d3cc.cloudflareaccess.com. This is expected.
curl -sI https://api.wesamamer.com/api/health | head -3

# With a session: sign in at https://api.wesamamer.com/api/signed-in first, then
# use a browser, or repeat the request with the browser's Cf-Access-Jwt-Assertion cookie.
curl -s -H 'Origin: https://wesamamer.com' https://api.wesamamer.com/api/verify
```

Signed in, `/api/health` reports `tokenConfigured` and `accessConfigured`. If the panel reports `503`, one of the three is missing: the team domain, the AUD tag, or the `ALLOWED_EMAILS` secret.

## If something goes wrong

- **Roll back the bundle:** `npx wrangler rollback`.
- **Stop all writes at once:** `npx wrangler secret delete GITHUB_TOKEN`. Every write then answers `503`, and the site keeps serving from GitHub.
- **Remove the public address:** the `routes` entry in `wrangler.toml` owns the custom domain. Deleting it and deploying detaches `api.wesamamer.com`; the Workers dashboard also allows this by hand.
- **A write the panel cannot make:** the Worker explains why in the response body. The panel shows that sentence.

## Tests

Four Node harnesses cover this Worker. None of them touch Cloudflare, GitHub, or the live site: they replace `fetch` with a fake GitHub and a fake Access key set.

| Harness | What it proves |
| --- | --- |
| `config-test.mjs` | the two Access values in `wrangler.toml` are the ones the Worker accepts — issuer, audience, email, and the scheme it adds to a team domain |
| `worker-test.mjs` | 80 checks: token verification, CORS, path policy, content limits, write confirmation |
| `round-trip.mjs` | every page rebuilds to itself byte for byte, and a date edit changes only that entry |
| `harness/server.mjs` | the panel in a browser, against this Worker and an in-memory GitHub |

They live outside the repository today, in the working scratch directory. Move them under `worker/tests/` to keep them with the code.
