#!/usr/bin/env node
/**
 * scripts/probe.ts — T2 验收探针（协议级最小 stdio LSP 客户端，非浏览器 e2e）。
 *
 * 对中间件 `node dist/cli.js --stdio`（内含官方 intelephense 子进程）：
 *   1. initialize（root=zuodian）→ 验证 serverCapabilities 合并 + serverInfo
 *   2. open Product.php → definition/hover on $this->auth（auth 案例 A 通道）
 *   3. completion：$this-> 含 auth（继承成员）；auth-> 含 check()（Auth 成员）
 *   4. foldingRange / selectionRange（三基础功能之二）
 *   5. documentLink（合成 include 文档，__DIR__ 解析）
 *   6. C 通道（赋值推断兜底）：合成 ProbeService/ProbeBase/ProbeChild 文档 hover $this->svc → ProbeService
 *   7. typeHierarchy 三方法（真实文件）：prepare(Product)/supertypes→Backend、prepare($this->auth)→Auth、
 *      prepare(Driver)/subtypes→Mysql+Redis、supertypes(Driver)→空（抽象根诚实降级）
 *   8. rename（addons 临时 fixture，探针结束清理；客户端内存 apply 不落盘）：类改名 WorkspaceEdit 断言
 *      （renameFile + use 行/docblock/new/instanceof/静态引用更新 + 字符串 FQN + 双命名空间 decoy 零误改）
 *   9. codeAction 三类各一例（内存合成）：自动 import（唯一候选+字母序插入）、批量实现抽象方法（带类型 stub）、
 *      生成 PHPDoc（@param/@return 联合/@throws）
 *
 * 输出逐项 PASS/FAIL 与证据；全过 exit 0，否则 exit 1。
 *
 * 运行：npm run build && npm run probe
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ZUODIAN_ROOT = process.env.PROBE_ROOT ?? '/code/www/gs/zuodian-worktree/zuodian--temp';
const PRODUCT_ABS = path.join(ZUODIAN_ROOT, 'application', 'admin', 'controller', 'product', 'Product.php');
const PRODUCT_URI = 'file://' + PRODUCT_ABS;

// ---------- 最小 stdio LSP 客户端 ----------

class ProbeClient {
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 100;
  readonly child: ChildProcess;
  serverMessages: any[] = [];

  constructor() {
    this.child = spawn(process.execPath, [path.join(__dirname, 'cli.js'), '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout!.on('data', (chunk: Buffer) => this.push(chunk));
    this.child.stderr!.on('data', (d: Buffer) => process.stderr.write('[server-stderr] ' + d.toString()));
  }

  private push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const sep = this.buffer.indexOf('\r\n\r\n');
      if (sep < 0) break;
      const header = this.buffer.slice(0, sep).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) break;
      const len = parseInt(m[1], 10);
      const total = sep + 4 + len;
      if (this.buffer.length < total) break;
      const body = this.buffer.slice(sep + 4, total).toString('utf8');
      this.buffer = this.buffer.slice(total);
      try {
        const msg = JSON.parse(body);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          p.resolve(msg);
        } else {
          this.serverMessages.push(msg);
        }
      } catch {
        // ignore malformed
      }
    }
  }

  send(method: string, params: unknown): { id: number; done: Promise<any> } {
    const id = this.nextId++;
    const done = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting response for ${method} (id=${id})`));
        }
      }, 45000);
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return { id, done };
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.child.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  async stop(): Promise<void> {
    try {
      const { done } = this.send('shutdown', null);
      await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
      this.notify('exit', null);
    } catch {
      // force
    }
    this.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ---------- 断言与证据 ----------

const results: { name: string; pass: boolean; evidence: string }[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  results.push({ name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`      证据: ${evidence}`);
}

function offsetOf(text: string, line: number, character: number): number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  const l = Math.min(line, starts.length - 1);
  return starts[l] + character;
}

function locate(text: string, needle: string, fromOffset = 0): { line: number; character: number } {
  const idx = text.indexOf(needle, fromOffset);
  if (idx < 0) throw new Error(`probe bug: needle ${JSON.stringify(needle)} not found`);
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  let line = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= idx) line = i;
  return { line, character: idx - starts[line] };
}

function summarize(v: unknown, max = 400): string {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
  if (!fs.existsSync(PRODUCT_ABS)) {
    console.error(`FATAL 目标项目不存在: ${PRODUCT_ABS}`);
    process.exit(2);
  }
  const productText = fs.readFileSync(PRODUCT_ABS, 'utf8');
  const client = new ProbeClient();

  try {
    // 1) initialize
    const initParams = {
      processId: process.pid,
      rootUri: 'file://' + ZUODIAN_ROOT,
      rootPath: ZUODIAN_ROOT,
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: false } },
          synchronization: { didSave: true },
        },
      },
    };
    const initResp = await client.send('initialize', initParams).done;
    const caps = initResp.result?.capabilities ?? {};
    const serverInfo = initResp.result?.serverInfo;
    const capsMerged =
      serverInfo?.name === 'intelephense-openidea' &&
      !!caps.foldingRangeProvider &&
      !!caps.selectionRangeProvider &&
      !!caps.documentLinkProvider &&
      !!caps.completionProvider &&
      !!caps.definitionProvider;
    record(
      'initialize 能力合并 + serverInfo',
      capsMerged,
      `serverInfo=${summarize(serverInfo)} foldingRangeProvider=${summarize(caps.foldingRangeProvider)} selectionRangeProvider=${summarize(caps.selectionRangeProvider)} documentLinkProvider=${summarize(caps.documentLinkProvider)} completionProvider=${!!caps.completionProvider} definitionProvider=${!!caps.definitionProvider}`,
    );
    client.notify('initialized', {});

    // 2) didOpen Product.php
    client.notify('textDocument/didOpen', {
      textDocument: { uri: PRODUCT_URI, languageId: 'php', version: 1, text: productText },
    });

    const productClassPos = locate(productText, 'class Product');
    const authPos = locate(productText, '$this->auth->check');
    const authChar = { line: authPos.line, character: authPos.character + '$this->'.length };
    const expectedLine55 = authPos.line; // 0 基；与 1 基 54 行一致
    console.log(`      [定位] $this->auth 首处 @ 0-based line=${authChar.line} char=${authChar.character}（1-based ${authPos.line + 1}）`);

    // definition on auth
    const defResp = await client.send('textDocument/definition', { textDocument: { uri: PRODUCT_URI }, position: authChar }).done;
    const defs = Array.isArray(defResp.result) ? defResp.result : defResp.result ? [defResp.result] : [];
    const defHit = defs.find((d: any) => typeof d?.uri === 'string' && d.uri.endsWith('Backend.php'));
    record(
      'definition($this->auth) → Backend.php 属性声明',
      !!defHit,
      defHit
        ? `${defHit.uri.split('/').slice(-1)[0]} @ 0-based line=${defHit.range.start.line}（1-based ${defHit.range.start.line + 1}） 官方结果数=${defs.length}`
        : `无结果：${summarize(defResp)}`,
    );

    // hover on auth
    const hoverResp = await client.send('textDocument/hover', { textDocument: { uri: PRODUCT_URI }, position: authChar }).done;
    const hoverVal = hoverResp.result?.contents?.value ?? '';
    const hoverPass = hoverVal.includes('Auth') && hoverVal.includes('$auth');
    record(
      'hover($this->auth) → Auth 类型 + 属性 docblock',
      hoverPass,
      hoverPass ? `markdown 含 "Auth" 与 "$auth"；摘录: ${hoverVal.split('\n').filter((s: string) => s.includes('Auth')).slice(0, 3).join(' / ')}` : `contents=${summarize(hoverResp.result?.contents)}`,
    );

    // typeDefinition on auth → Auth 类声明（app/admin/library/Auth.php）
    const authClsAbs = path.join(ZUODIAN_ROOT, 'application', 'admin', 'library', 'Auth.php');
    const authClsText = fs.readFileSync(authClsAbs, 'utf8');
    const authClsUri = 'file://' + authClsAbs;
    const authDeclPos = locate(authClsText, 'class Auth');
    const typeDefResp = await client.send('textDocument/typeDefinition', { textDocument: { uri: PRODUCT_URI }, position: authChar }).done;
    const typeDefs: any[] = Array.isArray(typeDefResp.result) ? typeDefResp.result : typeDefResp.result ? [typeDefResp.result] : [];
    const typeDefHit = typeDefs.find((d) => typeof d?.uri === 'string' && d.uri.endsWith('admin/library/Auth.php') && d.range?.start?.line === authDeclPos.line);
    record(
      'typeDefinition($this->auth) → Auth 类声明（A 通道类型）',
      !!typeDefHit,
      typeDefHit
        ? `${typeDefHit.uri.split('/').slice(-1)[0]} @ 0-based line=${typeDefHit.range.start.line}（1-based ${typeDefHit.range.start.line + 1}）结果数=${typeDefs.length}`
        : `无命中：${summarize(typeDefResp.result)}（期望 ${authClsUri.split('/').pop()} line=${authDeclPos.line}）`,
    );

    // implementation：Driver 抽象类（token 存储驱动）→ Mysql/Redis 子类；抽象方法 set → 两处实现
    const driverAbs = path.join(ZUODIAN_ROOT, 'application', 'common', 'library', 'token', 'Driver.php');
    const driverUri = 'file://' + driverAbs;
    const driverText = fs.readFileSync(driverAbs, 'utf8');
    client.notify('textDocument/didOpen', {
      textDocument: { uri: driverUri, languageId: 'php', version: 1, text: driverText },
    });
    const driverClassPos = locate(driverText, 'abstract class Driver');
    const implClassResp = await client.send('textDocument/implementation', {
      textDocument: { uri: driverUri },
      position: { line: driverClassPos.line, character: driverClassPos.character + 'abstract class '.length + 2 },
    }).done;
    const implClasses: any[] = Array.isArray(implClassResp.result) ? implClassResp.result : implClassResp.result ? [implClassResp.result] : [];
    const mysqlHit = implClasses.find((d) => typeof d?.uri === 'string' && d.uri.endsWith('token/driver/Mysql.php'));
    const redisHit = implClasses.find((d) => typeof d?.uri === 'string' && d.uri.endsWith('token/driver/Redis.php'));
    record(
      'implementation(Driver 抽象类) → Mysql + Redis 子类（跨文件）',
      !!mysqlHit && !!redisHit,
      !!mysqlHit && !!redisHit
        ? `结果数=${implClasses.length}：Mysql.php @ 0-based line=${mysqlHit.range.start.line}；Redis.php @ 0-based line=${redisHit.range.start.line}`
        : `结果=${summarize(implClasses)}`,
    );

    const mysqlText = fs.readFileSync(path.join(ZUODIAN_ROOT, 'application', 'common', 'library', 'token', 'driver', 'Mysql.php'), 'utf8');
    const redisText = fs.readFileSync(path.join(ZUODIAN_ROOT, 'application', 'common', 'library', 'token', 'driver', 'Redis.php'), 'utf8');
    const mysqlSetLine = locate(mysqlText, 'public function set').line;
    const redisSetLine = locate(redisText, 'public function set').line;
    const driverSetPos = locate(driverText, 'abstract function set');
    const implMethodResp = await client.send('textDocument/implementation', {
      textDocument: { uri: driverUri },
      position: { line: driverSetPos.line, character: driverSetPos.character + 'abstract function '.length + 1 },
    }).done;
    const implMethods: any[] = Array.isArray(implMethodResp.result) ? implMethodResp.result : implMethodResp.result ? [implMethodResp.result] : [];
    const mSet = implMethods.find((d) => typeof d?.uri === 'string' && d.uri.endsWith('driver/Mysql.php') && d.range?.start?.line === mysqlSetLine);
    const rSet = implMethods.find((d) => typeof d?.uri === 'string' && d.uri.endsWith('driver/Redis.php') && d.range?.start?.line === redisSetLine);
    record(
      'implementation(Driver::set 抽象方法) → Mysql::set + Redis::set 方法声明',
      !!mSet && !!rSet,
      !!mSet && !!rSet
        ? `结果数=${implMethods.length}：Mysql.php line=${mSet.range.start.line}（0基）；Redis.php line=${rSet.range.start.line}（0基）`
        : `结果=${summarize(implMethods)}（期望 Mysql line=${mysqlSetLine}、Redis line=${redisSetLine}，0基）`,
    );

    // declaration：Mysql::set 实现处 → Driver 抽象声明；抽象声明处 → 实现列表（双向）；虚拟属性 → docblock @property 标签
    const driverSetLine = driverSetPos.line;
    const declImplResp = await client.send('textDocument/declaration', {
      textDocument: { uri: 'file://' + path.join(ZUODIAN_ROOT, 'application', 'common', 'library', 'token', 'driver', 'Mysql.php') },
      position: { line: mysqlSetLine, character: locate(mysqlText, 'public function set').character + 'public function '.length + 2 },
    }).done;
    const declImpls: any[] = Array.isArray(declImplResp.result) ? declImplResp.result : declImplResp.result ? [declImplResp.result] : [];
    const declHit = declImpls.find((d) => typeof d?.uri === 'string' && d.uri.endsWith('token/Driver.php') && d.range?.start?.line === driverSetLine);
    record(
      'declaration(Mysql::set 实现) → Driver.php 抽象方法声明',
      !!declHit,
      !!declHit
        ? `Driver.php @ 0-based line=${declHit.range.start.line}（1-based ${declHit.range.start.line + 1}）`
        : `结果=${summarize(declImpls)}（期望 Driver.php line=${driverSetLine}，0基）`,
    );

    const declBidiResp = await client.send('textDocument/declaration', {
      textDocument: { uri: driverUri },
      position: { line: driverSetLine, character: driverSetPos.character + 'abstract function '.length + 2 },
    }).done;
    const declBidis: any[] = Array.isArray(declBidiResp.result) ? declBidiResp.result : declBidiResp.result ? [declBidiResp.result] : [];
    const bidiOk = !!declBidis.find((d) => d?.uri?.endsWith('driver/Mysql.php') && d.range?.start?.line === mysqlSetLine) && !!declBidis.find((d) => d?.uri?.endsWith('driver/Redis.php') && d.range?.start?.line === redisSetLine);
    record(
      'declaration(Driver::set 抽象声明) → 实现列表（双向）',
      bidiOk,
      bidiOk ? `结果数=${declBidis.length}，含 Mysql::set 与 Redis::set 声明位置` : `结果=${summarize(declBidis)}`,
    );

    const declDocUri = 'file://' + path.join(ZUODIAN_ROOT, 'probe-decl-test.php');
    const declDocText = `<?php
namespace app\\common\\library;

/**
 * 探针基类（docblock @property 声明通道）
 * @property ProbeMagicService $magic 魔法服务
 */
