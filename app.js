'use strict';
/* ChordBook — основная логика. Подключается ПОСЛЕ всей разметки,
   поэтому все getElementById гарантированно находят элементы
   (раньше настройки «Плотность» и закрытие оверлеев тапом мимо
   не работали: скрипт выполнялся до того, как кнопки появлялись в DOM). */

const CE = window.ChordsEngine;

// ═══════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
// FIX: раньше не экранировались кавычки → ломались атрибуты data-name="..." и onclick='...'
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const $ = id => document.getElementById(id);
const LS = {
  get(key, fallback = null) { try { const v = localStorage.getItem(key); return v != null ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch { return false; } }
};
function debounce(fn, ms) { let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); }; }

function showConfirm({ title, msg, okLabel = 'Удалить', cancelLabel = 'Отмена', onOk, onCancel }) {
  const el = document.createElement('div');
  el.className = 'confirm-dialog-overlay';
  el.innerHTML = `<div class="confirm-dialog">
    <div class="confirm-dialog-title">${escapeHtml(title)}</div>
    <div class="confirm-dialog-msg">${escapeHtml(msg)}</div>
    <div class="confirm-dialog-btns">
      <button class="confirm-dialog-cancel">${escapeHtml(cancelLabel)}</button>
      <button class="confirm-dialog-ok">${escapeHtml(okLabel)}</button>
    </div></div>`;
  document.body.appendChild(el);
  const esc = e => { if (e.key === 'Escape') cancel(); };
  const close = () => { el.remove(); document.removeEventListener('keydown', esc); };
  const cancel = () => { close(); if (onCancel) onCancel(); };
  el.querySelector('.confirm-dialog-cancel').onclick = cancel;
  el.querySelector('.confirm-dialog-ok').onclick = () => { close(); onOk(); };
  el.addEventListener('click', e => { if (e.target === el) cancel(); });
  document.addEventListener('keydown', esc);
  return el;
}

// Универсальное контекстное меню. FIX: старая версия оставляла «висящие»
// обработчики click на document и путала флаг открытости при перерисовке.
let _activeMenu = null;
function closeMenu() {
  if (!_activeMenu) return;
  _activeMenu.el.remove();
  document.removeEventListener('pointerdown', _activeMenu.outside, true);
  _activeMenu = null;
}
function openMenu(anchor, items) {
  const wasSame = _activeMenu && _activeMenu.anchor === anchor;
  closeMenu();
  if (wasSame) return null;
  const m = document.createElement('div');
  m.className = 'overflow-menu';
  items.filter(Boolean).forEach(it => {
    const d = document.createElement('div');
    d.className = 'overflow-menu-item' + (it.danger ? ' danger' : '');
    d.textContent = it.label;
    if (it.id) d.id = it.id;
    d.addEventListener('click', e => {
      e.stopPropagation();
      if (it.keepOpen) { it.onClick(d); return; }
      closeMenu(); it.onClick(d);
    });
    m.appendChild(d);
  });
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  const mh = m.offsetHeight || 300;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  m.style.top = top + 'px';
  m.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  const outside = e => { if (!m.contains(e.target) && !anchor.contains(e.target)) closeMenu(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  _activeMenu = { el: m, anchor, outside };
  return m;
}

// ═══════════════════════════════════════════
//  INDEXEDDB
// ═══════════════════════════════════════════
const IDB = (() => {
  const DB_NAME = 'chordbook_v1', DB_VER = 1;
  let _db = null;
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('songs')) {
          const store = db.createObjectStore('songs', { keyPath: 'id' });
          store.createIndex('title_lower', 'title_lower', { unique: false });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('setlists')) db.createObjectStore('setlists', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }
  const reqP = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const store = (name, mode = 'readonly') => _db.transaction(name, mode).objectStore(name);
  // FIX: replaceAll = clear + put в одной транзакции. Раньше putAll только добавлял —
  // песни, удалённые на другом устройстве, «воскресали» из локальной базы.
  function replaceAll(name, arr, mapFn) {
    return open().then(() => new Promise((resolve, reject) => {
      const t = _db.transaction(name, 'readwrite'); const s = t.objectStore(name);
      t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
      s.clear();
      for (const x of arr) if (x && x.id) s.put(mapFn ? mapFn(x) : x);
    }));
  }
  const withLower = s => ({ ...s, title_lower: (s.title || '').toLowerCase() });
  return {
    open,
    getAllSongs: () => open().then(() => reqP(store('songs').getAll())).then(r => r || []),
    putSong: s => open().then(() => reqP(store('songs', 'readwrite').put(withLower(s)))),
    deleteSong: id => open().then(() => reqP(store('songs', 'readwrite').delete(id))),
    replaceAllSongs: arr => replaceAll('songs', arr, withLower),
    getAllSetlists: () => open().then(() => reqP(store('setlists').getAll())).then(r => r || []),
    deleteSetlist: id => open().then(() => reqP(store('setlists', 'readwrite').delete(id))),
    replaceAllSetlists: arr => replaceAll('setlists', arr),
  };
})();

function updateHeaderHeight() {
  requestAnimationFrame(() => {
    const h = $('main-header') && $('main-header').offsetHeight;
    if (h > 0) document.documentElement.style.setProperty('--header-height', h + 'px');
  });
}

// ═══════════════════════════════════════════
//  TELEGRAM
// ═══════════════════════════════════════════
const tg = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData !== undefined ? window.Telegram.WebApp : null;
function applyInsets() {
  let top = 0;
  if (tg) {
    // FIX: в fullscreen-режиме нужен СУММА системного инсета (статус-бар) и
    // инсета контента (кнопки Telegram). Раньше брался только один из них.
    const sa = (tg.safeAreaInsets && tg.safeAreaInsets.top) || 0;
    const ca = (tg.contentSafeAreaInsets && tg.contentSafeAreaInsets.top) || 0;
    top = sa + ca;
    if (!top && tg.isFullscreen && window.innerWidth < 640) top = 80; // старые клиенты не сообщают инсеты
  }
  document.documentElement.style.setProperty('--safe-top', top ? top + 'px' : 'env(safe-area-inset-top, 0px)');
  updateHeaderHeight();
}
function initTelegram() {
  if (!tg) { applyInsets(); return; }
  try {
    tg.ready(); tg.expand();
    if (typeof tg.requestFullscreen === 'function' && /android|iphone|ipad/i.test(navigator.userAgent)) { try { tg.requestFullscreen(); } catch {} }
    if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
    applyInsets();
    if (tg.onEvent) ['safeAreaChanged', 'contentSafeAreaChanged', 'viewportChanged', 'fullscreenChanged'].forEach(ev => tg.onEvent(ev, applyInsets));
  } catch (e) { console.warn('Telegram init error:', e); applyInsets(); }
}

// ═══════════════════════════════════════════
//  API (Cloudflare Worker). Браузер в Firestore напрямую НЕ ходит:
//  каждый запрос подписан Telegram (initData), Worker проверяет подпись.
// ═══════════════════════════════════════════
const API_BASE = (window.CB_CONFIG && window.CB_CONFIG.apiBase) || 'https://chordbook-api.elapsov57.workers.dev';
async function api(method, path, body, timeoutMs = 15000) {
  const initData = tg && tg.initData;
  if (!initData) return { ok: false, status: 401, error: 'no-telegram' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(API_BASE + path, {
      method, signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data, error: r.ok ? null : ((data && data.error) || 'HTTP ' + r.status) };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'сервер не ответил' : 'нет сети' };
  } finally { clearTimeout(timer); }
}

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════
const NOTES = CE.NOTES_SHARP;
let songsCache = [];
let setlistsCache = [];
let currentSongId = null;
let currentSetlistId = null;
let transposeOffset = 0;
let currentPage = 'songs';
let selectedTags = [];
let setlistContext = null;
let performanceMode = false;
let isEditingDrawerOpen = false;

const SETTINGS_KEY = 'cb_settings';
let appSettings = LS.get(SETTINGS_KEY, null) || { notation: 'asis' };
function saveSettings() { LS.set(SETTINGS_KEY, appSettings); }

const transposeMap = LS.get('cb_transpose', {});
function saveTranspose(songId, offset) {
  if (!offset) delete transposeMap[songId]; else transposeMap[songId] = offset;
  LS.set('cb_transpose', transposeMap);
}
const notationMap = LS.get('cb_notation_map', {});
function saveNotationMap() { LS.set('cb_notation_map', notationMap); }
// FIX: глобальная настройка «Диезы/бемоли» раньше сохранялась, но нигде не применялась.
function getSongNotation(songId) {
  if (notationMap[songId]) return notationMap[songId];
  return appSettings.notation === 'flat' || appSettings.notation === 'sharp' ? appSettings.notation : null;
}

// ═══════════════════════════════════════════
//  SYNC — каждая песня и сет-лист сохраняются ОТДЕЛЬНО, с ревизией.
//  • очередь неотправленных изменений (_outbox) хранится в localStorage
//    и переживает перезапуск и работу без интернета;
//  • изменения сервера подтягиваются инкрементально (since = курсор);
//  • если песню одновременно изменил другой человек — сервер отвечает 409,
//    и пользователь выбирает, чью версию оставить.
// ═══════════════════════════════════════════
let _syncInterval = null;
let _outbox = LS.get('cb_outbox', []) || [];
let _cursor = LS.get('cb_cursor', 0) || 0;
let _syncState = 'idle'; // idle | ok | offline | noauth | error
let _flushing = null;
const _snap = { song: {}, setlist: {} }; // id → JSON последней синхронизированной версии
const KIND_PATH = { song: 'songs', setlist: 'setlists' };
const cacheOf = kind => kind === 'song' ? songsCache : setlistsCache;
function setCache(kind, arr) { if (kind === 'song') songsCache = arr; else setlistsCache = arr; }
function stripLocal(o) { const { _rev, _serverTs, _by, title_lower, ...rest } = o; return rest; }
function itemJson(o) { return JSON.stringify(stripLocal(o)); }
function fromServer(srv) {
  const { rev, serverTs, updatedBy, updatedByName, deleted, deletedAt, deletedBy, ...rest } = srv;
  return { ...rest, _rev: rev || 0, _serverTs: serverTs || 0, _by: updatedByName || '' };
}
function saveOutbox() { LS.set('cb_outbox', _outbox); }
function enqueue(kind, id, op) {
  _outbox = _outbox.filter(x => !(x.kind === kind && x.id === id));
  _outbox.push({ kind, id, op });
  saveOutbox();
}
function hasPending(kind, id) { return _outbox.some(x => x.kind === kind && x.id === id); }
function rebuildSnap(kind) { _snap[kind] = {}; cacheOf(kind).forEach(x => { if (x && x.id && x._rev) _snap[kind][x.id] = itemJson(x); }); }
// Сравнивает кэш с последней синхронизированной версией и ставит в очередь отличия
function diffAndQueue(kind) {
  const cache = cacheOf(kind), seen = new Set();
  cache.forEach(x => { if (!x || !x.id) return; seen.add(x.id); if (_snap[kind][x.id] !== itemJson(x)) enqueue(kind, x.id, 'put'); });
  Object.keys(_snap[kind]).forEach(id => { if (!seen.has(id)) enqueue(kind, id, 'del'); });
}
function showSyncState(state, msg) {
  _syncState = state;
  if (msg) { showSyncStatus(msg); setTimeout(hideSyncStatus, 2500); }
}

async function flush() {
  if (_flushing) return _flushing;
  _flushing = (async () => {
    if (!_outbox.length) return true;
    if (!navigator.onLine) { _syncState = 'offline'; return false; }
    const conflicts = [];
    // много новых песен (импорт) — одной пачкой
    const newSongs = _outbox.filter(o => o.kind === 'song' && o.op === 'put').map(o => songsCache.find(s => s.id === o.id)).filter(s => s && !s._rev);
    if (newSongs.length > 3) {
      for (let i = 0; i < newSongs.length; i += 50) {
        const chunk = newSongs.slice(i, i + 50);
        const sent = new Map(chunk.map(s => [s.id, itemJson(s)]));
        const r = await api('POST', '/api/batch', { songs: chunk.map(stripLocal) });
        if (!r.ok) { _syncState = r.status === 401 ? 'noauth' : 'error'; return false; }
        ((r.data && r.data.created) || []).forEach(c => { if (c && c.kind === 'song' && c.item && sent.has(c.item.id)) applyPushed('song', c.item, sent.get(c.item.id)); });
      }
    }
    for (const op of [..._outbox]) {
      if (!hasPending(op.kind, op.id)) continue;
      const path = `/api/${KIND_PATH[op.kind]}/${encodeURIComponent(op.id)}`;
      if (op.op === 'del') {
        const r = await api('DELETE', path);
        if (!r.ok) { _syncState = r.status === 401 ? 'noauth' : 'error'; return false; }
        _outbox = _outbox.filter(x => x !== op); saveOutbox();
        delete _snap[op.kind][op.id];
        continue;
      }
      const item = cacheOf(op.kind).find(x => x.id === op.id);
      if (!item) { _outbox = _outbox.filter(x => x !== op); saveOutbox(); continue; }
      const sentJson = itemJson(item);
      const r = await api('PUT', path, { item: stripLocal(item), baseRev: item._rev || 0 });
      if (r.status === 409 && r.data && r.data.current) {
        _outbox = _outbox.filter(x => x !== op); saveOutbox();
        conflicts.push({ kind: op.kind, local: item, remote: r.data.current });
        continue;
      }
      if (!r.ok) { _syncState = r.status === 401 ? 'noauth' : r.status === 0 ? 'offline' : 'error'; if (r.status === 413 || r.status === 400) { _outbox = _outbox.filter(x => x !== op); saveOutbox(); showToast('Не сохранено на сервере: ' + r.error); continue; } return false; }
      if (!r.data || !r.data.item || r.data.item.id !== op.id) { _syncState = 'error'; return false; } // неожиданный ответ — повторим позже
      applyPushed(op.kind, r.data.item, sentJson);
    }
    _syncState = 'ok';
    for (const c of conflicts) await resolveConflict(c);
    return true;
  })();
  try { return await _flushing; } finally { _flushing = null; }
}
// Сервер принял запись: обновляем ревизию, но содержимое не трогаем (вдруг уже есть новые правки)
function applyPushed(kind, srv, sentJson) {
  const list = cacheOf(kind);
  const i = list.findIndex(x => x.id === srv.id);
  if (i === -1) return;
  const updated = { ...list[i], _rev: srv.rev, _serverTs: srv.serverTs, _by: srv.updatedByName || '' };
  setCache(kind, [...list.slice(0, i), updated, ...list.slice(i + 1)]);
  _snap[kind][srv.id] = sentJson;
  // из очереди убираем, только если пока шёл запрос не появилось новых правок
  if (itemJson(updated) === sentJson) { _outbox = _outbox.filter(x => !(x.kind === kind && x.id === srv.id)); saveOutbox(); }
  persistIdb(kind);
}
function persistIdb(kind) { (kind === 'song' ? IDB.replaceAllSongs(songsCache) : IDB.replaceAllSetlists(setlistsCache)).catch(() => {}); }

function resolveConflict(c) {
  return new Promise(resolve => {
    const what = c.kind === 'song' ? 'Песню' : 'Сет-лист';
    const title = c.local.title || c.local.name || '';
    const who = c.remote.updatedByName || 'другой участник';
    const takeTheirs = () => {
      const list = cacheOf(c.kind);
      const fresh = fromServer(c.remote);
      const i = list.findIndex(x => x.id === fresh.id);
      if (c.remote.deleted) setCache(c.kind, list.filter(x => x.id !== fresh.id));
      else setCache(c.kind, i === -1 ? [fresh, ...list] : [...list.slice(0, i), fresh, ...list.slice(i + 1)]);
      _snap[c.kind][fresh.id] = itemJson(fresh);
      if (c.kind === 'song') invalidateSongCache(fresh.id);
      persistIdb(c.kind); refreshVisible();
      resolve();
    };
    const keepMine = () => {
      const list = cacheOf(c.kind);
      const i = list.findIndex(x => x.id === c.local.id);
      if (i !== -1) setCache(c.kind, [...list.slice(0, i), { ...list[i], _rev: c.remote.rev }, ...list.slice(i + 1)]);
      enqueue(c.kind, c.local.id, 'put');
      resolve(); setTimeout(() => flush(), 0);
    };
    showConfirm({ title: `${what} изменили одновременно с вами`, msg: `«${title}» только что изменил(а) ${who}. Какую версию оставить?`, okLabel: 'Мою', cancelLabel: 'Их версию', onOk: keepMine, onCancel: takeTheirs });
  });
}
function refreshVisible() {
  if (currentPage === 'songs') renderSongs($('search-input').value);
  else if (currentPage === 'setlists') renderSetlists();
  else if (currentPage === 'setlist-view' && currentSetlistId) { const f = getSlById(currentSetlistId); if (f) renderSetlistView(f); }
  else if (currentPage === 'song-view' && currentSongId && !_inlineEditActive) { const s = songsCache.find(x => x.id === currentSongId); if (s) renderSongView(s); }
}

// Подтянуть изменения с сервера
async function pull() {
  if (!navigator.onLine) { _syncState = 'offline'; return false; }
  if (_outbox.length) await flush();
  const full = !_cursor;
  const r = await api('GET', '/api/sync?since=' + (full ? 0 : Math.max(0, _cursor - 3000)));
  if (!r.ok) { _syncState = r.status === 401 ? 'noauth' : r.status === 0 ? 'offline' : 'error'; return false; }
  let changed = false;
  for (const kind of ['song', 'setlist']) {
    const incoming = (kind === 'song' ? r.data.songs : r.data.setlists) || [];
    if (full && kind === 'song' && !incoming.length && songsCache.length) {
      // Сервер пуст, а на устройстве есть песни — данные ещё не перенесены.
      // Ничего не стираем и курсор не двигаем: подождём переноса.
      _syncState = 'empty';
      return false;
    }
    if (full) {
      const keepLocal = cacheOf(kind).filter(x => hasPending(kind, x.id));
      const map = new Map(incoming.filter(x => !x.deleted).map(x => [x.id, fromServer(x)]));
      keepLocal.forEach(x => map.set(x.id, x));
      setCache(kind, [...map.values()]);
      rebuildSnap(kind);
      changed = true;
    } else {
      let list = cacheOf(kind);
      for (const srv of incoming) {
        if (hasPending(kind, srv.id)) continue;           // локальная правка ещё не ушла — не затираем
        const i = list.findIndex(x => x.id === srv.id);
        if (srv.deleted) { if (i !== -1) { list = list.filter(x => x.id !== srv.id); changed = true; } delete _snap[kind][srv.id]; continue; }
        if (i !== -1 && (list[i]._rev || 0) >= srv.rev) continue;
        const fresh = fromServer(srv);
        list = i === -1 ? [fresh, ...list] : [...list.slice(0, i), fresh, ...list.slice(i + 1)];
        _snap[kind][srv.id] = itemJson(fresh);
        if (kind === 'song') invalidateSongCache(srv.id);
        changed = true;
      }
      setCache(kind, list);
    }
  }
  _cursor = r.data.serverTs || Date.now(); LS.set('cb_cursor', _cursor);
  _syncState = 'ok';
  if (changed) {
    if (full) { _renderCache.clear(); _detectedKeyCache.clear(); }
    persistIdb('song'); persistIdb('setlist');
    refreshVisible();
  }
  return true;
}

async function saveSongs() {
  try { await IDB.replaceAllSongs(songsCache); } catch (e) { console.error('IDB save error:', e); }
  diffAndQueue('song');
  return flush();
}
async function saveSingleSong(song) {
  try { await IDB.putSong(song); } catch (e) { console.error('IDB putSong error:', e); }
  enqueue('song', song.id, 'put');
  return flush();
}
async function saveSetlists() {
  try { await IDB.replaceAllSetlists(setlistsCache); } catch (e) { console.error('IDB setlists error:', e); }
  diffAndQueue('setlist');
  return flush();
}
function replaceSongInCache(song) {
  const idx = songsCache.findIndex(s => s.id === song.id);
  if (idx === -1) songsCache = [song, ...songsCache];
  else songsCache = [...songsCache.slice(0, idx), song, ...songsCache.slice(idx + 1)];
  invalidateSongCache(song.id);
}

function startSync() {
  if (_syncInterval) clearInterval(_syncInterval);
  _syncInterval = setInterval(() => { if (!isEditingDrawerOpen && !_inlineEditActive) pull().catch(() => {}); }, 20000);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (_syncInterval) { clearInterval(_syncInterval); _syncInterval = null; } }
  else { startSync(); if (!isEditingDrawerOpen && !_inlineEditActive) pull().catch(() => {}); }
});

const SYNC_MSG = { empty: 'На сервере пока нет песен. Администратору: Настройки → «Перенести данные из старой базы»', offline: 'Нет интернета: работаем с сохранённой копией', noauth: 'Откройте приложение через Telegram, чтобы синхронизировать', error: 'Сервер недоступен: изменения отправятся позже' };
async function loadData() {
  try {
    const [idbSongs, idbSetlists] = await Promise.all([IDB.getAllSongs(), IDB.getAllSetlists()]);
    songsCache = idbSongs; setlistsCache = idbSetlists;
    rebuildSnap('song'); rebuildSnap('setlist');
    if (idbSongs.length || idbSetlists.length) refreshVisible();
  } catch (e) { console.warn('IDB load error', e); }
  if (!_cursor && songsCache.length) showSyncStatus('Загружаем библиотеку…');
  const ok = await pull();
  if (ok) hideSyncStatus(); else showSyncState(_syncState, SYNC_MSG[_syncState]);
  startSync();
}

window.addEventListener('online', async () => {
  const ok = await pull();
  showSyncState(_syncState, ok ? 'Синхронизировано' : SYNC_MSG[_syncState]);
});
window.addEventListener('offline', () => showSyncState('offline', 'Нет интернета'));

function showSyncStatus(msg) {
  let el = $('sync-status');
  if (!el) { el = document.createElement('div'); el.id = 'sync-status'; el.className = 'sync-status'; document.body.appendChild(el); }
  el.textContent = msg; el.style.opacity = '1';
}
function hideSyncStatus() { const el = $('sync-status'); if (el) el.style.opacity = '0'; }

// ═══════════════════════════════════════════
//  VIEW MODES
// ═══════════════════════════════════════════
const GLOBAL_VIEW_MODES = ['both', 'words', 'chords'];
const GLOBAL_VIEW_LABELS = { both: 'Слова+♪', words: 'Слова', chords: 'Аккорды' };
const GLOBAL_VIEW_TITLES = { both: 'Слова + аккорды', words: 'Только слова', chords: 'Только аккорды' };
const GLOBAL_VIEW_KEY = 'cb_global_view';
let globalViewMode = GLOBAL_VIEW_MODES.includes(LS.get(GLOBAL_VIEW_KEY)) ? LS.get(GLOBAL_VIEW_KEY) : 'both';

const SONG_VIEW_KEY = 'cb_song_view';
const songViewMap = LS.get(SONG_VIEW_KEY, {});
const SONG_VIEW_MODES = ['inherit', 'both', 'words', 'chords'];
const SONG_VIEW_LABELS = { inherit: 'Авто', both: 'Слова+♪', words: 'Слова', chords: 'Аккорды' };
const SONG_VIEW_TITLES = { inherit: 'Как глобально', both: 'Слова + аккорды', words: 'Только слова', chords: 'Только аккорды' };

