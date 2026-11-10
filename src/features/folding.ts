/**
 * features/folding.ts：foldingRange（自研，官方免费版关闭）。
 * 区域：类/接口/trait 体、函数/方法体、switch 体、use 导入块（连续行）、
 * docblock 与多行块注释、连续行注释段、heredoc/nowdoc。
 */

import { walk } from '../engine/ast';
import type { ParsedDoc } from '../engine/ast';

export interface FoldingRange {
  startLine: number;
  endLine: number;
  kind?: 'comment' | 'imports' | 'region';
}

export function computeFoldingRanges(doc: ParsedDoc): FoldingRange[] {
  const out: FoldingRange[] = [];
  const seen = new Set<string>();

  const push = (startLine: number, endLine: number, kind?: FoldingRange['kind']): void => {
    if (endLine <= startLine) return;
    const key = `${startLine}:${endLine}:${kind ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ startLine, endLine, kind });
  };

  const blockOf = (node: any): void => {
    if (!node.loc || !node.loc.start || !node.loc.end) return;
    push(node.loc.start.line - 1, node.loc.end.line - 1);
  };

  walk(doc.ast, (node) => {
    switch (node.kind) {
      case 'class':
      case 'interface':
      case 'trait':
      case 'method':
      case 'function':
        blockOf(node);
        break;
      case 'switch':
        blockOf(node);
        break;
      case 'string': {
        // heredoc / nowdoc：raw 以 <<< 开头
        const raw = typeof node.raw === 'string' ? node.raw : undefined;
        if (raw && raw.startsWith('<<<') && node.loc) blockOf(node);
        break;
      }
      default:
        break;
    }
  });

  // use 导入块：顶层连续 use 语句合并为一个 imports 区
  const topNodes = collectTopNodes(doc.ast);
  let groupStart: number | undefined;
  let groupEndPrev: number | undefined;
  const flushUseGroup = (): void => {
    if (groupStart !== undefined && groupEndPrev !== undefined && groupEndPrev > groupStart) {
      push(groupStart, groupEndPrev, 'imports');
    }
    groupStart = undefined;
    groupEndPrev = undefined;
  };
  for (const node of topNodes) {
    if (node.kind === 'usegroup' || node.kind === 'useitem') {
      if (!node.loc) continue;
      const sl = node.loc.start.line - 1;
      const el = node.loc.end.line - 1;
      if (groupStart === undefined) {
        groupStart = sl;
        groupEndPrev = el;
      } else if (sl === (groupEndPrev ?? sl) + 1) {
        groupEndPrev = el;
      } else {
        flushUseGroup();
        groupStart = sl;
        groupEndPrev = el;
      }
      // group use 自身跨行（use A\{...};）也单独成区
      if (el > sl) push(sl, el, 'imports');
    } else {
      flushUseGroup();
    }
  }
  flushUseGroup();

  // 注释：多行 commentblock（docblock 等）与连续 commentline 段
  const comments = Array.isArray(doc.ast.comments) ? doc.ast.comments : [];
  let lineGroupStart: number | undefined;
  let lineGroupEnd: number | undefined;
  const flushLineGroup = (): void => {
    if (lineGroupStart !== undefined && lineGroupEnd !== undefined && lineGroupEnd > lineGroupStart) {
      push(lineGroupStart, lineGroupEnd, 'comment');
    }
    lineGroupStart = undefined;
    lineGroupEnd = undefined;
  };
  for (const c of comments) {
    if (!c.loc || !c.loc.start || !c.loc.end) continue;
    const sl = c.loc.start.line - 1;
    const el = c.loc.end.line - 1;
    if (c.kind === 'commentblock') {
      if (el > sl) push(sl, el, 'comment');
      flushLineGroup();
    } else if (c.kind === 'commentline') {
      if (lineGroupStart === undefined) {
        lineGroupStart = sl;
        lineGroupEnd = sl;
      } else if (sl === (lineGroupEnd ?? sl) + 1) {
        lineGroupEnd = sl;
      } else {
        flushLineGroup();
        lineGroupStart = sl;
        lineGroupEnd = sl;
      }
    }
  }
  flushLineGroup();

  out.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return out;
}

function collectTopNodes(ast: any): any[] {
  const out: any[] = [];
  for (const child of ast.children ?? []) {
    if (child.kind === 'namespace') {
      const nsChildren = Array.isArray(child.children) ? child.children : Array.isArray(child.body) ? child.body : [];
      out.push(...nsChildren);
    } else {
      out.push(child);
    }
  }
  return out;
}
