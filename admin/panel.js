/* Logic for the News panel.

   The panel edits a hand-written page, so it never regenerates markup
   wholesale. It replaces only the character ranges a person changed and
   leaves every other byte alone. That is the whole safety story: an entry
   you did not touch cannot change.

   Proof: test/round-trip.mjs asserts render(parse(x)) === x for all 32 cards
   and all 24 record pages.
*/

// ── site facts ───────────────────────────────────────────────────────────

export const REPO = { owner: 'mwamer', name: 'index.html', branch: 'main' };
export const NEWS_PATH = 'news-engagement.html';
export const IMAGE_DIR = 'images/';

export const CATEGORIES = [
    { id: 'conferences-events', label: 'Conferences & Events' },
    { id: 'invited-talks', label: 'Invited Talks' },
    { id: 'institutional-engagement', label: 'Institutional Engagement' },
    { id: 'research-public-dialogue', label: 'Research & Public Dialogue' },
    { id: 'media-commentary', label: 'Media & Commentary' },
];

export const ACTIVITY_TYPES = [
    'Conference', 'Symposium', 'Seminar', 'Lecture', 'Keynote', 'Panel',
    'Workshop', 'Training', 'Policy', 'Media', 'Network', 'Initiative',
    'Delegation', 'Tribunal',
];

export const ROLES = [
    'Presenter', 'Invited Speaker', 'Invited Panel Participant', 'Panellist',
    'Co-Organiser', 'Interviewee', 'Workshop Participant', 'Expert Contributor',
    'Delegation Member', 'Founder', 'Contributor', 'Participant',
];

// ── entities ─────────────────────────────────────────────────────────────

const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    middot: '\u00b7', rarr: '\u2192', larr: '\u2190', mdash: '\u2014',
    ndash: '\u2013', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c',
    rdquo: '\u201d', hellip: '\u2026', eacute: '\u00e9', aacute: '\u00e1',
    iacute: '\u00ed', oacute: '\u00f3', uacute: '\u00fa', ntilde: '\u00f1',
    uuml: '\u00fc', ouml: '\u00f6', auml: '\u00e4', egrave: '\u00e8',
    ecirc: '\u00ea', ccedil: '\u00e7', pound: '\u00a3', deg: '\u00b0',
    times: '\u00d7', laquo: '\u00ab', raquo: '\u00bb', sect: '\u00a7',
};

export function decode(value) {
    return String(value ?? '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        const named = ENTITIES[body.toLowerCase()];
        return named === undefined ? match : named;
    });
}

