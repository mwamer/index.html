/* Tests for the parts of a deletion a test can hold still: which file an entry
   owns, what the published state file says afterwards, which photographs can go,
   the order a save runs in, and what Undo refuses to do.

   The panel itself is a page, so these drive the exported logic directly rather
   than a browser. Run with: node --test admin/
*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
    parseNewsPage, parseCard, recordPathFor, recordPageTarget, recordPageTargetForCard,
    isRecordPagePath, mergeState, serializeState, sha256Hex, imagesToRemove,
    saveChanges, undoPlan, undoRefusal, STATE_PATH, NEWS_PATH,
} from './panel.js';
import { sha256Hex as guardSha256Hex } from '../tools/content-guard.mjs';

/** A card in the shape the news page uses, through the real parser. */
function card({ slug = '', role = 'Invited Speaker', date = '10 October 2026' } = {}) {
    const link = slug ? `<a class="news-card__link" href="${slug}.html">${role}</a>` : role;
    return parseCard([
        '            <li class="news-card" data-category="conferences-events" data-tag="Conference">',
        `              <p class="news-card__meta"><span class="news-card__date">${date}</span> &middot; <span class="news-card__cat">Conferences</span></p>`,
        `              <h3 class="news-card__title">${link}</h3>`,
        '              <p class="news-card__place">Cambridge</p>',
        '            </li>',
    ].join('\n'), 0);
}

// ── 1. which record page an entry owns ───────────────────────────────────

test('a card that links to its own page resolves to that page', () => {
    const target = recordPageTargetForCard(card({ slug: 'engagement-hypermedia-warfare' }));
    assert.equal(target.path, 'engagement-hypermedia-warfare.html');
    assert.equal(target.reason, '');
});

test('a card with no link owns no page, and says so', () => {
    const target = recordPageTargetForCard(card({ slug: '' }));
    assert.equal(target.path, '');
    assert.match(target.reason, /no full record page/);
});

test('a card that links somewhere the panel does not write keeps its page', () => {
    // The card points at a page outside the pattern the Worker writes. Deleting
    // the derived path would remove a file nobody linked to, so nothing is
    // deleted and the reason names the link.
    const target = recordPageTarget({ recordSlug: 'old-news', href: 'old-news.html' });
    assert.equal(target.path, '');
    assert.match(target.reason, /links to old-news\.html/);
    assert.match(target.reason, /engagement-old-news\.html/);
});

test('an empty short name has no record page', () => {
    assert.equal(recordPathFor(''), '');
    assert.equal(recordPathFor('   '), '');
    assert.equal(recordPageTarget({}).path, '');
});

test('a short name is turned into the address the Worker writes', () => {
    assert.equal(recordPathFor('hypermedia-warfare'), 'engagement-hypermedia-warfare.html');
    assert.equal(recordPathFor('Hypermedia Warfare'), 'engagement-hypermedia-warfare.html');
});

test('a short name that already carries the prefix is not prefixed twice', () => {
    assert.equal(recordPathFor('engagement-ica-2026'), 'engagement-ica-2026.html');
});

test('paths the Worker would refuse are rejected', () => {
    for (const bad of ['', '.html', 'foo.html', 'engagement-.html', 'engagement-x.htm',
        'engagement-x.html.bak', 'news-engagement.html',
        `engagement-${'a'.repeat(82)}.html`, 'engagement-Upper.html']) {
        assert.equal(isRecordPagePath(bad), false, `${bad} should be refused`);
    }
    assert.equal(isRecordPagePath('engagement-ica-2026.html'), true);
    // The pattern allows 1 + up to 80 characters after the prefix.
    assert.equal(isRecordPagePath(`engagement-${'a'.repeat(81)}.html`), true);
    assert.equal(isRecordPagePath('engagement-a.html'), true);
});

test('a path the Worker refuses is never used as a deletion target', () => {
    // Even a short name that sanitises into something long stays inside the
    // pattern's bound, so recordPathFor always returns a writable path or none.
    const path = recordPathFor('x'.repeat(400));
    assert.ok(path === '' || isRecordPagePath(path), `unexpected target ${path}`);
});

