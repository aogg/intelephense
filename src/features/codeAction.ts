/**
 * features/codeAction.ts：textDocument/codeAction + codeAction/resolve（自研，官方免费版关闭）。
 * 三类动作（data 携带信息懒 resolve，resolve 时重算 edit）：
 *  1. quickfix 自动 import：光标未解析类名 → WorkspaceIndex 按类名找候选 → 字母序插入 use 行
 *     （与现有 use 冲突时 `use FQN as 别名;` 并同步改写引用 token）；
 *  2. quickfix 批量实现抽象方法：类缺口的接口/抽象方法 stub（继承参数类型与默认值，保持可见性/静态标记）；
 *  3. source 生成 PHPDoc：@param 从类型标注/默认值推断、@return 从 return 语句静态推断
 *     （字面量 / new X / 已知调用返回类型 / \$this->prop 类型 / 多 return 取联合）、
 *     @throws 从方法体 throw new X 收集、可空 ?Type 保留。
 */

import { byteIndexOf, docblockCommentNode, lspRangeForJsSpan, plainName, rawTypeOf } from '../engine/ast';
import type { ParsedDoc } from '../engine/ast';
import type { ClassSym, MethodSym } from '../engine/symbols';
import { resolveTypeRaw } from '../engine/resolver';
import { findMember, memberTypes, enclosingClass, type ParsedDocLike } from '../engine/member';
import { inferPropertyTypes } from '../engine/infer';
import { hierarchySets, declarationAt } from './implementation';
import { containingNodes, type NavigationEngine, type LocationLike } from './navigation';

export interface CodeActionParamsLike {
  textDocument: { uri: string };
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  context?: { diagnostics?: { range?: LocationLike['range']; message?: string }[] };
}

export interface CodeActionLike {
  title: string;
  kind: string;
  isPreferred?: boolean;
  diagnostics?: unknown[];
  data?: CAData;
  edit?: { changes: Record<string, { range: LocationLike['range']; newText: string }[]> };
}

interface CAData {
  kind: 'import' | 'implement' | 'phpdoc';
  uri: string;
  /** import */
  fqn?: string;
  alias?: string;
  nameRange?: LocationLike['range'];
  /** implement */
  classFqn?: string;
  /** phpdoc */
  decl?: 'method' | 'function' | 'property';
  sel?: LocationLike['range'];
}

const KIND_QUICKFIX = 'quickfix';
const KIND_SOURCE = 'source';

/** ---------- 入口 ---------- */

export async function codeActions(engine: NavigationEngine, params: CodeActionParamsLike): Promise<CodeActionLike[]> {
  const doc = await engine.getDoc(params.textDocument.uri);
  if (!doc) return [];
  const out: CodeActionLike[] = [];
  out.push(...(await importActions(engine, doc, params)));
  out.push(...(await implementActions(engine, doc, params)));
  out.push(...(await phpdocActions(engine, doc, params)));
  return out;
}

export async function codeActionResolve(engine: NavigationEngine, action: CodeActionLike): Promise<CodeActionLike> {
  const data = action.data;
  if (!data) return action;
  try {
    if (data.kind === 'import' && data.fqn) {
      const edit = buildImportEdit(engine, data.uri, data.fqn, data.alias, data.nameRange);
      if (edit) return { ...action, edit };
    } else if (data.kind === 'implement' && data.classFqn) {
      const edit = await buildImplementEdit(engine, data.uri, data.classFqn);
      if (edit) return { ...action, edit };
    } else if (data.kind === 'phpdoc' && data.decl && data.sel) {
      const edit = await buildPhpdocEdit(engine, data.uri, data.decl, data.sel);
      if (edit) return { ...action, edit };
    }
  } catch {
    // resolve 失败诚实返回原 action（无 edit）
  }
  return action;
}

/** ---------- 1. 自动 import ---------- */

