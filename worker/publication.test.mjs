#!/usr/bin/env node
/* Tests for publication.js: whether a save has reached the public website.

   The module is handed a `gh` function, so GitHub is stubbed by passing one in.
   Only the public site and Cloudflare go through `fetch`, and those are stubbed
   here. Nothing touches the live site or the live repository.

   Run:  node --test worker/
*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { publicationReport, purgeCache, siteOrigin, digestOf } from './publication.js';

const REPO = 'https://api.github.com/repos/mwamer/index.html';
const SITE = 'https://wesamamer.com';
const NEWS = 'news-engagement.html';
const STATE = '.panel-state.json';
const SHA = 'a'.repeat(40);

const OLD = '<html>the earlier page</html>\n';
const NEW = '<html>the new page</html>\n';
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

// ── a GitHub that knows one commit ───────────────────────────────────────────

/** `files` maps a path to `{ text }` for a file this commit writes, or
    `{ deleted: true }` for one it removes. */
function stubGitHub({ files = {}, build = null, unreadableContent = false } = {}) {
    const calls = [];
    return {
        calls,
        async gh(env, path) {
            calls.push(path);
            if (path === '/pages/builds/latest') {
                if (!build) throw new Error('GitHub replied: Resource not accessible by personal access token');
                return build;
            }
            const commit = path.match(/^\/commits\/([0-9a-f]{40})$/);
            if (commit) {
                return {
                    sha: commit[1],
                    files: Object.entries(files).map(([filename, value]) => ({
                        filename,
                        status: value.deleted ? 'removed' : 'modified',
                    })),
                };
            }
            const content = path.match(/^\/contents\/(.+?)\?ref=/);
            if (content) {
                if (unreadableContent) throw new Error('GitHub replied: Not Found');
                const name = decodeURIComponent(content[1]);
                const value = files[name];
                if (!value || value.deleted) throw new Error('GitHub replied: Not Found');
                return { content: b64(value.text) };
            }
            throw new Error(`stubGitHub does not know: ${path}`);
        },
    };
}

// ── the public site ──────────────────────────────────────────────────────────

/** `origin` is what a request nothing could have cached is served, and
    `cached` is what an ordinary request is served. They differ exactly when a
    cache is holding the earlier page, which is the case worth testing. */
