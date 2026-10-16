#!/usr/bin/env node
/* The publishing guard.

   The admin panel publishes the news page, the engagement record pages and the
   publishing state file. A clone that is behind can put an older copy of that
   content back, and a merge is what quietly does it: the merge keeps the stale
   side and the deleted article returns.

   This tool reads the repository and refuses that. Every page that does not
   match the state the panel published is a failure, because a push that
   replaces a published page — with an older copy of it, or with an edit made on
   top of an older copy — takes the live site backwards. Nothing is judged by
   intent: a deliberate edit becomes legitimate by recording it, with
   `node tools/content-state.mjs`, in the same push.

   The only findings that do not stop a push are the short moments in the middle
   of a panel save, when the state file has been written and the content commit
   has not landed yet.

   Nothing here writes to the repository or reverts anything. It is run twice,
   from `hooks/pre-push` on the machine that is pushing and from the workflow in
   `.github/workflows/content-guard.yml`. A hook can be bypassed, so the workflow
   is the enforcement that counts.

   Usage:  node tools/content-guard.mjs --base <rev> --head <rev>
*/

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

/** Written by the panel on every save, and read here. */
export const STATE_PATH = '.panel-state.json';

/** The files the panel owns, matching what worker/worker.js will write. Images
    are not listed: an image on its own publishes nothing, so it is not worth a
    digest in every commit. */
const CONTENT_PAGE = /^(?:news-engagement|engagement-[a-z0-9][a-z0-9-]{0,80})\.html$/;

/** How far back to look for a version the panel published earlier. */
const HISTORY_LIMIT = 100;

export const isContentPage = (path) => CONTENT_PAGE.test(path);