async function importActions(engine: NavigationEngine, doc: ParsedDoc, params: CodeActionParamsLike): Promise<CodeActionLike[]> {
  const uri = doc.uri;
  const file = engine.index.files.get(uri);
  const view: ParsedDocLike = { uri, ast: doc.ast, classNodes: (doc as any).classNodes ?? [] };
  const tried = new Set<string>();
  const out: CodeActionLike[] = [];

  const consider = async (line: number, character: number): Promise<void> => {
    for (const node of containingNodes(doc, line, character)) {
      if (node.kind !== 'name') continue;
      if (!node.loc) continue;
      const sl = node.loc.start.line - 1;
      const el = node.loc.end.line - 1;
      if (line < sl || line > el) continue;
      if (line === sl && character < node.loc.start.column) continue;
      if (line === el && character > node.loc.end.column) continue;
      const raw = typeof node.name === 'string' ? node.name : plainName(node);
      if (typeof raw !== 'string' || node.resolution === undefined) return;
      const ownerClass = enclosingClass(view, line, character);
      const fqns = resolveTypeRaw(raw, file, ownerClass?.fqn);
      if (fqns.length === 0) return; // 内建类型或推不出 → 无 import 语义
      const shortName = raw.includes('\\') ? raw.slice(raw.lastIndexOf('\\') + 1) : raw;
      const key = shortName.toLowerCase();
      if (tried.has(key)) return;
      tried.add(key);
      // 全部候选都无法解析 → 未定义类名
      let anyResolved = false;
      for (const fqn of fqns) {
        if (await engine.resolveClass(fqn)) {
          anyResolved = true;
          break;
        }
      }
      if (anyResolved) return;

      // 已导入同名 fqn → 不需要 import
      const existing = file ? file.imports.get(key) : undefined;
      if (existing) return;

      await engine.index.ensureScan();
      const lowerShort = shortName.toLowerCase();
      const candidates: string[] = [];
      for (const [fqn] of engine.index.scanEntries()) {
        const seg = fqn.slice(fqn.lastIndexOf('\\') + 1);
        if (seg.toLowerCase() === lowerShort && !candidates.includes(fqn)) candidates.push(fqn);
      }
      // 内存镜像文档中的类也计入
      for (const f of engine.index.files.values()) {
        for (const cls of f.classes) {
          if (cls.name.toLowerCase() === lowerShort && !candidates.includes(cls.fqn)) candidates.push(cls.fqn);
        }
      }
      candidates.sort((a, b) => a.localeCompare(b));
      const nameRange = lspRangeForJsSpan(doc, byteIndexOf(doc, node.loc.start.offset), byteIndexOf(doc, node.loc.end.offset));
      for (const fqn of candidates) {
        // 与现有 use 别名冲突 → as 别名 + 改写引用
        let alias: string | undefined;
        if (file && file.imports.has(lowerShort)) {
          let n = 2;
          while (file.imports.has((shortName + n).toLowerCase())) n++;
          alias = shortName + n;
        }
        out.push({
          title: `Import ${fqn}`,
          kind: KIND_QUICKFIX,
          isPreferred: candidates.length === 1,
          data: { kind: 'import', uri, fqn, alias, nameRange },
        });
      }
      return; // 只处理最内层 name 节点
    }
  };

  const start = params.range?.start ?? { line: 0, character: 0 };
  await consider(start.line, start.character);
  // 诊断兜底：光标不在名字上时，尝试与 range 相交的诊断位置
  for (const d of params.context?.diagnostics ?? []) {
    if (!d.range?.start) continue;
    const r = d.range;
    const intersects = r.start.line <= (params.range?.end?.line ?? r.start.line) && r.end.line >= start.line;
    if (!intersects) continue;
    if (start.line === r.start.line && start.character === r.start.character) continue;
    await consider(r.start.line, r.start.character);
  }
  return out.slice(0, 8); // 防爆炸：最多 8 个候选
}

