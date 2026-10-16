import { listEditors, getEditor, addEditor, updateEditor, removeEditor, ensureOwnerSeed, audit, desiredAccessEmails, lastAccessSync } from "./registry.js";
import { accessApiConfigured, reconcileAfterChange, accessDiagnosis } from "./access.js";
import { publicationReport } from "./publication.js";
/* The News & Engagement panel's API.

   The panel runs in a browser, so it must never hold a GitHub token. Every read
   and every write comes through this Worker, the only holder of that token, as
   the secret GITHUB_TOKEN. It can touch three kinds of file in mwamer/index.html
   and nothing else: the news page, the engagement record pages, and the images
   they use.

   Access is the authentication. Cloudflare Access stands in front of this Worker
   and only lets your email draw a one-time code, but being behind Access is not
   treated as proof by itself: every request carries an Access JWT, and this file
   checks its signature against the team's signing keys and checks its issuer,
   audience, expiry and email. A request that fails any of those is refused before
   any repository call is made. Nothing is served at all until ACCESS_TEAM_DOMAIN,
   ACCESS_AUD and ALLOWED_EMAILS are set, so a half-configured deployment fails
   closed rather than open. */

const GITHUB_API = 'https://api.github.com';
const NEWS_PATH = 'news-engagement.html';
/* What the panel has published, and which articles it has deleted. Written by
   the panel on every save and read by tools/content-guard.mjs, which refuses a
   push that would take the published site backwards. */
const PANEL_STATE_PATH = '.panel-state.json';
const MAX_BODY = 8 * 1024 * 1024;
/** One save can hold a news page, a state file, a record page and a handful of
    photographs. The cap is here so a runaway caller cannot ask for a thousand
    blobs in one request. */
const MAX_CHANGES = 60;
const JWT_LEEWAY = 60;
const JWKS_TTL = 600;
const GITHUB_API_VERSION = '2022-11-28';

class HttpError extends Error {
    constructor(message, status = 500) {
        super(message);
        this.status = status;
    }
}

// A caller mistake carries a status of its own; anything else is the registry
// being unreachable, which must not be reported as the caller's fault.
async function registryCall(fn) {
    try {
        return await fn();
    } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error && error.status) throw new HttpError(error.message, error.status);
        throw new HttpError(error && error.message ? error.message : 'The request failed', 400);
    }
}

// ── configuration ────────────────────────────────────────────────────────────

const list = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);

const repo = (env) => ({
    owner: env.REPO_OWNER || 'mwamer',
    name: env.REPO_NAME || 'index.html',
    branch: env.REPO_BRANCH || 'main',
});

// Cloudflare shows a team domain without a scheme, and an Access JWT always
// carries one in `iss`, so either form is accepted here and read as a URL.
const teamDomain = (env) => {
    const shown = String(env.ACCESS_TEAM_DOMAIN || '').trim().replace(/\/+$/, '');
    if (!shown) return '';
    return /^https?:\/\//i.test(shown) ? shown : `https://${shown}`;
};

// ── CORS ─────────────────────────────────────────────────────────────────────
//
// CORS is not authentication: it only stops another site's JavaScript from
// reading an answer. It is still worth being exact about, and the Origin header
// is enforced below as a cross-site request forgery defence, not as a login.

function corsHeaders(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = { Vary: 'Origin' };
    if (origin && list(env.ALLOWED_ORIGINS).includes(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Credentials'] = 'true';
        headers['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Content-Type, Cf-Access-Jwt-Assertion';
        headers['Access-Control-Max-Age'] = '86400';
    }
    return headers;
}

function jsonResponse(data, status, headers) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
    });
}

const fail = (message, status, headers) => jsonResponse({ error: message }, status, headers);

/** An Origin is the caller's own browser statement of what page it is on, and a
    browser will not let a page forge it. Requiring it is what stops another site
    from making the signed-in browser save something. */
function assertCallerIsAllowed(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (origin) {
        if (!list(env.ALLOWED_ORIGINS).includes(origin)) {
            throw new HttpError('This API only accepts requests from https://wesamamer.com', 403);
        }
        return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError('This API only accepts requests from https://wesamamer.com', 403);
    }
}

// ── base64 and text ──────────────────────────────────────────────────────────

