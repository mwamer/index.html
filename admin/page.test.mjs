/* The page's own glue, run the way a browser runs it.

   `panel.test.mjs` checks the pure logic, and `admin/index.html` holds a further
   few hundred lines that only exist to wire that logic to the page — reading
   elements, collecting a save, calling the API. Nothing ran that code, so a
   mistake in it failed in the browser and nowhere else: a call to a function the
   page never imported got as far as an upload before anyone noticed.

   This file closes that gap. It reads the inline module out of the page, gives it
   a small stand-in for the browser, and drives the real handlers. The stand-in is
   deliberately thin: an unknown element is handed back rather than crashing, so
   what these tests catch is the glue being *wrong*, not the page being unknown.
   Which elements exist is checked separately, from the markup itself.

   Nothing here touches the network. Reads are answered from the site's own files.

   Run with: node --test admin/ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = new URL('.', import.meta.url);
const PAGE = readFileSync(new URL('./index.html', HERE), 'utf8');
const GLUE = PAGE.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

// ── a small stand-in for the browser ────────────────────────────────────────

class FakeClassList {
    constructor() { this.names = new Set(); }
    add(...names) { for (const name of names) this.names.add(name); }
    remove(...names) { for (const name of names) this.names.delete(name); }
    toggle(name, force) { if (force) this.names.add(name); else this.names.delete(name); }
    contains(name) { return this.names.has(name); }
}

class FakeElement {
    constructor(tag = 'div') {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.attrs = {};
        this.style = {};
        this.classList = new FakeClassList();
        this.listeners = {};
        this.textContent = '';
        this.markup = '';
        this.hidden = false;
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.files = null;
        this.scrollTop = 0;
        this.scrollHeight = 0;
    }
    get innerHTML() { return this.markup; }
    set innerHTML(value) { this.markup = String(value); this.children = []; }
    get className() { return [...this.classList.names].join(' '); }
    set className(value) { this.classList = new FakeClassList(); for (const n of String(value).split(/\s+/)) if (n) this.classList.add(n); }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    dispatch(type, event = {}) { for (const handler of this.listeners[type] || []) handler(event); }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    append(...children) { for (const child of children) this.appendChild(child); }
    removeChild(child) { this.children = this.children.filter((item) => item !== child); return child; }
    replaceChildren(...children) { this.children = []; this.markup = ''; this.append(...children); }
    insertAdjacentHTML(_where, markup) { this.markup += markup; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
    removeAttribute(name) { delete this.attrs[name]; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    focus() {}
    blur() {}
    select() {}
    click() { return this.dispatch('click', { target: this }); }
    scrollIntoView() {}
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; }
    /** Only the selector shapes the page actually uses: an id, or a data
        attribute, possibly a comma-separated list of those. */
    matches(selector) {
        return selector.split(',').some((one) => {
            const part = one.trim();
            const attribute = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
            if (attribute) {
                const [, name, value] = attribute;
                // `data-act` is `dataset.act`: the prefix is not part of the key.
                const bare = name.startsWith('data-') ? name.slice('data-'.length) : name;
                const key = bare.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
                if (!(key in this.dataset)) return false;
                return value === undefined || String(this.dataset[key]) === value;
            }
            if (part.startsWith('#')) return this.id === part.slice(1);
            return false;
        });
    }
    closest(selector) {
        for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node;
        return null;
    }
}

/** A stand-in for the page. Elements are handed out by selector and remembered,
    the way the real document remembers them, so setting `.hidden` on `#pn-log`
    once is still visible the next time the page asks for it. */
function fakeDocument() {
    const bySelector = new Map();
    const document = {
        listenerLists: {},
        createElement: (tag) => new FakeElement(tag),
        createTextNode: (text) => { const node = new FakeElement('#text'); node.textContent = String(text); return node; },
        querySelector(selector) {
            if (!bySelector.has(selector)) {
                const element = new FakeElement('div');
                element.id = selector.startsWith('#') ? selector.slice(1) : '';
                bySelector.set(selector, element);
            }
            return bySelector.get(selector);
        },
        querySelectorAll: () => [],
        addEventListener(type, handler) { (document.listenerLists[type] ||= []).push(handler); },
        element: (selector) => document.querySelector(selector),
    };
    return document;
}

