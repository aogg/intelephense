/**
 * engine/symbols.ts：单文件与跨文件符号表 + 全局索引。
 * - FileIndex：每文件的 namespace / use 导入表 / 类符号（含成员与 docblock）；
 * - WorkspaceIndex：fqn→符号、uri→FileIndex、扫描兜底 fqn→uri（composer psr-4 + 目录扫描）；
 * - 解析结果按文件文本缓存：didChange 单文件重建，didChangeWatchedFiles 批量失效。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { locToRange, docblockOf, plainName, rawTypeOf } from './ast';
import { parseDocblock, DocblockInfo } from './docblock';
import type { ParsedDoc } from './ast';

export interface SymLoc {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface PropertySym extends SymLoc {
  name: string;
  typeRaw?: string; // 原生类型声明
  docType?: string; // docblock @var
  docblock?: DocblockInfo;
  visibility: string;
  isStatic: boolean;
  originVirtual?: boolean; // 类 docblock @property 生成的虚拟属性
}

export interface MethodSym extends SymLoc {
  name: string;
  visibility: string;
  isStatic: boolean;
  isAbstract: boolean;
  params: { name: string; typeRaw?: string; defaultRaw?: string }[];
  returnTypeRaw?: string;
  docblock?: DocblockInfo;
  astNode?: any; // 方法体 AST（赋值推断用）
  returnsNewSelf?: boolean; // 方法体内含 return new self/static（工厂推断用）
}

export interface ConstSym extends SymLoc {
  name: string;
  valueRaw?: string;
}

export interface TraitUseInfo {
  raw: string;
  adaptations: {
    alias?: { traitRaw?: string; method: string; newName?: string; visibility?: string };
    precedence?: { traitRaw: string; method: string; insteadOf: string[] };
  }[];
}

export interface ClassSym extends SymLoc {
  fqn: string;
  name: string;
  kind: 'class' | 'interface' | 'trait';
  extendsRaw: string[];
  implementsRaw: string[];
  traitUses: TraitUseInfo[];
  properties: PropertySym[];
  methods: MethodSym[];
  constants: ConstSym[];
  docblock?: DocblockInfo;
}

export interface FileIndex {
  uri: string;
  namespace: string;
  imports: Map<string, string>; // 别名(小写) → fqn
  classes: ClassSym[];
  parsedAt: number;
}

export interface WorkspacePaths {
  root: string; // fs 路径
}

/** 文本快速扫描：namespace/class/interface/trait 正则抽取 fqn→uri */
interface ScanEntry {
  uri: string;
  fqns: string[];
}

const MAX_SCAN_FILES = 8000;
const MAX_FILE_BYTES = 1_500_000;
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', 'runtime', 'dist', 'public', '.idea', '.vscode']);

export class WorkspaceIndex {
  files = new Map<string, FileIndex>();
  byFqn = new Map<string, ClassSym>();
  private scan: Map<string, string> = new Map(); // fqn → uri（小写键）
  private scanned = false;
  private scanning: Promise<void> | undefined;
  psr4: { prefix: string; dir: string }[] = [];
  /** 扫描根下所有 .php 文件（含不声明类符号的文件，rename/引用收集用） */
  allFiles = new Set<string>();

  constructor(public readonly rootInfo: WorkspacePaths) {}

  get root(): string {
    return this.rootInfo.root;
  }

