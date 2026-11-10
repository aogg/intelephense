/**
 * Caps：initialize 响应的 serverCapabilities 合并（architecture.md §二）。
 * 规则：
 *  - 官方 true 且无自研对应 → 透传；
 *  - 官方 false/缺席 且自研已实现 → 覆盖为自研 provider；
 *  - 官方 false/缺席 且自研未实现 → 保持 false/缺席（诚实降级）；
 *  - positionEncoding 等协商字段不改写。
 * T2 自研已实现：foldingRange / selectionRange / documentLink（provider 声明）；
 * definition/hover/completion 走拦截合并，官方本就注册 true，无需改声明。
 * T3 起逐个落地：typeDefinition → implementation → declaration → typeHierarchy
 * → rename → codeAction（每项随功能 commit 翻牌为 true，未实现项维持 false，不虚假声明）。
 * codeLens/inlayHint 本阶段未实现 → 维持官方免费值（缺席），不虚假声明。
 */

export interface OwnFeatureSet {
  foldingRange: boolean;
  selectionRange: boolean;
  documentLink: boolean;
  typeDefinition: boolean;
  declaration: boolean;
  implementation: boolean;
  typeHierarchy: boolean;
  rename: boolean;
  codeAction: boolean;
}

export const OWN_FEATURES: OwnFeatureSet = {
  foldingRange: true,
  selectionRange: true,
  documentLink: true,
  typeDefinition: true,
  declaration: true,
  implementation: true,
  typeHierarchy: true,
  rename: true,
  codeAction: true,
};

/** 兼容别名：T2 时期的导出名 */
export const T2_OWN_FEATURES = OWN_FEATURES;

export function mergeCapabilities(officialCaps: Record<string, unknown>, own: OwnFeatureSet): Record<string, unknown> {
  const caps: Record<string, unknown> = { ...officialCaps };

  // 官方为 false 或缺席时才允许自研覆盖；官方 true（用户持 key 开了 premium）时按
  // architecture.md 默认「自研优先」原则仍由自研声明，行为与有无 key 一致。
  const override = (key: string, provider: unknown, implemented: boolean): void => {
    if (!implemented) return; // 诚实降级：保持官方值
    const officialValue = officialCaps[key];
    const officialActive = officialValue === true || (typeof officialValue === 'object' && officialValue !== null);
    if (!officialActive || typeof officialValue === 'boolean') caps[key] = provider;
  };

  override('foldingRangeProvider', {}, own.foldingRange);
  override('selectionRangeProvider', {}, own.selectionRange);
  override('documentLinkProvider', { resolveProvider: false }, own.documentLink);
  override('typeDefinitionProvider', true, own.typeDefinition);
  override('implementationProvider', true, own.implementation);
  override('declarationProvider', true, own.declaration);
  override('typeHierarchyProvider', true, own.typeHierarchy);
  override('renameProvider', { prepareProvider: true }, own.rename);
  override('codeActionProvider', { codeActionKinds: ['quickfix', 'source'], resolveProvider: true }, own.codeAction);

  return caps;
}

/** initialize 响应整体合并：capabilities + serverInfo 补充 */
export function mergeInitializeResponse(result: Record<string, unknown>, own: OwnFeatureSet, version: string): Record<string, unknown> {
  const officialCaps = (result.capabilities ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...result, capabilities: mergeCapabilities(officialCaps, own) };
  const officialServerInfo = result.serverInfo as Record<string, unknown> | undefined;
  merged.serverInfo = officialServerInfo ?? { name: 'intelephense-openidea', version };
  return merged;
}
