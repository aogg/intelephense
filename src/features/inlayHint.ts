/**
 * features/inlayHint.ts：textDocument/inlayHint + inlayHint/resolve（自研，官方免费版不注册）。
 *
 * compute（快）：纯结构遍历产 hint 骨架（position + kind + data），label 留空（resolve 惰性）；
 * resolve（慢）：解析形参名 / 推断返回类型（复用 T3 codeAction 的 @return 推断）/ 闭包签名，填 label；
 * 推不出 → 返回空 label（客户端按惯例隐藏，零噪声）。
 * 上限保护：单文档 500 条（编辑器惯例）。
 *
 * 覆盖（vip-features §8）：
 *  - 参数名 hint：调用点实参前缀 `形参名:`（具名参数 / 展开实参保守跳过）；
 *  - 返回类型 hint：无返回类型标注的函数/方法，参数列表闭括号后 `: Type`（无体/魔术方法跳过）；
 *  - 匿名函数/箭头函数：赋值目标变量后 `: Closure(签名)`。
 */

import { byteIndexOf, rawTypeOf } from '../engine/ast';
import type { ParsedDoc } from '../engine/ast';
import type { ClassSym, MethodSym } from '../engine/symbols';
import { resolveName, resolveTypeRaw } from '../engine/resolver';
import { findMember, type ParsedDocLike } from '../engine/member';
import { inferReturnDoc } from './codeAction';
import { forEachCandidateDoc, receiverFqnsWithParams } from './rename';
import type { NavigationEngine } from './navigation';

export interface InlayHintData {
  kind: 'param' | 'return' | 'closure';
  uri: string;
  /** param：call 节点起始 offset */
  callOffset?: number;
  /** param：第几个位置实参（具名/展开不计入） */
  argIndex?: number;
  /** return/closure：函数（闭包）节点起始 offset */
  fnOffset?: number;
}

export interface InlayHintLike {
  position: { line: number; character: number };
  kind?: 1 | 2; // 1=Parameter 2=Type
  label: string;
  paddingLeft?: boolean;
  data?: InlayHintData;
}

const MAX_HINTS = 500;
const FN_KINDS = new Set(['function', 'closure', 'arrowfunc', 'arrowfn', 'arrowfunction']);
/** 无返回类型 hint 意义的魔术方法（返回类型由引擎约定，推断只会误导） */
const MAGIC_NO_RETURN = new Set(['__construct', '__destruct', '__clone', '__sleep', '__wakeup', '__serialize', '__unserialize', '__set_state']);

/** ---------- compute ---------- */

export async function computeInlayHints(
  engine: NavigationEngine,
  uri: string,
  range?: { start: { line: number; character: number }; end: { line: number; character: number } },
): Promise<InlayHintLike[]> {
  const doc = await engine.getDoc(uri);
  if (!doc) return [];
  const hints: InlayHintLike[] = [];
  walkNodes(doc.ast, (node) => {
    if (hints.length >= MAX_HINTS) return;
    if (node.kind === 'call') collectParamHints(doc, node, hints);
    else if (node.kind === 'method' || node.kind === 'function') collectReturnHint(doc, node, hints);
    else if (node.kind === 'assign') collectClosureHint(doc, node, hints);
  });
  const filtered = range ? hints.filter((h) => positionInRange(h.position, range)) : hints;
  return filtered.slice(0, MAX_HINTS);
}

/** 参数名骨架：每个位置实参一条（具名 namedargument / 展开 variadic 保守跳过） */
function collectParamHints(doc: ParsedDoc, call: any, hints: InlayHintLike[]): void {
  if (!call.loc || !Array.isArray(call.arguments)) return;
  let idx = 0;
  for (const arg of call.arguments) {
    if (!arg || !arg.loc) continue;
    if (arg.kind === 'namedargument' || arg.kind === 'variadic') continue;
    hints.push({
      position: { line: arg.loc.start.line - 1, character: arg.loc.start.column },
      kind: 1,
      label: '',
      paddingLeft: true,
      data: { kind: 'param', uri: doc.uri, callOffset: call.loc.start.offset, argIndex: idx },
    });
    idx++;
  }
}

