'use strict';
// Music Library page over data/library.json, which PublishPlaylist.py (stream
// PC, every 15 minutes) regenerates. Sorting / filtering / merged cells work like
// the Fish Log on the minigames page.
//
// data/library.json:
//   users   [name]                       (usernames only, never IDs)
//   songs   [game, title, lengthSec|null, communityRating|null, raters, [tags],
//            album, disc, track, altGame, altTitle]
//           altGame / altTitle = the real game / title of a disguised song:
//           searched by the Game / Title filters, never shown.
//   ratings [songIx, userIx, rating]     (each rater's latest rating)

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString();

// key, heading, filter kind, on by default. 'urating' turns on/off with 'user'
// (one "User Ratings" choice for the two columns). fill = shares the space the
// other columns leave (by this weight) until the visitor sets its width.
const COLS = [
    { key: 'game', label: 'Game', filter: 'text', ph: 'Game', on: true, fill: 4 },
    { key: 'title', label: 'Title', filter: 'text', ph: 'Title', on: true, fill: 5 },
    { key: 'length', label: 'Length', filter: 'range', ph: ['min', 'max'], on: true },
    { key: 'rating', label: 'Community Rating', filter: 'range', ph: ['min', 'max'], on: true, rated: true },
    { key: 'raters', label: '# of Ratings', filter: 'range', ph: ['min', 'max'], on: true },
    { key: 'tags', label: 'Tags', filter: 'text', ph: 'Tag', on: false, fill: 3 },
    { key: 'user', label: 'User', filter: 'text', ph: 'Username', on: false, perRating: true, width: 160 },
    { key: 'urating', label: 'User Rating', filter: 'range', ph: ['min', 'max'], on: false, perRating: true },
];
const CHOICES = [
    { label: 'Game', keys: ['game'] },
    { label: 'Title', keys: ['title'] },
    { label: 'Length', keys: ['length'] },
    { label: 'Community Rating', keys: ['rating'] },
    { label: '# of Ratings', keys: ['raters'] },
    { label: 'Tags', keys: ['tags'] },
    { label: 'User Ratings', keys: ['user', 'urating'] },
];
const STORE = 'playlist.columns.v1';
const WIDTH_STORE = 'playlist.widths.v1';

let D = null;
let songs = [];                  // song objects
const shown = {};                // column key -> visible
const sortState = { col: null, dir: 1 };
const filters = {};              // text: key -> string; range: key + '.min' / '.max'; 'rating.state': '' | 'rated' | 'unrated'
let widths = {};                 // column key -> px the visitor set (dragged); others are automatic
let lastW = {};                  // column key -> px as last laid out

const load = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };

// ------------------------------------------------------------------ load

fetch('data/library.json', { cache: 'no-cache' })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(init)
    .catch(() => {
        $('#info').textContent = 'Could not load the music library. Try refreshing the page.';
        $('#updated').textContent = '';
    });

function init(data) {
    D = data;
    songs = D.songs.map((s, i) => ({
        i, game: s[0], title: s[1], length: s[2], rating: s[3], raters: s[4], tags: s[5],
        album: s[6], disc: s[7], track: s[8],
        gameKey: (s[0] + '\n' + s[9]).toLowerCase(),
        titleKey: (s[1] + '\n' + s[10]).toLowerCase(),
        tagKeys: s[5].map(t => t.toLowerCase()),
        ratings: [],
    }));
    for (const [si, ui, r] of D.ratings) songs[si].ratings.push({ user: D.users[ui], userKey: D.users[ui].toLowerCase(), r });
    // A song's raters: highest rating first, ties alphabetically.
    for (const s of songs) s.ratings.sort((a, b) => b.r - a.r || a.userKey.localeCompare(b.userKey));
    // The library's own order: album, disc, track, title.
    const order = [...songs].sort((a, b) => a.album.localeCompare(b.album) || a.disc - b.disc || a.track - b.track
        || a.title.localeCompare(b.title) || a.i - b.i);
    order.forEach((s, k) => { s.ord = k; });

    const saved = load(STORE);
    for (const c of COLS) shown[c.key] = saved && typeof saved[c.key] === 'boolean' ? saved[c.key] : c.on;
    shown.urating = shown.user;
    const w = load(WIDTH_STORE);
    if (w && typeof w === 'object') for (const c of COLS) if (Number.isFinite(w[c.key])) widths[c.key] = Math.max(minWidth(c), w[c.key]);
    renderChooser();

    $('#reset').addEventListener('click', () => {
        clearTimeout(render.t);
        for (const k of Object.keys(filters)) delete filters[k];
        render();
    });
    let t = 0;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(applyWidths, 100); });

    $("#updated").textContent = `Updated ${new Date(D.updated).toLocaleString()} · refreshed about every 15 minutes`;
    render();
}