class ProbeDeclBase
{
    public function useMagic()
    {
        return $this->magic->ping();
    }
}
`;
    client.notify('textDocument/didOpen', {
      textDocument: { uri: declDocUri, languageId: 'php', version: 1, text: declDocText },
    });
    const magicPos = locate(declDocText, '$this->magic->ping()');
    const magicChar = { line: magicPos.line, character: magicPos.character + '$this->'.length };
    const declDocResp = await client.send('textDocument/declaration', { textDocument: { uri: declDocUri }, position: magicChar }).done;
    const declDocs: any[] = Array.isArray(declDocResp.result) ? declDocResp.result : declDocResp.result ? [declDocResp.result] : [];
    const propTagLine = locate(declDocText, '@property ProbeMagicService $magic').line;
    const docHit = declDocs.find((d) => d?.uri === declDocUri && d.range?.start?.line === propTagLine);
    let docHitTextOk = false;
    if (docHit) {
      const li: number[] = [0];
      for (let i = 0; i < declDocText.length; i++) if (declDocText.charCodeAt(i) === 10) li.push(i + 1);
      const s = li[docHit.range.start.line] + docHit.range.start.character;
      const e = li[docHit.range.end.line] + docHit.range.end.character;
      docHitTextOk = declDocText.slice(s, e) === '$magic';
    }
    record(
      'declaration(虚拟属性 $this->magic) → docblock @property 标签 range',
      !!docHit && docHitTextOk,
      docHit && docHitTextOk
        ? `range @ 0-based line=${docHit.range.start.line} char=${docHit.range.start.character}..${docHit.range.end.character}，命中文本 "$magic"`
        : `结果=${summarize(declDocs)}（期望 @property 行=${propTagLine}，0基）`,
    );

    // 3) completion: $this-> 包含 auth（继承自 Backend）
    const thisArrow = locate(productText, '$this->model = new ProductModel();');
    const completionPos = { line: thisArrow.line, character: thisArrow.character + '$this->'.length };
    const compResp = await client.send('textDocument/completion', { textDocument: { uri: PRODUCT_URI }, position: completionPos }).done;
    const compItems: any[] = Array.isArray(compResp.result) ? compResp.result : compResp.result?.items ?? [];
    const hasAuth = compItems.some((it) => it?.label === 'auth');
    record(
      'completion($this->) 包含 auth（继承成员）',
      hasAuth,
      hasAuth
        ? `auth 项: ${summarize(compItems.find((it) => it?.label === 'auth'))}；总项数=${compItems.length}`
        : `总项数=${compItems.length}，labels 前 20=${summarize(compItems.slice(0, 20).map((i) => i?.label))}`,
    );

    // completion: auth-> 包含 check（Auth::check 签名）
    const checkPos = locate(productText, '$this->auth->check');
    const authArrowPos = { line: checkPos.line, character: checkPos.character + '$this->auth->'.length };
    const compResp2 = await client.send('textDocument/completion', { textDocument: { uri: PRODUCT_URI }, position: authArrowPos }).done;
    const compItems2: any[] = Array.isArray(compResp2.result) ? compResp2.result : compResp2.result?.items ?? [];
    const checkItem = compItems2.find((it) => it?.label === 'check');
    const sigOk = !!checkItem && typeof checkItem?.detail === 'string' && checkItem.detail.includes('$name');
    record(
      'completion(auth->) 包含 check（带签名）',
      sigOk,
      sigOk ? `check 项: ${summarize(checkItem)}；总项数=${compItems2.length}` : `总项数=${compItems2.length}，labels=${summarize(compItems2.slice(0, 30).map((i) => i?.label))}`,
    );

    // 4) foldingRange
    const foldResp = await client.send('textDocument/foldingRange', { textDocument: { uri: PRODUCT_URI } }).done;
    const folds: any[] = Array.isArray(foldResp.result) ? foldResp.result : [];
    const foldPass = folds.length > 0;
    record(
      'foldingRange(Product.php) 非空',
      foldPass,
      `区域数=${folds.length}；样例=${summarize(folds.slice(0, 5))}`,
    );

    // 5) selectionRange
    const selResp = await client.send('textDocument/selectionRange', {
      textDocument: { uri: PRODUCT_URI },
      positions: [authChar],
    }).done;
    const selChain = selResp.result?.[0];
    let chainLen = 0;
    for (let cur = selChain; cur; cur = cur.parent) chainLen++;
    record(
      'selectionRange(auth 位置) 层级链',
      chainLen >= 3,
      `链长=${chainLen}；内层3层=${summarize((() => { const arr: any[] = []; for (let cur = selChain; cur && arr.length < 3; cur = cur.parent) arr.push(cur.range); return arr; })())}`,
    );

    // 6) documentLink（合成 include 文档，__DIR__ 解析）
    const linkUri = 'file://' + path.join(ZUODIAN_ROOT, 'probe-include-test.php');
    const linkText = `<?php\nrequire_once __DIR__ . '/application/common/controller/Backend.php';\ninclude 'application/tags.php';\n`;
    client.notify('textDocument/didOpen', {
      textDocument: { uri: linkUri, languageId: 'php', version: 1, text: linkText },
    });
    const linkResp = await client.send('textDocument/documentLink', { textDocument: { uri: linkUri } }).done;
    const links: any[] = Array.isArray(linkResp.result) ? linkResp.result : [];
    const backendLink = links.find((l) => typeof l?.target === 'string' && l.target.endsWith('Backend.php'));
    record(
      'documentLink(__DIR__ 拼接 → file URI)',
      !!backendLink,
      backendLink
        ? `target=${backendLink.target}`
        : `links=${summarize(links)}（不存在路径的 include 正确地未生成链接：${links.length} 条）`,
    );

    // 7) C 通道：赋值推断兜底（无 docblock @var / @property，纯赋值 + 工厂方法 new static）
    const cUri = 'file://' + path.join(ZUODIAN_ROOT, 'probe-cchannel-test.php');
    const cText = `<?php
