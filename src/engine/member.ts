/**
 * engine/member.ts：有效成员表 + $this->xxx 解析（architecture.md §4.5/§4.7）。
 * 合并顺序：本类声明 → trait 展开（adaptation 语义）→ 类 docblock @property → 父类链逐级向上。
 * @mixin 本阶段解析存储、不合并成员（T4）。
 */

import { walk, rawTypeOf, nodeContains, plainName } from './ast';
import type { ClassSym, FileIndex, MethodSym, PropertySym, WorkspaceIndex } from './symbols';
import { resolveTypeRaw } from './resolver';
import { inferPropertyTypes } from './infer';

export type MemberKind = 'property' | 'method' | 'constant';

export interface MemberRef {
  name: string;
  kind: MemberKind;
  property?: PropertySym;
  method?: MethodSym;
  owner: ClassSym;
  origin: string; // class | trait:<fqn> | docblock | parent:<fqn>
}

/** 解析层所需的文档视图（engine.ts 持有 classNodes 索引） */
export interface ParsedDocLike {
  uri: string;
  ast: any;
  classNodes: { sym: ClassSym; node: any }[];
}

export interface EngineContext {
  index: WorkspaceIndex;
  resolveClass: (fqn: string) => Promise<ClassSym | undefined>;
}

/** 类的有效成员表（含 trait 展开 / docblock @property / 父类链） */
export async function effectiveMembers(cls: ClassSym, ctx: EngineContext, depth = 0): Promise<Map<string, MemberRef>> {
  const out = new Map<string, MemberRef>();
  if (depth > 8) return out;
  const put = (ref: MemberRef): void => {
    if (!out.has(ref.name)) out.set(ref.name, ref);
  };

  // 本类声明
  for (const p of cls.properties) put({ name: p.name, kind: 'property', property: p, owner: cls, origin: 'class' });
  for (const m of cls.methods) put({ name: m.name, kind: 'method', method: m, owner: cls, origin: 'class' });
  for (const c of cls.constants) put({ name: c.name, kind: 'constant', owner: cls, origin: 'class' });

  // trait 展开（adaptation：traitalias 改名/可见性；traitprecedence 指定胜者）
  const file: FileIndex | undefined = ctx.index.files.get(cls.uri);
  const traitFqns = cls.traitUses.map((t) => resolveTypeRaw(t.raw, file, cls.fqn)[0]).filter((x): x is string => !!x);
  const traitMembers = new Map<string, { ref: MemberRef; fromTraitRaw: string }>();
  for (let i = 0; i < cls.traitUses.length; i++) {
    const traitFqn = traitFqns[i];
    if (!traitFqn) continue;
    const traitSym = await ctx.resolveClass(traitFqn);
    if (!traitSym) continue;
    const members = await effectiveMembers(traitSym, ctx, depth + 1);
    for (const [name, ref] of members) {
      if (ref.origin.startsWith('parent:')) continue; // trait 不带上其父类成员
      if (!traitMembers.has(name)) traitMembers.set(name, { ref: { ...ref, origin: `trait:${traitSym.fqn}` }, fromTraitRaw: cls.traitUses[i].raw });
    }
  }
  // adaptation 处理
  const winners = new Set<string>(); // precedence 指定胜者 (traitRawLower::method)
  const losers = new Set<string>(); // insteadof 被排除 (traitRawLower::method)
  const renamed = new Map<string, { newName: string; visibility?: string }>();
  for (const t of cls.traitUses) {
    for (const ad of t.adaptations) {
      if (ad.precedence) {
        winners.add(`${ad.precedence.traitRaw.toLowerCase()}::${ad.precedence.method}`);
        for (const insteadRaw of ad.precedence.insteadOf) losers.add(`${insteadRaw.toLowerCase()}::${ad.precedence.method}`);
      }
      if (ad.alias) {
        renamed.set(`${(ad.alias.traitRaw ?? '').toLowerCase()}::${ad.alias.method}`, {
          newName: ad.alias.newName ?? ad.alias.method,
          visibility: ad.alias.visibility,
        });
      }
    }
  }
  for (const [name, { ref, fromTraitRaw }] of traitMembers) {
    const key = `${fromTraitRaw.toLowerCase()}::${name}`;
    if (losers.has(key) && !winners.has(key)) continue;
    const rename = renamed.get(key);
    const finalRef: MemberRef = { ...ref, name: rename?.newName ?? name };
    if (rename && rename.visibility && finalRef.method) {
      finalRef.method = { ...finalRef.method, visibility: rename.visibility };
    }
    put(finalRef);
  }

  // 类 docblock @property（B 通道虚拟属性）
  if (cls.docblock) {
    for (const dp of cls.docblock.properties) {
      if (out.has(dp.name)) continue;
      const virtual: PropertySym = {
        name: dp.name,
        uri: cls.uri,
        range: cls.range,
        selectionRange: cls.selectionRange,
        docType: dp.type,
        visibility: 'public',
        isStatic: false,
        originVirtual: true,
      };
      put({ name: dp.name, kind: 'property', property: virtual, owner: cls, origin: 'docblock' });
    }
  }

  // 父类链
  for (const parentRaw of cls.extendsRaw) {
    const parentFqn = resolveTypeRaw(parentRaw, file, cls.fqn)[0];
    if (!parentFqn) continue;
    const parent = await ctx.resolveClass(parentFqn);
    if (!parent) continue;
    const parentMembers = await effectiveMembers(parent, ctx, depth + 1);
    for (const [name, ref] of parentMembers) put({ ...ref, origin: `parent:${parent.fqn}` });
  }
  return out;
}

