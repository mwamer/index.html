#!/usr/bin/env node
/* Tests for the Worker: the API the admin panel talks to.

   The real Worker is imported and called with a real Cloudflare Access JWT,
   signed here with a key the test generates. GitHub and D1 are stubbed, so the
   tests exercise this Worker's own logic — signature checking, the editor
   records, which paths it will write, what it records for a deletion, and the
   one-commit write that replaced one file at a time — without touching the live
   repository or the live database.

   Run:  node --test worker/
*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';

import worker from './worker.js';

const TEAM_DOMAIN = 'https://team.cloudflareaccess.com';
const ORIGIN = 'https://wesamamer.com';
const OWNER = 'wesaam.amer@gmail.com';
const EDITOR = 'family.amer6@gmail.com';
const GITHUB = 'https://api.github.com';
const NEWS = 'news-engagement.html';
const STATE = '.panel-state.json';
const RECORD = 'engagement-example-entry.html';

// ── the signing key the fake Access issuer uses ──────────────────────────────

const KEY_ID = 'test-key-1';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: KEY_ID, alg: 'RS256', use: 'sig' };

const base64url = (input) => Buffer.from(input).toString('base64url');

/** A JWT that this Worker will accept, unless a test says otherwise. */
function token({ email = OWNER, name = 'Wesam Amer', issuer = TEAM_DOMAIN, audience = 'test-aud', expiresIn = 3600, kid = KEY_ID } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const payload = base64url(JSON.stringify({
        iss: issuer,
        aud: audience,
        email,
        name,
        iat: now,
        exp: now + expiresIn,
    }));
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey).toString('base64url');
    return `${header}.${payload}.${signature}`;
}

// ── a D1 stand-in ────────────────────────────────────────────────────────────
//
// Only the statements the registry actually issues, which keeps it honest: a
// query this stub does not know is a failure, not a silent pass.

function stubDB(seed = [], { broken = false } = {}) {
    if (broken) {
        // A database that answers every statement with a failure, which is how
        // the fail-closed rules are tested.
        const boom = async () => { throw new Error('D1_ERROR: the database is not answering'); };
        return { prepare: () => ({ all: boom, first: boom, run: boom, bind: () => ({ all: boom, first: boom, run: boom }) }) };
    }
    const editors = seed.map((row) => ({
        email: row.email,
        name: row.name || row.email,
        role: row.role || 'news-editor',
        status: row.status || 'active',
        added_at: '2026-01-01T00:00:00.000Z',
        added_by: row.email,
        modified_at: '2026-01-01T00:00:00.000Z',
        modified_by: row.email,
    }));
    const auditRows = [];
    const syncRows = [];
    const handle = (sql, args) => ({
        all: async () => {
            if (/FROM editors ORDER BY email/.test(sql)) {
                return { results: [...editors].sort((a, b) => (a.email < b.email ? -1 : 1)) };
            }
            if (/SELECT email FROM editors WHERE status = 'active'/.test(sql)) {
                return { results: editors.filter((row) => row.status === 'active').map((row) => ({ email: row.email })) };
            }
            throw new Error(`stubDB does not know: ${sql}`);
        },
        first: async () => {
            if (/FROM editors WHERE email = \?/.test(sql)) {
                return editors.find((row) => row.email === args[0]) || null;
            }
            if (/COUNT\(\*\) as c FROM editors/.test(sql)) {
                return { c: editors.filter((row) => row.role === 'owner' && row.status === 'active').length };
            }
            if (/FROM access_sync/.test(sql)) {
                return syncRows.length ? syncRows[syncRows.length - 1] : null;
            }
            throw new Error(`stubDB does not know: ${sql}`);
        },
        run: async () => {
            if (/^INSERT INTO editors/.test(sql)) {
                const [email, name, role, status] = args;
                editors.push({
                    email, name, role, status,
                    added_at: args[4], added_by: args[5], modified_at: args[6], modified_by: args[7],
                });
                return { success: true };
            }
            if (/^UPDATE editors/.test(sql)) {
                const row = editors.find((item) => item.email === args[5]);
                if (row) Object.assign(row, { name: args[0], role: args[1], status: args[2], modified_at: args[3], modified_by: args[4] });
                return { success: true };
            }
            if (/^DELETE FROM editors/.test(sql)) {
                const at = editors.findIndex((item) => item.email === args[0]);
                if (at >= 0) editors.splice(at, 1);
                return { success: true };
            }
            if (/^INSERT INTO audit/.test(sql)) {
                auditRows.push({ at: args[0], actor: args[1], action: args[2], target: args[3], detail: args[4] });
                return { success: true };
            }
            if (/^INSERT INTO access_sync/.test(sql)) {
                syncRows.push({ at: args[0], state: args[1], detail: args[2] });
                return { success: true };
            }
            throw new Error(`stubDB does not know: ${sql}`);
        },
    });
    return {
        prepare: (sql) => ({
            ...handle(sql, []),
            bind: (...args) => handle(sql, args),
        }),
        _editors: editors,
        _audit: auditRows,
        _sync: syncRows,
    };
}

