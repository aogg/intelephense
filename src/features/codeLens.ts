/**
 * features/codeLens.ts：textDocument/codeLens + codeLens/resolve（自研，官方免费版不注册）。
 *
 * compute（快）：只产 range + data（kind + 符号定位），不查计数、不产 command（resolve 惰性）；
 * resolve（慢）：查自研索引算计数/重写关系，生成 command；计数为 0 或无重写关系时
 * 返回无 command 的 lens（客户端按惯例隐藏，零噪声）。
 *
 * 覆盖（vip-features §7）：
 *  - 类/接口/trait 声明行：子类数（subtypes）+ 实现数（implementations）两条 lens；
 *  - 方法声明行：引用数（可解析调用点，复用 rename 引用收集器）+ 重写关系（被 N 个子类重写 / 重写或实现某父类·接口来源）；
 *  - trait use 行：使用该 trait 的类数；
 *  - 属性声明行：引用数（->x / ::$x）；
 *  - 类 docblock @property 通道（虚拟属性）：引用数（经 docblock 通道解析的成员访问）。
 */

import { docblockCommentNode, byteIndexOf, lspRangeForJsSpan } from '../engine/ast';
import type { ParsedDoc } from '../engine/ast';
import type { ClassSym } from '../engine/symbols';
import { resolveTypeRaw } from '../engine/resolver';
import { findMember, type ParsedDocLike } from '../engine/member';
import { hierarchySets, usesTrait, workspaceClasses } from './implementation';
import type { NavigationEngine, LocationLike } from './navigation';
import { memberFamily, collectMemberAccessSites, forEachCandidateDoc, receiverFqnsWithParams } from './rename';

export interface LensData {
  kind:
    | 'class-subtypes'
    | 'class-implementations'
    | 'method-refs'
    | 'method-overrides'
    | 'property-refs'
    | 'docprop-refs'
    | 'traituse';
  uri: string;
  /** 类符号定位（class-*：声明类 fqn；traituse：宿主类 fqn；method-*：方法宿主类 fqn） */
  fqn?: string;
  traitRaw?: string;
  /** 成员名（method 系列 / property-refs / docprop-refs） */
  member?: string;
  ownerFqn?: string;
}

export interface CodeLensLike {
  range: LocationLike['range'];
  command?: { title: string; command: string; arguments?: unknown[] };
  data?: LensData;
}

/** 引用展示跳转命令：客户端未实现该命令时仅显示标题（计数文本），不产生副作用 */
export const LENS_COMMAND = 'intelephense-openidea.showReferences';

/** ---------- compute ---------- */

export async function computeCodeLenses(engine: NavigationEngine, uri: string): Promise<CodeLensLike[]> {
  const doc = await engine.getDoc(uri);
  if (!doc) return [];
  const out: CodeLensLike[] = [];
  const view: ParsedDocLike = { uri: doc.uri, ast: doc.ast, classNodes: (doc as any).classNodes ?? [] };

  for (const { sym, node } of view.classNodes) {
    // 1) 类/接口/trait 声明行：子类数 + 实现数
    out.push({ range: sym.selectionRange, data: { kind: 'class-subtypes', uri: doc.uri, fqn: sym.fqn } });
    out.push({ range: sym.selectionRange, data: { kind: 'class-implementations', uri: doc.uri, fqn: sym.fqn } });

    // 2) 方法声明行：引用数 + 重写关系
    for (const m of sym.methods) {
      out.push({ range: m.selectionRange, data: { kind: 'method-refs', uri: doc.uri, member: m.name, ownerFqn: sym.fqn } });
      out.push({ range: m.selectionRange, data: { kind: 'method-overrides', uri: doc.uri, member: m.name, ownerFqn: sym.fqn } });
    }

    // 3) 属性声明行：引用数（docblock 虚拟属性走 docprop-refs，落在 @property 标签行）
    const classDocblock = docblockCommentNode(node);
    for (const p of sym.properties) {
      if (p.originVirtual) continue;
      out.push({ range: p.selectionRange, data: { kind: 'property-refs', uri: doc.uri, member: p.name, ownerFqn: sym.fqn } });
    }

    // 4) trait use 行：使用该 trait 的类数（每条 use 的每个 trait 一条）
    for (const member of node.body ?? []) {
      if (member.kind !== 'traituse' || !member.loc) continue;
      for (const trait of member.traits ?? []) {
        const raw = typeof trait?.name === 'string' ? trait.name : trait?.name?.name;
        if (typeof raw !== 'string') continue;
        out.push({
          range: {
            start: { line: member.loc.start.line - 1, character: member.loc.start.column },
            end: { line: member.loc.end.line - 1, character: member.loc.end.column },
          },
          data: { kind: 'traituse', uri: doc.uri, fqn: sym.fqn, traitRaw: raw },
        });
      }
    }

    // 5) 类 docblock @property 标签行（虚拟属性引用计数）
    if (sym.docblock && sym.docblock.properties.length > 0) {
      for (const lens of docpropLenses(doc, sym, classDocblock)) out.push(lens);
    }
  }
  return out;
}

