// Doodle deník – logika stránky.
// Čisté ES moduly bez build kroku. Firebase se načítá z CDN až ve chvíli,
// kdy je vyplněný firebase-config.js; bez něj stránka běží jen na čtení.

import { firebaseConfig } from './firebase-config.js';

const FIREBASE_VERSION = '13.2.0';
const FIREBASE_CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
const YT_API_URL = 'https://www.youtube.com/iframe_api';
const SAVE_DELAY_MS = 600;
const LOADING_FALLBACK_MS = 6000;
const SNAPSHOT_TIMEOUT_MS = 12000;
const STICKY_QUERY = '(max-width: 760px) and (orientation: portrait)';
const RAINBOW_SIZE = 7;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const stickyPlayer = window.matchMedia(STICKY_QUERY);
const scrollBehavior = () => (reduceMotion.matches ? 'auto' : 'smooth');

const svg = (body, extra = '') =>
  `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" ${extra}>${body}</svg>`;
const stroke = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  check: svg('<path d="M3.2 8.6l3 3L12.8 5" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>'),
  grip: svg(`<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" ${stroke}/>`),
  top: svg(`<path d="M3 2.6h10M8 13.4V5.6M4.6 9L8 5.6 11.4 9" ${stroke}/>`),
  up5: svg(`<path d="M5 13.4V3.2M2.2 6L5 3.2 7.8 6M11 13.4V3.2M8.2 6L11 3.2 13.8 6" ${stroke}/>`),
  up1: svg('<path d="M8 3.6l5.2 8H2.8z" fill="currentColor"/>'),
  down1: svg('<path d="M8 12.4l-5.2-8h10.4z" fill="currentColor"/>'),
  down5: svg(`<path d="M5 2.6v10.2M2.2 10L5 12.8 7.8 10M11 2.6v10.2M8.2 10L11 12.8 13.8 10" ${stroke}/>`),
  end: svg(`<path d="M3 13.4h10M8 2.6v7.8M4.6 7L8 10.4 11.4 7" ${stroke}/>`),
};

// Pořadí tlačítek odpovídá pořadí v DOM (a tedy pořadí pro Tab).
const MOVES = [
  { key: 'top', label: 'Na začátek', target: () => 0 },
  { key: 'up5', label: 'O 5 nahoru', target: (i) => i - 5 },
  { key: 'up1', label: 'O 1 nahoru', target: (i) => i - 1 },
  { key: 'down1', label: 'O 1 dolů', target: (i) => i + 1 },
  { key: 'down5', label: 'O 5 dolů', target: (i) => i + 5 },
  { key: 'end', label: 'Na konec', target: (i, n) => n - 1 },
];
const UP_MOVES = new Set(['top', 'up5', 'up1']);

const $ = (id) => document.getElementById(id);
const els = {
  loginTop: $('login-top'),
  progressCount: $('progress-count'),
  progressPct: $('progress-pct'),
  mosaic: $('mosaic'),
  notices: $('notices'),
  nextBody: $('next-body'),
  player: $('player'),
  playerMessage: $('player-message'),
  playerMessageText: $('player-message-text'),
  playerMessageLink: $('player-message-link'),
  playerTitle: $('player-title'),
  playerDone: $('player-done'),
  playerYt: $('player-yt'),
  remainingHeading: $('zbyva-nadpis'),
  remainingCount: $('remaining-count'),
  remainingHint: $('remaining-hint'),
  listRemaining: $('list-remaining'),
  remainingEmpty: $('remaining-empty'),
  doneSection: $('done-section'),
  doneCount: $('done-count'),
  listDone: $('list-done'),
  doneEmpty: $('done-empty'),
  accountBody: $('account-body'),
  toast: $('toast'),
  announcer: $('announcer'),
};

// phase: 'loading' | 'disabled' | 'guest' | 'user-loading' | 'user' | 'user-error'
const state = {
  videos: [],
  byId: new Map(),
  phase: 'loading',
  loadingExpired: false,
  user: null,
  order: [],
  done: {},
  playingId: null,
};

const fb = {}; // načtené moduly a instance Firebase
const sync = {
  ref: null,
  unsubscribe: null,
  saveTimer: null,
  lastSyncedJson: null,
  seeding: false,
  snapshotTimer: null,
};
const yt = { apiPromise: null, player: null, ready: false, loadedId: null };
const rowCache = new Map();
const dotCache = new Map();
const notices = new Map();
let mosaicFocusId = null;
let loadingTimer = null;
let drag = null;
let toastTimer = null;
let accountSignature = '';

/* ---------- Pomocné funkce ---------- */