function base64ToBytes(value) {
    const binary = atob(String(value).replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function bytesToBase64(bytes) {
    let binary = '';
    const block = 0x8000;
    for (let i = 0; i < bytes.length; i += block) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + block));
    }
    return btoa(binary);
}

const textToBase64 = (text) => bytesToBase64(new TextEncoder().encode(text));

// GitHub hands back base64 over bytes, not text. Decoding with atob alone turns
// every accent and dash into mojibake, and a restore would then commit that.
const base64ToText = (value) => new TextDecoder().decode(base64ToBytes(value));

function base64UrlToBytes(value) {
    const padded = String(value).replace(/-/g, '+').replace(/_/g, '/');
    return base64ToBytes(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

// ── Cloudflare Access ────────────────────────────────────────────────────────

let keyCache = { domain: '', at: 0, keys: [] };

async function accessKeys(env, { refresh = false } = {}) {
    const domain = teamDomain(env);
    if (!refresh && keyCache.domain === domain && Date.now() - keyCache.at < JWKS_TTL * 1000) {
        return keyCache.keys;
    }
    const response = await fetch(`${domain}/cdn-cgi/access/certs`);
    if (!response.ok) throw new HttpError('Cloudflare Access signing keys could not be read', 502);
    const body = await response.json();
    keyCache = { domain, at: Date.now(), keys: body.keys || [] };
    return keyCache.keys;
}

async function verifySignature(env, header, signed, signature) {
    const keys = await accessKeys(env);
    let jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) jwk = (await accessKeys(env, { refresh: true })).find((key) => key.kid === header.kid);
    if (!jwk) throw new HttpError('Not signed in', 401);
    const key = await crypto.subtle.importKey('jwk', jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
        base64UrlToBytes(signature), new TextEncoder().encode(signed));
    if (!ok) throw new HttpError('Not signed in', 401);
}

/** Who is calling, proven rather than assumed: the Access token is checked here
    rather than trusted because a gate stood in front of the Worker. Returns the
    email Access authenticated, or throws. This is authentication only; what the
    caller may do is decided by verifyAccess, which reads the registry. */
async function verifySession(request, env) {
    const domain = teamDomain(env);
    const audience = String(env.ACCESS_AUD || '');
    if (!domain || !audience) {
        throw new HttpError('Cloudflare Access is not configured on this Worker yet', 503);
    }

    const header = request.headers.get('Cf-Access-Jwt-Assertion') || '';
    if (!header) throw new HttpError('Not signed in', 401);
    const parts = header.split('.');
    if (parts.length !== 3) throw new HttpError('Not signed in', 401);

    let claims;
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])));
        claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
    } catch {
        throw new HttpError('Not signed in', 401);
    }
    if (parsed.alg !== 'RS256' || !parsed.kid) throw new HttpError('Not signed in', 401);
    await verifySignature(env, parsed, `${parts[0]}.${parts[1]}`, parts[2]);

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + JWT_LEEWAY < now) {
        throw new HttpError('Your session has ended', 401);
    }
    if (typeof claims.nbf === 'number' && claims.nbf - JWT_LEEWAY > now) {
        throw new HttpError('Not signed in', 401);
    }
    if (claims.iss !== domain) throw new HttpError('Not signed in', 401);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) throw new HttpError('Not signed in', 401);

    const email = String(claims.email || '').toLowerCase();
    if (!email) throw new HttpError('Not signed in', 401);
    return { email, claims };
}

/** Who is calling, and what the editor registry says they may do.

    D1 is the authority, so this resolves the record from it and refuses when
    there is none. A record that is pending or suspended is returned rather than
    refused, so the panel can say which it is; requireActive and requireOwner
    decide what may then be done with it.

    A registry that cannot be read is a refusal, never a fallback. Treating an
    outage as "not in the registry" would either lock everyone out or, worse,
    let the allowlist stand in for a suspended record. */
async function verifyAccess(request, env) {
    const { email, claims } = await verifySession(request, env);
    const allowedEmails = list(env.ALLOWED_EMAILS).map((value) => value.toLowerCase());
    let editor;
    try {
        editor = await getEditor(env, email);
        // The first owner. ALLOWED_EMAILS is read here and nowhere else: it seeds
        // the registry, it does not replace it.
        if (!editor && allowedEmails.includes(email)) {
            editor = await ensureOwnerSeed(env, { email, name: claims.name || email });
        }
    } catch (error) {
        if (error && error.status) throw new HttpError(error.message, error.status);
        throw new HttpError('The editor registry could not be read, so nothing can be published right now. '
            + 'Check that the D1 migrations have been applied.', 503);
    }
    if (!editor) {
        throw new HttpError(`Signed in as ${email}, but this address is not an editor of this website`, 403);
    }
    return { email, claims, editor };
}