export function sha256Hex(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/** The state file as an object, or null when it is missing or unreadable. */
export function parseState(text) {
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        return null;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const files = {};
    for (const [path, sha] of Object.entries(body.files || {})) {
        if (typeof path === 'string' && typeof sha === 'string') files[path] = sha;
    }
    const deleted = [];
    for (const item of Array.isArray(body.deleted) ? body.deleted : []) {
        if (item && typeof item.path === 'string') {
            deleted.push({ path: item.path, at: String(item.at || '') });
        }
    }
    return { updated: String(body.updated || ''), files, deleted };
}

/** Decide what is wrong with the repository at `head`.

    Every input is already read, so this is a pure function and the tests drive
    it directly. `shaAtHead` returns the digest of a file's bytes at head.
    `everPublished` and `everDeleted` answer from the state file's whole history,
    because a deletion is permanent: an old copy of the state file must not be
    able to forget one. */
export function checkPublishing({ headState, baseState, headPaths, basePaths = new Set(), shaAtHead, shaAtBase = () => null, everPublished = () => false, everDeleted = () => null, stateChanged = false }) {
    const failures = [];
    const warnings = [];
    const fail = (code, path, message) => failures.push({ code, path, message });
    const warn = (code, path, message) => warnings.push({ code, path, message });

    if (!headState) {
        fail('state-missing', STATE_PATH,
            `${STATE_PATH} is missing or unreadable at this revision, so the published state of `
            + 'the site cannot be checked. Restore it from the newest panel save.');
        return { failures, warnings };
    }

    // The state file carries when it was written, so the newest one is the
    // authority. A stale copy brings its own older state file with its older
    // content, and trusting the tree's copy would let the pair pass as
    // consistent. An older state arriving on top of a newer one is a rollback.
    if (baseState && stateChanged && !(headState.updated > baseState.updated)) {
        fail('state-rolled-back', STATE_PATH,
            `the published state file went back to ${headState.updated || 'an earlier version'}, behind `
            + `${baseState.updated || 'the newer one'}. A stale copy is overwriting the live site. Pull the newest `
            + 'main and re-apply your edit on top of it.');
    }
    const authoritative = (baseState && baseState.updated > headState.updated) ? baseState : headState;

    // A deletion is permanent, so a page the panel has ever deleted must not be
    // here. A file that this push left exactly as the base had it is the panel's
    // own save part-way through; anything else is the article coming back.
    for (const path of headPaths) {
        const tombstone = everDeleted(path);
        if (!tombstone) continue;
        const untouched = basePaths.has(path) && shaAtBase(path) === shaAtHead(path);
        if (untouched) {
            warn('deletion-in-flight', path,
                `${path} is marked deleted on main and this push does not touch it. The panel removes the file `
                + 'in the next commit.');
        } else {
            fail('restores-deleted', path,
                `${path} was deleted on ${tombstone.at || 'an earlier save'} and this push puts it back. `
                + 'This is what a stale copy does when it merges. Pull the newest main, drop the file, and push again.');
        }
    }

    for (const path of headPaths) {
        // A deleted page is judged by the loop above, not by its digest.
        if (everDeleted(path)) continue;
        const actual = shaAtHead(path);
        const recorded = authoritative.files[path];
        if (recorded === actual) continue;
        if (recorded && everPublished(path, actual)) {
            fail('reverts-published', path,
                `${path} has been put back to a version the panel published earlier, replacing the newer published `
                + 'version. This is a stale copy overwriting the live site. Pull the newest main and re-apply your '
                + 'edit on top of it.');
            continue;
        }
        // New content the panel did not publish. It is not refused as a revert,
        // but it does replace the published page, so it is a conflict until the
        // person making it says, in the state file, that they meant it.
        fail('unrecorded-change', path,
            `${path} holds a version the panel never published, so this push replaces the published page with it. `
            + 'Keep the file, run `node tools/content-state.mjs`, and commit the updated state file in the same push.');
    }

    // A file the panel says it published but which is not here means a save
    // stopped half-way. Late in the same push, that is the save still running.
    for (const path of Object.keys(authoritative.files)) {
        if (headPaths.has(path)) continue;
        if (stateChanged) {
            warn('publish-in-flight', path,
                `${path} is recorded as published and is not in the repository yet. Expected mid-save.`);
        } else {
            fail('recorded-but-missing', path,
                `${path} is recorded as published but is not in the repository. The last save did not finish. `
                + 'Save again from the panel, or run `node tools/content-state.mjs` to record the truth.');
        }
    }

    return { failures, warnings };
}

// ── reading the repository ───────────────────────────────────────────────────

const isZero = (rev) => !rev || /^0+$/.test(rev);

/** Read a repository. `dir` is the working directory, so the tests can drive a
    throwaway repository without changing the process's own directory. */
function open(dir) {
    const git = (args, options = {}) => execFileSync('git', dir ? ['-C', dir, ...args] : args, {
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
    });

    const bytesAt = (rev, path) => git(['cat-file', 'blob', `${rev}:${path}`]);

    const stateAt = (rev) => {
        try {
            return parseState(bytesAt(rev, STATE_PATH).toString('utf8'));
        } catch {
            return null;
        }
    };

    const contentPathsAt = (rev) => {
        const output = git(['ls-tree', '-r', '--name-only', '-z', rev], { encoding: 'utf8' });
        return new Set(output.split('\0').filter((path) => isContentPage(path)));
    };

    const resolve = (base, head) => {
        if (!isZero(base)) {
            try {
                git(['cat-file', '-e', `${base}^{commit}`]);
                return base;
            } catch {
                // A rewritten remote history leaves the old revision unusable.
            }
        }
        return `${head}^`;
    };

    /** Every digest the panel ever published, and every article it ever deleted,
        read from the state file's own history. This is what separates "someone
        edited this on purpose" from "an old copy came back", and it is what
        makes a deletion permanent: an older state file cannot forget one. */
    const publishedHistory = (head) => {
        // `--full-history` matters: without it git's history simplification
        // follows one side of a merge, and the side that recorded a deletion is
        // exactly the side a stale copy merges against.
        //
        // The revision matters too: this reads what `head` can reach, not what is
        // checked out. A push can carry a branch that is not the working tree, and
        // reading HEAD there would judge the wrong history.
        const shas = git(['log', '--full-history', `--max-count=${HISTORY_LIMIT}`, '--format=%H', head, '--', STATE_PATH], { encoding: 'utf8' })
            .split('\n').filter(Boolean);
        const digests = new Map();
        const tombstones = new Map();
        for (const sha of shas) {
            const state = stateAt(sha);
            if (!state) continue;
            for (const [path, digest] of Object.entries(state.files)) {
                if (!digests.has(path)) digests.set(path, new Set());
                digests.get(path).add(digest);
            }
            for (const item of state.deleted) {
                const seen = tombstones.get(item.path);
                // Keep the earliest record of the deletion: that is when it happened.
                if (!seen || (item.at && item.at < seen.at)) tombstones.set(item.path, item);
            }
        }
        return {
            everPublished: (path, digest) => Boolean(digests.get(path) && digests.get(path).has(digest)),
            everDeleted: (path) => tombstones.get(path) || null,
        };
    };

    return {
        git,
        bytesAt,
        stateAt,
        contentPathsAt,
        resolve,
        publishedHistory,
        diffNames: (from, to) => git(['diff', '--name-only', '-z', from, to], { encoding: 'utf8' })
            .split('\0').filter(Boolean),
    };
}

export { open as openRepo };

export function guard({ base, head, dir = '' }) {
    const repo = open(dir);
    const from = repo.resolve(base, head);
    const headState = repo.stateAt(head);
    const baseState = repo.stateAt(from);
    const baseText = (() => {
        try {
            return repo.bytesAt(from, STATE_PATH).toString('utf8');
        } catch {
            return null;
        }
    })();
    const headText = (() => {
        try {
            return repo.bytesAt(head, STATE_PATH).toString('utf8');
        } catch {
            return null;
        }
    })();
    const history = repo.publishedHistory(head);
    const basePaths = repo.contentPathsAt(from);
    return {
        from,
        changedFiles: repo.diffNames(from, head),
        findings: checkPublishing({
            headState,
            baseState,
            headPaths: repo.contentPathsAt(head),
            basePaths,
            shaAtHead: (path) => sha256Hex(repo.bytesAt(head, path)),
            shaAtBase: (path) => sha256Hex(repo.bytesAt(from, path)),
            everPublished: history.everPublished,
            everDeleted: history.everDeleted,
            stateChanged: baseText !== headText,
        }),
    };
}

// ── the report ───────────────────────────────────────────────────────────────

/** What to say about the findings. Written for the person who has to fix it. */
export function report({ from, findings }, { base, head }) {
    const lines = [];
    lines.push(`Publishing guard: ${from.slice(0, 7)}..${head.slice(0, 7)}`);
    lines.push('');
    // Say so when the check covered less than it was asked about. Substituting the
    // range quietly would make green mean something narrower than it looks, which is
    // the one thing a check must never do.
    if (from !== base && !isZero(base)) {
        lines.push(`The revision ${String(base).slice(0, 7)} is not in this repository, so only `
            + `${from.slice(0, 7)}..${head.slice(0, 7)} was checked.`);
        lines.push('');
    }
    if (findings.failures.length) {
        lines.push(`${findings.failures.length} conflict(s) with the published state of the site:`);
        for (const item of findings.failures) {
            lines.push(`  FAIL  ${item.path}`);
            lines.push(`        ${item.message}`);
        }
    }
    if (findings.warnings.length) {
        lines.push(`${findings.warnings.length} change(s) the panel did not publish:`);
        for (const item of findings.warnings) {
            lines.push(`  note  ${item.path}`);
            lines.push(`        ${item.message}`);
        }
    }
    if (!findings.failures.length && !findings.warnings.length) {
        lines.push('The content matches what the panel published. Nothing to reconcile.');
    }
    if (findings.failures.length) {
        lines.push('');
        lines.push('To reconcile:');
        lines.push('  git pull --rebase origin main      # take the newest published content');
        lines.push('  # drop the files named above, or re-apply your edit on top of the pulled version');
        lines.push('  node tools/content-state.mjs       # re-record the published state');
        lines.push('  git add -A && git commit && git push');
    }
    return lines.join('\n');
}

/** Whether a revision names a commit in the repository the guard is looking at. */
function resolvable(rev) {
    try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', rev], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function main(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i].startsWith('--')) options[argv[i].slice(2)] = argv[i + 1];
    }
    const head = options.head || 'HEAD';
    const base = options.base || `${head}^`;
    let result;
    try {
        result = guard({ base, head });
    } catch (error) {
        // A range the guard cannot read cannot be judged, and a check that cannot run
        // must not report success: staying quiet here would leave the publishing
        // protection quietly absent, which is worse than a red run that explains
        // itself. The one range that means nothing is a repository's first commit,
        // which has nothing before it to compare against.
        process.stdout.write(`Publishing guard could not read ${String(base).slice(0, 7)}..`
            + `${String(head).slice(0, 7)}: ${error.message}\n`);
        if (!resolvable(`${head}^{commit}`) || resolvable(`${head}^{commit}^`)) {
            process.stdout.write('The published content could not be checked. '
                + 'Fetch the full history, or check this range by hand.\n');
            return 1;
        }
        process.stdout.write('Nothing earlier than this revision exists, '
            + 'so there is no published state to compare it with.\n');
        return 0;
    }
    const text = report(result, { base, head });
    process.stdout.write(`${text}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${text}\n\`\`\`\n`);
    }
    return result.findings.failures.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    process.exitCode = main(process.argv.slice(2));
}
