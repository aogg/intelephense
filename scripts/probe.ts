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