namespace app\\common\\library;

class ProbeService
{
    private static $instance;
    public static function instance()
    {
        if (self::$instance === null) {
            self::$instance = new static();
        }
        return self::$instance;
    }
    public function ping(): string
    {
        return 'pong';
    }
}

class ProbeBase
{
    public $svc;

    public function initService()
    {
        $this->svc = ProbeService::instance();
    }
}

class ProbeChild extends ProbeBase
{
    public function useService()
    {
        $this->svc->ping();
    }
}
`;
    client.notify('textDocument/didOpen', {
      textDocument: { uri: cUri, languageId: 'php', version: 1, text: cText },
    });
    const svcPos = locate(cText, '$this->svc->ping()');
    const svcChar = { line: svcPos.line, character: svcPos.character + '$this->'.length };
    const cHover = await client.send('textDocument/hover', { textDocument: { uri: cUri }, position: svcChar }).done;
    const cVal = cHover.result?.contents?.value ?? '';
    const cPass = cVal.includes('ProbeService');
    record(
      'C 通道 hover($this->svc) → 赋值+工厂推断 ProbeService',
      cPass,
      cPass ? `markdown 含 "ProbeService"；摘录: ${cVal.split('\n').slice(0, 4).join(' / ')}` : `contents=${summarize(cHover.result?.contents)}`,
    );

    // ---------- 8) typeHierarchy：真实文件三方法 ----------
    const prepProduct = await client.send('textDocument/prepareTypeHierarchy', {
      textDocument: { uri: PRODUCT_URI },
      position: { line: productClassPos.line, character: productClassPos.character + 'class '.length + 2 },
    }).done;
    const prepItems: any[] = Array.isArray(prepProduct.result) ? prepProduct.result : [];
    const productPrep = prepItems.find((it) => it?.data?.fqn === 'app\\admin\\controller\\product\\Product');
    record(
      'typeHierarchy/prepare(Product 声明) → TypeHierarchyItem',
      !!productPrep,
      productPrep ? `fqn=${productPrep.data.fqn} kind=${productPrep.kind} name=${productPrep.name}` : `结果=${summarize(prepProduct.result)}`,
    );

    const supResp = productPrep
      ? await client.send('typeHierarchy/supertypes', { item: productPrep }).done
      : { result: [] };
    const sups: any[] = Array.isArray(supResp.result) ? supResp.result : [];
    const backendSup = sups.find((s) => s?.name === 'Backend' && typeof s?.uri === 'string' && s.uri.endsWith('common/controller/Backend.php'));
    record(
      'typeHierarchy/supertypes(Product) → Backend（继承上溯，跨文件）',
      !!backendSup,
      backendSup ? `上溯=${sups.map((s) => s.name).join(', ')}（含 Backend @ 0-based line=${backendSup.range.start.line}）` : `结果=${summarize(supResp.result)}`,
    );

    const prepAuth = await client.send('textDocument/prepareTypeHierarchy', { textDocument: { uri: PRODUCT_URI }, position: authChar }).done;
    const authItems: any[] = Array.isArray(prepAuth.result) ? prepAuth.result : [];
    const authItem = authItems.find((it) => it?.data?.fqn === 'app\\admin\\library\\Auth');
    record(
      'typeHierarchy/prepare($this->auth) → Auth（成员类型通道）',
      !!authItem,
      authItem ? `fqn=${authItem.data.fqn} uri=…${authItem.uri.split('/').slice(-2).join('/')}` : `结果=${summarize(prepAuth.result)}`,
    );

    const prepDriver = await client.send('textDocument/prepareTypeHierarchy', {
      textDocument: { uri: driverUri },
      position: { line: driverClassPos.line, character: driverClassPos.character + 'abstract class '.length + 2 },
    }).done;
    const driverItems: any[] = Array.isArray(prepDriver.result) ? prepDriver.result : [];
    const driverPrep = driverItems[0];
    const subResp = driverPrep ? await client.send('typeHierarchy/subtypes', { item: driverPrep }).done : { result: [] };
    const subs: any[] = Array.isArray(subResp.result) ? subResp.result : [];
    const subMysql = subs.find((s) => s?.name === 'Mysql');
    const subRedis = subs.find((s) => s?.name === 'Redis');
    record(
      'typeHierarchy/subtypes(Driver) → Mysql + Redis（子类树下溯）',
      !!subMysql && !!subRedis,
      !!subMysql && !!subRedis ? `下溯=${subs.map((s) => s.name).join(', ')}` : `结果=${summarize(subResp.result)}`,
    );

    const supDriverResp = driverPrep ? await client.send('typeHierarchy/supertypes', { item: driverPrep }).done : { result: [] };
    const supsDriver: any[] = Array.isArray(supDriverResp.result) ? supDriverResp.result : [];
    record(
      'typeHierarchy/supertypes(Driver) → 空（抽象根诚实降级）',
      supsDriver.length === 0,
      `上溯结果数=${supsDriver.length}（vendor 外无父类不虚构）`,
    );

    // ---------- 9) rename：addons 临时 fixture（不落盘应用，结束后清理） ----------
    const REN_DIR = path.join(ZUODIAN_ROOT, 'addons', 'proberen');
    const DEC_DIR = path.join(ZUODIAN_ROOT, 'addons', 'probedecoy');
    const OLD_URI = 'file://' + path.join(REN_DIR, 'OldThing.php');
    const USER_URI = 'file://' + path.join(REN_DIR, 'User.php');
    const CFG_URI = 'file://' + path.join(REN_DIR, 'config.php');
    const DECOY_URI = 'file://' + path.join(DEC_DIR, 'OldThing.php');
    const DECOY_USER_URI = 'file://' + path.join(DEC_DIR, 'DecoyUser.php');
    const renTexts: Record<string, string> = {
      [OLD_URI]: `<?php
