/* Editor registry for D1 - authoritative source of editor permissions.

   This table decides who may publish. Cloudflare Access only decides who may
   sign in, and it holds a copy of this table rather than the truth, so a
   misconfigured policy can never grant more than a row here allows.

   Two rules shape the errors this module throws:

   - A caller mistake carries `status: 400`, so the API can say what was wrong
     with the request.
   - A database that cannot be read throws without a status, so the API answers
     503 and refuses. Nothing here falls back on another source of permission
     when D1 is unavailable: an outage must not become a grant. */

const ROLES = ['owner', 'news-editor'];
const STATUSES = ['active', 'pending', 'suspended'];

/** A refusal the caller can fix, as opposed to a failure of the database. */
function refuse(message) {
    return Object.assign(new Error(message), { status: 400 });
}

function isValidEmail(email) {
    if (typeof email !== 'string') return false;
    const normalized = email.toLowerCase().trim();
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(normalized) && normalized.length <= 254;
}

function normalizeEmail(email) {
    if (typeof email !== 'string') return '';
    return email.toLowerCase().trim();
}

function nowIso() {
    return new Date().toISOString();
}

function assertValidRole(role) {
    if (!ROLES.includes(role)) throw refuse('Invalid role');
}

function assertValidStatus(status) {
    if (!STATUSES.includes(status)) throw refuse('Invalid status');
}

/** The database, or a failure. A missing binding is a misconfiguration, not an
    empty registry, so it is raised rather than read as "no editors". */
function database(env) {
    if (!env || !env.DB) {
        throw Object.assign(new Error('The editor registry is not configured on this Worker'), { status: 503 });
    }
    return env.DB;
}

export async function listEditors(env) {
    const db = database(env);
    const { results } = await db.prepare('SELECT email, name, role, status, added_at, added_by, modified_at, modified_by FROM editors ORDER BY email ASC').all();
    return results || [];
}

/** The record for one address, or null when there is no such editor. A database
    that cannot answer throws, so a caller never reads an outage as "not an
    editor" or as "no owner". */
export async function getEditor(env, email) {
    if (!email) return null;
    const db = database(env);
    const norm = normalizeEmail(email);
    const row = await db.prepare('SELECT email, name, role, status, added_at, added_by, modified_at, modified_by FROM editors WHERE email = ?').bind(norm).first();
    return row || null;
}

export async function countActiveOwners(env) {
    const db = database(env);
    const row = await db.prepare("SELECT COUNT(*) as c FROM editors WHERE role = 'owner' AND status = 'active'").first();
    return (row && row.c) || 0;
}

export async function hasActiveOwner(env) {
    return (await countActiveOwners(env)) > 0;
}

/** The two guarantees that keep the owner able to get in: the last active owner
    is never demoted, suspended or removed, and an owner record is never removed
    or suspended at all. Both are checked here, next to the write, because the
    API and any future caller must obey them. */
async function assertOwnerSurvives(env, existing, { role, status, removing }) {
    if (existing.role === 'owner') {
        if (removing) throw refuse('The owner account cannot be removed from the panel');
        if (status !== undefined && status !== 'active') throw refuse('The owner account cannot be suspended');
    }
    const losingOwner = existing.role === 'owner' && existing.status === 'active'
        && ((role !== undefined && role !== 'owner') || (status !== undefined && status !== 'active') || removing);
    if (losingOwner && (await countActiveOwners(env)) <= 1) {
        throw refuse('This is the last active owner, so the website would be left with nobody able to manage editors');
    }
}