/** @property 标签行 lens：在类 docblock 文本内定位每个 `@property … $name` 的 $name range */
function docpropLenses(doc: ParsedDoc, sym: ClassSym, d: { value: string; startOffset: number; endOffset: number } | undefined): CodeLensLike[] {
  const out: CodeLensLike[] = [];
  if (!d) return out;
  const startJs = byteIndexOf(doc, d.startOffset);
  const lines = d.value.split('\n');
  let lineOffset = 0;
  for (const lineText of lines) {
    const m = /@property(?:-read|-write)?\s+[^\s$][^\s]*\s+\$(\w+)/.exec(lineText);
    if (m) {
      const nameStart = lineText.indexOf('$' + m[1], m.index);
      if (nameStart >= 0) {
        const range = lspRangeForJsSpan(doc, startJs + lineOffset + nameStart, startJs + lineOffset + nameStart + m[1].length + 1);
        out.push({ range, data: { kind: 'docprop-refs', uri: doc.uri, member: m[1], ownerFqn: sym.fqn } });
      }
    }
    lineOffset += lineText.length + 1;
  }
  return out;
}

/** ---------- resolve ---------- */

export async function resolveCodeLens(engine: NavigationEngine, lens: CodeLensLike): Promise<CodeLensLike> {
  const data = lens.data;
  if (!data) return lens;
  try {
    switch (data.kind) {
      case 'class-subtypes':
        return withCount(lens, data, await subtypeCount(engine, data.fqn ?? ''));
      case 'class-implementations':
        return withCount(lens, data, await implementationCount(engine, data.fqn ?? ''));
      case 'traituse':
        return withCount(lens, data, await traitUserCount(engine, data.traitRaw ?? '', data.fqn ?? '', data.uri));
      case 'method-refs':
        return withCount(lens, data, await memberReferenceCount(engine, data.ownerFqn ?? '', data.member ?? '', 'method'));
      case 'property-refs':
        return withCount(lens, data, await memberReferenceCount(engine, data.ownerFqn ?? '', data.member ?? '', 'property'));
      case 'docprop-refs':
        return withCount(lens, data, await docpropReferenceCount(engine, data.ownerFqn ?? '', data.member ?? ''));
      case 'method-overrides':
        return await overrideLens(engine, lens, data);
      default:
        return lens;
    }
  } catch {
    return lens; // resolve 失败诚实返回原 lens（无 command，客户端隐藏）
  }
}

/** 计数 > 0 才生成 command（0 引用 / 无重写 → 无 command，客户端隐藏） */
function withCount(lens: CodeLensLike, data: LensData, count: number): CodeLensLike {
  if (count <= 0) return { range: lens.range };
  const title =
    data.kind === 'class-subtypes'
      ? `${count} 个子类`
      : data.kind === 'class-implementations'
        ? `${count} 个实现`
        : data.kind === 'traituse'
          ? `${count} 个类使用`
          : `${count} 处引用`;
  return { range: lens.range, command: { title, command: LENS_COMMAND, arguments: [data.uri, lens.range.start, data] }, data };
}