namespace addons\\proberen;

class OldThing
{
    public static $count = 0;

    public function ping(): string
    {
        return 'pong';
    }
}
`,
      [USER_URI]: `<?php
namespace addons\\proberen;

use addons\\proberen\\OldThing;

/**
 * 用户
 * @see OldThing
 */
class User
{
    /** @var OldThing */
    public $thing;

    public function go(): OldThing
    {
        $t = new OldThing();
        assert($t instanceof OldThing);
        $t->ping();
        OldThing::$count++;
        return $t;
    }
}
`,
      [CFG_URI]: `<?php
return [
    'target' => 'addons\\proberen\\OldThing',
    'negative' => 'addons\\proberen\\OldThingExtra',
];
`,
      [DECOY_URI]: `<?php
namespace addons\\other;

class OldThing
{
    public function pong(): int
    {
        return 1;
    }
}
`,
      [DECOY_USER_URI]: `<?php
namespace addons\\other;

class DecoyUser
{
    public function t(): OldThing
    {
        return new OldThing();
    }
}
`,
    };
    fs.mkdirSync(REN_DIR, { recursive: true });
    fs.mkdirSync(DEC_DIR, { recursive: true });
    for (const [uri, text] of Object.entries(renTexts)) {
      fs.writeFileSync(uri.slice('file://'.length), text, 'utf8');
      client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'php', version: 1, text } });
    }

    const oldLines = renTexts[OLD_URI].split('\n');
    const oldDeclLine = oldLines.findIndex((l) => l.startsWith('class OldThing'));
    const oldPos = { line: oldDeclLine, character: oldLines[oldDeclLine].indexOf('Old') + 2 };
    const prepRen = await client.send('textDocument/prepareRename', { textDocument: { uri: OLD_URI }, position: oldPos }).done;
    const prepOk = prepRen.result?.placeholder === 'OldThing' && typeof prepRen.result?.range?.start?.line === 'number';
    record(
      'prepareRename(OldThing 声明) → placeholder + range',
      prepOk,
      prepOk ? `placeholder=${prepRen.result.placeholder} range=0-based line=${prepRen.result.range.start.line}` : `结果=${summarize(prepRen.result)}`,
    );

    const renResp = await client.send('textDocument/rename', { textDocument: { uri: OLD_URI }, position: oldPos, newName: 'NewThing' }).done;
    const docChanges: any[] = Array.isArray(renResp.result?.documentChanges) ? renResp.result.documentChanges : [];
    const renameFile = docChanges.find((c) => c.kind === 'rename');
    const editChanges = docChanges.filter((c) => c.kind === 'edit');
    const editedUris = new Set(editChanges.map((c) => c.textDocument.uri));
    const renameFileOk = !!renameFile && renameFile.oldUri.endsWith('/addons/proberen/OldThing.php') && renameFile.newUri.endsWith('/addons/proberen/NewThing.php');
    record(
      'rename(类) → documentChanges 含 renameFile（PSR-4 路径随名迁移）',
      renameFileOk,
      renameFileOk ? `renameFile: ${renameFile.oldUri.split('/').slice(-2).join('/')} → ${renameFile.newUri.split('/').slice(-2).join('/')}` : `结果=${summarize(renResp.result)}`,
    );

    const decoyUntouched = !editedUris.has(DECOY_URI) && !editedUris.has(DECOY_USER_URI);
    const coreTouched = editedUris.has(OLD_URI) && editedUris.has(USER_URI) && editedUris.has(CFG_URI);
    record(
      'rename(类) → 编辑按文件分组：本体/User/config 均更新，双命名空间 decoy 零误改',
      decoyUntouched && coreTouched,
      `编辑文件数=${editChanges.length}：${[...editedUris].map((u) => u.split('/').slice(-2).join('/')).join(', ')}；decoy 未触碰=${decoyUntouched}`,
    );

    // 客户端内存 apply（不落盘）
    const li = [0];
    const applyEdits = (text: string, edits: any[]): string => {
      const starts: number[] = [0];
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
      const at = (p: any) => starts[Math.min(p.line, starts.length - 1)] + p.character;
      const sorted = [...edits].sort((a: any, b: any) => at(b.range.start) - at(a.range.start));
      let t = text;
      for (const e of sorted) {
        const s = at(e.range.start);
        const en = at(e.range.end);
        t = t.slice(0, s) + e.newText + t.slice(en);
      }
      return t;
    };
    const applied: Record<string, string> = {};
    for (const [uri, text] of Object.entries(renTexts)) applied[uri] = text;
    for (const c of editChanges) {
      applied[c.textDocument.uri] = applyEdits(applied[c.textDocument.uri], c.edits);
    }
    // renameFile：内存视图切换键
    if (renameFileOk) {
      applied[renameFile.newUri] = applied[renameFile.oldUri];
      delete applied[renameFile.oldUri];
    }

    const userApplied = applied[USER_URI] ?? '';
    const userChecks = [
      ['use 行更新', userApplied.includes('use addons\\proberen\\NewThing;') && !userApplied.includes('use addons\\proberen\\OldThing;')],
      ['docblock @see/@var 更新', userApplied.includes('@see NewThing') && userApplied.includes('@var NewThing')],
      ['new/instanceof/返回类型更新', userApplied.includes('new NewThing()') && userApplied.includes('instanceof NewThing') && userApplied.includes(': NewThing')],
      ['静态类引用更新', userApplied.includes('NewThing::$count')],
      ['旧名残留', !/\bOldThing\b/.test(userApplied)],
    ];
    const userOk = userChecks.every(([, ok]) => ok);
    record(
      'rename(类) → User.php 内存 apply：use/docblock/new/instanceof/静态引用全部更新且无旧名残留',
      userOk,
      userOk
        ? `use addons\\proberen\\NewThing; @see/@var NewThing new NewThing() instanceof NewThing NewThing::\$count 全命中；旧名残留=0`
        : `未命中项：${userChecks.filter(([, ok]) => !ok).map(([n]) => n).join('、')}`,
    );

    const cfgApplied = applied[CFG_URI] ?? '';
    const cfgOk = cfgApplied.includes("'addons\\proberen\\NewThing'") && cfgApplied.includes('OldThingExtra');
    record(
      'rename(类) → 字符串 FQN 引用（think\\Config 形式）更新，前缀防误配',
      cfgOk,
      cfgOk ? `target 更新为 addons\\proberen\\NewThing；negative OldThingExtra 保持不变` : `结果=${summarize(cfgApplied)}`,
    );

    const oldApplied = applied[renameFileOk ? renameFile.newUri : OLD_URI] ?? '';
    const declOk = oldApplied.includes('class NewThing') && !oldApplied.includes('class OldThing');
    record(
      'rename(类) → 声明处类名更新（renameFile 后内存视图）',
      declOk,
      declOk ? 'class NewThing ✓ 无 class OldThing 残留' : `结果=${summarize(oldApplied.slice(0, 200))}`,
    );

    // ---------- 10) codeAction 三类各一例（内存合成） ----------
    // a) 自动 import：唯一候选 + 字母序插入
    const IMP_SVC = 'file://' + path.join(ZUODIAN_ROOT, 'application', 'probe', 'imp', 'Payment.php');
    const IMP_CALLER = 'file://' + path.join(ZUODIAN_ROOT, 'application', 'probe', 'imp', 'Shop.php');
    const impSvcText = `<?php