export function encode(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** As `encode`, for attribute values where a quote would end the attribute. */
export function encodeAttr(value) {
    return encode(value).replace(/"/g, '&quot;');
}

// ── span surgery ─────────────────────────────────────────────────────────

/** Character range of the text between `open` and the next `close`. */
function between(raw, open, close, from = 0) {
    const start = raw.indexOf(open, from);
    if (start < 0) return null;
    const bodyStart = start + open.length;
    const end = raw.indexOf(close, bodyStart);
    if (end < 0) return null;
    return { start: bodyStart, end, text: raw.slice(bodyStart, end) };
}

/** Whole element range, comment-aware, depth-counted. */
function element(raw, openTag, tagName, from = 0) {
    const start = raw.indexOf(openTag, from);
    if (start < 0) return null;
    const openRe = new RegExp(`<${tagName}\\b`, 'g');
    const closeRe = new RegExp(`</${tagName}>`, 'g');
    let depth = 0;
    let cursor = start;
    while (cursor < raw.length) {
        if (raw.startsWith('<!--', cursor)) {
            const skip = raw.indexOf('-->', cursor);
            if (skip < 0) break;
            cursor = skip + 3;
            continue;
        }
        openRe.lastIndex = cursor;
        closeRe.lastIndex = cursor;
        const open = openRe.exec(raw);
        const close = closeRe.exec(raw);
        if (!close) break;
        if (open && open.index < close.index) {
            depth += 1;
            cursor = open.index + open[0].length;
            continue;
        }
        depth -= 1;
        cursor = close.index + close[0].length;
        if (depth === 0) return { start, end: cursor, text: raw.slice(start, cursor) };
    }
    return null;
}

/** Apply replacements back to front so earlier ranges stay valid. */
function apply(text, replacements) {
    const ordered = [...replacements].sort((a, b) => b.start - a.start);
    let out = text;
    for (const rep of ordered) {
        out = out.slice(0, rep.start) + rep.text + out.slice(rep.end);
    }
    return out;
}

/** Block lead text with the notes the person deleted already taken out. */
function leadWithout(blockText, raw, noteIndices) {
    let lead = leadOf(blockText);
    if (!noteIndices || !noteIndices.length) return lead;
    const notes = noteComments(raw);
    for (const index of noteIndices) {
        const note = notes[index];
        if (!note) continue;
        lead = lead.split(raw.slice(note.lineStart, note.lineEnd)).join('');
    }
    return lead;
}

/** Queue a replacement only when the text really differs.
 *
 * Entity spelling is not a difference: if the words are the same, the page
 * keeps its own `&amp;` or `’` rather than being rewritten to the panel's taste.
 */
function replaceIfChanged(list, raw, span, nextText) {
    if (!span) return;
    const current = raw.slice(span.start, span.end);
    if (current === nextText) return;
    if (decode(current) === decode(nextText)) return;
    list.push({ start: span.start, end: span.end, text: nextText });
}

/** HTML comments that occupy whole lines, so removing one cannot break markup. */
export function noteComments(raw) {
    const found = [];
    const re = /<!--([\s\S]*?)-->/g;
    let match;
    while ((match = re.exec(raw)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;
        const lineStart = raw.lastIndexOf('\n', start) + 1;
        const lineEnd = raw.indexOf('\n', end);
        if (lineEnd < 0) continue;
        if (raw.slice(lineStart, start).trim() !== '') continue;   // shares a line: leave alone
        if (raw.slice(end, lineEnd).trim() !== '') continue;
        found.push({
            start, end, lineStart, lineEnd: lineEnd + 1,
            text: match[1].replace(/\s+/g, ' ').trim(),
        });
    }
    return found;
}

function dropNotes(raw, noteIndices, protectedRanges = []) {
    if (!noteIndices || !noteIndices.length) return raw;
    const notes = noteComments(raw);
    const chosen = noteIndices.map((i) => notes[i]).filter(Boolean)
        .filter((note) => !protectedRanges.some((range) => range.start !== range.end
            && note.start >= range.start && note.end <= range.end));
    if (!chosen.length) return raw;
    return apply(raw, chosen.map((note) => ({ start: note.lineStart, end: note.lineEnd, text: '' })));
}

// ── links and photographs ────────────────────────────────────────────────

export function parseLinks(inner) {
    const links = [];
    const re = /<a class="news-link" href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = re.exec(inner)) !== null) {
        const label = decode(match[3].replace(/\s*&rarr;\s*$/, '').replace(/&rarr;/, '')).trim();
        links.push({
            href: match[1],
            external: /target="_blank"/.test(match[2]),
            label: label || match[1],
        });
    }
    return links;
}

export function renderLinks(links) {
    return links.map((link) => (link.external
        ? `<a class="news-link" href="${encodeAttr(link.href)}" target="_blank" rel="noopener noreferrer">${encode(link.label)} &rarr;</a>`
        : `<a class="news-link" href="${encodeAttr(link.href)}">${encode(link.label)} &rarr;</a>`
    )).join(' ');
}

export function parsePhotos(block) {
    const photos = [];
    const re = /<figure class="news-media__item">([\s\S]*?)<\/figure>/g;
    let match;
    while ((match = re.exec(block)) !== null) {
        const inner = match[1];
        const image = inner.match(/<img class="news-photo[^"]*"\s+src="([^"]*)"\s+width="(\d+)"\s+height="(\d+)"\s+alt="([^"]*)"/);
        const caption = inner.match(/<figcaption class="news-caption">([\s\S]*?)<\/figcaption>/);
        if (image) {
            photos.push({
                kind: 'photo',
                src: image[1],
                width: Number(image[2]),
                height: Number(image[3]),
                alt: decode(image[4]),
                caption: caption ? decode(caption[1]).trim() : '',
            });
            continue;
        }
        const space = inner.match(/role="img"[\s\S]*?aria-label="([^"]*)"/);
        photos.push({
            kind: 'space',
            label: space ? decode(space[1]) : '',
            caption: caption ? decode(caption[1]).trim() : '',
            // Pages differ on whether the reserved space carries this hint.
            // Mirror what is already there instead of imposing a style.
            hint: /Replace this div with the photograph/.test(inner),
        });
    }
    return photos;
}

function figureMarkup(photo, photoClass, indent, place) {
    const inner = `${indent}    `;
    if (photo.kind === 'photo') {
        return [
            `${indent}<figure class="news-media__item">`,
            `${inner}<img class="news-photo ${photoClass}" src="${encodeAttr(photo.src)}"`,
            `${inner}     width="${photo.width}" height="${photo.height}" alt="${encodeAttr(photo.alt)}">`,
            `${inner}<figcaption class="news-caption">${encode(photo.caption)}</figcaption>`,
            `${indent}</figure>`,
        ].join('\n');
    }
    const label = photo.label || `Reserved space for a photograph of ${place || 'this engagement'}`;
    return [
        `${indent}<figure class="news-media__item">`,
        photo.hint ? `${inner}<!-- Replace this div with the photograph:` : null,
        photo.hint ? `${inner}     <img class="news-photo ${photoClass}" src="images/..." alt="..."> -->` : null,
        `${inner}<div class="news-photo ${photoClass}" role="img"`,
        `${inner}     aria-label="${encodeAttr(label)}"></div>`,
        `${indent}</figure>`,
    ].filter((line) => line !== null).join('\n');
}

