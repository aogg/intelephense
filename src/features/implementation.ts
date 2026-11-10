/**
 * features/implementation.ts：textDocument/implementation（find all implementations，自研，官方免费版关闭）。
 * 语义（vip-features §2 / phpstorm-gap P0-8）：
 *  - 接口 → 全部实现类（implements 链，传递）；抽象类/普通类 → 子类（extends 链，传递）；trait → use 者；
 *  - 接口方法/抽象方法 → 全部实现方法声明（含跨文件）；trait 方法 → use 者中的重写；具体方法 → 子类重写；
 *  - 由 WorkspaceIndex 全量扫描（composer psr-4 + 目录兜底）支撑跨文件查找。
 */

import { plainName } from '../engine/ast';
import { resolveTypeRaw } from '../engine/resolver';
import type { ClassSym } from '../engine/symbols';
import type { MemberRef } from '../engine/member';
import { hitAtPosition, type NavigationEngine, type DefinitionParamsLike, type LocationLike } from './navigation';

/** 类的继承关系集合：extends 链（classes，含自身）+ implements/接口 extends（interfaces） */
export interface HierarchySets {
  selfLower: string;
  classes: Set<string>; // 小写 fqn
  interfaces: Set<string>; // 小写 fqn
}

const MAX_HIERARCHY_DEPTH = 12;

export async function hierarchySets(engine: NavigationEngine, cls: ClassSym, depth = 0, seen?: Set<string>): Promise<HierarchySets> {
  const sets: HierarchySets = { selfLower: cls.fqn.toLowerCase(), classes: new Set([cls.fqn.toLowerCase()]), interfaces: new Set() };
  if (depth > MAX_HIERARCHY_DEPTH) return sets;
  const visited = seen ?? new Set<string>();
  if (visited.has(cls.fqn.toLowerCase())) return sets;
  visited.add(cls.fqn.toLowerCase());
  const file = engine.index.files.get(cls.uri);

  // extends 链（类 → 父类；接口 → 父接口进 interfaces）
  for (const raw of cls.extendsRaw ?? []) {
    const fqn = resolveTypeRaw(raw, file, cls.fqn)[0];
    if (!fqn) continue;
    const parent = await engine.resolveClass(fqn);
    if (!parent) continue;
    if (parent.kind === 'interface') {
      sets.interfaces.add(parent.fqn.toLowerCase());
      const parentSets = await hierarchySets(engine, parent, depth + 1, visited);
      for (const i of parentSets.interfaces) sets.interfaces.add(i);
    } else {
      sets.classes.add(parent.fqn.toLowerCase());
      const parentSets = await hierarchySets(engine, parent, depth + 1, visited);
      for (const c of parentSets.classes) sets.classes.add(c);
      for (const i of parentSets.interfaces) sets.interfaces.add(i);
    }
  }

  // implements（类/枚举 → 接口；接口 extends 已在上面处理）
  for (const raw of cls.implementsRaw ?? []) {
    const fqn = resolveTypeRaw(raw, file, cls.fqn)[0];
    if (!fqn) continue;
    const iface = await engine.resolveClass(fqn);
    if (!iface) continue;
    sets.interfaces.add(iface.fqn.toLowerCase());
    const ifaceSets = await hierarchySets(engine, iface, depth + 1, visited);
    for (const i of ifaceSets.interfaces) sets.interfaces.add(i);
  }
  return sets;
}

/** 全工作区类符号（扫描 fqn→uri 按需解析入索引；含内存镜像未入扫描的文档） */
export async function workspaceClasses(engine: NavigationEngine): Promise<ClassSym[]> {
  await engine.index.ensureScan();
  const out: ClassSym[] = [];
  const seen = new Set<string>();
  for (const [fqnLower] of engine.index.scanEntries()) {
    if (seen.has(fqnLower)) continue;
    seen.add(fqnLower);
    const cls = engine.index.byFqn.get(fqnLower) ?? (await engine.resolveClass(fqnLower));
    if (cls) out.push(cls);
  }
  for (const file of engine.index.files.values()) {
    for (const cls of file.classes) {
      const key = cls.fqn.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(cls);
      }
    }
  }
  return out;
}

/** 类是否直接/间接 use 了某 trait */
export async function usesTrait(engine: NavigationEngine, cls: ClassSym, traitFqnLower: string, depth = 0): Promise<boolean> {
  if (depth > MAX_HIERARCHY_DEPTH) return false;
  const file = engine.index.files.get(cls.uri);
  for (const t of cls.traitUses ?? []) {
    const fqn = resolveTypeRaw(t.raw, file, cls.fqn)[0];
    if (fqn && fqn.toLowerCase() === traitFqnLower) return true;
  }
  for (const raw of cls.extendsRaw ?? []) {
    const fqn = resolveTypeRaw(raw, file, cls.fqn)[0];
    if (!fqn) continue;
    const parent = await engine.resolveClass(fqn);
    if (parent && (await usesTrait(engine, parent, traitFqnLower, depth + 1))) return true;
  }
  return false;
}

