#!/usr/bin/env node
/* Tests for the publishing guard.

   Each test builds a throwaway git repository and drives the real guard against
   it, so the git plumbing is exercised as well as the rules. Run:

     node --test tools/
*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { guard, report, sha256Hex, STATE_PATH } from './content-guard.mjs';

const NEWS = 'news-engagement.html';
const RECORD = 'engagement-books-not-bombs.html';

function freshRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'content-guard-'));
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    return {
        dir,
        git,
        write(path, text) {
            const full = join(dir, path);
            mkdirSync(join(full, '..'), { recursive: true });
            writeFileSync(full, text);
        },
        remove(path) {
            rmSync(join(dir, path));
        },
        add(...paths) {
            git('add', '-A', ...paths);
        },
        commit(message) {
            git('add', '-A');
            git('commit', '-q', '-m', message);
            return git('rev-parse', 'HEAD').toString().trim();
        },
    };
}

/** The state file the panel writes: every page it owns, plus its tombstones.
    Digests come from the working tree, which is what the commit will hold.
    Every state file carries a later `updated` than the one before it. */
let clock = Date.parse('2026-01-01T00:00:00.000Z');
const nextStamp = () => new Date(clock += 60 * 1000).toISOString();

function stateFor(repo, files, deleted = [], updated = nextStamp()) {
    const map = {};
    for (const path of files) {
        map[path] = sha256Hex(readFileSync(join(repo.dir, path)));
    }
    return `${JSON.stringify({ version: 1, updated, files: map, deleted }, null, 4)}\n`;
}

const find = (findings, code) => findings.filter((item) => item.code === code);

test('a repository matching the published state has nothing to report', () => {
    const repo = freshRepo();
    repo.write(RECORD, '<html>record one</html>\n');
    repo.commit('add record');
    repo.write(NEWS, '<html>news with one entry</html>\n');
    repo.commit('add news');
    repo.write(STATE_PATH, stateFor(repo, [NEWS, RECORD]));
    const head = repo.commit('record state');

    const { findings } = guard({ base: `${head}^`, head, dir: repo.dir });
    assert.deepEqual(findings.failures, []);
    assert.deepEqual(findings.warnings, []);
});

test('a stale merge that brings back a deleted article fails', () => {
    const repo = freshRepo();
    repo.write(RECORD, '<html>record one</html>\n');
    repo.commit('add record');
    repo.write(NEWS, '<html>news with one entry</html>\n');
    repo.commit('add news');
    repo.write(STATE_PATH, stateFor(repo, [NEWS, RECORD]));
    repo.commit('record state');

    // A colleague clones here, edits the record page and the news page locally,
    // and then falls behind.
    const stale = repo.git('rev-parse', 'HEAD').toString().trim();
    repo.git('checkout', '-q', '-b', 'stale');
    repo.write(RECORD, '<html>record one with a local typo fix</html>\n');
    repo.write(NEWS, '<html>news with one entry, local tweak</html>\n');
    repo.commit('local edits');

    // Meanwhile the panel deletes the article: state first, then the file.
    repo.git('checkout', '-q', 'main');
    repo.write(NEWS, '<html>news with no entries</html>\n');
    repo.commit('panel: update news');
    repo.write(STATE_PATH, stateFor(repo, [NEWS], [{ path: RECORD, at: '2026-01-02T00:00:00.000Z' }]));
    repo.commit('panel: record state');
    repo.remove(RECORD);
    const published = repo.commit('panel: delete record');

    // Pulling with local edits conflicts, and the conflicts are resolved by
    // keeping this copy — the way a deletion actually comes undone.
    repo.git('checkout', '-q', 'stale');
    let conflicted = true;
    try {
        repo.git('merge', '--no-commit', published);
    } catch {
        conflicted = false;
    }
    assert.equal(conflicted, false, 'the merge should conflict');
    repo.git('checkout', '--ours', '--', NEWS, STATE_PATH, RECORD);
    const head = repo.commit('merge: keep this copy');

    // A push to main reports the previous main tip as the base, and the merge is
    // a fast-forward from it.
    const { findings } = guard({ base: published, head, dir: repo.dir });
    assert.ok(findings.failures.length > 0, 'the merge should be refused');
    const named = findings.failures.map((item) => item.path);
    assert.ok(named.includes(RECORD), `the deleted article should be named, got ${JSON.stringify(named)}`);
    assert.ok(named.includes(NEWS), `the news page that lost the published version should be named, got ${JSON.stringify(named)}`);
});

