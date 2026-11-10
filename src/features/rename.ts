/**
 * features/rename.ts：textDocument/rename + textDocument/prepareRename（自研，官方免费版关闭）。
 * 质量口径：不确定项宁可漏改不可误改；结果按文件分组（documentChanges）。
 *
 * 类/接口/trait 改名：
 *  - AST 精确引用（use 别名表 + 命名空间兜底解析的 name 节点：new X / X::class / instanceof / 类型标注 / extends/implements / static 类名）；
 *  - use/import 行（FQN 单反斜杠形式，别名 as 保留不动）；
 *  - 全文本 FQN 引用（含字符串 think\Config 形式、docblock FQN，兼容 \\ 双反斜杠写法）；
 *  - docblock 标签行短名引用（@param/@var/@return/@throws/@see/@mixin/@property…，仅限本文件已 use 该类或同命名空间）；
 *  - PSR-4 文件随名迁移（renameFile；文件名=类名才迁移，目标已存在则放弃）。
 * 方法改名：继承族声明（父类/子类/接口/trait 同名声明）+ 可解析调用点（->m(、self::/static::/parent::m(、Fqn::m()。
 * 属性改名：继承族声明 + $this->x / $obj->x 读写 + ::$x + 继承族 docblock @property/@var $x。
 * 函数改名：声明处 + 命名空间可解析调用点。局部变量/参数：最小 enclosing 作用域（子闭包参数遮蔽则排除）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { byteIndexOf, docblockCommentNode, lspRangeForJsSpan, plainName, rawTypeOf } from '../engine/ast';
import type { ParsedDoc } from '../engine/ast';
import type { ClassSym, FileIndex, MethodSym, PropertySym } from '../engine/symbols';
import { resolveName, resolveTypeRaw } from '../engine/resolver';
import { hierarchySets, usesTrait, workspaceClasses, declarationAt } from './implementation';
import { hitAtPosition, containingNodes, type NavigationEngine, type DefinitionParamsLike, type LocationLike } from './navigation';
import { enclosingClass, resolveReceiverFqns, type ParsedDocLike } from '../engine/member';

export type LspRange = LocationLike['range'];

export interface PrepareRenameResult {
  range: LspRange;
  placeholder: string;
}

export interface RenameTextEdit {
  range: LspRange;
  newText: string;
}
export interface RenameEditChange {
  kind: 'edit';
  textDocument: { uri: string; version: null };
  edits: RenameTextEdit[];
}
export interface RenameFileChange {
  kind: 'rename';
  oldUri: string;
  newUri: string;
}
export interface RenameWorkspaceEdit {
  documentChanges: (RenameEditChange | RenameFileChange)[];
}

export interface RenameParamsLike extends DefinitionParamsLike {
  newName?: string;
}

const MAX_HIERARCHY_DEPTH = 10;
const MAX_SCAN_BYTES = 1_500_000;

/** ---------- 每文件编辑收集（去重 + 防重叠 + 按位置排序） ---------- */

class FileEdits {
  private byUri = new Map<string, { doc: ParsedDoc; edits: RenameTextEdit[] }>();

  add(doc: ParsedDoc, startJs: number, endJs: number, newText: string): boolean {
    if (startJs < 0 || endJs > doc.text.length || endJs <= startJs) return false;
    const range = lspRangeForJsSpan(doc, startJs, endJs);
    if (doc.text.slice(startJs, endJs).length === 0) return false;
    let entry = this.byUri.get(doc.uri);
    if (!entry) {
      entry = { doc, edits: [] };
      this.byUri.set(doc.uri, entry);
    }
    for (const e of entry.edits) {
      if (overlaps(e.range, range)) return false; // 与更精确的编辑冲突：宁可漏改
    }
    entry.edits.push({ range, newText });
    return true;
  }

  /** 以 AST/符号的 LSP range 直接添加（range 已是 LSP 坐标） */
  addRange(doc: ParsedDoc, range: LspRange, newText: string): void {
    const lineStarts = doc.lineIndex;
    const s = lineStarts[Math.min(range.start.line, lineStarts.length - 1)] + range.start.character;
    const e = lineStarts[Math.min(range.end.line, lineStarts.length - 1)] + range.end.character;
    this.add(doc, s, e, newText);
  }

  changes(): RenameEditChange[] {
    const out: RenameEditChange[] = [];
    for (const [uri, { edits }] of this.byUri) {
      if (edits.length === 0) continue;
      edits.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
      out.push({ kind: 'edit', textDocument: { uri, version: null }, edits });
    }
    return out;
  }

  rangesOf(uri: string): LspRange[] {
    return (this.byUri.get(uri)?.edits ?? []).map((e) => e.range);
  }

  total(): number {
    let n = 0;
    for (const [, { edits }] of this.byUri) n += edits.length;
    return n;
  }
}

function overlaps(a: LspRange, b: LspRange): boolean {
  const aEndBefore = a.end.line < b.start.line || (a.end.line === b.start.line && a.end.character <= b.start.character);
  const bEndBefore = b.end.line < a.start.line || (b.end.line === a.start.line && b.end.character <= a.start.character);
  return !(aEndBefore || bEndBefore);
}