namespace app\\probe\\pay;

class Payment
{
    public function total(): float
    {
        return 0.0;
    }
}
`;
    const impCallerText = `<?php

namespace app\\probe\\ca;

use app\\probe\\ca\\AlphaHelper;
use app\\probe\\ca\\ZetaTool;

class Shop
{
    public function pay(): Payment
    {
        return new Payment();
    }
}
`;
    client.notify('textDocument/didOpen', { textDocument: { uri: IMP_SVC, languageId: 'php', version: 1, text: impSvcText } });
    client.notify('textDocument/didOpen', { textDocument: { uri: IMP_CALLER, languageId: 'php', version: 1, text: impCallerText } });
    const payLine = impCallerText.split('\n').findIndex((l) => l.includes(': Payment'));
    const payPos = { line: payLine, character: impCallerText.split('\n')[payLine].indexOf('Payment') + 3 };
    const impActs = await client.send('textDocument/codeAction', {
      textDocument: { uri: IMP_CALLER },
      range: { start: payPos, end: payPos },
      context: { diagnostics: [] },
    }).done;
    const impList: any[] = Array.isArray(impActs.result) ? impActs.result : [];
    const importAction = impList.find((a) => a?.kind === 'quickfix' && typeof a?.title === 'string' && a.title.includes('Import') && a.title.includes('app\\probe\\pay\\Payment'));
    let importOk = false;
    let importEvidence = `actions=${summarize(impList.map((a) => a?.title))}`;
    if (importAction) {
      const resolved = await client.send('codeAction/resolve', importAction).done;
      const edits = resolved.result?.edit?.changes?.[IMP_CALLER] ?? [];
      let text = impCallerText;
      const starts: number[] = [0];
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
      const at = (p: any) => starts[Math.min(p.line, starts.length - 1)] + p.character;
      for (const e of [...edits].sort((a: any, b: any) => at(b.range.start) - at(a.range.start))) {
        const s = at(e.range.start);
        const en = at(e.range.end);
        text = text.slice(0, s) + e.newText + text.slice(en);
      }
      const zetaLine = text.split('\n').findIndex((l) => l.includes('use app\\probe\\ca\\ZetaTool;'));
      const payUseLine = text.split('\n').findIndex((l) => l.includes('use app\\probe\\pay\\Payment;'));
      importOk = payUseLine > 0 && payUseLine > zetaLine;
      importEvidence = importOk ? `resolve 后 use 行按全 FQN 字母序插入 ZetaTool 之后：ZetaTool@${zetaLine} < Payment@${payUseLine}；title="${importAction.title}"` : `插入位置异常：Payment@${payUseLine} ZetaTool@${zetaLine}`;
    }
    record('codeAction/resolve(自动 import) → use 行字母序插入', importOk, importEvidence);

    // b) 批量实现抽象方法：带类型 stub
    const IMP_IF = 'file://' + path.join(ZUODIAN_ROOT, 'application', 'probe', 'imp', 'Transport.php');
    const IMPL_CLS = 'file://' + path.join(ZUODIAN_ROOT, 'application', 'probe', 'imp', 'Express.php');
    const ifText = `<?php
namespace app\\probe\\imp;

interface Transport
{
    public function ship(string $from, string $to, int $weight = 1): bool;
    public static function cost(float $d): float;
}
`;
    const clsText = `<?php
namespace app\\probe\\imp;

class Express implements Transport
{
    public function label(): string
    {
        return 'SF';
    }
}
`;
    client.notify('textDocument/didOpen', { textDocument: { uri: IMP_IF, languageId: 'php', version: 1, text: ifText } });
    client.notify('textDocument/didOpen', { textDocument: { uri: IMPL_CLS, languageId: 'php', version: 1, text: clsText } });
    const clsLine = clsText.split('\n').findIndex((l) => l.includes('class Express'));
    const implActs = await client.send('textDocument/codeAction', {
      textDocument: { uri: IMPL_CLS },
      range: { start: { line: clsLine, character: 10 }, end: { line: clsLine, character: 10 } },
      context: { diagnostics: [] },
    }).done;
    const implList: any[] = Array.isArray(implActs.result) ? implActs.result : [];
    const implAction = implList.find((a) => a?.kind === 'quickfix' && typeof a?.title === 'string' && a.title.includes('实现抽象方法'));
    let implOk = false;
    let implEvidence = `actions=${summarize(implList.map((a) => a?.title))}`;
    if (implAction) {
      const resolved = await client.send('codeAction/resolve', implAction).done;
      const stub = (resolved.result?.edit?.changes?.[IMPL_CLS] ?? []).map((e: any) => e.newText).join('');
      implOk = stub.includes('public function ship(string $from, string $to, int $weight = 1): bool') && stub.includes('public static function cost(float $d): float');
      implEvidence = implOk ? `stub 含完整类型标注与默认值：ship(string,string,int=1):bool + static cost(float):float（title="${implAction.title}"）` : `stub=${summarize(stub)}`;
    }
    record('codeAction/resolve(批量实现抽象方法) → 类型化 stub', implOk, implEvidence);

    // c) 生成 PHPDoc：@param / @return 联合 / @throws
    const DOC_URI = 'file://' + path.join(ZUODIAN_ROOT, 'application', 'probe', 'imp', 'Report.php');
    const docText2 = `<?php
namespace app\\probe\\imp;

class Report
{
    public function build(Payment $svc, int $copies = 1): ?string
    {
        if ($copies < 0) {
            throw new \\InvalidArgumentException('bad copies');
        }
        $svc->total();
        return new PaymentReceipt($copies);
    }