// ── a GitHub stand-in ────────────────────────────────────────────────────────
//
// It speaks the two APIs the Worker uses: the contents API, where one call
// writes one file, and the Git Data API, where a tree is built and moved onto
// the branch in one commit. The ref update enforces the same rule GitHub does:
// without `force`, a branch only moves forward.

function stubGitHub({ files = {}, deleted = [], onDelete = null, raceOnRefUpdate = false } = {}) {
    const store = { ...files };
    const calls = [];
    const commits = [];
    const commitsBySha = new Map();
    let head = 'commit-base';
    commitsBySha.set(head, { sha: head, message: 'base', parents: [] });
    let counter = 0;
    const next = (prefix) => `${prefix}-${++counter}`;

    const json = (body, status = 200) => new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json' },
    });

    const fetch = async (url, init = {}) => {
        const path = url.replace(GITHUB, '');
        const method = (init.method || 'GET').toUpperCase();
        const body = init.body ? JSON.parse(init.body) : {};
        calls.push({ method, path, body });
        const repoPath = '/repos/mwamer/index.html';

        if (method === 'GET' && path === repoPath) {
            return json({ owner: { login: 'mwamer' }, permissions: { push: true } });
        }

        // ── Git Data API ──
        if (method === 'GET' && path === `${repoPath}/git/ref/heads/main`) {
            return json({ ref: 'refs/heads/main', object: { sha: head } });
        }
        if (method === 'GET' && path.startsWith(`${repoPath}/git/commits/`)) {
            const sha = path.slice(`${repoPath}/git/commits/`.length);
            if (!commitsBySha.has(sha)) return json({ message: 'Not Found' }, 404);
            return json({ sha, tree: { sha: `tree-of-${sha}` } });
        }
        if (method === 'POST' && path === `${repoPath}/git/blobs`) {
            return json({ sha: next('blob') });
        }
        if (method === 'POST' && path === `${repoPath}/git/trees`) {
            for (const entry of body.tree) {
                if (entry.sha === null) {
                    if (entry.path in store) {
                        delete store[entry.path];
                        deleted.push(entry.path);
                        if (onDelete) onDelete(entry.path);
                    }
                    continue;
                }
                store[entry.path] = entry.sha;
            }
            return json({ sha: next('tree') });
        }
        if (method === 'POST' && path === `${repoPath}/git/commits`) {
            const sha = next('commit');
            commits.push({ sha, message: body.message, parents: body.parents, tree: body.tree });
            commitsBySha.set(sha, { sha, message: body.message, parents: body.parents });
            return json({ sha });
        }
        if (method === 'PATCH' && path === `${repoPath}/git/refs/heads/main`) {
            if (raceOnRefUpdate) {
                // A colleague's commit lands between this Worker's read and its
                // write. GitHub refuses anything that is not a fast-forward.
                head = 'commit-from-someone-else';
                commitsBySha.set(head, { sha: head, message: 'theirs', parents: [] });
            }
            const commit = commitsBySha.get(body.sha);
            if (!commit) return json({ message: 'Not Found' }, 404);
            if (body.force !== true && commit.parents[0] !== head) {
                return json({ message: 'Update is not a fast forward' }, 422);
            }
            head = body.sha;
            return json({ object: { sha: head } });
        }

        // ── contents API ──
        const match = path.match(/^\/repos\/mwamer\/index\.html\/contents\/(.+?)(\?.*)?$/);
        if (match) {
            const file = decodeURIComponent(match[1]);
            if (method === 'GET') {
                if (!(file in store)) return json({ message: 'Not Found' }, 404);
                return json({ sha: store[file], size: 10, encoding: 'base64', content: '' });
            }
            if (method === 'PUT') {
                if (file in store && !body.sha) {
                    // What GitHub does when an update does not carry the revision
                    // it is updating.
                    return json({ message: "sha wasn't supplied" }, 422);
                }
                if (file in store && body.sha !== store[file]) {
                    return json({ message: 'sha does not match' }, 409);
                }
                const sha = next('content');
                store[file] = sha;
                return json({ content: { sha }, commit: { sha: next('commit') } });
            }
            if (method === 'DELETE') {
                if (onDelete) onDelete(file);
                if (!(file in store)) return json({ message: 'Not Found' }, 404);
                if (body.sha !== store[file]) return json({ message: 'sha does not match' }, 409);
                delete store[file];
                deleted.push(file);
                return json({ commit: { sha: `commit-for-${file}` } });
            }
        }
        throw new Error(`stubGitHub does not know: ${method} ${path}`);
    };
    return {
        fetch,
        store,
        calls,
        deleted,
        commits,
        head: () => head,
        setHead: (sha) => { head = sha; commitsBySha.set(sha, { sha, message: 'manual', parents: [] }); },
    };
}