function getSongEffectiveMode(songId) {
  const m = songId && songViewMap[songId];
  return !m || m === 'inherit' ? globalViewMode : m;
}
function applySongViewMode() {
  const el = $('song-content-area');
  if (!el) return;
  el.classList.remove('mode-both', 'mode-words', 'mode-chords');
  el.classList.add('mode-' + getSongEffectiveMode(currentSongId));
}
function applyGlobalViewMode() { applySongViewMode(); }
function setGlobalViewMode(mode) {
  globalViewMode = mode;
  LS.set(GLOBAL_VIEW_KEY, mode);
  applyGlobalViewMode();
  updateSongViewModeBtn();
  if (_inlineEditActive && _inlineEditSong) _ieRedraw();
}
function cycleGlobalViewMode() {
  setGlobalViewMode(GLOBAL_VIEW_MODES[(GLOBAL_VIEW_MODES.indexOf(globalViewMode) + 1) % 3]);
  showToast(GLOBAL_VIEW_TITLES[globalViewMode]);
}
function updateSongViewModeBtn() {
  const seg = $('song-view-mode-btn');
  if (!seg) return;
  const mode = getSongEffectiveMode(currentSongId);
  seg.querySelectorAll('[data-mode]').forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
}
// Сегмент «Слова / Оба / Аккорды»: выбор для песни; совпадает с глобальным — запись не храним
function setSongViewMode(mode) {
  if (!SONG_VIEW_MODES.includes(mode)) return;
  if (mode === globalViewMode || mode === 'inherit') delete songViewMap[currentSongId]; else songViewMap[currentSongId] = mode;
  LS.set(SONG_VIEW_KEY, songViewMap);
  applySongViewMode(); updateSongViewModeBtn();
  if (_inlineEditActive) _ieRedraw();
}
function cycleSongViewMode() {
  const cur = songViewMap[currentSongId] || 'inherit';
  const next = SONG_VIEW_MODES[(SONG_VIEW_MODES.indexOf(cur) + 1) % SONG_VIEW_MODES.length];
  if (next === 'inherit') delete songViewMap[currentSongId]; else songViewMap[currentSongId] = next;
  LS.set(SONG_VIEW_KEY, songViewMap);
  applySongViewMode(); updateSongViewModeBtn();
  // FIX: при смене режима во время редактирования редактор не перерисовывался
  if (_inlineEditActive) _ieRedraw();
  showToast(SONG_VIEW_TITLES[next]);
}

// ═══════════════════════════════════════════
//  TRANSPOSE (делегирует движку — одна реализация на всё приложение)
// ═══════════════════════════════════════════
const normalizeNote = CE.normalizeNote;
const transposeChord = (c, s, n) => CE.transposeChord(c, s, n);
function transposeLyrics(text, semis, notation) {
  if (!semis && !notation) return text;
  return text.replace(/\[([^\]]+)\]/g, (full, inner) => CE.isChord(inner.trim()) ? `[${transposeChord(inner.trim(), semis, notation)}]` : full);
}
function getTransposeLabel(n) { return n === 0 ? 'Ориг.' : (n > 0 ? '+' : '') + n; }
const transposeKey = transposeChord;