/** Media wrapper. Starts at the `div` so it can replace a block in place.
 *
 * `lead` carries any comment the page keeps between the opening div and the
 * first figure, so a rebuilt block does not silently drop a note.
 */
function mediaMarkup(photos, photoClass, indent, place, wrapper = 'news-media', lead = '') {
    const inner = `${indent}    `;
    const figures = (photos.length ? photos : [{ kind: 'space' }])
        .map((photo) => figureMarkup(photo, photoClass, inner, place))
        .join('\n');
    return `<div class="${wrapper}">\n${lead}${figures}\n${indent}</div>`;
}

/** The text a block keeps between its opening tag and its first figure. */
function leadOf(blockText) {
    const open = blockText.indexOf('>\n');
    const figure = blockText.indexOf('<figure');
    if (open < 0 || figure < 0 || figure <= open) return '';
    const lineStart = blockText.lastIndexOf('\n', figure) + 1;
    if (lineStart <= open + 2) return '';
    return blockText.slice(open + 2, lineStart);
}

// ── cards ────────────────────────────────────────────────────────────────

const CARD_INDENT = '                ';
const CARD_LEAD = `${CARD_INDENT}    `;

export function parseCard(raw, index) {
    const card = { index, raw, photos: [], links: [], notes: noteComments(raw) };

    const head = raw.match(/<li class="news-card"([^>]*)>/);
    card.categoryAttr = head ? between(head[0], 'data-category="', '"') : null;
    card.tagAttr = head ? between(head[0], 'data-tag="', '"') : null;
    const headStart = raw.indexOf(head ? head[0] : '');
    const shift = (span) => (span ? { start: span.start + headStart, end: span.end + headStart, text: span.text } : null);
    card.categoryAttr = shift(card.categoryAttr);
    card.tagAttr = shift(card.tagAttr);

    const meta = between(raw, '<p class="news-card__meta">', '</p>');
    card.meta = meta;
    card.date = meta ? between(meta.text, '<span class="news-card__date">', '</span>') : null;
    card.cat = meta ? between(meta.text, '<span class="news-card__cat">', '</span>') : null;
    card.tag = meta ? between(meta.text, 'Activity type: ', '</span>') : null;
    const metaOffset = meta ? meta.start : 0;
    for (const key of ['date', 'cat', 'tag']) {
        if (card[key]) card[key] = { start: card[key].start + metaOffset, end: card[key].end + metaOffset, text: card[key].text };
    }

    const title = between(raw, '<h3 class="news-card__title">', '</h3>');
    card.title = title;
    if (title) {
        const link = between(title.text, '<a class="news-card__link" href="', '">');
        if (link) {
            const roleStart = link.end + 2;                       // skip the closing quote and bracket
            const roleEnd = title.text.lastIndexOf('</a>');
            card.slug = { start: title.start + link.start, end: title.start + link.end, text: link.text };
            card.role = { start: title.start + roleStart, end: title.start + roleEnd, text: title.text.slice(roleStart, roleEnd) };
        } else {
            card.role = { start: title.start, end: title.end, text: title.text };
        }
    }

    card.place = between(raw, '<p class="news-card__place">', '</p>');
    card.desc = between(raw, '<p class="news-card__desc">', '</p>');
    card.linksRow = element(raw, '<p class="news-card__links">', 'p');
    card.media = element(raw, '<div class="news-media">', 'div');

    if (card.linksRow) {
        card.links = parseLinks(card.linksRow.text);
        card.linksInner = { start: card.linksRow.start + '<p class="news-card__links">'.length, end: card.linksRow.end - '</p>'.length };
    }
    if (card.media) card.photos = parsePhotos(card.media.text);

    card.recordLink = card.links.findIndex((link) => /^Full record/.test(link.label));
    card.values = {
        date: card.date ? decode(card.date.text) : '',
        category: card.categoryAttr ? card.categoryAttr.text : '',
        categoryLabel: card.cat ? decode(card.cat.text) : '',
        activityType: card.tag ? decode(card.tag.text) : '',
        role: card.role ? decode(card.role.text) : '',
        place: card.place ? decode(card.place.text) : '',
        description: card.desc ? decode(card.desc.text) : '',
        photos: card.photos.map((photo) => ({ ...photo })),
        links: card.links
            .filter((_, i) => i !== card.recordLink)
            .map((link) => ({ ...link })),
    };
    card.slugText = card.slug ? card.slug.text : '';
    card.recordSlug = card.slugText ? card.slugText.replace(/\.html$/, '') : '';
    card.values.recordSlug = card.recordSlug;
    return card;
}