// ── 2. the published state file ──────────────────────────────────────────

const previousState = {
    version: 1,
    updated: '2026-10-01T00:00:00.000Z',
    files: {
        'news-engagement.html': 'aaa',
        'engagement-older.html': 'bbb',
        'engagement-gone.html': 'ccc',
    },
    deleted: [{ path: 'engagement-earlier.html', at: '2026-09-01T00:00:00.000Z' }],
};

test('a deletion records a tombstone and drops the page from what is published', () => {
    const next = mergeState(previousState, {
        at: '2026-10-16T00:00:00.000Z',
        published: { 'news-engagement.html': 'ddd' },
        deleted: [{ path: 'engagement-gone.html', at: '2026-10-16T00:00:00.000Z' }],
    });
    assert.equal(next.files['engagement-gone.html'], undefined);
    assert.equal(next.files['news-engagement.html'], 'ddd');
    assert.deepEqual(next.deleted.map((item) => item.path),
        ['engagement-earlier.html', 'engagement-gone.html']);
    assert.equal(next.updated, '2026-10-16T00:00:00.000Z');
});

test('everything already recorded is kept', () => {
    const next = mergeState(previousState, {
        at: '2026-10-16T00:00:00.000Z',
        published: { 'engagement-new.html': 'eee' },
    });
    assert.equal(next.files['engagement-older.html'], 'bbb');
    assert.equal(next.files['engagement-gone.html'], 'ccc');
    assert.equal(next.files['engagement-new.html'], 'eee');
    assert.deepEqual(next.deleted, previousState.deleted);
});

test('deleting the same page again keeps the first time it happened', () => {
    const first = mergeState(previousState, {
        at: '2026-10-02T00:00:00.000Z',
        deleted: [{ path: 'engagement-gone.html', at: '2026-10-02T00:00:00.000Z' }],
    });
    const again = mergeState(first, {
        at: '2026-10-03T00:00:00.000Z',
        deleted: [{ path: 'engagement-gone.html', at: '2026-10-03T00:00:00.000Z' }],
    });
    assert.equal(again.deleted.length, 2);
    assert.equal(again.deleted.find((item) => item.path === 'engagement-gone.html').at, '2026-10-02T00:00:00.000Z');
});

test('a tombstone already in the file is not moved by a later save', () => {
    const existing = {
        version: 1, updated: '2026-10-01T00:00:00.000Z', files: {},
        deleted: [{ path: 'engagement-earlier.html', at: '2026-09-01T00:00:00.000Z' }],
    };
    const next = mergeState(existing, {
        at: '2026-10-16T00:00:00.000Z',
        deleted: [{ path: 'engagement-earlier.html', at: '2026-10-16T00:00:00.000Z' }],
    });
    assert.equal(next.deleted[0].at, '2026-09-01T00:00:00.000Z');
});

test('removing a card with no record page still records the news page', () => {
    // The blank card at the end of the archive owns no page, so the state gains a
    // digest for the news page and no tombstone at all.
    const next = mergeState(previousState, {
        at: '2026-10-16T00:00:00.000Z',
        published: { 'news-engagement.html': 'fff' },
        deleted: [],
    });
    assert.equal(next.files['news-engagement.html'], 'fff');
    assert.equal(next.deleted.length, previousState.deleted.length);
    assert.equal(next.deleted.some((item) => item.path === ''), false);
});

test('a first save with no state file yet starts a clean one', () => {
    const next = mergeState(null, { at: '2026-10-16T00:00:00.000Z', published: { [NEWS_PATH]: 'x' } });
    assert.deepEqual(next, {
        version: 1,
        updated: '2026-10-16T00:00:00.000Z',
        files: { [NEWS_PATH]: 'x' },
        deleted: [],
    });
});