const canEdit = () => state.phase === 'user';
const isLoading = () => (state.phase === 'loading' || state.phase === 'user-loading') && !state.loadingExpired;
const isDone = (id) => Object.prototype.hasOwnProperty.call(state.done, id) && Boolean(state.done[id]);
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const pad2 = (n) => String(n).padStart(2, '0');

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[3])}.\u00a0${Number(m[2])}.\u00a0${m[1]}` : '';
}

function videoWord(n) {
  if (n === 1) return 'video';
  if (n >= 2 && n <= 4) return 'videa';
  return 'videí';
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children);
  return node;
}

// Čtvercové náhledy 144x144 vyrábí scripts/make_thumbs.py. Když soubor ještě
// chybí (nové video před během workflow), obrázek zmizí a zůstane šedý čtverec.
function thumbImg(id, { lazy = true } = {}) {
  const img = el('img', {
    src: `thumbs/${encodeURIComponent(id)}.jpg`,
    alt: '',
    width: '72',
    height: '72',
    loading: lazy ? 'lazy' : undefined,
    decoding: 'async',
  });
  img.addEventListener('error', () => img.remove(), { once: true });
  return img;
}

const youtubeUrl = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

function announce(text) {
  els.announcer.textContent = '';
  window.setTimeout(() => {
    els.announcer.textContent = text;
  }, 30);
}

function showToast(text, ms = 3200) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
}

function flash(node) {
  if (!node) return;
  node.classList.remove('flash');
  void node.offsetWidth; // restart přechodu
  node.classList.add('flash');
  window.setTimeout(() => node.classList.remove('flash'), 1400);
}

/* ---------- Data a pořadí ---------- */

async function loadVideos() {
  const res = await fetch('data/videos.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('videos.json není pole');
  const seen = new Set();
  state.videos = raw.filter((v) => {
    const ok = v && typeof v.id === 'string' && v.id && !seen.has(v.id);
    if (ok) seen.add(v.id);
    return ok;
  }).map((v) => ({
    id: v.id,
    title: typeof v.title === 'string' && v.title.trim() ? v.title.trim() : v.id,
    duration: typeof v.duration === 'string' ? v.duration : '',
  }));
  state.byId = new Map(state.videos.map((v) => [v.id, v]));
}

function sanitizeDone(done) {
  const out = {};
  if (done && typeof done === 'object' && !Array.isArray(done)) {
    for (const [id, date] of Object.entries(done)) {
      if (typeof date === 'string' && date) out[id] = date;
    }
  }
  return out;
}

// Videa, která v order chybí, přidá na konec; ta, která už nejsou ve videos.json, vyřadí.
// Záznamy v done zůstávají celé (kdyby se video do playlistu vrátilo).
function normalize({ done, order }) {
  const known = state.byId;
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(order) ? order : []) {
    if (typeof id === 'string' && known.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const v of state.videos) {
    if (!seen.has(v.id)) out.push(v.id);
  }
  return { done: sanitizeDone(done), order: out };
}

function buildView() {
  const total = state.videos.length;
  if (!canEdit()) {
    return { editable: false, remaining: state.videos.map((v) => v.id), done: [], total, doneCount: 0 };
  }
  const position = new Map(state.order.map((id, i) => [id, i]));
  const remaining = [];
  const done = [];
  for (const id of state.order) (isDone(id) ? done : remaining).push(id);
  done.sort((a, b) => cmp(state.done[a], state.done[b]) || position.get(a) - position.get(b));
  return { editable: true, remaining, done, total, doneCount: done.length };
}

// Posune video mezi nehotovými na nový index (index v seznamu "Zbývá").
// Hotová videa zůstávají ve state.order na svých místech.
function moveRemaining(id, targetIndex) {
  const slots = [];
  const remaining = [];
  state.order.forEach((oid, i) => {
    if (!isDone(oid)) {
      slots.push(i);
      remaining.push(oid);
    }
  });
  const from = remaining.indexOf(id);
  if (from < 0) return null;
  const to = clamp(targetIndex, 0, remaining.length - 1);
  if (to === from) return null;
  remaining.splice(from, 1);
  remaining.splice(to, 0, id);
  const next = state.order.slice();
  slots.forEach((slot, k) => {
    next[slot] = remaining[k];
  });
  state.order = next;
  return { from, to, count: remaining.length };
}

/* ---------- Vykreslení ---------- */

function render(opts = {}) {
  const active = document.activeElement;
  const activeKey = active && active.dataset ? active.dataset.key : null;
  const view = buildView();
  renderProgress(view);
  renderMosaic(view);
  renderNext(view);
  renderLists(view);
  renderPlayerBar();
  renderAccount();
  restoreFocus(opts.focusKey || activeKey, opts);
}

function restoreFocus(key, opts) {
  if (!key) return;
  let target = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (target && target.disabled) {
    const row = target.closest('.row');
    const fallbacks = UP_MOVES.has(target.dataset.move)
      ? ['down1', 'down5', 'end']
      : ['up1', 'up5', 'top'];
    target =
      fallbacks.map((k) => row && row.querySelector(`[data-move="${k}"]:not(:disabled)`)).find(Boolean) ||
      (row && row.querySelector('.play-btn'));
  }
  if (!target || target.closest('[hidden]')) {
    if (opts.focusFallback) opts.focusFallback.focus({ preventScroll: true });
    return;
  }
  if (document.activeElement !== target) target.focus({ preventScroll: opts.preventScroll !== false });
}

function renderProgress(view) {
  if (isLoading()) {
    els.progressCount.textContent = `… / ${view.total}`;
    els.progressPct.hidden = true;
    return;
  }
  if (view.editable) {
    const pct = view.total ? Math.round((view.doneCount / view.total) * 100) : 0;
    els.progressCount.textContent = `${view.doneCount} / ${view.total}`;
    els.progressPct.textContent = `${pct}\u00a0%`;
    els.progressPct.hidden = false;
  } else {
    els.progressCount.textContent = `${view.total} ${videoWord(view.total)}`;
    els.progressPct.hidden = true;
  }
}

function renderMosaic(view) {
  const ids = isLoading() ? [] : [...view.done, ...view.remaining];
  if (!ids.includes(mosaicFocusId)) mosaicFocusId = ids[0] || null;
  const dots = ids.map((id, i) => {
    let dot = dotCache.get(id);
    if (!dot) {
      dot = el('button', { type: 'button', className: 'dot', dataset: { action: 'dot', id, key: `dot:${id}` } });
      dotCache.set(id, dot);
    }
    const video = state.byId.get(id);
    const done = view.editable && isDone(id);
    dot.classList.toggle('is-done', done);
    dot.style.setProperty('--c', `var(--r${(i % RAINBOW_SIZE) + 1})`);
    dot.setAttribute('aria-label', `${video.title} (${done ? 'hotovo' : 'zbývá'})`);
    dot.title = video.title;
    dot.tabIndex = id === mosaicFocusId ? 0 : -1;
    return dot;
  });
  syncChildren(els.mosaic, dots);
}

let nextMeta = null;

function renderNext(view) {
  const nextId = isLoading() ? null : view.remaining[0];
  const video = nextId ? state.byId.get(nextId) : null;
  const metaText = video ? `${video.duration}${view.editable ? ` · zbývá ${view.remaining.length}` : ''}` : '';
  const signature = isLoading() ? 'loading' : `${nextId || 'none'}|${view.total}`;
  if (els.nextBody.dataset.sig === signature) {
    if (nextMeta) nextMeta.textContent = metaText;
    return;
  }
  els.nextBody.dataset.sig = signature;
  nextMeta = null;

  if (isLoading()) {
    els.nextBody.replaceChildren(el('p', { className: 'muted', text: 'Načítám…' }));
    return;
  }
  if (!nextId) {
    els.nextBody.replaceChildren(
      el('p', { className: 'next-empty', text: view.total ? 'Všechno je hotové. Krásná práce!' : 'Seznam videí je prázdný.' }),
    );
    return;
  }
  nextMeta = el('p', { className: 'row-meta', text: metaText });
  els.nextBody.replaceChildren(
    el('div', { className: 'next-video' }, [
      el('button', {
        type: 'button',
        className: 'thumb',
        tabindex: '-1',
        'aria-hidden': 'true',
        dataset: { action: 'play', id: nextId },
      }, [thumbImg(nextId, { lazy: false })]),
      el('div', { className: 'next-text' }, [
        el('p', { className: 'next-title', text: video.title }),
        nextMeta,
      ]),
      el('button', {
        type: 'button',
        className: 'pill next-play',
        'aria-label': `Pustit: ${video.title}`,
        dataset: { action: 'play', id: nextId, key: 'next-play' },
        text: 'Pustit',
      }),
    ]),
  );
}

function getRow(id) {
  let row = rowCache.get(id);
  if (row) return row;
  const video = state.byId.get(id);
  row = el('li', { className: 'row', dataset: { id } });
  const handle = el('span', { className: 'handle', 'aria-hidden': 'true', title: 'Přetáhnout', html: ICONS.grip });
  const check = el('button', {
    type: 'button',
    className: 'check',
    role: 'checkbox',
    'aria-checked': 'false',
    'aria-label': `Hotovo: ${video.title}`,
    dataset: { action: 'toggle', id, key: `check:${id}` },
    html: ICONS.check,
  });
  const thumb = el('button', {
    type: 'button',
    className: 'thumb',
    tabindex: '-1',
    'aria-hidden': 'true',
    dataset: { action: 'play', id },
  }, [thumbImg(id)]);
  const title = el('p', { className: 'row-title', text: video.title, title: video.title });
  const meta = el('p', { className: 'row-meta' });
  const text = el('div', { className: 'row-text' }, [title, meta]);
  const play = el('button', {
    type: 'button',
    className: 'pill pill-small play-btn',
    'aria-label': `Pustit: ${video.title}`,
    dataset: { action: 'play', id, key: `play:${id}` },
    text: 'Pustit',
  });
  const moveButtons = MOVES.map((m) =>
    el('button', {
      type: 'button',
      className: `icon-btn move-btn move-${m.key}`,
      'aria-label': `${m.label}: ${video.title}`,
      title: m.label,
      dataset: { action: 'move', move: m.key, id, key: `move:${m.key}:${id}` },
      html: ICONS[m.key],
    }),
  );
  const move = el('div', { className: 'move', role: 'group', 'aria-label': `Pořadí: ${video.title}` }, moveButtons);
  const actions = el('div', { className: 'row-actions' }, [play, move]);
  row.append(handle, check, thumb, text, actions);
  row._refs = { check, meta, moveButtons };
  rowCache.set(id, row);
  return row;
}

function updateRow(id, mode, index, count) {
  const row = getRow(id);
  const video = state.byId.get(id);
  const done = mode === 'done';
  const playing = id === state.playingId;
  row.classList.remove('mode-guest', 'mode-remaining', 'mode-done');
  row.classList.add(`mode-${mode}`);
  row.classList.toggle('is-done', done);
  row.classList.toggle('is-playing', playing);
  if (!drag || drag.row !== row) row.draggable = false;
  row._refs.check.setAttribute('aria-checked', String(done));
  const parts = [video.duration];
  if (done && formatDate(state.done[id])) parts.push(`hotovo\u00a0${formatDate(state.done[id])}`);
  else if (done) parts.push('hotovo');
  row._refs.meta.replaceChildren(
    document.createTextNode(parts.filter(Boolean).join(' · ')),
    ...(playing ? [el('span', { className: 'tag', text: 'hraje' })] : []),
  );
  for (const btn of row._refs.moveButtons) {
    const up = UP_MOVES.has(btn.dataset.move);
    btn.disabled = mode !== 'remaining' || (up ? index === 0 : index === count - 1);
  }
  return row;
}

function syncChildren(parent, nodes) {
  const wanted = new Set(nodes);
  for (const child of [...parent.children]) {
    if (!wanted.has(child)) child.remove();
  }
  nodes.forEach((node, i) => {
    if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] || null);
  });
}

function renderLists(view) {
  const loading = isLoading();
  const remainingIds = loading ? [] : view.remaining;
  const remainingMode = view.editable ? 'remaining' : 'guest';
  const rows = remainingIds.map((id, i) => updateRow(id, remainingMode, i, remainingIds.length));
  syncChildren(els.listRemaining, rows);
  els.listRemaining.setAttribute('aria-busy', String(loading));
  els.remainingCount.textContent = loading ? '' : `(${remainingIds.length})`;

  els.remainingEmpty.hidden = !loading && remainingIds.length > 0;
  els.remainingEmpty.textContent = loading
    ? 'Načítám…'
    : view.total
      ? 'Všechno hotovo. Krásná práce!'
      : 'Seznam videí je prázdný.';

  let hint = '';
  if (state.phase === 'guest') hint = 'Odškrtávat hotová videa a měnit pořadí jde po přihlášení.';
  else if ((state.phase === 'loading' || state.phase === 'user-loading') && state.loadingExpired) hint = 'Načítám uložený stav…';
  els.remainingHint.textContent = hint;
  els.remainingHint.hidden = !hint;

  els.doneSection.hidden = !view.editable;
  const doneRows = view.editable ? view.done.map((id, i) => updateRow(id, 'done', i, view.done.length)) : [];
  syncChildren(els.listDone, doneRows);
  els.doneCount.textContent = `(${doneRows.length})`;
  els.doneEmpty.hidden = doneRows.length > 0;
}

function renderPlayerBar() {
  const id = state.playingId;
  if (!id) return;
  const video = state.byId.get(id);
  els.playerTitle.textContent = video ? video.title : '';
  els.playerTitle.title = video ? video.title : '';
  els.playerYt.href = youtubeUrl(id);
  els.playerYt.setAttribute('aria-label', `Otevřít na YouTube: ${video ? video.title : id}`);
  els.playerMessageLink.href = youtubeUrl(id);
  const done = canEdit() && isDone(id);
  els.playerDone.hidden = !canEdit();
  els.playerDone.setAttribute('aria-pressed', String(done));
  els.playerDone.classList.toggle('is-done', done);
  els.playerDone.innerHTML = done ? `${ICONS.check}<span>Hotovo</span>` : '<span>Hotovo</span>';
  els.playerDone.setAttribute(
    'aria-label',
    done ? `Hotovo: ${video.title}. Opětovným stisknutím vrátíš mezi zbývající.` : `Označit jako hotové: ${video.title}`,
  );
}

function renderAccount() {
  const signature = `${state.phase}|${state.user ? state.user.uid : ''}|${state.user ? state.user.email : ''}`;
  if (signature === accountSignature) return;
  accountSignature = signature;
  const active = document.activeElement;
  const activeKey = active && els.accountBody.contains(active) ? active.dataset.key : null;

  els.loginTop.hidden = state.phase !== 'guest';
  let content;
  if (state.phase === 'disabled') {
    content = [el('p', { className: 'muted', text: 'Přihlášení není k dispozici, protože chybí konfigurace Firebase (soubor firebase-config.js).' })];
  } else if (state.phase === 'loading') {
    content = [el('p', { className: 'muted', text: 'Načítám…' })];
  } else if (state.phase === 'guest' || !state.user) {
    content = [
      el('p', { className: 'muted', text: 'Nepřihlášeno.' }),
      el('div', { className: 'account-row' }, [
        el('button', { type: 'button', className: 'pill pill-small', dataset: { action: 'login', key: 'account-login' }, text: 'Přihlásit se přes Google' }),
      ]),
    ];
  } else {
    content = [
      el('div', { className: 'account-row' }, [
        el('span', { className: 'account-label', text: 'E-mail' }),
        el('span', { className: 'account-value', text: state.user.email || '(bez e-mailu)' }),
        el('button', { type: 'button', className: 'pill pill-quiet pill-small', dataset: { action: 'logout', key: 'account-logout' }, text: 'Odhlásit' }),
      ]),
      el('div', { className: 'account-row' }, [
        el('label', { className: 'account-label', for: 'uid-input', text: 'Firebase UID' }),
        el('input', { className: 'uid-input', id: 'uid-input', type: 'text', readonly: true, value: state.user.uid, spellcheck: 'false' }),
        el('button', { type: 'button', className: 'pill pill-quiet pill-small', id: 'copy-uid', dataset: { action: 'copy-uid', key: 'account-copy' }, text: 'Kopírovat' }),
      ]),
      el('p', { className: 'account-note muted', text: 'UID patří do souboru firestore.rules místo VLOZ_SVOJE_UID.' }),
    ];
  }
  els.accountBody.replaceChildren(...content);
  if (activeKey) {
    const again = els.accountBody.querySelector(`[data-key="${CSS.escape(activeKey)}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

function setNotice(key, notice) {
  if (notice) notices.set(key, notice);
  else notices.delete(key);
  renderNotices();
}

const noticeNodes = new Map();

function renderNotices() {
  const nodes = [...notices.entries()].map(([key, n]) => {
    const cached = noticeNodes.get(key);
    if (cached && cached.notice === n) return cached.node;
    const actions = (n.actions || []).map((a) =>
      a.href
        ? el('a', { className: 'pill pill-quiet pill-small', href: a.href, target: '_blank', rel: 'noopener', text: a.label })
        : el('button', { type: 'button', className: 'pill pill-quiet pill-small', dataset: { action: a.action }, text: a.label }),
    );
    if (n.dismissible) {
      actions.push(el('button', { type: 'button', className: 'icon-btn notice-close', 'aria-label': 'Zavřít upozornění', dataset: { action: 'dismiss-notice', notice: key }, text: '×' }));
    }
    const node = el('div', { className: `notice notice-${n.tone || 'info'}` }, [
      el('p', { className: 'notice-text' }, [
        ...(n.title ? [el('strong', { text: n.title }), document.createTextNode(' ')] : []),
        document.createTextNode(n.text),
      ]),
      ...(actions.length ? [el('div', { className: 'notice-actions' }, actions)] : []),
    ]);
    noticeNodes.set(key, { notice: n, node });
    return node;
  });
  for (const key of [...noticeNodes.keys()]) if (!notices.has(key)) noticeNodes.delete(key);
  syncChildren(els.notices, nodes);
}

/* ---------- Akce uživatelky ---------- */

function toggleDone(id, source) {
  if (!canEdit() || !state.byId.has(id)) return;
  const wasDone = isDone(id);
  const before = buildView();
  const fromList = wasDone ? before.done : before.remaining;
  const index = fromList.indexOf(id);

  const done = { ...state.done };
  if (wasDone) delete done[id];
  else done[id] = todayISO();
  state.done = done;

  const after = buildView();
  let focusKey;
  if (source === 'row') {
    const list = wasDone ? after.done : after.remaining;
    const nextId = list[index] || list[index - 1];
    focusKey = nextId ? `check:${nextId}` : null;
  }
  render({ focusKey, focusFallback: source === 'row' ? els.remainingHeading : null });
  const title = state.byId.get(id).title;
  announce(
    wasDone
      ? `Vráceno mezi zbývající: ${title}.`
      : `Hotovo: ${title}. Celkem ${after.doneCount} z ${after.total}.`,
  );
  scheduleSave();
}

function moveAction(id, key, event) {
  if (!canEdit()) return;
  const move = MOVES.find((m) => m.key === key);
  const { remaining } = buildView();
  const from = remaining.indexOf(id);
  if (!move || from < 0) return;
  const row = getRow(id);
  const topBefore = row.getBoundingClientRect().top;
  const result = moveRemaining(id, move.target(from, remaining.length));
  if (!result) return;
  render({ focusKey: `move:${key}:${id}`, preventScroll: true });

  const far = key === 'top' || key === 'end';
  const viaKeyboard = event && event.detail === 0;
  if (!far) {
    // Řádek zůstane pod kurzorem, posune se seznam kolem něj.
    window.scrollBy(0, row.getBoundingClientRect().top - topBefore);
  } else if (viaKeyboard) {
    row.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
  } else {
    showToast(`Přesunuto ${key === 'top' ? 'na začátek' : 'na konec'}: ${state.byId.get(id).title}`);
  }
  flash(row);
  announce(`${state.byId.get(id).title}: pozice ${result.to + 1} z ${result.count}.`);
  scheduleSave();
}

function moveToIndex(id, index) {
  if (!canEdit()) return;
  const result = moveRemaining(id, index);
  if (!result) return;
  render();
  flash(getRow(id));
  announce(`${state.byId.get(id).title}: pozice ${result.to + 1} z ${result.count}.`);
  scheduleSave();
}

function goToRow(id) {
  mosaicFocusId = id;
  const row = rowCache.get(id);
  if (!row || !row.isConnected) return;
  row.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
  flash(row);
  const target = row.querySelector(canEdit() ? '.check' : '.play-btn');
  if (target) target.focus({ preventScroll: true });
}

function onMosaicKeydown(event) {
  const dot = event.target.closest('.dot');
  if (!dot) return;
  const dots = [...els.mosaic.children];
  const i = dots.indexOf(dot);
  const perRow = Math.max(1, dots.filter((d) => d.offsetTop === dots[0].offsetTop).length);
  const map = {
    ArrowRight: i + 1,
    ArrowLeft: i - 1,
    ArrowDown: i + perRow,
    ArrowUp: i - perRow,
    Home: 0,
    End: dots.length - 1,
  };
  if (!(event.key in map)) return;
  event.preventDefault();
  const next = dots[clamp(map[event.key], 0, dots.length - 1)];
  dots.forEach((d) => {
    d.tabIndex = d === next ? 0 : -1;
  });
  mosaicFocusId = next.dataset.id;
  next.focus();
}

/* ---------- Přetahování (jen myš) ---------- */

function clearDropMarks() {
  for (const r of els.listRemaining.querySelectorAll('.drop-before, .drop-after')) {
    r.classList.remove('drop-before', 'drop-after');
  }
}

function dropTarget(clientY) {
  const rows = [...els.listRemaining.children].filter((r) => r !== drag.row);
  let index = rows.length;
  for (let i = 0; i < rows.length; i += 1) {
    const box = rows[i].getBoundingClientRect();
    if (clientY < box.top + box.height / 2) {
      index = i;
      break;
    }
  }
  return { index, rows };
}

function bindDrag() {
  const list = els.listRemaining;
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.handle');
    if (!handle || !canEdit() || e.button !== 0) return;
    handle.closest('.row').draggable = true;
  });
  document.addEventListener('pointerup', () => {
    if (drag) return;
    for (const r of list.querySelectorAll('.row[draggable="true"]')) r.draggable = false;
  });
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('.row');
    if (!row || !row.draggable || !canEdit()) {
      e.preventDefault();
      return;
    }
    drag = { id: row.dataset.id, row, from: [...list.children].indexOf(row) };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.id);
    window.requestAnimationFrame(() => row.classList.add('dragging'));
  });
  list.addEventListener('dragover', (e) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const { index, rows } = dropTarget(e.clientY);
    clearDropMarks();
    if (index === drag.from) return; // beze změny
    if (index < rows.length) rows[index].classList.add('drop-before');
    else if (rows.length) rows[rows.length - 1].classList.add('drop-after');
  });
  list.addEventListener('dragleave', (e) => {
    if (drag && !list.contains(e.relatedTarget)) clearDropMarks();
  });
  list.addEventListener('drop', (e) => {
    if (!drag) return;
    e.preventDefault();
    const { index } = dropTarget(e.clientY);
    const { id } = drag;
    endDrag();
    moveToIndex(id, index);
  });
  list.addEventListener('dragend', endDrag);
}