/** Rebuild one card, touching only what changed. */
export function renderCard(card, values) {
    const raw = card.raw;
    const reps = [];
    const category = CATEGORIES.find((c) => c.id === values.category) || CATEGORIES[0];

    replaceIfChanged(reps, raw, card.categoryAttr, category.id);
    replaceIfChanged(reps, raw, card.tagAttr, values.activityType);
    replaceIfChanged(reps, raw, card.date, encode(values.date));
    replaceIfChanged(reps, raw, card.cat, encode(category.label));
    replaceIfChanged(reps, raw, card.tag, encode(values.activityType));

    const slug = values.recordSlug ? `${values.recordSlug}.html` : '';
    if (card.title && card.role) {
        const titleMarkup = slug
            ? `<a class="news-card__link" href="${encodeAttr(slug)}">${encode(values.role)}</a>`
            : encode(values.role);
        replaceIfChanged(reps, raw, { start: card.title.start, end: card.title.end }, titleMarkup);
    }

    replaceIfChanged(reps, raw, card.place, encode(values.place));

    if (values.description) {
        if (card.desc) {
            replaceIfChanged(reps, raw, card.desc, encode(values.description));
        } else if (card.place) {
            const at = endOfLine(raw, card.place.end);
            reps.push({ start: at, end: at, text: `\n${CARD_LEAD}<p class="news-card__desc">${encode(values.description)}</p>` });
        }
    } else if (card.desc) {
        reps.push({ start: lineStart(raw, card.desc.start), end: endOfLine(raw, card.desc.end), text: '' });
    }

    if (card.linksInner) {
        const links = [...values.links];
        if (slug) links.push({ href: slug, label: 'Full record', external: false });
        replaceIfChanged(reps, raw, card.linksInner, renderLinks(links));
    }

    if (card.media) {
        const photos = values.photos.length ? values.photos : card.photos;
        const candidate = mediaMarkup(photos.slice(0, 1), 'news-photo--16x9', CARD_LEAD, values.place, 'news-media', leadOf(card.media.text));
        replaceIfChanged(reps, raw, card.media, candidate);
    }

    const next = dropNotes(apply(raw, reps), values.dropNotes, reps);
    return { html: next, changed: next !== raw };
}

/** A brand new card, in the page's own shape. */
export function buildCard(values) {
    const category = CATEGORIES.find((c) => c.id === values.category) || CATEGORIES[0];
    const slug = values.recordSlug ? `${values.recordSlug}.html` : '';
    const links = [...values.links];
    if (slug) links.push({ href: slug, label: 'Full record', external: false });
    const photos = values.photos.length ? values.photos : [{ kind: 'space' }];
    return [
        `${CARD_INDENT}<li class="news-card" data-category="${encodeAttr(category.id)}" data-tag="${encodeAttr(values.activityType)}">`,
        `${CARD_LEAD}<p class="news-card__meta"><span class="news-card__date">${encode(values.date)}</span> &middot; <span class="news-card__cat">${encode(category.label)}</span><span class="news-visually-hidden"> &middot; Activity type: ${encode(values.activityType)}</span></p>`,
        `${CARD_LEAD}<h3 class="news-card__title">${slug ? `<a class="news-card__link" href="${encodeAttr(slug)}">${encode(values.role)}</a>` : encode(values.role)}</h3>`,
        `${CARD_LEAD}<p class="news-card__place">${encode(values.place)}</p>`,
        values.description ? `${CARD_LEAD}<p class="news-card__desc">${encode(values.description)}</p>` : null,
        `${CARD_LEAD}<p class="news-card__links">${renderLinks(links)}</p>`,
        `${CARD_LEAD}<!-- Outbound sources only, one per source. No embedding, no player, no thumbnail. -->`,
        `${CARD_LEAD}${mediaMarkup(photos.slice(0, 1), 'news-photo--16x9', CARD_LEAD, values.place)}`,
        `${CARD_INDENT}</li>`,
    ].filter((line) => line !== null).join('\n');
}

function lineStart(raw, at) {
    return raw.lastIndexOf('\n', at) + 1;
}

function endOfLine(raw, at) {
    const stop = raw.indexOf('\n', at);
    return stop < 0 ? raw.length : stop;
}

// ── the news page ────────────────────────────────────────────────────────

export function parseNewsPage(html) {
    const archiveOpen = html.indexOf('<ul class="news-archive">');
    if (archiveOpen < 0) throw new Error('The archive list was not found on the page.');
    const archiveClose = html.indexOf(`\n${'            '}</ul>`, archiveOpen);
    if (archiveClose < 0) throw new Error('The end of the archive list was not found.');

    const head = html.slice(0, archiveOpen + '<ul class="news-archive">'.length);
    const tail = html.slice(archiveClose + 1);
    const inner = html.slice(head.length, archiveClose + 1);

    const chunks = inner.split(/(?=^[ \t]*<li class="news-card")/m);
    const cards = [];
    chunks.forEach((chunk) => {
        if (!/^\s*<li class="news-card"/.test(chunk)) {
            if (chunk.trim()) throw new Error('Unexpected content between the archive entries.');
            return;
        }
        cards.push(parseCard(chunk.trim(), cards.length));
    });

    const featured = parseFeatured(html);
    return { html, head, tail, cards, featured };
}

