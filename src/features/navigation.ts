/**
 * features/navigation.ts：definition / hover / completion 的自研实现（auth 案例关键路径）。
 * 解析光标处成员引用：定位最内层 propertylookup/methodlookup/staticlookup →
 * 接收者类型（$this→类作用域 / 变量赋值推断 / 链式成员类型）→ 成员符号与类型。
 */

import { walk, plainName, locToRange } from '../engine/ast';
import type { ParsedDoc } from '../engine/ast';
import { effectiveMembers, findMember, memberTypes, enclosingClass, resolveReceiverFqns, type MemberRef, type ParsedDocLike, type EngineContext } from '../engine/member';
import { resolveTypeRaw } from '../engine/resolver';
import type { ClassSym } from '../engine/symbols';

/** navigation 所需的引擎最小结构（engine.Engine 结构化满足，避免模块环依赖） */
export interface NavigationEngine {
  ctx: EngineContext;
  index: import('../engine/symbols').WorkspaceIndex;
  getDoc(uri: string): Promise<(import('../engine/ast').ParsedDoc & { classNodes?: { sym: ClassSym; node: any }[] }) | undefined>;
  resolveClass(fqn: string): Promise<ClassSym | undefined>;
}

export interface DefinitionParamsLike {
  textDocument: { uri: string };
  position: { line: number; character: number };
}

