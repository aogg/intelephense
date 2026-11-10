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

interface PendingMerged {
  method: string;
  ownPromise: Promise<unknown>;
}

export class Router {
  /** id → 待合并的自研结果（官方响应回来时取用） */
  private pendingMerged = new Map<number | string, PendingMerged>();
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
        this.pendingMerged.set(id as number, { method, ownPromise: this.computeOwn(method, msg) });
        this.sendToServer(msg);
        return;
      }
      if (method === 'initialize') {
        this.setupWorkspace(msg);
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

    // initialize 响应：能力合并 + serverInfo
    if (id !== undefined && !('method' in msg) && (msg.result || msg.error)) {
      const pending = this.pendingMerged.get(id as number);
      if (!pending && this.isInitializeResponse(msg)) {
        const result = (msg.result ?? {}) as Record<string, unknown>;
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

    // 其余一切（publishDiagnostics、window/*、registerCapability 等）原样转发，绝不过滤
    this.sendToClient(msg);
  }

  private isInitializeResponse(msg: JsonRpcMessage): boolean {
    return true; // pendingMerged 未命中且带 result 的响应只可能是 initialize（首个请求）
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
    let own: unknown = null;
    try {
      own = await pending.ownPromise;
    } catch {
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
