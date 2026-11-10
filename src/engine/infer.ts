/**
 * engine/infer.ts：属性类型推断（architecture.md §4.6 优先级）。
 * 每级类内按序：1 原生声明 → 2 属性 docblock @var（A 通道）→ 3 赋值推断（C 通道）
 * → 4 类 docblock @property（B 通道）→ 递归 trait → 递归父类 → unknown（诚实降级）。
 * 赋值推断：$this->P = <expr>；new X → X；X::factory() → 返回类型或方法体 new self/static。
 */

import { walk, rawTypeOf } from './ast';
import type { ClassSym, FileIndex, MethodSym, PropertySym, WorkspaceIndex } from './symbols';
import { resolveTypeRaw } from './resolver';

export type InferChannel = 'native' | 'docvar' | 'docproperty' | 'assign' | 'unknown';

export interface InferResult {
  fqns: string[];
  channel: InferChannel;
  detail: string;
}

export interface InferContext {
  index: WorkspaceIndex;
  resolveClass: (fqn: string) => Promise<ClassSym | undefined>;
  maxDepth?: number;
}

export async function inferPropertyTypes(owner: ClassSym, propName: string, ctx: InferContext): Promise<InferResult> {
  return inferInHierarchy(owner, propName, ctx, new Set<string>(), 0);
}

async function inferInHierarchy(
  cls: ClassSym,
  propName: string,
  ctx: InferContext,
  visited: Set<string>,
  depth: number,
): Promise<InferResult> {
  const key = cls.fqn.toLowerCase();
  if (visited.has(key) || depth > 8) return { fqns: [], channel: 'unknown', detail: '' };
  visited.add(key);
  const file: FileIndex | undefined = ctx.index.files.get(cls.uri);

  // 1/2. 原生声明 与 属性 docblock @var（A 通道）
  const declared: PropertySym | undefined = cls.properties.find((p) => p.name === propName);
  if (declared) {
    if (declared.typeRaw) {
      const fqns = resolveTypeRaw(declared.typeRaw, file, cls.fqn);
      if (fqns.length > 0) {
        return { fqns, channel: 'native', detail: `${cls.name}::$${propName} 原生类型 ${declared.typeRaw}` };
      }
    }
    if (declared.docType) {
      const fqns = resolveTypeRaw(declared.docType, file, cls.fqn);
      if (fqns.length > 0) {
        return { fqns, channel: 'docvar', detail: `${cls.name}::$${propName} docblock @var ${declared.docType}` };
      }
    }
  }

  // 3. 赋值推断（C 通道）：本类方法体内 $this->P = expr（声明与否都扫，覆盖动态属性）
  const assignFqns: string[] = [];
  for (const method of cls.methods) {
    for (const fqn of await inferFromAssignments(method, propName, cls, ctx)) {
      if (!assignFqns.includes(fqn)) assignFqns.push(fqn);
    }
  }
  if (assignFqns.length > 0) {
    return { fqns: assignFqns, channel: 'assign', detail: `${cls.name} 方法体内赋值推断` };
  }

  // 4. 类 docblock @property（B 通道）
  if (cls.docblock) {
    const virtual = cls.docblock.properties.find((p) => p.name === propName);
    if (virtual) {
      const fqns = resolveTypeRaw(virtual.type, file, cls.fqn);
      if (fqns.length > 0) {
        return { fqns, channel: 'docproperty', detail: `${cls.name} 类 docblock @property ${virtual.type} $${propName}` };
      }
    }
  }

  // 递归 trait → 父类
  for (const t of cls.traitUses) {
    const traitFqn = resolveTypeRaw(t.raw, file, cls.fqn)[0];
    if (!traitFqn) continue;
    const traitSym = await ctx.resolveClass(traitFqn);
    if (traitSym) {
      const r = await inferInHierarchy(traitSym, propName, ctx, visited, depth + 1);
      if (r.fqns.length > 0) return r;
    }
  }
  for (const parentRaw of cls.extendsRaw) {
    const parentFqn = resolveTypeRaw(parentRaw, file, cls.fqn)[0];
    if (!parentFqn) continue;
    const parent = await ctx.resolveClass(parentFqn);
    if (parent) {
      const r = await inferInHierarchy(parent, propName, ctx, visited, depth + 1);
      if (r.fqns.length > 0) return r;
    }
  }

  return { fqns: [], channel: 'unknown', detail: `推不出 ${cls.name}::$${propName}` };
}