/** Let every promise the page is waiting on settle. */
async function settle(turns = 80) {
    for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Load `admin/index.html`'s own module against a stubbed browser, and hand back
    what the test needs to look at it: the fake document, and every API call the
    page made. */
async function loadPage({ verifyStatus = 'active', role = 'owner', editors = [], commit = null, publication = null, publicationFails = false } = {}) {
    const calls = [];
    const document = fakeDocument();
    const clipboard = [];
    let publicationServed = 0;
    const dir = mkdtempSync(join(tmpdir(), 'page-glue-'));

    const json = (body, status = 200) => ({
        ok: status >= 200 && status < 300,
        status,
        type: 'basic',
        json: async () => body,
    });

    // The page reads the published site directly for the pages the API will not
    // serve, so those are answered from this repository's own files.
    const siteFile = (url) => {
        const name = new URL(url, 'https://wesamamer.com/admin/index.html').pathname.split('/').pop();
        try { return readFileSync(new URL(`../${name}`, HERE), 'utf8'); } catch { return ''; }
    };

    const fetch = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        calls.push({ path: String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0], body });
        const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];

        if (path === '/api/verify') {
            return json({
                email: 'wesam.amer@gmail.com',
                canWrite: role === 'owner',
                editor: { email: 'wesam.amer@gmail.com', role, status: verifyStatus },
                head: 'head-1',
            });
        }
        if (path === '/api/admin/editors') return json({ editors });
        // Reading, changing and removing one editor share a prefix, so they are
        // answered together; the tests assert on what was sent, not on the reply.
        if (path.startsWith('/api/admin/editors/')) return json({ editor: {}, success: true });
        if (path === '/api/admin/access') return json({ desired: [], last: null, configured: false });
        if (path === '/api/admin/access') return json({ desired: [], last: null, configured: false });
        if (path === '/api/read' || path === '/api/read-at') {
            return json({ sha: 'sha-1', text: siteFile(new URL(url).searchParams.get('path') || ''), size: 1 });
        }
        if (path === '/api/history') return json({ history: [] });
        if (path === '/api/head') return json({ sha: 'head-1' });
        if (path === '/api/commit') {
            if (commit) return commit(json, calls);
            return json({ commit: 'commit-2', head: 'head-2', files: [], deleted: [] });
        }
        if (path === '/api/publication') {
            if (publicationFails) return json({ error: 'the site could not be reached' }, 503);
            // A report says what the site is serving now. Without one, the site is
            // taken to be serving the commit straight away, which keeps the tests
            // that are not about publication from waiting on it.
            const supplied = typeof publication === 'function' ? publication(body, calls) : publication;
            if (Array.isArray(supplied)) {
                const next = supplied[Math.min(publicationServed, supplied.length - 1)];
                publicationServed += 1;
                return json(typeof next === 'function' ? next(body, calls) : next);
            }
            return json(supplied || verifiedReport());
        }
        if (path.startsWith('/api/')) return json({ error: 'no such route' }, 404);
        return json(null) && { ok: true, status: 200, type: 'basic', text: async () => siteFile(url), json: async () => null };
    };

    // `AbortSignal.timeout` arms a real timer on every request. The stub answers
    // immediately and nothing is ever aborted, so a permanent signal keeps the
    // test process from waiting on timers it does not need.
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => new AbortController().signal;

    // Reading a photograph's size goes through an object URL and an off-screen
    // image, so both have to answer the way a browser does.
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:stub';
    URL.revokeObjectURL = () => {};

    // `navigator` and `fetch` are getter-only globals in Node, so they have to be
    // defined rather than assigned.
    const saved = new Map();
    const put = (key, value) => {
        saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { value, writable: true, configurable: true, enumerable: true });
    };
    put('document', document);
    put('fetch', fetch);
    put('confirm', () => true);
    put('alert', () => {});
    put('prompt', () => null);
    put('history', { pushState() {}, replaceState() {}, state: null });
    put('localStorage', memoryStorage());
    put('navigator', { clipboard: { writeText: async (text) => { clipboard.push(text); } }, userAgent: 'node' });
    put('location', { href: 'https://wesamamer.com/admin/index.html', search: '', hostname: 'wesamamer.com', reload() {} });
    // An image that reports its size as soon as `src` is set, which is what the
    // page waits for before it will accept a photograph.
    put('Image', class {
        constructor() {
            this.onload = null;
            this.onerror = null;
            this.naturalWidth = 1200;
            this.naturalHeight = 800;
            this.src = '';
        }
        set src(value) {
            this._src = value;
            queueMicrotask(() => { if (this.onload) this.onload(); });
        }
        get src() { return this._src; }
    });
    put('window', {
        open: () => null,
        scrollTo() {},
        addEventListener: (type, handler) => document.addEventListener(`window:${type}`, handler),
        location: globalThis.location,
        localStorage: globalThis.localStorage,
    });

    // The page's own callbacks resolve `document` and friends at call time, so the
    // stand-in has to stay in place until the test is done with the page, not just
    // until it has finished loading.
    const restore = () => {
        AbortSignal.timeout = originalTimeout;
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    };

    try {
        const file = join(dir, 'page.mjs');
        writeFileSync(file, GLUE.replace(/from '\.\/([\w.-]+\.js)\?v=[\w]+'/g,
            (_, name) => `from '${new URL(`./${name}`, HERE).href}'`));
        const module = await import(pathToFileURL(file).href);
        await settle();
        return { module, document, calls, clipboard, restore };
    } catch (error) {
        restore();
        throw error;
    }
}

function memoryStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
        clear: () => map.clear(),
        key: (index) => [...map.keys()][index] ?? null,
        get length() { return map.size; },
    };
}

/** The login the last `loadPage` left behind can be inspected through the
    element the page writes messages to. */
const statusOf = (document) => document.element('#pn-status').textContent;

/** Press a button the way the page's own dispatcher expects to be handed one. */
function press(document, dataset) {
    const button = new FakeElement('button');
    Object.assign(button.dataset, dataset);
    const handlers = document.listenerLists.click || [];
    assert.ok(handlers.length, 'the page should register a click handler');
    return handlers[0]({ target: button, preventDefault() {} });
}

/** Hand the page a file the way a file picker does. */
function choose(document, photoIndex, file) {
    const input = new FakeElement('input');
    input.dataset.photoFile = String(photoIndex);
    input.files = [file];
    const handlers = document.listenerLists.change || [];
    assert.ok(handlers.length, 'the page should register a change handler');
    return handlers[0]({ target: input });
}

/** A stand-in for a chosen photograph. */
const fakePhoto = (name, bytes = [1, 2, 3]) => ({
    name,
    size: bytes.length,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
});

const apiCalls = (calls) => calls.filter((call) => call.path.startsWith('/api/'));

/** Everything the page has written to its log, which is where a save narrates
    itself: what it sent, and what became of it. */
const logOf = (document) => document.element('#pn-log').textContent;

/** A publication report for a save that has already reached the site, which is
    what a test that is not about publication should be handed. */
const verifiedReport = (over = {}) => ({
    sha: 'commit-2',
    checkedAt: new Date(0).toISOString(),
    deployment: { state: 'completed', detail: 'The site serves what this commit holds.', build: null },
    files: [{
        path: 'news-engagement.html',
        url: 'https://wesamamer.com/news-engagement.html',
        kind: 'written',
        originState: 'current',
        publicState: 'current',
        cacheControl: 'max-age=600',
        age: '0',
    }],
    cache: { state: 'not-configured', detail: 'No Cloudflare zone is configured for this Worker.', urls: [] },
    behindCloudflare: false,
    verified: true,
    ...over,
});

/** A report for a commit GitHub has, and the site has not served yet. */
function startedReport(over = {}) {
    const report = verifiedReport();
    return {
        ...report,
        deployment: { state: 'started', detail: 'GitHub has the commit; the site is not serving it yet.', build: null },
        files: [{ ...report.files[0], originState: 'earlier', publicState: 'earlier' }],
        verified: false,
        ...over,
    };
}

test('the page loads, signs in, and reads the entries without an error', async (t) => {
    // The whole point of this one: import the page's module and let it run. A
    // reference to something that does not exist, or a step that throws on the way
    // up, shows here as a failure instead of in a browser.
    const { document, calls, restore } = await loadPage();
    t.after(restore);

    assert.match(statusOf(document), /Reading|Read|entries/i,
        `the page should get as far as reading the entries, not "${statusOf(document)}"`);
    assert.doesNotMatch(statusOf(document), /could not be read|is not defined|undefined is not/i,
        `the page reported a failure while loading: "${statusOf(document)}"`);
    assert.ok(apiCalls(calls).some((call) => call.path === '/api/verify'),
        'the page should ask the API who it is');
    assert.equal(document.element('#pn-session').dataset.state, 'in', 'a signed-in session should be shown');
});