/** ---------- 工具 ---------- */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** FQN 文本引用正则：段间 1~2 个反斜杠，可选前导 \，词尾防前缀误配 */
function fqnRegex(fqn: string): RegExp {
  const segs = fqn.split('\\').filter(Boolean);
  const body = segs.map(escapeRe).join('(?:\\\\|\\\\\\\\)');
  return new RegExp(`(?<![\\\\\\w])(?:\\\\|\\\\\\\\)?${body}(?![\\\\\\w])`, 'g');
}

function normFqn(s: string): string {
  return s.replace(/^\\/, '').toLowerCase();
}

function spanText(doc: ParsedDoc, range: LspRange): string {
  const li = doc.lineIndex;
  const s = li[Math.min(range.start.line, li.length - 1)] + range.start.character;
  const e = li[Math.min(range.end.line, li.length - 1)] + range.end.character;
  return doc.text.slice(s, e);
}

/** 带父节点感知 + 跳过 use 导入子树（use 行由文本层统一处理） */
function walkNoUse(root: any, visit: (node: any) => void): void {
  const stack: { node: any; inUse: boolean }[] = [{ node: root, inUse: false }];
  while (stack.length > 0) {
    const { node, inUse } = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, inUse });
      continue;
    }
    if (typeof node.kind === 'string') visit(node);
    const nextInUse = inUse || node.kind === 'usegroup' || node.kind === 'useitem';
    if (inUse) continue; // use 子树不深入（文本层已覆盖）
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const value = (node as Record<string, unknown>)[key];
      if (value && typeof value === 'object') stack.push({ node: value, inUse: nextInUse });
    }
  }
}

const FN_KINDS = new Set(['function', 'closure', 'arrowfn', 'arrowfunction', 'method']);
function isFnKind(kind: string): boolean {
  return FN_KINDS.has(kind);
}

/** 文件内全部 docblock 注释节点（按起始偏移去重） */
function docblocksOf(doc: ParsedDoc): { value: string; startOffset: number; endOffset: number }[] {
  const out = new Map<number, { value: string; startOffset: number; endOffset: number }>();
  walkNoUse(doc.ast, (node) => {
    const d = docblockCommentNode(node);
    if (d && !out.has(d.startOffset)) out.set(d.startOffset, d);
  });
  return [...out.values()];
}

/** 候选文件迭代：内存镜像文本优先，磁盘文本预筛（needle 不出现则不解析）。codeLens 计数复用 */
export async function forEachCandidateDoc(engine: import('./navigation').NavigationEngine, needle: string, fn: (doc: ParsedDoc) => Promise<void> | void): Promise<void> {
  if (!needle) return;
  await engine.index.ensureScan();
  for (const uri of engine.allKnownUris()) {
    let text: string | undefined;
    const cached = engine.peekDoc(uri);
    if (cached) {
      text = cached.text;
    } else {
      try {
        const p = fileURLToPath(uri);
        const stat = fs.statSync(p);
        if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) continue;
        text = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
    }
    if (!text || !text.includes(needle)) continue;
    const doc = await engine.getDoc(uri);
    if (doc) await fn(doc);
  }
}

/** ---------- rename 目标判定 ---------- */

type RenameTarget =
  | { kind: 'class'; sym: ClassSym; refRange?: LspRange }
  | { kind: 'method'; owner: ClassSym; method: MethodSym; refRange?: LspRange }
  | { kind: 'property'; owner: ClassSym; property: PropertySym; refRange?: LspRange }
  | { kind: 'function'; name: string; fqn: string; declUri: string; declRange: LspRange }
  | { kind: 'variable'; name: string; uri: string; varRange: LspRange; fnNode: any };