// ── calling the Worker ───────────────────────────────────────────────────────

function buildEnv({ db = stubDB(), allowedEmails = `${OWNER},${EDITOR}` } = {}) {
    return {
        GITHUB_TOKEN: 'test-token',
        REPO_OWNER: 'mwamer',
        REPO_NAME: 'index.html',
        REPO_BRANCH: 'main',
        ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
        ACCESS_AUD: 'test-aud',
        ALLOWED_EMAILS: allowedEmails,
        ALLOWED_ORIGINS: ORIGIN,
        DB: db,
    };
}

const request = (path, { method = 'GET', jwt = token(), body, origin = ORIGIN } = {}) => new Request(
    `https://api.wesamamer.com${path}`,
    {
        method,
        headers: {
            ...(origin ? { Origin: origin } : {}),
            ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    },
);

/** Run one call with `fetch` pointed at the stubs, and always put the real
    `fetch` back so one test cannot affect the next. */
async function call(path, options = {}, { db = stubDB(), github = stubGitHub(), env: extra } = {}) {
    const env = { ...buildEnv({ db }), ...extra };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        const target = String(url);
        if (target.startsWith(`${TEAM_DOMAIN}/cdn-cgi/access/certs`)) {
            return new Response(JSON.stringify({ keys: [publicJwk] }), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }
        if (target.startsWith(GITHUB)) return github.fetch(target, init);
        throw new Error(`unexpected fetch: ${target}`);
    };
    try {
        const response = await worker.fetch(request(path, options), env);
        const text = await response.text();
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: response.status, json, text, github, db };
    } finally {
        globalThis.fetch = realFetch;
    }
}

const owner = () => stubDB([{ email: OWNER, role: 'owner', status: 'active' }]);
const withEditor = (status = 'active') => stubDB([
    { email: OWNER, role: 'owner', status: 'active' },
    { email: EDITOR, role: 'news-editor', status },
]);

// ── /api/verify: who is calling ──────────────────────────────────────────────

test('/api/verify reports the owner', async () => {
    const { status, json } = await call('/api/verify', {}, { db: owner() });
    assert.equal(status, 200);
    assert.equal(json.email, OWNER);
    assert.equal(json.canWrite, true);
    assert.equal(json.editor.role, 'owner');
    assert.equal(json.head, 'commit-base', 'the panel needs the revision to save on top of');
});

test('/api/verify reports an active editor', async () => {
    const { status, json } = await call('/api/verify', { jwt: token({ email: EDITOR }) }, { db: withEditor() });
    assert.equal(status, 200);
    assert.equal(json.email, EDITOR);
    assert.equal(json.editor.role, 'news-editor');
    assert.equal(json.editor.status, 'active');
});

test('/api/verify seeds an allowlisted account that has no editor record', async () => {
    const db = owner();
    const newcomer = 'new.person@example.com';
    const { status, json } = await call('/api/verify', { jwt: token({ email: newcomer }) }, { db, env: { ALLOWED_EMAILS: `${OWNER},${newcomer}` } });
    assert.equal(status, 200, 'the new account must not fail');
    assert.ok(json.editor, 'the seeded record should be reported');
    assert.equal(json.editor.email, newcomer);
    assert.equal(json.editor.role, 'owner');
});

test('a pending editor can sign in and is told they are pending', async () => {
    const { status, json } = await call('/api/verify', { jwt: token({ email: EDITOR }) }, { db: withEditor('pending') });
    assert.equal(status, 200, 'authentication must succeed so the panel can explain the state');
    assert.equal(json.editor.status, 'pending');
});

