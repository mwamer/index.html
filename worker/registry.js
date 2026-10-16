/* Editor registry for D1 - authoritative source of editor permissions. */

const ROLES = ['owner', 'news-editor'];
const STATUSES = ['active', 'pending', 'suspended'];

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
    if (!ROLES.includes(role)) throw new Error('Invalid role');
}

function assertValidStatus(status) {
    if (!STATUSES.includes(status)) throw new Error('Invalid status');
}

export async function listEditors(env) {
    const db = env.DB;
    if (!db) return [];
    try {
        const { results } = await db.prepare('SELECT email, name, role, status, added_at, added_by, modified_at, modified_by FROM editors ORDER BY email ASC').all();
        return results || [];
    } catch (error) {
        return [];
    }
}

export async function getEditor(env, email) {
    const db = env.DB;
    if (!db || !email) return null;
    const norm = normalizeEmail(email);
    try {
        const row = await db.prepare('SELECT email, name, role, status, added_at, added_by, modified_at, modified_by FROM editors WHERE email = ?').bind(norm).first();
        return row || null;
    } catch (error) {
        return null;
    }
}

export async function countActiveOwners(env) {
    const db = env.DB;
    if (!db) return 0;
    try {
        const row = await db.prepare("SELECT COUNT(*) as c FROM editors WHERE role = 'owner' AND status = 'active'").first();
        return row?.c || 0;
    } catch (error) {
        return 0;
    }
}

export async function hasActiveOwner(env) {
    return (await countActiveOwners(env)) > 0;
}

export async function addEditor(env, { email, name, role = 'news-editor', status = 'pending', actor }) {
    if (!env.DB) throw new Error('D1 not configured');
    if (!actor) throw new Error('Actor required');
    const normEmail = normalizeEmail(email);
    const normName = (name || '').trim();
    if (!isValidEmail(normEmail)) throw new Error('Invalid email');
    if (!normName) throw new Error('Name required');
    assertValidRole(role);
    assertValidStatus(status);
    const existing = await getEditor(env, normEmail);
    if (existing) throw new Error('Editor already exists');
    const ts = nowIso();
    await env.DB.prepare('INSERT INTO editors (email, name, role, status, added_at, added_by, modified_at, modified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(normEmail, normName, role, status, ts, normalizeEmail(actor), ts, normalizeEmail(actor))
        .run();
    await audit(env, { actor, action: 'editor.add', target: normEmail, detail: JSON.stringify({ name: normName, role, status }) });
    return await getEditor(env, normEmail);
}

export async function updateEditor(env, { email, name, role, status, actor }) {
    if (!env.DB) throw new Error('D1 not configured');
    if (!actor) throw new Error('Actor required');
    const normEmail = normalizeEmail(email);
    const existing = await getEditor(env, normEmail);
    if (!existing) throw new Error('Editor not found');
    const changes = {};
    let newName = existing.name;
    let newRole = existing.role;
    let newStatus = existing.status;
    if (name !== undefined) {
        const n = (name || '').trim();
        if (!n) throw new Error('Name required');
        newName = n;
        changes.name = n;
    }
    if (role !== undefined) {
        assertValidRole(role);
        const actorEmail = normalizeEmail(actor);
        const actorRec = await getEditor(env, actorEmail);
        if (actorRec && actorRec.role !== 'owner') throw new Error('Only owner can change role');
        if (existing.role === 'owner' && role !== 'owner') {
            const activeOwners = await countActiveOwners(env);
            if (activeOwners <= 1 && existing.status === 'active') throw new Error('Cannot demote last active owner');
        }
        newRole = role;
        changes.role = role;
    }
    if (status !== undefined) {
        assertValidStatus(status);
        const actorEmail = normalizeEmail(actor);
        const actorRec = await getEditor(env, actorEmail);
        if (actorRec && actorRec.role !== 'owner') throw new Error('Only owner can change status');
        if (existing.role === 'owner' && status !== 'active') {
            const activeOwners = await countActiveOwners(env);
            if (activeOwners <= 1 && existing.status === 'active') throw new Error('Cannot change status of last active owner');
        }
        newStatus = status;
        changes.status = status;
    }
    const ts = nowIso();
    await env.DB.prepare('UPDATE editors SET name = ?, role = ?, status = ?, modified_at = ?, modified_by = ? WHERE email = ?')
        .bind(newName, newRole, newStatus, ts, normalizeEmail(actor), normEmail)
        .run();
    await audit(env, { actor, action: 'editor.update', target: normEmail, detail: JSON.stringify(changes) });
    return await getEditor(env, normEmail);
}

export async function removeEditor(env, { email, actor }) {
    if (!env.DB) throw new Error('D1 not configured');
    if (!actor) throw new Error('Actor required');
    const normEmail = normalizeEmail(email);
    const actorEmail = normalizeEmail(actor);
    if (normEmail === actorEmail) throw new Error('Cannot remove self');
    const existing = await getEditor(env, normEmail);
    if (!existing) throw new Error('Editor not found');
    if (existing.role === 'owner' && existing.status === 'active') {
        const activeOwners = await countActiveOwners(env);
        if (activeOwners <= 1) throw new Error('Cannot remove last active owner');
    }
    await env.DB.prepare('DELETE FROM editors WHERE email = ?').bind(normEmail).run();
    await audit(env, { actor, action: 'editor.remove', target: normEmail, detail: JSON.stringify({ role: existing.role, status: existing.status }) });
    return { success: true };
}

export async function audit(env, { actor, action, target, detail = '' }) {
    const db = env.DB;
    if (!db) return;
    const ts = nowIso();
    try {
        await db.prepare('INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
            .bind(ts, normalizeEmail(actor), action, normalizeEmail(target) || target, detail)
            .run();
    } catch (error) {
        // ignore audit failures
    }
}

export async function ensureOwnerSeed(env, { email, name }) {
    if (!env.DB || !email) return null;
    const existing = await getEditor(env, email);
    if (existing) return existing;
    const ts = nowIso();
    const norm = normalizeEmail(email);
    try {
        await env.DB.prepare('INSERT INTO editors (email, name, role, status, added_at, added_by, modified_at, modified_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(norm, name || norm, 'owner', 'active', ts, norm, ts, norm)
            .run();
        await audit(env, { actor: norm, action: 'owner.seed', target: norm, detail: '{}' });
    } catch (error) {
        // ignore
    }
    return await getEditor(env, email);
}