function buildImportEdit(
  engine: NavigationEngine,
  uri: string,
  fqn: string,
  alias: string | undefined,
  nameRange: LocationLike['range'] | undefined,
): { changes: Record<string, { range: LocationLike['range']; newText: string }[]> } | undefined {
  const doc = engine.peekDoc(uri) ?? undefined;
  if (!doc) return undefined;
  const insertLine = useInsertLine(engine, doc, fqn, alias);
  if (insertLine === undefined) return undefined;
  const edits: { range: LocationLike['range']; newText: string }[] = [
    {
      range: { start: { line: insertLine.line, character: 0 }, end: { line: insertLine.line, character: 0 } },
      newText: `use ${fqn}${alias ? ' as ' + alias : ''};\n`,
    },
  ];
  if (alias && nameRange) {
    edits.push({ range: nameRange, newText: alias });
  }
  return { changes: { [uri]: edits } };
}

/** use 行插入点：字母序落在首个更大的 use 行之前；无 use 块则 namespace 后（无 namespace 则 <?php 后） */
function useInsertLine(engine: NavigationEngine, doc: ParsedDoc, fqn: string, alias: string | undefined): { line: number } | undefined {
  const text = doc.text;
  const lines = text.split('\n');
  // 现有 use 行（含别名）字母序比较
  const useRe = /^(\s*)use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/;
  let firstGreater: number | undefined;
  let lastUseLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = useRe.exec(lines[i]);
    if (!m) continue;
    lastUseLine = i;
    const existing = m[2];
    if (firstGreater === undefined && existing.toLowerCase() > fqn.toLowerCase()) firstGreater = i;
  }
  if (lastUseLine >= 0) {
    if (firstGreater !== undefined) return { line: firstGreater };
    return { line: lastUseLine + 1 }; // 追加到最后一个 use 之后
  }
  // 无 use 块：namespace 行后；否则 <?php 行后
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*namespace\s+[\w\\]+\s*;/.test(lines[i])) return { line: i + 1 };
  }
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*<\?php/.test(lines[i])) return { line: i + 1 };
  }
  return { line: 0 };
}

/** ---------- 2. 批量实现抽象方法 ---------- */

async function implementActions(engine: NavigationEngine, doc: ParsedDoc, params: CodeActionParamsLike): Promise<CodeActionLike[]> {
  const line = params.range?.start?.line ?? 0;
  const character = params.range?.start?.character ?? 0;
  for (const { sym } of (doc as any).classNodes ?? []) {
    if (!inRange2(sym.range, line, character)) continue;
    if (sym.kind === 'trait') return [];
    const missing = await missingAbstractMethods(engine, sym);
    if (missing.length === 0) return [];
    const label = missing
      .slice(0, 4)
      .map((m) => m.name)
      .join(', ');
    const more = missing.length > 4 ? ` 等 ${missing.length} 个` : `（${missing.length} 个）`;
    return [
      {
        title: `实现抽象方法: ${label}${missing.length > 4 ? more : ''}`,
        kind: KIND_QUICKFIX,
        isPreferred: true,
        data: { kind: 'implement', uri: doc.uri, classFqn: sym.fqn },
      },
    ];
  }
  return [];
}

async function missingAbstractMethods(engine: NavigationEngine, cls: ClassSym): Promise<MethodSym[]> {
  const sets = await hierarchySets(engine, cls);
  const own = new Map<string, MethodSym>();
  for (const m of cls.methods) own.set(m.name.toLowerCase(), m);
  const missing: MethodSym[] = [];
  const seen = new Set<string>();
  for (const ancLower of [...sets.classes, ...sets.interfaces]) {
    const anc = await engine.resolveClass(ancLower);
    if (!anc) continue;
    for (const m of anc.methods) {
      const required = anc.kind === 'interface' || m.isAbstract;
      if (!required) continue;
      const key = m.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const mine = own.get(key);
      if (mine && !mine.isAbstract) continue;
      missing.push(m);
    }
  }
  return missing;
}

