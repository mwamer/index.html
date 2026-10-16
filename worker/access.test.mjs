#!/usr/bin/env node
/* Tests for keeping Cloudflare Access in step with the editor registry.

   The Cloudflare API is stubbed, so these run without credentials and without
   touching the live policy. What they pin down is the set of rules that make an
   automatic reconciliation safe to run after every editor change: it is skipped
   when it is not configured, it refuses to write a policy that would lock
   everyone out, it leaves the policy alone when it already agrees, and a failure
   is reported rather than thrown.

   Run:  node --test worker/
*/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { accessApiConfigured, accessDiff, reconcileAccess, reconcileAfterChange } from './access.js';

const ACCOUNT = 'acct-1';
const APP_ID = 'app-1';
const POLICY_ID = 'policy-1';
const AUD = 'aud-tag';

/** A Cloudflare stand-in with one Access application and one policy. */
function stubCloudflare({ policy = null, fail = false, failStatus = 500 } = {}) {
    const calls = [];
    const state = {
        policy: policy || {
            id: POLICY_ID,
            name: 'Editors',
            decision: 'allow',
            include: [{ email: { email: 'wesaam.amer@gmail.com' } }],
            exclude: [],
            require: [],
        },
    };
    const fetch = async (url, init = {}) => {
        const method = (init.method || 'GET').toUpperCase();
        const path = String(url).replace('https://api.cloudflare.com/client/v4', '');
        calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
        const json = (body, status = 200) => new Response(JSON.stringify(body), {
            status, headers: { 'Content-Type': 'application/json' },
        });
        if (fail) return json({ success: false, errors: [{ message: 'Access API said no' }] }, failStatus);

        if (method === 'GET' && path === `/accounts/${ACCOUNT}/access/apps`) {
            return json({ success: true, result: [{ id: APP_ID, aud: AUD, name: 'Website admin' }] });
        }
        if (method === 'GET' && path === `/accounts/${ACCOUNT}/access/apps/${APP_ID}/policies`) {
            return json({ success: true, result: [state.policy] });
        }
        if (method === 'PUT' && path === `/accounts/${ACCOUNT}/access/apps/${APP_ID}/policies/${state.policy.id}`) {
            state.policy = { ...state.policy, ...init.method === 'PUT' ? JSON.parse(init.body) : {} };
            state.policy.id = POLICY_ID;
            return json({ success: true, result: state.policy });
        }
        throw new Error(`stubCloudflare does not know: ${method} ${path}`);
    };
    return { fetch, calls, state };
}

/** A D1 stand-in that only answers what the registry needs here. Statements
    arrive either bound or bare, so both shapes are offered. */
function stubDB(activeEmails = []) {
    const syncs = [];
    const handle = (sql, args) => ({
        all: async () => {
            if (/SELECT email FROM editors WHERE status = 'active'/.test(sql)) {
                return { results: activeEmails.map((email) => ({ email })) };
            }
            throw new Error(`stubDB does not know: ${sql}`);
        },
        first: async () => {
            if (/FROM access_sync/.test(sql)) return syncs.at(-1) || null;
            throw new Error(`stubDB does not know: ${sql}`);
        },
        run: async () => {
            if (/^INSERT INTO access_sync/.test(sql)) {
                syncs.push({ at: args[0], state: args[1], detail: args[2] });
                return { success: true };
            }
            throw new Error(`stubDB does not know: ${sql}`);
        },
    });
    return {
        prepare: (sql) => ({ ...handle(sql, []), bind: (...args) => handle(sql, args) }),
        _syncs: syncs,
    };
}

const env = ({ db = stubDB(), token = 'cf-token', policyName } = {}) => ({
    DB: db,
    CF_API_TOKEN: token,
    CF_ACCOUNT_ID: ACCOUNT,
    ACCESS_AUD: AUD,
    ...(policyName ? { ACCESS_POLICY_NAME: policyName } : {}),
});

/** Run `run` with the Cloudflare API stubbed, and always put the real `fetch`
    back. */
async function withCloudflare(options, run) {
    const cloudflare = stubCloudflare(options);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, init) => cloudflare.fetch(url, init);
    try {
        return await run(cloudflare);
    } finally {
        globalThis.fetch = realFetch;
    }
}

test('an unconfigured Worker reports that reconciliation was skipped', async () => {
    const db = stubDB(['a@example.com']);
    const result = await reconcileAccess({ DB: db }, { apply: true });
    assert.equal(result.state, 'skipped');
    assert.equal(result.changed, false);
    assert.equal(accessApiConfigured({ DB: db }), false);
});

test('a policy that already matches is left alone', async () => {
    await withCloudflare({}, async (cloudflare) => {
        const result = await reconcileAccess(env({ db: stubDB(['wesaam.amer@gmail.com']) }), { apply: true });
        assert.equal(result.state, 'ok');
        assert.equal(result.changed, false, 'nothing differed, so nothing should be written');
        assert.deepEqual(result.add, []);
        assert.deepEqual(result.remove, []);
        assert.ok(!cloudflare.calls.some((call) => call.method === 'PUT'), 'no write should be attempted');
    });
});

test('a newly active editor is added to the policy', async () => {
    await withCloudflare({}, async (cloudflare) => {
        const db = stubDB(['wesaam.amer@gmail.com', 'family.amer6@gmail.com']);
        const result = await reconcileAccess(env({ db }), { apply: true });
        assert.equal(result.state, 'ok');
        assert.equal(result.changed, true);
        assert.deepEqual(result.add, ['family.amer6@gmail.com']);
        const written = cloudflare.calls.find((call) => call.method === 'PUT');
        const emails = written.body.include.map((rule) => rule.email.email).sort();
        assert.deepEqual(emails, ['family.amer6@gmail.com', 'wesaam.amer@gmail.com']);
        assert.equal(written.body.decision, 'allow', 'the policy decision must be preserved');
        assert.equal(written.body.name, 'Editors', 'the policy name must be preserved');
    });
});

