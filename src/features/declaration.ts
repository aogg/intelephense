/**
 * features/declaration.ts：textDocument/declaration（go to declaration，自研，官方免费版关闭）。
 * 语义（vip-features §4 / phpstorm-gap P0-6）：
 *  - 实现类方法 → 沿继承链向上找（接口优先、其次抽象/普通父类）首个同签名声明；
 *  - 接口/抽象方法声明处 → 跳到实现（双向，复用 implementation）；
 *  - 虚拟属性（类 docblock @property 通道）→ docblock 中 @property $name 标签精确 range；
 *  - 普通属性 → 属性声明行（含父类/trait 来源，findMember 已落声明文件）。
 */

import { plainName } from '../engine/ast';
import { resolveTypeRaw } from '../engine/resolver';
import type { ClassSym } from '../engine/symbols';
import { docblockPropertyTagRange, hitAtPosition, type NavigationEngine, type DefinitionParamsLike, type LocationLike } from './navigation';
import { implementationsOfMember } from './implementation';

export async function navigationDeclaration(engine: NavigationEngine, params: DefinitionParamsLike): Promise<LocationLike[] | null> {
  const doc = await engine.getDoc(params.textDocument.uri);
  if (!doc) return null;
  const line = params.position.line;
  const character = params.position.character;
  const hit = (await hitAtPosition(engine, doc, line, character)) ?? declarationRefAt(doc, line, character);
  if (!hit) return null;

  if (hit.kind === 'class') {
    return [{ uri: hit.sym.uri, range: hit.sym.selectionRange }];
  }

  const ref = hit.ref;
  if (ref.kind === 'method' && ref.method) {
    const m = ref.method;
    // 双向：光标在接口/抽象方法声明处 → 跳到全部实现
    if (ref.owner.kind === 'interface' || m.isAbstract) {
      const impls = await implementationsOfMember(engine, ref);
      if (impls.length > 0) return impls;
    }
    const sup = await firstSuperMethodDeclaration(engine, ref.owner, m.name);
    if (sup) return [sup];
    return [{ uri: m.uri, range: m.selectionRange }];
  }

  if (ref.kind === 'property' && ref.property) {
    const p = ref.property;
    if (p.originVirtual) {
      // B 通道：声明处即宿主类 docblock 的 @property 标签（跨文件父链时宿主文档另取，不能拿当前文档找宿主类）
      const ownerDoc = ref.owner.uri === doc.uri ? doc : await engine.getDoc(ref.owner.uri);
      const tag = ownerDoc ? docblockPropertyTagRange(ownerDoc, ref.owner, p.name) : undefined;
      if (tag) return [tag];
    }
    return [{ uri: p.uri, range: p.selectionRange }];
  }
  // 常量：落常量声明
  return [{ uri: ref.owner.uri, range: ref.owner.selectionRange }];
}

/** 声明处光标兜底：类名/方法名/属性名/类常量名本身（hitAtPosition 只认引用形态） */
function declarationRefAt(doc: any, line: number, character: number): { kind: 'class'; sym: ClassSym } | { kind: 'member'; ref: any } | undefined {
  const classNodes: { sym: ClassSym; node: any }[] = doc.classNodes ?? [];
  for (const { sym, node } of classNodes) {
    if (inSpan(sym.selectionRange, line, character)) return { kind: 'class', sym };
    for (const member of node.body ?? []) {
      if (member.kind === 'method') {
        const method = sym.methods.find((mm) => mm.name.toLowerCase() === (plainName(member.name) ?? '').toLowerCase());
        if (method && inSpan(method.selectionRange, line, character)) {
          return { kind: 'member', ref: { name: method.name, kind: 'method', method, owner: sym, origin: 'class' } };
        }
      } else if (member.kind === 'propertystatement') {
        for (const prop of member.properties ?? []) {
          const name = plainName(prop.name);
          const psym = sym.properties.find((pp) => pp.name === name);
          if (!psym || !prop.loc) continue;
          if (inSpan(prop.selectionRange ?? rangeOfNode(prop), line, character)) {
            return { kind: 'member', ref: { name: psym.name, kind: 'property', property: psym, owner: sym, origin: 'class' } };
          }
        }
      } else if (member.kind === 'classconstant') {
        const c = sym.constants.find((cc) => cc.name === plainName(member.name));
        if (c && c.selectionRange && inSpan(c.selectionRange, line, character)) {
          return { kind: 'member', ref: { name: c.name, kind: 'constant', owner: sym, origin: 'class' } };
        }
      }
    }
  }
  return undefined;
}

function rangeOfNode(node: any): LocationLike['range'] {
  const loc = node?.loc;
  if (!loc || !loc.start) return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  return {
    start: { line: loc.start.line - 1, character: loc.start.column },
    end: { line: loc.end.line - 1, character: loc.end.column },
  };
}

function inSpan(range: LocationLike['range'], line: number, character: number): boolean {
  const { start, end } = range;
  if (line < start.line || line > end.line) return false;
  if (line === start.line && character < start.character) return false;
  if (line === end.line && character > end.character) return false;
  return true;
}

/** 沿 implements（接口优先）→ extends 逐级向上找首个同签名方法声明（跳过与自身相同位置） */
async function firstSuperMethodDeclaration(engine: NavigationEngine, owner: ClassSym, methodName: string): Promise<LocationLike | undefined> {
  const own = owner.methods.find((mm) => mm.name.toLowerCase() === methodName.toLowerCase());
  const ownKey = own ? `${own.uri}#${own.selectionRange.start.line}:${own.selectionRange.start.character}` : '';
  const queue: ClassSym[] = [owner];
  const seen = new Set<string>();
  let guard = 0;
  while (queue.length > 0 && guard++ < 64) {
    const cur = queue.shift()!;
    const lower = cur.fqn.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const file = engine.index.files.get(cur.uri);
    const edges: ClassSym[] = [];
    for (const raw of cur.implementsRaw ?? []) {
      const fqn = resolveTypeRaw(raw, file, cur.fqn)[0];
      if (fqn) {
        const c = await engine.resolveClass(fqn);
        if (c) edges.push(c);
      }
    }
    for (const raw of cur.extendsRaw ?? []) {
      const fqn = resolveTypeRaw(raw, file, cur.fqn)[0];
      if (fqn) {
        const c = await engine.resolveClass(fqn);
        if (c) edges.push(c);
      }
    }
    for (const edge of edges) {
      const dm = edge.methods.find((mm) => mm.name.toLowerCase() === methodName.toLowerCase());
      if (dm) {
        const key = `${dm.uri}#${dm.selectionRange.start.line}:${dm.selectionRange.start.character}`;
        if (key !== ownKey) return { uri: dm.uri, range: dm.selectionRange };
      }
      queue.push(edge);
    }
  }
  return undefined;
}