export interface LocationLike {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

/** ---------- 内部：光标解析 ---------- */

export interface MemberHit {
  kind: 'member';
  ref: MemberRef;
  typeFqns: string[];
  typeDetail: string;
  memberRange: LocationLike['range'];
}

export interface ClassHit {
  kind: 'class';
  sym: ClassSym;
}

export type CursorHit = MemberHit | ClassHit;

export function containingNodes(doc: ParsedDoc, line: number, character: number): any[] {
  const out: any[] = [];
  walk(doc.ast, (node) => {
    const loc = node.loc;
    if (!loc || !loc.start || !loc.end) return;
    const sl = loc.start.line - 1;
    const el = loc.end.line - 1;
    if (line < sl || line > el) return;
    if (line === sl && character < loc.start.column) return;
    if (line === el && character > loc.end.column) return;
    out.push(node);
  });
  out.sort((a, b) => (a.loc.end.offset - a.loc.start.offset) - (b.loc.end.offset - b.loc.start.offset));
  return out;
}

export async function hitAtPosition(engine: NavigationEngine, doc: ParsedDoc, line: number, character: number): Promise<CursorHit | undefined> {
  const ctx = engine.ctx;
  const view: ParsedDocLike = { uri: doc.uri, ast: doc.ast, classNodes: (doc as any).classNodes ?? [] };
  const ownerClass = enclosingClass(view, line, character);
  const candidates = containingNodes(doc, line, character);

  // 1) 成员访问节点（最内层优先）
  for (const node of candidates) {
    if (node.kind !== 'propertylookup' && node.kind !== 'methodlookup' && node.kind !== 'staticlookup') continue;
    const offset = node.offset;
    if (!offset || !offset.loc) continue;
    const nameNode = offset.kind === 'call' ? offset.what : offset;
    if (!nameNode || !nameNode.loc) continue;
    if (!inLoc(line, character, nameNode.loc)) continue;
    const memberName = plainName(nameNode);
    if (!memberName || memberName === 'name') continue;

    const receiverFqns =
      node.kind === 'staticlookup'
        ? staticClassFqns(node.what, doc, ownerClass, ctx)
        : await resolveReceiverFqns(node.what, view, ownerClass, ctx);
    for (const fqn of receiverFqns) {
      const cls = await engine.resolveClass(fqn);
      if (!cls) continue;
      const ref = await findMember(cls, memberName, ctx);
      if (!ref) continue;
      const t = await memberTypes(ref, ctx);
      return {
        kind: 'member',
        ref,
        typeFqns: t.fqns,
        typeDetail: t.detail,
        memberRange: locToRange(nameNode.loc),
      };
    }
    // 接收者类型解析失败：成员命中不了，降级返回 undefined（诚实）
    return undefined;
  }

  // 2) 类名引用（extends/implements/new/use/静态类名）
  for (const node of candidates) {
    if (node.kind !== 'name' && node.kind !== 'identifier') continue;
    if (!node.loc || !inLoc(line, character, node.loc)) continue;
    // 作为类引用的场景：new X、extends X、staticlookup.what、useitem
    const name = typeof node.name === 'string' ? node.name : plainName(node);
    if (!name || ['this', 'self', 'static', 'parent'].includes(name)) continue;
    const file = undefined;
    void file;
    const fqns = resolveTypeRaw(name, engine.index.files.get(doc.uri), ownerClass?.fqn);
    for (const fqn of fqns) {
      const cls = await engine.resolveClass(fqn);
      if (cls) return { kind: 'class', sym: cls };
    }
    // 限定名（含 \）直接尝试
    if (name.includes('\\') || name.startsWith('\\')) {
      const cls = await engine.resolveClass(name.startsWith('\\') ? name : '\\' + name);
      if (cls) return { kind: 'class', sym: cls };
    }
    return undefined;
  }
  return undefined;
}

function staticClassFqns(whatNode: any, doc: ParsedDoc, ownerClass: ClassSym | undefined, ctx: EngineContext): string[] {
  const raw = typeof whatNode?.name === 'string' ? whatNode.name : plainName(whatNode);
  if (!raw) return [];
  if (['self', 'static'].includes(raw) && ownerClass) return [ownerClass.fqn];
  return resolveTypeRaw(raw, ctx.index.files.get(doc.uri), ownerClass?.fqn);
}

function inLoc(line: number, character: number, loc: any): boolean {
  const sl = loc.start.line - 1;
  const el = loc.end.line - 1;
  if (line < sl || line > el) return false;
  if (line === sl && character < loc.start.column) return false;
  if (line === el && character > loc.end.column) return false;
  return true;
}

/** ---------- definition ---------- */

export async function navigationDefinition(engine: NavigationEngine, params: DefinitionParamsLike): Promise<LocationLike[] | null> {
  const doc = await engine.getDoc(params.textDocument.uri);
  if (!doc) return null;
  const hit = await hitAtPosition(engine, doc, params.position.line, params.position.character);
  if (!hit) return null;
  if (hit.kind === 'class') {
    return [{ uri: hit.sym.uri, range: hit.sym.selectionRange }];
  }
  const ref = hit.ref;
  if (ref.kind === 'property' && ref.property) {
    return [{ uri: ref.property.uri, range: ref.property.selectionRange }];
  }
  if (ref.kind === 'method' && ref.method) {
    return [{ uri: ref.method.uri, range: ref.method.selectionRange }];
  }
  return [{ uri: ref.owner.uri, range: ref.owner.selectionRange }];
}

/** ---------- hover ---------- */

export async function navigationHover(engine: NavigationEngine, params: DefinitionParamsLike): Promise<Record<string, unknown> | null> {
  const doc = await engine.getDoc(params.textDocument.uri);
  if (!doc) return null;
  const hit = await hitAtPosition(engine, doc, params.position.line, params.position.character);
  if (!hit) return null;

  const lines: string[] = [];
  if (hit.kind === 'class') {
    lines.push('```php', `(${hit.sym.kind}) ${hit.sym.fqn}`, '```');
    if (hit.sym.docblock?.summary) lines.push('', hit.sym.docblock.summary);
  } else {
    const ref = hit.ref;
    if (ref.kind === 'property' && ref.property) {
      const p = ref.property;
      const staticPrefix = p.isStatic ? 'static ' : '';
      lines.push('```php', `(${staticPrefix}property) ${ref.owner.name}::$${p.name}`, '```');
      if (hit.typeFqns.length > 0) {
        lines.push('', `**类型** ${hit.typeFqns.map((f) => '`' + f + '`').join(' | ')}`);
      }
      if (p.docblock?.summary) lines.push('', p.docblock.summary);
      else if (ref.owner.docblock && p.originVirtual) lines.push('', `来自 ${ref.owner.name} 类 docblock @property`);
    } else if (ref.kind === 'method' && ref.method) {
      const m = ref.method;
      const sig = m.params.map((p) => `$${p.name}${p.defaultRaw ? ' = ' + p.defaultRaw : ''}`).join(', ');
      const staticPrefix = m.isStatic ? 'static ' : '';
      const returnSuffix = m.returnTypeRaw ? `: ${m.returnTypeRaw}` : '';
      lines.push('```php', `(${staticPrefix}method) ${ref.owner.name}::${m.name}(${sig})${returnSuffix}`, '```');
      if (hit.typeFqns.length > 0) {
        lines.push('', `**返回** ${hit.typeFqns.map((f) => '`' + f + '`').join(' | ')}`);
      }
      if (m.docblock?.summary) lines.push('', m.docblock.summary);
    }
  }
  if (lines.length === 0) return null;
  return {
    contents: { kind: 'markdown', value: lines.join('\n') },
    range: hit.kind === 'class' ? hit.sym.selectionRange : hit.memberRange,
  };
}

/** ---------- completion ---------- */

export interface CompletionParamsLike extends DefinitionParamsLike {}

export async function navigationCompletion(engine: NavigationEngine, params: CompletionParamsLike): Promise<Record<string, unknown>[] | null> {
  const doc = await engine.getDoc(params.textDocument.uri);
  if (!doc) return null;
  const view: ParsedDocLike = { uri: doc.uri, ast: doc.ast, classNodes: (doc as any).classNodes ?? [] };
  const ownerClass = enclosingClass(view, params.position.line, params.position.character);

  // 找接收者节点：位置往前找最近的 -> 与其左边的接收者表达式
  const receiverNode = findReceiverNode(doc, params.position.line, params.position.character);
  if (!receiverNode) return null;

  let receiverFqns: string[];
  if (receiverNode.kind === 'this') {
    if (!ownerClass) return null;
    receiverFqns = [ownerClass.fqn];
  } else {
    receiverFqns = await resolveReceiverFqns(receiverNode.node, view, ownerClass, engine.ctx);
  }
  if (receiverFqns.length === 0) return null;

  // 前缀过滤（光标在成员名中间时）
  const prefix = typedPrefix(doc, params.position.line, params.position.character);

  const items: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const fqn of receiverFqns) {
    const cls = await engine.resolveClass(fqn);
    if (!cls) continue;
    const members = await effectiveMembers(cls, engine.ctx);
    for (const [name, ref] of members) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (prefix && !name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
      items.push(memberToItem(ref));
    }
  }
  return items;
}

