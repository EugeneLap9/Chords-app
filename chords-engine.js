/*
 * ChordsEngine v2 — ядро режима «Только аккорды» для ChordBook.
 *
 * Модель «квадратов» (одна и та же для авто-анализа, ручной раскладки и AI):
 *   Square = { repeat: N, rows: [ { chords: ['Am','F'], repeat: n } ] }
 *   Квадрат — музыкальная фраза из одной или нескольких строк, играется N раз.
 *   Строка внутри квадрата может сама повторяться n раз (вложенный повтор).
 *
 * Запись раскладки блока (song.chordsOnlyLayout[bi]):
 *   { v: 2, squares: Square[], key: 'k2:припев#1', baseTranspose: 0, baseNotation: null }
 *   - key           — стабильный ключ блока (метка + номер её появления), чтобы
 *                     раскладка не «переезжала» на чужой блок при правке текста;
 *   - baseTranspose — в какой транспозиции записаны аккорды раскладки;
 *   - baseNotation  — 'sharp' | 'flat' | null (как введено).
 *   Нет вложенных массивов → Firestore сохраняет без обёрток.
 *
 * Все операции чистые (возвращают новые объекты) — это делает редактор
 * предсказуемым и покрываемым тестами.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChordsEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ───────────────────────── CHORDS ─────────────────────────
  // Корень + любые валидные «хвосты»: m, maj7, m7b5, 7#9, sus4, add9, 6/9, dim, °, ø, +, (b9), /bass
  var CHORD_RE = /^[A-H](?:#|b)?(?:maj|min|dim|aug|sus|add|alt|M|m|\+|-|°|ø|o(?=\d|$)|\d{1,2}|[#b](?=\d)|\(|\)|,|\/(?=\d))*(?:\/[A-H](?:#|b)?)?$/;
  var NOTES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var NOTES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  var FLAT2SHARP = { Db: 'C#', Eb: 'D#', Fb: 'E', Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B', 'E#': 'F', 'B#': 'C', H: 'B', Hb: 'A#', 'H#': 'C' };

  var KNOWN_BLOCK_WORDS = [
    'verse', 'chorus', 'bridge', 'intro', 'outro', 'interlude', 'solo', 'tag', 'hook', 'breakdown',
    'refrain', 'coda', 'ending', 'prechorus', 'pre-chorus', 'postchorus', 'post-chorus', 'instrumental',
    'куплет', 'припев', 'бридж', 'вступление', 'проигрыш', 'аутро', 'концовка', 'предприпев', 'пре-припев',
    'постприпев', 'пост-припев', 'вступ', 'мост', 'соло', 'повтор', 'тег', 'кода', 'запев', 'речитатив'
  ];

  function isChord(t) {
    if (t == null) return false;
    t = String(t).trim();
    if (!t || t.length > 14) return false;
    return CHORD_RE.test(t);
  }

  function isBlockLabel(text) {
    var t = String(text || '').trim();
    if (!t) return false;
    if (/^[×xхX*]\s*\d{1,2}$/.test(t) || /^\d{1,2}\s*[×xхX]$/.test(t)) return false; // «[х2]» — повтор, не метка
    var lower = t.toLowerCase();
    for (var i = 0; i < KNOWN_BLOCK_WORDS.length; i++) {
      if (lower.indexOf(KNOWN_BLOCK_WORDS[i]) === 0) return true;
    }
    if (isChord(t)) return false;
    if (/\s/.test(t)) return true;               // «Куплет 1», «Verse two»
    if (/[а-яё]/i.test(t)) return t.length >= 2;  // кириллица аккордом быть не может («Хор»)
    return t.length > 3;                          // «Хор», «Coda» (≤3 — скорее опечатка-аккорд)
  }

  function normalizeNote(n) { return FLAT2SHARP[n] || n; }

  function splitRoot(chord) {
    var m = /^([A-H](?:#|b)?)(.*)$/.exec(chord);
    return m ? { root: m[1], rest: m[2] } : null;
  }

  function transposeNote(root, semis, notation) {
    var idx = NOTES_SHARP.indexOf(normalizeNote(root));
    if (idx === -1) return root;
    if (!semis && !notation) return root;
    var n = ((idx + semis) % 12 + 12) % 12;
    var useFlat = notation === 'flat' || (!notation && root.length > 1 && root[1] === 'b' && semis === 0);
    return (useFlat ? NOTES_FLAT : NOTES_SHARP)[n];
  }

  function transposeChord(chord, semis, notation) {
    chord = String(chord);
    semis = semis | 0;
    if (!semis && !notation) return chord;
    var slash = chord.lastIndexOf('/');
    if (slash > 0 && /^[A-H](#|b)?$/.test(chord.slice(slash + 1))) {
      return transposeChord(chord.slice(0, slash), semis, notation) + '/' + transposeNote(chord.slice(slash + 1), semis, notation);
    }
    var p = splitRoot(chord);
    if (!p) return chord;
    return transposeNote(p.root, semis, notation) + p.rest;
  }

  // Ключ сравнения: энгармонизмы равны (A# == Bb, H == B), m == min.
  function chordKey(c) {
    var p = splitRoot(String(c).trim());
    if (!p) return String(c).trim();
    var rest = p.rest.replace(/^min/, 'm');
    var slash = rest.lastIndexOf('/');
    if (slash >= 0 && /^[A-H](#|b)?$/.test(rest.slice(slash + 1))) {
      rest = rest.slice(0, slash) + '/' + normalizeNote(rest.slice(slash + 1));
    }
    return normalizeNote(p.root) + rest;
  }
  function chordEq(a, b) { return chordKey(a) === chordKey(b); }

  // ─────────────────────── LINE PARSING ───────────────────────
  var LINE_REPEAT_RE = /^\(?\s*(?:[×xхX*]\s*(\d{1,2})|(\d{1,2})\s*(?:раз|раза|times|x|х|×))\s*\)?$/i;

  // Строка «Am F C G x4» / «| Am | F |» без скобок → «[Am] [F] [C] [G] x4».
  // null, если в строке есть хоть одно слово, не являющееся аккордом.
  var BARE_REP_RE = /(?:^|\s)\(?\s*(?:[×xхX*]\s*\d{1,2}|\d{1,2}\s*(?:раз|раза|x|х|×))\s*\)?\s*$/i;
  function bareChordLine(line) {
    var t = String(line || '').trim();
    if (!t || t.indexOf('[') !== -1) return null;
    t = t.replace(/[|‖]/g, ' ').replace(/\s[-–—/]+(?=\s)/g, ' ').trim();
    var rep = '';
    var m = BARE_REP_RE.exec(t);
    if (m) { rep = ' ' + m[0].trim().replace(/[()]/g, ''); t = t.slice(0, m.index).trim(); }
    var toks = t.split(/\s+/).filter(Boolean);
    if (!toks.length || !toks.every(isChord)) return null;
    return toks.map(function (c) { return '[' + c + ']'; }).join(' ') + rep;
  }
  // Метка блока без скобок: «Припев:», «1 куплет», «Verse 2:» → «Припев», «1 куплет», «Verse 2»
  var LABEL_WORDS_RE = new RegExp('^(?:\\d+\\s*[-.)]?\\s*)?(?:' + KNOWN_BLOCK_WORDS.map(function (w) { return w.replace(/-/g, '-?'); }).join('|') + ')(?:\\s*\\d+)?\\s*:?\\s*$', 'i');
  function bareLabelLine(line) {
    var t = String(line || '').trim();
    if (!t || t.length > 30 || t.indexOf('[') !== -1 || !LABEL_WORDS_RE.test(t)) return null;
    t = t.replace(/:\s*$/, '').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  // Приводит текст песни к виду со скобками: аккордные строки и метки без скобок понимаются так же
  function normalizeLyrics(text) {
    return String(text || '').replace(/\r/g, '').split('\n').map(function (l) {
      var lab = bareLabelLine(l); if (lab) return '[' + lab + ']';
      var ch = bareChordLine(l); return ch === null ? l : ch;
    }).join('\n');
  }

  // Возвращает { chords: [...], repeat: n, lyric: '...' } для строки исходного текста.
  function parseLine(line) {
    var chords = [];
    String(line || '').replace(/\[([^\]]+)\]/g, function (_, inner) {
      var t = inner.trim();
      if (isChord(t)) chords.push(t);
      return '';
    });
    var lyric = String(line || '').replace(/\[[^\]]+\]/g, '').trim();
    var repeat = 1;
    var m = LINE_REPEAT_RE.exec(lyric);
    if (chords.length && m) { repeat = parseInt(m[1] || m[2], 10) || 1; lyric = ''; }
    return { chords: chords, repeat: Math.max(1, Math.min(99, repeat)), lyric: lyric };
  }

  // Плоская последовательность аккордов блока + индексы начала строк.
  function blockSequence(lines) {
    var seq = [], bounds = [];
    (lines || []).forEach(function (l) {
      var p = parseLine(l);
      if (!p.chords.length) return;
      for (var r = 0; r < p.repeat; r++) { bounds.push(seq.length); seq.push.apply(seq, p.chords); }
    });
    return { seq: seq, bounds: bounds };
  }

  // ─────────────────────── COMPRESSION (DP) ───────────────────────
  // Оптимальная сегментация последовательности на литералы и повторы
  // (минимальная «длина описания»). Работает на ключах — годится и для
  // аккордов, и для целых строк.
  var MAX_PATTERN = 16;
  function compressKeys(keys, boundsArr, opts) {
    var unitPenalty = !(opts && opts.rows);
    var repCost = opts && opts.rows ? 0.5 : 1;
    var n = keys.length;
    var isB = {};
    (boundsArr || []).forEach(function (b) { isB[b] = true; });
    var hasBounds = !!(boundsArr && boundsArr.length);
    function aligned(i) { return !hasBounds || i === 0 || i === n || isB[i]; }
    function same(a, b, L) { for (var t = 0; t < L; t++) if (keys[a + t] !== keys[b + t]) return false; return true; }

    var cost = new Array(n + 1), choice = new Array(n + 1);
    cost[n] = 0;
    for (var i = n - 1; i >= 0; i--) {
      var best = 1 + cost[i + 1], ch = null;
      var maxL = Math.min(MAX_PATTERN, Math.floor((n - i) / 2));
      for (var L = 1; L <= maxL; L++) {
        var k = 1;
        while (i + (k + 1) * L <= n && same(i, i + k * L, L)) k++;
        if (k < 2) continue;
        for (var kk = k; kk >= 2; kk--) {
          var end = i + kk * L;
          var pen = 0.001 * L;
          if (!aligned(i)) pen += 0.35;
          if (!aligned(end)) pen += 0.35;
          if (unitPenalty && L === 1 && kk < 3) pen += 0.6;   // «G G» не схлопываем в «G ×2»
          var c = L + repCost + pen + cost[end];
          if (c < best - 1e-9) { best = c; ch = { L: L, k: kk }; }
        }
      }
      cost[i] = best; choice[i] = ch;
    }
    var pieces = [], pos = 0, litStart = -1;
    while (pos < n) {
      var c2 = choice[pos];
      if (!c2) { if (litStart < 0) litStart = pos; pos++; continue; }
      if (litStart >= 0) { pieces.push({ type: 'lit', start: litStart, len: pos - litStart }); litStart = -1; }
      pieces.push({ type: 'rep', start: pos, len: c2.L, k: c2.k });
      pos += c2.L * c2.k;
    }
    if (litStart >= 0) pieces.push({ type: 'lit', start: litStart, len: n - litStart });
    return pieces;
  }

  function chunk(arr, size) { var out = []; for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }

  // Разбивка фразы на визуальные строки: по исходным переносам, но
  // «по аккорду на строку» склеиваем в строки по 4 (типичный квадрат).
  function splitRows(chords, relBounds) {
    if (!chords.length) return [];
    var cuts = (relBounds || []).filter(function (b) { return b > 0 && b < chords.length; }).sort(function (a, b) { return a - b; });
    var segs = [], prev = 0;
    cuts.forEach(function (c) { if (c > prev) { segs.push(chords.slice(prev, c)); prev = c; } });
    segs.push(chords.slice(prev));
    if (segs.length === 1) return chords.length > 8 ? chunk(chords, 4) : [chords];
    var allShort = segs.every(function (s) { return s.length <= 2; });
    if (allShort && chords.length >= 3) return chunk(chords, 4);
    var out = [];
    segs.forEach(function (s) { if (s.length > 8) out.push.apply(out, chunk(s, 4)); else out.push(s); });
    return out;
  }

  function relBounds(bounds, start, len) {
    return bounds.filter(function (b) { return b > start && b < start + len; }).map(function (b) { return b - start; });
  }

  // Главный анализатор блока: строки текста → квадраты.
  function analyzeBlock(lines) {
    var bs = blockSequence(lines);
    return analyzeSequence(bs.seq, bs.bounds);
  }

  function analyzeSequence(seq, bounds) {
    if (!seq.length) return [];
    var keys = seq.map(chordKey);
    var pieces = compressKeys(keys, bounds);
    var squares = [];
    pieces.forEach(function (p) {
      var part = seq.slice(p.start, p.start + p.len);
      var rb = relBounds(bounds, p.start, p.len);
      if (p.type === 'lit') {
        squares.push({ repeat: 1, rows: splitRows(part, rb).map(function (c) { return { chords: c, repeat: 1 }; }) });
        return;
      }
      // Повтор: внутри фразы ищем вложенные повторы (например (Am F)×2 C G)
      var inner = part.length >= 3 ? compressKeys(part.map(chordKey), rb) : [];
      var rows = [];
      if (inner.some(function (q) { return q.type === 'rep'; })) {
        inner.forEach(function (q) {
          var sub = part.slice(q.start, q.start + q.len);
          if (q.type === 'rep') rows.push({ chords: sub, repeat: q.k });
          else splitRows(sub, relBounds(rb, q.start, q.len)).forEach(function (c) { rows.push({ chords: c, repeat: 1 }); });
        });
      } else {
        rows = splitRows(part, rb).map(function (c) { return { chords: c, repeat: 1 }; });
      }
      squares.push({ repeat: p.k, rows: rows });
    });
    return normalizeSquares(squares);
  }

  // Строки (массивы аккордов) → квадраты; ищет повторы групп строк (A|B)×2.
  function squaresFromRows(rows) {
    rows = (rows || []).map(toChordArray).filter(function (r) { return r.length; });
    if (!rows.length) return [];
    var keys = rows.map(function (r) { return r.map(chordKey).join(' '); });
    var pieces = compressKeys(keys, null, { rows: true });
    var squares = [], litRows = [];
    function flushLit() { if (litRows.length) { squares.push({ repeat: 1, rows: litRows.map(function (r) { return { chords: r, repeat: 1 }; }) }); litRows = []; } }
    pieces.forEach(function (p) {
      var part = rows.slice(p.start, p.start + p.len);
      if (p.type === 'lit') { litRows.push.apply(litRows, part); return; }
      flushLit();
      var inner = part.length >= 2 ? compressKeys(part.map(function (r) { return r.map(chordKey).join(' '); }), null, { rows: true }) : [];
      var outRows = [];
      inner.forEach(function (q) {
        var sub = part.slice(q.start, q.start + q.len);
        if (q.type === 'rep' && q.len === 1) outRows.push({ chords: sub[0], repeat: q.k });
        else {
          // многострочный вложенный повтор — третий уровень не поддерживаем, разворачиваем
          var times = q.type === 'rep' ? q.k : 1;
          for (var t = 0; t < times; t++) sub.forEach(function (r) { outRows.push({ chords: r, repeat: 1 }); });
        }
      });
      if (!inner.length) outRows = part.map(function (r) { return { chords: r, repeat: 1 }; });
      squares.push({ repeat: p.k, rows: outRows });
    });
    flushLit();
    return normalizeSquares(squares);
  }

  // ─────────────────────── MODEL HELPERS ───────────────────────
  function toChordArray(r) {
    if (Array.isArray(r)) return r.map(function (c) { return String(c).trim(); }).filter(Boolean);
    if (r && Array.isArray(r.chords)) return toChordArray(r.chords);
    if (r && Array.isArray(r.__nestedArray)) return toChordArray(r.__nestedArray);
    if (typeof r === 'string') return r.trim().split(/\s+/).filter(Boolean);
    return [];
  }
  function clampRep(n) { n = parseInt(n, 10); return isFinite(n) && n >= 1 ? Math.min(99, n) : 1; }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  // Чистит модель: пустые строки/квадраты убирает, повторы → целые 1..99,
  // квадрат из одной строки: repeat строки «поднимается» в repeat квадрата.
  function normalizeSquares(squares) {
    var out = [];
    (squares || []).forEach(function (sq) {
      if (!sq) return;
      var rows = (sq.rows || []).map(function (r) {
        return { chords: toChordArray(r), repeat: clampRep(r && r.repeat) };
      }).filter(function (r) { return r.chords.length; });
      if (!rows.length) return;
      var rep = clampRep(sq.repeat);
      if (rows.length === 1 && rows[0].repeat > 1) { rep = Math.min(99, rep * rows[0].repeat); rows[0].repeat = 1; }
      out.push({ repeat: rep, rows: rows });
    });
    return out;
  }

  function expandSquares(squares) {
    var flat = [];
    (squares || []).forEach(function (sq) {
      for (var a = 0; a < clampRep(sq.repeat); a++) {
        sq.rows.forEach(function (r) { for (var b = 0; b < clampRep(r.repeat); b++) flat.push.apply(flat, r.chords); });
      }
    });
    return flat;
  }

  // Приводит любую сохранённую запись (v1 {rows,mult}, AI {rows}, v2) к v2.
  function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    var squares;
    if (Array.isArray(entry.squares)) squares = normalizeSquares(entry.squares);
    else if (Array.isArray(entry.rows)) {
      var mult = Array.isArray(entry.mult) ? entry.mult : [];
      squares = normalizeSquares(entry.rows.map(function (r, i) {
        return { repeat: clampRep(mult[i]), rows: [{ chords: toChordArray(r), repeat: 1 }] };
      }));
    } else return null;
    return {
      v: 2,
      squares: squares,
      key: typeof entry.key === 'string' ? entry.key : null,
      baseTranspose: entry.baseTranspose | 0,
      baseNotation: entry.baseNotation === 'flat' || entry.baseNotation === 'sharp' ? entry.baseNotation : null
    };
  }

  function makeEntry(squares, key, baseTranspose, baseNotation) {
    return { v: 2, squares: normalizeSquares(squares), key: key || null, baseTranspose: baseTranspose | 0, baseNotation: baseNotation || null };
  }

  function transposeSquares(squares, semis, notation) {
    return (squares || []).map(function (sq) {
      return { repeat: sq.repeat, rows: sq.rows.map(function (r) {
        return { chords: r.chords.map(function (c) { return transposeChord(c, semis, notation); }), repeat: r.repeat };
      }) };
    });
  }

  // Квадраты записи в текущей транспозиции песни (относительно baseTranspose).
  function entrySquaresAt(entry, transpose, notation) {
    var e = normalizeEntry(entry);
    if (!e) return [];
    var delta = (transpose | 0) - e.baseTranspose;
    if (!delta && !notation) return e.squares;
    return transposeSquares(e.squares, delta, notation);
  }

  // ─────────────────────── BLOCK KEYS / LAYOUT ───────────────────────
  function baseLabel(label) { return String(label || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  function genericLabel(label) {
    return baseLabel(label).replace(/\b(i{1,3}|iv|vi{0,3}|ix|\d+)\b/g, '').replace(/[\s\-_.:]+/g, ' ').trim();
  }
  function blockKeys(blocks) {
    var counts = {};
    return (blocks || []).map(function (b) {
      var base = baseLabel(b && b.label);
      counts[base] = (counts[base] || 0) + 1;
      return 'k2:' + base + '#' + counts[base];
    });
  }
  function isV2Key(k) { return typeof k === 'string' && k.indexOf('k2:') === 0; }

  // { [bi]: entry } → { [bi]: normalizedEntry } для текущих блоков:
  // сначала по стабильному ключу, легаси-записи без ключа — по индексу.
  function resolveLayout(layout, blocks) {
    var res = {};
    if (!layout || typeof layout !== 'object') return res;
    var keys = blockKeys(blocks);
    var used = {};
    Object.keys(layout).forEach(function (k) {
      var e = normalizeEntry(layout[k]);
      if (!e || !isV2Key(e.key)) return;
      var bi = keys.indexOf(e.key);
      if (bi >= 0 && !used[bi]) { res[bi] = e; used[bi] = true; }
    });
    Object.keys(layout).forEach(function (k) {
      var e = normalizeEntry(layout[k]);
      if (!e || isV2Key(e.key)) return;
      var bi = parseInt(k, 10);
      if (isFinite(bi) && bi >= 0 && bi < keys.length && !used[bi]) { e.key = keys[bi]; res[bi] = e; used[bi] = true; }
    });
    return res;
  }

  // Перенос раскладки после правки текста песни (блоки могли добавиться/удалиться/переставиться).
  function remapLayout(layout, oldBlocks, newBlocks) {
    var resolvedOld = resolveLayout(layout, oldBlocks);
    var newKeys = blockKeys(newBlocks);
    var out = {};
    Object.keys(resolvedOld).forEach(function (bi) {
      var e = resolvedOld[bi];
      var ni = newKeys.indexOf(e.key);
      if (ni >= 0 && !out[ni]) out[ni] = e;
    });
    return out;
  }

  // Убирает из раскладки пустые записи; возвращает null если пусто (не хранить пустой объект).
  function compactLayout(layout) {
    var out = {}, any = false;
    Object.keys(layout || {}).forEach(function (k) {
      var e = normalizeEntry(layout[k]);
      if (e && e.squares.length) { out[k] = e; any = true; }
    });
    return any ? out : null;
  }

  // ─────────────────────── TEXT FORMAT ───────────────────────
  // Блок:  [Припев]
  //        Am F C G ×4                — квадрат из одной строки, 4 раза
  //        (Am F ×2 | C G) ×2         — квадрат из двух строк, 2 раза; первая строка ×2 внутри
  //        (                           — многострочная запись группы
  //        Em C
  //        G D
  //        ) ×2
  var REP_TAIL_RE = /(?:^|\s)(?:[×xXхХ*]\s*(\d{1,2})|(\d{1,2})\s*[×xXхХ])\s*$/;
  var REP_GLUED_RE = /([A-H][^\s]*?)[×*](\d{1,2})$/;

  function parseRowText(s, invalid) {
    s = String(s || '').replace(/\|/g, ' ').trim();
    var rep = 1;
    var m = REP_TAIL_RE.exec(s);
    if (m) { rep = clampRep(m[1] || m[2]); s = s.slice(0, m.index).trim(); }
    else {
      var g = REP_GLUED_RE.exec(s);
      if (g) { rep = clampRep(g[2]); s = s.slice(0, g.index) + g[1]; }
    }
    var chords = [];
    s.split(/\s+/).filter(Boolean).forEach(function (t) {
      t = t.replace(/^[\[(]+|[\])]+$/g, '').replace(/,$/, '');
      if (!t || t === '-' || t === '–' || t === '%' ) return;
      if (isChord(t)) chords.push(t); else if (invalid) invalid.push(t);
    });
    return { chords: chords, repeat: rep };
  }

  function parseSquaresText(text, invalid) {
    var lines = String(text || '').split('\n');
    var squares = [];
    var group = null;
    lines.forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      if (group) {
        var close = /^(.*)\)\s*(?:[×xXхХ*]\s*(\d{1,2}))?\s*$/.exec(line);
        if (close) {
          if (close[1].trim()) close[1].split('|').forEach(function (p) { if (p.trim()) group.rows.push(parseRowText(p, invalid)); });
          group.repeat = clampRep(close[2]);
          squares.push(group); group = null;
        } else line.split('|').forEach(function (p) { if (p.trim()) group.rows.push(parseRowText(p, invalid)); });
        return;
      }
      var inline = /^\((.*)\)\s*(?:[×xXхХ*]\s*(\d{1,2}))?\s*$/.exec(line);
      if (inline) {
        squares.push({ repeat: clampRep(inline[2]), rows: inline[1].split('|').filter(function (p) { return p.trim(); }).map(function (p) { return parseRowText(p, invalid); }) });
        return;
      }
      if (line[0] === '(') {
        group = { repeat: 1, rows: [] };
        var rest = line.slice(1).trim();
        if (rest) rest.split('|').forEach(function (p) { if (p.trim()) group.rows.push(parseRowText(p, invalid)); });
        return;
      }
      var row = parseRowText(line, invalid);
      squares.push({ repeat: row.repeat, rows: [{ chords: row.chords, repeat: 1 }] });
    });
    if (group) squares.push(group); // незакрытая скобка — прощаем
    return normalizeSquares(squares);
  }

  function rowToText(r) { return r.chords.join(' ') + (r.repeat > 1 ? ' ×' + r.repeat : ''); }
  function squaresToText(squares) {
    return normalizeSquares(squares).map(function (sq) {
      if (sq.rows.length === 1) return rowToText(sq.rows[0]) + (sq.repeat > 1 ? ' ×' + sq.repeat : '');
      // Не повторяющийся квадрат без вложенных повторов — просто строки (читабельнее)
      if (sq.repeat === 1) return sq.rows.map(rowToText).join('\n');
      return '(' + sq.rows.map(rowToText).join(' | ') + ')' + (sq.repeat > 1 ? ' ×' + sq.repeat : '');
    }).join('\n');
  }

  // Полный текст «только аккорды» → [{label, squares}]
  function parseChordsOnlyText(text) {
    var out = [], cur = null, buf = [], invalid = [];
    function flush() { if (cur) { cur.squares = parseSquaresText(buf.join('\n'), invalid); out.push(cur); } buf = []; }
    String(text || '').replace(/\r/g, '').split('\n').forEach(function (line) {
      var m = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (m && !isChord(m[1].trim())) { flush(); cur = { label: m[1].trim() }; return; }
      if (!cur) { if (!line.trim()) return; cur = { label: '' }; }
      buf.push(line);
    });
    flush();
    out.invalid = invalid;
    return out;
  }

  // Сопоставление по метке и порядку появления метки: 2-й [Припев] → 2-й [Припев].
  function buildLayoutFromText(parsed, blocks, baseTranspose, baseNotation) {
    var keys = blockKeys(blocks);
    var layout = {}, unmatched = [], seen = {};
    (parsed || []).forEach(function (pb) {
      var base = baseLabel(pb.label);
      seen[base] = (seen[base] || 0) + 1;
      var key = 'k2:' + base + '#' + seen[base];
      var bi = keys.indexOf(key);
      if (bi < 0 && !base) {
        bi = (blocks || []).findIndex(function (b) { return !baseLabel(b.label); });
      }
      if (bi < 0) { unmatched.push(pb.label || '(без метки)'); return; }
      if (!pb.squares.length) return;
      layout[bi] = makeEntry(pb.squares, keys[bi], baseTranspose, baseNotation);
    });
    return { layout: layout, unmatched: unmatched, invalid: parsed && parsed.invalid ? parsed.invalid : [] };
  }

  // Раскладка → текст (в оригинальной тональности: transpose 0).
  function layoutToText(layout, blocks) {
    var res = resolveLayout(layout, blocks);
    return Object.keys(res).map(Number).sort(function (a, b) { return a - b; }).map(function (bi) {
      var sq = entrySquaresAt(res[bi], 0, res[bi].baseNotation);
      var label = blocks[bi] && blocks[bi].label ? '[' + blocks[bi].label + ']\n' : '';
      return label + squaresToText(sq);
    }).join('\n\n');
  }

  // ─────────────────────── SONG ANALYSIS ───────────────────────
  // blocks: [{label, lines}] (как из parseSong). layout — song.chordsOnlyLayout.
  // Результат на каждый блок: { bi, label, squares, manual, repeatOf, sig }
  function analyzeSong(blocks, layout, transpose, notation) {
    var resolved = resolveLayout(layout, blocks);
    var out = [];
    (blocks || []).forEach(function (b, bi) {
      var manual = !!resolved[bi];
      var squares = manual ? entrySquaresAt(resolved[bi], transpose, notation) : analyzeBlock(b.lines);
      var sig = expandSquares(squares).map(chordKey).join(' ');
      var repeatOf = null;
      if (sig) {
        for (var j = out.length - 1; j >= 0; j--) {
          if (out[j].sig === sig && genericLabel(out[j].label) === genericLabel(b.label)) { repeatOf = out[j].repeatOf != null ? out[j].repeatOf : out[j].bi; break; }
        }
      }
      out.push({ bi: bi, label: b.label || '', squares: squares, manual: manual, repeatOf: repeatOf, sig: sig });
    });
    return out;
  }

  // Форма песни: [{label, count, bi}] — подряд идущие одинаковые блоки склеены (×N).
  function songForm(analysis) {
    var form = [];
    (analysis || []).forEach(function (a) {
      if (!a.label && !a.sig) return;
      var last = form[form.length - 1];
      if (last && last.sig === a.sig && genericLabel(last.label) === genericLabel(a.label) && a.sig) { last.count++; return; }
      form.push({ label: a.label || '—', count: 1, bi: a.bi, sig: a.sig });
    });
    return form;
  }


  // ─────────────────────── ARRANGEMENT (порядок песни) ───────────────────────
  // song.arrangement = [{ ref: 'k2:припев#1', repeat: 2 }, ...]
  // ref — ключ «оригинального» блока (повторный припев с теми же аккордами
  // ссылается на первый). null/пусто = порядок как в тексте.
  function normalizeArrangement(arr) {
    var out = [];
    (Array.isArray(arr) ? arr : []).forEach(function (it) {
      if (!it || typeof it.ref !== 'string' || !it.ref) return;
      var rep = clampRep(it.repeat);
      var last = out[out.length - 1];
      if (last && last.ref === it.ref) last.repeat = Math.min(99, last.repeat + rep);
      else out.push({ ref: it.ref, repeat: rep });
    });
    return out;
  }
  function defaultArrangement(blocks, analysis) {
    var keys = blockKeys(blocks), out = [];
    var lastA = null;
    (analysis || []).forEach(function (a) {
      if (!a.sig) return; // блоки только со словами в режиме «Аккорды» не играются
      if (lastA && lastA.sig === a.sig && genericLabel(lastA.label) === genericLabel(a.label)) { out[out.length - 1].repeat++; return; }
      out.push({ ref: keys[a.bi], repeat: 1 });
      lastA = a;
    });
    return out;
  }
  // → [{ bi, ref, repeat }] только существующие части; пусто → порядок по тексту
  function resolveArrangement(arr, blocks, analysis) {
    var keys = blockKeys(blocks);
    var src = normalizeArrangement(arr);
    var res = [];
    src.forEach(function (it) { var bi = keys.indexOf(it.ref); if (bi >= 0) res.push({ bi: bi, ref: it.ref, repeat: it.repeat }); });
    if (!res.length) {
      return defaultArrangement(blocks, analysis).map(function (it) { return { bi: keys.indexOf(it.ref), ref: it.ref, repeat: it.repeat }; });
    }
    return res;
  }
  function isDefaultArrangement(arr, blocks, analysis) {
    return JSON.stringify(normalizeArrangement(arr)) === JSON.stringify(defaultArrangement(blocks, analysis));
  }
  // Части, из которых можно собирать порядок (без дублей-повторов)
  function uniqueParts(blocks, analysis) {
    var keys = blockKeys(blocks);
    return (analysis || []).filter(function (a) { return a.sig && a.repeatOf == null; })
      .map(function (a) { return { bi: a.bi, ref: keys[a.bi], label: a.label || 'Без метки' }; });
  }
  // После правки текста: ссылки на исчезнувшие блоки отбрасываются;
  // mapping (необязательно) — явное переименование { oldKey: newKey }.
  function remapArrangement(arr, newBlocks, mapping) {
    if (!Array.isArray(arr) || !arr.length) return null;
    var keys = blockKeys(newBlocks);
    var out = normalizeArrangement(arr.map(function (it) {
      var ref = mapping && Object.prototype.hasOwnProperty.call(mapping, it.ref) ? mapping[it.ref] : it.ref;
      return { ref: ref, repeat: it.repeat };
    }).filter(function (it) { return it.ref && keys.indexOf(it.ref) >= 0; }));
    return out.length ? out : null;
  }
  var arrOps = {
    move: function (arr, from, to) {
      var a = clone(arr); if (from < 0 || from >= a.length) return normalizeArrangement(a);
      to = Math.max(0, Math.min(a.length - 1, to));
      var it = a.splice(from, 1)[0]; a.splice(to, 0, it);
      return a; // без склейки: пользователь видит ровно то, что двигал
    },
    setRepeat: function (arr, i, n) { var a = clone(arr); if (a[i]) a[i].repeat = clampRep(n); return a; },
    remove: function (arr, i) { var a = clone(arr); a.splice(i, 1); return a; },
    insert: function (arr, at, ref) {
      var a = clone(arr); var i = at == null ? a.length : Math.max(0, Math.min(at, a.length));
      a.splice(i, 0, { ref: ref, repeat: 1 }); return a;
    },
    duplicate: function (arr, i) { var a = clone(arr); if (a[i]) a.splice(i + 1, 0, clone(a[i])); return a; }
  };

  // ─────────────────────── SONG CHART (краткий вид) ───────────────────────
  // Разные квадраты песни получают буквы A, B, C… (по первому появлению),
  // каждая часть — последовательность букв с повторами: «Куплет 1: A ×2 B».
  function squareSig(sq) {
    return sq.rows.map(function (r) { return r.chords.map(chordKey).join(' ') + (r.repeat > 1 ? '*' + r.repeat : ''); }).join('|');
  }
  // Номер квадрата римскими цифрами: 0 → I, 1 → II, 3 → IV, 8 → IX …
  function romanName(i) {
    var n = i + 1, out = '';
    [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
      .forEach(function (p) { while (n >= p[0]) { out += p[1]; n -= p[0]; } });
    return out;
  }
  function songChart(analysis, items) {
    var bySig = {}, colorBySig = {}, patterns = [];
    function letterOf(sq) {
      var k = squareSig(sq);
      if (!bySig[k]) {
        var idx = patterns.length;
        bySig[k] = romanName(idx); colorBySig[k] = idx % 8;
        patterns.push({ letter: bySig[k], color: idx % 8, sig: k, square: { repeat: 1, rows: clone(sq.rows) }, uses: 0 });
      }
      return bySig[k];
    }
    var sections = [];
    (items || []).forEach(function (it, i) {
      var a = analysis[it.bi]; if (!a || !a.squares.length) return;
      var seq = [];
      a.squares.forEach(function (sq) {
        var L = letterOf(sq), last = seq[seq.length - 1];
        patterns.forEach(function (p) { if (p.letter === L) p.uses += sq.repeat * (it.repeat || 1); });
        if (last && last.letter === L) last.repeat += sq.repeat; else seq.push({ letter: L, repeat: sq.repeat });
      });
      seq.forEach(function (x) { x.color = patterns.filter(function (p) { return p.letter === x.letter; })[0].color; });
      sections.push({ item: i, bi: it.bi, label: a.label || '', repeat: it.repeat || 1, seq: seq });
    });
    return { patterns: patterns, sections: sections, letters: bySig, colors: colorBySig };
  }

  // ─────────────────────── EDITOR OPS (pure) ───────────────────────
  // Путь аккорда: {si, ri, ci}. Все операции возвращают новые квадраты.
  function rowAt(sq, si, ri) { return sq[si] && sq[si].rows[ri]; }

  function setChord(squares, p, val) {
    var s = clone(squares); var r = rowAt(s, p.si, p.ri);
    if (r && p.ci >= 0 && p.ci < r.chords.length && String(val).trim()) r.chords[p.ci] = String(val).trim();
    return normalizeSquares(s);
  }
  function insertChord(squares, p, val) {
    var s = clone(squares);
    if (!String(val || '').trim()) return normalizeSquares(s);
    if (!s.length) { s.push({ repeat: 1, rows: [{ chords: [String(val).trim()], repeat: 1 }] }); return normalizeSquares(s); }
    var sq = s[Math.max(0, Math.min(p.si, s.length - 1))];
    var r = sq.rows[Math.max(0, Math.min(p.ri, sq.rows.length - 1))];
    var ci = p.ci == null ? r.chords.length : Math.max(0, Math.min(p.ci, r.chords.length));
    r.chords.splice(ci, 0, String(val).trim());
    return normalizeSquares(s);
  }
  function removeChord(squares, p) {
    var s = clone(squares); var r = rowAt(s, p.si, p.ri);
    if (r && p.ci >= 0 && p.ci < r.chords.length) r.chords.splice(p.ci, 1);
    return normalizeSquares(s);
  }
  // to.ci — позиция вставки ДО удаления исходного аккорда.
  function moveChord(squares, from, to) {
    var s = clone(squares);
    var src = rowAt(s, from.si, from.ri);
    if (!src || from.ci < 0 || from.ci >= src.chords.length) return normalizeSquares(s);
    var dst = rowAt(s, to.si, to.ri);
    if (!dst) return normalizeSquares(s);
    var chord = src.chords.splice(from.ci, 1)[0];
    var ci = to.ci == null ? dst.chords.length : to.ci;
    if (src === dst && ci > from.ci) ci--;
    ci = Math.max(0, Math.min(ci, dst.chords.length));
    dst.chords.splice(ci, 0, chord);
    return normalizeSquares(s);
  }
  function moveChordAcross(srcSquares, from, dstSquares, to) {
    var src = clone(srcSquares), dst = clone(dstSquares);
    var r = rowAt(src, from.si, from.ri);
    if (!r || from.ci < 0 || from.ci >= r.chords.length) return { src: normalizeSquares(src), dst: normalizeSquares(dst) };
    var chord = r.chords.splice(from.ci, 1)[0];
    return { src: normalizeSquares(src), dst: insertChord(dst, to, chord) };
  }
  // Сдвиг аккорда на 1 позицию влево/вправо; на краю строки — в соседнюю строку.
  function shiftChord(squares, p, dir) {
    var s = clone(squares); var r = rowAt(s, p.si, p.ri);
    if (!r) return { squares: normalizeSquares(s), pos: p };
    var ni = p.ci + dir;
    if (ni >= 0 && ni < r.chords.length) {
      var t = r.chords[p.ci]; r.chords[p.ci] = r.chords[ni]; r.chords[ni] = t;
      return { squares: normalizeSquares(s), pos: { si: p.si, ri: p.ri, ci: ni } };
    }
    // на соседнюю строку (в т.ч. соседний квадрат)
    var flatRows = [];
    s.forEach(function (sq, si) { sq.rows.forEach(function (row, ri) { flatRows.push({ si: si, ri: ri }); }); });
    var idx = flatRows.findIndex(function (f) { return f.si === p.si && f.ri === p.ri; });
    var target = flatRows[idx + dir];
    if (!target || r.chords.length < 2) return { squares: normalizeSquares(s), pos: p };
    var chord = r.chords.splice(p.ci, 1)[0];
    var tr = s[target.si].rows[target.ri];
    if (dir > 0) tr.chords.unshift(chord); else tr.chords.push(chord);
    return { squares: normalizeSquares(s), pos: { si: target.si, ri: target.ri, ci: dir > 0 ? 0 : tr.chords.length - 1 } };
  }
  // Разрезать строку перед ci → новая строка в том же квадрате.
  function splitRow(squares, p) {
    var s = clone(squares); var sq = s[p.si]; var r = rowAt(s, p.si, p.ri);
    if (!r || p.ci <= 0 || p.ci >= r.chords.length) return normalizeSquares(s);
    var tail = r.chords.splice(p.ci);
    sq.rows.splice(p.ri + 1, 0, { chords: tail, repeat: 1 });
    return normalizeSquares(s);
  }
  function mergeRowUp(squares, si, ri) {
    var s = clone(squares); var sq = s[si];
    if (!sq || ri <= 0 || !sq.rows[ri]) return normalizeSquares(s);
    sq.rows[ri - 1].chords = sq.rows[ri - 1].chords.concat(sq.rows[ri].chords);
    sq.rows.splice(ri, 1);
    return normalizeSquares(s);
  }
  function addRow(squares, si, chords) {
    var s = clone(squares);
    if (!s[si]) { s.push({ repeat: 1, rows: [] }); si = s.length - 1; }
    s[si].rows.push({ chords: toChordArray(chords), repeat: 1 });
    return normalizeSquares(s);
  }
  function addSquare(squares, at, chords) {
    var s = clone(squares);
    var i = at == null ? s.length : Math.max(0, Math.min(at, s.length));
    s.splice(i, 0, { repeat: 1, rows: [{ chords: toChordArray(chords), repeat: 1 }] });
    return normalizeSquares(s);
  }
  function deleteSquare(squares, si) { var s = clone(squares); s.splice(si, 1); return normalizeSquares(s); }
  function duplicateSquare(squares, si) { var s = clone(squares); if (s[si]) s.splice(si + 1, 0, clone(s[si])); return normalizeSquares(s); }
  function setSquareRepeat(squares, si, n) { var s = clone(squares); if (s[si]) s[si].repeat = clampRep(n); return normalizeSquares(s); }
  function setRowRepeat(squares, si, ri, n) {
    var s = clone(squares); var r = rowAt(s, si, ri);
    if (r) {
      if (s[si].rows.length === 1) s[si].repeat = clampRep(n); else r.repeat = clampRep(n);
    }
    return normalizeSquares(s);
  }
  // Отделить строки начиная с ri в отдельный квадрат.
  function splitSquare(squares, si, ri) {
    var s = clone(squares); var sq = s[si];
    if (!sq || ri <= 0 || ri >= sq.rows.length) return normalizeSquares(s);
    if (sq.repeat > 1) { // повторяющуюся группу сначала разворачиваем, чтобы звучание не изменилось
      var unrolled = [];
      for (var i = 0; i < sq.repeat; i++) unrolled.push.apply(unrolled, clone(sq.rows));
      sq.rows = unrolled; sq.repeat = 1;
    }
    var tail = sq.rows.splice(ri);
    s.splice(si + 1, 0, { repeat: 1, rows: tail });
    return normalizeSquares(s);
  }
  function mergeSquareDown(squares, si) {
    var s = clone(squares);
    if (!s[si] || !s[si + 1]) return normalizeSquares(s);
    var a = s[si], b = s[si + 1];
    var rows = [];
    for (var i = 0; i < a.repeat; i++) rows.push.apply(rows, clone(a.rows));
    var brows = [];
    for (var j = 0; j < b.repeat; j++) brows.push.apply(brows, clone(b.rows));
    s.splice(si, 2, { repeat: 1, rows: rows.concat(brows) });
    return normalizeSquares(s);
  }
  // Повторный авто-анализ того, что пользователь уже набрал (не меняя звучание).
  function recompress(squares) {
    var flat = expandSquares(squares);
    return analyzeSequence(flat, []);
  }

  // ─────────────────────── MUSIC HELPERS ───────────────────────
  var FLAT_KEYS = { F: 1, Bb: 1, Eb: 1, Ab: 1, Db: 1, Gb: 1, Dm: 1, Gm: 1, Cm: 1, Fm: 1, Bbm: 1, Ebm: 1, 'A#': 1, 'D#': 1, 'G#': 1 };
  function preferredNotation(key) { return FLAT_KEYS[key] ? 'flat' : 'sharp'; }
  function diatonicChords(key, notation) {
    var p = splitRoot(String(key || 'C'));
    if (!p) return [];
    var minor = /^m(?!aj)/.test(p.rest);
    var root = NOTES_SHARP.indexOf(normalizeNote(p.root));
    if (root < 0) return [];
    var nt = notation || preferredNotation(key);
    var names = nt === 'flat' ? NOTES_FLAT : NOTES_SHARP;
    var steps = minor ? [[0, 'm'], [3, ''], [5, 'm'], [7, 'm'], [7, ''], [8, ''], [10, ''], [7, '7']]
                      : [[0, ''], [2, 'm'], [4, 'm'], [5, ''], [7, ''], [9, 'm'], [7, '7'], [10, '']];
    var seen = {}, out = [];
    steps.forEach(function (st) { var c = names[(root + st[0]) % 12] + st[1]; if (!seen[c]) { seen[c] = 1; out.push(c); } });
    return out;
  }

  // ─────────────────────── RENDER ───────────────────────
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Аккорд: корень (+m) крупно, расширения (7, sus4, maj7…) — индексом, бас — как есть
  function chordHtml(c) {
    var m = /^([A-H](?:#|b)?(?:m(?!aj))?)(.*?)(\/[A-H](?:#|b)?)?$/.exec(c);
    if (!m || !m[2]) return esc(c);
    return esc(m[1]) + '<sub>' + esc(m[2]) + '</sub>' + (m[3] ? esc(m[3]) : '');
  }
  // Квадрат = такты с тактовыми чертами; повтор — реприза и крупное ×N
  function squaresToHtml(squares, opts) {
    var letters = opts && opts.letters, colors = (opts && opts.colors) || {};
    return (squares || []).map(function (sq, si) {
      var cols = 1;
      sq.rows.forEach(function (r) { cols = Math.max(cols, r.chords.length); });
      var multi = sq.rows.length > 1;
      var rows = sq.rows.map(function (r) {
        return '<div class="cs-row">' + r.chords.map(function (c) { return '<span class="chord-badge cs-bar">' + chordHtml(c) + '</span>'; }).join('') +
          (r.repeat > 1 ? '<span class="cs-row-rep">×' + r.repeat + '</span>' : '') + '</div>';
      }).join('');
      var sig = squareSig(sq), letter = letters ? letters[sig] : '';
      return '<div class="cs-square' + (multi ? ' cs-multi' : '') + (sq.repeat > 1 ? ' cs-repeated' : '') + '" data-si="' + si + '">' +
        (letter ? '<span class="cs-letter" data-c="' + (colors[sig] != null ? colors[sig] : 0) + '" title="Квадрат ' + letter + '">' + letter + '</span>' : '') +
        '<div class="cs-rows" style="--cols:' + cols + '">' + rows + '</div>' +
        (sq.repeat > 1 ? '<div class="cs-rep">×' + sq.repeat + '</div>' : '') + '</div>';
    }).join('');
  }

  return {
    CHORD_RE: CHORD_RE, NOTES_SHARP: NOTES_SHARP, NOTES_FLAT: NOTES_FLAT,
    isChord: isChord, isBlockLabel: isBlockLabel, normalizeNote: normalizeNote,
    bareChordLine: bareChordLine, bareLabelLine: bareLabelLine, normalizeLyrics: normalizeLyrics,
    squareSig: squareSig, songChart: songChart, romanName: romanName,
    transposeChord: transposeChord, chordKey: chordKey, chordEq: chordEq,
    parseLine: parseLine, blockSequence: blockSequence, compressKeys: compressKeys, splitRows: splitRows,
    analyzeBlock: analyzeBlock, analyzeSequence: analyzeSequence, squaresFromRows: squaresFromRows,
    normalizeSquares: normalizeSquares, expandSquares: expandSquares, normalizeEntry: normalizeEntry,
    makeEntry: makeEntry, transposeSquares: transposeSquares, entrySquaresAt: entrySquaresAt,
    baseLabel: baseLabel, genericLabel: genericLabel, blockKeys: blockKeys,
    resolveLayout: resolveLayout, remapLayout: remapLayout, compactLayout: compactLayout,
    parseSquaresText: parseSquaresText, squaresToText: squaresToText,
    parseChordsOnlyText: parseChordsOnlyText, buildLayoutFromText: buildLayoutFromText, layoutToText: layoutToText,
    analyzeSong: analyzeSong, songForm: songForm,
    ops: {
      setChord: setChord, insertChord: insertChord, removeChord: removeChord, moveChord: moveChord,
      moveChordAcross: moveChordAcross, shiftChord: shiftChord, splitRow: splitRow, mergeRowUp: mergeRowUp,
      addRow: addRow, addSquare: addSquare, deleteSquare: deleteSquare, duplicateSquare: duplicateSquare,
      setSquareRepeat: setSquareRepeat, setRowRepeat: setRowRepeat, splitSquare: splitSquare,
      mergeSquareDown: mergeSquareDown, recompress: recompress
    },
    normalizeArrangement: normalizeArrangement, defaultArrangement: defaultArrangement, resolveArrangement: resolveArrangement,
    isDefaultArrangement: isDefaultArrangement, uniqueParts: uniqueParts, remapArrangement: remapArrangement, arrOps: arrOps,
    chordHtml: chordHtml,
    diatonicChords: diatonicChords, preferredNotation: preferredNotation,
    squaresToHtml: squaresToHtml, escapeHtml: esc
  };
});