async function buildImplementEdit(
  engine: NavigationEngine,
  uri: string,
  classFqn: string,
): Promise<{ changes: Record<string, { range: LocationLike['range']; newText: string }[]> } | undefined> {
  const cls = await engine.resolveClass(classFqn);
  if (!cls) return undefined;
  const doc = await engine.getDoc(cls.uri);
  if (!doc) return undefined;
  const missing = await missingAbstractMethods(engine, cls);
  if (missing.length === 0) return undefined;
  const classNode = (doc as any).classNodes?.find((c: any) => c.sym.fqn.toLowerCase() === cls.fqn.toLowerCase())?.node;
  if (!classNode?.loc?.end) return undefined;
  // 类收尾 } 所在行首插入；缩进取类内首个方法的缩进，缺省 4 空格
  let indent = '    ';
  for (const m of cls.methods) {
    if (m.range?.start?.character > 0) {
      indent = ' '.repeat(m.range.start.character);
      break;
    }
  }
  const stubs = missing.map((m) => methodStub(m, indent)).join('');
  const insertLine = Math.max(0, (classNode.loc.end.line ?? 1) - 1);
  return {
    changes: {
      [uri]: [
        {
          range: { start: { line: insertLine, character: 0 }, end: { line: insertLine, character: 0 } },
          newText: stubs,
        },
      ],
    },
  };
}

function methodStub(m: MethodSym, indent: string): string {
  const vis = m.visibility === 'private' || m.visibility === 'protected' ? m.visibility : 'public';
  const staticP = m.isStatic ? ' static' : '';
  const params = m.params
    .map((p) => {
      const t = p.typeRaw ? p.typeRaw + ' ' : '';
      const def = p.defaultRaw !== undefined ? ' = ' + p.defaultRaw : '';
      return `${t}$${p.name}${def}`;
    })
    .join(', ');
  const ret = m.returnTypeRaw ? `: ${m.returnTypeRaw}` : '';
  return `${indent}${vis}${staticP} function ${m.name}(${params})${ret}\n${indent}{\n${indent}}\n`;
}

/** ---------- 3. 生成 PHPDoc ---------- */

async function phpdocActions(engine: NavigationEngine, doc: ParsedDoc, params: CodeActionParamsLike): Promise<CodeActionLike[]> {
  const line = params.range?.start?.line ?? 0;
  const character = params.range?.start?.character ?? 0;

  // 方法声明（declarationAt 共用）
  const decl = declarationAt(doc, line, character);
  if (decl?.kind === 'method' && !docblockCommentNode(decl.method.astNode ?? ({}))) {
    const sel = decl.method.selectionRange;
    return [{ title: `生成 PHPDoc: ${decl.cls.name}::${decl.method.name}()`, kind: KIND_SOURCE, data: { kind: 'phpdoc', uri: doc.uri, decl: 'method', sel } }];
  }

  // 顶层函数声明
  let fnHit: { name: string; range: LocationLike['range'] } | undefined;
  walkNoUseNodes(doc.ast, (node) => {
    if (fnHit || node.kind !== 'function') return;
    if (!node.name?.loc) return;
    const range = lspRangeForJsSpan(doc, byteIndexOf(doc, node.name.loc.start.offset), byteIndexOf(doc, node.name.loc.end.offset));
    if (inRange2(range, line, character)) fnHit = { name: plainName(node.name) ?? '', range };
  });
  if (fnHit) {
    const hasDoc = !!docblockCommentNode(fnNodeAt(doc, fnHit));
    if (!hasDoc) return [{ title: `生成 PHPDoc: ${fnHit.name}()`, kind: KIND_SOURCE, data: { kind: 'phpdoc', uri: doc.uri, decl: 'function', sel: fnHit.range } }];
  }

  // 属性声明
  for (const { sym } of (doc as any).classNodes ?? []) {
    for (const p of sym.properties) {
      if (p.originVirtual) continue;
      if (!inRange2(p.selectionRange, line, character)) continue;
      if (p.docblock) return []; // 已有 docblock：不再生成
      return [{ title: `生成 PHPDoc: ${sym.name}::$${p.name}`, kind: KIND_SOURCE, data: { kind: 'phpdoc', uri: doc.uri, decl: 'property', sel: p.selectionRange } }];
    }
  }
  return [];
}