test('the file is written in the shape tools/content-state.mjs uses', () => {
    const state = mergeState(previousState, { at: '2026-10-16T00:00:00.000Z' });
    const text = serializeState(state);
    assert.equal(text.endsWith('\n'), true);
    assert.equal(text, `${JSON.stringify(state, null, 4)}\n`);
    assert.deepEqual(Object.keys(state), ['version', 'updated', 'files', 'deleted']);
    // Round-trips through JSON, which is all the guard needs of it.
    assert.deepEqual(JSON.parse(text).deleted, state.deleted);
});

test('the digest recorded matches the digest the guard takes', async () => {
    const html = readFileSync(new URL('../news-engagement.html', import.meta.url));
    assert.equal(await sha256Hex(html.toString('utf8')), guardSha256Hex(html));
    assert.equal(await sha256Hex(''), createHash('sha256').update(Buffer.from('')).digest('hex'));
    assert.equal(await sha256Hex('café — 1'), createHash('sha256').update(Buffer.from('café — 1', 'utf8')).digest('hex'));
});

test('a page with no way to take a digest is refused, not recorded blind', async () => {
    await assert.rejects(() => sha256Hex('x', null), /cannot work out a page digest/);
});

test('the path the panel records is the one the guard reads', () => {
    assert.equal(STATE_PATH, '.panel-state.json');
});

// ── 3. photographs ───────────────────────────────────────────────────────

const DATED = 'images/engagement-ica-2026-07-20261015.jpeg';
const SHARED = 'images/engagement-ica-2026-06-20261015.jpeg';
const UNDATED = 'images/wesam-amer-portrait.jpeg';

test('a photograph no page names any more can go', () => {
    const verdict = imagesToRemove({
        candidates: [DATED],
        pages: [{ path: NEWS_PATH, html: '<p>nothing here</p>' },
            { path: 'engagement-other.html', html: '<p>nor here</p>' }],
    });
    assert.deepEqual(verdict.remove, [DATED]);
    assert.equal(verdict.decisions[0].reason, 'no page uses it any more');
});

test('a photograph the news page still names is kept', () => {
    const verdict = imagesToRemove({
        candidates: [DATED],
        pages: [{ path: NEWS_PATH, html: `<img src="${DATED}">` }],
    });
    assert.deepEqual(verdict.remove, []);
    assert.match(verdict.keep[0].reason, /still used by news-engagement\.html/);
});

test('a photograph the featured panel names is kept', () => {
    // The featured panel is part of the news page, and it shows the same file.
    const verdict = imagesToRemove({
        candidates: [DATED],
        pages: [{ path: NEWS_PATH, html: `<div class="news-featured__media"><img src="${DATED}" alt=""></div>` }],
    });
    assert.deepEqual(verdict.remove, []);
});

test('a photograph another record page still names is kept', () => {
    const verdict = imagesToRemove({
        candidates: [SHARED],
        pages: [{ path: NEWS_PATH, html: '' },
            { path: 'engagement-other.html', html: `<img src="${SHARED}">` }],
    });
    assert.deepEqual(verdict.remove, []);
    assert.match(verdict.keep[0].reason, /still used by engagement-other\.html/);
});

test('an unread page leaves every candidate in place', () => {
    const verdict = imagesToRemove({
        candidates: [DATED],
        pages: [{ path: NEWS_PATH, html: '' }],
        unreadable: ['about.html'],
    });
    assert.deepEqual(verdict.remove, []);
    assert.match(verdict.keep[0].reason, /could not be checked against about\.html/);
});

test('a photograph the API cannot remove is reported and left alone', () => {
    const verdict = imagesToRemove({ candidates: [UNDATED], pages: [] });
    assert.deepEqual(verdict.remove, []);
    assert.match(verdict.keep[0].reason, /only removes photographs it named itself/);
});

test('every candidate is accounted for, once', () => {
    const verdict = imagesToRemove({
        candidates: [DATED, DATED, SHARED, UNDATED],
        pages: [{ path: NEWS_PATH, html: `<img src="${SHARED}">` }],
    });
    assert.equal(verdict.decisions.length, 3);
    assert.deepEqual([...verdict.decisions].map((item) => item.path).sort(), [DATED, SHARED, UNDATED].sort());
    assert.deepEqual(verdict.remove, [DATED]);
});