export function parseFeatured(html) {
    const section = element(html, '<section class="news-featured"', 'section');
    if (!section) return null;
    const body = section.text;
    const title = between(body, '<h2 class="news-featured__title"', '</h2>');
    const find = (span) => (span ? { start: section.start + span.start, end: section.start + span.end, text: span.text } : null);
    const featured = {
        span: { start: section.start, end: section.end },
        raw: section.text,
        eyebrow: find(between(body, '<p class="news-featured__eyebrow">', '</p>')),
        date: find(between(body, '<span class="news-featured__date">', '</span>')),
        role: find(between(body, '<span>', '</span>')),
        tag: find(between(body, 'Activity type: ', '</span>')),
        title: find(title),
        desc: find(between(body, '<p class="news-featured__desc">', '</p>')),
        linksRow: find(element(body, '<p class="news-card__links">', 'p')),
        media: find(element(body, '<div class="news-featured__media">', 'div')),
    };
    if (featured.title) {
        // The marker stops before the tag's closing ">", so everything from here
        // to "</h2>" covers the tag's own attributes as well as its content.
        const open = title.text.indexOf('>') + 1;
        featured.titleInner = { start: section.start + title.start + open, end: section.start + title.end, text: title.text.slice(open) };
        const link = between(title.text, '<a class="news-card__link" href="', '">');
        if (link) {
            const textStart = link.end + 2;
            const textEnd = title.text.lastIndexOf('</a>');
            featured.titleHref = { start: section.start + title.start + link.start, end: section.start + title.start + link.end, text: link.text };
            featured.titleText = { start: section.start + title.start + textStart, end: section.start + title.start + textEnd, text: title.text.slice(textStart, textEnd) };
        } else {
            featured.titleText = featured.titleInner;
        }
    }
    featured.slug = featured.titleHref ? featured.titleHref.text.replace(/\.html$/, '') : '';
    return featured;
}

function renderFeatured(featured, values) {
    if (!featured) return null;
    const reps = [];
    const raw = featured.raw;
    const shift = (span) => (span ? { start: span.start - featured.span.start, end: span.end - featured.span.start, text: span.text } : null);
    replaceIfChanged(reps, raw, shift(featured.date), encode(values.date));
    replaceIfChanged(reps, raw, shift(featured.role), encode(values.role));
    replaceIfChanged(reps, raw, shift(featured.tag), encode(values.activityType));
    if (featured.titleHref && values.recordSlug) {
        replaceIfChanged(reps, raw, shift(featured.titleText), encode(values.place));
        replaceIfChanged(reps, raw, shift(featured.titleHref), encodeAttr(`${values.recordSlug}.html`));
    } else if (featured.titleInner) {
        // Either the page never linked, or the entry has no record page now.
        // Replacing the whole inner title is what removes a stale anchor.
        replaceIfChanged(reps, raw, shift(featured.titleInner), encode(values.place));
    }
    replaceIfChanged(reps, raw, shift(featured.desc), encode(values.description));
    const inner = featured.linksRow
        ? { start: featured.linksRow.start - featured.span.start + '<p class="news-card__links">'.length, end: featured.linksRow.end - featured.span.start - '</p>'.length, text: '' }
        : null;
    if (inner) replaceIfChanged(reps, raw, inner, renderLinks(values.links));
    const media = shift(featured.media);
    if (media) {
        const indent = '            ';
        const photo = values.photos.length ? values.photos[0] : { kind: 'space' };
        const candidate = `<div class="news-featured__media">\n${leadOf(featured.media.text)}${figureMarkup(photo, 'news-photo--4x3', `${indent}    `, values.place)}\n${indent}</div>`;
        replaceIfChanged(reps, raw, media, candidate);
    }
    return apply(raw, reps);
}

/**
 * Rebuild the page from edited entries.
 *
 * `edit` is a map from card index to values; `edit.added` holds new entries and
 * `edit.removed` card indices to drop. Order is only re-sorted when a date (or
 * the set of entries) changed, so a save that touches nothing else cannot
 * shuffle the archive.
 */
