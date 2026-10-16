/* The publishing flow, driven end to end on a throwaway repository.

   The unit tests check each part on its own. This file checks that the parts
   agree with each other, using the real guard and the real recording tool: the
   state file a panel save writes, what the guard makes of it, what happens when a
   stale clone merges a deleted page back, and what the documented route for a hand
   edit does.

   Nothing here touches the real repository or the live site. Each test builds its
   own repository in a temporary directory and removes it afterwards.

   Run with: node --test tools/ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { guard, sha256Hex, STATE_PATH } from './content-guard.mjs';
import { mergeState, serializeState } from '../admin/panel.js';

const NEWS = 'news-engagement.html';
const KEEP = 'engagement-keep.html';
const GONE = 'engagement-gone.html';
const STATE_TOOL = fileURLToPath(new URL('./content-state.mjs', import.meta.url));

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});

const commit = (dir, message) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD').trim();
};

const digest = (dir, path) => sha256Hex(readFileSync(join(dir, path)));

const newsPage = (slugs) => `<!DOCTYPE html>\n<html><body>\n${slugs.map((slug) => `    <li><a href="${slug}.html">${slug}</a></li>`).join('\n')}\n</body></html>\n`;

/** A repository with the same shape the panel publishes, taken through one
    deletion the way the panel does it now: as a single commit that holds the card
    leaving the news page, the state file recording the deletion, and the page
    itself being removed.

    There is deliberately no revision in between. A save used to be several
    commits, so a push could carry a revision where the card was already gone and
    the page was still there; one commit is what makes that impossible, and the
    tests below pin it down.

    The state file's `updated` has to move forward with each save — the guard reads
    a state older than the one before it as the site going backwards — so the clock
    here only ever advances. */
function publishedRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'publishing-flow-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'panel-test@example.test');
    git(dir, 'config', 'user.name', 'Panel test');
    git(dir, 'config', 'commit.gpgsign', 'false');

    // Fixed in the past, and only ever advancing: `tools/content-state.mjs` uses
    // the real clock, so anything it writes must be later than these.
    let clock = Date.parse('2020-01-01T09:00:00.000Z');
    const tick = () => new Date(clock += 60000).toISOString();

    mkdirSync(join(dir, 'images'), { recursive: true });
    writeFileSync(join(dir, 'images/keep-01-20261015.jpeg'), 'a photograph');
    writeFileSync(join(dir, 'images/gone-01-20261015.jpeg'), 'another photograph');
    writeFileSync(join(dir, NEWS), newsPage(['engagement-keep', 'engagement-gone']));
    writeFileSync(join(dir, KEEP), `<html><body><img src="images/keep-01-20261015.jpeg"></body></html>\n`);
    writeFileSync(join(dir, GONE), `<html><body><img src="images/gone-01-20261015.jpeg"></body></html>\n`);
    const initial = commit(dir, 'the site as it was');

    // The panel's first save, recording what it published.
    const first = mergeState(null, {
        at: tick(),
        published: { [NEWS]: digest(dir, NEWS), [KEEP]: digest(dir, KEEP), [GONE]: digest(dir, GONE) },
    });
    writeFileSync(join(dir, STATE_PATH), serializeState(first));
    const published = commit(dir, 'Record what the panel published');

    // The save that deletes the entry. One commit: the news page without the card,
    // the state file with the tombstone, and the page gone.
    writeFileSync(join(dir, NEWS), newsPage(['engagement-keep']));
    const deletedAt = tick();
    const second = mergeState(first, {
        at: deletedAt,
        published: { [NEWS]: digest(dir, NEWS) },
        deleted: [{ path: GONE, at: deletedAt }],
    });
    writeFileSync(join(dir, STATE_PATH), serializeState(second));
    rmSync(join(dir, GONE));
    const deleted = commit(dir, 'Remove engagement-gone from the panel');

    return { dir, initial, published, deleted };
}

/** Run a test against its own repository, and take it away afterwards. */
function withRepo(check) {
    const world = publishedRepo();
    try {
        check(world);
    } finally {
        rmSync(world.dir, { recursive: true, force: true });
    }
}

test('a deletion the panel publishes matches the state it recorded', () => withRepo((world) => {
    const result = guard({ base: world.published, head: world.deleted, dir: world.dir });
    assert.deepEqual(result.findings.failures, []);
    assert.deepEqual(result.findings.warnings, []);
    assert.equal(result.changedFiles.includes(GONE), true);
}));

test('the state the panel leaves behind says the page is gone, not published', () => withRepo((world) => {
    const state = JSON.parse(git(world.dir, 'show', `${world.deleted}:${STATE_PATH}`));
    assert.equal(state.files[GONE], undefined, 'a deleted page is not listed as published');
    assert.deepEqual(state.deleted, [{ path: GONE, at: state.deleted[0].at }]);
    assert.equal(typeof state.files[NEWS], 'string', 'the news page is recorded as published');
}));