function stubSite({ origin = {}, cached = null, unreachable = false } = {}) {
    const asked = [];
    return {
        asked,
        fetch(url) {
            const target = new URL(url);
            const path = decodeURIComponent(target.pathname.replace(/^\//, ''));
            const fresh = target.searchParams.has('publication');
            asked.push({ path, fresh });
            if (unreachable) throw new Error('the site could not be reached');
            const table = fresh || !cached ? origin : cached;
            if (!(path in table)) return new Response('Not Found', { status: 404 });
            return new Response(table[path], { status: 200, headers: { 'cache-control': 'max-age=600' } });
        },
    };
}

/** Point `fetch` at the stubs for one test, and always put the real one back. */
async function withFetch({ site, cloudflare }, fn) {
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const target = String(url);
        if (target.startsWith(SITE)) return site.fetch(target);
        if (cloudflare && target.startsWith('https://api.cloudflare.com')) return cloudflare.fetch(target, init);
        throw new Error(`unexpected fetch: ${target}`);
    };
    try {
        return await fn();
    } finally {
        globalThis.fetch = real;
    }
}

const report = (rest) => publicationReport({}, rest.github.gh, { sha: SHA, purge: false, ...rest.options });

// ── the steps ────────────────────────────────────────────────────────────────

test('a commit GitHub has but the site does not yet serve is reported as started', async () => {
    const github = stubGitHub({ files: { [NEWS]: { text: NEW } } });
    const site = stubSite({ origin: { [NEWS]: OLD } });
    await withFetch({ site }, async () => {
        const result = await report({ github });
        assert.equal(result.deployment.state, 'started');
        assert.equal(result.verified, false);
        assert.equal(result.files[0].originState, 'earlier');
        assert.equal(result.files[0].url, `${SITE}/${NEWS}`);
    });
});

test('once the origin has the new page the deployment is complete, but a cache holding the old one is not verified', async () => {
    const github = stubGitHub({ files: { [NEWS]: { text: NEW } } });
    const site = stubSite({ origin: { [NEWS]: NEW }, cached: { [NEWS]: OLD } });
    await withFetch({ site }, async () => {
        const result = await report({ github });
        assert.equal(result.deployment.state, 'completed');
        assert.equal(result.files[0].originState, 'current');
        assert.equal(result.files[0].publicState, 'earlier');
        assert.equal(result.verified, false, 'a reader is still served the earlier page');
    });
});

test('a page served as the commit holds it is verified, by both measurements', async () => {
    const github = stubGitHub({ files: { [NEWS]: { text: NEW } } });
    const site = stubSite({ origin: { [NEWS]: NEW } });
    await withFetch({ site }, async () => {
        const result = await report({ github });
        assert.equal(result.deployment.state, 'completed');
        assert.equal(result.files[0].publicState, 'current');
        assert.equal(result.verified, true);
    });
});

test('a deleted page is verified by its absence, and by nothing less', async () => {
    const github = stubGitHub({ files: { 'engagement-gone.html': { deleted: true } } });
    const absent = stubSite({ origin: {} });
    await withFetch({ site: absent }, async () => {
        const gone = await report({ github });
        assert.equal(gone.files[0].kind, 'deleted');
        assert.equal(gone.files[0].originState, 'gone');
        assert.equal(gone.deployment.state, 'completed');
        assert.equal(gone.verified, true);
    });

    const still = stubSite({ origin: { 'engagement-gone.html': OLD } });
    await withFetch({ site: still }, async () => {
        const retained = await report({ github });
        assert.equal(retained.files[0].publicState, 'retained');
        assert.equal(retained.verified, false, 'the page is still being served, so the deletion has not published');
    });
});

test('the state file travels in the commit but is not part of the public site', async () => {
    // GitHub Pages does not publish dotfiles, so asking the site about the state
    // file would fail for a reason that has nothing to do with publication.
    const github = stubGitHub({ files: { [NEWS]: { text: NEW }, [STATE]: { text: '{"a":1}' } } });
    const site = stubSite({ origin: { [NEWS]: NEW } });
    await withFetch({ site }, async () => {
        const result = await report({ github });
        assert.deepEqual(result.files.map((file) => file.path), [NEWS]);
        assert.equal(result.verified, true);
    });
});

test('a site that cannot be read is unknown, and unknown is not verified', async () => {
    const github = stubGitHub({ files: { [NEWS]: { text: NEW } } });
    const site = stubSite({ unreachable: true });
    await withFetch({ site }, async () => {
        const result = await report({ github });
        assert.equal(result.deployment.state, 'unknown');
        assert.equal(result.files[0].originState, 'unknown');
        assert.equal(result.verified, false);
    });
});

test('a report names the commit it reports on', async () => {
    const github = stubGitHub({ files: {} });
    await assert.rejects(() => publicationReport({}, github.gh, { sha: 'not-a-revision' }), /40-character revision/);
    await assert.rejects(() => publicationReport({}, github.gh, {}), /40-character revision/);
});

test('the Pages build status is a detail, not the answer', async () => {
    const github = stubGitHub({ files: { [NEWS]: { text: NEW } } });
    const site = stubSite({ origin: { [NEWS]: NEW } });
    await withFetch({ site }, async () => {
        const without = await report({ github });
        assert.equal(without.deployment.build, null, 'a token without the Pages permission costs a detail, not an answer');
        assert.equal(without.verified, true);
    });

    const withBuild = stubGitHub({ files: { [NEWS]: { text: NEW } }, build: { status: 'built', commit: SHA, error: null } });
    await withFetch({ site }, async () => {
        const result = await report({ github: withBuild });
        assert.equal(result.deployment.build.status, 'built');
    });
});

test('a Pages build that errored is reported as a failure', async () => {
    const github = stubGitHub({
        files: { [NEWS]: { text: NEW } },
        build: { status: 'errored', commit: SHA, error: { message: 'Page build failed' } },
    });
    const site = stubSite({ origin: { [NEWS]: OLD } });
    await withFetch({ site }, async () => {
        const result = await report({ github });
        assert.equal(result.deployment.state, 'failed');
        assert.match(result.deployment.detail, /Page build failed/);
    });
});

test('a commit that changed nothing the site serves is not called verified', async () => {
    const github = stubGitHub({ files: { [STATE]: { text: '{}' } } });
    const site = stubSite({ origin: {} });
    await withFetch({ site }, async () => {
        const result = await report({ github });
        assert.deepEqual(result.files, []);
        assert.equal(result.verified, false);
    });
});

// ── the cache step ───────────────────────────────────────────────────────────

test('without a Cloudflare zone the cache step says so, and never claims it ran', async () => {
    const github = stubGitHub({ files: { [NEWS]: { text: NEW } } });
    const site = stubSite({ origin: { [NEWS]: NEW } });
    await withFetch({ site }, async () => {
        const result = await publicationReport({}, github.gh, { sha: SHA, purge: true });
        assert.equal(result.cache.state, 'not-configured');
        assert.equal(result.verified, true, 'no cache in front does not make the page unverified');
    });
});

test('a purge names only the URLs this save changed', async () => {
    const github = stubGitHub({ files: { [NEWS]: { text: NEW }, 'engagement-gone.html': { deleted: true } } });
    const site = stubSite({ origin: { [NEWS]: NEW } });
    const purged = [];
    const cloudflare = {
        fetch: async (url, init) => {
            purged.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ success: true, result: { id: 'purge-1' } }), { status: 200 });
        },
    };
    const env = { CF_ZONE_ID: 'zone-1', CF_CACHE_TOKEN: 'cache-token' };
    await withFetch({ site, cloudflare }, async () => {
        const result = await publicationReport(env, github.gh, { sha: SHA, purge: true });
        assert.equal(result.cache.state, 'purged');
        assert.deepEqual(purged, [{ files: [`${SITE}/${NEWS}`, `${SITE}/engagement-gone.html`] }]);
        assert.equal(result.behindCloudflare, false, 'the stub site serves no Cloudflare headers, so nothing is in front of it');
    });
});

