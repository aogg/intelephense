/**
 * features/selectionRange.ts：smart select（自研，官方免费版关闭）。
 * php-parser AST 节点层级（parent chain）驱动的扩选/缩选。
 */

import { walk } from '../engine/ast';
import type { ParsedDoc } from '../engine/ast';

export interface SelectionRange {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  parent?: SelectionRange;
}

export function computeSelectionRanges(doc: ParsedDoc, positions: { line: number; character: number }[]): SelectionRange[] {
  // 一次性收集全部带 loc 的节点，按 offset 排序后按位置过滤
  const nodes: any[] = [];
  walk(doc.ast, (node) => {
    if (node.loc && node.loc.start && node.loc.end && typeof node.loc.start.offset === 'number' && typeof node.loc.end.offset === 'number') {
      nodes.push(node);
    }
  });
  nodes.sort((a, b) => a.loc.start.offset - b.loc.start.offset || b.loc.end.offset - a.loc.end.offset);

  return positions.map((pos) => buildChain(doc, nodes, pos));
}

function buildChain(doc: ParsedDoc, nodes: any[], pos: { line: number; character: number }): SelectionRange {
  const lineIndex = doc.lineIndex;
  const offset = posToOffset(lineIndex, pos);
  // 含该位置的节点，按（大小升序）
  const containing: any[] = [];
  for (const node of nodes) {
    if (node.loc.start.offset <= offset && offset <= node.loc.end.offset) containing.push(node);
  }
  containing.sort((a, b) => size(a) - size(b));

  // 去重相同 range 并构建 parent 链（保证嵌套）
  const chain: { start: number; end: number }[] = [];
  for (const node of containing) {
    const s = node.loc.start.offset;
    const e = node.loc.end.offset;
    const prev = chain[chain.length - 1];
    if (prev && prev.start === s && prev.end === e) continue;
    if (prev && (s > prev.start || e < prev.end)) continue; // 不嵌套则丢弃
    chain.push({ start: s, end: e });
    if (chain.length > 100) break;
  }
  if (chain.length === 0) {
    const range = { start: { ...pos }, end: { ...pos } };
    return { range };
  }

  // 从最内层往外构建
  let current: SelectionRange | undefined;
  for (let i = 0; i < chain.length; i++) {
    const seg = chain[i];
    const range = {
      start: offsetToPos(lineIndex, seg.start),
      end: offsetToPos(lineIndex, seg.end),
    };
    current = current ? { range, parent: current } : { range };
  }
  return current!;
}

function posToOffset(lineIndex: number[], pos: { line: number; character: number }): number {
  const line = Math.min(Math.max(pos.line, 0), lineIndex.length - 1);
  return lineIndex[line] + pos.character;
}

function offsetToPos(lineIndex: number[], offset: number): { line: number; character: number } {
  let lo = 0;
  let hi = lineIndex.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineIndex[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - lineIndex[lo] };
}

function size(node: any): number {
  return node.loc.end.offset - node.loc.start.offset;
}