/** 子类数：全工作区类的继承集合（extends 链 / 接口 extends 链）包含目标（接口→扩展接口；类→子类；trait→use 者） */
async function subtypeCount(engine: NavigationEngine, fqn: string): Promise<number> {
  const target = await engine.resolveClass(fqn);
  if (!target) return 0;
  const targetLower = target.fqn.toLowerCase();
  let count = 0;
  for (const candidate of await workspaceClasses(engine)) {
    if (candidate.fqn.toLowerCase() === targetLower) continue;
    if (target.kind === 'trait') {
      if (await usesTrait(engine, candidate, targetLower)) count++;
      continue;
    }
    const sets = await hierarchySets(engine, candidate);
    const hit = target.kind === 'interface' ? sets.interfaces.has(targetLower) : sets.classes.has(targetLower);
    if (hit) count++;
  }
  return count;
}

/** 实现数：implementations 语义（接口→实现类；类→子类；trait→use 者）。接口的「实现」不计扩展接口（那是 subtypes 通道） */
async function implementationCount(engine: NavigationEngine, fqn: string): Promise<number> {
  const target = await engine.resolveClass(fqn);
  if (!target) return 0;
  const targetLower = target.fqn.toLowerCase();
  let count = 0;
  for (const candidate of await workspaceClasses(engine)) {
    if (candidate.fqn.toLowerCase() === targetLower) continue;
    if (target.kind === 'trait') {
      if (await usesTrait(engine, candidate, targetLower)) count++;
      continue;
    }
    const sets = await hierarchySets(engine, candidate);
    if (sets.classes.has(targetLower)) count++;
  }
  return count;
}

/** trait use 行：使用该 trait 的类数（含 traituse 所在类自身） */
async function traitUserCount(engine: NavigationEngine, traitRaw: string, userFqn: string, userUri: string): Promise<number> {
  const user = await engine.resolveClass(userFqn);
  if (!user) return 0;
  const userFile = engine.index.files.get(user.uri);
  const traitFqn = resolveTypeRaw(traitRaw, userFile, user.fqn)[0];
  if (!traitFqn) return 0;
  const traitLower = traitFqn.toLowerCase();
  let count = 0;
  for (const candidate of await workspaceClasses(engine)) {
    if (await usesTrait(engine, candidate, traitLower)) count++;
  }
  void userUri;
  return count;
}

/** 方法/属性引用数：复用 rename 引用收集器（可解析访问点） */
async function memberReferenceCount(engine: NavigationEngine, ownerFqn: string, name: string, kind: 'method' | 'property'): Promise<number> {
  const owner = await engine.resolveClass(ownerFqn);
  if (!owner) return 0;
  const family = await memberFamily(engine, owner, name, kind);
  const sites = await collectMemberAccessSites(engine, name, family, kind);
  return sites.length;
}