// ── 4. what one save changes ─────────────────────────────────────────────

const RECORD = 'engagement-ica-2026.html';

test('a save that changes pages and adds a photograph is one list of changes', () => {
    const batch = saveChanges({
        news: { path: NEWS_PATH, text: '<html>news</html>' },
        records: [{ path: RECORD, text: '<html>record</html>' }],
        uploads: [{ path: 'images/wesam-20261016.jpeg', contentBase64: 'AAAA' }],
        state: { text: '{"version":1}' },
    });
    assert.deepEqual(batch.changes.map((change) => change.path).sort(), [
        STATE_PATH, NEWS_PATH, RECORD, 'images/wesam-20261016.jpeg',
    ].sort());
    assert.equal(batch.deleted.length, 0);
});

test('every change carries the one thing the API needs to write it', () => {
    const batch = saveChanges({
        news: { path: NEWS_PATH, text: '<html>news</html>' },
        uploads: [{ path: 'images/wesam-20261016.jpeg', contentBase64: 'AAAA' }],
        deletions: [RECORD],
    });
    const byPath = new Map(batch.changes.map((change) => [change.path, change]));
    assert.equal(byPath.get(NEWS_PATH).text, '<html>news</html>');
    assert.equal(byPath.get('images/wesam-20261016.jpeg').contentBase64, 'AAAA');
    assert.equal(byPath.get(RECORD).delete, true);
});

test('the entries are sorted by path so one save always describes itself the same way', () => {
    const batch = saveChanges({
        news: { path: NEWS_PATH, text: 'n' },
        records: [{ path: 'engagement-zzz.html', text: 'z' }, { path: 'engagement-aaa.html', text: 'a' }],
        uploads: [{ path: 'images/wesam-20261016.jpeg', contentBase64: 'x' }],
        state: { text: 's' },
        deletions: ['engagement-mmm.html'],
    });
    const paths = batch.changes.map((change) => change.path);
    assert.deepEqual(paths, [...paths].sort());
});

test('a save says what it wrote and what it deleted', () => {
    const batch = saveChanges({
        news: { path: NEWS_PATH, text: 'n' },
        records: [{ path: RECORD, text: 'r' }],
        state: { text: 's' },
        deletions: ['engagement-gone.html', 'images/wesam-20260101.jpeg'],
    });
    assert.deepEqual(batch.deleted, ['engagement-gone.html', 'images/wesam-20260101.jpeg']);
    assert.equal(batch.written.includes(RECORD), true);
    assert.equal(batch.written.includes('engagement-gone.html'), false, 'a deleted path is not written');
});

test('a deletion with no valid record page changes no page but the news one', () => {
    // The blank card: it leaves the news page, and no file is deleted.
    const batch = saveChanges({ news: { path: NEWS_PATH, text: 'n' }, state: { text: 's' }, deletions: [] });
    assert.deepEqual(batch.deleted, []);
    assert.deepEqual(batch.changes.map((change) => change.path).sort(), [NEWS_PATH, STATE_PATH].sort());
});

test('a path is deleted once even when it is offered twice', () => {
    const batch = saveChanges({ deletions: [RECORD, RECORD] });
    assert.deepEqual(batch.deleted, [RECORD]);
    assert.equal(batch.changes.filter((change) => change.path === RECORD).length, 1);
});

test('a save with nothing in it produces nothing to send', () => {
    const batch = saveChanges({});
    assert.deepEqual(batch.changes, []);
    assert.equal(batch.message, 'Update the site from the panel');
});