// ═══════════════════════════════════════════
//  KEY DETECTION
// ═══════════════════════════════════════════
function detectKeyFromLyrics(lyrics) {
  if (!lyrics) return null;
  const ch = [...String(lyrics).matchAll(/\[([^\]]+)\]/g)].map(m => m[1].trim()).filter(c => CE.isChord(c));
  if (!ch.length) return null;
  const nc = new Array(12).fill(0);
  for (const c of ch) {
    const r = /^([A-H][b#]?)/.exec(c); if (!r) continue;
    const i = NOTES.indexOf(normalizeNote(r[1])); if (i < 0) continue;
    const isM = /^[A-H][b#]?m(?!aj)/.test(c);
    nc[i] += 3; nc[(i + (isM ? 3 : 4)) % 12] += 1; nc[(i + 7) % 12] += 2;
  }
  // Первый и последний аккорд — сильный признак тоники
  [ch[0], ch[ch.length - 1]].forEach(c => { const r = /^([A-H][b#]?)/.exec(c); const i = r ? NOTES.indexOf(normalizeNote(r[1])) : -1; if (i >= 0) nc[i] += 2; });
  const maj = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const min = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  let bk = null, bs = -Infinity, bm = false;
  for (let r = 0; r < 12; r++) {
    let ms = 0, ns = 0;
    for (let i = 0; i < 12; i++) { ms += nc[(r + i) % 12] * maj[i]; ns += nc[(r + i) % 12] * min[i]; }
    if (ms > bs) { bs = ms; bk = r; bm = false; }
    if (ns > bs) { bs = ns; bk = r; bm = true; }
  }
  return bk === null ? null : NOTES[bk] + (bm ? 'm' : '');
}
const _detectedKeyCache = new Map();
// FIX: единый источник тональности. Раньше список песен показывал song.key,
// а экран песни — алгоритм, и они расходились.
function getSongKey(song) {
  if (!song) return 'C';
  if (_detectedKeyCache.has(song.id)) return _detectedKeyCache.get(song.id);
  const detected = detectKeyFromLyrics(song.lyrics);
  const userKey = CE.isChord(song.key) ? song.key : null;
  let k = detected || userKey || 'C';
  // Am и C — одна гамма, алгоритм их не различит надёжно; уважаем выбор пользователя
  if (detected && userKey && sameScale(detected, userKey)) k = userKey;
  _detectedKeyCache.set(song.id, k);
  return k;
}
const getDetectedKey = getSongKey;
function sameScale(a, b) {
  const pa = /^([A-H][b#]?)(m(?!aj))?/.exec(a), pb = /^([A-H][b#]?)(m(?!aj))?/.exec(b);
  if (!pa || !pb) return false;
  const ra = NOTES.indexOf(normalizeNote(pa[1])) + (pa[2] ? 3 : 0), rb = NOTES.indexOf(normalizeNote(pb[1])) + (pb[2] ? 3 : 0);
  return ra % 12 === rb % 12;
}
function displayKey(song) { return transposeKey(getSongKey(song), transposeMap[song.id] || 0, getSongNotation(song.id)); }
function keyForSelect(k) {
  if (!k) return 'C';
  const m = /^([A-H][b#]?)(m?)/.exec(k);
  return m ? normalizeNote(m[1]) + m[2] : 'C';
}

// ═══════════════════════════════════════════
//  SINGERS
// ═══════════════════════════════════════════
const DEFAULT_SINGER_PROFILES = {
  'Сергей': { keysSung: ['F', 'D'], min: 2, max: 5 }, 'Даша': { keysSung: ['A', 'G', 'D', 'Em'], min: 2, max: 9 },
  'Арам': { keysSung: ['E', 'A', 'G', 'Em'], min: 4, max: 9 }, 'Кэти': { keysSung: ['Db', 'D', 'E', 'F', 'B'], min: 1, max: 11 },
  'Саша М': { keysSung: ['D', 'E', 'B', 'G'], min: 2, max: 11 }, 'Саша Ли': { keysSung: ['E'], min: 4, max: 4 }
};
let singerProfiles = LS.get('cb_singers', null) || JSON.parse(JSON.stringify(DEFAULT_SINGER_PROFILES));
function saveSingerProfiles() { LS.set('cb_singers', singerProfiles); }
function keyBareNum(key) { const idx = NOTES.indexOf(normalizeNote(String(key || 'C').replace(/m$/, ''))); return idx === -1 ? 0 : idx; }
const AWKWARD_KEYS = new Set([1, 6]);
function recommendKeyForSinger(originalKey, profile, tolerance) {
  tolerance = tolerance == null ? 1 : tolerance;
  const isMinor = /m$/.test(originalKey || '');
  const songNum = keyBareNum(originalKey);
  const lowConfidence = profile.min === profile.max && (profile.keysSung || []).length <= 1;
  let shift = 0;
  if (songNum >= profile.min - tolerance && songNum <= profile.max + tolerance) shift = 0;
  else if (songNum > profile.max) shift = -(songNum - profile.max);
  else shift = profile.min - songNum;
  if (lowConfidence && Math.abs(shift) <= 2) shift = 0;
  if (shift > 6) shift -= 12;
  if (shift < -6) shift += 12;
  let newNum = ((songNum + shift) % 12 + 12) % 12;
  if (AWKWARD_KEYS.has(newNum) && shift !== 0) {
    const alt = shift + (shift > 0 ? 1 : -1);
    const altNum = ((songNum + alt) % 12 + 12) % 12;
    if (!AWKWARD_KEYS.has(altNum)) { shift = alt; newNum = altNum; }
  }
  return { originalKey, recommendedKey: NOTES[newNum] + (isMinor ? 'm' : ''), shiftSemitones: shift, needsTranspose: shift !== 0, lowConfidence };
}
function updateSingerProfileWithKey(name, appliedKey) {
  const p = singerProfiles[name]; if (!p) return;
  const num = keyBareNum(appliedKey);
  p.keysSung = (p.keysSung || []).concat(appliedKey).slice(-30);
  p.min = Math.min(p.min, num); p.max = Math.max(p.max, num);
  saveSingerProfiles();
}
function applySingerTranspose(song, name) {
  const profile = singerProfiles[name]; if (!profile) return;
  if (_inlineEditActive) { showToast('Сначала сохраните или отмените редактирование'); return; }
  const rec = recommendKeyForSinger(getSongKey(song), profile);
  transposeOffset = rec.shiftSemitones;
  saveTranspose(song.id, transposeOffset);
  updateSingerProfileWithKey(name, rec.recommendedKey);
  closeOverlay('overlay-singer-picker');
  renderSongView(song);
  showToast(rec.needsTranspose ? `${name}: ${rec.recommendedKey} (сдвиг ${rec.shiftSemitones > 0 ? '+' : ''}${rec.shiftSemitones})` : `${name}: ${rec.recommendedKey} — без транспозиции`);
}
function renderSingerPickerList(song) {
  const list = $('singer-picker-list');
  const names = Object.keys(singerProfiles);
  if (!names.length) { list.innerHTML = '<p style="color:var(--muted);font-size:14px;text-align:center;padding:20px">Добавьте первого солиста ниже</p>'; return; }
  const originalKey = getSongKey(song);
  list.innerHTML = names.map(name => {
    const rec = recommendKeyForSinger(originalKey, singerProfiles[name]);
    const meta = !rec.needsTranspose ? `уже комфортно · ${rec.recommendedKey}` : `${originalKey} → ${rec.recommendedKey} (${rec.shiftSemitones > 0 ? '+' : ''}${rec.shiftSemitones})`;
    return `<div class="setlist-card" data-name="${escapeHtml(name)}" style="display:flex;align-items:center;gap:10px">
      <div style="flex:1;min-width:0" class="singer-row-body"><div class="setlist-title">${escapeHtml(name)}</div>
      <div class="setlist-meta">${escapeHtml(meta)}${rec.lowConfidence ? ' · мало данных' : ''}</div></div>
      <span class="reorder-btn remove-singer" aria-label="Удалить солиста">✕</span></div>`;
  }).join('');
  list.querySelectorAll('.setlist-card').forEach(card => {
    card.querySelector('.singer-row-body').addEventListener('click', () => applySingerTranspose(song, card.dataset.name));
    card.querySelector('.remove-singer').addEventListener('click', e => {
      e.stopPropagation();
      const name = card.dataset.name;
      showConfirm({ title: 'Удалить солиста?', msg: name, onOk: () => { delete singerProfiles[name]; saveSingerProfiles(); renderSingerPickerList(song); } });
    });
  });
}
function openSingerPicker(song) {
  renderSingerPickerList(song);
  openOverlay('overlay-singer-picker');
  $('add-singer-btn').onclick = () => {
    const inp = $('inp-new-singer'); const name = inp.value.trim();
    if (!name) return;
    if (singerProfiles[name]) { showToast('Такой солист уже есть'); return; }
    const num = keyBareNum(getSongKey(song));
    singerProfiles[name] = { keysSung: [], min: num, max: num };
    saveSingerProfiles(); inp.value = ''; renderSingerPickerList(song); showToast('Солист добавлен');
  };
}

// ═══════════════════════════════════════════
//  PARSE SONG
// ═══════════════════════════════════════════
const isBlockLabel = CE.isBlockLabel;
function convertToLyrics(s) {
  if (typeof s.lyrics === 'string') return s.lyrics.replace(/\\n/g, '\n').replace(/\r/g, '');
  if (Array.isArray(s.structure)) {
    return s.structure.map(block => {
      const label = block.type ? block.type.charAt(0).toUpperCase() + block.type.slice(1) + (block.number ? ' ' + block.number : '') : '';
      const chordsLine = block.chords ? String(block.chords).trim().split(/\s+/).map(c => '[' + c + ']').join(' ') : '';
      return (label ? '[' + label + ']\n' : '') + (chordsLine ? chordsLine + '\n' : '') + (block.lines || []).join('\n');
    }).join('\n\n');
  }
  if (Array.isArray(s.sections)) return s.sections.map(sec => { const l = sec.name || sec.type || ''; return (l ? '[' + l + ']\n' : '') + (sec.lyrics || sec.text || ''); }).join('\n\n');
  return '';
}
// Блоки: [{label, lines, repeat}]. Индексация блоков стабильна — на неё опираются
// сворачивание и ключи раскладок «Только аккорды».
function parseSong(rawLyrics, transpose, notation) {
  let lyrics = String(rawLyrics || '').replace(/\r/g, '');
  const trimmed = lyrics.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const obj = Array.isArray(parsed) ? parsed[0] : parsed;
      if (obj && (obj.structure || obj.sections || obj.lyrics)) lyrics = convertToLyrics(obj);
    } catch {}
  }
  const lines = transposeLyrics(lyrics, transpose || 0, notation).split('\n');
  const blocks = [];
  let current = { label: '', lines: [], repeat: 1 };
  for (const line of lines) {
    const t = line.trim();
    const m = t.match(/^\[([^\]]+)\]$/);
    if (m && isBlockLabel(m[1])) {
      if (current.lines.some(l => l.trim()) || current.label) blocks.push(current);
      current = { label: m[1].trim(), lines: [], repeat: 1 };
      continue;
    }
    const repM = t.match(/^#repeat:(\d+)$/);
    if (repM) { current.repeat = Math.max(1, parseInt(repM[1], 10) || 1); continue; }
    current.lines.push(line);
  }
  if (current.lines.some(l => l.trim()) || current.label) blocks.push(current);
  return blocks;
}

// ═══════════════════════════════════════════
//  BLOCK COLORS
// ═══════════════════════════════════════════
// Цвет части — переменная темы: в «Сцене», «Дне» и «Контрасте» свои оттенки
const BLOCK_COLOR_MAP = [
  { keys: ['пре-припев', 'pre-chorus', 'предприпев', 'prechorus'], color: 'var(--intro)' },
  { keys: ['пост-припев', 'post-chorus', 'постприпев'], color: 'var(--chorus)' },
  { keys: ['куплет', 'verse', 'couplet', 'запев'], color: 'var(--verse)' },
  { keys: ['припев', 'chorus', 'refrain', 'реф', 'хор'], color: 'var(--chorus)' },
  { keys: ['бридж', 'bridge', 'мост'], color: 'var(--bridge)' },
  { keys: ['вступление', 'вступ', 'intro'], color: 'var(--intro)' },
  { keys: ['проигрыш', 'instrumental', 'соло', 'solo', 'interlude'], color: 'var(--solo)' },
  { keys: ['аутро', 'outro', 'концовка', 'ending', 'кода', 'coda', 'тег', 'tag'], color: 'var(--outro)' },
];
const FALLBACK_COLORS = ['var(--verse)', 'var(--chorus)', 'var(--bridge)', 'var(--intro)', 'var(--solo)', 'var(--outro)'];
function getBlockColor(label, fallbackIdx) {
  if (!label) return FALLBACK_COLORS[(fallbackIdx || 0) % FALLBACK_COLORS.length];
  const norm = CE.genericLabel(label);
  for (const { keys, color } of BLOCK_COLOR_MAP) if (keys.some(k => norm === k || norm.startsWith(k))) return color;
  let hash = 2166136261;
  for (const ch of norm.replace(/\s+/g, '')) { hash ^= ch.charCodeAt(0); hash = (hash * 16777619) >>> 0; }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}

// ═══════════════════════════════════════════
//  RENDER — СЛОВА + АККОРДЫ
// ═══════════════════════════════════════════
function lineChords(line) { return [...String(line).matchAll(/\[([^\]]+)\]/g)].map(m => m[1].trim()).filter(c => CE.isChord(c)); }
function lineLyric(line) { return String(line).replace(/\[[^\]]+\]/g, '').trim(); }

function isAllSingleChordNoText(lines) {
  const chordLines = lines.filter(l => lineChords(l).length);
  return chordLines.length > 0 && chordLines.every(l => lineChords(l).length === 1 && !lineLyric(l)) && lines.every(l => !lineLyric(l) || lineChords(l).length);
}
function collapseRepeatingLines(lines) {
  const result = [];
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i].trim();
    if (!cur) { i++; continue; }
    let count = 1;
    while (i + count < lines.length && lines[i + count].trim() === cur) count++;
    result.push({ line: lines[i], count });
    i += count;
  }
  return result;
}
function renderLineWithRepeat(line, count) {
  const chords = lineChords(line);
  const lyric = lineLyric(line);
  if (!chords.length && !lyric) return '';
  const rep = count > 1 ? `<span class="repeat-badge" style="margin-left:6px">×${count}</span>` : '';
  let inner = '';
  if (chords.length) inner += `<div class="chord-row">${chords.map(c => `<span class="chord-badge">${escapeHtml(c)}</span>`).join('')}${lyric ? '' : rep}</div>`;
  if (lyric) inner += `<div class="lyric-line">${escapeHtml(lyric)}${rep}</div>`;
  return `<div class="ie-line-wrap">${inner}</div>`;
}
function renderBlockLabel(label, repeat) {
  if (!label) return '';
  return `<div class="block-label-card">${escapeHtml(label)}${repeat > 1 ? `<span class="block-repeat-badge">×${repeat}</span>` : ''}</div>`;
}
function renderMixedBlock(song, b, i) {
  if (!b.lines.some(l => l.trim()) && !b.label) return '';
  const color = getBlockColor(b.label, i);
  const collapsed = isCollapsed(song.id, 'm' + i, false);
  const colBtn = `<button class="block-collapse-btn" data-ck="m${i}" aria-label="Свернуть блок">▼</button>`;
  const head = `<div class="block-header-row">${renderBlockLabel(b.label, b.repeat) || '<span></span>'}${colBtn}</div>`;
  let body;
  if (isAllSingleChordNoText(b.lines)) {
    const all = b.lines.filter(l => lineChords(l).length).map(l => lineChords(l)[0]);
    body = `<div class="chord-row">${all.map(c => `<span class="chord-badge">${escapeHtml(c)}</span>`).join('')}</div>`;
  } else {
    body = collapseRepeatingLines(b.lines).map(({ line, count }) => renderLineWithRepeat(line, count)).join('');
  }
  return `<div class="song-card-block${collapsed ? ' block-collapsed' : ''}" style="--block-color:${color}">${head}<div class="block-chords">${body}</div></div>`;
}
function countBlockLines(block) {
  let n = 0;
  for (const line of block.lines) { if (lineChords(line).length) n++; if (lineLyric(line)) n++; }
  return Math.max(n, block.lines.length ? 1 : 0);
}
function twoColAllowed() {
  if (window.innerWidth >= 640) return true;
  return !!(window.matchMedia && window.matchMedia('(orientation: landscape)').matches) && window.innerWidth >= 480;
}
function splitBlocksToColumns(blocks, renderBlock) {
  const TH = 23;
  const items = blocks.map((b, i) => ({ html: renderBlock(b, i), lines: countBlockLines(b) })).filter(x => x.html);
  const total = items.reduce((s, x) => s + x.lines, 0);
  if (total <= TH || !twoColAllowed() || items.length < 2) return items.map(x => x.html).join('');
  // Делим пополам по числу строк — колонки получаются сбалансированными
  let sum = 0, splitIdx = items.length;
  for (let i = 0; i < items.length; i++) { if (sum + items[i].lines / 2 > total / 2 && i > 0) { splitIdx = i; break; } sum += items[i].lines; }
  const left = items.slice(0, splitIdx).map(x => x.html).join('');
  const right = items.slice(splitIdx).map(x => x.html).join('');
  return right ? `<div class="song-two-col"><div class="song-col">${left}</div><div class="song-col">${right}</div></div>` : left;
}

// ═══════════════════════════════════════════
//  RENDER — ТОЛЬКО АККОРДЫ (квадраты, форма песни)
// ═══════════════════════════════════════════
function partWeight(a) { return Math.max(1, CE.expandSquares(a.squares).length); }
// Карта песни: полоса, где ширина части = число тактов × повторы
function songMapHtml(items, analysis, editable, custom) {
  if (!items.length) return '';
  const seg = items.map(it => { const a = analysis[it.bi]; return { w: partWeight(a) * it.repeat, c: getBlockColor(a.label, it.bi), label: (a.label || '—') + (it.repeat > 1 ? ' ×' + it.repeat : '') }; });
  return `<div class="cs-map">
    ${editable ? `<div class="cs-map-head"><span class="cs-map-title">Порядок${custom ? ' <span class="cs-custom">свой</span>' : ''}</span>
      <button class="cs-map-edit" data-arr-edit aria-label="Изменить порядок песни"><svg class="ico"><use href="#i-edit"/></svg>Изменить</button></div>` : ''}
    <div class="cs-map-bar">${seg.map((x, i) => `<i data-goto-item="${i}" style="flex:${x.w};--c:${x.c}" title="${escapeHtml(x.label)}"></i>`).join('')}</div>
    <div class="cs-map-labels">${seg.map((x, i) => `<span data-goto-item="${i}" style="flex:${x.w}">${escapeHtml(x.label)}</span>`).join('')}</div></div>`;
}
// Режим «Аккорды» идёт по ПОРЯДКУ ПЕСНИ (song.arrangement, по умолчанию — как в тексте).
// Часть, которая уже звучала выше с теми же аккордами, свёрнута и помечена «как …».
function renderChordsOnly(song, blocks, transpose, notation) {
  const analysis = CE.analyzeSong(blocks, song.chordsOnlyLayout, transpose, notation);
  const items = CE.resolveArrangement(song.arrangement, blocks, analysis);
  const custom = !!(song.arrangement && song.arrangement.length) && !CE.isDefaultArrangement(song.arrangement, blocks, analysis);
  const shown = new Map(); // sig → label первого показа
  const body = items.map((it, i) => {
    const a = analysis[it.bi];
    if (!a || !a.squares.length) return '';
    const color = getBlockColor(a.label, it.bi);
    const firstLabel = shown.get(a.sig);
    const isRepeat = firstLabel !== undefined;
    if (!isRepeat) shown.set(a.sig, a.label || 'выше');
    const collapsed = isCollapsed(song.id, 'a' + i, isRepeat);
    const note = isRepeat ? `<span class="cs-repeat-note">как ${escapeHtml(firstLabel)}</span>` : '';
    const times = it.repeat > 1 ? `<span class="cs-times-badge">×${it.repeat}</span>` : '';
    const manual = a.manual ? '<span class="cs-manual-dot" title="Ручная раскладка">свои квадраты</span>' : '';
    const label = `<span class="chords-only-label">${escapeHtml(a.label || 'Без метки')}</span>`;
    return `<div class="chords-only-block${isRepeat ? ' is-repeat' : ''}${collapsed ? ' block-collapsed' : ''}" id="co-item-${i}" data-orig-bi="${it.bi}" style="--block-color:${color}">
      <div class="chords-only-header">${label}${times}${note}${manual}<button class="block-collapse-btn" data-ck="a${i}" aria-label="Свернуть часть">▼</button></div>
      <div class="chords-only-rows-wrap">${CE.squaresToHtml(a.squares)}</div></div>`;
  }).join('');
  return songMapHtml(items, analysis, true, custom) + body;
}

const _renderCache = new Map();
const RENDER_CACHE_MAX = 30;
function renderSongContent(song, transpose) {
  const notation = getSongNotation(song.id);
  const cacheKey = song.id + ':' + transpose + ':' + (notation || 'x') + ':' + (twoColAllowed() ? 2 : 1);
  if (_renderCache.has(cacheKey)) return _renderCache.get(cacheKey);
  const blocks = parseSong(song.lyrics, transpose, notation);
  const html = splitBlocksToColumns(blocks, (b, i) => renderMixedBlock(song, b, i)) + renderChordsOnly(song, blocks, transpose, notation);
  if (_renderCache.size >= RENDER_CACHE_MAX) _renderCache.delete(_renderCache.keys().next().value);
  _renderCache.set(cacheKey, html);
  return html;
}
function invalidateSongCache(songId) {
  for (const key of [..._renderCache.keys()]) if (key.startsWith(songId + ':')) _renderCache.delete(key);
  _detectedKeyCache.delete(songId);
}

// ═══════════════════════════════════════════
//  COLLAPSE — состояние «свёрнут» хранится как отличие от значения по умолчанию
//  (повторные блоки в режиме «Аккорды» по умолчанию свёрнуты)
// ═══════════════════════════════════════════
const _collapsedCache = {};
function getCollapsed(songId) {
  if (!_collapsedCache[songId]) _collapsedCache[songId] = new Set((LS.get('cb_collapsed_' + songId, []) || []).map(String));
  return _collapsedCache[songId];
}
function toggleCollapsed(songId, ck) {
  const set = getCollapsed(songId); ck = String(ck);
  if (set.has(ck)) set.delete(ck); else set.add(ck);
  LS.set('cb_collapsed_' + songId, [...set]);
}
function isCollapsed(songId, ck, byDefault) { return getCollapsed(songId).has(String(ck)) !== !!byDefault; }

// ═══════════════════════════════════════════
//  VIRTUAL SCROLL
// ═══════════════════════════════════════════
const VIRTUAL = (() => {
  const CARD_HEIGHT = 68; // высота строки зафиксирована в CSS (.song-card)
  const OVERSCAN = 6;
  let _list = [], _container = null, _scrollHandler = null, _resizeOb = null;
  function onClick(e) {
    const tagEl = e.target.closest('[data-tag-filter]');
    if (tagEl) { e.stopPropagation(); setTagFilter(tagEl.dataset.tagFilter); return; }
    const card = e.target.closest('.song-card');
    if (card) openSong(card.dataset.id);
  }
  function mount(container) {
    if (_container === container && _scrollHandler) return;
    destroy();
    _container = container;
    _scrollHandler = () => requestAnimationFrame(render);
    // FIX: раньше remove вызывался с capture=true, а add — без → обработчики копились при каждом поиске
    window.addEventListener('scroll', _scrollHandler, { passive: true });
    container.addEventListener('click', onClick);
    if (window.ResizeObserver) { _resizeOb = new ResizeObserver(debounce(render, 50)); _resizeOb.observe(container); }
  }
  function setList(list) { _list = list; render(); }
  function render() {
    if (!_container || currentPage !== 'songs') return;
    const total = _list.length;
    if (!total) { _container.innerHTML = ''; _container.style.height = ''; return; }
    const containerTop = _container.getBoundingClientRect().top + window.scrollY;
    const scrollTop = window.scrollY - containerTop;
    const viewH = window.innerHeight || 800;
    const startIdx = Math.max(0, Math.floor(scrollTop / CARD_HEIGHT) - OVERSCAN);
    const endIdx = Math.min(total, Math.ceil((scrollTop + viewH) / CARD_HEIGHT) + OVERSCAN);
    const key = startIdx + ':' + endIdx + ':' + total;
    if (_container.dataset.vkey === key && _container.dataset.vver === String(_ver)) return;
    _container.dataset.vkey = key; _container.dataset.vver = String(_ver);
    _container.style.height = (total * CARD_HEIGHT + 16) + 'px';
    _container.innerHTML = `<div style="height:${startIdx * CARD_HEIGHT}px"></div>` + _list.slice(startIdx, endIdx).map(renderSongCard).join('');
  }
  let _ver = 0;
  function bump() { _ver++; }
  function destroy() {
    if (_scrollHandler) window.removeEventListener('scroll', _scrollHandler);
    if (_container) _container.removeEventListener('click', onClick);
    if (_resizeOb) _resizeOb.disconnect();
    _scrollHandler = null; _resizeOb = null; _container = null;
  }
  return { mount, setList, render, destroy, bump };
})();

function renderSongCard(s) {
  const offset = transposeMap[s.id] || 0;
  const meta = [];
  if (s.artist) meta.push(escapeHtml(s.artist));
  if (s.bpm) meta.push(`${s.bpm} BPM`);
  (s.tags || []).forEach(t => meta.push(`<span class="tag" data-tag-filter="${escapeHtml(t)}">${escapeHtml(t)}</span>`));
  return `<div class="song-card" data-id="${escapeHtml(s.id)}">
    <div class="song-card-info"><div class="song-card-title">${escapeHtml(s.title || 'Без названия')}</div>
    <div class="song-card-meta">${meta.join(', ')}</div></div>
    ${offset ? `<span class="song-card-shift">${offset > 0 ? '+' : ''}${offset}</span>` : ''}
    <div class="song-card-key">${escapeHtml(displayKey(s))}</div></div>`;
}

// ═══════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════
const PAGE_DEPTH = { songs: 0, setlists: 0, 'setlist-view': 1, 'song-view': 2 };
let _shownPage = 'songs';
let _pageSwitchToken = 0;
function showPage(name) {
  const prev = _shownPage;
  const goingBack = (PAGE_DEPTH[name] ?? 0) < (PAGE_DEPTH[prev] ?? 0);
  const prevEl = $('page-' + prev), nextEl = $('page-' + name);
  // FIX: currentPage меняется сразу (логика не ждёт анимацию), а быстрые повторные
  // переходы отменяют устаревшие таймеры анимации.
  currentPage = name;
  const token = ++_pageSwitchToken;
  closeMenu();
  const doSwitch = () => {
    if (token !== _pageSwitchToken) return;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active', 'slide-back', 'slide-out-right', 'slide-out-left'));
    nextEl.classList.add('active');
    if (goingBack) nextEl.classList.add('slide-back');
    _shownPage = name;
    applyPageUI(name);
  };
  if (prevEl && prevEl.classList.contains('active') && prev !== name) {
    prevEl.classList.add(goingBack ? 'slide-out-right' : 'slide-out-left');
    setTimeout(doSwitch, 180);
  } else doSwitch();
}
function applyPageUI(name) {
  const isList = name === 'songs' || name === 'setlists';
  $('search-wrap').style.display = name === 'songs' ? '' : 'none';
  $('search-stats').style.display = name === 'songs' ? '' : 'none';
  $('sort-chips').style.display = name === 'songs' ? 'flex' : 'none';
  if (name !== 'songs') $('tag-filter-bar').style.display = 'none'; else renderTagFilterBar();
  $('fab-btn').style.display = isList ? '' : 'none';
  document.querySelector('.bottom-nav').style.display = isList ? '' : 'none';
  $('back-btn').style.display = isList ? 'none' : '';
  document.body.classList.toggle('page-list', isList);
  if (isList) $('header-actions').innerHTML = '';
  if (name !== 'song-view') $('perf-nav-buttons').classList.remove('show');
  document.querySelectorAll('.nav-btn[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  if (name === 'songs') { $('header-title').textContent = 'Песни'; renderSongs($('search-input').value); }
  else if (name === 'setlists') { $('header-title').textContent = 'Сет-листы'; renderSetlists(); }
  updateHeaderHeight();
}

// ═══════════════════════════════════════════
//  SONGS LIST
// ═══════════════════════════════════════════
let _renderSongsSeq = 0;
let _sortMode = LS.get('cb_sort', 'recent');
let _activeTagFilter = null;
function searchSongs(query) {
  const ql = String(query || '').trim().toLowerCase();
  let list = songsCache.slice();
  if (_activeTagFilter) list = list.filter(s => (s.tags || []).includes(_activeTagFilter));
  if (!ql) {
    if (_sortMode === 'alpha') list.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ru'));
    else list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return list;
  }
  const scored = [];
  for (const s of list) {
    const title = (s.title || '').toLowerCase();
    let score = -1;
    if (title.startsWith(ql)) score = 0;
    else if (title.includes(ql)) score = 1;
    else if ((s.artist || '').toLowerCase().includes(ql)) score = 2;
    else if ((s.tags || []).some(t => String(t).toLowerCase().includes(ql))) score = 3;
    else if (ql.length >= 3 && lineLyric(s.lyrics || '').toLowerCase().includes(ql)) score = 4;
    if (score >= 0) scored.push([score, s]);
  }
  scored.sort((a, b) => a[0] - b[0] || (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  return scored.map(x => x[1]);
}
// FIX: поиск идёт по songsCache в памяти (раньше — по IndexedDB, которая могла
// отставать/содержать удалённые песни) и защищён от гонки ответов.
function renderSongs(filter = '') {
  const seq = ++_renderSongsSeq;
  const container = $('songs-container');
  if (!container) return;
  const list = searchSongs(filter);
  if (seq !== _renderSongsSeq) return;
  const statsEl = $('search-stats');
  statsEl.textContent = filter ? (list.length ? `Найдено: ${list.length}` : 'Ничего не найдено') : `${songsCache.length} ${plural(songsCache.length, 'песня', 'песни', 'песен')}`;
  if (!list.length) {
    VIRTUAL.destroy();
    container.style.height = '';
    container.innerHTML = `<div class="empty"><div class="empty-icon">🎸</div><p>${filter ? 'Ничего не найдено' : 'Добавьте первую песню!'}</p></div>`;
    return;
  }
  if (container.querySelector('.empty')) container.innerHTML = '';
  VIRTUAL.mount(container);
  VIRTUAL.bump();
  VIRTUAL.setList(list);
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
function setTagFilter(tag) {
  _activeTagFilter = _activeTagFilter === tag ? null : tag;
  renderTagFilterBar();
  renderSongs($('search-input').value);
}
function renderTagFilterBar() {
  const bar = $('tag-filter-bar');
  if (!_activeTagFilter || currentPage !== 'songs') { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = '';
  const tagEl = document.createElement('span'); tagEl.className = 'tag'; tagEl.style.cssText = 'font-size:12px;padding:4px 10px'; tagEl.textContent = '🏷 ' + _activeTagFilter;
  const clear = document.createElement('button'); clear.className = 'tag-filter-clear'; clear.textContent = '✕ Сбросить';
  clear.addEventListener('click', () => setTagFilter(_activeTagFilter));
  bar.append(tagEl, clear);
}
function openSong(id, ctx) {
  const song = songsCache.find(s => s.id === id);
  if (!song) { showToast('Песня не найдена'); return; }
  currentSongId = song.id;
  transposeOffset = transposeMap[song.id] || 0;
  setlistContext = ctx || null;
  renderSongView(song);
  showPage('song-view');
}

// ═══════════════════════════════════════════
//  SONG VIEW
// ═══════════════════════════════════════════
let _swipeController = null;
function renderSongView(song, animDir) {
  const currentKey = transposeKey(getSongKey(song), transposeOffset, getSongNotation(song.id));
  $('header-title').textContent = song.title;
  $('header-actions').innerHTML = `
    <button class="icon-btn ${_inlineEditActive ? 'active' : ''}" id="song-inline-edit-btn" aria-label="Редактировать"><svg class="ico"><use href="#i-edit"/></svg></button>
    <button class="icon-btn" id="song-overflow-btn" aria-label="Ещё"><svg class="ico"><use href="#i-more"/></svg></button>`;
  let navBar = '';
  if (setlistContext) {
    const idx = setlistContext.index, total = setlistContext.songs.length;
    navBar = `<div class="setlist-nav-bar">
      <button class="snav-btn ${idx > 0 ? '' : 'disabled'}" id="snav-prev" aria-label="Предыдущая"><svg class="ico"><use href="#i-left"/></svg></button>
      <span class="snav-label">${idx + 1} из ${total}</span>
      <button class="snav-btn ${idx < total - 1 ? '' : 'disabled'}" id="snav-next" aria-label="Следующая"><svg class="ico"><use href="#i-right"/></svg></button></div>`;
  }
  const lock = _inlineEditActive ? 'disabled' : '';
  $('song-header').innerHTML = `
    <div class="song-view-controls">
      <div class="transpose-block">
        <button class="transpose-btn" id="tr-down" aria-label="Понизить на полтона" ${lock}>−</button>
        <div class="transpose-val" id="tr-val" title="Тап — вернуть оригинал">${escapeHtml(currentKey)}<small>${transposeOffset ? (transposeOffset > 0 ? '+' : '') + transposeOffset : 'ориг.'}</small></div>
        <button class="transpose-btn" id="tr-up" aria-label="Повысить на полтона" ${lock}>+</button>
      </div>
      <div class="mode-seg" id="song-view-mode-btn" role="group" aria-label="Режим просмотра">
        <button data-mode="words">Слова</button><button data-mode="both">Оба</button><button data-mode="chords">Аккорды</button>
      </div>
    </div>${navBar}`;

  const inner = $('song-content-inner');
  inner.className = ''; inner.style.transform = ''; inner.style.opacity = '';
  if (animDir) {
    inner.style.transition = 'none';
    inner.classList.add(animDir === 'left' ? 'swipe-from-right' : 'swipe-from-left');
    inner.innerHTML = renderSongContent(song, transposeOffset);
    void inner.offsetWidth;
    inner.style.transition = '';
    inner.classList.remove('swipe-from-right', 'swipe-from-left');
  } else {
    inner.style.transition = '';
    inner.innerHTML = renderSongContent(song, transposeOffset);
  }
  applySongViewMode();
  updateSongViewModeBtn();

  const transposeBy = d => {
    if (_inlineEditActive) { showToast('Транспонирование недоступно во время редактирования'); return; }
    transposeOffset += d; if (transposeOffset > 11) transposeOffset -= 12; if (transposeOffset < -11) transposeOffset += 12;
    saveTranspose(song.id, transposeOffset); renderSongView(song);
  };
  $('song-view-mode-btn').addEventListener('click', e => { const b = e.target.closest('[data-mode]'); if (b) setSongViewMode(b.dataset.mode); });
  $('tr-up').addEventListener('click', () => transposeBy(1));
  $('tr-down').addEventListener('click', () => transposeBy(-1));
  // FIX: dblclick не работает на телефонах — сброс транспозиции одиночным тапом по тональности
  $('tr-val').addEventListener('click', () => { if (!transposeOffset || _inlineEditActive) return; transposeOffset = 0; saveTranspose(song.id, 0); renderSongView(song); showToast('Оригинальная тональность'); });
  $('song-inline-edit-btn').addEventListener('click', () => toggleInlineEdit(song));
  $('song-overflow-btn').addEventListener('click', e => { e.stopPropagation(); showSongOverflowMenu(song, e.currentTarget); });
  if (setlistContext) {
    if (setlistContext.index > 0) $('snav-prev').addEventListener('click', () => navigateSetlistSong(-1));
    if (setlistContext.index < setlistContext.songs.length - 1) $('snav-next').addEventListener('click', () => navigateSetlistSong(1));
  }
  renderPerfNav(song);
  initSongSwipe();
  initSongContentClicks(song);
  if (_inlineEditActive && _inlineEditSong && _inlineEditSong.id === song.id) _ieRedraw();
  else { window.scrollTo(0, 0); }
  $('song-header').classList.remove('sv-hidden');
  _svHeaderHidden = false;
  _svLastScrollY = window.scrollY || 0;
}

function renderPerfNav(song) {
  const el = $('perf-nav-buttons');
  const active = performanceMode && !!setlistContext && !_inlineEditActive;
  $('song-header').classList.toggle('perf-active', active);
  if (!active) { el.classList.remove('show'); el.innerHTML = ''; return; }
  const i = setlistContext.index, n = setlistContext.songs.length;
  el.innerHTML = `<button class="perf-nav-btn ${i > 0 ? '' : 'disabled'}" id="perf-prev" aria-label="Предыдущая"><svg class="ico"><use href="#i-up"/></svg></button>
    <div class="perf-nav-pos" id="perf-pos" title="Выключить режим выступления">${i + 1}/${n}</div>
    <button class="perf-nav-btn ${i < n - 1 ? '' : 'disabled'}" id="perf-next" aria-label="Следующая"><svg class="ico"><use href="#i-down"/></svg></button>`;
  el.classList.add('show');
  if (i > 0) $('perf-prev').addEventListener('click', () => navigateSetlistSong(-1));
  if (i < n - 1) $('perf-next').addEventListener('click', () => navigateSetlistSong(1));
  $('perf-pos').addEventListener('click', () => { performanceMode = false; renderSongView(song); showToast('Режим выступления выключен'); });
}

// Автоскрытие панели при прокрутке вниз (как в читалках)
let _svLastScrollY = 0, _svHeaderHidden = false;
function _svTick() {
  if (currentPage === 'song-view' && !_inlineEditActive) {
    const header = $('song-header');
    const y = window.scrollY || 0;
    const delta = y - _svLastScrollY;
    if (y < 40) { if (_svHeaderHidden) { header.classList.remove('sv-hidden'); _svHeaderHidden = false; } }
    else if (delta > 4 && !_svHeaderHidden) { header.classList.add('sv-hidden'); _svHeaderHidden = true; }
    else if (delta < -4 && _svHeaderHidden) { header.classList.remove('sv-hidden'); _svHeaderHidden = false; }
    _svLastScrollY = y;
  }
  requestAnimationFrame(_svTick);
}
requestAnimationFrame(_svTick);

function navigateSetlistSong(dir, anim) {
  if (!setlistContext) return;
  if (_inlineEditActive) { showToast('Сначала сохраните или отмените редактирование'); return; }
  const ni = setlistContext.index + dir;
  if (ni < 0 || ni >= setlistContext.songs.length) return;
  const next = songsCache.find(s => s.id === setlistContext.songs[ni]);
  if (!next) return;
  currentSongId = next.id;
  transposeOffset = transposeMap[next.id] || 0;
  setlistContext = { ...setlistContext, index: ni };
  renderSongView(next, anim || (dir > 0 ? 'left' : 'right'));
}

let _contentClickController = null;
function initSongContentClicks(song) {
  if (_contentClickController) _contentClickController.abort();
  _contentClickController = new AbortController();
  $('song-content-inner').addEventListener('click', e => {
    const btn = e.target.closest('.block-collapse-btn');
    if (btn && !_inlineEditActive) {
      e.stopPropagation();
      toggleCollapsed(song.id, btn.dataset.ck);
      invalidateSongCache(song.id);
      const block = btn.closest('.song-card-block, .chords-only-block');
      if (block) block.classList.toggle('block-collapsed');
      return;
    }
    if (e.target.closest('[data-arr-edit]')) { openArrangementEditor(song); return; }
    const chip = e.target.closest('[data-goto-item]');
    if (chip) {
      const target = $('co-item-' + chip.dataset.gotoItem);
      if (target) {
        target.classList.remove('block-collapsed');
        const top = target.getBoundingClientRect().top + window.scrollY - ($('main-header').offsetHeight + 8);
        window.scrollTo({ top, behavior: 'smooth' });
      }
    }
  }, { signal: _contentClickController.signal });
}

function initSongSwipe() {
  if (_swipeController) _swipeController.abort();
  _swipeController = new AbortController();
  const { signal } = _swipeController;
  const el = $('song-content-area');
  let sx = 0, sy = 0, tracking = false;
  el.addEventListener('touchstart', e => {
    if (_inlineEditActive || e.touches.length > 1) { tracking = false; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true, signal });
  el.addEventListener('touchend', e => {
    if (!tracking || _inlineEditActive) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.7) return;
    const inner = $('song-content-inner');
    if (setlistContext) {
      const hasPrev = setlistContext.index > 0, hasNext = setlistContext.index < setlistContext.songs.length - 1;
      if (dx < 0 && hasNext) { inner.classList.add('swipe-left'); setTimeout(() => navigateSetlistSong(1, 'left'), 200); }
      else if (dx > 0 && hasPrev) { inner.classList.add('swipe-right'); setTimeout(() => navigateSetlistSong(-1, 'right'), 200); }
      else if (dx > 0) goBack();
    } else if (dx > 0) goBack();
  }, { passive: true, signal });
}

function goBack() {
  if (_inlineEditActive) {
    // FIX: раньше «назад» молча выбрасывал несохранённые правки
    if (_ieIsDirty()) {
      showConfirm({ title: 'Выйти без сохранения?', msg: 'Изменения в этой песне будут потеряны.', okLabel: 'Выйти', onOk: () => { _ieTeardown(); goBack(); } });
      return;
    }
    _ieTeardown();
  }
  closeMenu();
  if (currentPage === 'song-view') {
    if (setlistContext) { setlistContext = null; showPage('setlist-view'); const sl = getSlById(currentSetlistId); if (sl) renderSetlistView(sl); }
    else showPage('songs');
  } else if (currentPage === 'setlist-view') showPage('setlists');
}

// Свайп «назад» на экране сет-листа и между вкладками
(function () {
  let sx = 0, sy = 0, active = false;
  document.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; active = true; }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!active) return; active = false;
    if (document.querySelector('.overlay.open') || e.target.closest('.drag-handle, .song-view-controls-wrap, .import-tabs')) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.7) return;
    if (currentPage === 'setlist-view' && dx > 0) goBack();
    else if (currentPage === 'songs' && dx < 0) showPage('setlists');
    else if (currentPage === 'setlists' && dx > 0) showPage('songs');
  }, { passive: true });
})();

// ═══════════════════════════════════════════
//  ADD / EDIT SONG
// ═══════════════════════════════════════════
let _userPickedKey = false;
let _initialChordsOnlyText = '';
function openAddSong() {
  selectedTags = [];
  $('inp-title').value = ''; $('inp-artist').value = ''; $('inp-key').value = 'C';
  $('inp-lyrics').value = ''; $('inp-bpm').value = ''; $('inp-chords-only').value = '';
  $('chords-only-details').open = false;
  $('edit-song-id').value = '';
  $('delete-song-btn').style.display = 'none';
  $('add-song-title').textContent = 'Добавить песню';
  document.querySelectorAll('#tag-chips .chip').forEach(c => c.classList.remove('selected'));
  _userPickedKey = false; _initialChordsOnlyText = '';
  isEditingDrawerOpen = true;
  openOverlay('overlay-add-song');
}
function openEditSong(id) {
  const song = songsCache.find(s => s.id === id);
  if (!song) return;
  selectedTags = [...(song.tags || [])];
  $('inp-title').value = song.title || '';
  $('inp-artist').value = song.artist || '';
  $('inp-key').value = keyForSelect(song.key || getSongKey(song));
  $('inp-lyrics').value = song.lyrics || '';
  $('inp-bpm').value = song.bpm || '';
  const text = song.chordsOnlyLayout ? CE.layoutToText(song.chordsOnlyLayout, parseSong(song.lyrics, 0)) : '';
  $('inp-chords-only').value = text;
  _initialChordsOnlyText = text;
  $('chords-only-details').open = !!text;
  $('edit-song-id').value = id;
  $('delete-song-btn').style.display = '';
  $('add-song-title').textContent = 'Редактировать';
  document.querySelectorAll('#tag-chips .chip').forEach(c => c.classList.toggle('selected', selectedTags.includes(c.dataset.tag)));
  _userPickedKey = true;
  isEditingDrawerOpen = true;
  openOverlay('overlay-add-song');
}

// Собирает объект песни из формы (без побочных эффектов — удобно тестировать)
function buildSongFromForm(prev) {
  const title = $('inp-title').value.trim();
  const lyrics = $('inp-lyrics').value.replace(/\r/g, '');
  let key = $('inp-key').value;
  if (!_userPickedKey) { const dk = detectKeyFromLyrics(lyrics); if (dk) key = dk; }
  const bpmRaw = parseInt($('inp-bpm').value, 10);
  const song = {
    ...(prev || {}),
    id: prev ? prev.id : uid(),
    title, artist: $('inp-artist').value.trim(), key, lyrics,
    tags: [...selectedTags], updatedAt: Date.now(),
    bpm: bpmRaw >= 30 && bpmRaw <= 300 ? bpmRaw : 0
  };
  const warnings = [];
  const newBlocks = parseSong(lyrics, 0);
  let layout = null;
  if (prev && prev.chordsOnlyLayout) {
    // FIX (баг «чужой блок»): раскладка переносится по стабильному ключу блока
    layout = CE.remapLayout(prev.chordsOnlyLayout, parseSong(prev.lyrics, 0), newBlocks);
  }
  const coRaw = $('inp-chords-only').value.trim();
  if (coRaw && coRaw !== _initialChordsOnlyText.trim()) {
    const parsed = CE.parseChordsOnlyText(coRaw);
    const r = CE.buildLayoutFromText(parsed, newBlocks, 0, null);
    // Текст в форме — полная картина ручных блоков: блоки, которых в тексте нет, возвращаются к авто
    layout = r.layout;
    if (r.unmatched.length) warnings.push('Не найден блок: ' + r.unmatched.join(', '));
    if (r.invalid.length) warnings.push('Не аккорды (пропущены): ' + [...new Set(r.invalid)].slice(0, 5).join(', '));
  } else if (!coRaw && _initialChordsOnlyText) {
    layout = null; // FIX: очистка поля возвращает автоматический режим (раньше было невозможно)
  }
  const compact = layout ? CE.compactLayout(layout) : null;
  if (compact) song.chordsOnlyLayout = compact; else delete song.chordsOnlyLayout;
  // Порядок песни: ссылки на исчезнувшие после правки части отбрасываются
  const arrangement = prev && prev.arrangement ? CE.remapArrangement(prev.arrangement, newBlocks) : null;
  if (arrangement) song.arrangement = arrangement; else delete song.arrangement;
  delete song._aiChordsBackup;
  return { song, warnings };
}

$('save-song-btn').addEventListener('click', async () => {
  if (!$('inp-title').value.trim()) { showToast('Введите название песни'); return; }
  const id = $('edit-song-id').value;
  const prev = id ? songsCache.find(s => s.id === id) : null;
  const { song, warnings } = buildSongFromForm(prev);
  replaceSongInCache(song);
  closeOverlay('overlay-add-song');
  if (warnings.length) showToast(warnings.join(' · '));
  else showToast(prev ? 'Песня обновлена' : 'Песня добавлена');
  if (prev) {
    currentSongId = song.id;
    transposeOffset = transposeMap[song.id] || 0; // FIX: раньше сбрасывалось в 0, расходясь с сохранённым
    if (currentPage === 'song-view') renderSongView(song);
  } else if (currentPage === 'songs') renderSongs($('search-input').value);
  await saveSingleSong(song);
});

let _lastDelSong = null;
$('delete-song-btn').addEventListener('click', () => {
  const id = $('edit-song-id').value;
  const song = songsCache.find(s => s.id === id);
  if (!song) return;
  showConfirm({
    title: 'Удалить песню?', msg: `«${song.title}» будет удалена. Действие можно отменить.`,
    onOk: async () => {
      _lastDelSong = song;
      songsCache = songsCache.filter(s => s.id !== id);
      invalidateSongCache(id);
      closeOverlay('overlay-add-song');
      showPage('songs');
      showToastUndo('Песня удалена', async () => {
        if (!_lastDelSong) return;
        songsCache = [_lastDelSong, ...songsCache];
        renderSongs($('search-input').value);
        await saveSingleSong(_lastDelSong); _lastDelSong = null;
      });
      await saveSongs();
    }
  });
});

$('tag-chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip'); if (!chip) return;
  const t = chip.dataset.tag;
  if (selectedTags.includes(t)) selectedTags = selectedTags.filter(x => x !== t); else selectedTags.push(t);
  chip.classList.toggle('selected', selectedTags.includes(t));
});
$('inp-key').addEventListener('change', () => { _userPickedKey = true; });
$('inp-lyrics').addEventListener('input', debounce(() => {
  if (_userPickedKey) return;
  const dk = detectKeyFromLyrics($('inp-lyrics').value);
  if (dk && $('inp-key').querySelector(`option[value="${dk}"]`)) $('inp-key').value = dk;
}, 400));

let _bpmTaps = [];
$('bpm-tap-btn').addEventListener('click', () => {
  const now = Date.now();
  if (_bpmTaps.length && now - _bpmTaps[_bpmTaps.length - 1] > 2500) _bpmTaps = [];
  _bpmTaps.push(now);
  if (_bpmTaps.length > 8) _bpmTaps.shift();
  if (_bpmTaps.length < 2) { $('bpm-tap-btn').textContent = 'Tap…'; return; }
  const avg = (_bpmTaps[_bpmTaps.length - 1] - _bpmTaps[0]) / (_bpmTaps.length - 1);
  const bpm = Math.round(60000 / avg);
  $('inp-bpm').value = bpm;
  $('bpm-tap-btn').textContent = bpm + ' BPM';
});

// ═══════════════════════════════════════════
//  SET LISTS
// ═══════════════════════════════════════════
function getSlById(id) { return setlistsCache.find(s => s.id === id); }
function renderSetlists() {
  const c = $('setlists-container');
  if (!setlistsCache.length) { c.innerHTML = '<div class="empty" style="padding-top:48px"><div class="empty-icon">📋</div><p>Создайте первый сет-лист!</p></div>'; return; }
  const sorted = setlistsCache.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.createdAt || 0) - (a.createdAt || 0));
  c.innerHTML = sorted.map(sl => `
    <div class="setlist-card" data-id="${escapeHtml(sl.id)}" style="display:flex;align-items:center;gap:10px">
      <div style="flex:1;min-width:0" class="sl-card-body"><div class="setlist-title">${escapeHtml(sl.name)}</div>
      <div class="setlist-meta">${sl.date ? escapeHtml(sl.date) + ' · ' : ''}${(sl.songs || []).length} ${plural((sl.songs || []).length, 'песня', 'песни', 'песен')}</div></div>
      <button class="icon-btn sl-menu-btn" aria-label="Меню сет-листа"><svg class="ico"><use href="#i-more"/></svg></button></div>`).join('');
  c.querySelectorAll('.setlist-card').forEach(card => {
    card.querySelector('.sl-card-body').addEventListener('click', () => openSetlist(card.dataset.id));
    card.querySelector('.sl-menu-btn').addEventListener('click', e => { e.stopPropagation(); showSetlistMenu(card.dataset.id, e.currentTarget); });
  });
}
function openSetlist(id) {
  const sl = getSlById(id); if (!sl) return;
  currentSetlistId = id;
  renderSetlistView(sl);
  showPage('setlist-view');
}
function renderSetlistView(sl) {
  const live = getSlById(sl.id); if (!live) return;
  const slSongs = (live.songs || []).map(sid => songsCache.find(s => s.id === sid)).filter(Boolean);
  $('header-title').textContent = live.name;
  $('header-actions').innerHTML = `<button class="icon-btn" id="edit-setlist-btn" aria-label="Изменить сет-лист"><svg class="ico"><use href="#i-edit"/></svg></button>`;
  $('setlist-view-content').innerHTML = `
    <div class="sl-toolbar">
      <button class="ctrl-btn primary" id="add-songs-btn"><svg class="ico"><use href="#i-plus"/></svg>Добавить</button>
      <button class="ctrl-btn" id="sl-view-mode-btn">${GLOBAL_VIEW_LABELS[globalViewMode]}</button>
      <button class="icon-btn perf-mode-btn ${performanceMode ? 'active' : ''}" id="perf-mode-toggle" aria-label="Режим выступления" title="Режим выступления"><svg class="ico"><use href="#i-mic"/></svg></button>
      <button class="icon-btn" id="sync-keys-btn" aria-label="Синхронизировать тональности" title="Синхронизировать тональности"><svg class="ico"><use href="#i-sync"/></svg></button>
    </div>
    <div style="padding:5px 0 12px" id="setlist-songs-list">
      ${!slSongs.length ? '<div class="empty" style="padding:32px 0"><div class="empty-icon">🎵</div><p>Нажмите «＋ Добавить»</p></div>'
      : slSongs.map((s, i) => {
        const off = transposeMap[s.id] || 0;
        return `<div class="setlist-song-item" data-song-id="${escapeHtml(s.id)}" data-sl-idx="${i}">
          <span class="drag-handle" aria-label="Перетащить"><svg class="ico"><use href="#i-grip"/></svg></span><span class="setlist-song-num">${i + 1}</span>
          <div class="setlist-song-info"><div class="setlist-song-title">${escapeHtml(s.title)}</div>
          <div class="setlist-song-key"><b>${escapeHtml(displayKey(s))}</b>${off ? ` (${off > 0 ? '+' : ''}${off})` : ''}${s.artist ? ', ' + escapeHtml(s.artist) : ''}${s.bpm ? ', ' + s.bpm + ' BPM' : ''}</div></div>
          <button class="reorder-btn remove-from-setlist" aria-label="Убрать из сет-листа"><svg class="ico"><use href="#i-x"/></svg></button></div>`;
      }).join('')}
    </div>`;
  $('add-songs-btn').addEventListener('click', () => openSongPicker(live.id));
  $('sl-view-mode-btn').addEventListener('click', e => { cycleGlobalViewMode(); e.currentTarget.textContent = GLOBAL_VIEW_LABELS[globalViewMode]; });
  $('perf-mode-toggle').addEventListener('click', () => { performanceMode = !performanceMode; showToast(performanceMode ? 'Режим выступления включён' : 'Режим выступления выключен'); renderSetlistView(live); });
  $('edit-setlist-btn').addEventListener('click', () => openEditSetlistOverlay(live));
  $('sync-keys-btn').addEventListener('click', () => openSyncDrawer(live.id));
  document.querySelectorAll('#setlist-songs-list .setlist-song-item').forEach(item => {
    item.querySelector('.remove-from-setlist').addEventListener('click', async e => {
      e.stopPropagation();
      const cur = getSlById(live.id); if (!cur) return;
      const removedId = item.dataset.songId, pos = (cur.songs || []).indexOf(removedId);
      cur.songs = (cur.songs || []).filter(id => id !== removedId);
      renderSetlistView(cur);
      showToastUndo('Песня убрана', async () => { const c2 = getSlById(live.id); if (!c2) return; c2.songs.splice(Math.max(0, pos), 0, removedId); renderSetlistView(c2); await saveSetlists(); });
      await saveSetlists();
    });
    item.addEventListener('click', e => {
      if (e.target.closest('.remove-from-setlist, .drag-handle')) return;
      const cur = getSlById(live.id);
      const ids = (cur.songs || []).filter(sid => songsCache.some(s => s.id === sid));
      openSong(item.dataset.songId, { songs: ids, index: ids.indexOf(item.dataset.songId), slId: live.id });
    });
  });
  initDragReorder(live.id);
}
function initDragReorder(slId) {
  const list = $('setlist-songs-list'); if (!list) return;
  if (list._dragController) list._dragController.abort();
  const ac = new AbortController(); list._dragController = ac;
  const { signal } = ac;
  let dragEl = null, startY = 0, startIndex = 0, dropIndex = 0, itemH = 0;
  const items = () => [...list.querySelectorAll('.setlist-song-item')];
  function shifts() {
    items().forEach((it, i) => {
      if (it === dragEl) return;
      it.style.transition = 'transform 0.2s';
      let t = 0;
      if (startIndex < dropIndex && i > startIndex && i <= dropIndex) t = -itemH;
      if (startIndex > dropIndex && i >= dropIndex && i < startIndex) t = itemH;
      it.style.transform = `translateY(${t}px)`;
    });
  }
  list.addEventListener('pointerdown', e => {
    const h = e.target.closest('.drag-handle'); if (!h) return;
    dragEl = h.closest('.setlist-song-item');
    startIndex = dropIndex = items().indexOf(dragEl);
    itemH = dragEl.offsetHeight + 6; startY = e.clientY;
    dragEl.classList.add('lifted'); dragEl.style.zIndex = '10';
    try { h.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  }, { signal });
  list.addEventListener('pointermove', e => {
    if (!dragEl) return;
    const dy = e.clientY - startY;
    dragEl.style.transform = `translateY(${dy}px) scale(1.03)`;
    const ni = Math.max(0, Math.min(items().length - 1, startIndex + Math.round(dy / itemH)));
    if (ni !== dropIndex) { dropIndex = ni; shifts(); }
  }, { signal });
  const end = async () => {
    if (!dragEl) return;
    const el = dragEl; dragEl = null;
    items().forEach(it => { it.style.transition = ''; it.style.transform = ''; });
    el.classList.remove('lifted'); el.style.zIndex = '';
    if (dropIndex !== startIndex) {
      const its = items(); const ref = its[dropIndex];
      list.insertBefore(el, dropIndex > startIndex ? ref.nextSibling : ref);
      await saveReorder(slId, list);
    }
  };
  list.addEventListener('pointerup', end, { signal });
  list.addEventListener('pointercancel', end, { signal });
}
async function saveReorder(slId, list) {
  const sl = getSlById(slId); if (!sl) return;
  const visible = [...list.querySelectorAll('.setlist-song-item')].map(el => el.dataset.songId);
  // песни, которых нет в библиотеке (не отрисованы), сохраняем в конце, а не теряем
  const hidden = (sl.songs || []).filter(id => !visible.includes(id));
  sl.songs = visible.concat(hidden);
  list.querySelectorAll('.setlist-song-item').forEach((el, i) => { el.dataset.slIdx = i; el.querySelector('.setlist-song-num').textContent = String(i + 1); });
  await saveSetlists();
  showToast('Порядок сохранён');
}
$('save-setlist-btn').addEventListener('click', async () => {
  const name = $('inp-setlist-name').value.trim();
  if (!name) { showToast('Введите название'); return; }
  setlistsCache.unshift({ id: uid(), name, date: $('inp-setlist-date').value, songs: [], createdAt: Date.now() });
  closeOverlay('overlay-add-setlist'); showToast('Сет-лист создан'); renderSetlists();
  await saveSetlists();
});
function openPickSetlist(songId) {
  const list = $('pick-setlist-list');
  if (!setlistsCache.length) list.innerHTML = '<p style="color:var(--muted);font-size:14px;text-align:center;padding:20px">Сначала создайте сет-лист</p>';
  else {
    list.innerHTML = setlistsCache.map(sl => {
      const already = (sl.songs || []).includes(songId);
      return `<div class="setlist-card" data-id="${escapeHtml(sl.id)}" style="${already ? 'opacity:.5;pointer-events:none' : ''}">
        <div class="setlist-title">${escapeHtml(sl.name)} ${already ? '✓' : ''}</div>
        <div class="setlist-meta">${escapeHtml(sl.date || '')} · ${(sl.songs || []).length} песен</div></div>`;
    }).join('');
    list.querySelectorAll('.setlist-card').forEach(card => card.addEventListener('click', async () => {
      const sl = getSlById(card.dataset.id); if (!sl) return;
      sl.songs = sl.songs || [];
      if (!sl.songs.includes(songId)) sl.songs.push(songId);
      closeOverlay('overlay-pick-setlist'); showToast('Добавлено в сет-лист!');
      await saveSetlists();
    }));
  }
  openOverlay('overlay-pick-setlist');
}
function showSetlistMenu(slId, btn) {
  openMenu(btn, [
    { label: 'Открыть', onClick: () => openSetlist(slId) },
    { label: 'Переименовать', onClick: () => openEditSetlistOverlay(getSlById(slId)) },
    { label: 'Удалить', danger: true, onClick: () => showConfirm({ title: 'Удалить сет-лист?', msg: (getSlById(slId) || {}).name || '', onOk: () => deleteSetlist(slId) }) },
  ]);
}
let _lastDelSl = null;
async function deleteSetlist(slId) {
  _lastDelSl = getSlById(slId) || null;
  setlistsCache = setlistsCache.filter(s => s.id !== slId);
  renderSetlists();
  showToastUndo('Сет-лист удалён', async () => { if (_lastDelSl) { setlistsCache = [_lastDelSl, ...setlistsCache]; renderSetlists(); _lastDelSl = null; await saveSetlists(); } });
  await saveSetlists();
}
function openEditSetlistOverlay(sl) {
  if (!sl) return;
  $('edit-sl-name').value = sl.name || ''; $('edit-sl-date').value = sl.date || ''; $('edit-sl-id').value = sl.id;
  openOverlay('overlay-edit-setlist');
}
$('save-sl-btn').addEventListener('click', async () => {
  const id = $('edit-sl-id').value, name = $('edit-sl-name').value.trim();
  if (!name) { showToast('Введите название'); return; }
  const date = $('edit-sl-date').value;
  setlistsCache = setlistsCache.map(s => s.id === id ? { ...s, name, date } : s);
  closeOverlay('overlay-edit-setlist'); showToast('Сохранено');
  if (currentPage === 'setlists') renderSetlists();
  if (currentPage === 'setlist-view' && currentSetlistId === id) renderSetlistView(getSlById(id));
  await saveSetlists();
});
$('delete-sl-btn').addEventListener('click', () => {
  const id = $('edit-sl-id').value;
  showConfirm({ title: 'Удалить сет-лист?', msg: (getSlById(id) || {}).name || '', onOk: async () => {
    closeOverlay('overlay-edit-setlist');
    if (currentPage === 'setlist-view') goBack();
    await deleteSetlist(id);
  } });
});

// ═══════════════════════════════════════════
//  OVERLAYS (делегирование — работает и для оверлеев ниже по разметке)
// ═══════════════════════════════════════════
function openOverlay(id) { $(id).classList.add('open'); document.body.style.overflow = 'hidden'; closeMenu(); }
function closeOverlay(id) {
  const el = $(id); if (!el) return;
  el.classList.remove('open');
  if (id === 'overlay-add-song') isEditingDrawerOpen = false;
  if (id === 'overlay-tuner') stopTuner();
  if (!document.querySelector('.overlay.open')) document.body.style.overflow = '';
}
document.addEventListener('click', e => {
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) { closeOverlay(closeBtn.dataset.close); return; }
  if (e.target.classList && e.target.classList.contains('overlay')) closeOverlay(e.target.id);
});