/** 返回类型骨架：无返回类型标注且有方法体的函数/方法，参数列表闭括号后 */
function collectReturnHint(doc: ParsedDoc, node: any, hints: InlayHintLike[]): void {
  if (!node.loc || node.type) return; // 已有返回类型标注
  const body = node.body;
  if (!body || !body.loc) return; // 接口/抽象声明无体，诚实跳过
  const name = typeof node.name?.name === 'string' ? node.name.name : node.name;
  if (node.kind === 'method' && typeof name === 'string' && MAGIC_NO_RETURN.has(name)) return;
  const after = positionAfterParams(doc, node);
  if (!after) return;
  hints.push({
    position: after,
    kind: 2,
    label: '',
    paddingLeft: true,
    data: { kind: 'return', uri: doc.uri, fnOffset: node.loc.start.offset },
  });
}

/** 闭包/箭头函数骨架：$var = <closure|arrowfn> → 变量名后 */
function collectClosureHint(doc: ParsedDoc, node: any, hints: InlayHintLike[]): void {
  const right = node.right;
  const left = node.left;
  if (!right || !left || !right.loc || !left.loc) return;
  if (!FN_KINDS.has(right.kind)) return;
  if (left.kind !== 'variable') return;
  hints.push({
    position: { line: left.loc.end.line - 1, character: left.loc.end.column },
    kind: 2,
    label: '',
    paddingLeft: true,
    data: { kind: 'closure', uri: doc.uri, fnOffset: right.loc.start.offset },
  });
}

/** 参数列表闭括号 `)` 之后的位置（括号配对 + 字符串字面量感知，避免默认值里的括号误配） */
function positionAfterParams(doc: ParsedDoc, fnNode: any): { line: number; character: number } | undefined {
  if (!fnNode.loc || !fnNode.name?.loc) return undefined;
  const text = doc.text;
  let open = -1;
  // 从函数名结束处找参数列表开括号（签名语法上名后紧跟 (，中间无其他 token）
  const searchStart = fnNode.name.loc.end.offset;
  for (let i = searchStart; i < text.length && i < searchStart + 4096; i++) {
    const ch = text[i];
    if (ch === '(') {
      open = i;
      break;
    }
    if (ch === '{' || ch === ';') return undefined; // 参数列表之前不应出现这些（找不到就放弃）
  }
  if (open < 0) return undefined;
  const close = matchParen(text, open);
  if (close < 0) return undefined;
  return posOfOffset(doc, close + 1);
}

/** 括号配对（跳过单双引号字符串与行注释；转义感知） */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function posOfOffset(doc: ParsedDoc, offset: number): { line: number; character: number } {
  const starts = doc.lineIndex;
  const idx = Math.max(0, Math.min(offset, doc.text.length));
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: idx - starts[lo] };
}

function positionInRange(pos: { line: number; character: number }, range: { start: { line: number; character: number }; end: { line: number; character: number } }): boolean {
  const afterStart = pos.line > range.start.line || (pos.line === range.start.line && pos.character >= range.start.character);
  const beforeEnd = pos.line < range.end.line || (pos.line === range.end.line && pos.character <= range.end.character);
  return afterStart && beforeEnd;
}

/** ---------- resolve ---------- */

export async function resolveInlayHint(engine: NavigationEngine, hint: InlayHintLike): Promise<InlayHintLike> {
  const data = hint.data;
  if (!data) return hint;
  try {
    let label = '';
    if (data.kind === 'param') label = await resolveParamLabel(engine, data);
    else if (data.kind === 'return') label = await resolveReturnLabel(engine, data);
    else if (data.kind === 'closure') label = await resolveClosureLabel(engine, data);
    if (!label) return { ...hint, label: '' }; // 推不出：空 label（客户端隐藏）
    return { ...hint, label };
  } catch {
    return { ...hint, label: '' };
  }
}

/** 形参名：call 节点重定位 → callee 解析 → 第 argIndex 个位置形参 */
async function resolveParamLabel(engine: NavigationEngine, data: InlayHintData): Promise<string> {
  if (data.callOffset === undefined || data.argIndex === undefined) return '';
  const doc = await engine.getDoc(data.uri);
  if (!doc) return '';
  const call = findNodeAtOffset(doc, data.callOffset, ['call']);
  if (!call || !Array.isArray(call.arguments)) return '';
  const positional = call.arguments.filter((a: any) => a && a.kind !== 'namedargument' && a.kind !== 'variadic');
  const params = await calleeParams(engine, doc, call);
  if (!params) return '';
  const p = params[data.argIndex];
  if (!p || data.argIndex >= positional.length) return ''; // 超出形参表（变长实参等）：不猜
  const pname = typeof p.name === 'string' ? p.name.replace(/^\$/, '') : p.name;
  return typeof pname === 'string' && pname ? pname + ':' : '';
}