test('a suspended editor can sign in and is told they are suspended', async () => {
    const { status, json } = await call('/api/verify', { jwt: token({ email: EDITOR }) }, { db: withEditor('suspended') });
    assert.equal(status, 200);
    assert.equal(json.editor.status, 'suspended');
});

test('a registry that cannot be read refuses, and says so', async () => {
    // The rule this replaces let an allowlisted address through whenever the
    // database was unreachable, which is a grant the registry never made.
    const { status, json } = await call('/api/verify', {}, { db: stubDB([], { broken: true }) });
    assert.equal(status, 503);
    assert.match(json.error, /registry/i);
});

test('/api/verify refuses a Worker with no database binding', async () => {
    const { status, json } = await call('/api/verify', {}, { env: { DB: null } });
    assert.equal(status, 503);
    assert.match(json.error, /registry/i);
});

test('/api/verify refuses an expired session', async () => {
    const { status, json } = await call('/api/verify', { jwt: token({ expiresIn: -3600 }) });
    assert.equal(status, 401);
    assert.match(json.error, /session/i);
});

test('/api/verify refuses a token signed by another key', async () => {
    const { status } = await call('/api/verify', { jwt: token({ kid: 'not-a-known-key' }) });
    assert.equal(status, 401);
});

test('/api/verify refuses a token for another audience', async () => {
    const { status } = await call('/api/verify', { jwt: token({ audience: 'somewhere-else' }) });
    assert.equal(status, 401);
});

test('/api/verify refuses a call with no token', async () => {
    const { status } = await call('/api/verify', { jwt: '' });
    assert.equal(status, 401);
});

test('/api/verify refuses a call from another site', async () => {
    const { status } = await call('/api/verify', { origin: 'https://not-wesam.example' });
    assert.equal(status, 403);
});

test('/api/verify refuses an account that is not an editor', async () => {
    const { status, json } = await call('/api/verify', { jwt: token({ email: 'stranger@example.com' }) }, { db: owner() });
    assert.equal(status, 403);
    assert.match(json.error, /not an editor/i);
});

test('the sign-in page answers a signed-in person who is not an editor', async () => {
    // It is the page the sign-in flow lands on, so it must say who signed in and
    // not depend on the registry being readable.
    const { status, text } = await call('/api/signed-in', { jwt: token({ email: 'stranger@example.com' }) }, { db: owner() });
    assert.equal(status, 200);
    assert.match(text, /stranger@example\.com/);
});

// ── /api/commit: one save, one commit ────────────────────────────────────────

test('a save writes every file it changed as a single commit', async () => {
    const github = stubGitHub({ files: { [NEWS]: 'sha-news-old', [STATE]: 'sha-state-old' } });
    const db = owner();
    const { status, json } = await call('/api/commit', {
        method: 'POST',
        body: {
            base: 'commit-base',
            message: 'Save news entries from the panel',
            changes: [
                { path: NEWS, text: '<html>new</html>' },
                { path: STATE, text: '{"version":1}' },
            ],
        },
    }, { db, github });

    assert.equal(status, 200);
    assert.equal(json.commit, github.commits[0].sha);
    assert.deepEqual(json.files.map((file) => file.path), [NEWS, STATE]);
    assert.deepEqual(json.deleted, []);
    assert.equal(github.commits.length, 1, 'a save must be one commit, not one per file');
    assert.deepEqual(github.commits[0].parents, ['commit-base']);
    assert.equal(github.head(), json.commit, 'the branch must be moved onto the new commit');
});

test('a save cannot overwrite a revision it did not read', async () => {
    const github = stubGitHub({ files: { [NEWS]: 'sha-news-old' } });
    github.setHead('commit-someone-else');
    const { status, json } = await call('/api/commit', {
        method: 'POST',
        body: { base: 'commit-base', changes: [{ path: NEWS, text: 'mine' }] },
    }, { db: owner(), github });

    assert.equal(status, 409);
    assert.match(json.error, /still here/i, 'the message must say the draft survives');
    assert.equal(github.commits.length, 0, 'nothing may be written');
    assert.equal(github.store[NEWS], 'sha-news-old', 'the other editor’s file must be untouched');
});

test('a commit landing during the save is caught by the branch update', async () => {
    // The base check passes, then someone else commits before the branch moves.
    // GitHub refuses a non-fast-forward, and that is the last line of defence.
    const github = stubGitHub({ files: { [NEWS]: 'sha-news-old' }, raceOnRefUpdate: true });
    const { status, json } = await call('/api/commit', {
        method: 'POST',
        body: { base: 'commit-base', changes: [{ path: NEWS, text: 'mine' }] },
    }, { db: owner(), github });

    assert.equal(status, 409);
    assert.match(json.error, /GitHub refused the write/i);
    assert.equal(github.head(), 'commit-from-someone-else');
});

