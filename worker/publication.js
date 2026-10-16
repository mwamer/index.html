/* Whether a save has reached the public website.

   The panel's save ends when GitHub accepts the commit. That is not the same
   event as a reader seeing the changed page. Between the two sit a Pages build
   and, on the way out, caches: GitHub serves the site's HTML with
   `Cache-Control: max-age=600`, so a browser or an edge cache can hold the
   earlier page for ten minutes after the new one is live. A panel that reported
   its work done at the commit would be reporting the wrong moment.

   So each step is measured, not assumed:

   - The commit exists. The panel has already been told this by `/api/commit`.
   - The site's own copy has changed. Measured with a request nothing could have
     cached, so the answer comes from the origin.
   - A reader's copy has changed. Measured without that, so the answer includes
     whatever caches stand in front — which is what a visitor actually gets.
   - Caches were asked to drop the URLs. Only possible when a Cloudflare zone is
     configured for the website, which today it is not: wesamamer.com resolves
     to GitHub Pages directly, so there is no edge cache in front of it. That is
     reported as not applicable, never as done.

   A step that cannot be measured is reported as `unknown`, with the reason. */

const CF_API = 'https://api.cloudflare.com/client/v4';

/** Where the website is served. Configurable, so a staging copy can be checked
    with the same code. */
export function siteOrigin(env) {
    return String(env.SITE_ORIGIN || 'https://wesamamer.com').replace(/\/+$/, '');
}

/** Hex SHA-256 of some bytes. */
export async function digestOf(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const bytesFromBase64 = (value) => Uint8Array.from(atob(String(value).replace(/\s/g, '')), (c) => c.charCodeAt(0));

/** The files a commit changed, as GitHub records them. */
async function commitFiles(env, gh, sha) {
    const commit = await gh(env, `/commits/${sha}`);
    return (commit.files || []).map((file) => ({
        path: String(file.filename),
        deleted: file.status === 'removed',
    }));
}

/** A page as the public site serves it.

    `fresh` asks with a query nothing has ever used, so the answer cannot come
    from a cache. Without it the answer may, which is the reason for asking the
    same question twice. */
async function fetchPublic(url, { fresh = false } = {}) {
    const target = fresh ? `${url}${url.includes('?') ? '&' : '?'}publication=${Date.now()}` : url;
    try {
        const response = await fetch(target, { redirect: 'follow' });
        return {
            status: response.status,
            bytes: new Uint8Array(await response.arrayBuffer()),
            cacheControl: response.headers.get('cache-control') || '',
            age: response.headers.get('age') || '',
            behindCloudflare: Boolean(response.headers.get('cf-cache-status') || response.headers.get('cf-ray')),
        };
    } catch (error) {
        return { status: 0, bytes: new Uint8Array(), detail: (error && error.message) || String(error) };
    }
}

/** GitHub's own view of the last Pages build, when the token may read it.

    This is enrichment only. The measurement that decides anything is whether the
    site serves the new bytes, so a token without the Pages permission costs a
    detail, not an answer. */
async function pagesBuild(env, gh) {
    try {
        const build = await gh(env, '/pages/builds/latest');
        return {
            status: String(build.status || 'unknown'),
            commit: String(build.commit || ''),
            error: (build.error && build.error.message) || '',
        };
    } catch {
        return null;
    }
}

/** One file: what the origin serves, and what a reader is served. */
async function verifyFile(env, gh, { path, deleted, ref }) {
    const url = `${siteOrigin(env)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const origin = await fetchPublic(url, { fresh: true });
    const visitor = await fetchPublic(url);
    const common = { path, url, kind: deleted ? 'deleted' : 'written', cacheControl: visitor.cacheControl, age: visitor.age };

    if (deleted) {
        const state = (result) => (result.status === 404 ? 'gone'
            : result.status === 0 ? 'unknown' : 'retained');
        return { ...common, originState: state(origin), publicState: state(visitor) };
    }

    let expected = null;
    try {
        const body = await gh(env, `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
        expected = await digestOf(bytesFromBase64(body.content || ''));
    } catch (error) {
        return { ...common, originState: 'unknown', publicState: 'unknown', detail: `the committed copy could not be read: ${(error && error.message) || String(error)}` };
    }

    const state = async (result) => {
        if (result.status === 0) return 'unknown';
        if (result.status !== 200) return 'unreachable';
        return (await digestOf(result.bytes)) === expected ? 'current' : 'earlier';
    };
    return { ...common, originState: await state(origin), publicState: await state(visitor) };
}