test('publishing a save goes through exactly one commit', async (t) => {
    // The architectural promise: a save is one commit, never a file at a time. This
    // drives the page's real Save and publish button and counts what it sent.
    const { document, calls, restore } = await loadPage();
    t.after(restore);

    await press(document, { act: 'add' });
    await settle();
    await press(document, { act: 'save' });
    await settle();

    const commits = apiCalls(calls).filter((call) => call.path === '/api/commit');
    const singles = apiCalls(calls).filter((call) => call.path === '/api/write' || call.path === '/api/remove');

    assert.equal(commits.length, 1, `a save must be one commit, but ${commits.length} were sent`);
    assert.deepEqual(singles, [], 'a save must not write files one at a time');

    const { base, message, changes } = commits[0].body;
    assert.equal(base, 'head-1', 'the save must name the revision the panel read');
    assert.equal(typeof message, 'string');
    assert.ok(Array.isArray(changes) && changes.length, 'the commit must carry the changes');
    for (const change of changes) {
        assert.equal(typeof change.path, 'string');
        const shape = ['text', 'delete', 'contentBase64'].filter((key) => key in change);
        assert.equal(shape.length, 1, `${change.path} must be exactly one of text, delete or an upload`);
    }
    assert.ok(changes.some((change) => change.path === 'news-engagement.html'),
        'the news page should be in the commit');
    assert.match(statusOf(document), /published|saved|one commit/i,
        `the page should say the save went through, not "${statusOf(document)}"`);
});

test('checking the live site asks what the website serves, not just what GitHub holds', async (t) => {
    // The copy GitHub holds is not the page a reader gets: GitHub has to build
    // it, and a cache can hold the earlier page afterwards. A button that only
    // compared against GitHub would report the site caught up when it is not.
    const stale = verifiedReport({
        deployment: { state: 'started', detail: 'GitHub has the commit; the site is not serving it yet.', build: null },
        files: [{
            path: 'news-engagement.html',
            url: 'https://wesamamer.com/news-engagement.html',
            kind: 'written',
            originState: 'earlier',
            publicState: 'earlier',
        }],
        verified: false,
    });
    const { document, calls, restore } = await loadPage({ publication: stale });
    t.after(restore);

    await press(document, { act: 'check' });
    await settle();

    assert.ok(apiCalls(calls).some((call) => call.path === '/api/publication'),
        'the button must ask the Worker what the website serves');
    assert.match(statusOf(document), /not caught up|serving head-1/i,
        `the answer should describe the website, not just GitHub:\n${statusOf(document)}`);
});

test('a save is not called published until the site is serving it', async (t) => {
    // The commit is the first step, not the last. The panel has to follow the
    // save to the public site and say what it found, so that "published" never
    // means merely that GitHub accepted a write.
    const { document, calls, restore } = await loadPage({ publication: [startedReport(), verifiedReport()] });
    t.after(restore);

    await press(document, { act: 'add' });
    await settle();
    await press(document, { act: 'save' });

    const log = logOf(document);
    for (const step of ['Saved to GitHub', 'Deployment started', 'Deployment completed', 'Cache invalidation', 'Public website verified']) {
        assert.match(log, new RegExp(step), `the log should report "${step}", but it read:\n${log}`);
    }
    assert.ok(log.indexOf('Deployment started') < log.indexOf('Deployment completed'),
        'the steps should be reported in the order they happened');
    assert.ok(log.indexOf('Deployment completed') < log.indexOf('Public website verified'),
        'the site cannot be verified before the deployment completed');

    // A purge is asked for once, and only once the origin holds the new bytes:
    // a cache told to drop a URL before the build finishes fetches the old page
    // back into itself.
    const purges = apiCalls(calls).filter((call) => call.path === '/api/publication' && call.body && call.body.purge);
    assert.equal(purges.length, 1, `a save should ask for one purge, but asked ${purges.length} times`);
    assert.equal(purges[0].body.sha, 'commit-2', 'the purge should name the commit it follows');
});