test('a save that deletes a record page does it in the same commit as the news page', async () => {
    const github = stubGitHub({ files: { [NEWS]: 'sha-news', [RECORD]: 'sha-record' } });
    const { status, json } = await call('/api/commit', {
        method: 'POST',
        body: {
            base: 'commit-base',
            changes: [
                { path: NEWS, text: '<html>without the card</html>' },
                { path: RECORD, delete: true },
            ],
        },
    }, { db: owner(), github });

    assert.equal(status, 200);
    assert.deepEqual(json.deleted, [RECORD]);
    assert.equal(github.commits.length, 1, 'the page and the link to it must land together');
    assert.ok(!(RECORD in github.store));
});

test('every file a save deletes is named in the audit', async () => {
    const github = stubGitHub({ files: { [RECORD]: 'sha-record', 'images/wesam-20260101.jpeg': 'sha-photo' } });
    const db = owner();
    await call('/api/commit', {
        method: 'POST',
        body: {
            base: 'commit-base',
            changes: [
                { path: RECORD, delete: true },
                { path: 'images/wesam-20260101.jpeg', delete: true },
            ],
        },
    }, { db, github });

    const deletions = db._audit.filter((row) => row.action === 'content.delete');
    assert.deepEqual(deletions.map((row) => row.target), [RECORD, 'images/wesam-20260101.jpeg']);
    assert.equal(deletions[0].actor, OWNER);
    assert.equal(JSON.parse(deletions[0].detail).commit, github.commits[0].sha);
});

test('a save may add an image alongside the page that uses it', async () => {
    const github = stubGitHub({ files: { [NEWS]: 'sha-news' } });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
    const { status } = await call('/api/commit', {
        method: 'POST',
        body: {
            base: 'commit-base',
            changes: [
                { path: NEWS, text: '<html>with a photo</html>' },
                { path: 'images/wesam-20260101.jpeg', contentBase64: bytes.toString('base64') },
            ],
        },
    }, { db: owner(), github });

    assert.equal(status, 200);
    assert.equal(github.commits.length, 1);
    assert.ok(github.store['images/wesam-20260101.jpeg']);
});

test('a save with no revision to build on is refused', async () => {
    const { status, json } = await call('/api/commit', { method: 'POST', body: { changes: [{ path: NEWS, text: 'x' }] } }, { db: owner() });
    assert.equal(status, 400);
    assert.match(json.error, /which revision/i);
});

test('a save with nothing in it is refused', async () => {
    const { status } = await call('/api/commit', { method: 'POST', body: { base: 'commit-base', changes: [] } }, { db: owner() });
    assert.equal(status, 400);
});

test('a save that sends the same file twice is refused', async () => {
    const { status, json } = await call('/api/commit', {
        method: 'POST',
        body: { base: 'commit-base', changes: [{ path: NEWS, text: 'a' }, { path: NEWS, text: 'b' }] },
    }, { db: owner() });
    assert.equal(status, 400);
    assert.match(json.error, /twice/i);
});

test('a save cannot write outside the published content', async () => {
    const { status, json } = await call('/api/commit', {
        method: 'POST',
        body: { base: 'commit-base', changes: [{ path: 'worker/worker.js', text: 'mining' }] },
    }, { db: owner() });
    assert.equal(status, 400);
    assert.match(json.error, /does not write/i);
});

test('a pending editor cannot save', async () => {
    const { status, json } = await call('/api/commit', {
        method: 'POST',
        jwt: token({ email: EDITOR }),
        body: { base: 'commit-base', changes: [{ path: NEWS, text: 'x' }] },
    }, { db: withEditor('pending') });
    assert.equal(status, 403);
    assert.match(json.error, /waiting to be approved/i);
});

test('a suspended editor cannot save', async () => {
    const { status, json } = await call('/api/commit', {
        method: 'POST',
        jwt: token({ email: EDITOR }),
        body: { base: 'commit-base', changes: [{ path: NEWS, text: 'x' }] },
    }, { db: withEditor('suspended') });
    assert.equal(status, 403);
    assert.match(json.error, /suspended/i);
});