async function findRenameTarget(engine: import('./navigation').NavigationEngine, params: DefinitionParamsLike): Promise<RenameTarget | undefined> {
  const doc = await engine.getDoc(params.textDocument.uri);
  if (!doc) return undefined;
  const line = params.position.line;
  const character = params.position.character;
  const view: ParsedDocLike = { uri: doc.uri, ast: doc.ast, classNodes: (doc as any).classNodes ?? [] };
  const file = engine.index.files.get(doc.uri);
  const ownerClass = enclosingClass(view, line, character);

  // 1) 类声明名（classNodes 的 selectionRange 即名称 token）
  for (const { sym } of view.classNodes) {
    if (inRange(sym.selectionRange, line, character)) return { kind: 'class', sym };
  }

  // 2) 类名引用 / 函数调用（name 节点）
  for (const node of containingNodes(doc, line, character)) {
    if (node.kind !== 'name') continue;
    if (!node.loc || !inLoc(line, character, node.loc)) continue;
    const raw = typeof node.name === 'string' ? node.name : plainName(node);
    if (!raw) continue;
    const fqns = resolveTypeRaw(raw, file, ownerClass?.fqn);
    for (const fqn of fqns) {
      const cls = await engine.resolveClass(fqn);
      if (cls) {
        const range = rangeOfNameNode(doc, node, lastSegment(raw));
        return { kind: 'class', sym: cls, refRange: range };
      }
    }
    // 未解析为类：函数调用兜底（uqn → 当前命名空间 + 名称；工作区声明才可改）
    const resolved = normFqn(resolveName(raw, file));
    const decl = await findFunctionDeclaration(engine, resolved, lastSegment(resolved));
    if (decl) {
      return { kind: 'function', name: decl.name, fqn: resolved, declUri: decl.uri, declRange: decl.range };
    }
    return undefined;
  }

  // 3) 成员引用（$obj->m / self::m / parent::m）
  const hit = await hitAtPosition(engine, doc, line, character);
  if (hit && hit.kind === 'member') {
    if (hit.ref.kind === 'method' && hit.ref.method) {
      return { kind: 'method', owner: hit.ref.owner, method: hit.ref.method, refRange: hit.memberRange };
    }
    if (hit.ref.kind === 'property' && hit.ref.property && !hit.ref.property.originVirtual) {
      return { kind: 'property', owner: hit.ref.owner, property: hit.ref.property, refRange: hit.memberRange };
    }
    if (hit.ref.kind === 'property' && hit.ref.property) return undefined; // docblock 虚拟属性不可改名（无实体声明）
    return undefined;
  }

  // 4) 成员声明处（方法名 / 属性名 token）
  const decl = declarationAt(doc, line, character);
  if (decl?.kind === 'method') {
    return { kind: 'method', owner: decl.cls, method: decl.method, refRange: decl.method.selectionRange };
  }

  // 5) 属性声明名（propertystatement 内）
  for (const { sym } of view.classNodes) {
    for (const p of sym.properties) {
      if (p.originVirtual) continue;
      if (inRange(p.selectionRange, line, character)) return { kind: 'property', owner: sym, property: p, refRange: p.selectionRange };
    }
  }

  // 6) 函数声明名（顶层 function）
  const fnDecl = functionDeclarationAt(doc, line, character);
  if (fnDecl) {
    const fqn = normFqn(resolveName(fnDecl.name, file));
    return { kind: 'function', name: fnDecl.name, fqn, declUri: doc.uri, declRange: fnDecl.range };
  }

  // 7) 局部变量 / 参数（$name token，含参数声明 identifier "$name"）
  for (const node of containingNodes(doc, line, character)) {
    if (node.kind !== 'variable' && node.kind !== 'identifier') continue;
    if (!node.loc || !inLoc(line, character, node.loc)) continue;
    const span = doc.text.slice(byteIndexOf(doc, node.loc.start.offset), byteIndexOf(doc, node.loc.end.offset));
    if (!/^\$[A-Za-z_\x80-\xff][\w\x80-\xff]*$/.test(span)) continue;
    const name = span.slice(1);
    if (name === 'this') return undefined;
    const fnNode = smallestEnclosingFn(doc, node);
    if (!fnNode) return undefined;
    return {
      kind: 'variable',
      name,
      uri: doc.uri,
      varRange: locRangeOfSpan(doc, node.loc),
      fnNode,
    };
  }
  return undefined;
}

function lastSegment(raw: string): string {
  const idx = raw.lastIndexOf('\\');
  return idx >= 0 ? raw.slice(idx + 1) : raw;
}

/** name 节点 loc 内「最后一段」的 LSP range（rename 只改类名段，不动限定前缀） */
function rangeOfNameNode(doc: ParsedDoc, node: any, segment: string): LspRange | undefined {
  if (!node.loc) return undefined;
  const startJs = byteIndexOf(doc, node.loc.start.offset);
  const endJs = byteIndexOf(doc, node.loc.end.offset);
  const text = doc.text.slice(startJs, endJs);
  const segStart = text.lastIndexOf(segment);
  if (segStart < 0) return undefined;
  return lspRangeForJsSpan(doc, startJs + segStart, startJs + segStart + segment.length);
}

function locRangeOfSpan(doc: ParsedDoc, loc: any): LspRange {
  return lspRangeForJsSpan(doc, byteIndexOf(doc, loc.start.offset), byteIndexOf(doc, loc.end.offset));
}

async function findFunctionDeclaration(
  engine: import('./navigation').NavigationEngine,
  fqnLower: string,
  name: string,
): Promise<{ uri: string; range: LspRange; name: string } | undefined> {
  let found: { uri: string; range: LspRange; name: string } | undefined;
  await forEachCandidateDoc(engine, name, (doc) => {
    if (found) return;
    walkNoUse(doc.ast, (node) => {
      if (found || node.kind !== 'function') return;
      const n = plainName(node.name);
      if (!n || n !== name) return;
      const file = engine.index.files.get(doc.uri);
      const resolved = normFqn(resolveName(n, file));
      if (resolved === fqnLower && node.name?.loc) {
        found = { uri: doc.uri, range: locRangeOfSpan(doc, node.name.loc), name };
      }
    });
  });
  return found;
}

function functionDeclarationAt(doc: ParsedDoc, line: number, character: number): { name: string; range: LspRange } | undefined {
  let found: { name: string; range: LspRange } | undefined;
  walkNoUse(doc.ast, (node) => {
    if (found || node.kind !== 'function') return;
    if (!node.name?.loc) return;
    const range = locRangeOfSpan(doc, node.name.loc);
    if (inRange(range, line, character)) found = { name: plainName(node.name) ?? '', range };
  });
  return found;
}

/** 最小 enclosing 函数/闭包（变量作用域用） */
function smallestEnclosingFn(doc: ParsedDoc, target: any): any | undefined {
  let best: any | undefined;
  let bestSize = Infinity;
  const consider = (node: any): void => {
    if (!node?.loc || !isFnKind(node.kind)) return;
    const ts = target.loc?.start?.offset ?? -1;
    const te = target.loc?.end?.offset ?? -1;
    const s = node.loc.start.offset;
    const e = node.loc.end.offset;
    if (ts >= s && te <= e && e - s < bestSize) {
      best = node;
      bestSize = e - s;
    }
  };
  walkNoUse(doc.ast, consider);
  return best;
}

