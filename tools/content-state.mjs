#!/usr/bin/env node
/* Record the published state of the site.

   The panel writes `.panel-state.json` itself on every save. This tool does the
   same thing from the working tree, for the times a change is made by hand —
   editing a page in an editor, or removing an entry the panel cannot reach.

   It is the deliberate route, so it says out loud what it is recording, and it
   refuses the two things that should always be a decision rather than a side
   effect: reviving a deleted article, and deleting one by accident.

   Usage:
     node tools/content-state.mjs                    # record the working tree
     node tools/content-state.mjs --revive <path>    # publish a page again
*/

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { STATE_PATH, isContentPage, sha256Hex, parseState } from './content-guard.mjs';

/** The pages the panel owns that are on disk. `git ls-files` reads the index,
    so a page deleted from the working tree is filtered out here and recorded as
    a deletion below. */
function contentFiles() {
    return execFileSync('git', ['ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })
        .split('\0')
        .filter((path) => path && isContentPage(path) && existsSync(path))
        .sort();
}

function readState() {
    if (!existsSync(STATE_PATH)) return { version: 1, files: {}, deleted: [] };
    const parsed = parseState(readFileSync(STATE_PATH, 'utf8'));
    if (!parsed) throw new Error(`${STATE_PATH} is not readable JSON`);
    return { version: 1, ...parsed };
}

function main(argv) {
    const reviveAt = argv.indexOf('--revive');
    const revive = reviveAt >= 0 ? argv[reviveAt + 1] : '';

    const previous = readState();
    const at = new Date().toISOString();
    const present = contentFiles();

    const files = {};
    for (const path of present) files[path] = sha256Hex(readFileSync(path));

    const tombstoned = new Map(previous.deleted.map((item) => [item.path, item]));
    const revived = [];
    for (const path of present) {
        if (!tombstoned.has(path)) continue;
        if (path !== revive) {
            throw new Error(`${path} was deleted on ${tombstoned.get(path).at} and is back in the working tree.\n`
                + 'Nothing was written. If you mean to publish it again, run:\n'
                + `  node tools/content-state.mjs --revive ${path}`);
        }
        tombstoned.delete(path);
        revived.push(path);
    }

    // A page that has gone from the working tree is a deletion. Say so rather
    // than dropping it quietly: this is what stops a stale copy bringing it back.
    const removed = Object.keys(previous.files).filter((path) => !(path in files) && !tombstoned.has(path));
    for (const path of removed) tombstoned.set(path, { path, at });

    const next = {
        version: 1,
        updated: at,
        files,
        deleted: [...tombstoned.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
    };
    writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 4)}\n`);

    process.stdout.write(`Recorded ${present.length} published page(s) in ${STATE_PATH}.\n`);
    for (const path of removed) process.stdout.write(`  deleted: ${path} (kept as a tombstone)\n`);
    for (const path of revived) process.stdout.write(`  revived: ${path}\n`);
    return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