function endDrag() {
  if (drag) {
    drag.row.classList.remove('dragging');
    drag.row.draggable = false;
  }
  drag = null;
  clearDropMarks();
}

/* ---------- Přehrávač YouTube ---------- */

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (yt.apiPromise) return yt.apiPromise;
  yt.apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === 'function') previous();
      resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = YT_API_URL;
    script.async = true;
    script.onerror = () => reject(new Error('YouTube API se nenačetlo'));
    document.head.append(script);
    window.setTimeout(() => reject(new Error('YouTube API neodpovídá')), 15000);
  });
  yt.apiPromise.catch(() => {
    yt.apiPromise = null;
  });
  return yt.apiPromise;
}

function showPlayerMessage(text) {
  els.playerMessageText.textContent = text;
  els.playerMessage.hidden = false;
}

function playerErrorText(code) {
  if (code === 101 || code === 150) return 'YouTube nedovoluje přehrát tohle video mimo svůj web. Pusť si ho přímo na YouTube.';
  if (code === 100) return 'Video se nepodařilo najít. Možná bylo smazáno nebo je soukromé.';
  return 'Video se nepodařilo přehrát. Zkus ho otevřít přímo na YouTube.';
}

function startVideo(id) {
  yt.loadedId = id;
  try {
    yt.player.mute();
    yt.player.loadVideoById(id);
  } catch (err) {
    console.error(err);
    showPlayerMessage(playerErrorText(0));
  }
}

