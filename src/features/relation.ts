/**
 * features/relation.ts：definition 通道的 ThinkPHP ORM 关联跳转补强。
 * 在主通道 navigationDefinition（成员/类引用）未命中时兜底（engine.definition 接线），两个通道：
 *
 * P0 字符串实参 → 关联方法：
 *   光标落在 with/load/loadRelation/has 的字符串实参（含数组键 'a' => ...）上时，跳到
 *   「接收方类型的同名关联方法」定义处；'a.b' 复合名对第一段生效，第二段经第一段方法的
 *   返回类型（原生返回类型 / docblock @return）继续解析，推不出则只返回第一段（不误跳）。
 *   触发面收敛在最内层调用是上述关联名方法：where('a.b')/field()/order() 等普通字符串
 *   实参不卷入。接收方类型解析不出时退化为按方法名全局搜索（编辑器出选择列表），不许
 *   返回空还抛错。
 *
 * P1 方法名 __call 转发：
 *   光标在 ->method( 的方法名上且类型层级找不到该成员时，若层级（含自身/trait/父类）
 *   声明了 __call/__callStatic（think\Model 即此类；基类在 vendor 里时经 composer autoload
 *   映射补解析证明），在全局索引搜同名方法（think\db\Query::with）并返回全部 Location；
 *   层级完整却无 __call 或断裂无法证明时严格不兜底（防污染/防误跳）；接收方类型完全未知时
 *   放最后兜底同样全局搜索。全局搜不到诚实返回 null，不编造位置。
 *
 * AST 形状（php-parser 3.7 实测）：$obj->method() 是 call{what: propertylookup{what, offset:
 * identifier('method')}, arguments: [...] }，本版本不产生 methodlookup；字符串节点 value 为
 * 去引号内容、raw 含引号。helper 对 propertylookup/methodlookup 两种形状都兼容。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { type ParsedDoc, plainName } from '../engine/ast';
import {
  effectiveMembers,
  enclosingClass,
  findMember,
  memberTypes,
  resolveReceiverFqns,
  type MemberRef,
  type ParsedDocLike,
} from '../engine/member';
import { resolveTypeRaw } from '../engine/resolver';
import type { ClassSym } from '../engine/symbols';
import {
  containingNodes,
  escapeRegExp,
  inLoc,
  validPositionParams,
  type DefinitionParamsLike,
  type LocationLike,
  type NavigationEngine,
} from './navigation';

/** 接受关联名字符串实参的方法（ThinkPHP ORM 预载入/关联存在性） */
const RELATION_METHODS = new Set(['with', 'load', 'loadRelation', 'has']);

/** 合法关联名：a 或 a.b（段为标识符）。点号复合名用于嵌套关联。 */
const RELATION_PATH_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

/** relationDefinition：engine.definition 主通道未命中后的关联跳转兜底入口 */
export async function relationDefinition(engine: NavigationEngine, params: DefinitionParamsLike): Promise<LocationLike[] | null> {
  const p = validPositionParams(params);
  if (!p) return null;
  const doc = await engine.getDoc(p.uri);
  if (!doc) return null;

  // P0：关联名字符串实参 → 关联方法定义
  const relationLocs = await relationStringLocations(engine, doc, p.line, p.character);
  if (relationLocs && relationLocs.length > 0) return relationLocs;

  // P1：方法名 __call 转发（层级证明 __call 才转发；接收方类型完全未知时放最后全局兜底）
  const magicLocs = await magicCallLocations(engine, doc, p.line, p.character);
  return magicLocs && magicLocs.length > 0 ? magicLocs : null;
}

/** ---------- P0：字符串实参 → 关联方法 ---------- */

interface RelationCallHit {
  lookupNode: any;
  path: string;
}