test('a save whose publication cannot be followed does not claim the site was verified', async (t) => {
    const { document, restore } = await loadPage({ publicationFails: true });
    t.after(restore);

    await press(document, { act: 'add' });
    await settle();
    await press(document, { act: 'save' });

    const log = logOf(document);
    assert.match(log, /Saved to GitHub/, 'the commit still happened, and is still reported');
    assert.match(log, /Could not follow the publication|Not verified/, `the log should say the follow-up failed:\n${log}`);
    assert.doesNotMatch(log, /Public website verified/,
        'the panel must not say the site was verified when it could not be checked');
});

test('an editor waiting for approval can read the panel but cannot publish', async (t) => {
    // The registry decides, and the panel obeys. A pending account must be told
    // which state it is in, and must not reach the commit at all.
    const { document, calls, restore } = await loadPage({ verifyStatus: 'pending' });
    t.after(restore);

    await press(document, { act: 'save' });
    await settle();

    assert.match(logOf(document), /waiting to be approved/, `the panel should explain the state:\n${logOf(document)}`);
    assert.deepEqual(apiCalls(calls).filter((call) => call.path === '/api/commit'), [],
        'a pending account must publish nothing');
});

test('a suspended editor is refused differently from one waiting to be approved', async (t) => {
    const { document, calls, restore } = await loadPage({ verifyStatus: 'suspended' });
    t.after(restore);

    await press(document, { act: 'save' });
    await settle();

    assert.match(logOf(document), /suspended/, `the panel should name the state:\n${logOf(document)}`);
    assert.doesNotMatch(logOf(document), /waiting to be approved/,
        'a suspension is a decision already taken, not an approval that is pending');
    assert.deepEqual(apiCalls(calls).filter((call) => call.path === '/api/commit'), [],
        'a suspended account must publish nothing');
});

test('the owner sees each editor, and only the actions its state allows', async (t) => {
    // The buttons are the policy made visible: a pending account can be let in,
    // an active one paused, a suspended one restored — and the owner record
    // offers nothing, because the Worker protects it as well as this page does.
    const owner = 'owner@example.com';
    const waiting = 'waiting@example.com';
    const working = 'working@example.com';
    const paused = 'paused@example.com';
    const editors = [
        { email: owner, name: 'Owner', role: 'owner', status: 'active' },
        { email: waiting, name: 'Waiting', role: 'news-editor', status: 'pending' },
        { email: working, name: 'Working', role: 'news-editor', status: 'active' },
        { email: paused, name: 'Paused', role: 'news-editor', status: 'suspended' },
    ];
    const { document, calls, restore } = await loadPage({ editors });
    t.after(restore);

    await press(document, { act: 'refresh-editors' });
    await settle();

    assert.ok(apiCalls(calls).some((call) => call.path === '/api/admin/editors'),
        'the owner’s panel reads the editor list');
    const html = document.element('#pn-editors-list').innerHTML;
    for (const editor of editors) assert.match(html, new RegExp(editor.email), `${editor.email} should be listed`);

    const offers = (act, email) => html.includes(`data-act="${act}" data-email="${email}"`);
    assert.equal(offers('activate-editor', waiting), true, 'a pending account can be let in');
    assert.equal(offers('suspend-editor', waiting), false, 'a pending account has nothing to suspend yet');
    assert.equal(offers('suspend-editor', working), true, 'an active account can be paused');
    assert.equal(offers('reactivate-editor', paused), true, 'a suspended account can be restored');
    assert.equal(offers('remove-editor', waiting), true, 'anyone but the owner can be removed');
    for (const act of ['activate-editor', 'suspend-editor', 'reactivate-editor', 'remove-editor']) {
        assert.equal(offers(act, owner), false, `the owner record must not offer ${act}`);
    }
});

test('an editor who is not the owner is not offered editor management', async (t) => {
    const { document, calls, restore } = await loadPage({
        role: 'news-editor',
        editors: [{ email: 'owner@example.com', role: 'owner', status: 'active' }],
    });
    t.after(restore);

    // Ask for the list, then fill in the form and submit it. Neither may reach
    // the registry: the page and the Worker must agree about who may change
    // editors, and the page must not rely on the Worker to refuse.
    await press(document, { act: 'refresh-editors' });
    await settle();
    document.element('#pn-editor-name').value = 'Nour';
    document.element('#pn-editor-email').value = 'nour@example.com';
    await press(document, { act: 'add-editor' });
    await settle();

    assert.deepEqual(
        apiCalls(calls).filter((call) => call.path === '/api/admin/editors'),
        [],
        'a non-owner must neither read nor change the editor registry',
    );
});