// ═══════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════
let toastTimer;
function showToast(msg, ms) {
  const t = $('toast');
  t.textContent = msg; t.style.pointerEvents = ''; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms || Math.min(5000, 1800 + String(msg).length * 30));
}
function showToastUndo(msg, cb) {
  const t = $('toast');
  t.innerHTML = escapeHtml(msg) + '<button class="toast-undo-btn">Отменить</button>';
  t.style.pointerEvents = 'auto'; t.classList.add('show');
  clearTimeout(toastTimer);
  t.querySelector('.toast-undo-btn').onclick = () => { t.classList.remove('show'); t.style.pointerEvents = ''; clearTimeout(toastTimer); cb(); };
  toastTimer = setTimeout(() => { t.classList.remove('show'); t.style.pointerEvents = ''; }, 4500);
}

// ═══════════════════════════════════════════
//  SYNC TRANSPOSITIONS
// ═══════════════════════════════════════════
// Тональности сет-листа: документ на сервере (через Worker)
async function keysGet(id) {
  const r = await api('GET', '/api/keys/' + encodeURIComponent(id));
  if (r.status === 404) return { notFound: true };
  if (!r.ok) return { error: r.status === 401 ? 'откройте через Telegram' : r.error };
  return { data: r.data };
}
async function keysPut(id, keys) {
  const r = await api('PUT', '/api/keys/' + encodeURIComponent(id), { keys });
  return r.ok ? { ok: true } : { error: r.error };
}
async function openSyncDrawer(slId, preloaded) {
  const sl = getSlById(slId); if (!sl) return;
  const songs = (sl.songs || []).map(id => songsCache.find(s => s.id === id)).filter(Boolean);
  $('sync-drawer-title').textContent = 'Тональности: ' + sl.name;
  $('sync-drawer-body').innerHTML = '<div style="text-align:center;padding:24px 0;color:var(--muted);font-size:13px">Подключаемся…</div>';
  $('sync-drawer-btns').innerHTML = '';
  openOverlay('overlay-sync-keys');
  const result = preloaded || await keysGet(slId);
  if (result.error) {
    const off = !navigator.onLine;
    $('sync-drawer-body').innerHTML = `<div style="text-align:center;padding:20px 0"><div style="font-size:32px;margin-bottom:10px">${off ? '📴' : '⚠️'}</div>
      <div style="font-size:14px;font-weight:700">${off ? 'Нет подключения' : 'Не удалось подключиться'}</div>
      <div style="font-size:12px;color:var(--muted)">${off ? 'Проверьте интернет' : 'Ошибка: ' + escapeHtml(result.error)}</div></div>`;
    $('sync-drawer-btns').innerHTML = '<button class="sync-btn-primary" id="sync-retry-btn">🔄 Повторить</button>';
    $('sync-retry-btn').addEventListener('click', () => openSyncDrawer(slId));
    return;
  }
  renderSyncBody(result.notFound ? null : result.data, slId, songs);
}
function fmtShift(n) { return n ? ' (' + (n > 0 ? '+' : '') + n + ')' : ''; }
function renderSyncBody(remote, slId, songs) {
  const remoteKeys = remote ? (remote.keys || {}) : null;
  const ts = remote ? Number(remote.ts) : 0;
  let html = '';
  if (ts) {
    const diff = Math.max(0, Math.round((Date.now() - ts) / 60000));
    const t = diff < 1 ? 'только что' : diff < 60 ? diff + ' мин. назад' : diff < 1440 ? Math.round(diff / 60) + ' ч. назад' : Math.round(diff / 1440) + ' дн. назад';
    html += `<div style="text-align:center;font-size:11px;color:var(--muted);margin-bottom:12px">Последняя синхронизация: <strong style="color:var(--text)">${t}</strong></div>`;
  } else html += '<div style="text-align:center;font-size:11px;color:var(--muted);margin-bottom:12px">На сервере ещё нет данных для этого сет-листа</div>';
  let nDiff = 0, nOk = 0;
  html += '<div class="sync-section-label">Тональности</div>';
  for (const s of songs) {
    const local = transposeMap[s.id] || 0;
    const rv = remoteKeys && remoteKeys[s.id] !== undefined && remoteKeys[s.id] !== null ? Number(remoteKeys[s.id]) : null;
    const base = getSongKey(s), nt = getSongNotation(s.id);
    const lk = transposeKey(base, local, nt);
    const rk = rv !== null ? transposeKey(base, rv, nt) : null;
    let dot = 'only-local', st = 'только локально';
    if (rv !== null && rv === local) { dot = 'ok'; st = 'совпадает'; nOk++; } else if (rv !== null) { dot = 'diff'; st = 'различается'; nDiff++; }
    html += `<div class="sync-song-row"><div class="sync-status-dot ${dot}" title="${st}"></div>
      <div class="sync-song-info"><div class="sync-song-title">${escapeHtml(s.title)}</div>
      <div class="sync-song-keys">Здесь: <strong style="color:var(--primary)">${escapeHtml(lk)}${fmtShift(local)}</strong>${rk !== null && rv !== local ? ' → Сервер: <strong>' + escapeHtml(rk) + fmtShift(rv) + '</strong>' : ''}</div></div>
      <span class="sync-key-badge">${escapeHtml(lk)}</span></div>`;
  }
  if (nDiff) html += `<div style="margin-top:8px;padding:8px 12px;background:rgba(255,183,77,0.1);border:1px solid rgba(255,183,77,0.25);border-radius:10px;font-size:12px;color:var(--yellow)">⚠️ Отличается от сервера: ${nDiff}</div>`;
  else if (remoteKeys && songs.length && nOk === songs.length) html += '<div style="margin-top:8px;padding:8px 12px;background:rgba(76,175,125,0.1);border:1px solid rgba(76,175,125,0.25);border-radius:10px;font-size:12px;color:var(--green)">✅ Всё совпадает</div>';
  $('sync-drawer-body').innerHTML = html;

  const btns = $('sync-drawer-btns'); btns.innerHTML = '';
  const receive = document.createElement('button'); receive.className = 'sync-btn-secondary'; receive.textContent = '📥 Получить';
  const send = document.createElement('button'); send.className = 'sync-btn-primary'; send.textContent = '📤 Отправить';
  receive.disabled = !remoteKeys;
  receive.onclick = () => {
    if (_inlineEditActive) { showToast('Сначала сохраните редактирование'); return; }
    // Применяем только к песням ЭТОГО сет-листа, а не ко всему, что лежит в документе
    songs.forEach(s => { if (remoteKeys[s.id] !== undefined && remoteKeys[s.id] !== null) saveTranspose(s.id, Number(remoteKeys[s.id]) || 0); });
    if (currentSongId && currentPage === 'song-view') { transposeOffset = transposeMap[currentSongId] || 0; const so = songsCache.find(s => s.id === currentSongId); if (so) renderSongView(so); }
    closeOverlay('overlay-sync-keys');
    const sl = getSlById(slId); if (sl && currentPage === 'setlist-view') renderSetlistView(sl);
    showToast('✅ Тональности получены!');
  };
  send.onclick = async () => {
    send.disabled = receive.disabled = true; send.textContent = 'Отправка…';
    const keys = {}; songs.forEach(s => { keys[s.id] = transposeMap[s.id] || 0; });
    const res = await keysPut(slId, keys);
    if (res.ok) { closeOverlay('overlay-sync-keys'); showToast('📤 Тональности отправлены!'); }
    else { send.textContent = '📤 Отправить'; send.disabled = false; receive.disabled = !remoteKeys; showToast('⚠️ Ошибка: ' + res.error); }
  };
  btns.append(receive, send);
}
async function syncSingleSong(song, slId) {
  if (slId) { const res = await keysGet(slId); if (res.error) { showToast(navigator.onLine ? '⚠️ Ошибка связи' : '📴 Нет подключения'); return; } openSyncDrawer(slId, res); return; }
  const docId = 'song_' + song.id;
  const res = await keysGet(docId);
  if (res.error) { showToast(navigator.onLine ? '⚠️ Ошибка связи' : '📴 Нет подключения'); return; }
  if (res.notFound) { const r = await keysPut(docId, { [song.id]: transposeOffset }); showToast(r.ok ? '📤 Тональность отправлена' : '⚠️ ' + r.error); return; }
  const remoteVal = Number((res.data.keys || {})[song.id] ?? 0);
  const nt = getSongNotation(song.id), base = getSongKey(song);
  showSyncDialog(song.title, remoteVal === transposeOffset ? 'Совпадает с сервером' : `Здесь: ${transposeKey(base, transposeOffset, nt)} · Сервер: ${transposeKey(base, remoteVal, nt)}`,
    remoteVal === transposeOffset ? null : () => { if (_inlineEditActive) return; saveTranspose(song.id, remoteVal); transposeOffset = remoteVal; renderSongView(song); showToast('✅ Получено'); },
    async () => { const r = await keysPut(docId, { [song.id]: transposeOffset }); showToast(r.ok ? '📤 Отправлено' : '⚠️ ' + r.error); });
}
function showSyncDialog(title, subtitle, onGet, onSend) {
  const old = $('sd-old'); if (old) old.remove();
  const d = document.createElement('div'); d.id = 'sd-old'; d.className = 'sync-dialog';
  d.innerHTML = `<div style="font-size:13px;font-weight:700;margin-bottom:4px;text-align:center">${escapeHtml(title)}</div>
    <div style="font-size:11px;color:var(--muted);text-align:center;margin-bottom:10px">${escapeHtml(subtitle || '')}</div>
    <div style="display:flex;gap:8px">${onGet ? '<button class="sync-btn-secondary sd-get">📥 Получить</button>' : ''}
    <button class="sync-btn-primary sd-snd">📤 Отправить</button><button class="sync-btn-secondary sd-cls" style="flex:0 0 40px">✕</button></div>`;
  document.body.appendChild(d);
  const timer = setTimeout(() => d.remove(), 12000);
  const close = () => { clearTimeout(timer); d.remove(); };
  if (onGet) d.querySelector('.sd-get').onclick = () => { close(); onGet(); };
  d.querySelector('.sd-snd').onclick = () => { close(); onSend(); };
  d.querySelector('.sd-cls').onclick = close;
}