// ------------------------------------------------------------------ columns

function renderChooser() {
    $('#columns').innerHTML = '<span class="lbl">Columns:</span>' + CHOICES.map((ch, k) =>
        `<label class="chip${shown[ch.keys[0]] ? ' on' : ''}"><input type="checkbox" data-c="${k}"${shown[ch.keys[0]] ? ' checked' : ''}>${esc(ch.label)}</label>`).join('');
    $('#columns').querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => {
        for (const key of CHOICES[+cb.dataset.c].keys) {
            shown[key] = cb.checked;
            if (!cb.checked && sortState.col === key) sortState.col = null;
        }
        if (!COLS.some(c => shown[c.key])) { cb.checked = true; for (const key of CHOICES[+cb.dataset.c].keys) shown[key] = true; }
        save(STORE, shown);
        renderChooser();
        render();
    }));
}

const visible = () => COLS.filter(c => shown[c.key]);
const perRating = () => shown.user || shown.urating;

// ------------------------------------------------------------------ widths

// Heading text is measured, so a column's default and its narrowest are set by
// its own heading (wider headings, wider columns), whatever font the browser has.
let ctx = null;
function textWidth(s) {
    if (!ctx) {
        ctx = document.createElement('canvas').getContext('2d');
        ctx.font = `600 16px ${getComputedStyle(document.body).fontFamily}`;
    }
    return Math.ceil(ctx.measureText(s).width);
}
const HEAD_PAD = 28 + 16;        // th padding + room for the sort arrow
const FILTER_MIN = { range: 104, text: 80 };   // two 40 px boxes / one box, plus padding

// Narrowest: the heading may wrap onto lines, but no word may be cut, and the filter must fit.
function minWidth(c) {
    const word = Math.max(...c.label.split(' ').map(textWidth));
    return Math.max(word + HEAD_PAD, FILTER_MIN[c.filter]);
}
// Default for a non-fill column: its heading on one line.
const baseWidth = c => Math.max(c.width || 0, textWidth(c.label) + HEAD_PAD, minWidth(c));

// Columns the visitor sized keep their width; the others take their default, and
// fill columns share what is left of the page width so nothing is pushed out of sight.
function layoutWidths(cols) {
    const avail = $('#library').clientWidth;
    const w = {};
    let used = 0, weight = 0;
    for (const c of cols) {
        if (widths[c.key] != null) w[c.key] = widths[c.key];
        else if (c.fill) { weight += c.fill; continue; }
        else w[c.key] = baseWidth(c);
        used += w[c.key];
    }
    const left = Math.max(0, avail - used);
    for (const c of cols) if (w[c.key] == null) w[c.key] = Math.max(140, minWidth(c), Math.floor(left * c.fill / weight));
    return w;
}

function applyWidths() {
    const table = $('#library table.lib');
    if (!table) return;
    const cols = visible();
    lastW = layoutWidths(cols);
    let total = 0;
    for (const c of cols) {
        table.querySelector(`col[data-k="${c.key}"]`).style.width = lastW[c.key] + 'px';
        total += lastW[c.key];
    }
    table.style.width = total + 'px';
}

// Drag a column's right edge to size it; double-click the edge for its automatic width again.
function startDrag(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget, key = grip.dataset.k;
    const col = COLS.find(c => c.key === key);
    const x0 = e.clientX, w0 = lastW[key];
    let x = x0, raf = 0, moved = false;
    grip.setPointerCapture(e.pointerId);
    const move = ev => {
        x = ev.clientX;
        if (!moved) {
            if (Math.abs(x - x0) < 3) return;
            moved = true;
            document.body.classList.add('resizing');
            // Only the dragged column may change size: pin the fill columns where they are.
            for (const c of visible()) if (c.fill && widths[c.key] == null) widths[c.key] = lastW[c.key];
        }
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; widths[key] = Math.max(minWidth(col), Math.round(w0 + x - x0)); applyWidths(); });
    };
    const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        document.body.classList.remove('resizing');
        if (moved) save(WIDTH_STORE, widths);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
}

// ------------------------------------------------------------------ rows

// One row per song; with User Ratings shown, one row per rating (a song with
// no ratings keeps one row with an empty rating).
function allRows() {
    const rows = [];
    const split = perRating();
    for (const s of songs) {
        if (!split || !s.ratings.length) rows.push({ s, rt: null });
        else for (const rt of s.ratings) rows.push({ s, rt });
    }
    return rows;
}

// Length filter: "3:30" = mm:ss, a plain number = minutes.
function parseLen(v) {
    v = v.trim();
    if (!v) return NaN;
    if (v.includes(':')) {
        const p = v.split(':').map(Number);
        return p.some(isNaN) ? NaN : p.reduce((a, x) => a * 60 + x, 0);
    }
    return parseFloat(v) * 60;
}
const parseNum = v => v.trim() ? parseFloat(v) : NaN;