export async function addEditor(env, { email, name, role = 'news-editor', status = 'pending', actor }) {
    database(env);
    if (!actor) throw refuse('Actor required');
    const normEmail = normalizeEmail(email);
    const normName = (name || '').trim();
    if (!isValidEmail(normEmail)) throw refuse('A valid email address is required');
    if (!normName) throw refuse('A name is required');
    assertValidRole(role);
    assertValidStatus(status);
    if (await getEditor(env, normEmail)) throw refuse('That address is already an editor');
    const ts = nowIso();
    await env.DB.prepare('INSERT INTO editors (email, name, role, status, added_at, added_by, modified_at, modified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(normEmail, normName, role, status, ts, normalizeEmail(actor), ts, normalizeEmail(actor))
        .run();
    await audit(env, { actor, action: 'editor.add', target: normEmail, detail: JSON.stringify({ name: normName, role, status }) });
    return await getEditor(env, normEmail);
}

export async function updateEditor(env, { email, name, role, status, actor }) {
    database(env);
    if (!actor) throw refuse('Actor required');
    const normEmail = normalizeEmail(email);
    const existing = await getEditor(env, normEmail);
    if (!existing) throw refuse('Editor not found');
    const changes = {};
    let newName = existing.name;
    let newRole = existing.role;
    let newStatus = existing.status;
    if (name !== undefined) {
        const trimmed = (name || '').trim();
        if (!trimmed) throw refuse('A name is required');
        newName = trimmed;
        changes.name = trimmed;
    }
    if (role !== undefined) {
        assertValidRole(role);
        newRole = role;
        changes.role = role;
    }
    if (status !== undefined) {
        assertValidStatus(status);
        newStatus = status;
        changes.status = status;
    }
    if (!Object.keys(changes).length) return existing;
    await assertOwnerSurvives(env, existing, { role, status, removing: false });
    const ts = nowIso();
    await env.DB.prepare('UPDATE editors SET name = ?, role = ?, status = ?, modified_at = ?, modified_by = ? WHERE email = ?')
        .bind(newName, newRole, newStatus, ts, normalizeEmail(actor), normEmail)
        .run();
    await audit(env, { actor, action: 'editor.update', target: normEmail, detail: JSON.stringify(changes) });
    return await getEditor(env, normEmail);
}

export async function removeEditor(env, { email, actor }) {
    database(env);
    if (!actor) throw refuse('Actor required');
    const normEmail = normalizeEmail(email);
    if (normEmail === normalizeEmail(actor)) throw refuse('You cannot remove your own account');
    const existing = await getEditor(env, normEmail);
    if (!existing) throw refuse('Editor not found');
    await assertOwnerSurvives(env, existing, { removing: true });
    await env.DB.prepare('DELETE FROM editors WHERE email = ?').bind(normEmail).run();
    await audit(env, { actor, action: 'editor.remove', target: normEmail, detail: JSON.stringify({ role: existing.role, status: existing.status }) });
    return { success: true };
}

/** What was done to the registry, and to the published content. A failure here
    never fails the change it describes: the write has already happened, and
    losing the note about it is better than reporting the write as failed. */
export async function audit(env, { actor, action, target, detail = '' }) {
    if (!env || !env.DB) return;
    try {
        await env.DB.prepare('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
            .bind(nowIso(), normalizeEmail(actor), action, normalizeEmail(target) || target, detail)
            .run();
    } catch {
        // Intentionally ignored: see the note above.
    }
}

/** The first owner, created on the first signed-in request from an address in
    ALLOWED_EMAILS. That list is the bootstrap, not a second permission system:
    it is read here and nowhere else, so an address that is not in D1 and not on
    the list is refused however it signed in. */
export async function ensureOwnerSeed(env, { email, name }) {
    database(env);
    if (!email) return null;
    const existing = await getEditor(env, email);
    if (existing) return existing;
    const ts = nowIso();
    const norm = normalizeEmail(email);
    await env.DB.prepare('INSERT INTO editors (email, name, role, status, added_at, added_by, modified_at, modified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(norm, (name || '').trim() || norm, 'owner', 'active', ts, norm, ts, norm)
        .run();
    await audit(env, { actor: norm, action: 'owner.seed', target: norm, detail: '{}' });
    return await getEditor(env, norm);
}

/** The policy Cloudflare Access should hold: every address whose record is
    active. Written after a registry change so the two agree, and stored so a
    reconciliation that fails can be retried or reversed. */
export async function desiredAccessEmails(env) {
    const db = database(env);
    const { results } = await db.prepare("SELECT email FROM editors WHERE status = 'active' ORDER BY email ASC").all();
    return (results || []).map((row) => row.email);
}

export async function recordAccessSync(env, { state, detail }) {
    const db = database(env);
    const ts = nowIso();
    await db.prepare('INSERT INTO access_sync (at, state, detail) VALUES (?, ?, ?)')
        .bind(ts, state, String(detail || '').slice(0, 2000))
        .run();
    return { at: ts, state };
}

export async function lastAccessSync(env) {
    const db = database(env);
    const row = await db.prepare('SELECT at, state, detail FROM access_sync ORDER BY id DESC LIMIT 1').first();
    return row || null;
}