/** 方法体内 $this->P = expr 的右值类型推断（先把被调类异步解析入索引，再同步求值） */
async function inferFromAssignments(method: MethodSym, propName: string, owner: ClassSym, ctx: InferContext): Promise<string[]> {
  const body = method.astNode?.body;
  if (!body) return [];
  // 预解析：赋值表达式里出现的静态调用类
  const referenced: string[] = [];
  const file: FileIndex | undefined = ctx.index.files.get(owner.uri);
  walk(body, (node) => {
    if (node.kind !== 'call' || !node.what || node.what.kind !== 'staticlookup') return;
    const classRaw = rawTypeOf(node.what.what);
    if (!classRaw) return;
    const fqn = resolveTypeRaw(classRaw, file, owner.fqn)[0];
    if (fqn && !referenced.includes(fqn)) referenced.push(fqn);
  });
  for (const fqn of referenced) await ctx.resolveClass(fqn);

  const fqns: string[] = [];
  walk(body, (node) => {
    if (node.kind !== 'assign') return;
    const left = node.left;
    if (!left || left.kind !== 'propertylookup') return;
    const what = left.what;
    if (!what || what.kind !== 'variable' || what.name !== 'this') return;
    const target = left.offset && (typeof left.offset.name === 'string' ? left.offset.name : left.offset.name?.name);
    if (target !== propName) return;
    const fqn = inferStaticOrNew(node.right, owner, ctx);
    if (fqn && !fqns.includes(fqn)) fqns.push(fqn);
  });
  return fqns;
}

/** 表达式 → 类 FQN（同步；new X 与 X::m()，被调类需已入索引） */
function inferStaticOrNew(expr: any, owner: ClassSym, ctx: InferContext): string | undefined {
  if (!expr || typeof expr !== 'object') return undefined;
  const file: FileIndex | undefined = ctx.index.files.get(owner.uri);
  switch (expr.kind) {
    case 'new': {
      const what = expr.what;
      if (what && (what.kind === 'staticreference' || what.kind === 'selfreference')) {
        return owner.fqn; // new static/self → 当前类（调用点所在类）
      }
      const raw = rawTypeOf(what);
      return raw ? resolveTypeRaw(raw, file, owner.fqn)[0] : undefined;
    }
    case 'call': {
      const what = expr.what;
      if (what && what.kind === 'staticlookup') return staticCallType(what, owner, ctx);
      return undefined;
    }
    default:
      return undefined;
  }
}

/** X::m() 返回类型：原生 → docblock @return → 方法体 new self/static（被调类已入索引时） */
function staticCallType(lookup: any, owner: ClassSym, ctx: InferContext): string | undefined {
  const classRaw = rawTypeOf(lookup.what);
  if (!classRaw) return undefined;
  const file: FileIndex | undefined = ctx.index.files.get(owner.uri);
  const classFqn = resolveTypeRaw(classRaw, file, owner.fqn)[0];
  if (!classFqn) return undefined;
  const target = ctx.index.byFqn.get(classFqn.toLowerCase());
  if (!target) return undefined;
  const offset = lookup.offset;
  const methodName = offset && offset.kind === 'call' ? offset.what && offset.what.name : offset && offset.name;
  if (typeof methodName !== 'string') return undefined;
  const m = findMethodSync(target, methodName, ctx.index);
  if (!m) return undefined;
  const mFile: FileIndex | undefined = ctx.index.files.get(m.uri);
  if (m.returnTypeRaw) return resolveTypeRaw(m.returnTypeRaw, mFile, target.fqn)[0];
  if (m.docblock && m.docblock.returns.length > 0) return resolveTypeRaw(m.docblock.returns[0], mFile, target.fqn)[0];
  if (m.returnsNewSelf) return classFqn;
  return undefined;
}

function findMethodSync(cls: ClassSym, name: string, index: WorkspaceIndex): MethodSym | undefined {
  let cur: ClassSym | undefined = cls;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.fqn.toLowerCase())) {
    seen.add(cur.fqn.toLowerCase());
    const m = cur.methods.find((mm) => mm.name === name);
    if (m) return m;
    const file: FileIndex | undefined = index.files.get(cur.uri);
    let next: ClassSym | undefined;
    for (const parentRaw of cur.extendsRaw) {
      const parentFqn = resolveTypeRaw(parentRaw, file, cur.fqn)[0];
      if (parentFqn) {
        next = index.byFqn.get(parentFqn.toLowerCase());
        if (next) break;
      }
    }
    cur = next;
  }
  return undefined;
}