/** 最内层包含光标的调用：必须是关联名方法且光标恰在其字符串实参上，否则不触发（返回 undefined） */
function relationCallAt(doc: ParsedDoc, line: number, character: number): RelationCallHit | undefined {
  // containingNodes 按节点跨度升序（最内层优先）：第一层 call 即最内层调用
  for (const node of containingNodes(doc, line, character)) {
    if (node.kind !== 'call') continue;
    const what = node.what;
    if (!what || (what.kind !== 'propertylookup' && what.kind !== 'methodlookup')) return undefined;
    const nameNode = what.offset && what.offset.kind === 'call' ? what.offset.what : what.offset;
    const methodName = plainName(nameNode);
    // 最内层调用不是关联名方法：where('a.b')/field() 等普通字符串实参就此打住，不向外层扩散
    if (!methodName || !RELATION_METHODS.has(methodName)) return undefined;
    const relationPath = stringArgPathAt(node, line, character);
    if (relationPath === undefined) return undefined; // 光标不在该调用的字符串实参上（可能在方法名上 → 走 P1）
    return { lookupNode: what, path: relationPath };
  }
  return undefined;
}

async function relationStringLocations(engine: NavigationEngine, doc: ParsedDoc, line: number, character: number): Promise<LocationLike[] | undefined> {
  const hit = relationCallAt(doc, line, character);
  if (!hit) return undefined;
  const segments = hit.path.split('.');

  const view: ParsedDocLike = { uri: doc.uri, ast: doc.ast, classNodes: (doc as any).classNodes ?? [] };
  const ownerClass = enclosingClass(view, line, character);
  // 接收方类型：$this->model 复用既有链路（属性 docblock @var + use 别名 + 赋值推断）
  const receiverFqns = await resolveReceiverFqns(hit.lookupNode.what, view, ownerClass, engine.ctx);

  const first = await methodLocationsInTypes(engine, receiverFqns, segments[0]);
  if (!first || first.locations.length === 0) {
    // 接收方类型解析不出/关联方法不存在：退化为按方法名全局搜索（编辑器出选择列表）
    return globalMethodLocations(engine, segments[0]);
  }
  if (segments.length === 1) return first.locations;

  // 'a.b'：第二段经第一段关联方法的返回类型（原生 / docblock @return）继续解析
  const nested = await continuationLocations(engine, first.methodRefs, segments.slice(1));
  return nested && nested.length > 0 ? nested : first.locations; // 第二段推不出：至少第一段生效，不误跳
}

/** 在类型集合的成员表（含 trait/父类链）里找方法成员，返回定义位置与引用（供嵌套段继续解析） */
async function methodLocationsInTypes(
  engine: NavigationEngine,
  fqns: string[],
  methodName: string,
): Promise<{ locations: LocationLike[]; methodRefs: MemberRef[] } | undefined> {
  const locations: LocationLike[] = [];
  const methodRefs: MemberRef[] = [];
  const seen = new Set<string>();
  for (const fqn of fqns) {
    const cls = await engine.resolveClass(fqn);
    if (!cls) continue;
    const ref = await findMember(cls, methodName, engine.ctx);
    if (!ref || ref.kind !== 'method' || !ref.method) continue; // 关联名必须是方法；同名属性/常量不按关联跳
    const m = ref.method;
    const key = `${m.uri}#${m.selectionRange.start.line}:${m.selectionRange.start.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    methodRefs.push(ref);
    locations.push({ uri: m.uri, range: m.selectionRange });
  }
  return { locations, methodRefs };
}

/** 'a.b' 的后续段：沿上一段方法引用的返回类型逐段下钻；任一段推不出即止（返回到上一段为止的结果） */
async function continuationLocations(engine: NavigationEngine, frontier: MemberRef[], rest: string[]): Promise<LocationLike[] | undefined> {
  let refs = frontier;
  let last: LocationLike[] | undefined;
  for (const segment of rest) {
    const step = await methodLocationsInTypesFromRefs(engine, refs, segment);
    if (step.locations.length === 0) return last;
    last = step.locations;
    refs = step.methodRefs;
  }
  return last;
}

async function methodLocationsInTypesFromRefs(
  engine: NavigationEngine,
  refs: MemberRef[],
  methodName: string,
): Promise<{ locations: LocationLike[]; methodRefs: MemberRef[] }> {
  const locations: LocationLike[] = [];
  const methodRefs: MemberRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const types = await memberTypes(ref, engine.ctx);
    const next = await methodLocationsInTypes(engine, types.fqns, methodName);
    if (!next) continue;
    for (let i = 0; i < next.locations.length; i++) {
      const loc = next.locations[i];
      const key = `${loc.uri}#${loc.range.start.line}:${loc.range.start.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      methodRefs.push(next.methodRefs[i]);
      locations.push(loc);
    }
  }
  return { locations, methodRefs };
}