function fnNodeAt(doc: ParsedDoc, hit: { name: string; range: LocationLike['range'] }): any | undefined {
  let found: any | undefined;
  walkNoUseNodes(doc.ast, (node) => {
    if (found || node.kind !== 'function') return;
    if (plainName(node.name) === hit.name) found = node;
  });
  return found;
}

async function buildPhpdocEdit(
  engine: NavigationEngine,
  uri: string,
  decl: 'method' | 'function' | 'property',
  sel: LocationLike['range'],
): Promise<{ changes: Record<string, { range: LocationLike['range']; newText: string }[]> } | undefined> {
  const doc = await engine.getDoc(uri);
  if (!doc) return undefined;
  const indent = ' '.repeat(sel.start.character);
  let tags: string[] = [];
  let declText: string | undefined;

  if (decl === 'method') {
    // 由 sel（方法名 token）反查方法符号与宿主类
    const line = sel.start.line;
    for (const { sym } of (doc as any).classNodes ?? []) {
      const m = sym.methods.find((mm: MethodSym) => mm.selectionRange.start.line === line && mm.selectionRange.start.character === sel.start.character);
      if (!m) continue;
      tags = await methodPhpdocTags(engine, doc, sym, m);
      declText = `function ${m.name}`;
      break;
    }
    if (!declText) return undefined;
  } else if (decl === 'function') {
    const node = fnNodeAtRange(doc, sel);
    if (!node) return undefined;
    tags = functionPhpdocTags(node, doc, engine);
    declText = `function ${plainName(node.name)}`;
    if (tags.length === 0) return undefined;
  } else {
    // 属性：@var 从类型声明/赋值推断
    for (const { sym } of (doc as any).classNodes ?? []) {
      const p = sym.properties.find((pp: any) => pp.selectionRange.start.line === sel.start.line && pp.selectionRange.start.character === sel.start.character);
      if (!p) continue;
      if (p.typeRaw) {
        tags = [`@var ${p.typeRaw}`];
      } else {
        const r = await inferPropertyTypes(sym, p.name, engine.ctx);
        if (r.fqns.length === 0) return undefined; // 推不出类型：不生成空 docblock（诚实降级）
        const file = engine.index.files.get(uri);
        tags = [`@var ${r.fqns.map((f) => docTypeForFqn(f, file)).join('|')}`];
      }
      declText = `$${p.name}`;
      break;
    }
    if (!declText) return undefined;
  }

  const body = tags.length > 0 ? `/**\n${indent} * ${declText}\n${indent} *\n${indent} * ${tags.join(`\n${indent} * `)}\n${indent} */\n` : `/**\n${indent} * ${declText}\n${indent} */\n`;
  return {
    changes: {
      [uri]: [
        {
          range: { start: { line: sel.start.line, character: 0 }, end: { line: sel.start.line, character: 0 } },
          newText: indent + body,
        },
      ],
    },
  };
}

async function methodPhpdocTags(engine: NavigationEngine, doc: ParsedDoc, cls: ClassSym, m: MethodSym): Promise<string[]> {
  const tags: string[] = [];
  const file = engine.index.files.get(doc.uri);

  // @param：类型标注 → 默认值字面量推断 → mixed；可空 ?Type 保留
  for (const p of m.params) {
    let type = p.typeRaw;
    if (!type && p.defaultRaw !== undefined) {
      const d = p.defaultRaw.trim();
      if (/^-?\d+$/.test(d)) type = 'int';
      else if (/^-?\d+\.\d+$/.test(d)) type = 'float';
      else if (/^'(.*)'$/.test(d) || /^"(.*)"$/.test(d)) type = 'string';
      else if (d === '[]' || /^\[\s*\]$/.test(d)) type = 'array';
      else if (d === 'true' || d === 'false') type = 'bool';
      else if (d === 'null') type = 'null';
    }
    if (!type) type = 'mixed';
    tags.push(`@param ${type} $${p.name}${p.defaultRaw !== undefined ? ` 默认 ${p.defaultRaw.trim()}` : ''}`);
  }

  // @return：return 语句静态推断（字面量/new/已知调用/$this->prop；多 return 取联合）
  const ret = await inferReturnDoc(engine, doc, cls, m);
  if (ret) tags.push(`@return ${ret}`);

  // @throws：方法体 throw new X 收集
  const throws = collectThrows(doc, m);
  for (const t of throws) tags.push(`@throws ${t}`);
  return tags;
}