test('adding an editor sends the name and email the owner typed, and starts them pending', async (t) => {
    const { document, calls, restore } = await loadPage({ editors: [] });
    t.after(restore);

    document.element('#pn-editor-name').value = '  Nour  ';
    document.element('#pn-editor-email').value = '  Nour@Example.com  ';
    await press(document, { act: 'add-editor' });
    await settle();

    const posted = apiCalls(calls).find((call) => call.path === '/api/admin/editors' && call.body);
    assert.ok(posted, 'adding an editor should reach the registry');
    assert.deepEqual(posted.body, {
        name: 'Nour',
        email: 'nour@example.com',
        role: 'news-editor',
        status: 'pending',
    }, 'the name and email are trimmed, the email is lowercased, and a new editor waits for approval');
});

test('activating an editor sends the change for that editor only', async (t) => {
    const waiting = 'waiting@example.com';
    const { document, calls, restore } = await loadPage({
        editors: [{ email: waiting, name: 'Waiting', role: 'news-editor', status: 'pending' }],
    });
    t.after(restore);

    await press(document, { act: 'refresh-editors' });
    await settle();
    await press(document, { act: 'activate-editor', email: waiting });
    await settle();

    const patched = apiCalls(calls).find((call) => call.path === `/api/admin/editors/${encodeURIComponent(waiting)}` && call.body);
    assert.ok(patched, 'activating should reach the registry');
    assert.deepEqual(patched.body, { status: 'active' }, 'only the status changes, and only for the editor named');
});

test('deleting an entry removes its card and its page in the same commit', async (t) => {
    const { document, calls, restore } = await loadPage();
    t.after(restore);

    await press(document, { select: '0' });
    await settle();
    await press(document, { act: 'delete' });
    await settle();
    await press(document, { act: 'save' });
    await settle();

    const commit = apiCalls(calls).find((call) => call.path === '/api/commit');
    assert.ok(commit, 'a deletion is published as a commit');
    const changes = commit.body.changes;
    const paths = changes.map((change) => change.path);

    const news = changes.find((change) => change.path === 'news-engagement.html');
    assert.ok(news, 'the card is removed from the news page');
    assert.doesNotMatch(news.text, /href="engagement-neu-international-conference\.html"/,
        'the deleted entry must no longer be named anywhere on the news page');

    // The entry's own page goes, and so do the photographs only it used — all in
    // the same commit, so a photograph never leaves before the page naming it.
    const deletions = changes.filter((change) => 'delete' in change).map((change) => change.path);
    assert.deepEqual(deletions.filter((path) => !path.startsWith('images/')),
        ['engagement-neu-international-conference.html'],
        `the entry's own page should be deleted; deletions were ${JSON.stringify(deletions)}`);

    assert.ok(paths.includes('.panel-state.json'), 'the deletion is recorded where the guard reads it');
    const marker = changes.find((change) => change.path === '.panel-state.json');
    assert.match(marker.text, /engagement-neu-international-conference\.html/,
        'the state file records which page was deleted');
});

test('a save the API refuses keeps the draft and offers a way out', async (t) => {
    // The conflict path, which is the one moment the panel has to be careful: the
    // site moved, the Worker wrote nothing, and the answer is not to lose the work.
    const refuse = (json) => json({ error: 'The site moved on while this panel was open, so it is still here.' }, 409);
    const { document, calls, clipboard, restore } = await loadPage({ commit: refuse });
    t.after(restore);

    await press(document, { act: 'add' });
    await settle();
    await press(document, { act: 'save' });
    await settle();

    if (!apiCalls(calls).some((call) => call.path === '/api/commit')) {
        assert.fail(`the save should have been attempted and refused, but the page said: "${statusOf(document)}"`);
    }

    const banner = document.element('#pn-conflict').innerHTML;
    assert.match(banner, /still here|moved on/i, 'the conflict must be explained');
    assert.match(banner, /copy my work/i, 'the draft must be offered a way to be kept');
    assert.match(banner, /load the site/i, 'the site&rsquo;s version must be loadable');

    await press(document, { act: 'copy-draft' });
    await settle();
    assert.ok(clipboard.length, 'copying the draft should put something on the clipboard');
    const held = JSON.parse(clipboard[0]);
    assert.ok(Array.isArray(held.added), 'the copy should hold the entries that were added');
});

