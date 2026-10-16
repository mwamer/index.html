/* Keeping Cloudflare Access in step with the editor registry.

   Two systems decide access, and they answer different questions:

   - D1, in `registry.js`, decides what a signed-in person may publish. It is
     the authority.
   - Cloudflare Access decides who may sign in at all. Its policy is therefore a
     copy of the active editors in D1.

   A copy drifts unless something keeps it in step. That is this file. It reads
   the registry, works out what the policy should hold, and writes it only when
   it differs.

   Three properties make it safe to run after every change:

   - It never runs when it is not configured. Missing configuration is recorded
     as `skipped`, not treated as agreement, and never as a failure of the change
     that triggered it.
   - It cannot lock the website's owner out: an empty desired list is refused,
     and the owner's record cannot be suspended or removed in the first place.
   - It is recoverable. Every attempt is recorded in `access_sync` with what it
     found and did, so a failure is visible and can be retried from the panel.
     The registry is committed first, so a reconciliation that fails leaves the
     truth intact and the copy stale — which is the safe direction to drift. */

import { desiredAccessEmails as desiredFromRegistry, recordAccessSync } from './registry.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

/** Whether this Worker has what it needs to talk to Cloudflare. Without it the
    reconciliation is skipped, and the panel says so, rather than pretending the
    policy agrees with the registry. */
export function accessApiConfigured(env) {
    return Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID);
}

async function cf(env, path, init = {}) {
    const response = await fetch(`${CF_API}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${env.CF_API_TOKEN}`,
            'Content-Type': 'application/json',
            ...(init.headers || {}),
        },
    });
    const raw = await response.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (!response.ok || body.success === false) {
        const said = (body.errors && body.errors[0] && body.errors[0].message) || `Cloudflare replied ${response.status}`;
        throw new Error(said);
    }
    return body.result;
}

/** The Access application this Worker already belongs to, found by the audience
    tag it verifies. Nothing here creates an application: a second one would be
    a second gate, and the policy that matters is the one in front of the API. */
async function findApplication(env) {
    const apps = await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/access/apps`);
    const wanted = String(env.ACCESS_AUD || '');
    const found = (apps || []).find((app) => String(app.aud || '') === wanted);
    if (!found) {
        throw new Error('No Access application matches the audience in ACCESS_AUD, so there is nothing to reconcile');
    }
    return found;
}

/** The policy that lists editors. An id pins it exactly; otherwise it is matched
    by name, and a policy that cannot be identified is not guessed at. */
async function findPolicy(env, appId) {
    const policies = await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${appId}/policies`);
    const list = policies || [];
    if (env.ACCESS_POLICY_ID) {
        const pinned = list.find((item) => String(item.id) === String(env.ACCESS_POLICY_ID));
        if (!pinned) throw new Error('ACCESS_POLICY_ID does not name a policy on this Access application');
        return pinned;
    }
    const name = String(env.ACCESS_POLICY_NAME || 'Editors');
    const named = list.filter((item) => item.name === name);
    if (named.length === 1) return named[0];
    if (named.length > 1) throw new Error(`More than one policy on this application is named ${JSON.stringify(name)}`);
    throw new Error(`No policy on this Access application is named ${JSON.stringify(name)}. Set ACCESS_POLICY_ID, `
        + 'or rename the policy, then try again.');
}

const policyEmails = (policy) => (policy.include || [])
    .map((rule) => rule && rule.email && rule.email.email)
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .sort();

/** The emails the policy should hold, and what it holds now. Exported so the
    panel can show the difference without changing anything. */
export async function accessDiff(env) {
    const desired = await desiredFromRegistry(env);
    const app = await findApplication(env);
    const policy = await findPolicy(env, app.id);
    const current = policyEmails(policy);
    return {
        appId: app.id,
        policyId: policy.id,
        policyName: policy.name,
        desired,
        current,
        add: desired.filter((email) => !current.includes(email)),
        remove: current.filter((email) => !desired.includes(email)),
    };
}

/** Refuse to write an empty policy. An empty include list would deny everyone,
    including the owner, and no code change in the panel could undo that. */
function assertSafeToWrite(desired) {
    if (!desired.length) {
        throw new Error('The registry has no active editors, so the Access policy was left alone. '
            + 'An empty policy would lock everyone out of the website.');
    }
}

/** Put the registry's active editors into the Access policy.

    With `apply` false it reports what it would do and changes nothing. */
export async function reconcileAccess(env, { apply = false } = {}) {
    if (!accessApiConfigured(env)) {
        return { state: 'skipped', detail: 'Cloudflare API access is not configured on this Worker', changed: false };
    }
    try {
        const diff = await accessDiff(env);
        assertSafeToWrite(diff.desired);
        if (!diff.add.length && !diff.remove.length) {
            return { state: 'ok', detail: 'The Access policy already matches the registry', changed: false, ...diff };
        }
        if (!apply) return { state: 'ok', detail: 'Not applied', changed: false, ...diff };

        const app = await findApplication(env);
        const policy = await findPolicy(env, app.id);
        await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/access/apps/${app.id}/policies/${policy.id}`, {
            method: 'PUT',
            body: JSON.stringify({
                name: policy.name,
                decision: policy.decision || 'allow',
                include: diff.desired.map((email) => ({ email: { email } })),
                exclude: policy.exclude || [],
                require: policy.require || [],
            }),
        });
        return {
            state: 'ok',
            changed: true,
            detail: `Added ${diff.add.length}, removed ${diff.remove.length}`,
            ...diff,
        };
    } catch (error) {
        const message = (error && error.message) || String(error);
        return { state: 'failed', changed: false, detail: message };
    }
}

/** Reconcile after a registry change, and record what came of it.

    This never throws: the registry change has already been committed, and a
    person whose access was just granted should not see their change reported as
    failed because Cloudflare timed out. The record is what makes the drift
    visible, and the panel offers a retry. */
export async function reconcileAfterChange(env, { actor = '' } = {}) {
    let result;
    try {
        result = await reconcileAccess(env, { apply: true });
    } catch (error) {
        result = { state: 'failed', changed: false, detail: (error && error.message) || String(error) };
    }
    try {
        await recordAccessSync(env, { state: result.state, detail: `${actor ? `after ${actor}: ` : ''}${result.detail}` });
    } catch {
        // Recording is best-effort too: if `access_sync` cannot be written, the
        // registry change still stands and the next attempt records itself.
    }
    return result;
}