  /** composer.json psr-4 优先；目录扫描兜底 */
  async ensureScan(): Promise<void> {
    if (this.scanned) return;
    if (!this.scanning) {
      this.scanning = (async () => {
        this.readComposer();
        this.allFiles.clear();
        const entries: ScanEntry[] = [];
        const roots = new Set<string>();
        for (const { dir } of this.psr4) roots.add(path.resolve(this.root, dir));
        // FastAdmin/ThinkPHP 常见根目录兜底
        for (const d of ['application', 'app', 'extend', 'src']) {
          const abs = path.resolve(this.root, d);
          if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) roots.add(abs);
        }
        for (const dirAbs of roots) this.walkDir(dirAbs, entries, 0);
        for (const entry of entries) {
          for (const fqn of entry.fqns) this.scan.set(fqn.toLowerCase(), entry.uri);
        }
        this.scanned = true;
      })();
    }
    return this.scanning;
  }

  private readComposer(): void {
    try {
      const composerPath = path.resolve(this.root, 'composer.json');
      if (!fs.existsSync(composerPath)) return;
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
      const psr4 = composer?.autoload?.['psr-4'];
      if (psr4 && typeof psr4 === 'object') {
        for (const [prefix, dir] of Object.entries(psr4)) {
          if (typeof dir === 'string') this.psr4.push({ prefix: prefix.replace(/\\+$/, ''), dir });
        }
      }
    } catch {
      // composer.json 解析失败：走目录扫描兜底
    }
  }

  private walkDir(dirAbs: string, out: ScanEntry[], depth: number): void {
    if (depth > 6 || out.length > MAX_SCAN_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of entries) {
      const full = path.join(dirAbs, dirent.name);
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) continue;
        this.walkDir(full, out, depth + 1);
      } else if (dirent.isFile() && dirent.name.endsWith('.php')) {
        if (out.length >= MAX_SCAN_FILES) return;
        try {
          const stat = fs.statSync(full);
          if (stat.size > MAX_FILE_BYTES) continue;
          const text = fs.readFileSync(full, 'utf8');
          const fqns: string[] = [];
          const nsMatch = /\bnamespace\s+([\w\\]+)\s*;/.exec(text);
          const ns = nsMatch ? nsMatch[1] : '';
          const declRe = /\b(?:abstract\s+|final\s+|readonly\s+)*(class|interface|trait)\s+(\w+)/g;
          let dm: RegExpExecArray | null;
          while ((dm = declRe.exec(text)) !== null) {
            const fqn = (ns ? ns + '\\' : '') + dm[2];
            fqns.push(fqn);
          }
          if (fqns.length > 0) out.push({ uri: pathToFileURL(full).href, fqns });
          this.allFiles.add(pathToFileURL(full).href);
        } catch {
          // 读不了的文件跳过
        }
      }
    }
  }

  /** 由 ParsedDoc 构建 FileIndex 并入索引 */
  applyFile(doc: ParsedDoc, classes: ClassSym[]): FileIndex {
    const file: FileIndex = {
      uri: doc.uri,
      namespace: extractNamespace(doc.ast),
      imports: extractImports(doc.ast),
      classes,
      parsedAt: Date.now(),
    };
    this.files.set(doc.uri, file);
    for (const cls of classes) this.byFqn.set(cls.fqn.toLowerCase(), cls);
    return file;
  }

  removeFile(uri: string): void {
    const file = this.files.get(uri);
    if (file) for (const cls of file.classes) this.byFqn.delete(cls.fqn.toLowerCase());
    this.files.delete(uri);
  }

  invalidateAll(): void {
    this.scanned = false;
    this.scanning = undefined;
    this.scan.clear();
    this.allFiles.clear();
  }

  lookupFqnUri(fqn: string): string | undefined {
    return this.scan.get(fqn.toLowerCase());
  }

  /** 扫描快照（fqn 小写 → uri），跨文件遍历入口 */
  scanEntries(): [string, string][] {
    return [...this.scan.entries()];
  }
}

// ---------- FileIndex 构建（AST → ClassSym） ----------

export function extractNamespace(ast: any): string {
  for (const child of ast.children ?? []) {
    if (child.kind === 'namespace') {
      const name = typeof child.name === 'string' ? child.name : plainName(child.name);
      if (name) return name;
    }
  }
  return '';
}

