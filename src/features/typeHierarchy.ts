/**
 * features/typeHierarchy.ts：typeHierarchy 三方法（自研，官方免费版关闭）。
 *  - textDocument/prepareTypeHierarchy：光标处类型 → TypeHierarchyItem（类名引用/成员类型/声明处）；
 *  - typeHierarchy/supertypes：直接上级（extends 父类 + implements 接口 + trait use，逐项可继续上钻）；
 *  - typeHierarchy/subtypes：直接下级（全工作区直接 extends/implements/use 本类型的类型）。
 * openidea 类编辑器（Type Hierarchy 面板）可直接消费这三个方法。
 */

import { resolveTypeRaw } from '../engine/resolver';
import type { ClassSym } from '../engine/symbols';
import { hitAtPosition, type NavigationEngine, type DefinitionParamsLike, type LocationLike } from './navigation';
import { declarationAt, workspaceClasses } from './implementation';

export const SYMBOL_KIND_CLASS = 5;
export const SYMBOL_KIND_INTERFACE = 11;

export interface TypeHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LocationLike['range'];
  selectionRange: LocationLike['range'];
  detail?: string;
  data?: { fqn: string };
}

function itemOfClass(cls: ClassSym): TypeHierarchyItem {
  return {
    name: cls.name,
    kind: cls.kind === 'interface' ? SYMBOL_KIND_INTERFACE : SYMBOL_KIND_CLASS,
    uri: cls.uri,
    range: cls.range,
    selectionRange: cls.selectionRange,
    detail: cls.kind === 'trait' ? 'trait' : cls.kind,
    data: { fqn: cls.fqn },
  };
}

async function resolveItems(engine: NavigationEngine, fqns: string[]): Promise<TypeHierarchyItem[]> {
  const out: TypeHierarchyItem[] = [];
  const seen = new Set<string>();
  for (const fqn of fqns) {
    const lower = fqn.toLowerCase();
    if (!lower || seen.has(lower)) continue;
    const cls = await engine.resolveClass(fqn);
    if (!cls) continue;
    seen.add(lower);
    out.push(itemOfClass(cls));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function prepareTypeHierarchy(engine: NavigationEngine, params: DefinitionParamsLike): Promise<TypeHierarchyItem[] | null> {
  const doc = await engine.getDoc(params.textDocument.uri);
  if (!doc) return null;
  const line = params.position.line;
  const character = params.position.character;

  const hit = await hitAtPosition(engine, doc, line, character);
  if (hit) {
    if (hit.kind === 'class') return [itemOfClass(hit.sym)];
    // 成员引用：类型优先（$this->auth → Auth），退化到成员宿主类
    const typed = await resolveItems(engine, hit.typeFqns ?? []);
    if (typed.length > 0) return typed;
    return [itemOfClass(hit.ref.owner)];
  }

  // 声明处光标（类名声明 / 方法名声明 → 宿主类型）
  const decl = declarationAt(doc, line, character);
  if (decl?.kind === 'class') return [itemOfClass(decl.cls)];
  if (decl?.kind === 'method') return [itemOfClass(decl.cls)];
  return null;
}

/** 直接上级：extends 父类 + implements 接口 + trait use（vendor 等索引外类型诚实缺席） */
export async function typeHierarchySupertypes(engine: NavigationEngine, item: TypeHierarchyItem | undefined): Promise<TypeHierarchyItem[] | null> {
  const fqn = item?.data?.fqn;
  if (!fqn) return null;
  const cls = await engine.resolveClass(fqn);
  if (!cls) return null;
  const file = engine.index.files.get(cls.uri);
  const supers: string[] = [];
  for (const raw of cls.extendsRaw ?? []) {
    const f = resolveTypeRaw(raw, file, cls.fqn)[0];
    if (f) supers.push(f);
  }
  for (const raw of cls.implementsRaw ?? []) {
    const f = resolveTypeRaw(raw, file, cls.fqn)[0];
    if (f) supers.push(f);
  }
  for (const t of cls.traitUses ?? []) {
    const f = resolveTypeRaw(t.raw, file, cls.fqn)[0];
    if (f) supers.push(f);
  }
  return resolveItems(engine, supers);
}

/** 直接下级：全工作区直接 extends/implements/use 本类型的类型 */
export async function typeHierarchySubtypes(engine: NavigationEngine, item: TypeHierarchyItem | undefined): Promise<TypeHierarchyItem[] | null> {
  const fqn = item?.data?.fqn;
  if (!fqn) return null;
  const targetLower = fqn.toLowerCase();
  const out: TypeHierarchyItem[] = [];
  for (const candidate of await workspaceClasses(engine)) {
    if (candidate.fqn.toLowerCase() === targetLower) continue;
    const file = engine.index.files.get(candidate.uri);
    let direct = false;
    for (const raw of candidate.extendsRaw ?? []) {
      const f = resolveTypeRaw(raw, file, candidate.fqn)[0];
      if (f && f.toLowerCase() === targetLower) {
        direct = true;
        break;
      }
    }
    if (!direct) {
      for (const raw of candidate.implementsRaw ?? []) {
        const f = resolveTypeRaw(raw, file, candidate.fqn)[0];
        if (f && f.toLowerCase() === targetLower) {
          direct = true;
          break;
        }
      }
    }
    if (!direct) {
      for (const t of candidate.traitUses ?? []) {
        const f = resolveTypeRaw(t.raw, file, candidate.fqn)[0];
        if (f && f.toLowerCase() === targetLower) {
          direct = true;
          break;
        }
      }
    }
    if (direct) out.push(itemOfClass(candidate));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.uri.localeCompare(b.uri));
}