test('a purge Cloudflare refused is reported as failed, not as done', async () => {
    const env = { CF_ZONE_ID: 'zone-1', CF_CACHE_TOKEN: 'cache-token' };
    const refused = {
        fetch: async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'Invalid zone' }] }), { status: 200 }),
    };
    await withFetch({ site: stubSite({ origin: {} }), cloudflare: refused }, async () => {
        const result = await purgeCache(env, [`${SITE}/${NEWS}`]);
        assert.equal(result.state, 'failed');
        assert.match(result.detail, /Invalid zone/);
    });
});

test('purging nothing is skipped rather than sent as an empty purge', async () => {
    const env = { CF_ZONE_ID: 'zone-1', CF_CACHE_TOKEN: 'cache-token' };
    let asked = false;
    await withFetch({
        site: stubSite({ origin: {} }),
        cloudflare: { fetch: async () => { asked = true; return new Response('{}', { status: 200 }); } },
    }, async () => {
        const result = await purgeCache(env, []);
        assert.equal(result.state, 'skipped');
        assert.equal(asked, false, 'an empty purge is not sent');
    });
});

// ── the origin is configurable, so a staging copy can be checked ─────────────

test('the site origin can be pointed elsewhere, and is otherwise wesamamer.com', () => {
    assert.equal(siteOrigin({}), SITE);
    assert.equal(siteOrigin({ SITE_ORIGIN: 'https://staging.example.com/' }), 'https://staging.example.com');
});

test('the digest used to compare pages is SHA-256 of the bytes served', async () => {
    const bytes = new TextEncoder().encode(NEW);
    const same = await digestOf(bytes);
    assert.match(same, /^[0-9a-f]{64}$/);
    assert.equal(await digestOf(new TextEncoder().encode(NEW)), same, 'the same bytes give the same digest');
    assert.notEqual(await digestOf(new TextEncoder().encode(OLD)), same);
});