/** 收集调用实参子树里的全部字符串字面量节点（跳过闭包体：闭包内字符串不属于本调用实参） */
function stringArgsOfCall(callNode: any): any[] {
  const out: any[] = [];
  const raw = callNode.arguments;
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.arguments) ? raw.arguments : [];
  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node.kind === 'string') {
      if (node.kind === 'closure' || node.kind === 'arrowfn' || node.kind === 'arrowfunction' || node.kind === 'fn') return;
      if (node.kind === 'string') out.push(node);
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const value = (node as Record<string, unknown>)[key];
      if (value && typeof value === 'object') visit(value);
    }
  };
  visit(list);
  return out;
}

/** 光标所在的实参字符串 → 合法关联名（非字符串实参/非法形态返回 undefined，不触发） */
function stringArgPathAt(callNode: any, line: number, character: number): string | undefined {
  for (const stringNode of stringArgsOfCall(callNode)) {
    if (!stringNode.loc || !inLoc(line, character, stringNode.loc)) continue;
    const value = typeof stringNode.value === 'string' ? stringNode.value : '';
    // 部分 php-parser 形态 value 带引号（与 raw 一致），剥一层再校验；插值/拼接等非法形态被正则拒绝
    const stripped =
      value.length >= 2 && ((value[0] === "'" && value.endsWith("'")) || (value[0] === '"' && value.endsWith('"')))
        ? value.slice(1, -1)
        : value;
    return RELATION_PATH_RE.test(stripped) ? stripped : undefined;
  }
  return undefined;
}

/** ---------- P1：方法名 __call 转发 ---------- */

/** 光标所在的「被调用方法名」：lookup 节点 offset 含光标，且该节点是某个 call 的 what（属性式访问不走 __call） */
function invokedMethodNameAt(doc: ParsedDoc, line: number, character: number): { lookupNode: any; name: string } | undefined {
  const candidates = containingNodes(doc, line, character);
  for (const node of candidates) {
    if (node.kind !== 'propertylookup' && node.kind !== 'methodlookup') continue;
    const offset = node.offset;
    const nameNode = offset && offset.kind === 'call' ? offset.what : offset;
    if (!nameNode || !nameNode.loc || !inLoc(line, character, nameNode.loc)) continue;
    const name = plainName(nameNode);
    if (!name || name === 'name') continue;
    if (!candidates.some((c) => c.kind === 'call' && c.what === node)) return undefined; // $obj->prop 属性访问不触发
    return { lookupNode: node, name };
  }
  return undefined;
}

/** vendor FQN 补解析缓存：根目录|fqn → 符号（含 undefined 负缓存）。vendor 在会话内静态，中间件重启才失效 */
const vendorClassCache = new Map<string, ClassSym | undefined>();

/** __call 门槛判定：'magic' 层级证明有 __call/__callStatic；'clean' 层级完整且证明没有；'broken' 层级断裂无法证明（严格不兜底） */
type MagicCallGate = 'magic' | 'clean' | 'broken';

async function magicCallGate(cls: ClassSym, engine: NavigationEngine): Promise<MagicCallGate> {
  const ctx = engine.ctx;
  const visit = async (c: ClassSym, visited: Set<string>, depth: number): Promise<MagicCallGate> => {
    const key = c.fqn.toLowerCase();
    if (visited.has(key) || depth > 8) return 'clean';
    visited.add(key);
    const members = await effectiveMembers(c, ctx);
    if (members.has('__call') || members.has('__callStatic')) return 'magic';
    const file = ctx.index.files.get(c.uri);
    let broken = false;
    // 父类/trait 解析顺序：工作区索引 → composer autoload 映射补解析（工作区扫描显式跳过 vendor，
    // 而 think\Model 等基类恰在 vendor 包里；补解析成功即可继续向上证明/证伪 __call）
    for (const traitUse of c.traitUses) {
      const traitFqn = resolveTypeRaw(traitUse.raw, file, c.fqn)[0];
      if (!traitFqn) {
        broken = true;
        continue;
      }
      const traitSym = (await ctx.resolveClass(traitFqn)) ?? (await resolveFqnInVendor(engine, traitFqn));
      if (!traitSym) return 'broken'; // trait 缺失：无法证明有没有 __call
      const traitGate = await visit(traitSym, visited, depth + 1);
      if (traitGate === 'magic') return 'magic';
    }
    for (const parentRaw of c.extendsRaw) {
      const parentFqn = resolveTypeRaw(parentRaw, file, c.fqn)[0];
      if (!parentFqn) {
        broken = true;
        continue;
      }
      const parent = (await ctx.resolveClass(parentFqn)) ?? (await resolveFqnInVendor(engine, parentFqn));
      if (!parent) return 'broken'; // 基类缺失（如 worktree 无 topthink/framework）：无法证明，严格不兜底
      const parentGate = await visit(parent, visited, depth + 1);
      if (parentGate === 'magic') return 'magic';
    }
    return broken ? 'broken' : 'clean';
  };
  return visit(cls, new Set<string>(), 0);
}