test('the commit message says what happened, and stays short', () => {
    const batch = saveChanges({
        news: { path: NEWS_PATH, text: 'n' },
        records: [{ path: 'engagement-a.html', text: 'a' }, { path: 'engagement-b.html', text: 'b' }],
        deletions: ['engagement-c.html'],
    });
    assert.match(batch.message, /remove engagement-c\.html/i);
    assert.match(batch.message, /update engagement-a\.html, engagement-b\.html/i);
    assert.match(batch.message, /update the news entries/i);
    assert.ok(batch.message.length < 200, 'a commit subject has to stay readable');
});

test('the panel sends a whole save as one request', () => {
    // The save used to be a list of steps run one after another, which is what
    // made a half-published site possible. There is one call now, and this checks
    // the page still makes it rather than falling back to per-file writes.
    const source = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    assert.match(source, /api\.commit\(/, 'the page must send the save as one commit');
    assert.doesNotMatch(source, /saveSteps|runSaveSteps/, 'the step-by-step save must be gone');
});

test('the page asks for its modules by content, so a deploy cannot serve a stale one', () => {
    // The page fetches both modules with a ?v= stamp. If the stamp is not updated
    // when the file changes, a browser that already holds the old copy keeps using
    // it — and a panel with an old api-worker.js cannot save at all, because the
    // method it calls is not in it. Tying the stamp to the file's own digest makes
    // that impossible to forget: change the file without changing the stamp, and
    // this fails and says what the stamp should be.
    const source = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    const references = [...source.matchAll(/from '\.\/([\w.-]+\.js)\?v=([\w]+)'/g)];
    assert.ok(references.length >= 2, 'the page should version both of its modules');
    for (const [, file, stamp] of references) {
        const digest = createHash('sha256')
            .update(readFileSync(new URL(`./${file}`, import.meta.url)))
            .digest('hex').slice(0, 8);
        assert.equal(stamp, digest,
            `index.html asks for ${file}?v=${stamp}, but that file's content is ${digest}. Use ?v=${digest}.`);
    }
});

test('the page imports every function it calls from the modules', () => {
    // The page's own glue is not run by these tests — there is no DOM here — so a
    // function used but never imported would fail in the browser and nowhere else.
    // This reads the page the way the browser will: whatever it calls, it must
    // have brought in.
    const source = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    const script = source.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

    const exportedNames = (file) => [...readFileSync(new URL(file, import.meta.url), 'utf8')
        .matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)]
        .map((match) => match[1]);
    const exported = new Set([...exportedNames('./panel.js'), ...exportedNames('./api-worker.js')]);

    const imported = new Set();
    for (const clause of script.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
        for (const part of clause[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/).pop().trim();
            if (name) imported.add(name);
        }
    }

    const called = new Set([...script.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]));
    const missing = [...called].filter((name) => exported.has(name) && !imported.has(name));
    assert.deepEqual(missing, [], `the page calls ${missing.join(', ')} without importing it`);
});

// ── 5. undo ──────────────────────────────────────────────────────────────

test('a save that deleted a page cannot be undone', () => {
    const plan = undoPlan({
        at: '2026-10-16T00:00:00.000Z',
        commit: 'c0ffee',
        files: [{ path: NEWS_PATH, commit: 'c0ffee', created: false, previousSha: 'old' }],
        deletions: [RECORD],
    }, { [NEWS_PATH]: { sha: 'c0ffee', history: ['c0ffee', 'old'], text: 'before' } });
    assert.equal(plan.actions, undefined);
    assert.match(plan.refused, /engagement-ica-2026\.html/);
    assert.match(plan.refused, /cannot be put back by Undo/);
});

test('a save with no deletion can be tried, before the repository is read at all', () => {
    // Asked about a save with nothing deleted, and with nothing looked up yet:
    // an ordinary save must not be refused here, or undo would never run. The plan
    // itself does need the repository's answer, and refuses rather than guess.
    const saved = {
        commit: 'c0ffee',
        files: [{ path: NEWS_PATH, commit: 'c0ffee', created: false, previousSha: 'old' }],
        deletions: [],
    };
    assert.equal(undoRefusal(saved), '');
    assert.match(undoPlan(saved).refused, /has changed on GitHub/);
    assert.equal(undoRefusal({}), '');
    assert.equal(undoRefusal(null), '');
    assert.equal(undoRefusal({ files: [] }), '');
});