// ═══════════════════════════════════════════
//  SONG MENU
// ═══════════════════════════════════════════
function showSongOverflowMenu(song, btn) {
  const nt = getSongNotation(song.id);
  const hasBackup = Object.prototype.hasOwnProperty.call(song, '_aiChordsBackup');
  const hasManual = !!(song.chordsOnlyLayout && Object.keys(song.chordsOnlyLayout).length);
  openMenu(btn, [
    { label: 'Порядок песни', onClick: () => openArrangementEditor(song) },
    { label: 'Шрифт крупнее (' + FONT_PCTS[fontSizeIdx] + '%)', keepOpen: true, onClick: item => { changeFontSize(1); item.textContent = 'Шрифт крупнее (' + FONT_PCTS[fontSizeIdx] + '%)'; } },
    { label: 'Шрифт мельче', keepOpen: true, onClick: () => { changeFontSize(-1); const it = _activeMenu && _activeMenu.el.firstChild && _activeMenu.el.children[1]; if (it) it.textContent = 'Шрифт крупнее (' + FONT_PCTS[fontSizeIdx] + '%)'; } },
    { label: 'Добавить в сет-лист', onClick: () => openPickSetlist(song.id) },
    { label: 'Подобрать под солиста', onClick: () => openSingerPicker(song) },
    { label: nt === 'flat' ? 'Показывать диезы ♯' : 'Показывать бемоли ♭', onClick: () => {
      if (_inlineEditActive) { showToast('Сначала сохраните редактирование'); return; }
      notationMap[song.id] = nt === 'flat' ? 'sharp' : 'flat'; saveNotationMap();
      invalidateSongCache(song.id); renderSongView(song);
      showToast(notationMap[song.id] === 'flat' ? 'Бемоли для этой песни' : 'Диезы для этой песни');
    } },
    { label: 'Улучшить квадраты с AI', keepOpen: true, onClick: async item => {
      if (_inlineEditActive) { closeMenu(); showToast('Сначала сохраните редактирование'); return; }
      item.textContent = 'Анализируем…'; item.classList.add('disabled');
      try { const fresh = await improveChordsWithAI(song); closeMenu(); renderSongView(fresh); showToast('✨ Квадраты улучшены — откатить можно в меню'); }
      catch (err) { closeMenu(); console.error(err); showToast('Не удалось: ' + (err && err.message || 'ошибка')); }
    } },
    hasBackup && { label: 'Откатить улучшение AI', onClick: async () => { try { const fresh = await revertAiChords(song); renderSongView(fresh); showToast('↩️ Откачено'); } catch (e) { showToast(e.message); } } },
    hasManual && { label: 'Сбросить свои квадраты', onClick: () => showConfirm({ title: 'Сбросить ручные квадраты?', msg: 'Все блоки вернутся к автоматическому анализу.', okLabel: 'Сбросить', onOk: async () => {
      const fresh = { ...song, updatedAt: Date.now() }; delete fresh.chordsOnlyLayout; delete fresh._aiChordsBackup;
      replaceSongInCache(fresh); renderSongView(fresh); await saveSingleSong(fresh);
    } }) },
    { label: 'Изменить текст и данные', onClick: () => openEditSong(song.id) },
    { label: 'Распечатать или PDF', onClick: () => printSong(song) },
    { label: 'Синхронизировать тональность', keepOpen: true, onClick: item => {
      item.textContent = 'Синхронизация…'; item.classList.add('disabled');
      syncSingleSong(song, setlistContext ? setlistContext.slId : null).finally(closeMenu);
    } },
  ]);
}

// ═══════════════════════════════════════════
//  AI-УЛУЧШЕНИЕ КВАДРАТОВ (Cloudflare Worker → Gemini)
// ═══════════════════════════════════════════
const IMPROVE_CHORDS_URL = 'https://chordbook-improve.elapsov57.workers.dev';
function buildAIChordsPayload(song) {
  return parseSong(song.lyrics, 0).map((b, index) => ({ index, label: b.label || '', lines: b.lines.map(lineChords).filter(l => l.length) })).filter(b => b.lines.length);
}
// Ответ воркера → раскладка. Принимает {rows,mult} (старый формат) и {squares} (новый).
function aiResultToLayout(blocksResult, song) {
  const blocks = parseSong(song.lyrics, 0);
  const keys = CE.blockKeys(blocks);
  const layout = {};
  let changed = 0;
  (blocksResult || []).forEach(b => {
    if (!b || typeof b.index !== 'number' || b.index < 0 || b.index >= blocks.length) return;
    let squares;
    if (Array.isArray(b.squares)) squares = CE.normalizeSquares(b.squares);
    else if (Array.isArray(b.rows)) {
      // {rows, mult} → развёрнутые строки → поиск повторов групп строк
      const e = CE.normalizeEntry({ rows: b.rows, mult: b.mult });
      const rows = [];
      if (e) e.squares.forEach(sq => { for (let k = 0; k < sq.repeat; k++) sq.rows.forEach(r => { for (let j = 0; j < r.repeat; j++) rows.push(r.chords); }); });
      squares = CE.squaresFromRows(rows);
    }
    if (!squares || !squares.length) return;
    // Защита от «галлюцинаций»: в ответе должны быть только настоящие аккорды
    if (CE.expandSquares(squares).some(c => !CE.isChord(c))) return;
    layout[b.index] = CE.makeEntry(squares, keys[b.index], 0, null); // аккорды в оригинальной тональности
    changed++;
  });
  return { layout, changed };
}
async function improveChordsWithAI(song) {
  const payload = buildAIChordsPayload(song);
  if (!payload.length) throw new Error('В песне нет аккордов');
  if (!navigator.onLine) throw new Error('нет интернета');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let res;
  try { res = await fetch(IMPROVE_CHORDS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blocks: payload }), signal: ctrl.signal }); }
  catch (e) { throw new Error(e.name === 'AbortError' ? 'сервер не ответил за 25 с' : 'сеть недоступна'); }
  finally { clearTimeout(timer); }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.blocks)) throw new Error('неожиданный ответ сервера');
  const { layout, changed } = aiResultToLayout(data.blocks, song);
  if (!changed) throw new Error('AI не вернул ни одной группировки');
  const fresh = { ...song, chordsOnlyLayout: { ...(song.chordsOnlyLayout ? CE.resolveLayout(song.chordsOnlyLayout, parseSong(song.lyrics, 0)) : {}), ...layout },
    _aiChordsBackup: song.chordsOnlyLayout ? JSON.parse(JSON.stringify(song.chordsOnlyLayout)) : null, updatedAt: Date.now() };
  replaceSongInCache(fresh);
  await saveSingleSong(fresh);
  return fresh;
}
async function revertAiChords(song) {
  if (!Object.prototype.hasOwnProperty.call(song, '_aiChordsBackup')) throw new Error('Нечего откатывать');
  const fresh = { ...song, updatedAt: Date.now() };
  if (song._aiChordsBackup) fresh.chordsOnlyLayout = song._aiChordsBackup; else delete fresh.chordsOnlyLayout;
  delete fresh._aiChordsBackup;
  replaceSongInCache(fresh);
  await saveSingleSong(fresh);
  return fresh;
}

// ═══════════════════════════════════════════
//  IMPORT / EXPORT
// ═══════════════════════════════════════════
const AI_PROMPT = `Конвертируй эти аккорды в JSON для приложения ChordBook.
Верни ТОЛЬКО валидный JSON без пояснений и без обёртки \`\`\`.

Одна песня — объект:
- title (обязательно) — название
- artist — исполнитель
- key — тональность, например "Am"
- lyrics (обязательно) — текст с аккордами в квадратных скобках перед словом: [Am]Строка [G]текста
  Метки блоков — отдельной строкой в скобках: [Куплет 1], [Припев], [Бридж]. Блоки разделяй пустой строкой.
  Если строка играется несколько раз подряд — пиши её столько раз, сколько она звучит (или добавь в конце строки x4).
- chordsOnly (желательно) — компактные «квадраты» для режима «Только аккорды».
  Для КАЖДОГО блока с аккордами: строка [Метка] (символ в символ как в lyrics), затем квадраты:
    Am F C G ×4          — одна строка аккордов, сыграть 4 раза
    (Em C | G D) ×2      — квадрат из двух строк (разделитель |), сыграть 2 раза целиком
    (Am F ×2 | C G) ×2   — внутри квадрата строка тоже может повторяться
  Одинаковые метки ([Припев] дважды) сопоставляются по порядку — давай отдельную секцию на каждое появление.
  САМОПРОВЕРКА: разверни все ×N — последовательность аккордов должна совпасть с аккордами этого блока в lyrics.

Внутри JSON-строк перенос строки — это \\n (два символа), а не настоящий перевод строки.

Пример:
{"title":"Пример","artist":"Автор","key":"Am","lyrics":"[Куплет 1]\\n[Am]Строка [G]текста\\n[C]Ещё строка\\n\\n[Припев]\\n[Em]Раз [C]раз\\n[G]Два [D]два\\n[Em]Раз [C]раз\\n[G]Два [D]два","chordsOnly":"[Куплет 1]\\nAm G\\nC\\n\\n[Припев]\\n(Em C | G D) ×2"}

Несколько песен — массив: [{...},{...}]`;
$('ai-prompt-text').textContent = AI_PROMPT;

function buildChordsOnlyLayoutFromImport(s, lyrics) {
  if (!s || typeof s.chordsOnly !== 'string' || !s.chordsOnly.trim()) return { layout: undefined, unmatched: [] };
  const parsed = CE.parseChordsOnlyText(s.chordsOnly.replace(/\\n/g, '\n'));
  const r = CE.buildLayoutFromText(parsed, parseSong(lyrics, 0), 0, null);
  return { layout: CE.compactLayout(r.layout) || undefined, unmatched: r.unmatched };
}
// Приводит запись из JSON (бэкап ChordBook или ответ AI) к песне.
function songFromImport(s) {
  const lyrics = convertToLyrics(s);
  const isBackup = typeof s.id === 'string' && typeof s.lyrics === 'string';
  const rawKey = String(s.key || s.tonality || s.tone || '').replace(/[Тт]ональность:?/g, '').trim();
  const song = {
    id: isBackup && !songsCache.some(x => x.id === s.id) ? s.id : uid(),
    title: String(s.title || 'Без названия').trim(), artist: String(s.artist || '').trim(),
    key: CE.isChord(rawKey) ? rawKey : (detectKeyFromLyrics(lyrics) || 'C'),
    lyrics, tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
    bpm: Number(s.bpm) >= 30 && Number(s.bpm) <= 300 ? Math.round(Number(s.bpm)) : 0,
    updatedAt: Date.now()
  };
  let unmatched = [];
  if (Array.isArray(s.arrangement)) { const arr = CE.remapArrangement(s.arrangement, parseSong(lyrics, 0)); if (arr) song.arrangement = arr; }
  if (s.chordsOnlyLayout && typeof s.chordsOnlyLayout === 'object') {
    const c = CE.compactLayout(CE.resolveLayout(s.chordsOnlyLayout, parseSong(lyrics, 0)));
    if (c) song.chordsOnlyLayout = c;
  } else {
    const r = buildChordsOnlyLayoutFromImport(s, lyrics);
    if (r.layout) song.chordsOnlyLayout = r.layout;
    unmatched = r.unmatched;
  }
  return { song, unmatched, origId: s.id };
}

let pendingImport = { songs: [], setlists: [], idMap: {} };
function parseImportData(data) {
  let songsArr = data, setlists = [];
  if (data && !Array.isArray(data) && Array.isArray(data.songs)) { songsArr = data.songs; setlists = Array.isArray(data.setlists) ? data.setlists : []; }
  if (!Array.isArray(songsArr)) songsArr = [songsArr];
  const idMap = {}, unmatchedAll = [];
  const songs = songsArr.filter(s => s && s.title).map(s => {
    const r = songFromImport(s);
    if (r.origId) idMap[r.origId] = r.song.id;
    if (r.unmatched.length) unmatchedAll.push(r.song.title + ': ' + r.unmatched.join(', '));
    return r.song;
  });
  return { songs, setlists: setlists.filter(sl => sl && sl.id && sl.name), idMap, unmatchedAll };
}
// FIX: импорт бэкапа раньше терял сет-листы, BPM, ручные квадраты и id (ссылки сет-листов рвались)
async function applyImport(pi) {
  let added = 0, skipped = 0;
  const titleToId = {};
  const fresh = [];
  for (const s of pi.songs) {
    const exists = songsCache.find(x => (x.title || '').toLowerCase() === s.title.toLowerCase());
    if (exists) { skipped++; titleToId[s.id] = exists.id; continue; }
    fresh.push(s); added++;
  }
  songsCache = [...fresh, ...songsCache];
  let slAdded = 0;
  for (const sl of pi.setlists) {
    if (getSlById(sl.id)) continue;
    const songs = (sl.songs || []).map(id => { const mapped = pi.idMap[id] || id; return titleToId[mapped] || mapped; }).filter(id => songsCache.some(s => s.id === id));
    setlistsCache.push({ id: sl.id, name: String(sl.name), date: sl.date || '', songs, createdAt: sl.createdAt || Date.now() });
    slAdded++;
  }
  await saveSongs();
  if (slAdded) await saveSetlists();
  return { added, skipped, slAdded };
}
function processJsonFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      pendingImport = parseImportData(JSON.parse(e.target.result));
      if (!pendingImport.songs.length) { showToast('В файле нет песен'); return; }
      $('json-count').textContent = pendingImport.songs.length;
      $('json-sl-count').textContent = pendingImport.setlists.length ? ` · сет-листов: ${pendingImport.setlists.length}` : '';
      $('json-song-list').innerHTML = pendingImport.songs.map(s => `<div class="json-song-row"><span>🎵 ${escapeHtml(s.title)}</span>${s.artist ? `<span style="color:var(--muted);font-size:12px">${escapeHtml(s.artist)}</span>` : ''}<span class="jkey">${escapeHtml(s.key)}</span></div>`).join('');
      $('json-preview').style.display = '';
      if (pendingImport.unmatchedAll.length) showToast('Не найдены блоки «только аккорды»: ' + pendingImport.unmatchedAll.join(' / '));
    } catch { showToast('Ошибка: неверный JSON'); }
  };
  reader.onerror = () => showToast('Ошибка чтения файла');
  reader.readAsText(file);
}
$('confirm-json-import').addEventListener('click', async () => {
  if (!pendingImport.songs.length) return;
  const r = await applyImport(pendingImport);
  closeOverlay('overlay-import');
  renderSongs($('search-input').value);
  showToast(`Добавлено: ${r.added}${r.skipped ? ', пропущено дублей: ' + r.skipped : ''}${r.slAdded ? ', сет-листов: ' + r.slAdded : ''}`);
  pendingImport = { songs: [], setlists: [], idMap: {} };
  $('json-preview').style.display = 'none'; $('file-input').value = '';
});
function parseLooseJson(raw) {
  const clean = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const attempts = [
    () => JSON.parse(clean),
    () => JSON.parse(clean.replace(/[\u201C\u201D\u00AB\u00BB]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/"((?:[^"\\]|\\.)*)"/gs, m => m.replace(/\n/g, '\\n').replace(/\r/g, '')).replace(/,\s*([}\]])/g, '$1')),
    () => JSON.parse(clean.match(/\[[\s\S]*\]/)[0]),
    () => JSON.parse(clean.match(/\{[\s\S]*\}/)[0]),
  ];
  for (const a of attempts) { try { const d = a(); if (d) return d; } catch {} }
  return null;
}
$('parse-ai-btn').addEventListener('click', async () => {
  const raw = $('inp-ai-paste').value.trim();
  if (!raw) { showToast('Вставьте ответ AI'); return; }
  const data = parseLooseJson(raw);
  if (!data) { showToast('Не удалось разобрать JSON'); return; }
  const pi = parseImportData(data);
  if (!pi.songs.length) { showToast('Не найдено ни одной песни с title'); return; }
  const r = await applyImport(pi);
  closeOverlay('overlay-import');
  renderSongs($('search-input').value);
  showToast(`Добавлено: ${r.added}${r.skipped ? ', пропущено: ' + r.skipped : ''}` + (pi.unmatchedAll.length ? ' · не найдены блоки: ' + pi.unmatchedAll.join(' / ') : ''));
  $('inp-ai-paste').value = '';
});