function functionPhpdocTags(fnNode: any, doc: ParsedDoc, engine: NavigationEngine): string[] {
  const tags: string[] = [];
  const params = fnNode.arguments ?? fnNode.args ?? [];
  for (const p of params) {
    const pname = typeof p?.name === 'string' ? p.name.replace(/^\$/, '') : plainName(p?.name)?.replace(/^\$/, '');
    if (!pname) continue;
    const t = rawTypeOf(p?.type);
    let type = t;
    if (!type && p?.value?.loc) {
      const d = doc.text.slice(byteIndexOf(doc, p.value.loc.start.offset), byteIndexOf(doc, p.value.loc.end.offset)).trim();
      if (/^-?\d+$/.test(d)) type = 'int';
      else if (/^-?\d+\.\d+$/.test(d)) type = 'float';
      else if (/^'(.*)'$/.test(d) || /^"(.*)"$/.test(d)) type = 'string';
      else if (d === '[]') type = 'array';
      else if (d === 'true' || d === 'false') type = 'bool';
    }
    tags.push(`@param ${type ?? 'mixed'} $${pname}`);
  }
  const returns = literalReturnsOf(fnNode, doc);
  if (returns.length > 0) tags.push(`@return ${unionOf(returns)}`);
  else tags.push('@return void');
  const throws = new Set<string>();
  walkScoped(fnNode, (n: any) => {
    if (n.kind !== 'throw') return;
    const e = n.what ?? n.expression ?? n.expr;
    if (e?.kind === 'new') {
      const raw = rawTypeOf(e.what);
      if (raw) throws.add(raw);
    }
  });
  for (const t of throws) tags.push(`@throws ${t}`);
  void engine;
  return tags;
}

/** 方法/函数 @return 推断：returnTypeRaw 直接用；否则扫描 return 表达式。T4 inlayHint 复用（cls 仅提供 self/static 解析上下文，可为空） */
export async function inferReturnDoc(engine: NavigationEngine, doc: ParsedDoc, cls: ClassSym | undefined, m: MethodSym): Promise<string | undefined> {
  if (m.returnTypeRaw) return m.returnTypeRaw;
  const body = m.astNode?.body;
  if (!body) return undefined;
  const parts: string[] = [];
  const returnNodes: any[] = [];
  let hasReturn = false;
  walkScoped(body, (node: any) => {
    if (node.kind !== 'return') return;
    hasReturn = true;
    returnNodes.push(node);
  });
  for (const node of returnNodes) {
    const expr = node.expression ?? node.expr;
    for (const t of await returnExprTypes(engine, doc, cls, expr)) parts.push(t);
  }
  if (!hasReturn) return 'void';
  const union = unionOf(parts);
  if (!union) return undefined;
  return union;
}