export async function findMember(owner: ClassSym, memberName: string, ctx: EngineContext): Promise<MemberRef | undefined> {
  const members = await effectiveMembers(owner, ctx);
  return members.get(memberName);
}

/** 成员的类型 FQN（属性：原生→docvar→赋值→docblock @property；方法：返回类型） */
export async function memberTypes(ref: MemberRef, ctx: EngineContext): Promise<{ fqns: string[]; detail: string }> {
  if (ref.kind === 'property' && ref.property) {
    const p = ref.property;
    const file: FileIndex | undefined = ctx.index.files.get(ref.owner.uri);
    if (p.typeRaw) {
      const fqns = resolveTypeRaw(p.typeRaw, file, ref.owner.fqn);
      if (fqns.length > 0) return { fqns, detail: `${ref.owner.name}::$${p.name} 原生类型 ${p.typeRaw}` };
    }
    if (p.docType) {
      const fqns = resolveTypeRaw(p.docType, file, ref.owner.fqn);
      if (fqns.length > 0) return { fqns, detail: `${ref.owner.name}::$${p.name} docblock @var ${p.docType}` };
    }
    const r = await inferPropertyTypes(ref.owner, p.name, ctx);
    if (r.fqns.length > 0) return { fqns: r.fqns, detail: r.detail };
    return { fqns: [], detail: '' };
  }
  if (ref.kind === 'method' && ref.method) {
    const m = ref.method;
    const file: FileIndex | undefined = ctx.index.files.get(m.uri);
    if (m.returnTypeRaw) {
      const fqns = resolveTypeRaw(m.returnTypeRaw, file, ref.owner.fqn);
      if (fqns.length > 0) return { fqns, detail: `${ref.owner.name}::${m.name}() 返回类型 ${m.returnTypeRaw}` };
    }
    if (m.docblock && m.docblock.returns.length > 0) {
      const fqns = resolveTypeRaw(m.docblock.returns[0], file, ref.owner.fqn);
      if (fqns.length > 0) return { fqns, detail: `${ref.owner.name}::${m.name}() docblock @return` };
    }
  }
  return { fqns: [], detail: '' };
}

/** 定位 0 基位置所在的类符号 */
export function enclosingClass(doc: ParsedDocLike, line: number, character: number): ClassSym | undefined {
  for (const { sym, node } of doc.classNodes) {
    if (nodeContains(node, line, character)) return sym;
  }
  return undefined;
}