export function renderNewsPage(page, edit = {}) {
    const entries = [];
    page.cards.forEach((card, index) => {
        if (edit.removed && edit.removed.includes(index)) return;
        const values = edit.values ? edit.values[index] : null;
        entries.push({
            index,
            values,
            date: values ? values.date : card.values.date,
            html: values ? renderCard(card, values).html : card.raw,
        });
    });
    for (const entry of edit.added || []) {
        entries.push({ index: -1, values: entry, date: entry.date, html: buildCard(entry) });
    }

    const dateChanged = entries.some((entry) => entry.index >= 0 && entry.values
            && entry.values.date !== page.cards[entry.index].values.date)
        || (edit.added || []).length > 0
        || (edit.removed || []).length > 0;

    const ordered = dateChanged
        ? entries.map((entry, i) => ({ entry, i }))
            .sort((a, b) => dateKey(b.entry.date) - dateKey(a.entry.date) || a.i - b.i)
            .map((item) => item.entry)
        : entries;

    // Between entries the page uses exactly one blank line; the first sits right
    // under the archive list. Reproducing that rule keeps an untouched page
    // byte-identical.
    const body = ordered
        .map((entry, i) => `${i ? `\n\n${CARD_INDENT}` : `\n${CARD_INDENT}`}${entry.html.trim()}`)
        .join('');

    let html = `${page.head}${body}\n${page.tail}`;

    if (page.featured) {
        const removed = edit.removed || [];
        // Which entry the panel is showing: the editor's own choice when they made
        // one, otherwise the entry whose record the panel links to.
        const shown = page.cards.findIndex(
            (card) => card.recordSlug && card.recordSlug === page.featured.slug);
        const chosen = edit.featuredIndex === undefined ? shown : edit.featuredIndex;
        // Deleting the entry the panel shows would leave it published at the top of
        // the page, so feature the newest entry that is left instead.
        const deleted = chosen >= 0 && removed.includes(chosen);
        // Left alone, the panel already matches the file, so an entry that was not
        // deleted is never rewritten.
        if (edit.featuredIndex !== undefined || deleted) {
            const featuredIndex = deleted
                ? page.cards.findIndex((card, index) => !removed.includes(index))
                : chosen;
            if (featuredIndex >= 0) {
                const values = (edit.values && edit.values[featuredIndex]) || page.cards[featuredIndex].values;
                const candidate = renderFeatured(page.featured, values);
                if (candidate !== page.featured.raw) {
                    const start = page.featured.span.start;
                    html = html.slice(0, start) + candidate + html.slice(start + page.featured.raw.length);
                }
            }
        }
    }
    return { html, changed: html !== page.html };
}

// ── record pages ─────────────────────────────────────────────────────────

export function parseRecordPage(html) {
    const section = element(html, '<section class="news-detail">', 'section');
    if (!section) return null;
    const raw = section.text;
    const at = (span) => (span ? { start: section.start + span.start, end: section.start + span.end, text: span.text } : null);

    const page = { html, raw, span: { start: section.start, end: section.end } };
    page.kicker = at(between(raw, '<p class="kicker">', '</p>'));
    const h1 = between(raw, '<h1 class="news-detail__title">', '</h1>') || between(raw, '<h1 class="page-title">', '</h1>');
    page.titleTag = raw.includes('<h1 class="news-detail__title">') ? 'news-detail__title' : 'page-title';
    page.title = at(h1);
    page.meta = at(between(raw, '<p class="news-detail__meta">', '</p>'));
    page.date = at(between(raw, '<span class="news-detail__date">', '</span>'));
    page.lede = at(between(raw, '<p class="news-detail__lede">', '</p>'));

    const bodies = [];
    const bodyRe = /<p class="news-detail__body">[\s\S]*?<\/p>/g;
    let match;
    while ((match = bodyRe.exec(raw)) !== null) {
        bodies.push(at({ start: match.index, end: match.index + match[0].length, text: match[0] }));
    }
    page.bodies = bodies;

    page.linksRow = at(element(raw, '<p class="news-card__links">', 'p'));
    if (page.linksRow) {
        page.linksInner = {
            start: page.linksRow.start + '<p class="news-card__links">'.length,
            end: page.linksRow.end - '</p>'.length,
        };
    }
    page.media = at(element(raw, '<div class="news-media news-media--detail">', 'div'));
    page.photos = page.media ? parsePhotos(raw.slice(page.media.start - section.start, page.media.end - section.start)) : [];

    // The meta line has two shapes across the site's history; keep whichever
    // this page uses rather than normalising it. Offsets below are measured
    // from the start of the meta line, then shifted onto the page.
    const metaText = page.meta ? page.meta.text : '';
    const metaBase = page.meta ? page.meta.start : 0;
    page.metaShape = /Activity type:/.test(metaText) ? 'role-tag' : 'place-role';
    if (page.metaShape === 'role-tag') {
        const dateEnd = metaText.indexOf('</span>') + '</span>'.length;
        const roleStart = dateEnd + ' &middot; '.length;
        const roleEnd = metaText.indexOf('<span class="news-visually-hidden">');
        page.role = { start: metaBase + roleStart, end: metaBase + roleEnd, text: metaText.slice(roleStart, roleEnd) };
        const tag = between(metaText, 'Activity type: ', '</span>');
        page.tag = tag ? { start: metaBase + tag.start, end: metaBase + tag.end, text: tag.text } : null;
        page.place = null;
    } else {
        const parts = metaText.split(' &middot; ');
        const first = parts[0] || '';
        const placeStart = first.length + ' &middot; '.length;
        const roleStart = placeStart + (parts[1] || '').length + ' &middot; '.length;
        page.place = { start: metaBase + placeStart, end: metaBase + placeStart + (parts[1] || '').length, text: parts[1] || '' };
        page.role = { start: metaBase + roleStart, end: metaBase + roleStart + (parts[2] || '').length, text: parts[2] || '' };
        page.tag = null;
    }

    page.values = {
        kicker: page.kicker ? decode(page.kicker.text) : '',
        title: page.title ? decode(page.title.text) : '',
        date: page.date ? decode(page.date.text) : '',
        place: page.place ? decode(page.place.text) : '',
        role: page.role ? decode(page.role.text) : '',
        activityType: page.tag ? decode(page.tag.text) : '',
        lede: page.lede ? decode(page.lede.text) : '',
        bodies: bodies.map((body) => decode(body.text.replace(/^<p class="news-detail__body">/, '').replace(/<\/p>$/, ''))),
        links: page.linksRow ? parseLinks(raw.slice(page.linksRow.start - section.start, page.linksRow.end - section.start)) : [],
        photos: page.photos.map((photo) => ({ ...photo })),
    };
    return page;
}