test('an active editor can save', async () => {
    const github = stubGitHub({ files: { [NEWS]: 'sha-news' } });
    const { status } = await call('/api/commit', {
        method: 'POST',
        jwt: token({ email: EDITOR }),
        body: { base: 'commit-base', changes: [{ path: NEWS, text: 'x' }] },
    }, { db: withEditor(), github });
    assert.equal(status, 200);
});

test('one save can hold at most the stated number of files', async () => {
    const changes = Array.from({ length: 61 }, (unused, index) => ({ path: `engagement-${index}.html`, delete: true }));
    const { status, json } = await call('/api/commit', { method: 'POST', body: { base: 'commit-base', changes } }, { db: owner() });
    assert.equal(status, 400);
    assert.match(json.error, /at most/i);
});

// ── /api/head ────────────────────────────────────────────────────────────────

test('/api/head answers the revision the panel should build on', async () => {
    const github = stubGitHub();
    github.setHead('commit-now');
    const { status, json } = await call('/api/head', {}, { db: owner(), github });
    assert.equal(status, 200);
    assert.equal(json.head, 'commit-now');
    assert.equal(json.branch, 'main');
});

// ── /api/write ───────────────────────────────────────────────────────────────

test('/api/write updates a file when it is given the revision it read', async () => {
    const github = stubGitHub({ files: { [NEWS]: 'sha-news' } });
    const { status } = await call('/api/write', {
        method: 'POST',
        body: { path: NEWS, text: '<html>edited</html>', sha: 'sha-news' },
    }, { db: owner(), github });
    assert.equal(status, 200);
    assert.notEqual(github.store[NEWS], 'sha-news');
});

test('/api/write refuses to update a file without the revision', async () => {
    // It used to look the sha up and write anyway, which overwrites whatever a
    // colleague saved in the meantime.
    const github = stubGitHub({ files: { [NEWS]: 'sha-news' } });
    const { status } = await call('/api/write', {
        method: 'POST',
        body: { path: NEWS, text: '<html>edited</html>' },
    }, { db: owner(), github });
    assert.equal(status, 409);
    assert.equal(github.store[NEWS], 'sha-news');
});

test('/api/write creates a file that is not there yet', async () => {
    const github = stubGitHub({ files: {} });
    const { status } = await call('/api/write', {
        method: 'POST',
        body: { path: 'engagement-brand-new.html', text: '<html></html>' },
    }, { db: owner(), github });
    assert.equal(status, 200);
});

test('/api/write refuses a pending editor', async () => {
    const { status } = await call('/api/write', {
        method: 'POST',
        jwt: token({ email: EDITOR }),
        body: { path: NEWS, text: 'x' },
    }, { db: withEditor('pending') });
    assert.equal(status, 403);
});

// ── /api/remove ──────────────────────────────────────────────────────────────

test('deleting an article removes the file and records who did it', async () => {
    const github = stubGitHub({ files: { [RECORD]: 'sha-1' } });
    const db = owner();
    const { status, json } = await call('/api/remove', {
        method: 'POST',
        body: { path: RECORD, sha: 'sha-1', message: 'Delete example entry' },
    }, { db, github });

    assert.equal(status, 200);
    assert.deepEqual(json, { path: RECORD, commit: `commit-for-${RECORD}` });
    assert.deepEqual(github.deleted, [RECORD], 'the file should have been deleted');

    const record = db._audit.at(-1);
    assert.equal(record.actor, OWNER, 'the actor should be the signed-in account');
    assert.equal(record.action, 'content.delete');
    assert.equal(record.target, RECORD, 'the deleted article should be named');
    assert.ok(record.at, 'the record should carry a timestamp');
    assert.deepEqual(JSON.parse(record.detail), { outcome: 'removed', commit: `commit-for-${RECORD}` });
});

test('an editor can delete too, and is named in the record', async () => {
    const github = stubGitHub({ files: { [RECORD]: 'sha-1' } });
    const db = withEditor();
    const { status } = await call('/api/remove', {
        method: 'POST',
        jwt: token({ email: EDITOR }),
        body: { path: RECORD, sha: 'sha-1' },
    }, { db, github });
    assert.equal(status, 200);
    assert.equal(db._audit.at(-1).actor, EDITOR);
});

test('a deletion GitHub refuses is recorded as failed', async () => {
    const github = stubGitHub({ files: { [RECORD]: 'sha-1' } });
    github.fetch = async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
    const db = owner();
    const { status } = await call('/api/remove', {
        method: 'POST',
        body: { path: RECORD, sha: 'sha-1' },
    }, { db, github });

    assert.equal(status, 502);
    const record = db._audit.at(-1);
    assert.equal(record.action, 'content.delete');
    assert.equal(record.target, RECORD);
    assert.equal(JSON.parse(record.detail).outcome, 'failed');
});