test('a suspended editor is removed from the policy', async () => {
    await withCloudflare({
        policy: {
            id: POLICY_ID,
            name: 'Editors',
            decision: 'allow',
            include: [{ email: { email: 'wesaam.amer@gmail.com' } }, { email: { email: 'gone@example.com' } }],
            exclude: [],
            require: [],
        },
    }, async (cloudflare) => {
        const result = await reconcileAccess(env({ db: stubDB(['wesaam.amer@gmail.com']) }), { apply: true });
        assert.deepEqual(result.remove, ['gone@example.com']);
        const written = cloudflare.calls.find((call) => call.method === 'PUT');
        assert.deepEqual(written.body.include.map((rule) => rule.email.email), ['wesaam.amer@gmail.com']);
    });
});

test('a dry run reports the difference and writes nothing', async () => {
    await withCloudflare({}, async (cloudflare) => {
        const db = stubDB(['wesaam.amer@gmail.com', 'new@example.com']);
        const result = await reconcileAccess(env({ db }), { apply: false });
        assert.equal(result.changed, false);
        assert.deepEqual(result.add, ['new@example.com']);
        assert.ok(!cloudflare.calls.some((call) => call.method === 'PUT'));
    });
});

test('an empty registry never empties the policy', async () => {
    await withCloudflare({}, async (cloudflare) => {
        const result = await reconcileAccess(env({ db: stubDB([]) }), { apply: true });
        assert.equal(result.state, 'failed');
        assert.match(result.detail, /lock everyone out/i);
        assert.ok(!cloudflare.calls.some((call) => call.method === 'PUT'), 'the policy must be left as it was');
    });
});

test('a Cloudflare failure is reported, not thrown', async () => {
    await withCloudflare({ fail: true }, async () => {
        const result = await reconcileAccess(env({ db: stubDB(['a@example.com']) }), { apply: true });
        assert.equal(result.state, 'failed');
        assert.match(result.detail, /Access API said no/);
    });
});

test('an application that does not match the audience is refused', async () => {
    await withCloudflare({}, async () => {
        const result = await reconcileAccess({ ...env({ db: stubDB(['a@example.com']) }), ACCESS_AUD: 'different' }, { apply: true });
        assert.equal(result.state, 'failed');
        assert.match(result.detail, /ACCESS_AUD/);
    });
});

test('a policy that cannot be identified is refused rather than guessed at', async () => {
    await withCloudflare({
        policy: { id: POLICY_ID, name: 'Something else', decision: 'allow', include: [], exclude: [], require: [] },
    }, async () => {
        const result = await reconcileAccess(env({ db: stubDB(['a@example.com']) }), { apply: true });
        assert.equal(result.state, 'failed');
        assert.match(result.detail, /named "Editors"/);
    });
});

test('a pinned policy id is used when it is given', async () => {
    await withCloudflare({}, async (cloudflare) => {
        const result = await reconcileAccess({
            ...env({ db: stubDB(['wesaam.amer@gmail.com', 'new@example.com']) }),
            ACCESS_POLICY_ID: POLICY_ID,
        }, { apply: true });
        assert.equal(result.state, 'ok');
        assert.equal(result.changed, true);
        assert.ok(cloudflare.calls.some((call) => call.path.endsWith(`/policies/${POLICY_ID}`)));
    });
});

test('a pinned policy id that is not on the application is refused', async () => {
    await withCloudflare({}, async () => {
        const result = await reconcileAccess({
            ...env({ db: stubDB(['a@example.com']) }),
            ACCESS_POLICY_ID: 'not-there',
        }, { apply: true });
        assert.equal(result.state, 'failed');
        assert.match(result.detail, /ACCESS_POLICY_ID/);
    });
});

test('the difference can be read without changing anything', async () => {
    await withCloudflare({}, async (cloudflare) => {
        const diff = await accessDiff(env({ db: stubDB(['wesaam.amer@gmail.com', 'new@example.com']) }));
        assert.deepEqual(diff.add, ['new@example.com']);
        assert.deepEqual(diff.current, ['wesaam.amer@gmail.com']);
        assert.equal(diff.policyName, 'Editors');
        assert.ok(!cloudflare.calls.some((call) => call.method === 'PUT'));
    });
});

test('the outcome of a reconciliation is recorded', async () => {
    await withCloudflare({}, async () => {
        const db = stubDB(['wesaam.amer@gmail.com', 'new@example.com']);
        await reconcileAfterChange(env({ db }), { actor: 'wesaam.amer@gmail.com' });
        assert.equal(db._syncs.length, 1);
        assert.equal(db._syncs[0].state, 'ok');
        assert.match(db._syncs[0].detail, /wesaam\.amer@gmail\.com/);
    });
});

test('an unconfigured reconciliation is still recorded as skipped', async () => {
    const db = stubDB(['a@example.com']);
    await reconcileAfterChange({ DB: db }, { actor: 'owner@example.com' });
    assert.equal(db._syncs.at(-1).state, 'skipped');
});

test('a reconciliation that fails does not stop the change that triggered it', async () => {
    // The registry write has already happened. A Cloudflare outage must not turn
    // it into a failure the caller sees, or the owner would be told their change
    // did not happen when it did.
    await withCloudflare({ fail: true }, async () => {
        const db = stubDB(['a@example.com']);
        const result = await reconcileAfterChange(env({ db }), { actor: 'owner@example.com' });
        assert.equal(result.state, 'failed');
        assert.equal(db._syncs.at(-1).state, 'failed');
    });
});