export function renderRecordPage(page, values, touched = null) {
    if (!page) return { html: null, changed: false };
    const raw = page.raw;
    const reps = [];
    const abs = (span) => ({ start: span.start - page.span.start, end: span.end - page.span.start, text: span.text });

    // Only the parts the person changed are written back. Everything else keeps
    // the page's own wording, punctuation and entities exactly as they are, so
    // saving one field can never restyle another. No `touched` means every
    // field (a caller that builds a page from scratch).
    const edited = (name) => !touched || touched.has(name);

    if (edited('title')) replaceIfChanged(reps, raw, abs(page.title), encode(values.title));
    if (edited('date')) replaceIfChanged(reps, raw, abs(page.date), encode(values.date));
    if (edited('lede')) replaceIfChanged(reps, raw, abs(page.lede), encode(values.lede));

    if (page.metaShape === 'role-tag') {
        if (edited('role')) replaceIfChanged(reps, raw, abs(page.role), encode(values.role));
        if (edited('activityType')) replaceIfChanged(reps, raw, abs(page.tag), encode(values.activityType));
    } else {
        if (edited('place')) replaceIfChanged(reps, raw, abs(page.place), encode(values.place));
        if (edited('role')) replaceIfChanged(reps, raw, abs(page.role), encode(values.role));
    }

    if (page.linksInner && edited('links')) {
        replaceIfChanged(reps, raw, abs(page.linksInner), renderLinks(values.links));
    }

    // Paragraphs keep their slot: clearing one deletes it, so removing the
    // second of five never shifts the text of the other four.
    const paragraphs = values.bodies || page.values.bodies;
    if (edited('bodies')) {
        page.bodies.forEach((body, i) => {
            const span = abs(body);
            if (paragraphs[i] === undefined || String(paragraphs[i]).trim() === '') {
                reps.push({ start: lineStart(raw, span.start), end: endOfLine(raw, span.end), text: '' });
                return;
            }
            replaceIfChanged(reps, raw, span, `<p class="news-detail__body">${encode(paragraphs[i])}</p>`);
        });
        const extra = paragraphs.slice(page.bodies.length).filter((paragraph) => String(paragraph).trim() !== '');
        if (extra.length) {
            const last = page.bodies[page.bodies.length - 1] || page.lede || page.meta;
            const anchor = endOfLine(raw, abs(last).end);
            const markup = extra.map((paragraph) => `              <p class="news-detail__body">${encode(paragraph)}</p>`).join('\n');
            reps.push({ start: anchor, end: anchor, text: `\n${markup}` });
        }
    }

    // The media block names the entry in the space left for a photograph, and
    // its lead comment carries the notes the person deleted, so both can move it.
    const mediaMoved = edited('photos') || edited('title') || edited('place') || (values.dropNotes || []).length > 0;
    if (page.media && mediaMoved) {
        const indent = '            ';
        const photos = values.photos.length ? values.photos : page.photos;
        const blockText = raw.slice(abs(page.media).start, abs(page.media).end);
        const candidate = mediaMarkup(photos, 'news-photo--16x9', indent, values.title || values.place, 'news-media news-media--detail',
            leadWithout(blockText, raw, values.dropNotes));
        replaceIfChanged(reps, raw, abs(page.media), candidate);
    }

    const next = dropNotes(apply(raw, reps), values.dropNotes, reps);
    const html = page.html.slice(0, page.span.start) + next + page.html.slice(page.span.end);
    return { html, changed: html !== page.html };
}

