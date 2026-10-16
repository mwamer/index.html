/* The panel's only connection to the website's files.

   Every read and every change goes through the Worker at api.wesamamer.com. The
   GitHub token is a Worker secret and never reaches this page. The browser
   proves who it is with the Cloudflare Access session, and the browser attaches
   that session to each request by itself, so there is nothing to paste, nothing
   to store, and nothing to set up on a second device.

   Signed out, the panel still reads the pages from this computer, so the entry
   list stays usable without a session. Saving needs one. */

const DEV_ORIGIN = 'http://localhost:8787';
const PROD_ORIGIN = 'https://api.wesamamer.com';

export const SIGNED_IN_PATH = '/api/signed-in';
export const SIGNED_OUT_PATH = '/cdn-cgi/access/logout';

/** A failure worth explaining to the person using the panel. */
export class ApiError extends Error {
    constructor(message, status = 0, code = 'api') {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
    }
}

/** Where the API lives. Localhost talks to `wrangler dev`; everything else talks
    to the deployed Worker. `?api=` overrides both, to point a device at another
    copy. */
export function apiBase(search = '', host = '') {
    const override = apiOverride(search);
    if (override) return override;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return DEV_ORIGIN;
    return PROD_ORIGIN;
}

/** Base64 of raw bytes, in blocks small enough for String.fromCharCode. */
export function toBase64(bytes) {
    let binary = '';
    const block = 0x8000;
    for (let i = 0; i < bytes.length; i += block) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + block));
    }
    return btoa(binary);
}

/** One sentence a person can act on, for any failure the panel can hit. */
export function describe(error) {
    const message = error && error.message ? error.message : String(error);
    if (!error || !error.code) return message;
    if (error.code === 'signed-out') return 'Your session has ended. Press Sign in, then try again.';
    if (error.code === 'unreachable') return 'The API at api.wesamamer.com could not be reached. Check your connection, then try again.';
    if (error.code === 'forbidden') return `You are signed in, but the API refused: ${message}`;
    if (error.status === 409 || error.status === 422) return `The live site changed while this panel was open, so GitHub refused the write: ${message}`;
    if (error.status === 503) return `The API is not ready to save yet: ${message}`;
    return message;
}

/** The GitHub-shaped client, spoken to the Worker. */
export function gitHub(options = {}) {
    const base = options.base || apiBase(location.search, location.hostname);
    const origin = new URL(base).origin;

    async function call(path, init = {}) {
        let response;
        try {
            response = await fetch(`${base}${path}`, {
                ...init,
                credentials: 'include',
                redirect: 'manual',
                headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
                signal: AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined,
            });
        } catch (error) {
            throw Object.assign(new Error('the API could not be reached'), { code: 'unreachable' });
        }
        // Cloudflare Access answers a request with no session by redirecting to
        // its sign-in page, and a page is not allowed to follow that redirect.
        if (response.type === 'opaqueredirect' || response.status === 0) {
            throw Object.assign(new Error('no session'), { status: 401, code: 'signed-out' });
        }
        const body = await response.json().catch(() => null);
        if (!response.ok) {
            const error = new Error((body && body.error) || `the API replied ${response.status}`);
            error.status = response.status;
            error.code = response.status === 401 ? 'signed-out' : response.status === 403 ? 'forbidden' : 'api';
            throw error;
        }
        if (!body) throw Object.assign(new Error('the API did not reply with JSON'), { status: response.status, code: 'api' });
        return body;
    }

    return {
        base,
        /** Open this to start the Cloudflare Access one-time-PIN sign-in. */
        signedInUrl: `${base}${SIGNED_IN_PATH}`,
        /** Access clears its own session here. */
        signedOutUrl: `${origin}${SIGNED_OUT_PATH}?redirect_url=https://wesamamer.com/admin/`,

        async verify() {
            return call('/api/verify');
        },
        async health() {
            return call('/api/health');
        },
        async read(path, { meta = false } = {}) {
            const body = await call(`/api/read?path=${encodeURIComponent(path)}${meta ? '&meta=1' : ''}`);
            return { sha: body.sha, text: body.text || '', size: body.size };
        },
        async write(path, { text, bytes, message, sha }) {
            const payload = { path, message, sha };
            if (bytes) payload.contentBase64 = toBase64(bytes);
            else payload.text = text;
            return call('/api/write', { method: 'POST', body: JSON.stringify(payload) });
        },
        async remove(path, sha, message) {
            return call('/api/remove', { method: 'POST', body: JSON.stringify({ path, sha, message }) });
        },
        /** Write everything a save changed as one commit.
            
            `base` is the revision this panel was reading from. The Worker refuses
            the save when the site has moved on, and says so, instead of writing
            over whatever arrived in the meantime. */
        async commit({ base, message, changes }) {
            return call('/api/commit', { method: 'POST', body: JSON.stringify({ base, message, changes }) });
        },
        /** The revision the site is on now, which a save must name as its base. */
        async head() {
            return call('/api/head');
        },
        async history(path, count = 3) {
            const body = await call(`/api/history?path=${encodeURIComponent(path)}&count=${count}`);
            return body.history || [];
        },
        async readAt(path, ref) {
            const body = await call(`/api/read-at?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`);
            return body.text;
        },
        async listEditors() {
            return call('/api/admin/editors');
        },
        async addEditor(data = {}) {
            return call('/api/admin/editors', { method: 'POST', body: JSON.stringify(data) });
        },
        async updateEditor(id, data = {}) {
            return call(`/api/admin/editors/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) });
        },
        async removeEditor(id) {
            return call(`/api/admin/editors/${encodeURIComponent(id)}`, { method: 'DELETE' });
        },
        /** What Cloudflare Access is being told, and when it was last told. */
        async accessState() {
            return call('/api/admin/access');
        },
        /** Ask for the Access policy to be brought back into step now. */
        async reconcileAccess() {
            return call('/api/admin/access', { method: 'POST', body: '{}' });
        },
    };
}

/** `?api=` wins over the hostname, so a device can be pointed at another copy. */
function apiOverride(search) {
    const value = new URLSearchParams(search || '').get('api');
    return value ? value.replace(/\/+$/, '') : '';
}