test('a photograph travels inside the same commit as the page that shows it', async (t) => {
    // The path that first exposed how little of this page was covered: choosing a
    // photograph, readying its bytes, and putting it in the commit. Reading the
    // bytes goes through a helper the page has to import, and when it forgot to,
    // only a real upload noticed.
    const { document, calls, restore } = await loadPage();
    t.after(restore);

    await press(document, { act: 'add' });
    await settle();
    await choose(document, 0, fakePhoto('talk-01-20261016.jpeg', [1, 2, 3]));
    await settle();
    assert.match(statusOf(document), /photograph ready/i,
        `the page should accept the photograph, but it said: "${statusOf(document)}"`);

    await press(document, { act: 'save' });
    await settle();

    const commits = apiCalls(calls).filter((call) => call.path === '/api/commit');
    assert.equal(commits.length, 1, 'the photograph and the page must be one commit');

    const { changes } = commits[0].body;
    const image = changes.find((change) => change.path.startsWith('images/'));
    assert.ok(image, `the commit should carry the photograph, but held ${changes.map((c) => c.path).join(', ')}`);
    assert.match(image.path, /^images\/[\w-]+-\d{8}\.jpeg$/, 'the photograph gets a dated path the API accepts');
    assert.equal(image.contentBase64, 'AQID', 'the photograph&rsquo;s own bytes should be sent, encoded');
    assert.ok(changes.some((change) => change.path === 'news-engagement.html'), 'and the page that shows it');
});

test('replacing a photograph dates the name it already had, and adds no second date', async (t) => {
    // An upload is dated so a replacement never lands on the file the site is
    // already serving. That date has to replace the one already on the name.
    // `london-01` collected three of them across three saves before the name was
    // stripped back, and a name only grows until it no longer fits the length the
    // API allows — at which point the save is refused outright.
    const { document, calls, restore } = await loadPage();
    t.after(restore);

    // The entry the site shows first carries the photograph that grew: opening it
    // is how the page comes to know the name the replacement replaces.
    await press(document, { select: '0' });
    await settle();
    await choose(document, 0, fakePhoto('london-01.jpeg', [9, 9, 9]));
    await settle();

    await press(document, { act: 'save' });
    await settle();

    const commits = apiCalls(calls).filter((call) => call.path === '/api/commit');
    assert.equal(commits.length, 1, 'the replacement and the page are one commit');

    const image = commits[0].body.changes.find((change) => change.path.startsWith('images/'));
    assert.ok(image, 'the replacement photograph should be in the commit');

    const withoutTodays = image.path.replace(/^images\//, '').replace(/\.[a-z0-9]+$/i, '').replace(/-\d{8}$/, '');
    assert.doesNotMatch(withoutTodays, /-\d{8}/,
        `the name should carry one date, but a save has added another: ${image.path}`);
    assert.match(image.path, /^images\/london-01-\d{8}\.jpeg$/,
        `the name should be the one the entry already used, dated: ${image.path}`);
});

test('every element the page reaches for by name exists in the page', () => {
    // The stand-in hands back an element for any selector, so a misspelt id would
    // otherwise pass unnoticed. The markup is the authority: check it directly.
    const ids = new Set([...PAGE.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
    const reached = new Set([...GLUE.matchAll(/\$\('#([\w-]+)'/g)].map((match) => match[1]));
    const missing = [...reached].filter((id) => !ids.has(id));
    assert.deepEqual(missing, [], `the page reaches for ${missing.join(', ')}, which the page does not have`);
});

test('every button in the page is handled, and every handler has a button', () => {
    // A button whose action nothing answers is a dead control; an action with no
    // button is a handler nobody can reach. Both are silent in a browser.
    const inPage = new Set([...PAGE.matchAll(/data-act="([\w-]+)"/g)].map((match) => match[1]));
    const handled = new Set([...GLUE.matchAll(/act === '([\w-]+)'/g)].map((match) => match[1]));

    const dead = [...inPage].filter((act) => !handled.has(act) && !GLUE.includes(`data-act=\\"${act}\\"`));
    assert.deepEqual(dead, [], `nothing answers the button(s): ${dead.join(', ')}`);

    const unreachable = [...handled].filter((act) => !inPage.has(act) && !GLUE.includes(`data-act="${act}"`) && !GLUE.includes(`data-act=\\"${act}\\"`));
    assert.deepEqual(unreachable, [], `these handlers can never be reached: ${unreachable.join(', ')}`);
});
