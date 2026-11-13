/**
 * router.ts：客户端↔官方 双向消息路由（architecture.md §三）。
 * - 默认透传；命中自研路由表的方法截留；
 * - initialize 响应进能力合并；文档镜像 fan-out；
 * - definition/hover/completion 双引擎：转发官方 + 引擎并行，应答时合并（自研高置信优先）；
 * - 绝不过滤官方通知（合规 §5d）。
 */

import { mergeInitializeResponse, OWN_FEATURES } from './caps';
import { mergeCompletions, pickLocations, pickHover } from './merge';
import type { JsonRpcMessage } from './framer';
import type { Engine } from './engine/engine';

/** 自研独占处理（不转发官方） */
const OWN_HANDLED = new Set([
  'textDocument/foldingRange',
  'textDocument/selectionRange',
  'textDocument/documentLink',
  'textDocument/typeDefinition',
  'textDocument/implementation',
  'textDocument/declaration',
  'textDocument/prepareTypeHierarchy',
  'typeHierarchy/supertypes',
  'typeHierarchy/subtypes',
  'textDocument/rename',
  'textDocument/prepareRename',
  'textDocument/codeAction',
  'codeAction/resolve',
  'textDocument/codeLens',
  'codeLens/resolve',
  'textDocument/inlayHint',
  'inlayHint/resolve',
]);

/** 双引擎合并处理（转发官方 + 引擎并行） */
const MERGED_HANDLED = new Set(['textDocument/definition', 'textDocument/hover', 'textDocument/completion']);

/**
 * MERGED 通道等待自研引擎结果的上限（毫秒）。
 * 取舍：官方引擎的 definition/hover/completion 结果免费且极快（实测 ~13ms），
 * completeMerged 绝不能被自研 ownPromise 无限阻塞——自研引擎一旦挂死（大项目扫描/解析
 * pathological 文件），官方的好结果会被无限期扣住，用户侧表现为跳转全灭。
 * 因此官方响应到达后只给自研一个有上限的合并窗口（竞速）：自研增强迟到则本次降级为纯官方
 * 结果回包（跳转/悬停/补全即时恢复；自研结果不丢弃，仅本次不合并）。
 */
const MERGED_OWN_WAIT_MS = 300;

/** 竞速败者哨兵：MERGED_OWN_WAIT_MS 后 resolve，用于区分「自研无结果(null)」与「合并窗口超时」 */
const OWN_TIMED_OUT = Symbol('own-timed-out');

/** 竞速败者：MERGED_OWN_WAIT_MS 后 resolve(OWN_TIMED_OUT)，仅用于给合并窗口封顶 */
function ownWaitTimeout(): Promise<typeof OWN_TIMED_OUT> {
  return new Promise((resolve) => setTimeout(() => resolve(OWN_TIMED_OUT), MERGED_OWN_WAIT_MS));
}

interface PendingMerged {
  method: string;
  ownPromise: Promise<unknown>;
}

export class Router {
  /** id → 待合并的自研结果（官方响应回来时取用） */
  private pendingMerged = new Map<number | string, PendingMerged>();
  /** initialize 请求的 id：仅该 id 的官方响应走能力合并，其余官方响应一律原样透传（references/documentSymbol 等数组响应不可破坏） */
  private initializeRequestId: number | string | undefined = undefined;
  /** 客户端最近一次 workspace/didChangeConfiguration 的 settings（自留镜像；转发不受影响） */
  lastClientSettings: unknown = undefined;

  constructor(
    private engine: Engine,
    private sendToClient: (msg: JsonRpcMessage) => void,
    private sendToServer: (msg: JsonRpcMessage) => void,
  ) {}