// Парсер формата бота: аккорды строкой над текстом, без скобок
function parseBotFormat(raw) {
  const isChordLine = line => { const t = line.trim().split(/\s+/).filter(Boolean); return t.length > 0 && t.every(x => CE.isChord(x)); };
  const LABEL_RE = /^(?:\d+\s*)?(?:-?(?:й|ый|ой)\s*)?(куплет|припев|бридж|вступление|вступ|проигрыш|аутро|кода|концовка|соло|тег|пре-?припев|пост-?припев|мост|verse|chorus|bridge|intro|outro|pre-?chorus|post-?chorus|interlude|instrumental|solo|tag|coda|ending)(?:\s*\d+)?\s*:?\s*$/i;
  const isLabel = line => LABEL_RE.test(line.trim());
  const lines = String(raw).replace(/\r/g, '').split('\n');
  let title = '', artist = '', bpm = 0, headerDone = false;
  const body = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) { if (headerDone) body.push(l); continue; }
    if (/^🎵/.test(t)) { title = t.replace(/^🎵\s*/, '').trim(); headerDone = true; continue; }
    if (/^👤/.test(t)) { artist = t.replace(/^👤\s*/, '').trim(); continue; }
    if (/BPM[:\s]+(\d+)/i.test(t) && /^🥁|^BPM/i.test(t)) { bpm = +t.match(/BPM[:\s]+(\d+)/i)[1]; continue; }
    if (/^🔗|^Источник|^https?:/i.test(t) || /^[─—-]{3,}$/.test(t)) continue;
    if (headerDone && title && !body.some(x => x.trim())) {
      const n = t.replace(/\s+/g, ' ').toLowerCase(), tn = title.toLowerCase();
      if (n === tn || n.startsWith(tn)) continue;
    }
    if (!headerDone && !title && !isChordLine(t) && !isLabel(t)) { title = t; headerDone = true; continue; }
    headerDone = true; body.push(l);
  }
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const t = body[i].trim();
    if (!t) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    if (isLabel(t)) { if (out.length && out[out.length - 1] !== '') out.push(''); out.push('[' + t.replace(/:\s*$/, '').trim() + ']'); continue; }
    if (isChordLine(t)) {
      const chords = t.split(/\s+/);
      let j = i + 1; while (j < body.length && !body[j].trim()) j++;
      const next = j < body.length ? body[j].trim() : '';
      if (next && j === i + 1 && !isChordLine(next) && !isLabel(next)) {
        // распределяем аккорды по словам строки равномерно
        const words = next.split(/\s+/);
        const step = words.length / chords.length;
        const at = new Map(); chords.forEach((c, k) => { const w = Math.min(words.length - 1, Math.floor(k * step)); at.set(w, (at.get(w) || '') + `[${c}]`); });
        out.push(words.map((w, wi) => (at.get(wi) || '') + w).join(' '));
        i = j;
      } else out.push(chords.map(c => `[${c}]`).join(' '));
      continue;
    }
    out.push(t);
  }
  const lyrics = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: title || 'Без названия', artist, bpm, key: detectKeyFromLyrics(lyrics) || 'C', lyrics };
}
$('parse-bot-preview-btn').addEventListener('click', () => {
  const raw = $('inp-bot-paste').value.trim();
  if (!raw) { showToast('Вставьте текст из бота'); return; }
  const s = parseBotFormat(raw);
  $('bot-preview-content').textContent = `Название: ${s.title}\nИсполнитель: ${s.artist || '—'}\nТональность: ${s.key}${s.bpm ? '\nBPM: ' + s.bpm : ''}\n\n${s.lyrics}`;
  $('bot-preview').style.display = '';
});
$('parse-bot-btn').addEventListener('click', async () => {
  const raw = $('inp-bot-paste').value.trim();
  if (!raw) { showToast('Вставьте текст из бота'); return; }
  const s = parseBotFormat(raw);
  if (s.title === 'Без названия') { showToast('Не удалось распознать название'); return; }
  if (songsCache.some(x => (x.title || '').toLowerCase() === s.title.toLowerCase())) { showToast('«' + s.title + '» уже есть'); return; }
  const song = { id: uid(), ...s, tags: [], updatedAt: Date.now() };
  songsCache = [song, ...songsCache];
  closeOverlay('overlay-import'); renderSongs($('search-input').value);
  showToast('✅ «' + s.title + '» добавлена');
  $('inp-bot-paste').value = ''; $('bot-preview').style.display = 'none';
  await saveSingleSong(song);
});
document.querySelectorAll('.import-tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.import-tab').forEach(t => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.import-panel').forEach(p => p.classList.toggle('active', p.id === 'itab-' + tab.dataset.tab));
  if (tab.dataset.tab === 'export') updateStorageInfo();
}));
$('open-manual-add-btn').addEventListener('click', () => { closeOverlay('overlay-import'); openAddSong(); });
$('copy-prompt-btn').addEventListener('click', () => {
  const done = () => showToast('Промт скопирован!');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(AI_PROMPT).then(done).catch(fallbackCopy);
  else fallbackCopy();
  function fallbackCopy() {
    const ta = document.createElement('textarea'); ta.value = AI_PROMPT; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch { showToast('Скопируйте текст вручную'); }
    ta.remove();
  }
});
const dropZone = $('drop-zone'), fileInput = $('file-input');
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); if (e.dataTransfer.files[0]) processJsonFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) processJsonFile(fileInput.files[0]); });
$('export-json-btn').addEventListener('click', () => {
  const data = JSON.stringify({ app: 'ChordBook', version: 2, songs: songsCache.map(({ title_lower, ...s }) => s), setlists: setlistsCache, exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'chordbook-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Файл сохранён');
});
async function updateStorageInfo() {
  let bytes = JSON.stringify(songsCache).length * 2;
  try { if (navigator.storage && navigator.storage.estimate) bytes = (await navigator.storage.estimate()).usage || bytes; } catch {}
  const docKb = Math.round(JSON.stringify(songsCache).length / 1024);
  $('storage-info').innerHTML = `📦 <strong>${songsCache.length} песен</strong>, ${(bytes / 1024).toFixed(1)} КБ · ${setlistsCache.length} сет-листов<br>
    <span style="font-size:11px">Облачный документ: ${docKb} КБ из ~1000 КБ лимита Firestore${docKb > 800 ? ' — <b style="color:var(--yellow)">скоро лимит!</b>' : ''}</span>`;
}

// ═══════════════════════════════════════════
//  FONT / DENSITY / THEME
// ═══════════════════════════════════════════
const FONT_PCTS = [80, 90, 100, 120, 135, 150, 165, 180, 200];
const BASE_FONT = 13.5;
const FONT_KEY = 'cb_fontsize';
let fontSizeIdx = Math.max(0, Math.min(FONT_PCTS.length - 1, LS.get(FONT_KEY, 2) | 0));
function applyFontSize() {
  document.documentElement.style.setProperty('--song-font', +(BASE_FONT * FONT_PCTS[fontSizeIdx] / 100).toFixed(1) + 'px');
  const sl = $('settings-font-label'); if (sl) sl.textContent = FONT_PCTS[fontSizeIdx] + '%';
}
function changeFontSize(dir) { fontSizeIdx = Math.max(0, Math.min(FONT_PCTS.length - 1, fontSizeIdx + dir)); LS.set(FONT_KEY, fontSizeIdx); applyFontSize(); }
const DENSITY_KEY = 'cb_density';
let densityMode = LS.get(DENSITY_KEY, 'normal');
function applyDensityMode() { document.body.classList.toggle('density-compact', densityMode === 'compact'); }
const THEME_KEY = 'cb_theme';
// Три темы: «Сцена» (основная), «День», «Контраст». Старые значения переносятся.
const THEMES = ['stage', 'day', 'bw'];
const THEME_MIGRATE = { dark: 'stage', glass: 'stage', white: 'day', print: 'day' };
const THEME_BG = { stage: '#1B2130', day: '#F7F8FA', bw: '#000000' };
function currentTheme() { const t = LS.get(THEME_KEY); return THEMES.includes(t) ? t : (THEME_MIGRATE[t] || 'stage'); }
function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = THEME_MIGRATE[theme] || 'stage';
  ['theme-day', 'theme-bw'].forEach(c => { document.body.classList.remove(c); document.documentElement.classList.remove(c); });
  if (theme !== 'stage') { document.body.classList.add('theme-' + theme); document.documentElement.classList.add('theme-' + theme); }
  if (tg) { try { tg.setHeaderColor && tg.setHeaderColor(THEME_BG[theme]); tg.setBackgroundColor && tg.setBackgroundColor(THEME_BG[theme]); } catch {} }
}
function setTheme(theme) { LS.set(THEME_KEY, theme); applyTheme(theme); updateSettingsUI(); }

// ═══════════════════════════════════════════
//  SONG PICKER
// ═══════════════════════════════════════════
let pickerSelected = new Set(), pickerSlId = null;
function openSongPicker(slId) {
  pickerSlId = slId; pickerSelected = new Set();
  $('picker-search').value = '';
  $('picker-confirm').textContent = 'Добавить выбранные';
  renderPickerList('');
  openOverlay('overlay-song-picker');
}
$('picker-search').addEventListener('input', debounce(e => renderPickerList(e.target.value), 150));
$('picker-confirm').addEventListener('click', async () => {
  if (!pickerSelected.size) { showToast('Выберите хотя бы одну песню'); return; }
  const cur = getSlById(pickerSlId); if (!cur) return;
  cur.songs = cur.songs || [];
  let added = 0;
  pickerSelected.forEach(id => { if (!cur.songs.includes(id)) { cur.songs.push(id); added++; } });
  closeOverlay('overlay-song-picker'); renderSetlistView(cur);
  showToast(`Добавлено: ${added}`);
  await saveSetlists();
});
function renderPickerList(filter) {
  const cur = getSlById(pickerSlId);
  const existing = new Set(cur ? cur.songs || [] : []);
  const list = searchSongs(filter).slice(0, 300);
  const c = $('picker-song-list');
  if (!list.length) { c.innerHTML = '<div class="empty"><div class="empty-icon">🔍</div><p>Ничего не найдено</p></div>'; return; }
  // FIX: artist/key раньше вставлялись без экранирования (XSS через импорт)
  c.innerHTML = list.map(s => {
    const already = existing.has(s.id), sel = pickerSelected.has(s.id);
    return `<div class="picker-song-item ${sel ? 'selected' : ''}" data-id="${escapeHtml(s.id)}" ${already ? 'style="opacity:0.5;pointer-events:none"' : ''}>
      <div class="picker-check">${sel ? '✓' : ''}</div>
      <div style="flex:1;min-width:0"><div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.title)}</div>
      <div style="font-size:12px;color:var(--muted)">${escapeHtml(s.artist || '')} · ${escapeHtml(getSongKey(s))}</div></div>
      ${already ? '<span class="picker-already">уже в сете</span>' : ''}</div>`;
  }).join('');
  c.querySelectorAll('.picker-song-item').forEach(item => item.addEventListener('click', () => {
    const id = item.dataset.id;
    if (pickerSelected.has(id)) pickerSelected.delete(id); else pickerSelected.add(id);
    item.classList.toggle('selected', pickerSelected.has(id));
    item.querySelector('.picker-check').textContent = pickerSelected.has(id) ? '✓' : '';
    const n = pickerSelected.size;
    $('picker-confirm').textContent = n ? `Добавить ${n} ${plural(n, 'песню', 'песни', 'песен')}` : 'Добавить выбранные';
  }));
}

// ═══════════════════════════════════════════
//  SETTINGS
// ═══════════════════════════════════════════
function markActive(sel, attr, val) {
  document.querySelectorAll(sel).forEach(b => {
    const on = b.dataset[attr] === val;
    b.style.borderColor = on ? 'var(--primary)' : ''; b.style.color = on ? 'var(--primary)' : '';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}
function updateSettingsUI() {
  applyFontSize();
  markActive('.settings-theme-btn', 'theme', currentTheme());
  markActive('.settings-view-btn', 'mode', globalViewMode);
  markActive('.settings-notation-btn', 'notation', appSettings.notation || 'asis');
  markActive('.settings-density-btn', 'density', densityMode);
}
$('settings-nav-btn').addEventListener('click', () => { updateSettingsUI(); openOverlay('overlay-settings'); checkAdmin().catch(() => {}); });
$('settings-font-down').addEventListener('click', () => { changeFontSize(-1); updateSettingsUI(); });
$('settings-font-up').addEventListener('click', () => { changeFontSize(1); updateSettingsUI(); });
document.querySelectorAll('.settings-theme-btn').forEach(b => b.addEventListener('click', () => setTheme(b.dataset.theme)));
document.querySelectorAll('.settings-view-btn').forEach(b => b.addEventListener('click', () => { setGlobalViewMode(b.dataset.mode); updateSettingsUI(); showToast(GLOBAL_VIEW_TITLES[globalViewMode]); }));
document.querySelectorAll('.settings-notation-btn').forEach(b => b.addEventListener('click', () => {
  appSettings.notation = b.dataset.notation; saveSettings();
  _renderCache.clear(); VIRTUAL.bump();
  updateSettingsUI();
  if (currentPage === 'songs') renderSongs($('search-input').value);
}));
document.querySelectorAll('.settings-density-btn').forEach(b => b.addEventListener('click', () => { densityMode = b.dataset.density; LS.set(DENSITY_KEY, densityMode); applyDensityMode(); updateSettingsUI(); }));
$('settings-tuner-btn').addEventListener('click', () => { closeOverlay('overlay-settings'); openTuner(); });
document.querySelectorAll('.sort-chip').forEach(chip => {
  chip.classList.toggle('active', chip.dataset.sort === _sortMode);
  chip.addEventListener('click', () => {
    _sortMode = chip.dataset.sort; LS.set('cb_sort', _sortMode);
    document.querySelectorAll('.sort-chip').forEach(c => c.classList.toggle('active', c === chip));
    renderSongs($('search-input').value);
  });
});

// ═══════════════════════════════════════════
//  GLOBAL EVENTS
// ═══════════════════════════════════════════
$('back-btn').addEventListener('click', goBack);
$('fab-btn').addEventListener('click', () => {
  if (currentPage === 'setlists') {
    $('inp-setlist-name').value = '';
    $('inp-setlist-date').value = new Date().toISOString().slice(0, 10);
    openOverlay('overlay-add-setlist');
    return;
  }
  document.querySelectorAll('.import-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'manual'));
  document.querySelectorAll('.import-panel').forEach(p => p.classList.toggle('active', p.id === 'itab-manual'));
  openOverlay('overlay-import');
});
const debouncedSearch = debounce(v => renderSongs(v), 150);
$('search-input').addEventListener('input', e => { window.scrollTo(0, 0); debouncedSearch(e.target.value); });
document.querySelectorAll('.nav-btn[data-page]').forEach(btn => btn.addEventListener('click', () => showPage(btn.dataset.page)));
let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    updateHeaderHeight();
    if (currentPage === 'song-view' && currentSongId && !_inlineEditActive) { const s = songsCache.find(x => x.id === currentSongId); if (s) renderSongView(s); }
  }, 200);
});

// Pull-to-refresh на списках
(function initPullToRefresh() {
  const TH = 70, ind = $('ptr-indicator');
  let startY = 0, pulling = false, busy = false;
  const setPos = dy => { ind.style.transform = `translateX(-50%) translateY(${Math.min(dy, TH + 20) - 80}px)`; };
  const reset = () => { ind.classList.remove('ptr-visible', 'ptr-ready'); ind.textContent = '↓'; setPos(0); pulling = false; };
  document.addEventListener('touchstart', e => {
    if (busy || !['songs', 'setlists'].includes(currentPage) || document.querySelector('.overlay.open') || window.scrollY > 4) return;
    startY = e.touches[0].clientY; pulling = true;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || window.scrollY > 4) { reset(); return; }
    ind.classList.add('ptr-visible'); setPos(dy);
    const ready = dy >= TH;
    if (ready && !ind.classList.contains('ptr-ready') && navigator.vibrate) navigator.vibrate(8);
    ind.classList.toggle('ptr-ready', ready); ind.textContent = ready ? '↑' : '↓';
  }, { passive: true });
  document.addEventListener('touchend', async e => {
    if (!pulling) return;
    const dy = e.changedTouches[0].clientY - startY;
    if (dy < TH) { reset(); return; }
    pulling = false; busy = true; ind.textContent = '↻';
    try { await pull(); await checkPendingSongFromBot(); } catch (err) { console.warn(err); }
    ind.textContent = '✓'; setTimeout(() => { reset(); busy = false; }, 400);
  }, { passive: true });
  document.addEventListener('touchcancel', () => { if (pulling) reset(); }, { passive: true });
})();

document.addEventListener('keydown', e => {
  const tag = document.activeElement && document.activeElement.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA';
  if (e.key === 'Escape') {
    if (_activeMenu) { closeMenu(); return; }
    if ($('ce-popup').classList.contains('visible') || $('ie-chord-popup').classList.contains('visible') || $('ie-line-popup').classList.contains('visible')) { _ieHidePopups(); return; }
    const open = document.querySelector('.overlay.open');
    if (open) { closeOverlay(open.id); return; }
    return;
  }
  if (typing || document.querySelector('.overlay.open') || _inlineEditActive) return;
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && currentPage === 'song-view' && setlistContext) {
    navigateSetlistSong(e.key === 'ArrowLeft' ? -1 : 1); e.preventDefault();
  }
});

// ═══════════════════════════════════════════
//  TUNER
// ═══════════════════════════════════════════
const TUNER_NOTES = NOTES;
const GUITAR_TUNINGS = {
  standard: { name: 'E-A-D-G-B-e', strings: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
  dropD: { name: 'Drop D', strings: ['D2', 'A2', 'D3', 'G3', 'B3', 'E4'] },
  openG: { name: 'Open G', strings: ['D2', 'G2', 'D3', 'G3', 'B3', 'D4'] }
};
let tunerActive = false, tunerAudioCtx = null, tunerAnalyser = null, tunerStream = null, tunerAnimFrame = null, tunerBuf = null, tunerModeKey = 'standard';
function renderTunerStrings(activeNote) {
  $('tuner-strings').innerHTML = GUITAR_TUNINGS[tunerModeKey].strings.map(s => {
    const on = activeNote && s.replace(/\d/, '') === activeNote;
    return `<div style="padding:8px 14px;border-radius:12px;font-weight:800;font-size:14px;font-family:monospace;background:${on ? 'var(--primary)' : 'var(--glass-bg)'};border:1px solid var(--glass-border);color:${on ? '#fff' : 'var(--text)'}">${s}</div>`;
  }).join('');
}
function freqToNoteInfo(freq) {
  if (!freq || freq < 20 || freq > 5000) return null;
  const semis = 12 * Math.log2(freq / 440);
  const r = Math.round(semis);
  const note = TUNER_NOTES[((r % 12) + 12 + 9) % 12];
  const cents = Math.round(1200 * Math.log2(freq / (440 * Math.pow(2, r / 12))));
  return { note, cents, freq };
}
function autoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / SIZE) < 0.008) return -1;
  let r1 = 0, r2 = SIZE - 1;
  for (let i = 0; i < SIZE / 2; i++) if (Math.abs(buf[i]) < 0.2) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++) if (Math.abs(buf[SIZE - i]) < 0.2) { r2 = SIZE - i; break; }
  const s = buf.slice(r1, r2), len = Math.min(s.length, 4096);
  const c = new Float32Array(len);
  for (let i = 0; i < len; i++) for (let j = 0; j < len - i; j++) c[i] += s[j] * s[j + i];
  let d = 0; while (d < len - 1 && c[d] > c[d + 1]) d++;
  let maxVal = -1, maxPos = -1;
  for (let i = d; i < len; i++) if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; }
  if (maxPos <= 0 || maxPos >= len - 1) return -1;
  let T0 = maxPos;
  const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1], a = (x1 + x3 - 2 * x2) / 2, b = (x3 - x1) / 2;
  if (a) T0 -= b / (2 * a);
  return sampleRate / T0;
}
function roundRectPath(ctx, x, y, w, h, r) {
  // FIX: ctx.roundRect отсутствует в iOS < 16 / старых WebView — рисовали с ошибкой
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawTunerMeter(cents) {
  const canvas = $('tuner-canvas'); const ctx = canvas.getContext && canvas.getContext('2d'); if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.04)'; roundRectPath(ctx, 0, 0, W, H, 14); ctx.fill();
  ctx.fillStyle = 'rgba(76,175,125,0.18)'; roundRectPath(ctx, W / 2 - W * 0.05, 4, W * 0.1, H - 28, 6); ctx.fill();
  if (cents !== null) {
    const nx = W / 2 + (Math.max(-50, Math.min(50, cents)) / 50) * (W / 2 - 20);
    ctx.fillStyle = Math.abs(cents) < 5 ? '#4caf7d' : '#B794FF';
    roundRectPath(ctx, nx - 2, 8, 4, H - 30, 2); ctx.fill();
  }
}
function tunerLoop() {
  if (!tunerActive || !tunerAnalyser) return;
  tunerAnalyser.getFloatTimeDomainData(tunerBuf);
  const info = freqToNoteInfo(autoCorrelate(tunerBuf, tunerAudioCtx.sampleRate));
  if (info) {
    $('tuner-note').textContent = info.note;
    $('tuner-freq').textContent = info.freq.toFixed(1) + ' Hz';
    $('tuner-cents').textContent = (info.cents > 0 ? '+' : '') + info.cents + ' ¢';
    const ok = Math.abs(info.cents) < 5;
    $('tuner-status').textContent = ok ? '✅ В строе!' : info.cents < 0 ? '↑ Подтяни' : '↓ Ослабь';
    drawTunerMeter(info.cents); renderTunerStrings(info.note);
  } else drawTunerMeter(null);
  tunerAnimFrame = requestAnimationFrame(tunerLoop);
}
async function startTuner() {
  if (tunerActive) return;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no media');
    tunerStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    tunerAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    tunerAnalyser = tunerAudioCtx.createAnalyser(); tunerAnalyser.fftSize = 4096;
    tunerBuf = new Float32Array(tunerAnalyser.fftSize);
    tunerAudioCtx.createMediaStreamSource(tunerStream).connect(tunerAnalyser);
    tunerActive = true; tunerLoop();
  } catch { $('tuner-status').textContent = '⚠️ Нет доступа к микрофону'; }
}
function stopTuner() {
  tunerActive = false;
  if (tunerAnimFrame) cancelAnimationFrame(tunerAnimFrame);
  if (tunerStream) tunerStream.getTracks().forEach(t => t.stop());
  if (tunerAudioCtx) tunerAudioCtx.close().catch(() => {});
  tunerAudioCtx = tunerAnalyser = tunerStream = tunerBuf = null;
  $('tuner-note').textContent = '–'; $('tuner-freq').textContent = '– Hz'; $('tuner-cents').textContent = '0 ¢';
  $('tuner-status').textContent = '🎙 Слушаю...';
}
function openTuner() { openOverlay('overlay-tuner'); renderTunerStrings(null); drawTunerMeter(null); startTuner(); }
$('tuner-close').addEventListener('click', () => closeOverlay('overlay-tuner'));
$('tuner-mode-btn').addEventListener('click', () => {
  const keys = Object.keys(GUITAR_TUNINGS);
  tunerModeKey = keys[(keys.indexOf(tunerModeKey) + 1) % keys.length];
  $('tuner-mode-btn').textContent = GUITAR_TUNINGS[tunerModeKey].name; renderTunerStrings(null);
});
document.addEventListener('visibilitychange', () => { if (document.hidden && tunerActive) stopTuner(); });