/** callee 形参表（方法/静态/命名函数；解析不了返回 undefined） */
async function calleeParams(engine: NavigationEngine, doc: ParsedDoc, call: any): Promise<{ name: string }[] | undefined> {
  const what = call.what;
  if (!what) return undefined;
  const view: ParsedDocLike = { uri: doc.uri, ast: doc.ast, classNodes: (doc as any).classNodes ?? [] };

  if (what.kind === 'propertylookup' || what.kind === 'methodlookup') {
    const methodName = what.offset && (typeof what.offset.name === 'string' ? what.offset.name : what.offset.name?.name);
    if (typeof methodName !== 'string') return undefined;
    const ownerClass = nodeOwnerClass(view, call);
    // 常规推断 + 函数参数类型标注兜底（function go(Main $m) 的 $m），与 rename 同源
    const fqns = await receiverFqnsWithParams(engine, doc, what, view, ownerClass);
    for (const fqn of fqns) {
      const cls = await engine.resolveClass(fqn);
      if (!cls) continue;
      const ref = await findMember(cls, methodName, engine.ctx);
      if (ref?.method) return ref.method.params;
    }
    return undefined;
  }

  if (what.kind === 'staticlookup') {
    const methodName = what.offset && (typeof what.offset.name === 'string' ? what.offset.name : what.offset.name?.name);
    if (typeof methodName !== 'string') return undefined;
    const ownerClass = nodeOwnerClass(view, call);
    const file = engine.index.files.get(doc.uri);
    const whatKind = what.what?.kind;
    let fqns: string[] = [];
    if (whatKind === 'selfreference' || whatKind === 'staticreference') {
      if (ownerClass) fqns = [ownerClass.fqn];
    } else if (whatKind === 'parentreference') {
      if (ownerClass) fqns = (ownerClass.extendsRaw ?? []).map((raw) => resolveTypeRaw(raw, engine.index.files.get(ownerClass.uri), ownerClass.fqn)[0]).filter((x): x is string => !!x);
    } else {
      const raw = rawTypeOf(what.what);
      if (raw) fqns = resolveTypeRaw(raw, file, ownerClass?.fqn);
    }
    for (const fqn of fqns) {
      const cls = await engine.resolveClass(fqn);
      if (!cls) continue;
      let cur: ClassSym | undefined = cls;
      const seen = new Set<string>();
      while (cur && !seen.has(cur.fqn.toLowerCase())) {
        seen.add(cur.fqn.toLowerCase());
        const m = cur.methods.find((mm: MethodSym) => mm.name === methodName);
        if (m) return m.params;
        const cFile = engine.index.files.get(cur.uri);
        const curCls: ClassSym = cur;
        const parentFqn: string | undefined = ((curCls.extendsRaw ?? []) as string[]).map((r: string) => resolveTypeRaw(r, cFile, curCls.fqn)[0]).find(Boolean);
        cur = parentFqn ? await engine.resolveClass(parentFqn) : undefined;
      }
    }
    return undefined;
  }

  // 命名函数：uqn → 当前命名空间兜底；工作区声明才可解
  if (what.kind === 'name') {
    const fname = typeof what.name === 'string' ? what.name : what.name?.name;
    if (typeof fname !== 'string') return undefined;
    const file = engine.index.files.get(doc.uri);
    const fqnLower = resolveName(fname, file).toLowerCase();
    let params: { name: string }[] | undefined;
    await forEachCandidateDoc(engine, fname, (candidate) => {
      if (params) return;
      walkNodes(candidate.ast, (node) => {
        if (params || node.kind !== 'function') return;
        const n = typeof node.name?.name === 'string' ? node.name.name : node.name?.name?.name;
        if (n !== fname) return;
        const cFile = engine.index.files.get(candidate.uri);
        if (resolveName(fname, cFile).toLowerCase() === fqnLower) {
          params = (node.arguments ?? node.args ?? []).map((p: any) => ({
            name: typeof p?.name === 'string' ? p.name : typeof p?.name?.name === 'string' ? p.name.name : '',
          }));
        }
      });
    });
    return params;
  }
  return undefined;
}