test('checking out an older news page is refused, naming the page', () => {
    const repo = freshRepo();
    repo.write(NEWS, '<html>news v1</html>\n');
    const v1 = repo.commit('news v1');
    repo.write(STATE_PATH, stateFor(repo, [NEWS]));
    const base = repo.commit('state for v1');

    // The panel publishes a newer news page.
    repo.write(NEWS, '<html>news v2</html>\n');
    repo.write(STATE_PATH, stateFor(repo, [NEWS]));
    repo.commit('state for v2');

    // Someone restores the old page with a checkout, keeping the newer state.
    repo.git('checkout', v1, '--', NEWS);
    const head = repo.commit('put the old page back');

    const { findings } = guard({ base, head, dir: repo.dir });
    assert.equal(findings.failures.length, 1);
    assert.equal(findings.failures[0].code, 'reverts-published');
    assert.equal(findings.failures[0].path, NEWS);
});

test('a deleted article arriving with the tombstone in place fails by name', () => {
    const repo = freshRepo();
    repo.write(NEWS, '<html>news with one entry</html>\n');
    repo.write(RECORD, '<html>record one</html>\n');
    repo.commit('content');
    repo.write(STATE_PATH, stateFor(repo, [NEWS, RECORD]));
    repo.commit('record state');

    // The panel deletes it: state, then file.
    repo.write(NEWS, '<html>news with no entries</html>\n');
    repo.write(STATE_PATH, stateFor(repo, [NEWS], [{ path: RECORD, at: '2026-01-02T00:00:00.000Z' }]));
    repo.commit('panel: delete');
    repo.remove(RECORD);
    const base = repo.commit('panel: remove file');

    // An old copy puts the file back, tombstone untouched.
    repo.write(RECORD, '<html>record one</html>\n');
    const head = repo.commit('stale: bring it back');

    const { findings } = guard({ base, head, dir: repo.dir });
    assert.equal(findings.failures.length, 1);
    assert.equal(findings.failures[0].code, 'restores-deleted');
    assert.equal(findings.failures[0].path, RECORD);
    assert.match(findings.failures[0].message, /deleted on 2026-01-02/);
});

test('a deliberate hand edit is refused until it is recorded', () => {
    const repo = freshRepo();
    repo.write(NEWS, '<html>news with one entry</html>\n');
    repo.commit('content');
    repo.write(STATE_PATH, stateFor(repo, [NEWS]));
    const base = repo.commit('record state');

    repo.write(NEWS, '<html>news with a hand-written correction</html>\n');
    const head = repo.commit('hand edit');

    const { findings } = guard({ base, head, dir: repo.dir });
    assert.equal(findings.failures.length, 1);
    assert.equal(findings.failures[0].code, 'unrecorded-change');
    assert.match(findings.failures[0].message, /content-state\.mjs/);
});

test('re-recording the state lets a deliberate hand edit through', () => {
    const repo = freshRepo();
    repo.write(NEWS, '<html>news with one entry</html>\n');
    repo.commit('content');
    repo.write(STATE_PATH, stateFor(repo, [NEWS]));
    const base = repo.commit('record state');

    repo.write(NEWS, '<html>news with a hand-written correction</html>\n');
    repo.commit('hand edit');
    repo.write(STATE_PATH, stateFor(repo, [NEWS]));
    const head = repo.commit('record the hand edit');

    const { findings } = guard({ base, head, dir: repo.dir });
    assert.deepEqual(findings.failures, []);
    assert.deepEqual(findings.warnings, []);
});

test('a panel save caught mid-flight is not a failure', () => {
    const repo = freshRepo();
    repo.write(NEWS, '<html>news with one entry</html>\n');
    repo.write(RECORD, '<html>record one</html>\n');
    repo.commit('content');
    repo.write(STATE_PATH, stateFor(repo, [NEWS, RECORD]));
    const base = repo.commit('record state');

    // The state file is written before the file is removed.
    repo.write(NEWS, '<html>news with no entries</html>\n');
    repo.write(STATE_PATH, stateFor(repo, [NEWS], [{ path: RECORD, at: '2026-01-02T00:00:00.000Z' }]));
    const head = repo.commit('panel: record state, file still there');

    const { findings } = guard({ base, head, dir: repo.dir });
    assert.deepEqual(findings.failures, []);
    assert.equal(findings.warnings.length, 1);
    assert.equal(findings.warnings[0].code, 'deletion-in-flight');
});