  /** 客户端 → 中间件 */
  onClientMessage(msg: JsonRpcMessage): void {
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    const id = msg.id as number | string | undefined;

    // 请求（带 id + method）
    if (method && id !== undefined) {
      if (OWN_HANDLED.has(method)) {
        void this.handleOwnRequest(id as number, method, msg);
        return;
      }
      if (MERGED_HANDLED.has(method)) {
        // 防未捕获拒绝：ownPromise 的 rejection 必须在创建处就被捕获降级为 null（带日志），
        // 保证任何时刻不存在游离的未处理 rejection（此前官方响应先回时它会直接崩掉进程）。
        const ownPromise = this.computeOwn(method, msg).catch((err: unknown) => {
          process.stderr.write(`[intelephense-openidea] merged ${method} own engine failed: ${String(err)}\n`);
          return null;
        });
        this.pendingMerged.set(id as number, { method, ownPromise });
        this.sendToServer(msg);
        return;
      }
      if (method === 'initialize') {
        this.setupWorkspace(msg);
        this.initializeRequestId = id; // 记录请求 id，响应配对时才做能力合并
        this.sendToServer(msg);
        return;
      }
      this.sendToServer(msg);
      return;
    }

    // 通知
    if (method) {
      switch (method) {
        case 'textDocument/didOpen': {
          const p = msg.params as any;
          if (p?.textDocument?.uri && typeof p.textDocument.text === 'string') {
            this.engine.openDocument(p.textDocument.uri, p.textDocument.text);
          }
          break;
        }
        case 'textDocument/didChange': {
          const p = msg.params as any;
          if (p?.textDocument?.uri && Array.isArray(p.contentChanges)) {
            this.engine.changeDocument(p.textDocument.uri, p.contentChanges);
          }
          break;
        }
        case 'textDocument/didClose': {
          const p = msg.params as any;
          if (p?.textDocument?.uri) this.engine.closeDocument(p.textDocument.uri);
          break;
        }
        case 'workspace/didChangeWatchedFiles':
          this.engine.invalidateScan();
          break;
        case 'workspace/didChangeConfiguration':
          // php.toml resync-on-configuration=true：客户端会重发。原样转发官方（不拦截不过滤），
          // 同时自留一份 settings（含 intelephense 段等客户端环境设置，供后续自研开关如 premiumPassthrough 读取）。
          this.lastClientSettings = (msg.params as { settings?: unknown } | undefined)?.settings;
          break;
        default:
          break;
      }
      // 所有通知原样转发（含 didOpen/didChange/didClose），绝不过滤
      this.sendToServer(msg);
      return;
    }

    // 其他（响应等）原样透传
    this.sendToServer(msg);
  }

  /** 官方 → 中间件 */
  onServerMessage(msg: JsonRpcMessage): void {
    const id = msg.id as number | string | undefined;

    // initialize 响应（与记录的请求 id 配对的成功响应）：能力合并 + serverInfo
    if (id !== undefined && !('method' in msg) && (msg.result || msg.error)) {
      const pending = this.pendingMerged.get(id as number);
      if (!pending && this.isInitializeResponse(id) && msg.result !== undefined) {
        this.initializeRequestId = undefined; // id 已消费：后续同 id 响应（异常/重放）不再合并
        const result = msg.result as Record<string, unknown>;
        try {
          msg = { ...msg, result: mergeInitializeResponse(result, OWN_FEATURES, VERSION) };
        } catch {
          // 合并失败时透传原始响应
        }
        this.sendToClient(msg);
        return;
      }
      if (pending) {
        void this.completeMerged(id as number, pending, msg);
        return;
      }
    }

    // 其余一切（references/documentSymbol/workspaceSymbol/formatting 响应、publishDiagnostics、
    // window/*、registerCapability 等）原样转发，绝不过滤
    this.sendToClient(msg);
  }

  /** initialize 响应判定：响应 id 与记录的 initialize 请求 id 配对（initialize 为会话首个请求，响应一一对应） */
  private isInitializeResponse(id: number | string): boolean {
    return this.initializeRequestId !== undefined && id === this.initializeRequestId;
  }

  private async handleOwnRequest(id: number, method: string, msg: JsonRpcMessage): Promise<void> {
    let result: unknown = null;
    try {
      result = await this.computeOwn(method, msg);
    } catch (err) {
      process.stderr.write(`[intelephense-openidea] own ${method} failed: ${String(err)}\n`);
      result = null;
    }
    this.sendToClient({ jsonrpc: '2.0', id, result: result ?? null });
  }