// ── a new record page ────────────────────────────────────────────────────

export function buildRecordPage(shell, values) {
    const section = [
        '          <section class="news-detail">',
        '              <p class="news-detail__back"><a class="news-link" href="news-engagement.html">&larr; News &amp; Engagement</a></p>',
        `              <p class="kicker">${encode(values.categoryLabel)}</p>`,
        `              <h1 class="news-detail__title">${encode(values.title)}</h1>`,
        `              <p class="news-detail__meta"><span class="news-detail__date">${encode(values.date)}</span> &middot; ${encode(values.place)} &middot; ${encode(values.role)}</p>`,
        `              <p class="news-detail__lede">${encode(values.description)}</p>`,
        ...(values.bodies || []).filter((p) => p.trim()).map((p) => `              <p class="news-detail__body">${encode(p)}</p>`),
        `              <p class="news-card__links">${renderLinks(values.links)}</p>`,
        `            ${mediaMarkup(values.photos.length ? values.photos : [{ kind: 'space' }], 'news-photo--16x9', '            ', values.title || values.place, 'news-media news-media--detail')}`,
        '          </section>',
    ].join('\n');

    if (shell.includes('<!--RECORD-->')) return shell.replace('<!--RECORD-->', section);
    const marker = /\n\s*<section class="news-detail">[\s\S]*?<\/section>/;
    if (!marker.test(shell)) throw new Error('The record page template has no news-detail section.');
    return shell.replace(marker, `\n${section}`);
}

/** Give a reused shell its own title and description. */
export function retitleRecordShell(shell, { name, description }) {
    return shell
        .replace(/<title>[^<]*<\/title>/, `<title>${encode(name)} - Dr Wesam Amer</title>`)
        .replace(/<meta name="description" content="[^"]*">/,
            `<meta name="description" content="${encodeAttr(description)}">`);
}

/** Strip the record page down to nav, footer and boilerplate, ready for reuse. */
export function recordShell(html) {
    return html.replace(/\n\s*<section class="news-detail">[\s\S]*?<\/section>/, '\n<!--RECORD-->');
}

// ── ordering ─────────────────────────────────────────────────────────────

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Sortable key from a free-text date, so partial dates still order correctly. */
export function dateKey(label) {
    const text = String(label || '').toLowerCase();
    const named = text.match(new RegExp(`(${MONTHS.join('|')})\\s+(\\d{4})`));
    if (named) return Number(named[2]) * 100 + (MONTHS.indexOf(named[1]) + 1);
    const year = text.match(/(\d{3,4})/);
    if (year) return Number(year[1]) * 100 + 12;
    return 0;
}

export function slugify(value) {
    return String(value || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

/** The photograph formats the Worker writes. It stays the authority: this list
    only lets the panel say so before anything has been written. */
export const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif'];
export const PHOTO_FORMATS = ['JPEG', 'PNG', 'WebP', 'AVIF'];

/** The extension of a file or path, lowercased and without the dot. */
export function photoExtension(name) {
    const match = String(name || '').match(/\.([A-Za-z0-9]+)$/);
    return match ? match[1].toLowerCase() : '';
}

/** Whether the Worker will write a photograph at this path. An upload runs
    before the pages do, so a file it would refuse has to be caught before the
    first one goes, rather than leaving the plan half written. */
export function photoPathAllowed(path) {
    if (!PHOTO_EXTENSIONS.includes(photoExtension(path))) return false;
    return /^images\/[A-Za-z0-9][A-Za-z0-9-]{0,80}-\d{8}\.[a-z0-9]+$/.test(path);
}

/** Report text with nowhere to go: a full record is written to
    `engagement-<short name>.html`, so text typed without a short name cannot be
    published at all. The save stops on these entries and names them, rather than
    dropping what the person wrote. */
export function needsShortName(entry) {
    if (entry.recordSlug) return false;
    return [entry.recordTitle, ...(entry.bodies || [])].some((value) => String(value || '').trim() !== '');
}

/** The address a record page is published at.

    The Worker only writes record pages named `engagement-*.html`, so the
    prefix belongs here rather than in the hands of whoever is typing. An entry
    with no short name has no record page, and returns an empty string. */
export function recordPageSlug(value) {
    const slug = slugify(value);
    if (!slug) return '';
    return slug.startsWith('engagement-') ? slug : `engagement-${slug}`;
}

// ── base64 ───────────────────────────────────────────────────────────────

export function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

export function base64ToBytes(base64) {
    const binary = atob(String(base64).replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

export function textToBase64(text) {
    return bytesToBase64(new TextEncoder().encode(text));
}

export function base64ToText(base64) {
    return new TextDecoder().decode(base64ToBytes(base64));
}