/** docblock @property 虚拟属性引用数：->x 访问经成员通道解析出 originVirtual 且宿主匹配 */
async function docpropReferenceCount(engine: NavigationEngine, ownerFqn: string, name: string): Promise<number> {
  const owner = await engine.resolveClass(ownerFqn);
  if (!owner) return 0;
  const ownerLower = owner.fqn.toLowerCase();
  const ctx = engine.ctx;
  let count = 0;
  await forEachCandidateDoc(engine, name, async (doc) => {
    const view: ParsedDocLike = { uri: doc.uri, ast: doc.ast, classNodes: (doc as any).classNodes ?? [] };
    // walker 回调内不能 await：先同步收集访问点，walker 外统一解析接收者
    const pending: { doc: ParsedDoc; node: any; ownerClass: ClassSym | undefined }[] = [];
    walkNodes(doc.ast, (node) => {
      if (node.kind !== 'propertylookup' || !node.offset?.loc || !node.loc) return;
      const offset = node.offset;
      if (offset.kind === 'call') return; // ->x() 是方法调用，不是属性引用
      const nameNode = offset;
      if (!nameNode?.loc) return;
      const span = doc.text.slice(byteIndexOf(doc, nameNode.loc.start.offset), byteIndexOf(doc, nameNode.loc.end.offset));
      if (span !== name) return;
      const afterName = doc.text.slice(byteIndexOf(doc, nameNode.loc.end.offset), byteIndexOf(doc, nameNode.loc.end.offset) + 8);
      if (/^\s*\(/.test(afterName)) return;
      pending.push({ doc, node, ownerClass: enclosingClassOf(view, node) });
    });
    for (const item of pending.splice(0)) {
      const fqns = await receiverFqnsWithParams(engine, item.doc, item.node, view, item.ownerClass);
      for (const fqn of fqns) {
        const cls = await engine.resolveClass(fqn);
        if (!cls) continue;
        const ref = await findMember(cls, name, ctx);
        if (!ref || ref.kind !== 'property' || !ref.property?.originVirtual) continue;
        if (ref.owner.fqn.toLowerCase() !== ownerLower) continue;
        count++;
        break;
      }
    }
  });
  return count;
}

/** ---------- 重写关系 lens ---------- */

async function overrideLens(engine: NavigationEngine, lens: CodeLensLike, data: LensData): Promise<CodeLensLike> {
  const owner = await engine.resolveClass(data.ownerFqn ?? '');
  if (!owner) return { range: lens.range };
  const m = owner.methods.find((mm) => mm.name === data.member);
  if (!m) return { range: lens.range };

  const parts: string[] = [];

  // 来源：向上（父类/接口/trait）找最近同名声明（本类自身除外）
  const origin = await nearestAncestorDeclaration(engine, owner, m.name);
  if (origin) parts.push(origin.kind === 'interface' ? `实现 ${origin.name}::${m.name}` : `重写 ${origin.name}::${m.name}`);

  // 去向：子类重写数（具体方法实现）
  const ownerLower = owner.fqn.toLowerCase();
  let overrides = 0;
  for (const candidate of await workspaceClasses(engine)) {
    if (candidate.fqn.toLowerCase() === ownerLower) continue;
    const impl = candidate.methods.find((mm) => mm.name === m.name && !mm.isAbstract);
    if (!impl) continue;
    const sets = await hierarchySets(engine, candidate);
    const related =
      owner.kind === 'interface'
        ? sets.interfaces.has(ownerLower)
        : owner.kind === 'trait'
          ? await usesTrait(engine, candidate, ownerLower)
          : sets.classes.has(ownerLower);
    if (related) overrides++;
  }
  if (overrides > 0) parts.push(`被 ${overrides} 个子类重写`);

  if (parts.length === 0) return { range: lens.range };
  const title = parts.join(' · ');
  return { range: lens.range, command: { title, command: LENS_COMMAND, arguments: [data.uri, lens.range.start, data] }, data };
}

/** 最近祖先同名声明（extends 链 + implements + trait use，防环限深） */
async function nearestAncestorDeclaration(
  engine: NavigationEngine,
  owner: ClassSym,
  methodName: string,
): Promise<{ name: string; kind: string } | undefined> {
  const seen = new Set<string>([owner.fqn.toLowerCase()]);
  let queue: ClassSym[] = [owner];
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && queue.length > 0; depth++) {
    const next: ClassSym[] = [];
    for (const cls of queue) {
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
      for (const fqn of supers) {
        const lower = fqn.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        const sym = await engine.resolveClass(fqn);
        if (!sym) continue;
        if (sym.methods.some((mm) => mm.name === methodName)) return { name: sym.name, kind: sym.kind };
        next.push(sym);
      }
    }
    queue = next;
  }
  return undefined;
}

const MAX_ANCESTOR_DEPTH = 8;

/** ---------- 小工具 ---------- */

function walkNodes(root: any, visit: (node: any) => void): void {
  const stack: any[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (typeof node.kind === 'string') visit(node);
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const value = (node as Record<string, unknown>)[key];
      if (value && typeof value === 'object') stack.push(value);
    }
  }
}

/** lookup 节点（按起点）所在的最小类节点对应符号 */
function enclosingClassOf(view: ParsedDocLike, target: any): ClassSym | undefined {
  const ts = target.loc?.start?.offset ?? -1;
  const te = target.loc?.end?.offset ?? -1;
  let best: ClassSym | undefined;
  let bestSize = Infinity;
  for (const { sym, node } of view.classNodes) {
    if (!node.loc) continue;
    const s = node.loc.start.offset;
    const e = node.loc.end.offset;
    if (ts >= s && te <= e && e - s < bestSize) {
      best = sym;
      bestSize = e - s;
    }
  }
  return best;
}