async function play(id) {
  if (!state.byId.has(id)) return;
  state.playingId = id;
  els.playerMessage.hidden = true;
  els.player.hidden = false;
  render();
  updateStickyOffset();
  window.requestAnimationFrame(() => {
    els.player.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
  });

  let YT;
  try {
    YT = await loadYouTubeApi();
  } catch (err) {
    if (state.playingId === id) showPlayerMessage('Přehrávač YouTube se nepodařilo načíst. Video si můžeš pustit přímo na YouTube.');
    return;
  }
  if (state.playingId !== id) return;
  if (!yt.player) {
    yt.loadedId = id;
    yt.player = new YT.Player('yt-player', {
      width: '100%',
      height: '100%',
      videoId: id,
      playerVars: { autoplay: 1, mute: 1, playsinline: 1, rel: 0 },
      events: {
        onReady: (e) => {
          yt.ready = true;
          if (state.playingId && state.playingId !== yt.loadedId) startVideo(state.playingId);
          else {
            e.target.mute();
            e.target.playVideo();
          }
        },
        onError: (e) => {
          if (state.playingId) showPlayerMessage(playerErrorText(Number(e.data)));
        },
        // Konec videa záměrně nic nedělá: nic se neodškrtne a nic dalšího se nepustí.
        onStateChange: () => {},
      },
    });
  } else if (yt.ready) {
    startVideo(id);
  }
}