function memberToItem(ref: MemberRef): Record<string, unknown> {
  if (ref.kind === 'method' && ref.method) {
    const m = ref.method;
    const sig = m.params.map((p) => `$${p.name}${p.defaultRaw ? ' = ' + p.defaultRaw : ''}`).join(', ');
    return {
      label: m.name,
      kind: 2, // Method
      detail: `${ref.origin.startsWith('parent:') ? ref.origin + ' → ' : ''}${ref.owner.name}::${m.name}(${sig})`,
      sortText: `0_${m.name}`,
    };
  }
  if (ref.kind === 'property' && ref.property) {
    const p = ref.property;
    return {
      label: p.name,
      kind: 10, // Property
      detail: p.docType ?? p.typeRaw ?? '(property)',
      sortText: `1_${p.name}`,
    };
  }
  return {
    label: ref.name,
    kind: 21, // Constant
    detail: `${ref.owner.name}::${ref.name}`,
    sortText: `2_${ref.name}`,
  };
}

/** 位置左侧的接收者：$this / 变量 / 链式 $this->auth */
function findReceiverNode(
  doc: ParsedDoc,
  line: number,
  character: number,
): { kind: 'this'; node: undefined } | { kind: 'expr'; node: any } | undefined {
  const lineIndex = doc.lineIndex;
  const lo = lineIndex[Math.min(line, lineIndex.length - 1)];
  const offset = lo + character;
  const text = doc.text.slice(0, offset);
  // 从光标往回找最近一个未闭合的 -> 链：$var(->name)* -> prefix
  const m = /((?:\$[A-Za-z_\x80-\xff][\w\x80-\xff]*)(?:\s*->\s*[A-Za-z_\x80-\xff][\w\x80-\xff]*)*)->\s*([A-Za-z_\x80-\xff][\w\x80-\xff]*)?$/.exec(text);
  if (!m) return undefined;
  const chainText = m[1];
  const segments = chainText.split('->').map((s) => s.trim());
  const head = segments[0];
  if (head === '$this') {
    if (segments.length === 1) return { kind: 'this', node: undefined };
    // $this->auth 链：构造 propertylookup 视图逐级求类型（直接复用 AST 更可靠：按位置找）
    return findChainNodeAtEnd(doc, line, character, segments.slice(1));
  }
  // 变量接收者：按文本反查 AST 中该变量节点
  return findVariableNode(doc, head, line, character);
}

function findChainNodeAtEnd(
  doc: ParsedDoc,
  line: number,
  character: number,
  _segments: string[],
): { kind: 'this'; node: undefined } | { kind: 'expr'; node: any } | undefined {
  void _segments;
  // 位置左侧最近 propertylookup（offset 的 call/identifier 结束于光标之前）
  let best: any | undefined;
  walk(doc.ast, (node) => {
    if (node.kind !== 'propertylookup' && node.kind !== 'methodlookup') return;
    if (!node.loc || !node.offset || !node.offset.loc) return;
    const endLine = node.offset.loc.end.line - 1;
    const endCol = node.offset.loc.end.column;
    if (endLine === line && endCol <= character) {
      if (!best || node.loc.end.offset >= best.loc.end.offset) best = node;
    }
  });
  if (!best) return { kind: 'this', node: undefined };
  // best 是最内层链（$this->auth）；其 what 即接收者（$this）
  if (best.what && best.what.kind === 'variable' && best.what.name === 'this') {
    return { kind: 'expr', node: best };
  }
  return { kind: 'expr', node: best };
}

function findVariableNode(doc: ParsedDoc, varName: string, line: number, character: number): { kind: 'expr'; node: any } | undefined {
  void varName;
  let best: any | undefined;
  walk(doc.ast, (node) => {
    if (node.kind !== 'variable') return;
    if (!node.loc) return;
    const el = node.loc.end.line - 1;
    const ec = node.loc.end.column;
    if (el === line && ec <= character) {
      if (!best || node.loc.end.offset >= best.loc.end.offset) best = node;
    }
  });
  return best ? { kind: 'expr', node: best } : undefined;
}

function typedPrefix(doc: ParsedDoc, line: number, character: number): string {
  const lineIndex = doc.lineIndex;
  const lineText = doc.text.slice(lineIndex[Math.min(line, lineIndex.length - 1)], lineIndex[Math.min(line, lineIndex.length - 1)] + character);
  const m = /[A-Za-z_\x80-\xff][\w\x80-\xff]*$/.exec(lineText);
  return m ? m[0] : '';
}