/** Publishing needs a record that says active. A pending or suspended record is
    refused here, with a message that says which, so the panel can explain it. */
function requireActive(caller) {
    if (!caller || !caller.editor) throw new HttpError('Sign in before saving', 401);
    if (caller.editor.status === 'pending') {
        throw new HttpError('Your editor account is waiting to be approved by the owner, so nothing can be published yet', 403);
    }
    if (caller.editor.status !== 'active') {
        throw new HttpError('Your editor account is suspended, so nothing can be published', 403);
    }
    return caller.editor;
}

/** Managing editors is the owner's alone. */
function requireOwner(caller) {
    if (!caller || !caller.editor) throw new HttpError('Sign in before managing editors', 401);
    if (caller.editor.role !== 'owner' || caller.editor.status !== 'active') {
        throw new HttpError('Only the owner can manage editors', 403);
    }
    return caller.editor;
}


// ── GitHub ───────────────────────────────────────────────────────────────────

function githubMessage(status, body) {
    const said = body && body.message ? body.message : `GitHub replied ${status}`;
    if (status === 401) return `GitHub refused the Worker's token: ${said}`;
    if (status === 403) return `GitHub refused the request: ${said}`;
    if (status === 409 || status === 422) return `GitHub refused the write: ${said}`;
    return said;
}

function githubStatus(status) {
    if (status === 404) return 404;
    if (status === 409 || status === 422) return 409;
    return 502;
}

