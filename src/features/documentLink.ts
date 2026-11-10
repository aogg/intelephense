/**
 * features/documentLink.ts：documentLink（自研，官方免费版不注册）。
 * require/include/include_once/require_once 的路径字面量与 __DIR__ 拼接解析为文件 URI；
 * 含未知常量或目标不存在的路径不生成链接（诚实降级）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { walk } from '../engine/ast';
import type { ParsedDoc } from '../engine/ast';

export interface DocumentLink {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  target?: string;
}

interface PathPart {
  kind: 'str' | 'dir' | 'const';
  value?: string;
  constName?: string;
  loc?: any;
}

export function computeDocumentLinks(doc: ParsedDoc, rootPath: string | undefined): DocumentLink[] {
  const out: DocumentLink[] = [];
  let fileDir: string | undefined;
  try {
    fileDir = path.dirname(fileURLToPath(doc.uri));
  } catch {
    return out;
  }

  walk(doc.ast, (node) => {
    if (node.kind !== 'include' || !node.target) return;
    const parts = flattenConcat(node.target);
    if (parts.length === 0) return;
    // 含未知常量 → 无法解析 → 不生成链接
    if (parts.some((p) => p.kind === 'const')) return;
    const hasDir = parts.some((p) => p.kind === 'dir');
    const joined = parts
      .map((p) => (p.kind === 'str' ? p.value ?? '' : ''))
      .join('');
    if (!joined.trim()) return;

    const candidates: string[] = [];
    if (hasDir) {
      // __DIR__ 拼接：joined 常以 / 开头，必须拼在文件目录下（不能用 resolve，会把前导 / 当绝对路径）
      candidates.push(path.join(fileDir, joined));
    } else if (path.isAbsolute(joined)) {
      candidates.push(joined);
    } else {
      candidates.push(path.resolve(fileDir, joined));
      if (rootPath) candidates.push(path.resolve(rootPath, joined));
    }
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          const range = node.loc
            ? {
                start: { line: node.target.loc.start.line - 1, character: node.target.loc.start.column },
                end: { line: node.target.loc.end.line - 1, character: node.target.loc.end.column },
              }
            : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
          out.push({ range, target: pathToFileURL(candidate).href });
          return;
        }
      } catch {
        // stat 失败按不存在处理
      }
    }
    // 目标不存在：不生成链接
  });

  return out;
}

/** 展开 '.' 拼接树为部件序列；无法识别的部件返回空 */
function flattenConcat(node: any): PathPart[] {
  if (!node || typeof node !== 'object') return [];
  if (node.kind === 'bin' && node.type === '.') {
    const left = flattenConcat(node.left);
    const right = flattenConcat(node.right);
    if (left.length === 0 || right.length === 0) return [];
    return [...left, ...right];
  }
  if (node.kind === 'string' && typeof node.value === 'string') {
    return [{ kind: 'str', value: node.value, loc: node.loc }];
  }
  if (node.kind === 'magic' && node.value === '__DIR__') {
    return [{ kind: 'dir' }];
  }
  if (node.kind === 'magic' && typeof node.value === 'string') {
    // __FILE__ 等其他 magic 常量暂不解析
    return [{ kind: 'const', constName: node.value }];
  }
  if (node.kind === 'name' && typeof node.name === 'string') {
    return [{ kind: 'const', constName: node.name }];
  }
  if (node.kind === 'parenthesized' && node.expr) {
    return flattenConcat(node.expr);
  }
  return [];
}