// ═══════════════════════════════════════════
//  PRINT — печатает в текущем режиме (Слова / Аккорды / оба)
// ═══════════════════════════════════════════
function printSong(song) {
  const mode = getSongEffectiveMode(song.id);
  const content = renderSongContent(song, transposeOffset);
  const css = `body{font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;padding:24px;color:#111;background:#fff}
    h1{font-size:20px;margin:0 0 4px}.meta{font-size:13px;color:#666;margin-bottom:16px}
    .song-card-block,.chords-only-block{border-left:3px solid #aaa;padding:4px 10px;margin-bottom:8px;break-inside:avoid}
    .block-label-card,.chords-only-label{font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#555}
    .chord-badge{font-family:'Courier New',monospace;font-size:14px;font-weight:900;color:#111;margin-right:6px}
    .lyric-line{font-family:'Courier New',monospace;font-size:12px;color:#444;white-space:pre-wrap}
    .cs-square{display:flex;gap:10px;align-items:center}.cs-rows{flex:1}.cs-rep{font-weight:900;font-family:monospace}
    .cs-row-rep,.repeat-badge,.block-repeat-badge{font-size:11px;color:#666;margin-left:4px}
    .block-collapse-btn,.cs-form,.cs-manual-dot{display:none}
    ${mode === 'chords' ? '.song-card-block,.song-two-col{display:none}' : '.chords-only-block{display:none}'}
    ${mode === 'words' ? '.chord-row{display:none}' : ''}
    .song-two-col{display:flex;gap:16px}.song-col{flex:1}`;
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>${escapeHtml(song.title)}</title><style>${css}</style></head><body>
    <h1>${escapeHtml(song.title)}</h1><div class="meta">${song.artist ? escapeHtml(song.artist) + ' · ' : ''}${escapeHtml(transposeKey(getSongKey(song), transposeOffset, getSongNotation(song.id)))}${song.bpm ? ' · ' + song.bpm + ' BPM' : ''}</div>
    ${content}<script>window.onload=function(){setTimeout(function(){window.print()},150)}<\/script></body></html>`;
  const w = window.open('', '_blank');
  if (w && w.document) { w.document.write(html); w.document.close(); return; }
  // В Telegram WebView всплывающие окна блокируются — печатаем текущую страницу (есть @media print)
  try { window.print(); } catch { showToast('Печать недоступна в этом приложении'); }
}

// ═══════════════════════════════════════════
//  ПЕСНЯ ОТ БОТА-ПАРСЕРА (pending_<userId> в Firestore)
// ═══════════════════════════════════════════
async function checkPendingSongFromBot() {
  try {
    if (!tg || !tg.initData) return;
    // Worker сам определяет пользователя по подписи Telegram — чужую песню получить нельзя
    const r = await api('GET', '/api/pending');
    if (!r.ok) return;
    const data = r.data;
    if (!data || !data.title) { await api('DELETE', '/api/pending'); return; }
    const updatedAt = Number(data.updatedAt || 0);
    if (updatedAt && Date.now() - updatedAt > 30 * 60 * 1000) { await api('DELETE', '/api/pending'); return; }
    if (songsCache.some(s => (s.title || '').toLowerCase() === String(data.title).toLowerCase())) { await api('DELETE', '/api/pending'); showToast('«' + data.title + '» уже есть в ChordBook'); return; }
    const song = { id: uid(), title: String(data.title), artist: String(data.artist || ''), key: CE.isChord(data.key) ? data.key : (detectKeyFromLyrics(data.lyrics) || 'C'),
      bpm: Number(data.bpm) || 0, lyrics: String(data.lyrics || ''), tags: [], updatedAt: Date.now() };
    songsCache = [song, ...songsCache];
    // документ удаляется только ПОСЛЕ успешного сохранения
    const ok = await saveSingleSong(song);
    if (ok && !hasPending('song', song.id)) await api('DELETE', '/api/pending');
    renderSongs($('search-input').value);
    const t = $('toast');
    t.innerHTML = `«${escapeHtml(song.title)}» добавлена <button class="toast-undo-btn">Открыть</button>`;
    t.style.pointerEvents = 'auto'; t.classList.add('show'); clearTimeout(toastTimer);
    t.querySelector('button').onclick = () => { t.classList.remove('show'); t.style.pointerEvents = ''; openSong(song.id); };
    toastTimer = setTimeout(() => { t.classList.remove('show'); t.style.pointerEvents = ''; }, 6000);
  } catch (e) { console.warn('[ChordBook] pending check error:', e); }
}

// ═══════════════════════════════════════════
//  ONBOARDING
// ═══════════════════════════════════════════
(function initOnboarding() {
  if (LS.get('cb_onboarded_v2', false)) return;
  const ov = $('onboarding'); ov.style.display = 'flex';
  let step = 0; const total = 3;
  ov.querySelectorAll('[data-ob-next]').forEach(btn => btn.addEventListener('click', () => {
    $('ob-step-' + step).classList.remove('active'); $('ob-dot-' + step).classList.remove('active');
    step++;
    if (step >= total) { LS.set('cb_onboarded_v2', true); ov.style.display = 'none'; return; }
    $('ob-step-' + step).classList.add('active'); $('ob-dot-' + step).classList.add('active');
  }));
})();

async function migrateFromLocalStorage() {
  if (LS.get('cb_idb_migrated', false)) return;
  const oldSongs = LS.get('cb_songs', []), oldSetlists = LS.get('cb_setlists', []);
  try {
    if (oldSongs.length) await IDB.replaceAllSongs(oldSongs);
    if (oldSetlists.length) await IDB.replaceAllSetlists(oldSetlists);
    LS.set('cb_idb_migrated', true);
  } catch (e) { console.warn('migration failed', e); }
}

// ═══════════════════════════════════════════════════════════
//  INLINE EDIT
//  Два редактора поверх просмотра песни:
//   • «Слова» / «Слова+♪» — построчный: аккорды и текст строк (данные = lyrics)
//   • «Аккорды»           — редактор КВАДРАТОВ (данные = song.chordsOnlyLayout)
//  Оба показывают аккорды в ТЕКУЩЕЙ тональности (как на экране) и сохраняются
//  одной кнопкой. Есть история «↶». Немодифицированные строки текста
//  сохраняются байт-в-байт (позиции аккордов внутри строки не теряются).
// ═══════════════════════════════════════════════════════════
let _inlineEditActive = false;
let _inlineEditSong = null;
let _ieT = 0, _ieN = null;
let _ieBlocks = [];
let _ceLayout = {};          // bi → squares (в отображаемой тональности) — тронутые в этой сессии
let _ceOrig = {};            // bi → нормализованная исходная запись
let _ceReset = new Set();    // bi, сброшенные к авто
let _ieHistory = [];
let _ieInitialSnap = '';
let _ieStartKeys = [];

const _ieDisp = c => (_ieT || _ieN) ? transposeChord(c, _ieT, _ieN) : c;
const _ieStore = c => _ieT ? transposeChord(c, -_ieT, _ieN) : c;

function _ieParseBlocks(lyrics) {
  return parseSong(lyrics || '', 0).map(b => ({
    label: b.label || '', repeat: b.repeat || 1,
    lines: b.lines.filter(l => l.trim()).map(raw => ({ chords: lineChords(raw), lyric: lineLyric(raw), raw }))
  }));
}
function _ieLineUnchanged(l) {
  return l.raw != null && JSON.stringify(lineChords(l.raw)) === JSON.stringify(l.chords) && lineLyric(l.raw) === l.lyric;
}
function _ieBuildLyrics(blocks) {
  return blocks.map(b => {
    const out = [];
    if (b.label) out.push('[' + b.label + ']');
    if (b.repeat > 1) out.push('#repeat:' + b.repeat);
    b.lines.forEach(l => {
      if (_ieLineUnchanged(l)) { out.push(l.raw.replace(/\s+$/, '')); return; }
      const cs = l.chords.map(c => '[' + c + ']').join(' ');
      if (cs || l.lyric) out.push([cs, l.lyric].filter(Boolean).join(' '));
    });
    return out.join('\n');
  }).filter(s => s.trim()).join('\n\n');
}
function _ieSnapshot() { return JSON.stringify({ b: _ieBlocks, l: _ceLayout, r: [..._ceReset] }); }
function _ieRestore(snap) { const o = JSON.parse(snap); _ieBlocks = o.b; _ceLayout = o.l; _ceReset = new Set(o.r); }
function _ieIsDirty() { return _inlineEditActive && _ieSnapshot() !== _ieInitialSnap; }
function _ieCommit(fn) {
  _ieHistory.push(_ieSnapshot());
  if (_ieHistory.length > 80) _ieHistory.shift();
  fn();
  _ieRedraw();
}
function _ieUndo() {
  const snap = _ieHistory.pop();
  if (!snap) { showToast('Нечего отменять'); return; }
  _ieRestore(snap); _ieHidePopups(); _ieRedraw();
}

function toggleInlineEdit(song) { if (_inlineEditActive) cancelInlineEdit(); else startInlineEdit(song); }
function startInlineEdit(song) {
  _inlineEditActive = true;
  _inlineEditSong = song;
  _ieT = transposeOffset; _ieN = getSongNotation(song.id);
  _ieBlocks = _ieParseBlocks(song.lyrics);
  _ceOrig = CE.resolveLayout(song.chordsOnlyLayout, parseSong(song.lyrics, 0));
  _ceLayout = {}; _ceReset = new Set(); _ieHistory = [];
  _ieStartKeys = CE.blockKeys(_ieBlocks);
  _ieInitialSnap = _ieSnapshot();
  document.body.classList.add('inline-editing');
  $('inline-edit-banner').classList.add('visible');
  $('song-inline-edit-btn').classList.add('active');
  ['tr-up', 'tr-down'].forEach(id => { const b = $(id); if (b) b.disabled = true; });
  $('song-header').classList.remove('sv-hidden', 'perf-active');
  $('perf-nav-buttons').classList.remove('show');
  _ieRedraw();
}
function _ieTeardown() {
  _inlineEditActive = false;
  _ieBlocks = []; _ceLayout = {}; _ceOrig = {}; _ceReset = new Set(); _ieHistory = [];
  document.body.classList.remove('inline-editing');
  $('inline-edit-banner').classList.remove('visible');
  const btn = $('song-inline-edit-btn'); if (btn) btn.classList.remove('active');
  _ieHidePopups(); _dragEnd(true);
}
function cancelInlineEdit() {
  const song = songsCache.find(s => s.id === (_inlineEditSong && _inlineEditSong.id)) || _inlineEditSong;
  const finish = () => { _ieTeardown(); if (song) renderSongView(song); };
  if (_ieIsDirty()) showConfirm({ title: 'Отменить изменения?', msg: 'Все правки этой сессии будут потеряны.', okLabel: 'Отменить правки', onOk: finish });
  else finish();
}
function _ieBuildLayout() {
  const keys = CE.blockKeys(_ieBlocks);
  const layout = {};
  _ieBlocks.forEach((b, bi) => {
    if (_ceLayout[bi]) { const sq = CE.normalizeSquares(_ceLayout[bi]); if (sq.length) layout[bi] = CE.makeEntry(sq, keys[bi], _ieT, _ieN); return; }
    if (_ceReset.has(bi)) return;
    if (_ceOrig[bi]) layout[bi] = { ..._ceOrig[bi], key: keys[bi] };
  });
  return CE.compactLayout(layout);
}
async function saveInlineEdit() {
  const song = _inlineEditSong;
  if (!song) return;
  const updated = { ...song, lyrics: _ieBuildLyrics(_ieBlocks), updatedAt: Date.now() };
  const layout = _ieBuildLayout();
  if (layout) updated.chordsOnlyLayout = layout; else delete updated.chordsOnlyLayout;
  if (_Object_keys_changed(song.chordsOnlyLayout, layout)) delete updated._aiChordsBackup;
  if (song.arrangement) {
    // переименованные в редакторе части остаются в порядке песни
    const newKeys = CE.blockKeys(_ieBlocks), mapping = {};
    _ieStartKeys.forEach((k, i) => { if (newKeys[i]) mapping[k] = newKeys[i]; });
    const arrangement = CE.remapArrangement(song.arrangement, parseSong(updated.lyrics, 0), mapping);
    if (arrangement) updated.arrangement = arrangement; else delete updated.arrangement;
  }
  replaceSongInCache(updated);
  _ieTeardown();
  renderSongView(updated);
  showToast('Сохранено');
  await saveSingleSong(updated);
}
function _Object_keys_changed(a, b) { return JSON.stringify(a || null) !== JSON.stringify(b || null); }

$('inline-edit-save').addEventListener('click', saveInlineEdit);
$('inline-edit-cancel').addEventListener('click', cancelInlineEdit);
$('inline-edit-undo').addEventListener('click', _ieUndo);

function _ieMode() { return getSongEffectiveMode(currentSongId); }
function _ieDisplayKey() { return _inlineEditSong ? transposeKey(getSongKey(_inlineEditSong), _ieT, _ieN) : 'C'; }
function _ieTonic() { const k = _ieDisplayKey(); return /m$/.test(k) && !/maj$/.test(k) ? k : k; }

function _ieRedraw() {
  const inner = $('song-content-inner');
  if (!inner || !_inlineEditActive) return;
  const chordsMode = _ieMode() === 'chords';
  $('inline-edit-label').textContent = chordsMode ? 'Тап по такту — заменить аккорд' : 'Тап по аккорду — заменить, удержание строки — меню';
  $('inline-edit-undo').disabled = !_ieHistory.length;
  inner.innerHTML = (chordsMode ? _ceRenderEditor() : _ieRenderMixedEditor()) + '<button class="ie-add-block-btn" data-act="add-block">＋ Добавить блок</button>';
}

// ─────────── построчный редактор ───────────
function _ieRenderMixedEditor() {
  return _ieBlocks.map((b, bi) => {
    const color = getBlockColor(b.label, bi);
    const lines = b.lines.map((l, li) => {
      const chords = l.chords.map((c, ci) => `<span class="chord-badge" data-bi="${bi}" data-li="${li}" data-ci="${ci}">${escapeHtml(_ieDisp(c))}</span>`).join('');
      const lyric = l.lyric ? `<div class="lyric-line">${escapeHtml(l.lyric)}</div>` : (l.chords.length ? '' : '<div class="lyric-line" style="opacity:.35">(пустая строка)</div>');
      return `<div class="ie-line-wrap" data-bi="${bi}" data-li="${li}"><div class="chord-row" data-bi="${bi}" data-li="${li}" style="min-height:${l.chords.length ? 0 : 6}px">${chords}</div>${lyric}</div>`;
    }).join('') || `<div class="ie-line-wrap" data-bi="${bi}" data-li="-1"><div class="lyric-line" style="opacity:.35">(пустой блок — удержите, чтобы добавить строку)</div></div>`;
    const label = `<div class="block-label-card" data-act="rename" data-bi="${bi}">${escapeHtml(b.label || '+ метка')}${b.repeat > 1 ? `<span class="block-repeat-badge">×${b.repeat}</span>` : ''}</div>`;
    return `<div class="song-card-block" data-bi="${bi}" style="--block-color:${color}">${label}<div class="block-chords">${lines}</div></div>`;
  }).join('');
}

// ─────────── редактор квадратов ───────────
function _ceAutoSquares(bi) {
  const b = _ieBlocks[bi]; if (!b) return [];
  // текст строки передаём тоже: в нём может быть «x2» — повтор строки
  return CE.analyzeBlock(b.lines.map(l => l.chords.map(c => '[' + _ieDisp(c) + ']').join(' ') + ' ' + l.lyric));
}
function _ceIsManual(bi) { return !!_ceLayout[bi] || (!_ceReset.has(bi) && !!_ceOrig[bi]); }
function _ceGetSquares(bi) {
  if (_ceLayout[bi]) return _ceLayout[bi];
  if (!_ceReset.has(bi) && _ceOrig[bi]) return CE.entrySquaresAt(_ceOrig[bi], _ieT, _ieN);
  return _ceAutoSquares(bi);
}
function _ceMutate(bi, fn) { _ieCommit(() => { _ceLayout[bi] = CE.normalizeSquares(fn(_ceGetSquares(bi))); _ceReset.delete(bi); }); }
function _ceRenderEditor() {
  return _ieBlocks.map((b, bi) => {
    const squares = _ceGetSquares(bi);
    const manual = _ceIsManual(bi);
    const color = getBlockColor(b.label, bi);
    const sqHtml = squares.map((sq, si) => {
      const multi = sq.rows.length > 1;
      const rows = sq.rows.map((r, ri) => `<div class="ce-row" data-bi="${bi}" data-si="${si}" data-ri="${ri}">
          ${r.chords.map((c, ci) => `<span class="chord-badge" data-bi="${bi}" data-si="${si}" data-ri="${ri}" data-ci="${ci}">${escapeHtml(c)}</span>`).join('')}
          <button class="ce-add-chord" data-act="add-chord" aria-label="Добавить аккорд">＋</button>
          ${multi ? `<button class="ce-row-rep" data-act="row-rep" title="Повтор строки">×${r.repeat}</button>` : ''}
          <button class="ce-row-menu" data-act="row-menu" aria-label="Действия со строкой">⋯</button></div>`).join('');
      return `<div class="ce-square" data-bi="${bi}" data-si="${si}">
        <div class="ce-sq-head"><span class="ce-sq-title">Квадрат ${si + 1}</span>
          <div class="ce-stepper"><button data-act="sq-dec" aria-label="Меньше повторов">−</button><span>×${sq.repeat}</span><button data-act="sq-inc" aria-label="Больше повторов">+</button></div>
          <button class="ce-row-menu" data-act="sq-menu" aria-label="Действия с квадратом">⋯</button></div>
        ${rows}
        <div class="ce-sq-foot"><button data-act="add-row">＋ строка</button></div></div>`;
    }).join('');
    return `<div class="ce-block" data-bi="${bi}" style="--block-color:${color}">
      <div class="ce-head"><span class="ce-label" data-act="rename" data-bi="${bi}">${escapeHtml(b.label || 'Без метки')}</span>
        <span class="ce-mode ${manual ? 'manual' : ''}">${manual ? 'ручная' : 'авто'}</span>
        <div class="ce-tools">
          <button class="ce-tool" data-act="text" title="Редактировать текстом">✎ Текст</button>
          <button class="ce-tool" data-act="recompress" title="Найти повторы в том, что набрано">✨ Сжать</button>
          ${manual ? '<button class="ce-tool" data-act="reset" title="Вернуть авто-анализ">↺ Авто</button>' : ''}
        </div></div>
      ${sqHtml || '<div class="ce-preview">В блоке нет аккордов</div>'}
      <button class="ce-add-square" data-act="add-square">＋ Квадрат</button></div>`;
  }).join('');
}

// ─────────── клики по кнопкам редакторов (делегирование) ───────────
$('song-content-inner').addEventListener('click', e => {
  if (!_inlineEditActive) return;
  const actEl = e.target.closest('[data-act]');
  if (!actEl) return;
  e.stopPropagation();
  const act = actEl.dataset.act;
  const holder = actEl.closest('[data-bi]');
  const bi = holder ? +holder.dataset.bi : -1;
  const sqEl = actEl.closest('.ce-square'), rowEl = actEl.closest('.ce-row');
  const si = sqEl ? +sqEl.dataset.si : -1, ri = rowEl ? +rowEl.dataset.ri : -1;
  switch (act) {
    case 'add-block': return _ieAddBlock();
    case 'rename': return _ieRename(bi);
    case 'text': return _ceOpenText(bi);
    case 'recompress': return _ceMutate(bi, sq => CE.ops.recompress(sq));
    case 'reset': return showConfirm({ title: 'Вернуть авто-квадраты?', msg: 'Ручная раскладка этого блока будет удалена.', okLabel: 'Вернуть', onOk: () => _ieCommit(() => { delete _ceLayout[bi]; _ceReset.add(bi); }) });
    case 'add-square': {
      const tonic = _ieTonic();
      _ceMutate(bi, sq => CE.ops.addSquare(sq, null, [tonic]));
      return _ceOpenPopupAt(bi, _ceGetSquares(bi).length - 1, 0, 0);
    }
    case 'sq-inc': return _ceMutate(bi, sq => CE.ops.setSquareRepeat(sq, si, sq[si].repeat + 1));
    case 'sq-dec': return _ceMutate(bi, sq => CE.ops.setSquareRepeat(sq, si, sq[si].repeat - 1));
    case 'add-row': { const tonic = _ieTonic(); _ceMutate(bi, sq => CE.ops.addRow(sq, si, [tonic])); const s = _ceGetSquares(bi)[si]; return _ceOpenPopupAt(bi, si, s.rows.length - 1, 0); }
    case 'add-chord': {
      const tonic = _ieTonic();
      _ceMutate(bi, sq => CE.ops.insertChord(sq, { si, ri, ci: null }, tonic));
      return _ceOpenPopupAt(bi, si, ri, _ceGetSquares(bi)[si].rows[ri].chords.length - 1);
    }
    case 'row-rep': return _ceMutate(bi, sq => CE.ops.setRowRepeat(sq, si, ri, sq[si].rows[ri].repeat >= 4 ? 1 : sq[si].rows[ri].repeat + 1));
    case 'row-menu': return openMenu(actEl, [
      ri > 0 && { label: 'Склеить с предыдущей строкой', onClick: () => _ceMutate(bi, sq => CE.ops.mergeRowUp(sq, si, ri)) },
      ri > 0 && { label: 'Начать здесь новый квадрат', onClick: () => _ceMutate(bi, sq => CE.ops.splitSquare(sq, si, ri)) },
      { label: 'Удалить строку', danger: true, onClick: () => _ceMutate(bi, sq => { const c = JSON.parse(JSON.stringify(sq)); c[si].rows.splice(ri, 1); return c; }) },
    ]);
    case 'sq-menu': {
      const n = _ceGetSquares(bi).length;
      return openMenu(actEl, [
        { label: 'Дублировать квадрат', onClick: () => _ceMutate(bi, sq => CE.ops.duplicateSquare(sq, si)) },
        si < n - 1 && { label: 'Объединить со следующим', onClick: () => _ceMutate(bi, sq => CE.ops.mergeSquareDown(sq, si)) },
        { label: 'Удалить квадрат', danger: true, onClick: () => _ceMutate(bi, sq => CE.ops.deleteSquare(sq, si)) },
      ]);
    }
  }
});

// ─────────── свой prompt (window.prompt ненадёжен в Telegram WebView) ───────────
function showPrompt({ title, value, placeholder, onOk }) {
  const el = showConfirm({ title, msg: '', okLabel: 'OK', onOk: () => onOk(inp.value) });
  const box = el.querySelector('.confirm-dialog-msg');
  box.style.marginBottom = '14px';
  const inp = document.createElement('input');
  inp.className = 'form-input'; inp.value = value || ''; inp.placeholder = placeholder || '';
  box.appendChild(inp);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') el.querySelector('.confirm-dialog-ok').click(); });
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
}
function _ieRename(bi) {
  const b = _ieBlocks[bi]; if (!b) return;
  showPrompt({ title: 'Название блока', value: b.label, placeholder: 'Куплет 1', onOk: v => {
    const nv = v.trim();
    // Блок без метки «склеился» бы с предыдущим при сохранении — запрещаем для всех, кроме первого
    if (!nv && bi > 0) { showToast('У блока должна быть метка'); return; }
    if (nv && !CE.isBlockLabel(nv)) { showToast('Похоже на аккорд — используйте слово, например «Припев»'); return; }
    _ieCommit(() => { b.label = nv; });
  } });
}
function _ieAddBlock() {
  const labels = ['Куплет', 'Припев', 'Бридж', 'Проигрыш', 'Аутро'];
  const used = new Set(_ieBlocks.map(b => CE.genericLabel(b.label)));
  const label = labels.find(l => !used.has(CE.genericLabel(l))) || 'Куплет ' + (_ieBlocks.length + 1);
  _ieCommit(() => { _ieBlocks.push({ label, repeat: 1, lines: [{ chords: [_ieStore(_ieTonic())], lyric: '', raw: null }] }); });
  setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 60);
}

// ─────────── попапы ───────────
let _iePopupCtx = null, _ieLineCtx = null, _cePopupCtx = null, _popupOutside = null;
function _placePopup(popup, anchor) {
  popup.classList.add('visible');
  const r = anchor.getBoundingClientRect();
  const pw = popup.offsetWidth || 240, ph = popup.offsetHeight || 220;
  let top = r.bottom + 8, left = r.left;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8);
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  popup.style.top = Math.max(8, top) + 'px'; popup.style.left = Math.max(8, left) + 'px';
  _popupOutside = e => { if (!popup.contains(e.target)) _ieHidePopups(); };
  setTimeout(() => document.addEventListener('pointerdown', _popupOutside, true), 250);
}
function _ieHidePopups() {
  ['ie-chord-popup', 'ie-line-popup', 'ce-popup'].forEach(id => $(id).classList.remove('visible'));
  _iePopupCtx = _ieLineCtx = _cePopupCtx = null;
  if (_popupOutside) { document.removeEventListener('pointerdown', _popupOutside, true); _popupOutside = null; }
  document.querySelectorAll('.chord-badge.ce-selected').forEach(b => b.classList.remove('ce-selected'));
}
function _paletteHtml(list) { return list.map(c => `<button type="button" data-chord="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join(''); }
function _songChordsDisplay() {
  const seen = new Set();
  _ieBlocks.forEach(b => b.lines.forEach(l => l.chords.forEach(c => seen.add(_ieDisp(c)))));
  Object.keys(_ceLayout).forEach(bi => CE.expandSquares(_ceLayout[bi]).forEach(c => seen.add(c)));
  return [...seen].slice(0, 16);
}
function _focusSelect(inp) {
  // На телефоне не открываем клавиатуру сразу — палитра покрывает 90% случаев
  if (!('ontouchstart' in window)) setTimeout(() => { inp.focus(); inp.select(); }, 30);
}

function _ieOpenChordPopup(badge) {
  _ieHidePopups();
  const bi = +badge.dataset.bi, li = +badge.dataset.li, ci = +badge.dataset.ci;
  const c = _ieBlocks[bi] && _ieBlocks[bi].lines[li] && _ieBlocks[bi].lines[li].chords[ci];
  if (c == null) return;
  _iePopupCtx = { bi, li, ci };
  $('ie-cp-input').value = _ieDisp(c);
  $('ie-cp-palette').innerHTML = _paletteHtml(CE.diatonicChords(_ieDisplayKey(), _ieN));
  _placePopup($('ie-chord-popup'), badge);
  _focusSelect($('ie-cp-input'));
}
function _ieChordSave(val) {
  const ctx = _iePopupCtx; if (!ctx) return;
  val = String(val || '').trim();
  if (!val) { _ieHidePopups(); return; }
  if (!CE.isChord(val)) { showToast('«' + val + '» — не похоже на аккорд'); return; }
  _ieHidePopups();
  _ieCommit(() => { _ieBlocks[ctx.bi].lines[ctx.li].chords[ctx.ci] = _ieStore(val); });
}
$('ie-cp-ok').addEventListener('click', () => _ieChordSave($('ie-cp-input').value));
$('ie-cp-input').addEventListener('keydown', e => { if (e.key === 'Enter') _ieChordSave($('ie-cp-input').value); });
$('ie-cp-palette').addEventListener('click', e => { const b = e.target.closest('[data-chord]'); if (b) _ieChordSave(b.dataset.chord); });
$('ie-cp-del').addEventListener('click', () => {
  const ctx = _iePopupCtx; if (!ctx) return; _ieHidePopups();
  _ieCommit(() => { _ieBlocks[ctx.bi].lines[ctx.li].chords.splice(ctx.ci, 1); });
});

function _ieOpenLinePopup(wrap) {
  _ieHidePopups();
  _ieLineCtx = { bi: +wrap.dataset.bi, li: +wrap.dataset.li };
  const empty = _ieLineCtx.li < 0;
  ['ie-line-addchord', 'ie-line-text', 'ie-line-del'].forEach(id => { $(id).style.display = empty ? 'none' : ''; });
  _placePopup($('ie-line-popup'), wrap);
}
$('ie-line-addchord').addEventListener('click', () => {
  const ctx = _ieLineCtx; if (!ctx) return; _ieHidePopups();
  _ieCommit(() => { _ieBlocks[ctx.bi].lines[ctx.li].chords.push(_ieStore(_ieTonic())); });
  const ci = _ieBlocks[ctx.bi].lines[ctx.li].chords.length - 1;
  const b = document.querySelector(`#song-content-inner .chord-badge[data-bi="${ctx.bi}"][data-li="${ctx.li}"][data-ci="${ci}"]`);
  if (b) _ieOpenChordPopup(b);
});
$('ie-line-text').addEventListener('click', () => {
  const ctx = _ieLineCtx; if (!ctx) return; _ieHidePopups();
  const line = _ieBlocks[ctx.bi].lines[ctx.li];
  showPrompt({ title: 'Текст строки', value: line.lyric, onOk: v => _ieCommit(() => { line.lyric = v.replace(/\[[^\]]*\]/g, '').trim(); }) });
});
$('ie-line-add').addEventListener('click', () => {
  const ctx = _ieLineCtx; if (!ctx) return; _ieHidePopups();
  _ieCommit(() => { _ieBlocks[ctx.bi].lines.splice(ctx.li + 1, 0, { chords: [_ieStore(_ieTonic())], lyric: '', raw: null }); });
});
$('ie-line-del').addEventListener('click', () => {
  const ctx = _ieLineCtx; if (!ctx) return; _ieHidePopups();
  _ieCommit(() => { _ieBlocks[ctx.bi].lines.splice(ctx.li, 1); });
});