/** 返回类型 label：方法走 MethodSym 通道；命名函数伪造伪 MethodSym（cls 无 self 上下文） */
async function resolveReturnLabel(engine: NavigationEngine, data: InlayHintData): Promise<string> {
  if (data.fnOffset === undefined) return '';
  const doc = await engine.getDoc(data.uri);
  if (!doc) return '';
  const fnNode = findNodeAtOffset(doc, data.fnOffset, ['method', 'function']);
  if (!fnNode || fnNode.type) return '';
  const view: ParsedDocLike = { uri: doc.uri, ast: doc.ast, classNodes: (doc as any).classNodes ?? [] };

  if (fnNode.kind === 'method') {
    const cls = nodeOwnerClass(view, fnNode);
    if (!cls) return '';
    const nameLoc = fnNode.name?.loc;
    const m = cls.methods.find((mm) => nameLoc && mm.selectionRange.start.line === nameLoc.start.line - 1 && mm.selectionRange.start.character === nameLoc.start.column);
    if (!m) return '';
    const ret = await inferReturnDoc(engine, doc, cls, m);
    return ret ? `: ${ret}` : '';
  }

  // 命名函数
  const pseudo: MethodSym = {
    name: typeof fnNode.name?.name === 'string' ? fnNode.name.name : '',
    uri: doc.uri,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    visibility: 'public',
    isStatic: false,
    isAbstract: false,
    params: [],
    returnTypeRaw: undefined,
    astNode: fnNode,
  };
  const ret = await inferReturnDoc(engine, doc, undefined, pseudo);
  return ret ? `: ${ret}` : '';
}

/** 闭包/箭头函数签名 label：`: Closure(Type $a, $b): Ret`（返回类型走字面量推断，推不出则省略） */
async function resolveClosureLabel(engine: NavigationEngine, data: InlayHintData): Promise<string> {
  if (data.fnOffset === undefined) return '';
  const doc = await engine.getDoc(data.uri);
  if (!doc) return '';
  const fn = findNodeAtOffset(doc, data.fnOffset, ['closure', 'arrowfunc', 'arrowfn', 'arrowfunction']);
  if (!fn) return '';
  const paramParts: string[] = [];
  for (const p of fn.arguments ?? fn.args ?? []) {
    const pname = typeof p?.name === 'string' ? p.name : typeof p?.name?.name === 'string' ? p.name.name : '';
    if (!pname) continue;
    const t = rawTypeOf(p?.type);
    paramParts.push(t ? `${t} ${pname}` : pname);
  }
  let ret: string | undefined;
  if (fn.kind === 'arrowfunc' || fn.kind === 'arrowfn' || fn.kind === 'arrowfunction') {
    ret = literalTypeOf(fn.body ?? fn.expr);
  } else {
    const parts: string[] = [];
    let has = false;
    walkNodes(fn.body ?? {}, (node: any) => {
      if (node.kind !== 'return') return;
      has = true;
      const t = literalTypeOf(node.expression ?? node.expr);
      if (t && !parts.includes(t)) parts.push(t);
    });
    if (parts.length > 0) ret = parts.join('|');
    else if (!has) ret = 'void';
  }
  const retSuffix = ret ? `: ${ret}` : '';
  return `: Closure(${paramParts.join(', ')})${retSuffix}`;
}

/** 字面量表达式 → 类型串（推断不了返回 undefined，诚实省略） */
function literalTypeOf(expr: any): string | undefined {
  if (!expr || typeof expr !== 'object') return undefined;
  switch (expr.kind) {
    case 'integer':
      return 'int';
    case 'number':
      return /^[+\-]?\d+$/.test(String(expr.value ?? '')) ? 'int' : 'float';
    case 'float':
      return 'float';
    case 'string':
      return 'string';
    case 'boolean':
      return 'bool';
    case 'null':
      return 'null';
    case 'array':
      return 'array';
    default:
      return undefined;
  }
}

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

/** offset 精确命中某类节点（resolve 重定位） */
function findNodeAtOffset(doc: ParsedDoc, offset: number, kinds: string[]): any | undefined {
  let found: any | undefined;
  walkNodes(doc.ast, (node) => {
    if (found || !node.loc) return;
    if (!kinds.includes(node.kind)) return;
    if (node.loc.start.offset === offset) found = node;
  });
  return found;
}

/** 节点（按起点）所在最小类符号 */
function nodeOwnerClass(view: ParsedDocLike, target: any): ClassSym | undefined {
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

void byteIndexOf;
