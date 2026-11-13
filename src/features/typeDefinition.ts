/**
 * features/typeDefinition.ts：textDocument/typeDefinition（go to type definition，自研，官方免费版关闭）。
 * 语义：对符号引用解析出其静态类型，再跳到类型声明处（vip-features §3）：
 *  - `$this->auth` → 成员类型推断（原生/属性 docblock @var/赋值推断三通道）→ Auth 类声明；
 *  - 变量 `$model = new ProductModel()` → 赋值推断类型；
 *  - 类名引用 → 类自身声明（与 definition 一致）；
 *  - 推不出类型 → 返回 null（诚实降级，不误跳）。
 */

import { hitAtPosition, containingNodes, validPositionParams, type NavigationEngine, type DefinitionParamsLike, type LocationLike } from './navigation';
import { enclosingClass, resolveReceiverFqns, type ParsedDocLike } from '../engine/member';
import type { ClassSym } from '../engine/symbols';

export async function navigationTypeDefinition(engine: NavigationEngine, params: DefinitionParamsLike): Promise<LocationLike[] | null> {
  const p = validPositionParams(params);
  if (!p) return null;
  const doc = await engine.getDoc(p.uri);
  if (!doc) return null;
  const line = p.line;
  const character = p.character;
  const hit = await hitAtPosition(engine, doc, line, character);
  if (hit) {
    const fqns = hit.kind === 'class' ? [hit.sym.fqn] : hit.typeFqns;
    const locations = await classLocations(engine, fqns);
    if (locations.length > 0) return locations;
    // 类引用自身已在结果里；成员类型推不出 → 继续走变量通道兜底
    if (hit.kind === 'class') return null;
  }

  // 变量接收者（$var = new X / X::factory()）：光标落在变量节点上
  const view: ParsedDocLike = { uri: doc.uri, ast: doc.ast, classNodes: (doc as any).classNodes ?? [] };
  const ownerClass = enclosingClass(view, line, character);
  const varNode = containingNodes(doc, line, character).find((n) => n.kind === 'variable');
  if (varNode) {
    const name = typeof varNode.name === 'string' ? varNode.name : undefined;
    if (name && name !== 'this') {
      const fqns = await resolveReceiverFqns(varNode, view, ownerClass, engine.ctx);
      const locations = await classLocations(engine, fqns);
      if (locations.length > 0) return locations;
    }
  }
  return null;
}

async function classLocations(engine: NavigationEngine, fqns: string[]): Promise<LocationLike[]> {
  const out: LocationLike[] = [];
  const seen = new Set<string>();
  for (const fqn of fqns ?? []) {
    const cls: ClassSym | undefined = await engine.resolveClass(fqn);
    if (!cls || seen.has(cls.fqn.toLowerCase())) continue;
    seen.add(cls.fqn.toLowerCase());
    out.push({ uri: cls.uri, range: cls.selectionRange });
  }
  return out;
}