  private async computeOwn(method: string, msg: JsonRpcMessage): Promise<unknown> {
    const params = (msg.params ?? {}) as any;
    switch (method) {
      case 'textDocument/foldingRange':
        return this.engine.foldingRanges(params.textDocument?.uri);
      case 'textDocument/selectionRange': {
        const positions = Array.isArray(params.positions) ? params.positions : [];
        return this.engine.selectionRanges(params.textDocument?.uri, positions);
      }
      case 'textDocument/documentLink':
        return this.engine.documentLinks(params.textDocument?.uri);
      case 'textDocument/definition':
        return this.engine.definition(params);
      case 'textDocument/hover':
        return this.engine.hover(params);
      case 'textDocument/completion':
        return this.engine.completion(params);
      case 'textDocument/typeDefinition':
        return this.engine.typeDefinition(params);
      case 'textDocument/implementation':
        return this.engine.implementation(params);
      case 'textDocument/declaration':
        return this.engine.declaration(params);
      case 'textDocument/prepareTypeHierarchy':
        return this.engine.prepareTypeHierarchy(params);
      case 'typeHierarchy/supertypes':
        return this.engine.typeHierarchySupertypes(params.item);
      case 'typeHierarchy/subtypes':
        return this.engine.typeHierarchySubtypes(params.item);
      case 'textDocument/prepareRename':
        return this.engine.prepareRename(params);
      case 'textDocument/rename':
        return this.engine.rename(params);
      case 'textDocument/codeAction':
        return this.engine.codeActions(params);
      case 'codeAction/resolve':
        return this.engine.codeActionResolve(params as any);
      case 'textDocument/codeLens':
        return this.engine.codeLenses(params.textDocument?.uri);
      case 'codeLens/resolve':
        return this.engine.codeLensResolve((params as any)?.codeLens ?? {});
      case 'textDocument/inlayHint':
        return this.engine.inlayHints(params.textDocument?.uri, params.range);
      case 'inlayHint/resolve':
        return this.engine.inlayHintResolve(params as any);
      default:
        return null;
    }
  }

  private async completeMerged(id: number, pending: PendingMerged, serverMsg: JsonRpcMessage): Promise<void> {
    this.pendingMerged.delete(id);
    // 有上限的竞速：官方响应已到达，只给自研 MERGED_OWN_WAIT_MS 的合并窗口。
    // 自研挂死/迟到 → 本次降级为纯官方回包，绝不无限期扣住官方结果。
    // ownPromise 在创建处已挂 .catch（永不 reject），这里无需再兜 try/catch。
    let own: unknown = await Promise.race([pending.ownPromise, ownWaitTimeout()]);
    if (own === OWN_TIMED_OUT) {
      process.stderr.write(
        `[intelephense-openidea] merged ${pending.method}: own engine exceeded ${MERGED_OWN_WAIT_MS}ms, degrading to official-only\n`,
      );
      own = null;
    }

    let mergedResult: unknown;
    const officialResult = serverMsg.result;
    const officialError = serverMsg.error;
    switch (pending.method) {
      case 'textDocument/completion':
        // 官方出错时用自研；否则合并（官方排序在前，自研按 label 去重追加）
        mergedResult = officialError ? own ?? null : mergeCompletions(officialResult, Array.isArray(own) ? own : []);
        break;
      case 'textDocument/definition':
        mergedResult = officialError ? own ?? null : pickLocations(officialResult, Array.isArray(own) ? own : []);
        break;
      case 'textDocument/hover':
        mergedResult = officialError ? own ?? null : pickHover(officialResult, own);
        break;
      default:
        mergedResult = officialResult ?? own ?? null;
    }

    const response: JsonRpcMessage = { jsonrpc: '2.0', id, result: mergedResult ?? null };
    if (officialError && (own === null || own === undefined)) {
      response.result = null;
      response.error = officialError; // 双方都无结果时保留官方错误语义
    }
    this.sendToClient(response);
  }

  private setupWorkspace(msg: JsonRpcMessage): void {
    const params = (msg.params ?? {}) as any;
    let rootPath: string | undefined;
    if (typeof params.rootPath === 'string' && params.rootPath) {
      rootPath = params.rootPath;
    } else if (typeof params.rootUri === 'string' && params.rootUri) {
      try {
        rootPath = require('node:url').fileURLToPath(params.rootUri);
      } catch {
        rootPath = undefined;
      }
    } else if (Array.isArray(params.workspaceFolders) && params.workspaceFolders.length > 0) {
      try {
        rootPath = require('node:url').fileURLToPath(params.workspaceFolders[0].uri);
      } catch {
        rootPath = undefined;
      }
    }
    if (rootPath) this.engine.setWorkspace(rootPath);
  }
}

const VERSION = '0.3.0';