// Попап аккорда в редакторе квадратов
function _ceOpenPopupAt(bi, si, ri, ci) {
  const badge = document.querySelector(`#song-content-inner .ce-row .chord-badge[data-bi="${bi}"][data-si="${si}"][data-ri="${ri}"][data-ci="${ci}"]`);
  if (badge) _ceOpenPopup(badge);
}
function _ceOpenPopup(badge) {
  _ieHidePopups();
  const p = { bi: +badge.dataset.bi, si: +badge.dataset.si, ri: +badge.dataset.ri, ci: +badge.dataset.ci };
  const sq = _ceGetSquares(p.bi);
  const chord = sq[p.si] && sq[p.si].rows[p.ri] && sq[p.si].rows[p.ri].chords[p.ci];
  if (chord == null) return;
  _cePopupCtx = p;
  badge.classList.add('ce-selected');
  $('ce-input').value = chord;
  $('ce-palette-key').innerHTML = _paletteHtml(CE.diatonicChords(_ieDisplayKey(), _ieN));
  const songCh = _songChordsDisplay().filter(c => !CE.diatonicChords(_ieDisplayKey(), _ieN).includes(c));
  $('ce-palette-song').innerHTML = _paletteHtml(songCh);
  $('ce-palette-song-label').style.display = songCh.length ? '' : 'none';
  $('ce-split').disabled = p.ci === 0;
  _placePopup($('ce-popup'), badge);
  _focusSelect($('ce-input'));
}
function _ceApply(fn, reopen) {
  const p = _cePopupCtx; if (!p) return;
  _ieHidePopups();
  let next = null;
  _ceMutate(p.bi, sq => { const r = fn(sq, p); if (r && r.squares) { next = r.pos; return r.squares; } return r; });
  if (reopen && next) _ceOpenPopupAt(p.bi, next.si, next.ri, next.ci);
}
function _ceSetValue(v) {
  v = String(v || '').trim();
  if (!v) { _ieHidePopups(); return; }
  if (!CE.isChord(v)) { showToast('«' + v + '» — не похоже на аккорд'); return; }
  _ceApply((sq, p) => CE.ops.setChord(sq, p, v));
}
$('ce-ok').addEventListener('click', () => _ceSetValue($('ce-input').value));
$('ce-input').addEventListener('keydown', e => { if (e.key === 'Enter') _ceSetValue($('ce-input').value); });
$('ce-palette-key').addEventListener('click', e => { const b = e.target.closest('[data-chord]'); if (b) _ceSetValue(b.dataset.chord); });
$('ce-palette-song').addEventListener('click', e => { const b = e.target.closest('[data-chord]'); if (b) _ceSetValue(b.dataset.chord); });
$('ce-del').addEventListener('click', () => _ceApply((sq, p) => CE.ops.removeChord(sq, p)));
$('ce-left').addEventListener('click', () => _ceApply((sq, p) => CE.ops.shiftChord(sq, p, -1), true));
$('ce-right').addEventListener('click', () => _ceApply((sq, p) => CE.ops.shiftChord(sq, p, 1), true));
$('ce-split').addEventListener('click', () => _ceApply((sq, p) => CE.ops.splitRow(sq, p)));

// Текстовый редактор квадратов блока
let _ceTextBi = -1;
function _ceOpenText(bi) {
  _ceTextBi = bi;
  $('ce-text-title').textContent = 'Квадраты: ' + (_ieBlocks[bi].label || 'блок');
  $('ce-text-input').value = CE.squaresToText(_ceGetSquares(bi));
  _ceTextPreview();
  openOverlay('overlay-ce-text');
}
function _ceTextPreview() {
  const inv = [];
  const sq = CE.parseSquaresText($('ce-text-input').value, inv);
  const n = CE.expandSquares(sq).length;
  $('ce-text-preview').textContent = `Квадратов: ${sq.length} · аккордов при игре: ${n}` + (inv.length ? ` · не распознано: ${[...new Set(inv)].join(', ')}` : '');
}
$('ce-text-input').addEventListener('input', debounce(_ceTextPreview, 150));
$('ce-text-save').addEventListener('click', () => {
  const bi = _ceTextBi; if (bi < 0) return;
  const sq = CE.parseSquaresText($('ce-text-input').value);
  closeOverlay('overlay-ce-text');
  _ceMutate(bi, () => sq);
});

// ─────────── нажатия: тап / удержание / перетаскивание ───────────
let _press = null, _drag = null, _lastTouch = 0;
const _ghost = $('ie-drag-ghost');
function _pressStart(x, y, target) {
  if (!_inlineEditActive || target.closest('[data-act], .chord-edit-popup')) return;
  const badge = target.closest('.chord-badge[data-ci]');
  const line = !badge && target.closest('.ie-line-wrap[data-li]');
  if (!badge && !line) return;
  _press = { x, y, badge, line, moved: false, long: false };
  _press.timer = setTimeout(() => {
    if (!_press) return;
    _press.long = true;
    if (navigator.vibrate) navigator.vibrate(12);
    if (badge) _dragBegin(badge, x, y); else _ieOpenLinePopup(line);
  }, 330);
}
function _pressMove(x, y, ev) {
  if (_drag) { if (ev && ev.cancelable) ev.preventDefault(); _dragMove(x, y); return; }
  if (!_press) return;
  if (Math.hypot(x - _press.x, y - _press.y) > 10) { clearTimeout(_press.timer); _press = null; } // это прокрутка
}
function _pressEnd(x, y) {
  if (_drag) { _dragDrop(x, y); return; }
  if (!_press) return;
  clearTimeout(_press.timer);
  const p = _press; _press = null;
  if (p.long) return;
  if (p.badge) { if (p.badge.closest('.ce-row')) _ceOpenPopup(p.badge); else _ieOpenChordPopup(p.badge); }
}
const inner0 = $('song-content-inner');
inner0.addEventListener('touchstart', e => { _lastTouch = Date.now(); if (e.touches.length === 1) _pressStart(e.touches[0].clientX, e.touches[0].clientY, e.target); }, { passive: true });
inner0.addEventListener('touchmove', e => _pressMove(e.touches[0].clientX, e.touches[0].clientY, e), { passive: false });
inner0.addEventListener('touchend', e => { const t = e.changedTouches[0]; _pressEnd(t.clientX, t.clientY); });
inner0.addEventListener('touchcancel', () => { if (_press) clearTimeout(_press.timer); _press = null; _dragEnd(true); });
inner0.addEventListener('mousedown', e => {
  if (Date.now() - _lastTouch < 800 || e.button !== 0) return;
  _pressStart(e.clientX, e.clientY, e.target);
  if (!_press) return;
  const mm = ev => _pressMove(ev.clientX, ev.clientY, ev);
  const mu = ev => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); _pressEnd(ev.clientX, ev.clientY); };
  document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
});

function _dragBegin(badge, x, y) {
  _ieHidePopups();
  const ce = !!badge.closest('.ce-row');
  _drag = { ce, badge, from: ce ? { bi: +badge.dataset.bi, si: +badge.dataset.si, ri: +badge.dataset.ri, ci: +badge.dataset.ci } : { bi: +badge.dataset.bi, li: +badge.dataset.li, ci: +badge.dataset.ci } };
  _press = null;
  badge.classList.add('ie-dragging');
  _ghost.textContent = badge.textContent;
  _ghost.style.display = 'inline-flex';
  _dragMove(x, y);
}
function _dragTarget(x, y) {
  const rows = [...document.querySelectorAll(_drag.ce ? '#song-content-inner .ce-row' : '#song-content-inner .chord-row[data-li]')];
  let best = null, bestD = Infinity;
  for (const row of rows) {
    const r = row.getBoundingClientRect();
    if (y < r.top - 30 || y > r.bottom + 30) continue;
    const d = Math.abs(y - (r.top + r.height / 2));
    if (d < bestD) { bestD = d; best = row; }
  }
  if (!best) return null;
  const badges = [...best.querySelectorAll('.chord-badge[data-ci]')].filter(b => b !== _drag.badge || true);
  let ci = badges.length ? +badges[badges.length - 1].dataset.ci + 1 : 0;
  for (const b of badges) { const r = b.getBoundingClientRect(); if (x < r.left + r.width / 2) { ci = +b.dataset.ci; break; } }
  const t = _drag.ce ? { bi: +best.dataset.bi, si: +best.dataset.si, ri: +best.dataset.ri, ci } : { bi: +best.dataset.bi, li: +best.dataset.li, ci };
  t.row = best; t.before = badges.find(b => +b.dataset.ci === ci) || null;
  return t;
}
function _dragMove(x, y) {
  _ghost.style.left = (x - 22) + 'px'; _ghost.style.top = (y - 40) + 'px';
  document.querySelectorAll('.ie-insert-cursor').forEach(c => c.remove());
  const t = _dragTarget(x, y);
  if (!t) return;
  const cur = document.createElement('span'); cur.className = 'ie-insert-cursor';
  if (t.before) t.row.insertBefore(cur, t.before);
  else { const add = t.row.querySelector('.ce-add-chord'); t.row.insertBefore(cur, add || null); }
  // автопрокрутка у краёв экрана
  if (y < 90) window.scrollBy(0, -12); else if (y > window.innerHeight - 60) window.scrollBy(0, 12);
}
function _dragEnd(silent) {
  if (_ghost) _ghost.style.display = 'none';
  document.querySelectorAll('.ie-insert-cursor').forEach(c => c.remove());
  document.querySelectorAll('.chord-badge.ie-dragging').forEach(b => b.classList.remove('ie-dragging'));
  _drag = null;
}
function _dragDrop(x, y) {
  const d = _drag; const t = _dragTarget(x, y);
  _dragEnd();
  if (!d || !t) return;
  const f = d.from;
  if (d.ce) {
    if (t.bi === f.bi && t.si === f.si && t.ri === f.ri && (t.ci === f.ci || t.ci === f.ci + 1)) return;
    if (t.bi === f.bi) _ceMutate(f.bi, sq => CE.ops.moveChord(sq, f, t));
    else _ieCommit(() => {
      const r = CE.ops.moveChordAcross(_ceGetSquares(f.bi), f, _ceGetSquares(t.bi), t);
      _ceLayout[f.bi] = r.src; _ceLayout[t.bi] = r.dst; _ceReset.delete(f.bi); _ceReset.delete(t.bi);
    });
    return;
  }
  if (t.bi === f.bi && t.li === f.li && (t.ci === f.ci || t.ci === f.ci + 1)) return;
  _ieCommit(() => _ieMoveChord(f, t));
}
// Перенос аккорда в построчном редакторе (с корректировкой индексов)
function _ieMoveChord(f, t) {
  const src = _ieBlocks[f.bi] && _ieBlocks[f.bi].lines[f.li];
  const dstLine = _ieBlocks[t.bi] && _ieBlocks[t.bi].lines[t.li];
  if (!src || !dstLine || f.ci >= src.chords.length) return;
  const chord = src.chords.splice(f.ci, 1)[0];
  let ci = t.ci;
  if (src === dstLine && ci > f.ci) ci--;
  dstLine.chords.splice(Math.max(0, Math.min(ci, dstLine.chords.length)), 0, chord);
  if (!src.chords.length && !src.lyric && src !== dstLine) _ieBlocks[f.bi].lines.splice(f.li, 1);
}


// ═══════════════════════════════════════════
//  АДМИНИСТРАТОР: перенос старых данных, корзина
// ═══════════════════════════════════════════
let _isAdmin = false;
async function checkAdmin() {
  const r = await api('GET', '/api/me');
  _isAdmin = !!(r.ok && r.data && r.data.isAdmin);
  $('admin-section').style.display = _isAdmin ? '' : 'none';
  return _isAdmin;
}
$('admin-migrate-btn').addEventListener('click', () => showConfirm({
  title: 'Перенести данные?', msg: 'Песни, сет-листы и тональности из старой общей базы будут скопированы в новую. Уже перенесённые не дублируются, старые данные не удаляются.', okLabel: 'Перенести',
  onOk: async () => {
    const b = $('admin-migrate-btn'); b.disabled = true; b.textContent = 'Переносим…';
    const r = await api('POST', '/admin/migrate', {}, 120000);
    b.disabled = false; b.textContent = 'Перенести данные из старой базы';
    if (!r.ok) { showToast('Не удалось: ' + r.error); return; }
    showToast(`Перенесено: песен ${r.data.songs}, сет-листов ${r.data.setlists}, тональностей ${r.data.keys}${r.data.skipped ? ', пропущено ' + r.data.skipped : ''}`, 6000);
    _cursor = 0; await pull();
  }
}));
$('admin-trash-btn').addEventListener('click', async () => {
  const box = $('admin-trash'); box.textContent = 'Загружаем…';
  const r = await api('GET', '/admin/trash');
  if (!r.ok) { box.textContent = 'Не удалось: ' + r.error; return; }
  const list = (r.data.songs || []).sort((x, y) => (y.deletedAt || 0) - (x.deletedAt || 0));
  if (!list.length) { box.textContent = 'Корзина пуста'; return; }
  box.innerHTML = list.map(s => `<div class="sync-song-row"><div class="sync-song-info"><div class="sync-song-title">${escapeHtml(s.title)}</div>
    <div class="sync-song-keys">${s.deletedAt ? new Date(s.deletedAt).toLocaleString('ru') : ''}</div></div>
    <button class="ctrl-btn" data-restore="${escapeHtml(s.id)}">Восстановить</button></div>`).join('');
});
$('admin-trash').addEventListener('click', async e => {
  const b = e.target.closest('[data-restore]'); if (!b) return;
  b.disabled = true;
  const r = await api('POST', '/admin/restore/songs/' + encodeURIComponent(b.dataset.restore));
  if (!r.ok) { b.disabled = false; showToast('Не удалось: ' + r.error); return; }
  b.closest('.sync-song-row').remove();
  await pull();
  showToast('Восстановлено: ' + r.data.item.title);
});

// ═══════════════════════════════════════════
//  ПОРЯДОК ПЕСНИ (arrangement) — редактор
// ═══════════════════════════════════════════
let _arr = null; // { songId, items, blocks, analysis }
function openArrangementEditor(song) {
  if (_inlineEditActive) { showToast('Сначала сохраните или отмените редактирование'); return; }
  const notation = getSongNotation(song.id);
  const blocks = parseSong(song.lyrics, transposeOffset, notation);
  const analysis = CE.analyzeSong(blocks, song.chordsOnlyLayout, transposeOffset, notation);
  const items = CE.resolveArrangement(song.arrangement, blocks, analysis).map(it => ({ ref: it.ref, repeat: it.repeat }));
  _arr = { songId: song.id, items, blocks, analysis };
  renderArrangementEditor();
  openOverlay('overlay-arrangement');
}
function _arrPart(ref) {
  const bi = CE.blockKeys(_arr.blocks).indexOf(ref);
  const a = _arr.analysis[bi];
  return { bi, label: a ? (a.label || 'Без метки') : '?', color: a ? getBlockColor(a.label, bi) : 'var(--muted)', a };
}
function renderArrangementEditor() {
  if (!_arr) return;
  const resolved = _arr.items.map(it => ({ ...it, bi: _arrPart(it.ref).bi })).filter(it => it.bi >= 0);
  $('arr-preview').innerHTML = resolved.length ? songMapHtml(resolved, _arr.analysis, false, false) : '';
  const n = _arr.items.length;
  $('arr-list').innerHTML = n ? _arr.items.map((it, i) => {
    const p = _arrPart(it.ref);
    return `<div class="arr-item" data-i="${i}" style="--c:${p.color}">
      <span class="arr-handle" aria-label="Перетащить"><svg class="ico"><use href="#i-grip"/></svg></span>
      <span class="arr-dot"></span><span class="arr-name">${escapeHtml(p.label)}</span>
      <button class="arr-move" data-arr="up" aria-label="Выше" ${i === 0 ? 'disabled' : ''}><svg class="ico"><use href="#i-up"/></svg></button>
      <button class="arr-move" data-arr="down" aria-label="Ниже" ${i === n - 1 ? 'disabled' : ''}><svg class="ico"><use href="#i-down"/></svg></button>
      <div class="arr-rep"><button data-arr="dec" aria-label="Меньше повторов">−</button><span>×${it.repeat}</span><button data-arr="inc" aria-label="Больше повторов">+</button></div>
      <button class="arr-del" data-arr="del" aria-label="Убрать часть"><svg class="ico"><use href="#i-x"/></svg></button></div>`;
  }).join('') : '<div class="empty" style="padding:16px">Добавьте части ниже</div>';
  $('arr-parts').innerHTML = CE.uniqueParts(_arr.blocks, _arr.analysis).map(p =>
    `<button class="arr-part" data-ref="${escapeHtml(p.ref)}" style="--c:${getBlockColor(p.label, p.bi)}">${escapeHtml(p.label)}</button>`).join('');
}
function _arrApply(fn) { _arr.items = fn(_arr.items); renderArrangementEditor(); }
$('arr-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-arr]'); if (!btn || !_arr) return;
  const i = +btn.closest('.arr-item').dataset.i;
  const it = _arr.items[i];
  switch (btn.dataset.arr) {
    case 'up': return _arrApply(a => CE.arrOps.move(a, i, i - 1));
    case 'down': return _arrApply(a => CE.arrOps.move(a, i, i + 1));
    case 'inc': return _arrApply(a => CE.arrOps.setRepeat(a, i, it.repeat + 1));
    case 'dec': return _arrApply(a => CE.arrOps.setRepeat(a, i, it.repeat - 1));
    case 'del': return _arrApply(a => CE.arrOps.remove(a, i));
  }
});
$('arr-parts').addEventListener('click', e => {
  const b = e.target.closest('[data-ref]'); if (!b || !_arr) return;
  _arrApply(a => CE.arrOps.insert(a, null, b.dataset.ref));
  const list = $('arr-list'); list.lastElementChild && list.lastElementChild.scrollIntoView && list.lastElementChild.scrollIntoView({ block: 'nearest' });
});
$('arr-reset').addEventListener('click', () => { if (_arr) _arrApply(() => CE.defaultArrangement(_arr.blocks, _arr.analysis)); });
$('arr-save').addEventListener('click', async () => {
  if (!_arr) return;
  const song = songsCache.find(s => s.id === _arr.songId); if (!song) return;
  const norm = CE.normalizeArrangement(_arr.items);
  const fresh = { ...song, updatedAt: Date.now() };
  if (!norm.length || CE.isDefaultArrangement(norm, _arr.blocks, _arr.analysis)) delete fresh.arrangement; else fresh.arrangement = norm;
  _arr = null;
  closeOverlay('overlay-arrangement');
  replaceSongInCache(fresh);
  if (currentPage === 'song-view' && currentSongId === fresh.id) renderSongView(fresh);
  showToast(fresh.arrangement ? 'Порядок песни сохранён' : 'Порядок как в тексте');
  await saveSingleSong(fresh);
});
// Перетаскивание частей за ручку
(function () {
  const list = $('arr-list');
  let drag = null;
  list.addEventListener('pointerdown', e => {
    const h = e.target.closest('.arr-handle'); if (!h || !_arr) return;
    const el = h.closest('.arr-item');
    drag = { el, from: +el.dataset.i, y: e.clientY, h: el.offsetHeight + 6 || 50, to: +el.dataset.i };
    el.classList.add('lifted');
    try { h.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  list.addEventListener('pointermove', e => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    drag.el.style.transform = `translateY(${dy}px)`;
    drag.to = Math.max(0, Math.min(_arr.items.length - 1, drag.from + Math.round(dy / drag.h)));
  });
  const end = () => {
    if (!drag) return;
    const d = drag; drag = null;
    d.el.classList.remove('lifted'); d.el.style.transform = '';
    if (d.to !== d.from) _arrApply(a => CE.arrOps.move(a, d.from, d.to));
  };
  list.addEventListener('pointerup', end); list.addEventListener('pointercancel', end);
})();

// ═══════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════
applyTheme(currentTheme());
applyFontSize();
applyDensityMode();
applyGlobalViewMode();
initTelegram();
const _appReady = (async function init() {
  showPage('songs');
  await migrateFromLocalStorage();
  await loadData();
  await checkPendingSongFromBot();
  setTimeout(updateHeaderHeight, 100);
  setTimeout(updateHeaderHeight, 600);
})();