    public function render(int $mode)
    {
        if ($mode === 1) {
            return 'text';
        }
        return 42;
    }
}
`;
    client.notify('textDocument/didOpen', { textDocument: { uri: DOC_URI, languageId: 'php', version: 1, text: docText2 } });
    const buildLine = docText2.split('\n').findIndex((l) => l.includes('function build'));
    const docActs = await client.send('textDocument/codeAction', {
      textDocument: { uri: DOC_URI },
      range: { start: { line: buildLine, character: 24 }, end: { line: buildLine, character: 24 } },
      context: { diagnostics: [] },
    }).done;
    const docList: any[] = Array.isArray(docActs.result) ? docActs.result : [];
    const docAction = docList.find((a) => a?.kind === 'source' && typeof a?.title === 'string' && a.title.includes('PHPDoc'));
    let docOk = false;
    let docEvidence = `actions=${summarize(docList.map((a) => a?.title))}`;
    if (docAction) {
      const resolved = await client.send('codeAction/resolve', docAction).done;
      const block = (resolved.result?.edit?.changes?.[DOC_URI] ?? []).map((e: any) => e.newText).join('');
      const checks = [
        block.includes('@param Payment $svc'),
        block.includes('@param int $copies'),
        block.includes('@return ?string'),
        block.includes('@throws \\InvalidArgumentException'),
      ];
      docOk = checks.every(Boolean);
      docEvidence = docOk ? `docblock 含 @param Payment $svc / @param int $copies / @return ?string / @throws \\InvalidArgumentException` : `缺失项=${checks.filter((c) => !c).length}；block=${summarize(block)}`;
    }
    record('codeAction/resolve(生成 PHPDoc) → @param/@return ?Type/@throws', docOk, docEvidence);

    const renderLine = docText2.split('\n').findIndex((l) => l.includes('function render'));
    const docActs2 = await client.send('textDocument/codeAction', {
      textDocument: { uri: DOC_URI },
      range: { start: { line: renderLine, character: 26 }, end: { line: renderLine, character: 26 } },
      context: { diagnostics: [] },
    }).done;
    const docList2: any[] = Array.isArray(docActs2.result) ? docActs2.result : [];
    const docAction2 = docList2.find((a) => a?.kind === 'source');
    let renderOk = false;
    let renderEvidence = `actions=${summarize(docList2.map((a) => a?.title))}`;
    if (docAction2) {
      const resolved = await client.send('codeAction/resolve', docAction2).done;
      const block = (resolved.result?.edit?.changes?.[DOC_URI] ?? []).map((e: any) => e.newText).join('');
      renderOk = block.includes('@param int $mode') && block.includes('@return string|int');
      renderEvidence = renderOk ? '多 return 字面量联合 @return string|int + @param int $mode' : `block=${summarize(block)}`;
    }
    record('codeAction/resolve(生成 PHPDoc) → 多 return 联合类型', renderOk, renderEvidence);

    // ---------- 11) T4 codeLens：计数 + resolve 惰性（合成 fixture，didOpen 不落盘） ----------
    const T4_DIR = path.join(ZUODIAN_ROOT, 'application', 'probe', 't4');
    const t4 = (f: string): string => 'file://' + path.join(T4_DIR, f);
    const t4Texts: Record<string, string> = {
      'MixTarget.php': `<?php
namespace app\\probe\\t4;

class MixTarget
{
    /** @var string */
    public $mixProp;

    public function mixMethod(int $a, string $b = 'x'): string
    {
        return $b . $a;
    }
}
`,
      'traits.php': `<?php
namespace app\\probe\\t4;

trait HasLogger
{
    public function log(string $msg): void
    {
    }
}
`,
      'Base.php': `<?php
namespace app\\probe\\t4;

class Base
{
    public function handle(): void
    {
    }
}
`,
      'Virt.php': `<?php
namespace app\\probe\\t4;

class Virt
{
    public function ping(): string
    {
        return 'pong';
    }
}
`,
      'MixMain.php': `<?php
namespace app\\probe\\t4;

use app\\probe\\t4\\MixTarget;

/**
 * 探针主体
 * @mixin MixTarget
 * @property \\app\\probe\\t4\\Virt $virt 虚拟属性
 */
class MixMain extends Base
{
    use HasLogger;

    /** @var MixTarget */
    public $target;

    /** @var string */
    public $label = 'init';

    public function mixCall(): string
    {
        $this->mixMethod(1, 'a');
        return $this->virt->ping();
    }

    public function pick(string $name, $weight = 1)
    {
        $t = new MixTarget();
        $t->mixMethod(2, 'b');
        return $this->target->mixProp . $this->label . $name . $weight;
    }

    public function flag($v)
    {
        return true;
    }

    public function fire($x)
    {
        $this->label = $x;
    }
}
`,
      'Sub.php': `<?php
namespace app\\probe\\t4;

class Sub extends Base
{
    public function handle(): void
    {
        $m = new MixTarget();
        echo "user {$m->mixProp}";
    }