/** 单个 return 表达式的类型字符串集合 */
async function returnExprTypes(engine: NavigationEngine, doc: ParsedDoc, cls: ClassSym | undefined, expr: any): Promise<string[]> {
  if (!expr) return []; // return; → 无值
  const file = engine.index.files.get(doc.uri);
  switch (expr.kind) {
    case 'number': {
      // php-parser 3.x 整数与浮点字面量同为 number，按值区分
      const v = String(expr.value ?? '');
      return /^[+\-]?\d+$/.test(v) ? ['int'] : ['float'];
    }
    case 'integer':
      return ['int'];
    case 'float':
      return ['float'];
    case 'string':
      return ['string'];
    case 'boolean':
      return ['bool'];
    case 'null':
      return ['null'];
    case 'array':
      return ['array'];
    case 'new': {
      const raw = rawTypeOf(expr.what);
      if (!raw) return [];
      const fqns = resolveTypeRaw(raw, file, cls?.fqn);
      return fqns.map((f) => docTypeForFqn(f, file));
    }
    case 'call': {
      // X::m() 已知返回类型（原生/@return/new self|static）
      const what = expr.what;
      if (what?.kind !== 'staticlookup') return [];
      const classRaw = rawTypeOf(what.what);
      if (!classRaw) return [];
      const classFqn = resolveTypeRaw(classRaw, file, cls?.fqn)[0];
      if (!classFqn) return [];
      const offset = what.offset;
      const methodName = offset && offset.kind === 'call' ? offset.what && offset.what.name : offset && offset.name;
      if (typeof methodName !== 'string') return [];
      // 同步查（索引内）
      const target = engine.index.byFqn.get(classFqn.toLowerCase());
      if (!target) return [];
      let cur: ClassSym | undefined = target;
      const seen = new Set<string>();
      while (cur && !seen.has(cur.fqn.toLowerCase())) {
        seen.add(cur.fqn.toLowerCase());
        const mm = cur.methods.find((x) => x.name === methodName);
        if (mm) {
          const mFile = engine.index.files.get(mm.uri);
          if (mm.returnTypeRaw) return resolveTypeRaw(mm.returnTypeRaw, mFile, cur.fqn).map((f) => docTypeForFqn(f, mFile));
          if (mm.docblock?.returns?.length) return resolveTypeRaw(mm.docblock.returns[0], mFile, cur.fqn).map((f) => docTypeForFqn(f, mFile));
          if (mm.returnsNewSelf) return [docTypeForFqn(classFqn, file)];
          return [];
        }
        const cFile = engine.index.files.get(cur.uri);
        const curCls: ClassSym = cur; const parentFqn: string | undefined = ((curCls.extendsRaw ?? []) as string[]).map((r: string) => resolveTypeRaw(r, cFile, curCls.fqn)[0]).find(Boolean);
        cur = parentFqn ? engine.index.byFqn.get(parentFqn.toLowerCase()) : undefined;
      }
      return [];
    }
    case 'propertylookup':
      return await returnExprTypesAsync(engine, doc, cls, expr);
    default:
      return [];
  }
}

/** $this->prop 形式 return：属性类型走 memberTypes 通道（异步） */
async function returnExprTypesAsync(engine: NavigationEngine, doc: ParsedDoc, cls: ClassSym | undefined, expr: any): Promise<string[]> {
  const what = expr.what;
  if (!what || what.kind !== 'variable' || what.name !== 'this') return [];
  const name = expr.offset && (typeof expr.offset.name === 'string' ? expr.offset.name : expr.offset.name?.name);
  if (typeof name !== 'string') return [];
  if (!cls) return [];
  const ref = await findMember(cls, name, engine.ctx);
  if (!ref) return [];
  const t = await memberTypes(ref, engine.ctx);
  const file = engine.index.files.get(doc.uri);
  return t.fqns.map((f) => docTypeForFqn(f, file));
}

/** docblock 类型串：已 use → 短名；同命名空间 → 相对名；否则全限定 \FQN（保证可解析） */
function docTypeForFqn(fqn: string, file: { namespace: string; imports: Map<string, string> } | undefined): string {
  const short = fqn.slice(fqn.lastIndexOf('\\') + 1);
  if (file) {
    for (const target of file.imports.values()) {
      if (target.toLowerCase() === fqn.toLowerCase()) return short;
    }
    const ns = (file.namespace ?? '').toLowerCase();
    if (ns && fqn.toLowerCase().startsWith(ns + '\\')) return fqn.slice(ns.length + 1);
  }
  return '\\' + fqn;
}

