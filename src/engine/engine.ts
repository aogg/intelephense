/**
 * engine/engine.ts：自研语义引擎门面。
 * - 文档镜像（didOpen/didChange/didClose fan-out），按文件文本缓存 AST/符号并失效；
 * - 跨文件类解析（fqn→符号：索引优先，composer psr-4 + 目录扫描兜底，按需解析文件）；
 * - 对 features 暴露 definition/hover/completion/foldingRange/selectionRange/documentLink。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createParser, parseText, walk, plainName, type ParsedDoc } from './ast';
import { WorkspaceIndex, buildClasses, type ClassSym } from './symbols';
import type { EngineContext } from './member';
import {
  navigationDefinition,
  navigationHover,
  navigationCompletion,
  type DefinitionParamsLike,
  type LocationLike,
} from '../features/navigation';
import { navigationTypeDefinition } from '../features/typeDefinition';
import { navigationImplementation } from '../features/implementation';
import { navigationDeclaration } from '../features/declaration';
import { prepareTypeHierarchy, typeHierarchySupertypes, typeHierarchySubtypes, type TypeHierarchyItem } from '../features/typeHierarchy';
import { prepareRename, rename, type PrepareRenameResult, type RenameWorkspaceEdit, type RenameParamsLike } from '../features/rename';
import { codeActions, codeActionResolve, type CodeActionLike, type CodeActionParamsLike } from '../features/codeAction';
import { computeCodeLenses, resolveCodeLens, type CodeLensLike } from '../features/codeLens';
import { computeInlayHints, resolveInlayHint, type InlayHintLike } from '../features/inlayHint';
import { computeFoldingRanges, type FoldingRange } from '../features/folding';
import { computeSelectionRanges, type SelectionRange } from '../features/selectionRange';
import { computeDocumentLinks, type DocumentLink } from '../features/documentLink';

export interface ParsedDocExt extends ParsedDoc {
  classNodes: { sym: ClassSym; node: any }[];
  mirrored: boolean; // 是否由 didOpen/didChange 镜像（false = 磁盘按需解析）
}

const MAX_ONDISK_BYTES = 3_000_000;

export class Engine {
  private parser = createParser();
  private docs = new Map<string, ParsedDocExt>();
  index: WorkspaceIndex;
  private rootPath: string | undefined;
  private resolving = new Set<string>();

  constructor() {
    this.index = new WorkspaceIndex({ root: '' });
  }

  /** initialize 时设置工作区根（fs 路径） */
  setWorkspace(rootPath: string): void {
    if (this.rootPath === rootPath) return;
    this.rootPath = rootPath;
    this.index = new WorkspaceIndex({ root: rootPath });
    this.docs.clear();
  }

  /** 供 features 使用的解析上下文 */
  get ctx(): EngineContext {
    return { index: this.index, resolveClass: (fqn) => this.resolveClass(fqn) };
  }

  // ---------- 文档镜像 ----------

  openDocument(uri: string, text: string): void {
    this.applyText(uri, text, true);
  }

  changeDocument(uri: string, changes: any[]): void {
    const current = this.docs.get(uri);
    let text = current?.text ?? '';
    for (const change of changes ?? []) {
      if (change && typeof change.text === 'string') {
        if (change.range) {
          const start = this.offsetOf(text, change.range.start);
          const end = this.offsetOf(text, change.range.end);
          text = text.slice(0, start) + change.text + text.slice(end);
        } else {
          text = change.text; // 全量
        }
      }
    }
    this.applyText(uri, text, true);
  }

  closeDocument(uri: string): void {
    // 文本缓存保留（供索引），仅标记不再镜像；后续 didOpen 会覆盖
    const doc = this.docs.get(uri);
    if (doc) doc.mirrored = false;
  }

  /** 查询文档（镜像优先；未镜像的工作区内文件按需从磁盘解析并缓存） */
  async getDoc(uri: string): Promise<ParsedDocExt | undefined> {
    const cached = this.docs.get(uri);
    if (cached) return cached;
    if (!this.rootPath) return undefined;
    let p: string;
    try {
      p = fileURLToPath(uri);
    } catch {
      return undefined;
    }
    const rootAbs = path.resolve(this.rootPath);
    if (!path.resolve(p).startsWith(rootAbs + path.sep)) return undefined;
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile() || stat.size > MAX_ONDISK_BYTES) return undefined;
      const text = fs.readFileSync(p, 'utf8');
      return this.applyText(uri, text, false);
    } catch {
      return undefined;
    }
  }

  private applyText(uri: string, text: string, mirrored: boolean): ParsedDocExt {
    const parsed = parseText(this.parser, uri, text);
    const classes = buildClasses(uri, parsed);
    this.index.applyFile(parsed, classes);
    const classNodes: { sym: ClassSym; node: any }[] = [];
    walk(parsed.ast, (node: any) => {
      const kind = node.kind;
      if (kind !== 'class' && kind !== 'interface' && kind !== 'trait') return;
      if (node.isAnonymous) return;
      const name = plainName(node.name);
      const sym = classes.find((c) => c.name === name);
      if (sym) classNodes.push({ sym, node });
    });
    const ext: ParsedDocExt = { ...parsed, classNodes, mirrored };
    this.docs.set(uri, ext);
    return ext;
  }

  private offsetOf(text: string, pos: { line: number; character: number }): number {
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    const line = Math.min(Math.max(pos.line, 0), starts.length - 1);
    return starts[line] + pos.character;
  }

  // ---------- 跨文件类解析 ----------

  async resolveClass(fqn: string): Promise<ClassSym | undefined> {
    // 索引键无前导 \（ns\Name），而 docblock 类型常写 \FQN —— 先归一再去查，否则全限定写法永远 miss
    const key = fqn.replace(/^\\+/, '').toLowerCase();
    const hit = this.index.byFqn.get(key);
    if (hit) return hit;
    await this.index.ensureScan();
    const uri = this.index.lookupFqnUri(key);
    if (!uri) return undefined;
    if (this.resolving.has(uri)) return undefined; // 重入保护
    this.resolving.add(uri);
    try {
      await this.getDoc(uri);
      return this.index.byFqn.get(key);
    } finally {
      this.resolving.delete(uri);
    }
  }

  /** didChangeWatchedFiles：批量失效扫描缓存 */
  invalidateScan(): void {
    this.index.invalidateAll();
  }

  /** rename 等全工作区扫描入口：内存镜像文档 + 磁盘扫描文件并集 */
  allKnownUris(): string[] {
    const out = new Set<string>(this.docs.keys());
    for (const u of this.index.allFiles) out.add(u);
    return [...out];
  }

  /** 不触发解析的缓存查看（rename 候选预筛用；镜像文档的内存文本以 cached.text 为准） */
  peekDoc(uri: string): ParsedDocExt | undefined {
    return this.docs.get(uri);
  }

  // ---------- features 门面 ----------

  async definition(params: DefinitionParamsLike): Promise<LocationLike[] | null> {
    return navigationDefinition(this, params);
  }

  async hover(params: DefinitionParamsLike): Promise<Record<string, unknown> | null> {
    return navigationHover(this, params);
  }

  async completion(params: DefinitionParamsLike): Promise<Record<string, unknown>[] | null> {
    return navigationCompletion(this, params);
  }

  async typeDefinition(params: DefinitionParamsLike): Promise<LocationLike[] | null> {
    return navigationTypeDefinition(this, params);
  }

  async implementation(params: DefinitionParamsLike): Promise<LocationLike[] | null> {
    return navigationImplementation(this, params);
  }

  async declaration(params: DefinitionParamsLike): Promise<LocationLike[] | null> {
    return navigationDeclaration(this, params);
  }

  prepareTypeHierarchy(params: DefinitionParamsLike): Promise<TypeHierarchyItem[] | null> {
    return prepareTypeHierarchy(this, params);
  }

  typeHierarchySupertypes(item: TypeHierarchyItem): Promise<TypeHierarchyItem[] | null> {
    return typeHierarchySupertypes(this, item);
  }

  typeHierarchySubtypes(item: TypeHierarchyItem): Promise<TypeHierarchyItem[] | null> {
    return typeHierarchySubtypes(this, item);
  }

  prepareRename(params: DefinitionParamsLike): Promise<PrepareRenameResult | null> {
    return prepareRename(this, params);
  }

  rename(params: RenameParamsLike): Promise<RenameWorkspaceEdit | null> {
    return rename(this, params);
  }

  async codeActions(params: CodeActionParamsLike): Promise<CodeActionLike[]> {
    return codeActions(this, params);
  }

  async codeActionResolve(action: CodeActionLike): Promise<CodeActionLike> {
    return codeActionResolve(this, action);
  }

  // ---------- T4: codeLens / inlayHint ----------

  async codeLenses(uri: string): Promise<CodeLensLike[]> {
    return computeCodeLenses(this, uri);
  }

  async codeLensResolve(lens: CodeLensLike): Promise<CodeLensLike> {
    return resolveCodeLens(this, lens);
  }

  async inlayHints(uri: string, range?: { start: { line: number; character: number }; end: { line: number; character: number } }): Promise<InlayHintLike[]> {
    return computeInlayHints(this, uri, range);
  }

  async inlayHintResolve(hint: InlayHintLike): Promise<InlayHintLike> {
    return resolveInlayHint(this, hint);
  }


  foldingRanges(uri: string): FoldingRange[] {
    const doc = this.docs.get(uri);
    return doc ? computeFoldingRanges(doc) : [];
  }

  selectionRanges(uri: string, positions: { line: number; character: number }[]): SelectionRange[] {
    const doc = this.docs.get(uri);
    return doc ? computeSelectionRanges(doc, positions) : [];
  }

  documentLinks(uri: string): DocumentLink[] {
    const doc = this.docs.get(uri);
    if (!doc) return [];
    return computeDocumentLinks(doc, this.rootPath);
  }
}