function inRange(key, value, parse) {
    const lo = (parse || parseNum)(filters[key + '.min'] || ''), hi = (parse || parseNum)(filters[key + '.max'] || '');
    if (isNaN(lo) && isNaN(hi)) return true;
    if (value == null) return false;
    return (isNaN(lo) || value >= lo) && (isNaN(hi) || value <= hi);
}

// Community Rating: "Unrated" shows only songs nobody has rated (min / max don't
// apply), "Rated" only rated ones, "All" both.
function ratingOk(s) {
    const state = filters['rating.state'] || '';
    if (state === 'unrated') return s.rating == null;
    if (state === 'rated' && s.rating == null) return false;
    return inRange('rating', s.rating);
}

function filterRows(rows) {
    const t = k => shown[k] ? (filters[k] || '').trim().toLowerCase() : '';
    const game = t('game'), title = t('title'), tag = t('tags'), user = t('user');
    const on = k => shown[k];
    return rows.filter(({ s, rt }) =>
        (!game || s.gameKey.includes(game)) &&
        (!title || s.titleKey.includes(title)) &&
        (!on('length') || inRange('length', s.length, parseLen)) &&
        (!on('rating') || ratingOk(s)) &&
        (!on('raters') || inRange('raters', s.raters)) &&
        (!tag || s.tagKeys.some(x => x.includes(tag))) &&
        (!user || (rt && rt.userKey.includes(user))) &&
        (!on('urating') || inRange('urating', rt ? rt.r : null)));
}

const anyFilter = () => Object.values(filters).some(v => v && String(v).trim());

// [missing, value]: missing values sort last in BOTH directions.
const SORT_KEY = {
    game: ({ s }) => [0, s.game.toLowerCase()],
    title: ({ s }) => [0, s.title.toLowerCase()],
    length: ({ s }) => [s.length == null ? 1 : 0, s.length ?? 0],
    rating: ({ s }) => [s.rating == null ? 1 : 0, s.rating ?? 0],
    raters: ({ s }) => [0, s.raters],
    tags: ({ s }) => [s.tags.length ? 0 : 1, s.tagKeys.join(', ')],
    user: ({ rt }) => [rt ? 0 : 1, rt ? rt.userKey : ''],
    urating: ({ rt }) => [rt ? 0 : 1, rt ? rt.r : 0],
};
// Library order, then a song's ratings highest first, ties alphabetically.
const defaultOrder = (a, b) => a.s.ord - b.s.ord || (a.rt && b.rt ? b.rt.r - a.rt.r || a.rt.userKey.localeCompare(b.rt.userKey) : 0);

function sortRows(rows) {
    const { col, dir } = sortState;
    if (!col) return rows.sort(defaultOrder);
    const key = SORT_KEY[col];
    return rows.sort((a, b) => {
        const ka = key(a), kb = key(b);
        if (ka[0] !== kb[0]) return ka[0] - kb[0];
        const c = ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0;
        return c * dir || defaultOrder(a, b);
    });
}

// ------------------------------------------------------------------ render

