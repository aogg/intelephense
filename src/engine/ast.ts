/**
 * engine/ast.ts：php-parser 封装 + 文档缓存。
 * 形状依据 scripts/ast-notes.md（3.7.0 实测）：
 *  - withPositions 在 ast 选项组；suppressErrors/extractDoc 嵌套 parser 子对象；
 *  - node.loc = {start:{line(1基),column(UTF-16),offset}, end:{...}}；
 *  - docblock 在语句级节点的 leadingComments[]；语法错误在 ast.errors[]。
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const phpParserModule: any = require('php-parser');

export interface ParsedDoc {
  uri: string;
  text: string;
  ast: any;
  errors: any[];
  lineIndex: number[];
}

export function createParser(): any {
  return phpParserModule.create({
    ast: { withPositions: true },
    parser: { extractDoc: true, suppressErrors: true, version: 704 },
    debug: false,
  });
}

export function parseText(parser: any, uri: string, text: string): ParsedDoc {
  let ast: any;
  try {
    ast = parser.parseCode(text, uri);
  } catch (e) {
    // suppressErrors 下不应发生；兜底出空 program 保证引擎不崩
    ast = { kind: 'program', children: [], errors: [String(e)] };
  }
  const errors = Array.isArray(ast.errors) ? ast.errors : [];
  return { uri, text, ast, errors, lineIndex: buildLineIndexLocal(text) };
}

function buildLineIndexLocal(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** php-parser loc → LSP Range */
export function locToRange(loc: any): { start: { line: number; character: number }; end: { line: number; character: number } } {
  if (!loc || !loc.start) return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  return {
    start: { line: loc.start.line - 1, character: loc.start.column },
    end: { line: loc.end.line - 1, character: loc.end.column },
  };
}

export function nodeStart(node: any): { line: number; character: number } | undefined {
  return node && node.loc && node.loc.start ? { line: node.loc.start.line - 1, character: node.loc.start.column } : undefined;
}

/** 节点是否包含 0 基 LSP 位置 */
export function nodeContains(node: any, line: number, character: number): boolean {
  const loc = node && node.loc;
  if (!loc || !loc.start || !loc.end) return false;
  const sl = loc.start.line - 1;
  const el = loc.end.line - 1;
  if (line < sl || line > el) return false;
  if (line === sl && character < loc.start.column) return false;
  if (line === el && character > loc.end.column) return false;
  return true;
}

/** 通用递归遍历（跳过 loc 元数据） */
export function walk(node: any, visit: (node: any) => void, seen?: Set<any>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, seen);
    return;
  }
  if (seen && seen.has(node)) return;
  if (seen) seen.add(node);
  if (typeof node.kind === 'string') visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    const value = (node as Record<string, unknown>)[key];
    if (value && typeof value === 'object') walk(value, visit, seen);
  }
}

/** 语句节点上的 docblock（leadingComments 中最后一个 commentblock） */
export function docblockOf(node: any): string | undefined {
  const leading = node && node.leadingComments;
  if (!Array.isArray(leading)) return undefined;
  for (let i = leading.length - 1; i >= 0; i--) {
    const c = leading[i];
    if (c && c.kind === 'commentblock' && typeof c.value === 'string' && c.value.startsWith('/**')) return c.value;
  }
  return undefined;
}

/** 类型节点的原始文本（name/identifier/nullabletype/uniontype/intersectiontype） */
export function rawTypeOf(node: any): string | undefined {
  if (!node) return undefined;
  switch (node.kind) {
    case 'name':
    case 'identifier': {
      const name = typeof node.name === 'string' ? node.name : node.name && node.name.name;
      const resolution = node.resolution;
      // fqn（\ 开头或 resolution==='fqn'）保留前导 \，其余保持原样交给别名表
      if (typeof name !== 'string') return undefined;
      if (resolution === 'fqn' && !name.startsWith('\\')) return '\\' + name;
      return name;
    }
    case 'nullabletype': {
      const inner = rawTypeOf(node.what);
      return inner ? '?' + inner : undefined;
    }
    case 'uniontype':
    case 'intersectiontype':
      return Array.isArray(node.types) ? node.types.map(rawTypeOf).filter(Boolean).join(node.kind === 'uniontype' ? '|' : '&') : undefined;
    default:
      return undefined;
  }
}

/** 朴素标识符字符串（identifier.name 可能是嵌套节点） */
export function plainName(node: any): string | undefined {
  if (!node) return undefined;
  if (typeof node === 'string') return node;
  if (typeof node.name === 'string') return node.name;
  if (node.name && typeof node.name.name === 'string') return node.name.name;
  return undefined;
}