function paramNamesOf(fnNode: any): Set<string> {
  const out = new Set<string>();
  const params = fnNode?.arguments ?? fnNode?.args ?? [];
  for (const p of Array.isArray(params) ? params : []) {
    const t = typeof p?.name === 'string' ? p.name : plainName(p?.name);
    if (typeof t === 'string') out.add(t.startsWith('$') ? t : '$' + t);
  }
  return out;
}

function closureUseNames(fnNode: any): Set<string> {
  const out = new Set<string>();
  for (const u of fnNode?.uses ?? []) {
    const t = typeof u?.name === 'string' ? u.name : plainName(u);
    if (typeof t === 'string') out.add(t.startsWith('$') ? t : '$' + t);
  }
  return out;
}

/** ---------- prepareRename ---------- */

export async function prepareRename(engine: import('./navigation').NavigationEngine, params: DefinitionParamsLike): Promise<PrepareRenameResult | null> {
  const target = await findRenameTarget(engine, params);
  if (!target) return null;
  switch (target.kind) {
    case 'class':
      return { range: target.refRange ?? target.sym.selectionRange, placeholder: target.sym.name };
    case 'method':
      return { range: target.refRange ?? target.method.selectionRange, placeholder: target.method.name };
    case 'property':
      return { range: target.refRange ?? target.property.selectionRange, placeholder: '$' + target.property.name };
    case 'function':
      return { range: target.declRange, placeholder: target.name };
    case 'variable':
      return { range: target.varRange, placeholder: '$' + target.name };
  }
}

/** ---------- rename ---------- */

export async function rename(engine: import('./navigation').NavigationEngine, params: RenameParamsLike): Promise<RenameWorkspaceEdit | null> {
  const newName = (params.newName ?? '').trim();
  if (!newName || !/^[A-Za-z_\x80-\xff][\w\x80-\xff]*$/.test(newName)) return null;
  const target = await findRenameTarget(engine, params);
  if (!target) return null;
  const edits = new FileEdits();
  let fileChange: RenameFileChange | undefined;

  if (target.kind === 'class') {
    fileChange = await renameClassLike(engine, target.sym, newName, edits);
  } else if (target.kind === 'method') {
    await renameMethod(engine, target.owner, target.method, newName, edits);
  } else if (target.kind === 'property') {
    await renameProperty(engine, target.owner, target.property, newName, edits);
  } else if (target.kind === 'function') {
    await renameFunction(engine, target, newName, edits);
  } else if (target.kind === 'variable') {
    await renameVariable(engine, target, newName, edits);
  }

  const changes = edits.changes();
  if (changes.length === 0 && !fileChange) return null;
  // 文本编辑在前、文件重命名在后（客户端按数组顺序应用，保证改名前先改类声明）
  const documentChanges: (RenameEditChange | RenameFileChange)[] = [...changes];
  if (fileChange) documentChanges.push(fileChange);
  return { documentChanges };
}

/** ---------- 类/接口/trait ---------- */

async function renameClassLike(engine: import('./navigation').NavigationEngine, sym: ClassSym, newName: string, edits: FileEdits): Promise<RenameFileChange | undefined> {
  const fqn = sym.fqn;
  const fqnLower = fqn.toLowerCase();
  const oldName = sym.name;
  const ns = fqn.slice(0, fqn.length - oldName.length); // 含尾 \ 或空串

  await forEachCandidateDoc(engine, oldName, (doc) => {
    const file = engine.index.files.get(doc.uri);
    // 1) AST：类声明名 + 类引用名节点
    walkNoUse(doc.ast, (node) => {
      if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
        if (node.isAnonymous) return;
        const n = plainName(node.name);
        if (!n || n !== oldName || !node.name?.loc) return;
        const resolved = normFqn(resolveName(n, file));
        if (resolved !== fqnLower) return;
        edits.addRange(doc, locRangeOfSpan(doc, node.name.loc), newName);
        return;
      }
      if (node.kind !== 'name') return;
      const raw = typeof node.name === 'string' ? node.name : plainName(node);
      if (typeof raw !== 'string' || node.resolution === undefined) return;
      const seg = lastSegment(raw);
      if (seg !== oldName) return; // 大小写敏感且必须是旧类名本名（别名引用保留别名不动）
      const resolved = normFqn(resolveName(raw, file));
      if (resolved !== fqnLower) return;
      const range = rangeOfNameNode(doc, node, seg);
      if (range) edits.addRange(doc, range, newName);
    });

    // 2) 全文本 FQN 引用（use 行 / 字符串 think\Config 形式 / docblock FQN；兼容 \\ 写法）
    collectFqnTextEdits(doc, fqn, oldName, newName, edits);

    // 3) docblock 标签行短名引用（仅限本文件 use 了该类或同命名空间）
    collectDocblockWordEdits(doc, file, fqn, ns, oldName, newName, edits);
  });

  return psr4FileRename(engine, sym, newName);
}

