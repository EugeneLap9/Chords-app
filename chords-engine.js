// chords-engine.js — чистая, без-DOM логика режима "Аккорды" ChordBook.
// Работает и как <script src> в браузере (window.ChordsEngine), и как
// обычный CommonJS-модуль в Node (require('./chords-engine.js')) — для
// юнит-тестов и для самого index.html одновременно, без дублирования
// алгоритмов.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ChordsEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function eq(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ═══════════════════════════════════════════
  //  ЭКСТРАКЦИЯ АККОРДОВ ИЗ СТРОКИ
  // ═══════════════════════════════════════════
  function extractLineChords(line) {
    if (!line) return [];
    const chords = [];
    for (const m of String(line).matchAll(/\[([^\]]+)\]/g)) chords.push(m[1]);
    return chords;
  }

  // ═══════════════════════════════════════════
  //  АВТО-ГРУППИРОВКА (упрощённый, полностью предсказуемый алгоритм)
  //
  //  Правило: 1 исходная строка = 1 square по умолчанию. Единственное,
  //  что схлопывается автоматически — ТОЧНЫЕ повторы (одна строка или
  //  группа из нескольких РАЗНЫХ строк, повторяющаяся подряд без
  //  изменений). Никогда не сливает строки разной длины, никогда не
  //  режет строку на части — это осознанно оставлено за AI-кнопкой и
  //  ручным редактором (см. Планирование/…TDD-переписывание режима
  //  Аккорды в Obsidian).
  // ═══════════════════════════════════════════
  function autoGroupBlock(lines) {
    const chordLines = (lines || [])
      .map(extractLineChords)
      .filter(chords => chords.length > 0);

    if (!chordLines.length) return [];

    // Ищем наименьшую длину паттерна L (>=1), для которой блок начинается
    // с >=2 точных повторов подряд. Первая подходящая L побеждает —
    // предсказуемо и просто для человека (не пытаемся угадать "лучшую"
    // из нескольких математически валидных интерпретаций).
    const maxL = Math.floor(chordLines.length / 2);
    for (let L = 1; L <= maxL; L++) {
      const pattern = chordLines.slice(0, L);
      let reps = 0;
      while ((reps + 1) * L <= chordLines.length) {
        const start = reps * L;
        let matches = true;
        for (let j = 0; j < L; j++) {
          if (!eq(chordLines[start + j], pattern[j])) { matches = false; break; }
        }
        if (!matches) break;
        reps++;
      }
      if (reps >= 2) {
        const consumed = reps * L;
        const tailLines = (lines || []).filter(l => extractLineChords(l).length > 0).slice(consumed);
        const tailResult = tailLines.length ? autoGroupBlock(tailLines) : [];

        if (L === 1) {
          return [{ type: 'single', chords: pattern[0], multiplier: reps }, ...tailResult];
        }
        return [{
          type: 'group',
          items: pattern.map(chords => ({ type: 'single', chords, multiplier: 1 })),
          multiplier: reps
        }, ...tailResult];
      }
    }

    // Ни один периодический паттерн не найден с начала — каждая строка
    // становится собственным square, порядок сохранён, без слияния.
    return chordLines.map(chords => ({ type: 'single', chords, multiplier: 1 }));
  }

  // ═══════════════════════════════════════════
  //  СХЛОПЫВАНИЕ ПОДРЯД ИДУЩИХ ОДИНАКОВЫХ СТРОК В mult[i]
  //  (перенесено как есть из ранее проверенной реализации — используется
  //  и AI-слоем, и потенциально ручным редактором для одинакового
  //  визуального результата)
  // ═══════════════════════════════════════════
  function collapseRepeatedRows(rows) {
    const outRows = [];
    const outMult = [];
    let i = 0;
    while (i < rows.length) {
      const cur = rows[i];
      let mul = 1;
      while (i + mul < rows.length && eq(rows[i + mul], cur)) mul++;
      outRows.push(cur);
      outMult.push(mul);
      i += mul;
    }
    return { rows: outRows, mult: outMult };
  }

  // ═══════════════════════════════════════════
  //  СТАБИЛЬНЫЙ КЛЮЧ БЛОКА (фикс "раскладка приклеивается к чужому
  //  блоку" — вместо голого индекса блока в исходном массиве, который
  //  меняется при правке сырого текста песни)
  // ═══════════════════════════════════════════

  // Небольшой детерминированный хэш строки (djb2-подобный) — не для
  // криптографии, только чтобы отличать разные наборы аккордов друг от
  // друга стабильно между запусками/машинами.
  function _hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  function _normalizeLabel(label) {
    return String(label || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function computeBlockKey(block) {
    const label = _normalizeLabel(block && block.label);
    const lines = (block && block.lines) || [];
    const flatChords = lines.map(extractLineChords).flat().join(',');
    return label + '|' + _hashString(flatChords);
  }

  // Переносит записи раскладки со старых индексов на новые по
  // совпадению стабильного key. Легаси-записи без key (сохранённые до
  // введения этого поля) трактуются как относящиеся к блоку на ТОМ ЖЕ
  // числовом индексе, что и раньше (мягкая обратная совместимость), и
  // key для них вычисляется и дописывается в результат.
  function remapChordsLayout(storedLayout, newBlocks) {
    const newKeys = newBlocks.map(computeBlockKey);
    const result = {};

    Object.keys(storedLayout || {}).forEach(function (oldIndexStr) {
      const entry = storedLayout[oldIndexStr];
      if (!entry) return;
      const oldIndex = +oldIndexStr;

      if (typeof entry.key === 'string') {
        const newIndex = newKeys.indexOf(entry.key);
        if (newIndex === -1) return; // блок пропал — раскладка тихо не переносится
        result[newIndex] = entry;
        return;
      }

      // Легаси-запись без key: доверяем прежнему индексу, если блок там
      // всё ещё существует, и дописываем key на будущее.
      if (oldIndex >= 0 && oldIndex < newBlocks.length) {
        result[oldIndex] = Object.assign({}, entry, { key: newKeys[oldIndex] });
      }
    });

    return result;
  }

  // ═══════════════════════════════════════════
  //  ТРАНСПОНИРОВАНИЕ (перенесено из index.html — единственный источник
  //  истины для алгоритма транспонирования, используется и обычным
  //  рендером песни, и слоем ручной/AI-раскладки режима "Аккорды")
  // ═══════════════════════════════════════════
  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const NOTES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

  function normalizeNote(n) {
    const flat2sharp = { Db: 'C#', Eb: 'D#', Fb: 'E', Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B', H: 'B' };
    return flat2sharp[n] || n;
  }

  function transposeSingleNote(root, semitones, notation) {
    const norm = normalizeNote(root);
    const idx = NOTES.indexOf(norm);
    if (idx === -1) return root;
    const newIdx = ((idx + semitones) % 12 + 12) % 12;
    return (notation === 'flat' ? NOTES_FLAT : NOTES)[newIdx];
  }

  function transposeChord(chord, semitones, notation) {
    if (semitones === 0 && !notation) return chord;
    if (chord.indexOf('/') !== -1) {
      const slashIdx = chord.lastIndexOf('/');
      const main = chord.slice(0, slashIdx);
      const bass = chord.slice(slashIdx + 1);
      return transposeChord(main, semitones, notation) + '/' + transposeChord(bass, semitones, notation);
    }
    return chord.replace(/([A-H][b#]?)((?:maj7?|maj|min|m|dim|aug|sus[24]?|add\d+|\d+)*)/g, function (match, root, quality) {
      return transposeSingleNote(root, semitones, notation) + quality;
    });
  }

  // Пересчитывает ручную/AI-раскладку под ТЕКУЩЕЕ состояние песни.
  // layout хранит baseTranspose/baseNotation — состояние, при котором
  // раскладка была создана/сохранена в последний раз; функция сама
  // считает дельту относительно него и транспонирует rows тем же
  // алгоритмом (transposeChord), что и обычный рендер песни. Не
  // мутирует исходный layout — baseTranspose должен остаться прежним
  // для будущих пересчётов от исходной точки, а не накапливать дрейф.
  function applyTransposeToLayout(layout, currentTranspose, currentNotation) {
    const base = layout.baseTranspose || 0;
    const delta = (currentTranspose || 0) - base;
    const notation = currentNotation;
    const baseNotationSame = (layout.baseNotation || 'sharp') === (notation || 'sharp');
    if (delta === 0 && baseNotationSame) {
      return Object.assign({}, layout);
    }
    const newRows = layout.rows.map(function (row) {
      return row.map(function (chord) { return transposeChord(chord, delta, notation); });
    });
    return Object.assign({}, layout, { rows: newRows });
  }

  // ═══════════════════════════════════════════
  //  ЕДИНЫЙ РЕНДЕР (устраняет прежнее дублирование squareToHtml +
  //  manualLayoutToHtml с отдельной ×N-логикой в каждом — источник
  //  бага "AI-результат не схлопнулся")
  // ═══════════════════════════════════════════

  // Конвертирует ручную/AI-раскладку {rows, mult?} в тот же формат
  // Square[], что возвращает autoGroupBlock — дальше единый squareToHtml
  // рендерит оба пути одинаково.
  function manualRowsToSquares(layout) {
    const rows = (layout && layout.rows) || [];
    const mult = (layout && layout.mult) || [];
    const squares = [];
    rows.forEach(function (row, i) {
      if (!row || !row.length) return;
      squares.push({ type: 'single', chords: row, multiplier: mult[i] > 1 ? mult[i] : 1 });
    });
    return squares;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function squareToHtml(sq) {
    if (sq.type === 'group') {
      const rowsHtml = sq.items.map(squareToHtml).join('');
      const multHtml = '<span class="repeat-badge repeat-inline">\xd7' + sq.multiplier + '</span>';
      return '<div class="group-repeat-block">'
        + '<div class="group-repeat-left">' + multHtml + '</div>'
        + '<div class="group-repeat-bracket"></div>'
        + '<div style="flex:1">'
        + '<div class="group-repeat-rows">' + rowsHtml + '</div>'
        + '</div>'
        + '</div>';
    }
    if (sq.type === 'pair') {
      const rowA = sq.chords.map(function (c) { return '<span class="chord-badge">' + escapeHtml(c) + '</span>'; }).join('');
      const rowB = sq.chords2.map(function (c) { return '<span class="chord-badge">' + escapeHtml(c) + '</span>'; }).join('');
      const multHtml = '<span class="repeat-badge repeat-inline">\xd7' + sq.multiplier + '</span>';
      return '<div class="chords-only-row" style="margin-bottom:6px;align-items:center;flex-wrap:wrap;">'
        + '<span style="display:inline-flex;align-items:center;gap:3px;flex-wrap:wrap">' + rowA + '</span>'
        + '<span style="color:var(--muted);font-size:11px;padding:0 4px">|</span>'
        + '<span style="display:inline-flex;align-items:center;gap:3px;flex-wrap:wrap">' + rowB + '</span>'
        + multHtml + '</div>';
    }
    const chordsHtml = sq.chords.map(function (c) { return '<span class="chord-badge">' + escapeHtml(c) + '</span>'; }).join('');
    const passageHtml = sq.passage ? '<span class="passage-badge">(' + escapeHtml(sq.passage) + ')</span>' : '';
    const mulN = sq.multiplier > 1 ? sq.multiplier : 0;
    const multHtml = mulN > 1 ? '<span class="repeat-badge repeat-inline">\xd7' + mulN + '</span>' : '';
    return '<div class="chords-only-row" style="margin-bottom:6px;align-items:center;flex-wrap:nowrap;overflow:visible;">' + chordsHtml + passageHtml + multHtml + '</div>';
  }

  // ═══════════════════════════════════════════
  //  РУЧНОЙ РЕДАКТОР — ЧИСТЫЕ ТРАНСФОРМАЦИИ СОСТОЯНИЯ
  //  (add/remove/drag). Каждая функция возвращает НОВЫЙ layout, исходный
  //  не мутируется. Строка удаляется целиком только если она опустела И
  //  она не единственная оставшаяся строка блока — блок никогда не
  //  схлопывается в пустоту сам по себе.
  // ═══════════════════════════════════════════
  function _cloneRows(rows) {
    return (rows || []).map(function (r) { return r.slice(); });
  }

  function editorAddChord(layout, ri, chord) {
    const rows = _cloneRows(layout.rows);
    if (!rows[ri]) rows[ri] = [];
    rows[ri].push(chord);
    return Object.assign({}, layout, { rows: rows });
  }

  function editorAddRow(layout, chord) {
    const rows = _cloneRows(layout.rows);
    rows.push([chord]);
    return Object.assign({}, layout, { rows: rows });
  }

  // Внутренний хелпер: убирает аккорд [ri][ci], возвращает
  // { layout, chord, rowRemoved } — нужен moveChord'у, чтобы знать,
  // сдвинулись ли индексы строк после удаления.
  function _removeChordAt(layout, ri, ci) {
    const rows = _cloneRows(layout.rows);
    if (!rows[ri]) return { layout: Object.assign({}, layout, { rows: rows }), chord: undefined, rowRemoved: false };
    const chord = rows[ri][ci];
    rows[ri].splice(ci, 1);
    let rowRemoved = false;
    if (rows[ri].length === 0 && rows.length > 1) {
      rows.splice(ri, 1);
      rowRemoved = true;
    }
    return { layout: Object.assign({}, layout, { rows: rows }), chord: chord, rowRemoved: rowRemoved };
  }

  // Публичная версия — просто новый layout, без служебных полей.
  function editorRemoveChord(layout, ri, ci) {
    return _removeChordAt(layout, ri, ci).layout;
  }

  // Вставляет chord в rows[ri] на позицию ci. НИКОГДА не создаёт новую
  // строку — ri клэмпится к последней РЕАЛЬНО существующей строке, если
  // цель указывает дальше конца (новые строки создаются только явно,
  // через editorAddRow).
  function _editorInsertChord(rows, ri, ci, chord) {
    if (rows.length === 0) rows.push([]);
    const clampedRi = Math.max(0, Math.min(ri, rows.length - 1));
    const row = rows[clampedRi];
    const clampedCi = Math.max(0, Math.min(ci, row.length));
    row.splice(clampedCi, 0, chord);
  }

  // Перетаскивание внутри ОДНОГО блока: from {ri, ci} → to {ri, ci}.
  function editorMoveChord(layout, from, to) {
    const removed = _removeChordAt(layout, from.ri, from.ci);
    let targetRi = to.ri;
    let targetCi = to.ci;
    if (removed.rowRemoved && targetRi > from.ri) {
      targetRi -= 1;
    } else if (!removed.rowRemoved && targetRi === from.ri && targetCi > from.ci) {
      targetCi -= 1;
    }
    const rows = _cloneRows(removed.layout.rows);
    _editorInsertChord(rows, targetRi, targetCi, removed.chord);
    return Object.assign({}, removed.layout, { rows: rows });
  }

  // Перетаскивание между ДВУМЯ блоками: возвращает { src, dst }.
  function editorMoveChordAcrossBlocks(srcLayout, from, dstLayout, to) {
    const removed = _removeChordAt(srcLayout, from.ri, from.ci);
    const dstRows = _cloneRows(dstLayout.rows);
    _editorInsertChord(dstRows, to.ri, to.ci, removed.chord);
    return {
      src: removed.layout,
      dst: Object.assign({}, dstLayout, { rows: dstRows })
    };
  }

  return {
    extractLineChords: extractLineChords,
    autoGroupBlock: autoGroupBlock,
    collapseRepeatedRows: collapseRepeatedRows,
    computeBlockKey: computeBlockKey,
    remapChordsLayout: remapChordsLayout,
    transposeChord: transposeChord,
    applyTransposeToLayout: applyTransposeToLayout,
    manualRowsToSquares: manualRowsToSquares,
    squareToHtml: squareToHtml,
    escapeHtml: escapeHtml,
    editorAddChord: editorAddChord,
    editorAddRow: editorAddRow,
    editorRemoveChord: editorRemoveChord,
    editorMoveChord: editorMoveChord,
    editorMoveChordAcrossBlocks: editorMoveChordAcrossBlocks
  };
});