    public function render(MixMain $main, int $copies): void
    {
        $main->mixMethod(3, 'c');
        $main->pick('n', 2);
        $main->pick(name: 'n', w: 2);
        $fn = function (string $s, $t = 1) { return $s; };
        $dbl = fn($x) => $x * 2;
        ?>
<div><?= $main->mixMethod(4, 'd') ?></div>
        <?php
    }
}
`,
    };
    for (const [f, text] of Object.entries(t4Texts)) {
      client.notify('textDocument/didOpen', { textDocument: { uri: t4(f), languageId: 'php', version: 1, text } });
    }
    const lensOf = (f: string): Promise<any[]> =>
      client.send('textDocument/codeLens', { textDocument: { uri: t4(f) } }).done.then((r: any) => (Array.isArray(r.result) ? r.result : []));
    const resolveLens = async (lens: any): Promise<any> => (await client.send('codeLens/resolve', { codeLens: lens }).done).result;

    // compute：骨架带 range+data（kind），无 command（resolve 惰性）
    const mainLenses = await lensOf('MixMain.php');
    const mainDocText = t4Texts['MixMain.php'];
    const mainClassLine = mainDocText.split('\n').findIndex((l) => l.startsWith('class MixMain'));
    const mainTraitLine = mainDocText.split('\n').findIndex((l) => l.includes('use HasLogger'));
    const mainDocpropLine = mainDocText.split('\n').findIndex((l) => l.includes('@property'));
    const skeletonOk =
      mainLenses.length > 0 &&
      mainLenses.every((l) => !l.command && l.data?.kind) &&
      mainLenses.some((l) => l.data?.kind === 'class-subtypes' && l.range.start.line === mainClassLine) &&
      mainLenses.some((l) => l.data?.kind === 'traituse' && l.range.start.line === mainTraitLine) &&
      mainLenses.some((l) => l.data?.kind === 'docprop-refs' && l.range.start.line === mainDocpropLine);
    record(
      'codeLens(MixMain) → 骨架只带 range+kind（类/方法/属性/traituse/docprop），resolve 惰性',
      skeletonOk,
      skeletonOk
        ? `lens 数=${mainLenses.length}，kinds=${[...new Set(mainLenses.map((l) => l.data.kind))].join('/')}，全部无 command`
        : `lens=${summarize(mainLenses.map((l: any) => ({ k: l.data?.kind, line: l.range?.start?.line, cmd: l.command })))}`,
    );

    // resolve：Base 子类/实现/重写计数（Sub + MixMain）
    const baseLenses = await lensOf('Base.php');
    const baseResolved: any[] = [];
    for (const l of baseLenses) baseResolved.push(await resolveLens(l));
    const baseCmd = (kind: string): string | undefined => baseResolved.find((l) => l.data?.kind === kind)?.command?.title;
    const baseOk = baseCmd('class-subtypes') === '2 个子类' && baseCmd('class-implementations') === '2 个实现';
    const handleOverride = baseResolved.find((l) => l.data?.kind === 'method-overrides' && l.data?.member === 'handle')?.command?.title ?? '';
    // 子类侧：Sub::handle 标注重写来源 Base::handle
    const subLensesBase = await lensOf('Sub.php');
    const subHandle = (await resolveLens(subLensesBase.find((l) => l.data?.kind === 'method-overrides' && l.data?.member === 'handle'))).command?.title ?? '';
    record(
      'codeLens/resolve(Base) → 子类 2 / 实现 2 / handle 被 1 个子类重写（子类侧标注 重写 Base::handle）',
      baseOk && handleOverride.includes('被 1 个子类重写') && subHandle.includes('重写 Base::handle'),
      baseOk && handleOverride
        ? `subtypes="${baseCmd('class-subtypes')}" implementations="${baseCmd('class-implementations')}" overrides="${handleOverride}"；Sub::handle="${subHandle}"`
        : `resolved=${summarize(baseResolved.filter((l) => l.command).map((l) => ({ k: l.data?.kind, m: l.data?.member, t: l.command?.title })))}`,
    );

    // resolve：traituse 行（MixMain use HasLogger）→ 使用该 trait 的类数（含宿主）=1
    const traituseLens = mainLenses.find((l) => l.data?.kind === 'traituse');
    const traituseResolved = traituseLens ? await resolveLens(traituseLens) : null;
    record(
      'codeLens/resolve(trait use 行) → HasLogger 被 1 个类使用',
      traituseResolved?.command?.title === '1 个类使用',
      `title=${summarize(traituseResolved?.command?.title)}`,
    );

    // resolve：属性与 docblock @property 虚拟属性引用计数
    const targetRefs = (await resolveLens(mainLenses.find((l) => l.data?.kind === 'property-refs' && l.data?.member === 'target'))).command?.title;
    const labelRefs = (await resolveLens(mainLenses.find((l) => l.data?.kind === 'property-refs' && l.data?.member === 'label'))).command?.title;
    const virtRefs = (await resolveLens(mainLenses.find((l) => l.data?.kind === 'docprop-refs'))).command?.title;
    const propOk = targetRefs === '1 处引用' && labelRefs === '2 处引用' && virtRefs === '1 处引用';
    record(
      'codeLens/resolve(属性) → $target 1 / $label 2 / docblock @property $virt 1（docblock 通道计数）',
      propOk,
      propOk ? `target="${targetRefs}" label="${labelRefs}" virt="${virtRefs}"` : `target=${summarize(targetRefs)} label=${summarize(labelRefs)} virt=${summarize(virtRefs)}`,
    );

    // resolve：零计数 → 无 command（客户端隐藏，零噪声）
    const mainSubtypes = await resolveLens(mainLenses.find((l) => l.data?.kind === 'class-subtypes'));
    const mixCallRefs = await resolveLens(mainLenses.find((l) => l.data?.kind === 'method-refs' && l.data?.member === 'mixCall'));
    const zeroOk = !mainSubtypes.command && !mixCallRefs.command;
    record(
      'codeLens/resolve(零计数) → MixMain 无子类、mixCall 零引用：无 command（隐藏）',
      zeroOk,
      zeroOk ? 'class-subtypes/method-refs 均无 command' : `subtypes=${summarize(mainSubtypes.command)} mixCall=${summarize(mixCallRefs.command)}`,
    );

    // ---------- 12) T4 inlayHint：参数名/返回类型/闭包三类（resolve 惰性 + 上限保护） ----------
    const hintsOf = (f: string): Promise<any[]> =>
      client.send('textDocument/inlayHint', { textDocument: { uri: t4(f) } }).done.then((r: any) => (Array.isArray(r.result) ? r.result : []));
    const resolveHint = async (h: any): Promise<any> => (await client.send('inlayHint/resolve', h).done).result;

    const subHints = await hintsOf('Sub.php');
    const subDocText = t4Texts['Sub.php'];
    const subLines = subDocText.split('\n');
    const pickPosLine = subLines.findIndex((l) => l.includes("$main->pick('n', 2);"));
    const pickNamedLine = subLines.findIndex((l) => l.includes("$main->pick(name: 'n', w: 2);"));
    const fnLine = subLines.findIndex((l) => l.includes('$fn = function'));
    const dblLine = subLines.findIndex((l) => l.includes('$dbl = fn('));
    const paramOnPick = subHints.filter((h) => h.position.line === pickPosLine && h.data?.kind === 'param');
    const paramOnNamed = subHints.filter((h) => h.position.line === pickNamedLine && h.data?.kind === 'param');
    const closureHints = subHints.filter((h) => (h.position.line === fnLine || h.position.line === dblLine) && h.data?.kind === 'closure');
    record(
      'inlayHint(Sub) compute → 位置实参 hint 骨架（具名参数保守跳过），闭包/箭头函数赋值目标 hint',
      paramOnPick.length === 2 && paramOnNamed.length === 0 && closureHints.length === 2,
      `pick 位置参数 hint=${paramOnPick.length}；具名参数 hint=${paramOnNamed.length}（应 0）；closure/arrowfn hint=${closureHints.length} @ line ${fnLine}/${dblLine}`,
    );

    const pickResolved = await Promise.all(paramOnPick.map(resolveHint));
    const pickLabels = pickResolved.map((h) => h.label).join(',');
    const closureResolved = await Promise.all(closureHints.map(resolveHint));
    const fnLabel = closureResolved.find((h) => h.position.line === fnLine)?.label ?? '';
    const dblLabel = closureResolved.find((h) => h.position.line === dblLine)?.label ?? '';
    const closureOk = pickLabels === 'name:,weight:' && fnLabel.includes('Closure(string s, t)') && dblLabel.includes('Closure(x)');
    record(
      'inlayHint/resolve → 形参名 name:/weight: + 闭包签名 : Closure(string s, t) + 箭头函数 : Closure(x)',
      closureOk,
      closureOk ? `pick labels="${pickLabels}"；$fn="${fnLabel}"；$dbl="${dblLabel}"` : `pick="${pickLabels}" fn="${fnLabel}" dbl="${dblLabel}"`,
    );

    const mainHints = await hintsOf('MixMain.php');
    const mainLines = mainDocText.split('\n');
    const flagLine = mainLines.findIndex((l) => l.includes('public function flag('));
    const fireLine = mainLines.findIndex((l) => l.includes('public function fire('));
    const pickDeclLine = mainLines.findIndex((l) => l.includes('public function pick('));
    const returnHints = mainHints.filter((h) => h.data?.kind === 'return');
    const flagLabel = (await resolveHint(returnHints.find((h) => h.position.line === flagLine)))?.label ?? '';
    const fireLabel = (await resolveHint(returnHints.find((h) => h.position.line === fireLine)))?.label ?? '';
    const pickReturnHint = returnHints.find((h) => h.position.line === pickDeclLine);
    const pickLabel = pickReturnHint ? (await resolveHint(pickReturnHint))?.label ?? '' : '(无骨架)';
    const hintLimit = (await hintsOf('Sub.php')).length <= 500;
    record(
      'inlayHint/resolve(返回类型) → flag : bool / fire : void；pick 表达式串联推不出诚实省略；单文档 ≤500 上限',
      flagLabel === ': bool' && fireLabel === ': void' && (pickLabel === '' || pickLabel === '(无骨架)') && hintLimit,
      `flag="${flagLabel}" fire="${fireLabel}" pick="${pickLabel === '' ? '(空，隐藏)' : pickLabel}"；hints 数=${(await hintsOf('Sub.php')).length}≤500=${hintLimit}`,
    );

    // ---------- 13) T4 @mixin 合并：成员通道 completion/definition + rename mixin 通道 + 嵌入语境 ----------
    const mmLine = mainLines.findIndex((l) => l.includes("$this->mixMethod(1"));
    const mixMethodTokPos = { line: mmLine, character: mainLines[mmLine].indexOf('mixMethod') + 2 };
    const compThisPos = { line: mmLine, character: mainLines[mmLine].indexOf('$this->mixMethod') + '$this->'.length };

    const compMain = await client.send('textDocument/completion', { textDocument: { uri: t4('MixMain.php') }, position: compThisPos }).done;
    const compMainItems: any[] = Array.isArray(compMain.result) ? compMain.result : compMain.result?.items ?? [];
    const mixMethodItem = compMainItems.find((it) => it?.label === 'mixMethod');
    const virtItem = compMainItems.find((it) => it?.label === 'virt');
    const mixinCompOk =
      !!mixMethodItem && typeof mixMethodItem?.detail === 'string' && mixMethodItem.detail.startsWith('mixin:app\\probe\\t4\\MixTarget') && !!virtItem;
    record(
      'completion($this->) @mixin 合并 → mixMethod（origin=mixin:MixTarget）与 @property virt 均在列',
      mixinCompOk,
      mixinCompOk
        ? `mixMethod detail="${mixMethodItem.detail}"；总项数=${compMainItems.length}（含 trait log 与父类 handle）`
        : `items=${summarize(compMainItems.map((i) => i?.label))}`,
    );

    const mixDef = await client.send('textDocument/definition', { textDocument: { uri: t4('MixMain.php') }, position: mixMethodTokPos }).done;
    const mixDefs: any[] = Array.isArray(mixDef.result) ? mixDef.result : mixDef.result ? [mixDef.result] : [];
    const mixTargetDeclLine = t4Texts['MixTarget.php'].split('\n').findIndex((l) => l.includes('public function mixMethod'));
    const mixDefHit = mixDefs.find((d) => typeof d?.uri === 'string' && d.uri.endsWith('probe/t4/MixTarget.php') && d.range?.start?.line === mixTargetDeclLine);
    record(
      'definition($this->mixMethod) → 经 mixin 通道跳 MixTarget.php 声明',
      !!mixDefHit,
      mixDefHit ? `MixTarget.php @ 0-based line=${mixDefHit.range.start.line}（1-based ${mixTargetDeclLine + 1}）` : `结果=${summarize(mixDef.result)}`,
    );

    // codeLens：mixMethod 引用计数（mixin 通道 + 嵌入语境）：mixCall 1 + pick 1 + Sub.render 2（含 <?= ?> 内联块）= 4
    const mtLensesProbe = await lensOf('MixTarget.php');
    const mixMethodLens = mtLensesProbe.find((l) => l.data?.kind === 'method-refs' && l.data?.member === 'mixMethod');
    const mixMethodRefs = mixMethodLens ? (await resolveLens(mixMethodLens)).command?.title : undefined;
    record(
      'codeLens/resolve(mixMethod) → 4 处引用（mixin 通道 + 嵌入 <?= ?> 内联块全覆盖）',
      mixMethodRefs === '4 处引用',
      `title=${summarize(mixMethodRefs)}（MixMain 2 处 + Sub 常规 1 处 + Sub <?= ?> 1 处）`,
    );

    // rename mixin 通道：改 MixTarget::mixMethod → 使用方（经 @mixin 的 MixMain + Sub 内联块）引用同步更新
    const mixTargetLines = t4Texts['MixTarget.php'].split('\n');
    const mtDeclLine = mixTargetLines.findIndex((l) => l.includes('public function mixMethod'));
    const mtPos = { line: mtDeclLine, character: mixTargetLines[mtDeclLine].indexOf('mixMethod') + 2 };
    const mixRen = await client.send('textDocument/rename', { textDocument: { uri: t4('MixTarget.php') }, position: mtPos, newName: 'blendMethod' }).done;
    const mixChanges: any[] = Array.isArray(mixRen.result?.documentChanges) ? mixRen.result.documentChanges.filter((c: any) => c.kind === 'edit') : [];
    const applyTextEdits = (text: string, edits: any[]): string => {
      const starts: number[] = [0];
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
      const at = (p: any) => starts[Math.min(p.line, starts.length - 1)] + p.character;
      let t = text;
      for (const e of [...edits].sort((a: any, b: any) => at(b.range.start) - at(a.range.start))) {
        const s = at(e.range.start);
        const en = at(e.range.end);
        t = t.slice(0, s) + e.newText + t.slice(en);
      }
      return t;
    };
    // 按 URI 建 key（rename 编辑按 URI 分组）
    const mixApplied: Record<string, string> = {};
    for (const [f, text] of Object.entries(t4Texts)) mixApplied[t4(f)] = text;
    for (const c of mixChanges) mixApplied[c.textDocument.uri] = applyTextEdits(mixApplied[c.textDocument.uri] ?? '', c.edits);
    const mainApplied = mixApplied[t4('MixMain.php')] ?? '';
    const subApplied = mixApplied[t4('Sub.php')] ?? '';
    const mixRenameOk =
      mainApplied.includes('$this->blendMethod(1') &&
      mainApplied.includes('$t->blendMethod(2') &&
      subApplied.includes("$main->blendMethod(3, 'c')") &&
      subApplied.includes("$main->blendMethod(4, 'd')") &&
      !/\bmixMethod\b/.test(mainApplied) &&
      !/\bmixMethod\b/.test(subApplied) &&
      (t4Texts['MixTarget.php'].match(/mixMethod/g) ?? []).length >= 0 &&
      mixApplied[t4('MixTarget.php')].includes('public function blendMethod(');
    record(
      'rename(@mixin 成员) → 使用方经 mixin 通道引用全更新（MixMain 2 处 + Sub 常规/内联块 2 处），旧名零残留',
      mixRenameOk,
      mixRenameOk
        ? `编辑文件数=${mixChanges.length}；\$this->blendMethod + \$t->blendMethod + \$main->blendMethod(3)/(4) 命中；mixMethod 残留=0`
        : `main 有 blend=${mainApplied.includes('blendMethod')}，sub 内联块=${subApplied.includes('blendMethod(4')}，残留=${/\\bmixMethod\\b/.test(mainApplied) || /\\bmixMethod\\b/.test(subApplied)}`,
    );

    // 嵌入 HTML/JS 语境（vip §13 务实子集）：双引号字符串插值 "{$m->mixProp}" 属性引用改名 + heredoc 内插值
    const propDeclLine = t4Texts['MixTarget.php'].split('\n').findIndex((l) => l.includes('public $mixProp'));
    const propPos = { line: propDeclLine, character: t4Texts['MixTarget.php'].split('\n')[propDeclLine].indexOf('mixProp') + 2 };
    const propRen = await client.send('textDocument/rename', { textDocument: { uri: t4('MixTarget.php') }, position: propPos, newName: 'blendProp' }).done;
    const propChanges: any[] = Array.isArray(propRen.result?.documentChanges) ? propRen.result.documentChanges.filter((c: any) => c.kind === 'edit') : [];
    const propApplied: Record<string, string> = {};
    for (const [f, text] of Object.entries(t4Texts)) propApplied[t4(f)] = text;
    for (const c of propChanges) propApplied[c.textDocument.uri] = applyTextEdits(propApplied[c.textDocument.uri] ?? '', c.edits);
    const subPropApplied = propApplied[t4('Sub.php')] ?? '';
    const propRenameOk = subPropApplied.includes('"user {$m->blendProp}"') && !subPropApplied.includes('mixProp');
    record(
      'rename(嵌入语境) → 双引号字符串插值 "{$m->mixProp}" 内属性引用更新（php-parser encapsed 表达式节点）',
      propRenameOk,
      propRenameOk ? `Sub.php 插值更新为 "{$m->blendProp}"，mixProp 残留=0` : `sub=${summarize(subPropApplied.split('\n').find((l) => l.includes('blendProp') || l.includes('mixProp')))}`,
    );

    // ---------- 14) T4 php.toml 兼容：serverInfo 0.3.0 + T4 provider 注册 + didChangeConfiguration 转发 ----------
    const capsT4Ok =
      serverInfo?.version === '0.3.0' &&
      caps.codeLensProvider?.resolveProvider === true &&
      caps.inlayHintProvider?.resolveProvider === true;
    record(
      'initialize(T4) → serverInfo 0.3.0 + codeLensProvider/inlayHintProvider（resolveProvider）自研注册',
      capsT4Ok,
      capsT4Ok
        ? `version=${serverInfo?.version} codeLensProvider=${summarize(caps.codeLensProvider)} inlayHintProvider=${summarize(caps.inlayHintProvider)}`
        : `serverInfo=${summarize(serverInfo)} codeLens=${summarize(caps.codeLensProvider)} inlayHint=${summarize(caps.inlayHintProvider)}`,
    );

    // php.toml resync-on-configuration=true：configuration 段含 intelephense 环境设置 → 中间件不炸、原样转发官方
    client.notify('workspace/didChangeConfiguration', {
      settings: { intelephense: { environment: { phpVersion: '7.4', phpVersionOverride: null } }, probing: true },
    });
    const symResp = await client.send('textDocument/documentSymbol', { textDocument: { uri: PRODUCT_URI } }).done;
    const syms: any[] = Array.isArray(symResp.result) ? symResp.result : symResp.result?.items ?? symResp.result?.symbols ?? [];
    const cfgOkT4 = Array.isArray(symResp.result) && syms.length > 0 && !symResp.error;
    record(
      'didChangeConfiguration(intelephense 环境设置) → 不炸且后续官方请求正常（documentSymbol 有结果）',
      cfgOkT4,
      cfgOkT4 ? `settings 含 intelephense.environment.phpVersion=7.4 + 未知段；documentSymbol 返回 ${syms.length} 个符号（透传官方存活）` : `resp=${summarize(symResp)}`,
    );

    // fixture 清理（探针不留痕）
    try {
      fs.rmSync(REN_DIR, { recursive: true, force: true });
      fs.rmSync(DEC_DIR, { recursive: true, force: true });
    } catch {
      // 清理失败不影响探针结论
    }

    // 汇总
    const failed = results.filter((r) => !r.pass);
    console.log('\n==== 探针汇总 ====');
    for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
    console.log(`${results.length - failed.length}/${results.length} 通过${failed.length === 0 ? '（auth 案例 A/B/C 与三基础功能全部就绪）' : ''}`);
    void expectedLine55;
    process.exitCode = failed.length === 0 ? 0 : 1;
  } catch (err) {
    console.error('PROBE ERROR:', err);
    process.exitCode = 2;
  } finally {
    await client.stop();
  }
}

void main();