test('a save that deletes an entry is one commit, so the site is never half-changed', () => withRepo((world) => {
    // What the panel writes when an entry is deleted. It used to be three commits —
    // the card, then the state, then the page — so a push could carry a revision
    // where the card was gone and the page it pointed at was still there, and the
    // guard would fail the build for a state the panel had passed through.
    const changed = git(world.dir, 'show', '--name-status', '--format=', world.deleted)
        .trim().split('\n').map((row) => row.split('\t'));
    const status = new Map(changed.map(([code, path]) => [path, code]));
    assert.equal(status.get(NEWS), 'M', 'the news page loses the card');
    assert.equal(status.get(STATE_PATH), 'M', 'the state records the deletion');
    assert.equal(status.get(GONE), 'D', 'the page itself goes');
    assert.equal(changed.length, 3, 'and nothing else moves');

    // The revision before it still holds both, so every revision the branch ever
    // points at is self-consistent.
    const before = `${world.deleted}^`;
    assert.match(git(world.dir, 'show', `${before}:${NEWS}`), /engagement-gone/);
    assert.match(git(world.dir, 'show', `${before}:${GONE}`), /img/);
    assert.equal(git(world.dir, 'show', `${world.deleted}:${NEWS}`).includes('engagement-gone'), false);
}));

test('the guard reads the state at the revision it is given, not the checkout', () => withRepo((world) => {
    // The pre-push hook runs with whatever happens to be checked out, and it used
    // to read the state from there. Left on the first commit, the guard still has
    // to judge the save it was asked about — which is the revision whose state
    // carries the tombstone.
    git(world.dir, 'checkout', '-q', world.initial);
    const result = guard({ base: world.published, head: world.deleted, dir: world.dir });
    assert.deepEqual(result.findings.failures, []);
    assert.equal(result.changedFiles.includes(GONE), true);
    assert.equal(git(world.dir, 'rev-parse', 'HEAD').trim(), world.initial, 'the guard must not move the checkout');
}));

test('a stale clone that merges a deleted page back fails, and is told how to fix it', () => withRepo((world) => {
    // A clone that is behind, with a local edit to the page that was deleted. The
    // merge resolves modify/delete by keeping the local file, which is exactly how
    // a deleted article comes back without anyone meaning it to.
    git(world.dir, 'checkout', '-q', '-b', 'stale', world.published);
    writeFileSync(join(world.dir, GONE), '<html><body>an older copy, with a local edit</body></html>\n');
    commit(world.dir, 'a local edit on an old checkout');

    git(world.dir, 'checkout', '-q', 'main');
    assert.throws(() => git(world.dir, 'merge', '-q', '--no-edit', 'stale'), 'the merge should conflict');
    git(world.dir, 'add', GONE);
    git(world.dir, 'commit', '-q', '-m', 'merge an old checkout');
    const head = git(world.dir, 'rev-parse', 'HEAD').trim();

    const result = guard({ base: world.deleted, head, dir: world.dir });
    assert.equal(result.findings.failures.length, 1);
    assert.equal(result.findings.failures[0].code, 'restores-deleted');
    assert.equal(result.findings.failures[0].path, GONE);
    assert.match(result.findings.failures[0].message, /Pull the newest main/);
    // The guard reports. It never rewrites the repository.
    assert.equal(git(world.dir, 'cat-file', 'blob', `HEAD:${GONE}`).includes('local edit'), true);
}));

test('the recorded route refuses to publish a page that was deleted', () => withRepo((world) => {
    // The same stale copy, put back in the working tree and staged rather than
    // merged, which is what a stale clone looks like when it is about to commit.
    // The tool that records a hand edit refuses it, and says how to mean it.
    writeFileSync(join(world.dir, GONE), '<html><body>back on disk by accident</body></html>\n');
    git(world.dir, 'add', GONE);
    assert.throws(
        () => execFileSync('node', [STATE_TOOL], { cwd: world.dir, encoding: 'utf8', stdio: 'pipe' }),
        (error) => {
            assert.match(String(error.stderr), /was deleted on/);
            assert.match(String(error.stderr), /--revive/);
            return true;
        },
    );
    // Nothing was recorded: the page is still a tombstone and the state is as it was.
    const state = JSON.parse(readFileSync(join(world.dir, STATE_PATH), 'utf8'));
    assert.equal(state.files[GONE], undefined);
    assert.equal(state.deleted.some((item) => item.path === GONE), true);
}));

test('a hand edit recorded the documented way keeps its content and passes', () => withRepo((world) => {
    // A deliberate edit by hand. On its own the guard objects, because the panel
    // never published this version; recording it is what makes it legitimate, and
    // the edit itself is untouched.
    const edited = '<html><body><p>a sentence added by hand</p></body></html>\n';
    writeFileSync(join(world.dir, KEEP), edited);
    const handCommit = commit(world.dir, 'Hand edit to a record page');

    const before = guard({ base: world.deleted, head: handCommit, dir: world.dir });
    assert.deepEqual(before.findings.failures.map((item) => item.code), ['unrecorded-change']);
    assert.equal(before.findings.failures[0].path, KEEP);

    execFileSync('node', [STATE_TOOL], { cwd: world.dir, encoding: 'utf8', stdio: 'pipe' });
    const recorded = commit(world.dir, 'Record the published state');
    const after = guard({ base: handCommit, head: recorded, dir: world.dir });
    assert.deepEqual(after.findings.failures, []);

    // The edit survived, and the deletion is still a deletion.
    assert.equal(readFileSync(join(world.dir, KEEP), 'utf8'), edited);
    assert.equal(readFileSync(join(world.dir, '.panel-state.json'), 'utf8').includes(GONE), true);
}));