export function extractImports(ast: any): Map<string, string> {
  const imports = new Map<string, string>();
  const topNodes = collectTopNodes(ast);
  for (const node of topNodes) {
    if (node.kind !== 'usegroup' && node.kind !== 'useitem') continue;
    const groupType = node.type; // null|'function'|'const'
    const prefix = typeof node.name === 'string' ? node.name : undefined; // group use 前缀；plain use 为 null
    const items = Array.isArray(node.items) ? node.items : [node];
    for (const item of items) {
      if (!item || item.kind !== 'useitem') continue;
      if (item.type === 'function' || item.type === 'const' || groupType === 'function' || groupType === 'const') continue;
      const itemName = typeof item.name === 'string' ? item.name : plainName(item.name);
      if (!itemName) continue;
      const fqn = prefix ? prefix + '\\' + itemName : itemName;
      const alias = item.alias ? plainName(item.alias) : lastSegment(itemName);
      if (alias) imports.set(alias.toLowerCase(), fqn);
    }
  }
  return imports;
}

function collectTopNodes(ast: any): any[] {
  const out: any[] = [];
  for (const child of ast.children ?? []) {
    if (child.kind === 'namespace') {
      const nsChildren = Array.isArray(child.children) ? child.children : Array.isArray(child.body) ? child.body : [];
      out.push(...nsChildren);
    } else {
      out.push(child);
    }
  }
  return out;
}

function lastSegment(name: string): string {
  const idx = Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/'));
  return idx >= 0 ? name.slice(idx + 1) : name;
}


export function buildClasses(uri: string, doc: ParsedDoc): ClassSym[] {
  const classes: ClassSym[] = [];
  const visit = (node: any): void => {
    if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'trait') {
      if (node.isAnonymous) return;
      const name = plainName(node.name);
      if (!name) return;
      const ns = extractNamespace(doc.ast);
      const fqn = (ns ? ns + '\\' : '') + name;
      const sym: ClassSym = {
        fqn,
        name,
        kind: node.kind,
        uri,
        range: locToRange(node.loc),
        selectionRange: selectRangeOf(node, uri),
        extendsRaw: extendsRawOf(node),
        implementsRaw: namesRawOf(node.implements),
        traitUses: traitUsesOf(node),
        properties: [],
        methods: [],
        constants: [],
        docblock: parseMaybeDocblock(docblockOf(node)),
      };
      for (const member of node.body ?? []) collectMember(uri, member, sym, doc);
      classes.push(sym);
    }
  };
  walkAll(doc, visit);
  return classes;
}

function walkAll(doc: ParsedDoc, visit: (node: any) => void): void {
  const stack: any[] = [...(doc.ast.children ?? [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (typeof node.kind === 'string') visit(node);
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'doc') continue;
      const value = (node as Record<string, unknown>)[key];
      if (value && typeof value === 'object') stack.push(value);
    }
  }
}

function selectRangeOf(node: any, uri: string): SymLoc['selectionRange'] {
  void uri;
  const nameLoc = node.name && node.name.loc ? node.name.loc : node.loc;
  return locToRange(nameLoc);
}

function extendsRawOf(node: any): string[] {
  if (!node.extends) return [];
  if (Array.isArray(node.extends)) return node.extends.map((e: any) => rawTypeOf(e)).filter((x: string | undefined): x is string => !!x);
  const raw = rawTypeOf(node.extends);
  return raw ? [raw] : [];
}

function namesRawOf(list: any): string[] {
  if (!Array.isArray(list)) return [];
  return list.map(rawTypeOf).filter((x): x is string => !!x);
}

function traitUsesOf(node: any): TraitUseInfo[] {
  const out: TraitUseInfo[] = [];
  for (const member of node.body ?? []) {
    if (member.kind !== 'traituse') continue;
    const adaptations: TraitUseInfo['adaptations'] = [];
    for (const ad of member.adaptations ?? []) {
      if (ad.kind === 'traitalias') {
        adaptations.push({
          alias: {
            traitRaw: ad.trait ? rawTypeOf(ad.trait) : undefined,
            method: plainName(ad.method) ?? '',
            newName: ad.as ? plainName(ad.as) : undefined,
            visibility: typeof ad.visibility === 'string' ? ad.visibility : undefined,
          },
        });
      } else if (ad.kind === 'traitprecedence') {
        adaptations.push({
          precedence: {
            traitRaw: ad.trait ? rawTypeOf(ad.trait) ?? '' : '',
            method: plainName(ad.method) ?? '',
            insteadOf: (ad.instead ?? []).map((e: any) => rawTypeOf(e)).filter((x: string | undefined): x is string => !!x),
          },
        });
      }
    }
    for (const trait of member.traits ?? []) {
      const raw = rawTypeOf(trait);
      if (raw) out.push({ raw, adaptations });
    }
  }
  return out;
}