async function magicCallLocations(engine: NavigationEngine, doc: ParsedDoc, line: number, character: number): Promise<LocationLike[] | undefined> {
  const found = invokedMethodNameAt(doc, line, character);
  if (!found) return undefined;

  const view: ParsedDocLike = { uri: doc.uri, ast: doc.ast, classNodes: (doc as any).classNodes ?? [] };
  const ownerClass = enclosingClass(view, line, character);
  const receiverFqns = await resolveReceiverFqns(found.lookupNode.what, view, ownerClass, engine.ctx);

  const resolved: ClassSym[] = [];
  for (const fqn of receiverFqns) {
    const cls = await engine.resolveClass(fqn);
    if (!cls) continue;
    resolved.push(cls);
    // 防御：成员实际命中时应由主通道处理，这里不兜底（正常不会走到）
    if (await findMember(cls, found.name, engine.ctx)) return undefined;
  }

  if (resolved.length > 0) {
    let anyMagic = false;
    for (const cls of resolved) {
      if ((await magicCallGate(cls, engine)) === 'magic') {
        anyMagic = true;
        break;
      }
    }
    // 层级完整且无 __call（clean，普通项目防污染）或层级断裂无法证明（broken，如 worktree 无
    // topthink/framework）：都严格不兜底——接收方可解析时全局搜索同名方法会命中无关类（如
    // vendor 里包工具类的同名方法），反而造成误跳。只有证明 __call 才放行转发搜索。
    if (!anyMagic) return undefined;
  }
  // resolved.length === 0：接收方类型完全未知 → 放最后的全局同名搜索兜底
  const locations = await globalMethodLocations(engine, found.name);
  return locations.length > 0 ? locations : undefined; // 搜不到诚实返回空（上层落 null），不编造位置
}

/** ---------- vendor 内 FQN 补解析（composer autoload 映射） ---------- */

/**
 * composer vendor 内 FQN → 类符号：读 vendor/composer/autoload_psr4.php / autoload_classmap.php
 * 的映射（psr-4 最长前缀 / classmap 直查），定位类文件后经 engine.getDoc 解析出符号。
 * 解析不到（worktree 无 topthink/framework）诚实返回 undefined；映射缺失/读不了按无映射处理。
 */
async function resolveFqnInVendor(engine: NavigationEngine, fqn: string): Promise<ClassSym | undefined> {
  const root = engine.index.root;
  if (!root) return undefined;
  const cacheKey = `${root}|${fqn}`;
  if (vendorClassCache.has(cacheKey)) return vendorClassCache.get(cacheKey);
  const sym = await resolveFqnInVendorUncached(engine, fqn);
  vendorClassCache.set(cacheKey, sym);
  return sym;
}

async function resolveFqnInVendorUncached(engine: NavigationEngine, fqn: string): Promise<ClassSym | undefined> {
  const root = engine.index.root;
  if (!root) return undefined;
  const vendorDir = path.resolve(root, 'vendor');
  const maps = readComposerAutoloadMaps(vendorDir);
  const norm = fqn.replace(/^\\+/, '');

  // classmap 直查
  const classmapFile = maps.classmap.get(norm.toLowerCase());
  if (classmapFile) {
    const cls = await classSymbolFromFile(engine, classmapFile, norm);
    if (cls) return cls;
  }
  // psr-4 最长前缀匹配
  const fqnLower = norm.toLowerCase();
  let best: { prefixLen: number; dir: string } | undefined;
  for (const entry of maps.psr4) {
    if (fqnLower === entry.keyNoSep || fqnLower.startsWith(entry.key)) {
      if (!best || entry.key.length > best.prefixLen) best = { prefixLen: entry.key.length, dir: entry.path };
    }
  }
  if (!best) return undefined;
  const remainder = norm.slice(best.prefixLen).replace(/\\/g, '/');
  const candidate = path.join(best.dir, remainder) + '.php';
  return classSymbolFromFile(engine, candidate, norm);
}