function closePlayer() {
  const id = state.playingId;
  try {
    if (yt.player && yt.ready) yt.player.stopVideo();
  } catch (err) {
    console.error(err);
  }
  state.playingId = null;
  els.player.hidden = true;
  updateStickyOffset();
  render();
  const back = id && document.querySelector(`[data-key="${CSS.escape(`play:${id}`)}"]`);
  (back || els.remainingHeading).focus({ preventScroll: true });
}

function updateStickyOffset() {
  const stuck = stickyPlayer.matches && !els.player.hidden;
  const offset = stuck ? els.player.offsetHeight + 12 : 16;
  document.documentElement.style.setProperty('--sticky-offset', `${offset}px`);
}

/* ---------- Firebase: přihlášení a ukládání ---------- */

function isConfigured() {
  const required = ['apiKey', 'authDomain', 'projectId', 'appId'];
  return Boolean(firebaseConfig) && required.every((k) => typeof firebaseConfig[k] === 'string' && firebaseConfig[k].trim());
}

function isPartlyConfigured() {
  return Boolean(firebaseConfig) && Object.values(firebaseConfig).some((v) => typeof v === 'string' && v.trim());
}

function enterPhase(phase) {
  state.phase = phase;
  window.clearTimeout(loadingTimer);
  state.loadingExpired = false;
  if (phase === 'loading' || phase === 'user-loading') {
    loadingTimer = window.setTimeout(() => {
      if (state.phase === phase) {
        state.loadingExpired = true;
        render();
      }
    }, LOADING_FALLBACK_MS);
  }
}