test('the deletion is refused before any file is looked at', () => {
    // The deleted page is missing from the repository — exactly the case that an
    // ordinary undo would treat as "gone, skip". The refusal comes first.
    const plan = undoPlan({
        commit: 'c0ffee',
        files: [{ path: RECORD, commit: 'c0ffee', created: false, previousSha: 'old' }],
        deletions: [RECORD],
    }, { [RECORD]: { missing: true } });
    assert.equal(plan.actions, undefined);
    assert.match(plan.refused, /cannot be put back by Undo/);
});

test('a save with no deletion still undoes, exactly as before', () => {
    const plan = undoPlan({
        commit: 'c0ffee',
        files: [
            { path: NEWS_PATH, commit: 'c0ffee', created: false, previousSha: 'old' },
            { path: 'images/new-20261016.jpeg', commit: 'c0ffee', created: true },
        ],
        deletions: [],
    }, {
        [NEWS_PATH]: { sha: 'c0ffee', history: ['c0ffee', 'old'], text: 'the page before' },
        'images/new-20261016.jpeg': { sha: 'c0ffee', history: ['c0ffee'] },
    });
    assert.equal(plan.refused, '');
    assert.deepEqual(plan.actions, [
        { path: NEWS_PATH, kind: 'restore', sha: 'c0ffee', text: 'the page before' },
        { path: 'images/new-20261016.jpeg', kind: 'remove', sha: 'c0ffee' },
    ]);
});

test('a file changed on GitHub after the save is not written over', () => {
    const plan = undoPlan({
        commit: 'c0ffee',
        files: [{ path: NEWS_PATH, commit: 'c0ffee', created: false }],
        deletions: [],
    }, { [NEWS_PATH]: { sha: 'newer', history: ['newer', 'c0ffee'] } });
    assert.equal(plan.actions, undefined);
    assert.match(plan.refused, /has changed on GitHub since that save/);
});

test('a file that is missing is skipped, as an ordinary undo always did', () => {
    const plan = undoPlan({
        commit: 'c0ffee',
        files: [{ path: 'engagement-vanished.html', commit: 'c0ffee', created: false }],
        deletions: [],
    }, { 'engagement-vanished.html': { missing: true } });
    assert.equal(plan.refused, '');
    assert.deepEqual(plan.actions, [{ path: 'engagement-vanished.html', kind: 'skip' }]);
});

test('a file the save created is only removed when it has no older history', () => {
    const saved = { commit: 'c0ffee', files: [{ path: 'engagement-new.html', commit: 'c0ffee', created: true }], deletions: [] };
    const safe = undoPlan(saved, { 'engagement-new.html': { sha: 'c0ffee', history: ['c0ffee'] } });
    assert.deepEqual(safe.actions, [{ path: 'engagement-new.html', kind: 'remove', sha: 'c0ffee' }]);

    const unsafe = undoPlan(saved, { 'engagement-new.html': { sha: 'c0ffee', history: ['c0ffee', 'older'] } });
    assert.equal(unsafe.actions, undefined);
    assert.match(unsafe.refused, /history from before that save/);
});

// ── 6. the state file and the news page together ─────────────────────────

test('a deletion through the real page parser resolves to the page it links to', () => {
    const page = parseNewsPage(readFileSync(new URL('../news-engagement.html', import.meta.url), 'utf8'));
    const linked = page.cards.filter((item) => item.recordSlug);
    assert.ok(linked.length > 0);
    for (const item of linked) {
        const target = recordPageTargetForCard(item);
        assert.equal(target.path, `${item.recordSlug}.html`, `card linking to ${item.recordSlug} resolved oddly`);
    }
    // The blank card at the end owns no page, so deleting it deletes no file.
    const blank = page.cards.filter((item) => !item.recordSlug);
    for (const item of blank) assert.equal(recordPageTargetForCard(item).path, '');
});