/** Ask Cloudflare to drop specific URLs.

    By URL, not by tag and not the whole zone: only the pages this save changed.
    Without a zone configured there is nothing to ask, and the answer says so. */
export async function purgeCache(env, urls) {
    if (!env.CF_ZONE_ID || !env.CF_CACHE_TOKEN) {
        return {
            state: 'not-configured',
            detail: 'No Cloudflare zone is configured for this Worker, so there was nothing to purge.',
            urls: [],
        };
    }
    if (!urls.length) return { state: 'skipped', detail: 'No changed URL was known, so nothing was purged.', urls: [] };
    try {
        const response = await fetch(`${CF_API}/zones/${encodeURIComponent(env.CF_ZONE_ID)}/purge_cache`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.CF_CACHE_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: urls }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.success === false) {
            const said = (body.errors && body.errors[0] && body.errors[0].message) || `Cloudflare replied ${response.status}`;
            return { state: 'failed', detail: said, urls };
        }
        return { state: 'purged', detail: `Asked Cloudflare to drop ${urls.length} URL(s).`, urls };
    } catch (error) {
        return { state: 'failed', detail: (error && error.message) || String(error), urls };
    }
}

const SETTLED = ['current', 'gone'];
const awaiting = (states) => states.some((state) => state === 'unknown');

/** The whole picture for one commit, in the panel's own steps.

    `purge` asks Cloudflare to drop the changed URLs first, which is worth doing
    only once the origin has the new bytes: a purge before the build finishes
    lets the old page back in. */
export async function publicationReport(env, gh, { sha, purge = false } = {}) {
    const revision = String(sha || '');
    if (!/^[0-9a-f]{40}$/i.test(revision)) {
        throw new Error('A publication report names the commit it reports on, as a 40-character revision.');
    }

    const changed = (await commitFiles(env, gh, revision))
        // GitHub Pages does not publish dotfiles, so the state file that travels
        // in the same commit is not part of the public site and is not checked.
        .filter((file) => !file.path.split('/').some((part) => part.startsWith('.')));

    if (!changed.length) {
        return {
            sha: revision,
            checkedAt: new Date().toISOString(),
            deployment: { state: 'unknown', detail: 'This commit changed nothing the public site serves.' },
            files: [],
            cache: { state: 'skipped', detail: 'Nothing published, so no cache step applied.', urls: [], behindCloudflare: false },
            verified: false,
        };
    }

    const files = [];
    for (const file of changed) files.push(await verifyFile(env, gh, { ...file, ref: revision }));

    const originStates = files.map((file) => file.originState);
    const publicStates = files.map((file) => file.publicState);
    const behindCloudflare = files.some((file) => file.behindCloudflare);
    const build = await pagesBuild(env, gh);

    const deployment = originStates.every((state) => SETTLED.includes(state))
        ? { state: 'completed', detail: 'The site serves what this commit holds.' }
        : awaiting(originStates)
            ? { state: 'unknown', detail: 'The site could not be read, so the deployment could not be measured.' }
            : { state: 'started', detail: 'GitHub has the commit; the site is not serving it yet.' };
    if (build && build.status === 'errored') {
        deployment.state = 'failed';
        deployment.detail = build.error || 'The GitHub Pages build reported an error.';
    }

    const cache = purge ? await purgeCache(env, files.map((file) => file.url)) : null;

    return {
        sha: revision,
        checkedAt: new Date().toISOString(),
        deployment: { ...deployment, build },
        files,
        cache,
        behindCloudflare,
        verified: publicStates.every((state) => SETTLED.includes(state)),
    };
}