/** 方法/函数体 return 字面量类型（含作用域：跳过嵌套闭包内部） */
function literalReturnsOf(fnNode: any, doc: ParsedDoc): string[] {
  const parts: string[] = [];
  let has = false;
  walkScoped(fnNode, (node) => {
    if (node.kind !== 'return') return;
    has = true;
    const expr = node.expression ?? node.expr;
    if (!expr) return;
    switch (expr.kind) {
      case 'integer':
        parts.push('int');
        break;
      case 'float':
        parts.push('float');
        break;
      case 'string':
        parts.push('string');
        break;
      case 'boolean':
        parts.push('bool');
        break;
      case 'null':
        parts.push('null');
        break;
      case 'array':
        parts.push('array');
        break;
      default:
        break;
    }
  });
  void doc;
  if (!has) return [];
  return parts;
}

function unionOf(parts: string[]): string | undefined {
  const uniq: string[] = [];
  for (const p of parts) if (!uniq.includes(p)) uniq.push(p);
  if (uniq.length === 0) return undefined;
  const hasNull = uniq.includes('null');
  const rest = uniq.filter((p) => p !== 'null');
  if (rest.length === 0) return 'null';
  const joined = rest.join('|');
  return hasNull ? (rest.length === 1 ? '?' + joined : joined + '|null') : joined;
}

/** 方法体 throw new X 的类型字符串（别名解析为 doc 类型） */
function collectThrows(doc: ParsedDoc, m: MethodSym): string[] {
  const body = m.astNode?.body;
  if (!body) return [];
  const out = new Set<string>();
  walkScoped(body, (node: any) => {
    if (node.kind !== 'throw') return;
    const e = node.what ?? node.expression ?? node.expr;
    if (e?.kind === 'new') {
      const raw = rawTypeOf(e.what);
      if (raw) out.add(raw);
    } else if (e && typeof e.name === 'string') {
      out.add(e.name);
    }
  });
  void doc;
  return [...out].sort();
}

/** ---------- 通用小件 ---------- */

/** 作用域感知遍历：嵌套 function 一律不入（return/throw 属于内层），闭包同 */
function walkScoped(root: any, visit: (node: any) => void): void {
  const walk = (node: any, inFn: boolean): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inFn);
      return;
    }
    const isFn = node.kind === 'function' || node.kind === 'closure' || node.kind === 'arrowfn' || node.kind === 'arrowfunction';
    const childInFn = inFn || isFn;
    if (!inFn && typeof node.kind === 'string') visit(node);
    if (node.kind === 'usegroup' || node.kind === 'useitem') return;
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const value = (node as Record<string, unknown>)[key];
      if (value && typeof value === 'object') walk(value, childInFn);
    }
  };
  walk(root, false);
}

function walkNoUseNodes(root: any, visit: (node: any) => void): void {
  const stack: any[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (typeof node.kind === 'string') visit(node);
    if (node.kind === 'usegroup' || node.kind === 'useitem') continue;
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const value = (node as Record<string, unknown>)[key];
      if (value && typeof value === 'object') stack.push(value);
    }
  }
}

function fnNodeAtRange(doc: ParsedDoc, sel: LocationLike['range']): any | undefined {
  let found: any | undefined;
  walkNoUseNodes(doc.ast, (node) => {
    if (found || node.kind !== 'function' || !node.name?.loc) return;
    const range = lspRangeForJsSpan(doc, byteIndexOf(doc, node.name.loc.start.offset), byteIndexOf(doc, node.name.loc.end.offset));
    if (range.start.line === sel.start.line && range.start.character === sel.start.character) found = node;
  });
  return found;
}

function inRange2(range: LocationLike['range'], line: number, character: number): boolean {
  const { start, end } = range;
  if (line < start.line || line > end.line) return false;
  if (line === start.line && character < start.character) return false;
  if (line === end.line && character > end.character) return false;
  return true;
}