async function gh(env, path, init = {}) {
    const token = env.GITHUB_TOKEN;
    if (!token) throw new HttpError('The GitHub token has not been set on this Worker yet', 503);
    const { owner, name } = repo(env);
    const response = await fetch(`${GITHUB_API}/repos/${owner}/${name}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
            'User-Agent': 'wesam-personal-website-api',
            ...(init.headers || {}),
        },
    });
    const raw = await response.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!response.ok) throw new HttpError(githubMessage(response.status, body), githubStatus(response.status));
    return body;
}

const contentsPath = (env, path) => `/contents/${path.split('/').map(encodeURIComponent).join('/')}`;

// Reading a ref and moving one are different endpoints: GitHub spells the read
// `/git/ref/{ref}` and the write `/git/refs/{ref}`.
const refPath = (env) => `/git/ref/heads/${branchPath(env)}`;
const refsPath = (env) => `/git/refs/heads/${branchPath(env)}`;
const branchPath = (env) => repo(env).branch.split('/').map(encodeURIComponent).join('/');

/** The commit the branch is on now. This is the value a save must name as the
    revision it started from, which is what makes a stale save detectable. */
async function headSha(env) {
    const body = await gh(env, refPath(env));
    return (body.object && body.object.sha) || '';
}

/** Write everything a save changed as one commit, or nothing at all.

    This is what the panel uses, and it replaces a sequence of one-file commits.
    It is better in two ways that matter:

    - The site is never seen half-changed. A save that updates the news page,
      the state file and a record page lands as a single revision, so no reader,
      and no checker, can catch the site between two of those steps.
    - A stale save cannot overwrite anyone. `base` is the revision the panel was
      reading from. If main has moved since — because a colleague saved, or
      another tab did — the commit is refused before anything is written, and
      the panel keeps the draft and says so.

    GitHub's own ref update is the last word: `force: false` refuses anything
    that is not a fast-forward, so a commit that lands between the check above
    and the write below is caught too. */
async function commitFiles(env, { base, message, changes }) {
    const head = await headSha(env);
    if (!head) throw new HttpError('GitHub did not say which revision the site is on, so nothing was written', 502);
    if (!base) throw new HttpError('A save must say which revision it started from', 400);
    if (base !== head) {
        throw new HttpError('Someone else published while this panel was open, so this save was not written. '
            + 'Your work is still here: copy it if you need to, reload to see their version, then apply yours again.', 409);
    }

    const baseCommit = await gh(env, `/git/commits/${head}`);
    const baseTree = baseCommit.tree && baseCommit.tree.sha;
    if (!baseTree) throw new HttpError('GitHub did not say what the site contained, so nothing was written', 502);

    const tree = [];
    const written = [];
    const removed = [];
    for (const change of changes) {
        const path = change && change.path;
        assertPath(path);
        if (change.delete) {
            // A null sha on an entry of the base tree is how the Git Data API
            // expresses "this file is no longer in the tree".
            tree.push({ path, mode: '100644', type: 'blob', sha: null });
            removed.push(path);
            continue;
        }
        const content = contentBase64(change, path);
        const blob = await gh(env, '/git/blobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, encoding: 'base64' }),
        });
        if (!blob.sha) throw new HttpError(`GitHub did not accept the new contents of ${path}`, 502);
        tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
        written.push({ path, sha: blob.sha });
    }

    const created = await gh(env, '/git/trees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_tree: baseTree, tree }),
    });
    if (!created.sha) throw new HttpError('GitHub did not accept the new file list, so nothing was written', 502);

    const commit = await gh(env, '/git/commits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: String(message || 'Update the site from the panel').slice(0, 200),
            tree: created.sha,
            parents: [head],
        }),
    });
    if (!commit.sha) throw new HttpError('GitHub did not confirm the commit, so nothing is being reported as saved', 502);

    await gh(env, refsPath(env), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: commit.sha, force: false }),
    });

    return { commit: commit.sha, head: commit.sha, files: written, deleted: removed };
}

// ── what this Worker is allowed to touch ─────────────────────────────────────

function isAllowedPath(path) {
    if (typeof path !== 'string' || !path.length || path.length > 200) return false;
    if (path.startsWith('/') || path.includes('..') || path.includes('\\')) return false;
    if (/[\u0000-\u001f\u007f]/.test(path)) return false;
    if (path === NEWS_PATH) return true;
    if (path === PANEL_STATE_PATH) return true;
    if (/^engagement-[a-z0-9][a-z0-9-]{0,80}\.html$/.test(path)) return true;
    if (/^images\/[A-Za-z0-9][A-Za-z0-9-]{0,80}-\d{8}\.(jpe?g|png|webp|avif)$/.test(path)) return true;
    return false;
}

const assertPath = (path) => {
    if (!isAllowedPath(path)) throw new HttpError(`This Worker does not write ${JSON.stringify(path)}`, 400);
};

/** The first bytes of a file, as a check that an image really is one. Sixty-four
    base64 characters is forty-eight bytes, enough to read the brands inside an
    AVIF "ftyp" box, which is where that format says what it is. */
function fileHead(base64) {
    const chunk = base64.replace(/\s/g, '').slice(0, 64);
    if (chunk.length < 8) return new Uint8Array();
    try { return base64ToBytes(chunk); } catch { return new Uint8Array(); }
}

const isJpeg = (b) => b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b) => b.length > 3 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isWebp = (b) => b.length > 11 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP';
/** AVIF is ISO base media: an "ftyp" box, then the brands it belongs to. Only a
    real AVIF lists "avif" or "avis" among them. */
const isAvif = (b) => {
    if (b.length < 12) return false;
    if (String.fromCharCode(...b.subarray(4, 8)) !== 'ftyp') return false;
    const brands = String.fromCharCode(...b.subarray(8, Math.min(b.length, 40)));
    return brands.includes('avif') || brands.includes('avis');
};

/** The file's bytes, from whichever shape the caller sent. Refuses an empty
    file: a save that quietly committed a zero-byte photograph would look like a
    success and put a broken image on the site. */
function contentBase64(payload, path) {
    let content = '';
    if (typeof payload.contentBase64 === 'string') {
        content = payload.contentBase64.replace(/\s/g, '');
    } else if (typeof payload.text === 'string') {
        if (!payload.text.trim()) throw new HttpError('Refusing to write an empty file', 400);
        return textToBase64(payload.text);
    } else if (Array.isArray(payload.bytes)) {
        if (!payload.bytes.length) throw new HttpError('The file is empty', 400);
        return bytesToBase64(Uint8Array.from(payload.bytes));
    } else if (payload.bytes) {
        // A Uint8Array serialised into JSON arrives as {"0":…}, which would have
        // been written as a zero-byte file. Say so instead of writing rubbish.
        throw new HttpError('Send an image as contentBase64, not as a serialised byte array', 400);
    } else {
        throw new HttpError('No content was sent with this write', 400);
    }

    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4) {
        throw new HttpError('The file content is not valid base64', 400);
    }
    if (!content.length) throw new HttpError('The file is empty', 400);
    if (path.startsWith('images/')) {
        const head = fileHead(content);
        if (!isJpeg(head) && !isPng(head) && !isWebp(head) && !isAvif(head)) {
            throw new HttpError('That did not look like a JPEG, PNG, WebP or AVIF file', 400);
        }
    }
    return content;
}

async function readJson(request) {
    const raw = await request.text();
    if (raw.length > MAX_BODY) throw new HttpError('The upload is too large', 413);
    try {
        return JSON.parse(raw);
    } catch {
        throw new HttpError('The request body was not valid JSON', 400);
    }
}

// ── the API ──────────────────────────────────────────────────────────────────

function signedInPage(email) {
    const safe = String(email).replace(/[&<>"]/g, (character) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow">
<title>Signed in</title></head>
<body style="font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.25rem;color:#24384A">
<h1 style="font-size:1.3rem">You are signed in</h1>
<p>Cloudflare signed you in as <strong>${safe}</strong>. You can close this tab and go back to the
<a href="https://wesamamer.com/admin/">news panel</a>.</p>
<p>The panel will accept saves for the next 24 hours, or until you sign out.</p>
</body></html>`;
}

async function handle(request, env, headers) {
    const url = new URL(request.url);
    const route = url.pathname;
    const method = request.method;

    if (route === '/api/health') {
        return jsonResponse({
            ok: true,
            service: 'wesam-personal-website-api',
            repo: `${repo(env).owner}/${repo(env).name}`,
            accessConfigured: Boolean(teamDomain(env) && env.ACCESS_AUD && list(env.ALLOWED_EMAILS).length),
            tokenConfigured: Boolean(env.GITHUB_TOKEN),
        }, 200, headers);
    }

    assertCallerIsAllowed(request, env);

    // The sign-in page and the root need a proven session, not an editor record:
    // someone who has just signed in should be able to see that they did, and be
    // told what is missing, whether their access is pending or not granted.
    if (route === '/api/signed-in' || route === '/' || route === '') {
        const { email } = await verifySession(request, env);
        return new Response(signedInPage(email), {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
        });
    }

    const caller = await verifyAccess(request, env);
    const { email } = caller;

    if (route === '/api/verify') {
        const { owner, name } = repo(env);
        const body = await gh(env, '');
        return jsonResponse({
            email,
            login: (body.owner && body.owner.login) || owner,
            repo: `${owner}/${name}`,
            canWrite: Boolean(body.permissions && body.permissions.push),
            // The registry's record, so the panel can say "waiting for
            // approval" or "suspended" rather than a bare refusal.
            editor: caller.editor,
            // The revision this panel would save on top of. A save that names it
            // is refused when the site has moved on, instead of overwriting.
            head: await headSha(env),
        }, 200, headers);
    }
    // Editor management endpoints
    if (route.startsWith('/api/admin/editors')) {
        requireOwner(caller);
        if (route === '/api/admin/editors' && method === 'GET') {
            const editors = await registryCall(() => listEditors(env));
            return jsonResponse({ editors }, 200, headers);
        }
        if (route === '/api/admin/editors' && method === 'POST') {
            const payload = await readJson(request);
            const created = await registryCall(() => addEditor(env, { email: payload.email, name: payload.name, role: payload.role || 'news-editor', status: payload.status || 'pending', actor: email }));
            await reconcileAfterChange(env, { actor: email });
            return jsonResponse({ editor: created }, 201, headers);
        }
        if (route.startsWith('/api/admin/editors/') && method === 'PATCH') {
            const id = decodeURIComponent(route.split('/').pop());
            const payload = await readJson(request);
            const updated = await registryCall(() => updateEditor(env, { email: id, name: payload.name, role: payload.role, status: payload.status, actor: email }));
            await reconcileAfterChange(env, { actor: email });
            return jsonResponse({ editor: updated }, 200, headers);
        }
        if (route.startsWith('/api/admin/editors/') && method === 'DELETE') {
            const id = decodeURIComponent(route.split('/').pop());
            await registryCall(() => removeEditor(env, { email: id, actor: email }));
            await reconcileAfterChange(env, { actor: email });
            return jsonResponse({ success: true }, 200, headers);
        }
        throw new HttpError(`${method} is not a way to change editors`, 405);
    }

    // What Cloudflare Access is being told, and asking it to be told again.
    if (route === '/api/admin/access') {
        requireOwner(caller);
        if (method === 'GET') {
            // `?diagnose=1` reads the live policy and reports the comparison.
            // The plain form stays as it was, so the panel's existing view keeps
            // working without a second round trip.
            if (url.searchParams.get('diagnose')) {
                // An unavailable diagnosis is still an answer: it says the read
                // failed, or was never configured. Not a 5xx.
                return jsonResponse(await accessDiagnosis(env), 200, headers);
            }
            const [desired, last] = await registryCall(() => Promise.all([desiredAccessEmails(env), lastAccessSync(env)]));
            return jsonResponse({ desired, last, configured: accessApiConfigured(env) }, 200, headers);
        }
        if (method === 'POST') {
            // The same path an editor change takes, so a manual retry is recorded
            // too — otherwise the panel would still show the old attempt and the
            // owner could not tell whether pressing the button did anything.
            const result = await reconcileAfterChange(env, { actor: email });
            return jsonResponse(result, result.state === 'failed' ? 502 : 200, headers);
        }
        throw new HttpError(`${method} is not a way to work with Access`, 405);
    }


    if (route === '/api/read') {
        const path = url.searchParams.get('path');
        assertPath(path);
        const body = await gh(env, `${contentsPath(env, path)}?ref=${encodeURIComponent(repo(env).branch)}`);
        if (url.searchParams.get('meta') === '1') {
            return jsonResponse({ sha: body.sha, size: body.size }, 200, headers);
        }
        const text = typeof body.content === 'string' && body.encoding === 'base64'
            ? base64ToText(body.content)
            : '';
        return jsonResponse({ sha: body.sha, size: body.size, text }, 200, headers);
    }

    if (route === '/api/read-at') {
        const path = url.searchParams.get('path');
        const ref = url.searchParams.get('ref') || '';
        assertPath(path);
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(ref)) throw new HttpError('That revision is not valid', 400);
        const body = await gh(env, `${contentsPath(env, path)}?ref=${encodeURIComponent(ref)}`);
        const text = typeof body.content === 'string' && body.encoding === 'base64'
            ? base64ToText(body.content)
            : '';
        return jsonResponse({ sha: body.sha, text }, 200, headers);
    }

    if (route === '/api/history') {
        const path = url.searchParams.get('path');
        assertPath(path);
        const asked = Number.parseInt(url.searchParams.get('count') || '3', 10);
        const count = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 10) : 3;
        const body = await gh(env, `/commits?path=${encodeURIComponent(path)}`
            + `&sha=${encodeURIComponent(repo(env).branch)}&per_page=${count}`);
        const history = (Array.isArray(body) ? body : []).map((item) => ({
            sha: item.sha,
            message: (item.commit && item.commit.message) ? item.commit.message.split('\n')[0] : '',
            date: (item.commit && item.commit.author) ? item.commit.author.date : '',
        }));
        return jsonResponse({ history }, 200, headers);
    }

    if (route === '/api/write' && method === 'POST') {
        requireActive(caller);
        const payload = await readJson(request);
        const path = payload.path;
        assertPath(path);
        const content = contentBase64(payload, path);
        // Only the revision the caller read. Filling the sha in from the current
        // file would write over whatever is there now, which is exactly the
        // silent overwrite that a second editor must never suffer. An update
        // must therefore say which revision it is updating; a create passes none.
        const sha = payload.sha;
        const body = await gh(env, contentsPath(env, path), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: String(payload.message || `Update ${path}`).slice(0, 200),
                content,
                branch: repo(env).branch,
                ...(sha ? { sha } : {}),
            }),
        });
        if (!body.commit || !body.commit.sha) {
            throw new HttpError('GitHub did not confirm the write, so nothing is being reported as saved', 502);
        }
        return jsonResponse({
            path,
            sha: body.content && body.content.sha,
            commit: body.commit.sha,
        }, 200, headers);
    }

    if (route === '/api/remove' && method === 'POST') {
        requireActive(caller);
        const payload = await readJson(request);
        const path = payload.path;
        assertPath(path);
        // A deletion names the revision it deletes. Looking the sha up here would
        // delete whatever the file holds now, including a colleague's edit.
        const sha = payload.sha;
        if (!sha) throw new HttpError('A deletion must say which revision it is removing', 400);
        // Who deleted what, and when. This is the record of a permanent change,
        // so it is written on failure as well as on success.
        const record = (detail) => audit(env, {
            actor: email,
            action: 'content.delete',
            target: path,
            detail: JSON.stringify(detail),
        });
        let body;
        try {
            body = await gh(env, contentsPath(env, path), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: String(payload.message || `Remove ${path}`).slice(0, 200),
                    sha,
                    branch: repo(env).branch,
                }),
            });
            if (!body.commit || !body.commit.sha) {
                throw new HttpError('GitHub did not confirm the deletion', 502);
            }
        } catch (error) {
            await record({ outcome: 'failed', reason: String((error && error.message) || error) });
            throw error;
        }
        await record({ outcome: 'removed', commit: body.commit.sha });
        return jsonResponse({ path, commit: body.commit.sha }, 200, headers);
    }

    if (route === '/api/head') {
        return jsonResponse({ head: await headSha(env), branch: repo(env).branch }, 200, headers);
    }

    /* A whole save in one commit. The panel sends every file it changed, the
       revision it started from, and nothing else; either all of it lands or none
       of it does. Deletions travel the same way, as an entry with `delete: true`,
       which is what keeps a record page and the link to it in one revision. */
    if (route === '/api/commit' && method === 'POST') {
        requireActive(caller);
        const payload = await readJson(request);
        const changes = Array.isArray(payload.changes) ? payload.changes : [];
        if (!changes.length) throw new HttpError('Nothing was sent to save', 400);
        if (changes.length > MAX_CHANGES) {
            throw new HttpError(`A save can hold at most ${MAX_CHANGES} files, and this one holds ${changes.length}`, 400);
        }
        const seen = new Set();
        for (const change of changes) {
            const path = change && change.path;
            if (seen.has(path)) throw new HttpError(`${JSON.stringify(path)} was sent twice in one save`, 400);
            seen.add(path);
        }
        const result = await commitFiles(env, { base: payload.base, message: payload.message, changes });
        // One line per deleted file, so the audit answers "who removed the
        // photograph" as precisely as it did when deletions were one at a time.
        for (const path of result.deleted) {
            await audit(env, {
                actor: email,
                action: 'content.delete',
                target: path,
                detail: JSON.stringify({ outcome: 'removed', commit: result.commit, via: 'commit' }),
            });
        }
        return jsonResponse(result, 200, headers);
    }

    // Whether the commit the panel just made has actually reached the website.
    // Read-only, so any signed-in editor may ask; purging asks a cache to drop
    // URLs, so that needs the right to publish at all.
    if (route === '/api/publication' && method === 'POST') {
        const payload = await readJson(request);
        if (payload.purge) requireActive(caller);
        const report = await publicationReport(env, gh, { sha: payload.sha, purge: Boolean(payload.purge) });
        return jsonResponse(report, 200, headers);
    }

    // Cloudflare asks the origin about these two prefixes itself, so they are
    // answered without a body. Everything else that is not a route above is a
    // mistake, and saying so is better than answering 200 to a typo.
    if (route.startsWith('/cdn-cgi/') || route.startsWith('/.well-known/')) {
        return new Response('', { status: 200, headers: { 'Cache-Control': 'no-store', ...headers } });
    }
    return jsonResponse({ error: `There is no ${route} on this API` }, 404, headers);
}

export default {
    async fetch(request, env) {
        const headers = corsHeaders(request, env);
        const url = new URL(request.url);
        const route = url.pathname;
        try {
            if (route.startsWith('/cdn-cgi/') || route.startsWith('/.well-known/')) {
                return new Response('', { status: 200, headers: { 'Cache-Control': 'no-store', ...headers } });
            }
            if (request.method === 'OPTIONS') {
                const origin = request.headers.get('Origin') || '';
                return list(env.ALLOWED_ORIGINS).includes(origin)
                    ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', ...headers } })
                    : fail('This API only accepts requests from https://wesamamer.com', 403, headers);
            }
            return await handle(request, env, headers);
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 500;
            return fail(error && error.message ? error.message : 'The API failed', status, headers);
        }
    },
};