async function classSymbolFromFile(engine: NavigationEngine, file: string, fqn: string): Promise<ClassSym | undefined> {
  try {
    if (!fs.existsSync(file)) return undefined; // psr-4 前缀命中但文件不存在（如 think\ 被包注册而 Model.php 不在其中）
  } catch {
    return undefined;
  }
  const doc = await engine.getDoc(pathToFileURL(file).href);
  if (!doc) return undefined;
  const classNodes: { sym: ClassSym }[] = (doc as any).classNodes ?? [];
  const hit = classNodes.find((e) => e.sym.fqn.toLowerCase() === fqn.toLowerCase());
  return hit ? hit.sym : undefined;
}

interface ComposerAutoloadMaps {
  /** psr-4：key 为归一化小写前缀（带尾部 \），keyNoSep 为去尾分隔符版本，path 为映射目录 */
  psr4: { key: string; keyNoSep: string; path: string }[];
  /** classmap：fqn 小写 → 文件绝对路径 */
  classmap: Map<string, string>;
}

/** 解析 vendor/composer/autoload_psr4.php 与 autoload_classmap.php（逐行正则，缺失/读不了按无映射处理） */
function readComposerAutoloadMaps(vendorDir: string): ComposerAutoloadMaps {
  const out: ComposerAutoloadMaps = { psr4: [], classmap: new Map() };
  const baseDir = path.dirname(vendorDir);
  const sources: { file: string; kind: 'psr4' | 'classmap' }[] = [
    { file: path.join(vendorDir, 'composer', 'autoload_psr4.php'), kind: 'psr4' },
    { file: path.join(vendorDir, 'composer', 'autoload_classmap.php'), kind: 'classmap' },
  ];
  // PHP 单引号字符串里反斜杠写作 \\（原始文本两个字符），映射时还原为单个
  const unescape = (s: string): string => s.replace(/\\\\/g, '\\');
  const baseOf = (varName: string): string => (varName === 'vendorDir' ? vendorDir : baseDir);
  for (const { file, kind } of sources) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // 无该映射文件：composer 未安装/极简安装，按无映射处理
    }
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      // psr-4 行：'Ns\\Sub\\' => array($vendorDir . '/pkg/path'),
      const psr4 = /^'((?:[^']|\\)*)\\\\'\s*=>\s*array\(\s*\$(vendorDir|baseDir)\s*\.\s*'([^']+)'/m.exec(line);
      if (kind === 'psr4' && psr4) {
        const key = unescape(psr4[1]).toLowerCase();
        out.psr4.push({
          key: key.endsWith('\\') ? key : key + '\\',
          keyNoSep: key.endsWith('\\') ? key.slice(0, -1) : key,
          path: path.join(baseOf(psr4[2]), psr4[3]),
        });
        continue;
      }
      // classmap 行：'Ns\\Sub\\Class' => $baseDir . '/pkg/path/Class.php',
      const cm = /^'((?:[^']|\\)*)'\s*=>\s*\$(vendorDir|baseDir)\s*\.\s*'([^']+)'/m.exec(line);
      if (kind === 'classmap' && cm) {
        out.classmap.set(unescape(cm[1]).toLowerCase(), path.join(baseOf(cm[2]), cm[3]));
      }
    }
  }
  return out;
}

/** ---------- 全局同名方法搜索 ---------- */

const MAX_GLOBAL_FILES = 8000;
const MAX_GLOBAL_FILE_BYTES = 1_500_000;
const MAX_VENDOR_PARSE_CANDIDATES = 200;
const VENDOR_SKIP_DIRS = new Set(['composer', 'bin', 'tests', '.git']);