test('a deletion must name the revision it is deleting', async () => {
    const github = stubGitHub({ files: { [RECORD]: 'sha-1' } });
    const { status, json } = await call('/api/remove', { method: 'POST', body: { path: RECORD } }, { db: owner(), github });
    assert.equal(status, 400);
    assert.match(json.error, /which revision/i);
    assert.equal(github.store[RECORD], 'sha-1');
});

test('deleting a file whose revision has moved is refused', async () => {
    const github = stubGitHub({ files: { [RECORD]: 'sha-now' } });
    const { status } = await call('/api/remove', { method: 'POST', body: { path: RECORD, sha: 'sha-stale' } }, { db: owner(), github });
    assert.equal(status, 409);
    assert.equal(github.store[RECORD], 'sha-now');
});

test('the publishing state file can be removed', async () => {
    const github = stubGitHub({ files: { [STATE]: 'sha-state' } });
    const { status } = await call('/api/remove', { method: 'POST', body: { path: STATE, sha: 'sha-state' } }, { github });
    assert.equal(status, 200);
    assert.deepEqual(github.deleted, [STATE]);
});

test('a path outside the published content is refused', async () => {
    for (const path of ['worker/worker.js', '../secrets.txt', 'about.html', 'index.html', 'images/logo.png']) {
        const { status, json } = await call('/api/remove', { method: 'POST', body: { path, sha: 'sha' } });
        assert.equal(status, 400, `${path} should be refused`);
        assert.match(json.error, /does not write/i);
    }
});

// ── managing editors ─────────────────────────────────────────────────────────

test('the owner sees the editor list', async () => {
    const { status, json } = await call('/api/admin/editors', {}, { db: withEditor() });
    assert.equal(status, 200);
    assert.deepEqual(json.editors.map((row) => row.email).sort(), [EDITOR, OWNER]);
});

test('a new editor starts pending', async () => {
    const db = owner();
    const { status, json } = await call('/api/admin/editors', {
        method: 'POST',
        body: { name: 'New Editor', email: 'new@example.com' },
    }, { db });
    assert.equal(status, 201);
    assert.equal(json.editor.status, 'pending');
    assert.equal(json.editor.role, 'news-editor');
    assert.equal(db._editors.find((row) => row.email === 'new@example.com').status, 'pending');
});

test('an editor cannot see the editor list', async () => {
    const { status, json } = await call('/api/admin/editors', { jwt: token({ email: EDITOR }) }, { db: withEditor() });
    assert.equal(status, 403);
    assert.match(json.error, /owner/i);
});

test('an editor cannot add an editor', async () => {
    const { status } = await call('/api/admin/editors', {
        method: 'POST',
        jwt: token({ email: EDITOR }),
        body: { name: 'Sneaky', email: 'sneaky@example.com' },
    }, { db: withEditor() });
    assert.equal(status, 403);
});

test('a pending editor cannot add an editor', async () => {
    const { status } = await call('/api/admin/editors', {
        method: 'POST',
        jwt: token({ email: EDITOR }),
        body: { name: 'Sneaky', email: 'sneaky@example.com' },
    }, { db: withEditor('pending') });
    assert.equal(status, 403);
});

test('the owner activates an editor', async () => {
    const db = withEditor('pending');
    const { status, json } = await call(`/api/admin/editors/${encodeURIComponent(EDITOR)}`, {
        method: 'PATCH',
        body: { status: 'active' },
    }, { db });
    assert.equal(status, 200);
    assert.equal(json.editor.status, 'active');
    assert.equal(db._editors.find((row) => row.email === EDITOR).status, 'active');
    assert.equal(db._sync.at(-1).state, 'skipped', 'a Worker with no Cloudflare credentials records that it did not reconcile');
});

test('the owner suspends an editor', async () => {
    const db = withEditor();
    const { status, json } = await call(`/api/admin/editors/${encodeURIComponent(EDITOR)}`, {
        method: 'PATCH',
        body: { status: 'suspended' },
    }, { db });
    assert.equal(status, 200);
    assert.equal(json.editor.status, 'suspended');
});

test('the owner removes an editor', async () => {
    const db = withEditor();
    const { status } = await call(`/api/admin/editors/${encodeURIComponent(EDITOR)}`, { method: 'DELETE' }, { db });
    assert.equal(status, 200);
    assert.equal(db._editors.find((row) => row.email === EDITOR), undefined);
});

