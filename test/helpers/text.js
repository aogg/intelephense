'use strict';
/**
 * test/helpers/text.js — 文本定位 / LSP 结果归一化 / 内存文本编辑工具。
 *
 * 与 scripts/probe.ts 无共享代码：独立实现，供 test/ 各用例独立断言使用。
 */

const crypto = require('node:crypto');

/** 行起始偏移表：lineStarts(text)[line] === 该行首字符在 text 中的偏移 */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 字符偏移 → {line, character}（0 基） */
function posAt(text, offset) {
  const starts = lineStarts(text);
  let line = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= offset) line = i;
  return { line, character: offset - starts[line] };
}

/** needle 第 occurrence 次（0 起）出现位置 {line, character}；找不到抛错 */
function locate(text, needle, occurrence = 0) {
  let idx = -1;
  for (let k = 0; k <= occurrence; k++) {
    idx = text.indexOf(needle, idx + 1);
    if (idx < 0) throw new Error(`locate: ${JSON.stringify(needle)} 第 ${occurrence} 次出现未找到`);
  }
  return posAt(text, idx);
}

/** LSP range 覆盖的源文本切片 */
function textInRange(text, range) {
  if (!range || !range.start || !range.end) return '';
  const starts = lineStarts(text);
  const at = (p) => starts[Math.min(p.line, starts.length - 1)] + p.character;
  return text.slice(at(range.start), at(range.end));
}

/** LSP TextEdit[] 应用到内存文本（从后往前，避免位置漂移；调用方保证区间不重叠） */
function applyTextEdits(text, edits) {
  const starts = lineStarts(text);
  const at = (p) => starts[Math.min(p.line, starts.length - 1)] + p.character;
  let t = text;
  for (const e of [...(edits || [])].sort((a, b) => at(b.range.start) - at(a.range.start))) {
    const s = at(e.range.start);
    const en = at(e.range.end);
    t = t.slice(0, s) + (e.newText || '') + t.slice(en);
  }
  return t;
}

/** Location | Location[] | LocationLink[] → [{uri, range}]（统一归一化，断言只用 uri+range） */
function asLocations(result) {
  const norm = (l) => {
    if (!l || typeof l !== 'object') return null;
    const uri = typeof l.uri === 'string' ? l.uri : typeof l.targetUri === 'string' ? l.targetUri : undefined;
    if (!uri) return null;
    const range = l.range || l.targetSelectionRange || l.sourceRange;
    return { uri, range };
  };
  if (Array.isArray(result)) return result.map(norm).filter(Boolean);
  if (result && typeof result === 'object') {
    const n = norm(result);
    return n ? [n] : [];
  }
  return [];
}

/** CompletionList | CompletionItem[] → item 数组 */
function asItems(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.items)) return result.items;
  return [];
}

/** hover 结果 → 纯文本（MarkupContent / MarkedString[] / string 兼容） */
function hoverText(result) {
  const c = result && result.contents;
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (typeof c.value === 'string') return c.value;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x && x.value) || '').join('\n');
  return '';
}

function sha256File(abs, fs) {
  return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function summary(v, max = 360) {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  lineStarts,
  posAt,
  locate,
  textInRange,
  applyTextEdits,
  asLocations,
  asItems,
  hoverText,
  sha256File,
  summary,
  sleep,
};