/** 类级实现：接口→实现类；抽象类/类→子类；trait→use 者 */
export async function implementationsOfClass(engine: NavigationEngine, cls: ClassSym): Promise<LocationLike[]> {
  const targetLower = cls.fqn.toLowerCase();
  const out: LocationLike[] = [];
  for (const candidate of await workspaceClasses(engine)) {
    if (candidate.fqn.toLowerCase() === targetLower) continue;
    if (cls.kind === 'trait') {
      if (await usesTrait(engine, candidate, targetLower)) out.push(loc(candidate));
      continue;
    }
    const sets = await hierarchySets(engine, candidate);
    const hit = cls.kind === 'interface' ? sets.interfaces.has(targetLower) : sets.classes.has(targetLower);
    if (hit) out.push(loc(candidate));
  }
  return sortLocations(out);
}

/** 方法级实现：接口方法/抽象方法→实现方法；trait 方法→use 者重写；具体方法→子类重写 */
export async function implementationsOfMember(engine: NavigationEngine, ref: MemberRef): Promise<LocationLike[]> {
  if (ref.kind !== 'method' || !ref.method) return [];
  const owner = ref.owner;
  const m = ref.method;
  const nameLower = m.name.toLowerCase();
  const ownerLower = owner.fqn.toLowerCase();
  const abstractish = owner.kind === 'interface' || owner.kind === 'trait' || m.isAbstract;
  const out: LocationLike[] = [];
  for (const candidate of await workspaceClasses(engine)) {
    if (candidate.fqn.toLowerCase() === ownerLower) continue;
    const impl = candidate.methods.find((mm) => mm.name.toLowerCase() === nameLower && !mm.isAbstract);
    if (!impl) continue;
    if (owner.kind === 'trait') {
      if (!(await usesTrait(engine, candidate, ownerLower))) continue;
    } else {
      const sets = await hierarchySets(engine, candidate);
      const related = owner.kind === 'interface' ? sets.interfaces.has(ownerLower) : sets.classes.has(ownerLower);
      if (!related) continue;
    }
    out.push({ uri: impl.uri, range: impl.selectionRange });
  }
  return sortLocations(out);
}

function loc(cls: ClassSym): LocationLike {
  return { uri: cls.uri, range: cls.selectionRange };
}

function sortLocations(list: LocationLike[]): LocationLike[] {
  return list.sort((a, b) => a.uri.localeCompare(b.uri) || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
}

/** 声明处命中：类/接口/trait 名称本身，或方法声明名 */
function declarationAt(doc: any, line: number, character: number): { kind: 'class'; cls: ClassSym } | { kind: 'method'; cls: ClassSym; method: any } | undefined {
  const classNodes: { sym: ClassSym; node: any }[] = doc.classNodes ?? [];
  for (const { sym, node } of classNodes) {
    if (inRange(sym.selectionRange, line, character)) return { kind: 'class', cls: sym };
    for (const member of node.body ?? []) {
      if (member.kind !== 'method') continue;
      const method = sym.methods.find((mm) => mm.name === plainName(member.name));
      if (!method) continue;
      if (inRange(method.selectionRange, line, character)) return { kind: 'method', cls: sym, method };
    }
  }
  return undefined;
}

function inRange(range: LocationLike['range'], line: number, character: number): boolean {
  const { start, end } = range;
  if (line < start.line || line > end.line) return false;
  if (line === start.line && character < start.character) return false;
  if (line === end.line && character > end.character) return false;
  return true;
}

export async function navigationImplementation(engine: NavigationEngine, params: DefinitionParamsLike): Promise<LocationLike[] | null> {
  const doc = await engine.getDoc(params.textDocument.uri);
  if (!doc) return null;
  const line = params.position.line;
  const character = params.position.character;

  const hit = await hitAtPosition(engine, doc, line, character);
  if (hit) {
    if (hit.kind === 'class') return distinct(implementationsOfClass(engine, hit.sym));
    if (hit.ref.kind === 'method') return distinct(implementationsOfMember(engine, hit.ref));
    return null; // 属性/常量无 implementation 语义
  }

  // 声明处光标（类名声明/方法名声明）
  const decl = declarationAt(doc, line, character);
  if (decl?.kind === 'class') return distinct(implementationsOfClass(engine, decl.cls));
  if (decl?.kind === 'method') {
    const ref: MemberRef = { name: decl.method.name, kind: 'method', method: decl.method, owner: decl.cls, origin: 'class' };
    return distinct(implementationsOfMember(engine, ref));
  }
  return null;
}

async function distinct(promise: Promise<LocationLike[]>): Promise<LocationLike[]> {
  const list = await promise;
  const seen = new Set<string>();
  const out: LocationLike[] = [];
  for (const l of list) {
    const key = `${l.uri}#${l.range.start.line}:${l.range.start.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}