/** PSR-4：文件名与类名一致才随名迁移；目标已存在则放弃（宁可漏改） */
function psr4FileRename(engine: import('./navigation').NavigationEngine, sym: ClassSym, newName: string): RenameFileChange | undefined {
  let p: string;
  try {
    p = fileURLToPath(sym.uri);
  } catch {
    return undefined;
  }
  const base = path.basename(p);
  if (base !== sym.name + '.php') return undefined;
  const newPath = path.join(path.dirname(p), newName + '.php');
  // composer psr-4 校验：映射前缀与 FQN 目录吻合才移动；否则仅当文件已在原位（目录不变）也允许同名迁移
  const psr4Ok = engine.index.psr4.some(({ prefix, dir }) => {
    const rel = fqnToRelPath(sym.fqn, prefix);
    if (!rel) return false;
    const expected = path.resolve(engine.index.root, dir, rel + '.php');
    return expected === path.resolve(p);
  });
  if (!psr4Ok && !fs.existsSync(p)) return undefined;
  if (fs.existsSync(newPath)) return undefined;
  return { kind: 'rename', oldUri: sym.uri, newUri: pathToFileURL(newPath).href };
}

function fqnToRelPath(fqn: string, prefix: string): string | undefined {
  const pf = prefix.replace(/\\+$/, '');
  if (!fqn.toLowerCase().startsWith(pf.toLowerCase() + '\\') && fqn.toLowerCase() !== pf.toLowerCase()) return undefined;
  const rest = fqn.slice(pf.length).replace(/^\\/, '');
  return rest.replace(/\\/g, '/');
}

function collectFqnTextEdits(doc: ParsedDoc, fqn: string, oldName: string, newName: string, edits: FileEdits): void {
  const re = fqnRegex(fqn);
  for (;;) {
    const m = re.exec(doc.text);
    if (!m) break;
    const start = m.index + m[0].length - oldName.length;
    const end = m.index + m[0].length;
    if (doc.text.slice(start, end).toLowerCase() !== oldName.toLowerCase()) continue;
    edits.add(doc, start, end, newName);
  }
}

function collectDocblockWordEdits(doc: ParsedDoc, file: FileIndex | undefined, fqn: string, ns: string, oldName: string, newName: string, edits: FileEdits): void {
  const fqnLower = fqn.toLowerCase();
  const nsLower = ns.replace(/\\$/, '').toLowerCase();
  const sameNs = normFqn((file?.namespace ?? '')) === nsLower;
  const imported = file ? [...file.imports.values()].some((v) => v.toLowerCase() === fqnLower) : false;
  if (!sameNs && !imported) return;
  const wordRe = new RegExp(`(?<![\\\\$\\\\w])${escapeRe(oldName)}(?![\\\\w])`, 'g');
  const baseJs = byteIndexOf(doc, 0); // ASCII 文档恒等；非 ASCII 经 byteIndexOf 映射
  void baseJs;
  for (const d of docblocksOf(doc)) {
    const startJs = byteIndexOf(doc, d.startOffset);
    const value = d.value;
    const lines = value.split('\n');
    let lineOffset = 0;
    for (const lineText of lines) {
      if (/@[\w-]+/.test(lineText) && lineText.includes(oldName)) {
        wordRe.lastIndex = 0;
        for (;;) {
          const wm = wordRe.exec(lineText);
          if (!wm) break;
          const s = startJs + lineOffset + wm.index;
          edits.add(doc, s, s + oldName.length, newName);
        }
      }
      lineOffset += lineText.length + 1;
    }
  }
}

/** ---------- 方法 ---------- */

/** 继承族（T4 codeLens / mixin 通道复用）：上行（extends/implements/trait use）+ 下行（全工作区）同名声明者 */
export interface MemberFamily {
  lower: Set<string>;
  classes: ClassSym[];
  traits: string[]; // 小写 fqn
}

function declaresMethod(cls: ClassSym, name: string): boolean {
  return cls.methods.some((m) => m.name === name);
}
function declaresProperty(cls: ClassSym, name: string): boolean {
  return cls.properties.some((p) => p.name === name && !p.originVirtual);
}

/** 继承族：上行（extends/implements/trait use）+ 下行（全工作区）同名声明者 */
/** 继承族：上行（extends/implements/trait use）+ 下行（全工作区）同名声明者。codeLens 计数复用 */
export async function memberFamily(engine: import('./navigation').NavigationEngine, owner: ClassSym, name: string, kind: 'method' | 'property'): Promise<MemberFamily> {
  const declares = kind === 'method' ? declaresMethod : declaresProperty;
  const family: MemberFamily = { lower: new Set<string>(), classes: [], traits: [] };
  const add = (cls: ClassSym): void => {
    const k = cls.fqn.toLowerCase();
    if (family.lower.has(k)) return;
    family.lower.add(k);
    family.classes.push(cls);
    if (cls.kind === 'trait') family.traits.push(k);
  };
  add(owner);

  // 上行
  const upVisit = async (cls: ClassSym, depth: number, seen: Set<string>): Promise<void> => {
    const key = cls.fqn.toLowerCase();
    if (depth > MAX_HIERARCHY_DEPTH || seen.has(key)) return;
    seen.add(key);
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
    for (const f of supers) {
      const s = await engine.resolveClass(f);
      if (!s) continue;
      if (declares(s, name)) add(s);
      await upVisit(s, depth + 1, seen);
    }
  };
  await upVisit(owner, 0, new Set<string>());

  // 下行
  for (const candidate of await workspaceClasses(engine)) {
    if (family.lower.has(candidate.fqn.toLowerCase())) continue;
    if (!declares(candidate, name)) continue;
    if (await relatedToFamily(engine, candidate, family)) add(candidate);
  }
  return family;
}