function parseMaybeDocblock(raw: string | undefined): DocblockInfo | undefined {
  return raw ? parseDocblock(raw) : undefined;
}

function collectMember(uri: string, member: any, sym: ClassSym, doc: ParsedDoc): void {
  if (member.kind === 'propertystatement') {
    const docblock = parseMaybeDocblock(docblockOf(member));
    const docType = docblock?.vars[0]?.type;
    for (const prop of member.properties ?? []) {
      const name = plainName(prop.name);
      if (!name) continue;
      const typeRaw = rawTypeOf(prop.type);
      sym.properties.push({
        name,
        uri,
        range: locToRange(member.loc),
        selectionRange: locToRange(prop.loc),
        typeRaw: typeRaw ?? undefined,
        docType,
        docblock,
        visibility: typeof member.visibility === 'string' ? member.visibility : 'public',
        isStatic: !!member.isStatic,
      });
    }
  } else if (member.kind === 'method') {
    const name = plainName(member.name);
    if (!name) return;
    const docblock = parseMaybeDocblock(docblockOf(member));
    const params: MethodSym['params'] = [];
    for (const arg of member.arguments ?? member.args ?? []) {
      // 参数名是 variable 节点（name 属性可能是 '$name' 字符串），统一 plainName + 去 $
      let pname = plainName(arg?.name) ?? '';
      pname = pname.replace(/^\$/, '');
      params.push({
        name: pname,
        typeRaw: rawTypeOf(arg?.type) ?? undefined,
        defaultRaw: arg?.value?.loc ? doc.text.slice(arg.value.loc.start.offset, arg.value.loc.end.offset) : undefined,
      });
    }
    const returnsNewSelf = bodyReturnsNewSelf(member.body);
    sym.methods.push({
      name,
      uri,
      range: locToRange(member.loc),
      selectionRange: selectRangeOf(member, uri),
      visibility: typeof member.visibility === 'string' ? member.visibility : 'public',
      isStatic: !!member.isStatic,
      isAbstract: !!member.isAbstract,
      params,
      returnTypeRaw: rawTypeOf(member.type) ?? undefined,
      docblock,
      astNode: member,
      returnsNewSelf,
    });
  } else if (member.kind === 'classconstant') {
    const name = plainName(member.name);
    if (!name) return;
    sym.constants.push({
      name,
      uri,
      range: locToRange(member.loc),
      selectionRange: locToRange(member.name?.loc ?? member.loc),
      valueRaw: undefined,
    });
  }
}

function bodyReturnsNewSelf(body: any): boolean {
  if (!body) return false;
  let found = false;
  const visit = (node: any): void => {
    if (found || !node || typeof node !== 'object') return;
    if (node.kind === 'new') {
      const what = node.what;
      if (!what) return;
      // new self / new static：name 节点或 staticreference/selfreference（raw 字段）
      const nm = typeof what.name === 'string' ? what.name : typeof what.raw === 'string' ? what.raw : plainName(what);
      const lower = (nm ?? '').toLowerCase();
      if (lower === 'self' || lower === 'static') found = true;
    }
  };
  walkNodes(body, visit);
  return found;
}

function walkNodes(node: any, visit: (node: any) => void): void {
  const stack: any[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (Array.isArray(cur)) {
      stack.push(...cur);
      continue;
    }
    if (typeof cur.kind === 'string') visit(cur);
    for (const key of Object.keys(cur)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const value = (cur as Record<string, unknown>)[key];
      if (value && typeof value === 'object') stack.push(value);
    }
  }
}