test('the owner cannot suspend their own account', async () => {
    const db = owner();
    const { status, json } = await call(`/api/admin/editors/${encodeURIComponent(OWNER)}`, {
        method: 'PATCH',
        body: { status: 'suspended' },
    }, { db });
    assert.equal(status, 400);
    assert.match(json.error, /cannot be suspended/i);
    assert.equal(db._editors.find((row) => row.email === OWNER).status, 'active');
});

test('the owner cannot remove their own account', async () => {
    const db = owner();
    const { status, json } = await call(`/api/admin/editors/${encodeURIComponent(OWNER)}`, { method: 'DELETE' }, { db });
    assert.equal(status, 400);
    assert.match(json.error, /your own account/i);
    assert.ok(db._editors.find((row) => row.email === OWNER));
});

test('an owner record cannot be removed by another owner', async () => {
    const other = 'second.owner@example.com';
    const db = stubDB([
        { email: OWNER, role: 'owner', status: 'active' },
        { email: other, role: 'owner', status: 'active' },
    ]);
    const { status, json } = await call(`/api/admin/editors/${encodeURIComponent(OWNER)}`, {
        method: 'DELETE',
        jwt: token({ email: other }),
    }, { db });
    assert.equal(status, 400);
    assert.match(json.error, /cannot be removed/i);
    assert.ok(db._editors.find((row) => row.email === OWNER));
});

test('the last active owner cannot be demoted', async () => {
    const db = owner();
    const { status, json } = await call(`/api/admin/editors/${encodeURIComponent(OWNER)}`, {
        method: 'PATCH',
        body: { role: 'news-editor' },
    }, { db });
    assert.equal(status, 400);
    assert.match(json.error, /last active owner/i);
    assert.equal(db._editors.find((row) => row.email === OWNER).role, 'owner');
});

test('adding an editor who is already there is refused', async () => {
    const { status, json } = await call('/api/admin/editors', {
        method: 'POST',
        body: { name: 'Again', email: EDITOR },
    }, { db: withEditor() });
    assert.equal(status, 400);
    assert.match(json.error, /already an editor/i);
});

test('adding an editor without a valid address is refused', async () => {
    for (const email of ['', 'not-an-address', 'a@b']) {
        const { status } = await call('/api/admin/editors', {
            method: 'POST',
            body: { name: 'Someone', email },
        }, { db: owner() });
        assert.equal(status, 400, `${JSON.stringify(email)} should be refused`);
    }
});

test('the editor list failing is reported as the registry being unavailable', async () => {
    const { status } = await call('/api/admin/editors', {}, { db: stubDB([], { broken: true }) });
    assert.equal(status, 503);
});

// ── what Access is being told ────────────────────────────────────────────────

test('the owner can see what Access is being told', async () => {
    const { status, json } = await call('/api/admin/access', {}, { db: withEditor() });
    assert.equal(status, 200);
    assert.deepEqual(json.desired.sort(), [EDITOR, OWNER].sort(), 'the active editors are the desired policy');
    assert.equal(json.last, null, 'nothing has been reconciled on this deployment yet');
    assert.equal(json.configured, false, 'no Cloudflare credentials here, and it must say so');
});

test('an editor cannot see what Access is being told', async () => {
    const { status, json } = await call('/api/admin/access', { jwt: token({ email: EDITOR }) }, { db: withEditor() });
    assert.equal(status, 403);
    assert.match(json.error, /owner/i);
});

test('asking for a reconciliation without credentials reports that it was skipped', async () => {
    const db = withEditor();
    const { status, json } = await call('/api/admin/access', { method: 'POST', body: {} }, { db });
    assert.equal(status, 200);
    assert.equal(json.state, 'skipped');
    assert.equal(db._sync.at(-1).state, 'skipped', 'the attempt is recorded even when it does nothing');
});

test('the Access view reports the registry being unavailable rather than failing opaquely', async () => {
    const { status } = await call('/api/admin/access', {}, { db: stubDB([], { broken: true }) });
    assert.equal(status, 503);
});

// ── the shape of the API itself ──────────────────────────────────────────────

test('a route that does not exist answers 404', async () => {
    const { status, json } = await call('/api/nonsense', {}, { db: owner() });
    assert.equal(status, 404);
    assert.match(json.error, /no \/api\/nonsense/i);
});

test('/api/health answers without a session', async () => {
    const { status, json } = await call('/api/health', { jwt: '' }, { db: owner() });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
});