/** 候选类与族是否同类（自身/祖先链/接口/trait use 任一命中） */
async function relatedToFamily(engine: import('./navigation').NavigationEngine, cls: ClassSym, family: MemberFamily): Promise<boolean> {
  if (family.lower.has(cls.fqn.toLowerCase())) return true;
  const sets = await hierarchySets(engine, cls);
  for (const k of sets.classes) if (family.lower.has(k)) return true;
  for (const k of sets.interfaces) if (family.lower.has(k)) return true;
  for (const t of family.traits) if (await usesTrait(engine, cls, t)) return true;
  return false;
}

async function receiverRelated(engine: import('./navigation').NavigationEngine, fqns: string[], family: MemberFamily): Promise<boolean> {
  for (const fqn of fqns) {
    const cls = await engine.resolveClass(fqn);
    if (!cls) continue;
    if (await relatedToFamily(engine, cls, family)) return true;
  }
  return false;
}

async function renameMethod(engine: import('./navigation').NavigationEngine, owner: ClassSym, method: MethodSym, newName: string, edits: FileEdits): Promise<void> {
  const oldName = method.name;
  const family = await memberFamily(engine, owner, oldName, 'method');

  // 1) 族内全部声明
  for (const cls of family.classes) {
    const m = cls.methods.find((mm) => mm.name === oldName);
    if (!m) continue;
    const doc = await engine.getDoc(m.uri);
    if (!doc) continue;
    edits.addRange(doc, m.selectionRange, newName);
  }

  // 2) 可解析调用点（->m( / self::|static::|parent::|Fqn::m(）
  await collectMemberCallSiteEdits(engine, oldName, newName, family, edits);
}

/** 可解析成员访问点（rename 编辑与 T4 codeLens 引用计数共用） */
export interface MemberSite {
  uri: string;
  doc: ParsedDoc;
  range: LspRange;
  staticProp: boolean; // ::$name 形式（替换文本需 $ 前缀）
}

export type MemberSiteMode = 'method' | 'property';

/**
 * 全工作区收集某成员的「可解析访问点」：->m( / ::m(（mode=method）或 ->x / ::$x（mode=property）。
 * 与 rename 编辑器逻辑同源：接收者类型解析 + 继承族/mixin 通道相关性判定；宁可漏收不可误收。
 */