const lenText = n => {
    if (n == null) return '';
    const h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = String(n % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};
const ratingText = r => r == null ? '' : r.toFixed(1);   // ratings are given to 1 decimal

function cellHtml(key, { s, rt }) {
    switch (key) {
        case 'game': return esc(s.game);
        case 'title': return esc(s.title);
        case 'length': return s.length == null ? '<span class="dim">?</span>' : lenText(s.length);
        case 'rating': return s.rating == null ? '<span class="dim">Unrated</span>' : s.rating.toFixed(2);
        case 'raters': return s.raters ? fmt(s.raters) : '<span class="dim">0</span>';
        case 'tags': return s.tags.length ? esc(s.tags.join(', ')) : '';
        case 'user': return rt ? esc(rt.user) : '<span class="dim">-</span>';
        case 'urating': return rt ? ratingText(rt.r) : '<span class="dim">-</span>';
    }
    return '';
}

function filterRowHtml(cols) {
    const txt = c => `<input type="text" data-f="${c.key}" value="${esc(filters[c.key] || '')}" placeholder="${c.ph}">`;
    const rng = c => {
        const off = c.rated && filters['rating.state'] === 'unrated' ? ' disabled' : '';
        let h = `<div class="range">` +
            `<input type="text" inputmode="decimal" data-f="${c.key}.min" value="${esc(filters[c.key + '.min'] || '')}" placeholder="${c.ph[0]}"${off}>` +
            `<input type="text" inputmode="decimal" data-f="${c.key}.max" value="${esc(filters[c.key + '.max'] || '')}" placeholder="${c.ph[1]}"${off}></div>`;
        if (c.rated) {
            const st = filters['rating.state'] || '';
            h += `<select data-s="${c.key}.state" title="Rated songs, unrated songs, or both">` +
                [['', 'All'], ['rated', 'Rated'], ['unrated', 'Unrated']].map(([v, t]) =>
                    `<option value="${v}"${v === st ? ' selected' : ''}>${t}</option>`).join('') + '</select>';
        }
        return h;
    };
    return '<tr class="filters">' + cols.map(c => `<th class="c-${c.key}">${c.filter === 'range' ? rng(c) : txt(c)}</th>`).join('') + '</tr>';
}

function render() {
    const cols = visible();
    const all = allRows();
    const rows = sortRows(filterRows(all));

    // Song columns merge across adjacent rows of the same song (User Ratings shown).
    const span = new Array(rows.length).fill(0);
    let start = 0;
    rows.forEach((r, i) => { if (i === 0 || r.s !== rows[i - 1].s) start = i; span[start]++; });

    const head = '<tr class="heads">' + cols.map(c => {
        const on = sortState.col === c.key;
        return `<th class="sortable c-${c.key}" data-sort="${c.key}"><span class="lbl">${c.label}${on ? `<span class="arrow">${sortState.dir > 0 ? '▲' : '▼'}</span>` : ''}</span>` +
            `<span class="grip" data-k="${c.key}" title="Drag to resize · double-click to reset"><i>◂</i><i>▸</i></span></th>`;
    }).join('') + '</tr>' + filterRowHtml(cols);

    // Shading alternates per SONG, so a song's merged cells and its rating rows share one shade.
    const parts = [];
    let song = -1;
    rows.forEach((r, i) => {
        if (span[i]) song++;
        let h = `<tr class="${span[i] ? 'first' : ''}${song % 2 ? ' alt' : ''}">`;
        for (const c of cols) {
            if (c.perRating) h += `<td class="c-${c.key}">${cellHtml(c.key, r)}</td>`;
            else if (span[i]) h += `<td class="c-${c.key}"${span[i] > 1 ? ` rowspan="${span[i]}"` : ''}>${cellHtml(c.key, r)}</td>`;
        }
        parts.push(h + '</tr>');
    });
    const body = parts.join('') || `<tr><td colspan="${cols.length}" class="dim">No songs match these filters.</td></tr>`;

    const nSongs = new Set(rows.map(r => r.s)).size;
    const ratingsInfo = perRating() ? ` · ${fmt(rows.filter(r => r.rt).length)} ratings` : '';
    $('#info').textContent = (nSongs === songs.length ? `Showing ${fmt(songs.length)} songs`
        : `Showing ${fmt(nSongs)} of ${fmt(songs.length)} songs`) + ratingsInfo + ' · click a heading to sort, drag its edge to resize';
    $('#reset').disabled = !anyFilter();

    const el = $('#library');
    const colgroup = '<colgroup>' + cols.map(c => `<col data-k="${c.key}">`).join('') + '</colgroup>';
    el.innerHTML = `<div class="scroll"><table class="lib">${colgroup}<thead>${head}</thead><tbody>${body}</tbody></table></div>`;
    applyWidths();

    el.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
        const c = th.dataset.sort;
        if (sortState.col !== c) { sortState.col = c; sortState.dir = 1; }
        else if (sortState.dir > 0) sortState.dir = -1;
        else sortState.col = null;      // third click: back to the library's order
        render();
    }));
    el.querySelectorAll('.grip').forEach(g => {
        g.addEventListener('pointerdown', startDrag);
        g.addEventListener('click', e => e.stopPropagation());     // never a sort click
        g.addEventListener('dblclick', e => {
            e.stopPropagation();
            delete widths[g.dataset.k];
            save(WIDTH_STORE, widths);
            applyWidths();
        });
    });
    el.querySelectorAll('select[data-s]').forEach(sel => sel.addEventListener('change', () => {
        filters[sel.dataset.s] = sel.value;
        render();
        const again = el.querySelector(`select[data-s="${sel.dataset.s}"]`);
        if (again) again.focus();
    }));
    el.querySelectorAll('input[data-f]').forEach(inp => inp.addEventListener('input', () => {
        filters[inp.dataset.f] = inp.value;
        clearTimeout(render.t);
        // Up to ~16,000 rows with User Ratings shown: wait for a pause in typing.
        render.t = setTimeout(() => {
            const focus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.f : null;
            const pos = focus ? document.activeElement.selectionStart : null;
            render();
            if (focus) {   // re-rendering replaces the inputs: keep typing where you were
                const again = el.querySelector(`[data-f="${focus}"]`);
                if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
            }
        }, 200);
    }));
}