async function initFirebase() {
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${FIREBASE_CDN}/firebase-app.js`),
    import(`${FIREBASE_CDN}/firebase-auth.js`),
    import(`${FIREBASE_CDN}/firebase-firestore.js`),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  Object.assign(fb, {
    auth: authMod.getAuth(app),
    db: fsMod.getFirestore(app),
    GoogleAuthProvider: authMod.GoogleAuthProvider,
    signInWithPopup: authMod.signInWithPopup,
    signInWithRedirect: authMod.signInWithRedirect,
    signOut: authMod.signOut,
    doc: fsMod.doc,
    onSnapshot: fsMod.onSnapshot,
    setDoc: fsMod.setDoc,
  });
  authMod.getRedirectResult(fb.auth).catch((err) => showAuthError(err));
  authMod.onAuthStateChanged(fb.auth, onUserChanged);
}

function authErrorText(err) {
  const code = err && err.code;
  switch (code) {
    case 'auth/unauthorized-domain':
      return 'Tahle doména není ve Firebase povolená. Přidej ji v konzoli Firebase: Authentication → Settings → Authorized domains.';
    case 'auth/operation-not-allowed':
      return 'Přihlášení přes Google není ve Firebase zapnuté (Authentication → Sign-in method → Google).';
    case 'auth/invalid-api-key':
    case 'auth/api-key-not-valid.-please-pass-a-valid-api-key.':
      return 'Firebase odmítl API klíč. Zkontroluj hodnoty ve firebase-config.js.';
    case 'auth/network-request-failed':
      return 'Přihlášení selhalo kvůli připojení k internetu. Zkus to znovu.';
    default:
      return `Přihlášení se nepovedlo${code ? ` (${code})` : ''}.`;
  }
}

function showAuthError(err) {
  console.error(err);
  setNotice('auth', { tone: 'error', text: authErrorText(err), dismissible: true });
}

const CANCEL_ERRORS = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']);
const NO_REDIRECT_ERRORS = new Set([
  'auth/unauthorized-domain',
  'auth/operation-not-allowed',
  'auth/invalid-api-key',
  'auth/network-request-failed',
]);

async function login() {
  if (!fb.auth) return;
  setNotice('auth', null);
  const provider = new fb.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await fb.signInWithPopup(fb.auth, provider);
  } catch (err) {
    if (err && CANCEL_ERRORS.has(err.code)) return;
    if (err && NO_REDIRECT_ERRORS.has(err.code)) {
      showAuthError(err);
      return;
    }
    try {
      await fb.signInWithRedirect(fb.auth, provider);
    } catch (err2) {
      showAuthError(err2);
    }
  }
}

async function logout() {
  if (!fb.auth) return;
  await Promise.race([flushSave(), new Promise((r) => window.setTimeout(r, 3000))]);
  try {
    await fb.signOut(fb.auth);
  } catch (err) {
    showAuthError(err);
  }
}

function stopSync() {
  if (sync.unsubscribe) sync.unsubscribe();
  window.clearTimeout(sync.saveTimer);
  window.clearTimeout(sync.snapshotTimer);
  Object.assign(sync, { ref: null, unsubscribe: null, saveTimer: null, lastSyncedJson: null, seeding: false, snapshotTimer: null });
}

function onUserChanged(user) {
  stopSync();
  setNotice('firestore', null);
  if (!user) {
    state.user = null;
    state.order = [];
    state.done = {};
    enterPhase('guest');
    render();
    return;
  }
  state.user = { uid: user.uid, email: user.email || '' };
  setNotice('auth', null);
  subscribe();
}

function subscribe() {
  stopSync();
  setNotice('firestore', null);
  enterPhase('user-loading');
  render();
  const uid = state.user.uid;
  const ref = fb.doc(fb.db, 'users', uid);
  sync.ref = ref;
  sync.snapshotTimer = window.setTimeout(() => {
    if (state.phase === 'user-loading') {
      setNotice('firestore', {
        tone: 'error',
        text: 'Uložený stav se zatím nepodařilo načíst. Zkontroluj připojení k internetu; jakmile se obnoví, stav se načte sám.',
        actions: [{ label: 'Zkusit znovu', action: 'retry-sync' }],
      });
    }
  }, SNAPSHOT_TIMEOUT_MS);
  // includeMetadataChanges: bez něj by po offline startu nemusela přijít
  // zpráva ze serveru, že dokument opravdu neexistuje.
  sync.unsubscribe = fb.onSnapshot(
    ref,
    { includeMetadataChanges: true },
    (snap) => onSnapshotData(snap, ref),
    (err) => onSnapshotError(err),
  );
}

async function onSnapshotData(snap, ref) {
  if (sync.ref !== ref) return;
  if (!snap.exists()) {
    if (snap.metadata.fromCache || sync.seeding) return; // čekej na odpověď serveru
    sync.seeding = true;
    const seed = await loadSeed();
    if (sync.ref !== ref) return;
    applyRemote(normalize(seed), null);
    flushSave().then(() => {
      if (seed.fromFile) showToast('Deník je založený z dosavadního stavu.');
    });
    return;
  }
  // Místní změna ještě čeká na uložení: místní stav je novější, snapshot přeskoč.
  if (sync.saveTimer || snap.metadata.hasPendingWrites) return;
  const data = snap.data() || {};
  const remote = { done: sanitizeDone(data.done), order: Array.isArray(data.order) ? data.order.filter((x) => typeof x === 'string') : [] };
  applyRemote(normalize(remote), stableStringify(remote));
}

function applyRemote(normalized, syncedJson) {
  window.clearTimeout(sync.snapshotTimer);
  sync.lastSyncedJson = syncedJson;
  const same =
    state.phase === 'user' &&
    stableStringify({ done: state.done, order: state.order }) === stableStringify(normalized);
  setNotice('firestore', null);
  if (same) return;
  state.done = normalized.done;
  state.order = normalized.order;
  enterPhase('user');
  render();
}

function onSnapshotError(err) {
  console.error(err);
  window.clearTimeout(sync.snapshotTimer);
  sync.unsubscribe = null;
  enterPhase('user-error');
  render();
  const denied = err && err.code === 'permission-denied';
  setNotice('firestore', {
    tone: 'error',
    title: denied ? 'Firestore odmítl přístup.' : 'Uložený stav se nepodařilo načíst.',
    text: denied
      ? 'Pokud je to tvůj deník, zkopíruj Firebase UID z panelu Účet dole na stránce, vlož ho do firestore.rules místo VLOZ_SVOJE_UID a pravidla zveřejni v konzoli Firebase (Firestore Database → Rules). Pak to zkus znovu.'
      : `Zkus to za chvíli znovu${err && err.code ? ` (${err.code})` : ''}.`,
    actions: [{ label: 'Zkusit znovu', action: 'retry-sync' }],
  });
}

async function loadSeed() {
  try {
    const res = await fetch('data/seed.json', { cache: 'no-store' });
    if (res.ok) {
      const seed = await res.json();
      return { done: seed.done, order: seed.order, fromFile: true };
    }
  } catch (err) {
    console.warn('seed.json nejde načíst', err);
  }
  // Bez seedu začne deník od nuly v pořadí playlistu.
  return { done: {}, order: state.videos.map((v) => v.id), fromFile: false };
}

function scheduleSave() {
  if (!canEdit() || !sync.ref) return;
  window.clearTimeout(sync.saveTimer);
  sync.saveTimer = window.setTimeout(flushSave, SAVE_DELAY_MS);
}

async function flushSave() {
  window.clearTimeout(sync.saveTimer);
  sync.saveTimer = null;
  if (!canEdit() || !sync.ref) return;
  const payload = { done: { ...state.done }, order: [...state.order] };
  const json = stableStringify(payload);
  if (json === sync.lastSyncedJson) return; // nic se nezměnilo
  const previous = sync.lastSyncedJson;
  const ref = sync.ref;
  sync.lastSyncedJson = json;
  try {
    await fb.setDoc(ref, payload);
    if (sync.ref === ref) setNotice('save', null);
  } catch (err) {
    console.error(err);
    if (sync.ref !== ref) return;
    if (sync.lastSyncedJson === json) sync.lastSyncedJson = previous;
    setNotice('save', {
      tone: 'error',
      text: `Poslední změnu se nepodařilo uložit${err && err.code ? ` (${err.code})` : ''}. Zkus ji udělat znovu, nebo stránku obnov.`,
      dismissible: true,
    });
  }
}

/* ---------- Události ---------- */

function bindEvents() {
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    const { action, id } = target.dataset;
    switch (action) {
      case 'play':
        play(id);
        break;
      case 'toggle':
        toggleDone(id, 'row');
        break;
      case 'move':
        moveAction(id, target.dataset.move, event);
        break;
      case 'dot':
        goToRow(id);
        break;
      case 'player-done':
        if (state.playingId) toggleDone(state.playingId, 'player');
        break;
      case 'player-close':
        closePlayer();
        break;
      case 'login':
        login();
        break;
      case 'logout':
        logout();
        break;
      case 'copy-uid':
        copyUid(target);
        break;
      case 'retry-sync':
        if (state.user) subscribe();
        break;
      case 'dismiss-notice':
        setNotice(target.dataset.notice, null);
        break;
      default:
        break;
    }
  });
  els.mosaic.addEventListener('keydown', onMosaicKeydown);
  bindDrag();

  const flushIfPending = () => {
    if (sync.saveTimer) flushSave();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushIfPending();
  });
  window.addEventListener('pagehide', flushIfPending);

  if ('ResizeObserver' in window) new ResizeObserver(updateStickyOffset).observe(els.player);
  stickyPlayer.addEventListener('change', updateStickyOffset);
}

async function copyUid(button) {
  const uid = state.user && state.user.uid;
  if (!uid) return;
  let ok = false;
  try {
    await navigator.clipboard.writeText(uid);
    ok = true;
  } catch {
    const input = $('uid-input');
    if (input) {
      input.focus();
      input.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
    }
  }
  button.textContent = ok ? 'Zkopírováno' : 'Označeno, zkopíruj ručně';
  announce(ok ? 'UID je zkopírované.' : 'UID je označené, zkopíruj ho ručně.');
  window.setTimeout(() => {
    if (button.isConnected) button.textContent = 'Kopírovat';
  }, 2000);
}

/* ---------- Start ---------- */

async function main() {
  bindEvents();
  try {
    await loadVideos();
  } catch (err) {
    console.error(err);
    setNotice('videos', { tone: 'error', text: 'Nepodařilo se načíst seznam videí (data/videos.json). Zkus stránku obnovit.' });
  }

  if (!isConfigured()) {
    enterPhase('disabled');
    setNotice('config', {
      title: isPartlyConfigured() ? 'Konfigurace Firebase je neúplná.' : 'Firebase zatím není nastavený.',
      text: 'Přihlášení a ukládání hotových videí proto nefunguje, videa si ale pustit můžeš. Doplň hodnoty do firebase-config.js (postup je v README).',
    });
    render();
    return;
  }

  enterPhase('loading');
  render();
  try {
    await initFirebase();
  } catch (err) {
    console.error(err);
    enterPhase('disabled');
    setNotice('config', {
      tone: 'error',
      title: 'Firebase se nepodařilo načíst.',
      text: 'Přihlášení a ukládání teď nefunguje, videa si ale pustit můžeš. Zkus stránku obnovit.',
    });
    render();
  }
}

main();