export async function collectMemberAccessSites(
  engine: import('./navigation').NavigationEngine,
  name: string,
  family: MemberFamily,
  mode: MemberSiteMode,
): Promise<MemberSite[]> {
  const sites: MemberSite[] = [];
  await forEachCandidateDoc(engine, name, async (doc) => {
    const view: ParsedDocLike = { uri: doc.uri, ast: doc.ast, classNodes: (doc as any).classNodes ?? [] };
    const file = engine.index.files.get(doc.uri);
    // walker 回调内不能 await：先同步收集，walker 结束后统一异步处理（逐文件独立队列，避免并发串扰）
    const pendingReceivers: { doc: ParsedDoc; node: any; nameNode: any; ownerClass: ClassSym | undefined }[] = [];
    const pendingStaticChecks: { doc: ParsedDoc; nameNode: any; fqns: string[]; staticProp: boolean }[] = [];
    walkNoUse(doc.ast, (node) => {
      if (node.kind !== 'methodlookup' && node.kind !== 'staticlookup' && node.kind !== 'propertylookup') return;
      if (node.kind === 'methodlookup' && mode !== 'method') return;
      if (!node.offset?.loc) return;
      const offset = node.offset;
      const nameNode = offset.kind === 'call' ? offset.what : offset;
      if (!nameNode?.loc) return;
      // 成员名 token：无 $ 前缀且精确等于旧名（静态属性 offset 是带 $ 的 variable，天然区分）
      const span = doc.text.slice(byteIndexOf(doc, nameNode.loc.start.offset), byteIndexOf(doc, nameNode.loc.end.offset));
      // php-parser 3.7：call 包在 lookup 外层（->m() 的 offset 是 identifier），用 offset 后是否紧跟 ( 判定方法调用
      const afterName = doc.text.slice(byteIndexOf(doc, nameNode.loc.end.offset), byteIndexOf(doc, nameNode.loc.end.offset) + 8);
      const methodCall =
        span === name &&
        (node.kind === 'methodlookup' ||
          (node.kind === 'propertylookup' && /^\s*\(/.test(afterName)) ||
          (node.kind === 'staticlookup' && offset.kind !== 'variable')); // Fqn::m( / self:: / parent::
      // propertylookup 且 offset 非 call、后不紧跟 ( → 属性访问；->m() 是方法调用（methodCall 分支处理）
      const propAccess =
        (node.kind === 'propertylookup' && offset.kind !== 'call' && span === name && !/^\s*\(/.test(afterName)) ||
        (node.kind === 'staticlookup' && offset.kind === 'variable' && span === '$' + name);
      const hit = mode === 'method' ? methodCall : propAccess;
      if (!hit) return;
      const pos = locRangeOfSpan(doc, node.loc).start;
      const ownerClass = enclosingClass(view, pos.line, pos.character);

      if (node.kind !== 'staticlookup') {
        // 异步解析在 walker 内不可等待：先收集，walker 外处理
        pendingReceivers.push({ doc, node, nameNode, ownerClass });
        return;
      }
      const what = node.what;
      const whatKind = what?.kind;
      let fqns: string[] = [];
      if (whatKind === 'selfreference' || whatKind === 'staticreference') {
        if (ownerClass) fqns = [ownerClass.fqn];
      } else if (whatKind === 'parentreference') {
        if (ownerClass) {
          const ocFile = engine.index.files.get(ownerClass.uri);
          fqns = (ownerClass.extendsRaw ?? []).map((raw) => resolveTypeRaw(raw, ocFile, ownerClass.fqn)[0]).filter((x): x is string => !!x);
        }
      } else {
        const raw = rawTypeOf(what);
        if (raw) fqns = resolveTypeRaw(raw, file, ownerClass?.fqn);
      }
      if (fqns.length > 0) pendingStaticChecks.push({ doc, nameNode, fqns, staticProp: offset.kind === 'variable' });
    });
    // walker 结束后统一异步处理（walk 回调不能 await）
    for (const item of pendingReceivers.splice(0)) {
      const fqns = await receiverFqnsWithParams(engine, item.doc, item.node, view, item.ownerClass);
      if (await receiverRelated(engine, fqns, family)) {
        sites.push({ uri: item.doc.uri, doc: item.doc, range: locRangeOfSpan(item.doc, item.nameNode.loc), staticProp: false });
      }
    }
    for (const item of pendingStaticChecks.splice(0)) {
      if (await receiverRelated(engine, item.fqns, family)) {
        sites.push({ uri: item.doc.uri, doc: item.doc, range: locRangeOfSpan(item.doc, item.nameNode.loc), staticProp: item.staticProp });
      }
    }
  });
  return sites;
}

async function collectMemberCallSiteEdits(
  engine: import('./navigation').NavigationEngine,
  oldName: string,
  newName: string,
  family: MemberFamily,
  edits: FileEdits,
): Promise<void> {
  for (const site of await collectMemberAccessSites(engine, oldName, family, 'method')) {
    edits.addRange(site.doc, site.range, newName);
  }
}

/** 接收者解析：常规推断优先，未命中时用「函数参数类型标注」兜底（function go(Base $b) 的 \$b）。codeLens 计数复用 */
export async function receiverFqnsWithParams(
  engine: import('./navigation').NavigationEngine,
  doc: ParsedDoc,
  lookupNode: any,
  view: ParsedDocLike,
  ownerClass: ClassSym | undefined,
): Promise<string[]> {
  const primary = await resolveReceiverFqns(lookupNode.what, view, ownerClass, engine.ctx);
  if (primary.length > 0) return primary;
  const what = lookupNode.what;
  if (!what || what.kind !== 'variable') return [];
  const varName = typeof what.name === 'string' ? what.name : plainName(what);
  if (!varName || varName === 'this') return [];
  const fnNode = smallestEnclosingFn(doc, what);
  if (!fnNode) return [];
  const params = fnNode.arguments ?? fnNode.args ?? [];
  for (const p of Array.isArray(params) ? params : []) {
    const pname = typeof p?.name === 'string' ? p.name : plainName(p?.name);
    const clean = typeof pname === 'string' ? pname.replace(/^\$/, '') : '';
    if (clean !== varName) continue;
    const raw = rawTypeOf(p?.type);
    if (!raw) return [];
    const file = engine.index.files.get(doc.uri);
    return resolveTypeRaw(raw, file, ownerClass?.fqn);
  }
  return [];
}

/** ---------- 属性 ---------- */

async function renameProperty(engine: import('./navigation').NavigationEngine, owner: ClassSym, property: PropertySym, newName: string, edits: FileEdits): Promise<void> {
  const oldName = property.name;
  const family = await memberFamily(engine, owner, oldName, 'property');

  // 1) 族内声明 + 属性 docblock @var $name
  for (const cls of family.classes) {
    const p = cls.properties.find((pp) => pp.name === oldName);
    if (!p) continue;
    const doc = await engine.getDoc(p.uri);
    if (!doc) continue;
    const declText = spanText(doc, p.selectionRange);
    edits.addRange(doc, p.selectionRange, declText.startsWith('$') ? '$' + newName : newName);
    // 属性声明 docblock（@var Type $name）
    const classNode = (doc as any).classNodes?.find((c: any) => c.sym.fqn.toLowerCase() === cls.fqn.toLowerCase())?.node;
    if (classNode) {
      for (const member of classNode.body ?? []) {
        if (member.kind !== 'propertystatement') continue;
        const names = (member.properties ?? []).map((pp: any) => plainName(pp?.name)).filter(Boolean);
        if (!names.includes(oldName)) continue;
        collectDocblockDollarEdits(doc, docblockCommentNode(member), oldName, newName, edits);
      }
    }
  }

  // 2) 继承族类级 docblock @property $name
  for (const cls of family.classes) {
    const doc = await engine.getDoc(cls.uri);
    if (!doc) continue;
    const classNode = (doc as any).classNodes?.find((c: any) => c.sym.fqn.toLowerCase() === cls.fqn.toLowerCase())?.node;
    if (!classNode) continue;
    collectDocblockDollarEdits(doc, docblockCommentNode(classNode), oldName, newName, edits);
  }

  // 3) 调用点：->x 读写 / ::$x
  await collectPropertyAccessEdits(engine, oldName, newName, family, edits);
}

async function collectPropertyAccessEdits(
  engine: import('./navigation').NavigationEngine,
  oldName: string,
  newName: string,
  family: MemberFamily,
  edits: FileEdits,
): Promise<void> {
  for (const site of await collectMemberAccessSites(engine, oldName, family, 'property')) {
    edits.addRange(site.doc, site.range, (site.staticProp ? '$' : '') + newName);
  }
}

/** docblock（类级 @property / 属性级 @var）中 $name 的标签行编辑 */
function collectDocblockDollarEdits(doc: ParsedDoc, d: { value: string; startOffset: number; endOffset: number } | undefined, oldName: string, newName: string, edits: FileEdits): void {
  if (!d) return;
  const startJs = byteIndexOf(doc, d.startOffset);
  const dollarRe = new RegExp(`(?<![\\\\\\w])\\$${escapeRe(oldName)}(?![\\w])`, 'g');
  const lines = d.value.split('\n');
  let lineOffset = 0;
  for (const lineText of lines) {
    if (/@[\w-]+/.test(lineText) && lineText.includes('$' + oldName)) {
      dollarRe.lastIndex = 0;
      for (;;) {
        const m = dollarRe.exec(lineText);
        if (!m) break;
        const s = startJs + lineOffset + m.index;
        edits.add(doc, s, s + oldName.length + 1, '$' + newName);
      }
    }
    lineOffset += lineText.length + 1;
  }
}

/** ---------- 函数 ---------- */

async function renameFunction(
  engine: import('./navigation').NavigationEngine,
  target: { kind: 'function'; name: string; fqn: string; declUri: string; declRange: LspRange },
  newName: string,
  edits: FileEdits,
): Promise<void> {
  // 1) 声明处
  const declDoc = await engine.getDoc(target.declUri);
  if (declDoc) edits.addRange(declDoc, target.declRange, newName);

  // 2) 命名空间可解析调用点（name 节点 uqn → 当前命名空间兜底；FQN 形式同）
  const fqnLower = target.fqn;
  await forEachCandidateDoc(engine, target.name, (doc) => {
    const file = engine.index.files.get(doc.uri);
    walkNoUse(doc.ast, (node) => {
      if (node.kind !== 'name') return;
      const raw = typeof node.name === 'string' ? node.name : plainName(node);
      if (typeof raw !== 'string' || node.resolution === undefined) return;
      const seg = lastSegment(raw);
      if (seg !== target.name) return;
      if (normFqn(resolveName(raw, file)) !== fqnLower) return;
      const range = rangeOfNameNode(doc, node, seg);
      if (range) edits.addRange(doc, range, newName);
    });
  });
}

/** ---------- 局部变量 / 参数 ---------- */

async function renameVariable(engine: import('./navigation').NavigationEngine, target: { kind: 'variable'; name: string; uri: string; fnNode: any }, newName: string, edits: FileEdits): Promise<void> {
  const doc = await engine.getDoc(target.uri);
  if (!doc) return;
  const fnNode = target.fnNode;
  if (!fnNode?.loc) return;
  const token = '$' + target.name;
  const newText = '$' + newName;

  // 子作用域遮蔽集合：嵌套 function 一律遮蔽；闭包/箭头函数仅当参数同名遮蔽（use ($x) 绑定仍属外层变量）
  const shadowSet = new Set<any>();
  walkNoUse(fnNode, (node) => {
    if (!isFnKind(node.kind) || node === fnNode) return;
    if (node.kind === 'function') {
      shadowSet.add(node);
      return;
    }
    if (paramNamesOf(node).has(token)) shadowSet.add(node);
    // 闭包 use ($x)：绑定的是外层变量，不遮蔽
    void closureUseNames(node);
  });

  const walkScoped = (node: any, shadowed: boolean): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walkScoped(item, shadowed);
      return;
    }
    const childShadowed = shadowed || (node !== fnNode && shadowSet.has(node));
    if (!childShadowed && typeof node.kind === 'string') {
      if (node.kind === 'variable' || node.kind === 'identifier') {
        if (node.loc) {
          const s = byteIndexOf(doc, node.loc.start.offset);
          const e = byteIndexOf(doc, node.loc.end.offset);
          if (doc.text.slice(s, e) === token) edits.add(doc, s, e, newText);
        }
      }
    }
    if (node.kind === 'usegroup' || node.kind === 'useitem') return;
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const value = (node as Record<string, unknown>)[key];
      if (value && typeof value === 'object') walkScoped(value, childShadowed);
    }
  };
  walkScoped(fnNode, false);
}

function inRange(range: LspRange, line: number, character: number): boolean {
  const { start, end } = range;
  if (line < start.line || line > end.line) return false;
  if (line === start.line && character < start.character) return false;
  if (line === end.line && character > end.character) return false;
  return true;
}

function inLoc(line: number, character: number, loc: any): boolean {
  const sl = loc.start.line - 1;
  const el = loc.end.line - 1;
  if (line < sl || line > el) return false;
  if (line === sl && character < loc.start.column) return false;
  if (line === el && character > loc.end.column) return false;
  return true;
}
