/** 共享的 LSP 最小类型与工具（自研层自持，不依赖 vscode-languageserver） */

export interface LSPPosition {
  line: number; // 0-based
  character: number; // UTF-16 code units
}
export interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}
export interface LSPLocation {
  uri: string;
  range: LSPRange;
}

export function posKey(p: LSPPosition): string {
  return `${p.line}:${p.character}`;
}

/** UTF-16 单位比较 */
export function comparePosition(a: LSPPosition, b: LSPPosition): number {
  return a.line - b.line || a.character - b.character;
}

export function positionInRange(pos: LSPPosition, range: LSPRange): boolean {
  return comparePosition(pos, range.start) >= 0 && comparePosition(pos, range.end) <= 0;
}

/** 行首偏移索引：lineStarts[i] = 第 i 行(0基)在文本中的起始 offset（UTF-16 单位） */
export function buildLineIndex(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

export function positionToOffset(lineIndex: number[], pos: LSPPosition): number {
  const line = Math.min(Math.max(pos.line, 0), lineIndex.length - 1);
  return lineIndex[line] + pos.character;
}

export function offsetToPosition(lineIndex: number[], offset: number): LSPPosition {
  // 二分找行
  let lo = 0;
  let hi = lineIndex.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineIndex[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - lineIndex[lo] };
}
