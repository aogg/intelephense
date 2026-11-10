/**
 * engine/resolver.ts：类型字符串 → FQN → 文件位置。
 * - use 别名表优先（含 group use），其次当前命名空间兜底；
 * - 支持 ?可空、A|B 联合、Type[] 数组后缀、$this/self/static；
 * - 内建类型不解析（诚实返回空）。
 */

import type { FileIndex, WorkspaceIndex } from './symbols';

export const BUILTIN_TYPES = new Set([
  'int', 'integer', 'string', 'bool', 'boolean', 'float', 'double', 'real',
  'array', 'object', 'callable', 'iterable', 'void', 'null', 'mixed', 'never',
  'false', 'true', 'resource', 'scalar', 'numeric', 'self', 'static', 'parent', '_closure',
]);

/** 拆联合类型（不处理 & 交集：交集逐段解析意义不大） */
export function splitUnion(raw: string): string[] {
  return raw
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 去掉 ? 前缀与 [] 后缀、<...> 泛型参数 */
export function normalizeRaw(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('?')) s = s.slice(1);
  const bracket = s.indexOf('<');
  if (bracket > 0 && s.endsWith('>')) s = s.slice(0, bracket);
  if (s.endsWith('[]')) s = s.slice(0, -2);
  return s.trim();
}

/**
 * PHP 名称解析规则：
 * - 前导 \ → FQN 原样；
 * - 限定名 A\B → 首段查别名表；命中用别名 FQN + 其余段；否则当前命名空间 + 全名；
 * - 非限定名 A → 别名表 → 当前命名空间 + A；
 */
export function resolveName(raw: string, file: FileIndex | undefined): string {
  let name = raw.trim();
  if (name.startsWith('\\')) return name;
  const segments = name.split('\\');
  const first = segments[0].toLowerCase();
  if (file) {
    const alias = file.imports.get(first);
    if (alias) {
      if (segments.length === 1) return alias;
      return alias + '\\' + segments.slice(1).join('\\');
    }
  }
  const ns = file?.namespace ?? '';
  if (segments.length > 1 || ns) return (ns ? ns + '\\' : '') + name;
  return name;
}

/**
 * 类型字符串 → FQN 列表。currentClassFqn 用于 self/static/$this。
 */
export function resolveTypeRaw(raw: string, file: FileIndex | undefined, currentClassFqn?: string): string[] {
  const out: string[] = [];
  for (const part of splitUnion(raw)) {
    const norm = normalizeRaw(part);
    if (!norm) continue;
    const lower = norm.toLowerCase();
    if (lower === 'self' || lower === 'static' || lower === '$this' || lower === 'this') {
      if (currentClassFqn) out.push(currentClassFqn);
      continue;
    }
    if (lower === 'parent') continue; // parent 类型本阶段不展开
    if (BUILTIN_TYPES.has(lower)) continue;
    out.push(resolveName(norm, file));
  }
  return out;
}

/** FQN → 文件 URI：索引（已解析）优先，扫描映射兜底 */
export async function findUriForFqn(fqn: string, index: WorkspaceIndex): Promise<string | undefined> {
  const key = fqn.toLowerCase();
  const inIndex = index.byFqn.get(key);
  if (inIndex) return inIndex.uri;
  await index.ensureScan();
  return index.lookupFqnUri(fqn);
}