/**
 * 全局搜同名方法的定义位置（可能多个，编辑器出选择列表）：
 * ① 已解析文档（内存缓存，零 IO）+ 全工作区扫描集（allKnownUris，不含 vendor）文本预筛后按需解析；
 * ② vendor 定向扫描——工作区扫描显式跳过 vendor，而 __call 转发目标（think\db\Query::with）
 *    恰在框架包里，故按 `function <name>(` 快速预筛后解析候选文件。
 */
async function globalMethodLocations(engine: NavigationEngine, methodName: string): Promise<LocationLike[]> {
  const locations: LocationLike[] = [];
  const seen = new Set<string>();
  const push = (loc: LocationLike): void => {
    const key = `${loc.uri}#${loc.range.start.line}:${loc.range.start.character}`;
    if (seen.has(key)) return;
    seen.add(key);
    locations.push(loc);
  };
  const collectFromDoc = (docu: ParsedDoc): void => {
    const classNodes: { sym: ClassSym }[] = (docu as any).classNodes ?? [];
    for (const { sym } of classNodes) {
      const m = sym.methods.find((mm) => mm.name === methodName);
      if (m) push({ uri: m.uri, range: m.selectionRange });
    }
  };

  const declRe = new RegExp(`\\bfunction\\s+${escapeRegExp(methodName)}\\s*\\(`);
  for (const uri of engine.allKnownUris()) {
    const cached = engine.peekDoc(uri);
    if (cached) {
      collectFromDoc(cached);
      continue;
    }
    // 未解析的工作区文件：先文本预筛（function name(）再按需解析，避免全仓 AST 解析
    let filePath: string;
    try {
      filePath = fileURLToPath(uri);
    } catch {
      continue; // 非 file:// 文档（如 untitled:）无磁盘路径，跳过
    }
    if (!quickPrefilterMatch(filePath, declRe)) continue;
    const docu = await engine.getDoc(uri);
    if (docu) collectFromDoc(docu);
  }

  for (const loc of await vendorMethodLocations(engine, declRe, methodName)) push(loc);
  return locations;
}

/** 单文件快速预筛：读文本（限大小）匹配方法声明正则；读不了的文件按扫描惯例跳过 */
function quickPrefilterMatch(filePath: string, declRe: RegExp): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_GLOBAL_FILE_BYTES) return false;
    return declRe.test(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false; // 扫描集与磁盘瞬时不一致（文件被删/无权限）：按不存在处理
  }
}

/** vendor 目录定向扫描：正则预筛 → engine.getDoc 解析候选 → 类方法归属精确命中 */
async function vendorMethodLocations(engine: NavigationEngine, declRe: RegExp, methodName: string): Promise<LocationLike[]> {
  const root = engine.index.root;
  if (!root) return [];
  const vendorDir = path.resolve(root, 'vendor');
  let topEntries: fs.Dirent[];
  try {
    topEntries = fs.readdirSync(vendorDir, { withFileTypes: true });
  } catch {
    return []; // 无 vendor 目录：本项目没有框架包可搜，诚实返回空
  }
  const candidates: string[] = [];
  const visit = (dirAbs: string, depth: number): void => {
    if (depth > 8 || candidates.length >= MAX_GLOBAL_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of entries) {
      if (candidates.length >= MAX_GLOBAL_FILES) return;
      const full = path.join(dirAbs, dirent.name);
      if (dirent.isDirectory()) {
        if (VENDOR_SKIP_DIRS.has(dirent.name)) continue;
        visit(full, depth + 1);
      } else if (dirent.isFile() && dirent.name.endsWith('.php')) {
        if (quickPrefilterMatch(full, declRe)) candidates.push(full);
      }
    }
  };
  for (const dirent of topEntries) {
    if (dirent.isDirectory()) visit(path.join(vendorDir, dirent.name), 1);
  }

  const locations: LocationLike[] = [];
  for (const file of candidates.slice(0, MAX_VENDOR_PARSE_CANDIDATES)) {
    const docu = await engine.getDoc(pathToFileURL(file).href);
    if (!docu) continue;
    const classNodes: { sym: ClassSym }[] = (docu as any).classNodes ?? [];
    for (const { sym } of classNodes) {
      const m = sym.methods.find((mm) => mm.name === methodName);
      if (m) locations.push({ uri: m.uri, range: m.selectionRange });
    }
  }
  return locations;
}