/** 表达式节点（variable / propertylookup / name）的静态类型 FQN 列表 */
export async function resolveReceiverFqns(
  node: any,
  doc: ParsedDocLike,
  ownerClass: ClassSym | undefined,
  ctx: EngineContext,
): Promise<string[]> {
  if (!node) return [];
  if (node.kind === 'variable') {
    const name = typeof node.name === 'string' ? node.name : plainName(node);
    if (name === 'this') return ownerClass ? [ownerClass.fqn] : [];
    if (!name) return [];
    return inferVariableType(node, name, doc, ownerClass, ctx);
  }
  if (node.kind === 'propertylookup' || node.kind === 'methodlookup') {
    // 链式：$this->auth → 先解析 receiver 类型，再找成员类型
    const receiverFqns = await resolveReceiverFqns(node.what, doc, ownerClass, ctx);
    const memberName = node.offset && (typeof node.offset.name === 'string' ? node.offset.name : plainName(node.offset));
    if (!memberName || receiverFqns.length === 0) return [];
    for (const fqn of receiverFqns) {
      const cls = await ctx.resolveClass(fqn);
      if (!cls) continue;
      const ref = await findMember(cls, memberName, ctx);
      if (!ref) continue;
      const t = await memberTypes(ref, ctx);
      if (t.fqns.length > 0) return t.fqns;
    }
    return [];
  }
  const raw = rawTypeOf(node);
  if (raw) {
    const file: FileIndex | undefined = ownerClass ? ctx.index.files.get(ownerClass.uri) : undefined;
    return resolveTypeRaw(raw, file, ownerClass?.fqn);
  }
  return [];
}

/** 变量类型推断：外层函数体/方法体内 $name = <expr>（new X / X::factory()） */
async function inferVariableType(
  varNode: any,
  name: string,
  doc: ParsedDocLike,
  ownerClass: ClassSym | undefined,
  ctx: EngineContext,
): Promise<string[]> {
  const fnNode = findEnclosingFunction(doc, varNode);
  if (!fnNode) return [];
  const fqns: string[] = [];
  walk(fnNode, (node) => {
    if (node.kind !== 'assign') return;
    const left = node.left;
    if (!left || left.kind !== 'variable') return;
    if (left.name !== name) return;
    const right = node.right;
    if (!right) return;
    const file: FileIndex | undefined = ownerClass ? ctx.index.files.get(ownerClass.uri) : undefined;
    if (right.kind === 'new') {
      const raw = rawTypeOf(right.what);
      const fqn = raw ? resolveTypeRaw(raw, file, ownerClass?.fqn)[0] : undefined;
      if (fqn && !fqns.includes(fqn)) fqns.push(fqn);
    } else if (right.kind === 'call' && right.what && right.what.kind === 'staticlookup') {
      const lookup = right.what;
      const classRaw = rawTypeOf(lookup.what);
      const classFqn = classRaw ? resolveTypeRaw(classRaw, file, ownerClass?.fqn)[0] : undefined;
      if (!classFqn) return;
      const target = ctx.index.byFqn.get(classFqn.toLowerCase());
      if (!target) return;
      const offset = lookup.offset;
      const methodName = offset && offset.kind === 'call' ? offset.what && offset.what.name : offset && offset.name;
      const m = typeof methodName === 'string' ? target.methods.find((mm) => mm.name === methodName) : undefined;
      if (!m) return;
      if (m.returnsNewSelf) {
        if (!fqns.includes(classFqn)) fqns.push(classFqn);
        return;
      }
      if (m.returnTypeRaw) {
        const mFile: FileIndex | undefined = ctx.index.files.get(m.uri);
        const fqn = resolveTypeRaw(m.returnTypeRaw, mFile, target.fqn)[0];
        if (fqn && !fqns.includes(fqn)) fqns.push(fqn);
      } else if (m.docblock && m.docblock.returns.length > 0) {
        const mFile: FileIndex | undefined = ctx.index.files.get(m.uri);
        const fqn = resolveTypeRaw(m.docblock.returns[0], mFile, target.fqn)[0];
        if (fqn && !fqns.includes(fqn)) fqns.push(fqn);
      }
    }
  });
  return fqns;
}

function findEnclosingFunction(doc: ParsedDocLike, target: any): any | undefined {
  let best: any | undefined;
  let bestSize = Infinity;
  const consider = (node: any): void => {
    if (!node || !node.loc) return;
    const kind = node.kind;
    if (kind !== 'method' && kind !== 'function' && kind !== 'closure' && kind !== 'arrowfn' && kind !== 'arrowfunction') return;
    const ts = target.loc?.start?.offset ?? -1;
    const te = target.loc?.end?.offset ?? -1;
    const s = node.loc.start.offset;
    const e = node.loc.end.offset;
    if (ts >= s && te <= e && e - s < bestSize) {
      best = node;
      bestSize = e - s;
    }
  };
  for (const { node } of doc.classNodes) walk(node, consider);
  walk(doc.ast, consider);
  return best;
}