test('a page recorded as published but missing is a failure', () => {
    const repo = freshRepo();
    repo.write(NEWS, '<html>news</html>\n');
    repo.write(RECORD, '<html>record one</html>\n');
    repo.commit('content');
    repo.write(STATE_PATH, stateFor(repo, [NEWS, RECORD]));
    const base = repo.commit('record state');

    repo.remove(RECORD);
    const head = repo.commit('lost the file');

    const { findings } = guard({ base, head, dir: repo.dir });
    assert.equal(findings.failures.length, 1);
    assert.equal(findings.failures[0].code, 'recorded-but-missing');
    assert.equal(findings.failures[0].path, RECORD);
});

test('a missing state file is a failure, not a free pass', () => {
    const repo = freshRepo();
    repo.write(NEWS, '<html>news</html>\n');
    repo.commit('content');
    repo.write(STATE_PATH, stateFor(repo, [NEWS]));
    const base = repo.commit('record state');

    repo.remove(STATE_PATH);
    const head = repo.commit('dropped the state file');

    const { findings } = guard({ base, head, dir: repo.dir });
    assert.equal(findings.failures[0].code, 'state-missing');
});

test('an unrelated push touching no published content still passes', () => {
    const repo = freshRepo();
    repo.write(NEWS, '<html>news</html>\n');
    repo.commit('content');
    repo.write(STATE_PATH, stateFor(repo, [NEWS]));
    const base = repo.commit('record state');

    repo.write('about.html', '<html>about</html>\n');
    const head = repo.commit('edit about page');

    const { findings } = guard({ base, head, dir: repo.dir });
    assert.deepEqual(findings.failures, []);
    assert.deepEqual(findings.warnings, []);
});

test('a report says so when it checked a narrower range than it was asked about', () => {
    // Green has to mean the same thing every time. When the revision the range began
    // at is gone — a rewritten branch, an old clone — the guard can only check part
    // of that range, and the part it did not check has to be on the record.
    const findings = { failures: [], warnings: [] };

    const substituted = report({ from: 'aaaaaaa1111', findings }, { base: 'bbbbbbb2222', head: 'aaaaaaa1111' });
    assert.match(substituted, /The revision bbbbbbb is not in this repository/);
    assert.match(substituted, /only aaaaaaa\.\.aaaaaaa was checked/);

    const exact = report({ from: 'aaaaaaa1111', findings }, { base: 'aaaaaaa1111', head: 'aaaaaaa1111' });
    assert.doesNotMatch(exact, /was checked/);

    // The first push of a branch asks about a range that cannot exist yet. That is
    // the ordinary case, not a substitution, so it stays quiet.
    const first = report({ from: 'aaaaaaa1111', findings }, { base: '0'.repeat(40), head: 'aaaaaaa1111' });
    assert.doesNotMatch(first, /was checked/);
});

test('a range the guard cannot read fails instead of passing quietly', () => {
    // The guard's whole promise is that it fails loudly. A run that cannot read the
    // range has no business reporting success, because success would mean the
    // publishing protection was simply not there.
    const repo = freshRepo();
    repo.git('commit', '-q', '--allow-empty', '-m', 'first');
    const cli = fileURLToPath(new URL('./content-guard.mjs', import.meta.url));
    const run = (...args) => {
        try {
            const out = execFileSync(process.execPath, [cli, ...args],
                { cwd: repo.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            return { status: 0, out };
        } catch (error) {
            return { status: error.status, out: `${error.stdout || ''}${error.stderr || ''}` };
        }
    };

    // A repository's first commit has nothing before it to compare against, so there
    // is genuinely nothing to check. That is an honest pass.
    const firstCommit = run('--base', '0'.repeat(40), '--head', 'HEAD');
    assert.equal(firstCommit.status, 0, firstCommit.out);
    assert.match(firstCommit.out, /Nothing earlier than this revision exists/);

    // A revision that cannot be read at all is a real failure, and says so.
    const unreadable = run('--base', 'HEAD', '--head', '0'.repeat(40));
    assert.equal(unreadable.status, 1, unreadable.out);
    assert.match(unreadable.out, /could not read/);
});
