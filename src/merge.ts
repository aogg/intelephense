/**
 * merge.ts：双引擎结果合并去重。
 * - completion：官方 + 自研合并；同 label+kind 时以自研 detail/documentation 富化官方项
 *   （保留官方 data/textEdit 供 resolve 使用）；官方没有的项自研追加；
 * - hover/definition：自研高置信结果存在时自研优先，否则透传官方（auth 案例关键路径）。
 */

export function mergeCompletions(official: unknown, own: unknown[]): unknown {
  const ownItems = Array.isArray(own) ? own : [];
  if (ownItems.length === 0) return official;
  const officialItems: unknown[] = Array.isArray(official)
    ? official
    : official && typeof official === 'object' && Array.isArray((official as { items?: unknown[] }).items)
      ? (official as { items: unknown[] }).items
      : [];
  const keyOf = (item: unknown): string => {
    const it = item as { label?: string; kind?: number };
    return `${it.label ?? ''}#${it.kind ?? ''}`;
  };
  const ownByKey = new Map<string, Record<string, unknown>>();
  for (const it of ownItems) ownByKey.set(keyOf(it), it as Record<string, unknown>);

  // 自研优先：官方项若与自研同 key，用自研 detail/documentation 富化（保留官方 data/textEdit）
  const enriched = officialItems.map((it) => {
    const own = ownByKey.get(keyOf(it));
    if (!own || typeof it !== 'object' || it === null) return it;
    const merged = { ...(it as Record<string, unknown>) };
    if (typeof own.detail === 'string') merged.detail = own.detail;
    if (own.documentation !== undefined) merged.documentation = own.documentation;
    if (own.sortText !== undefined) merged.sortText = own.sortText;
    return merged;
  });

  const seen = new Set(officialItems.map(keyOf));
  const extra = ownItems.filter((it) => !seen.has(keyOf(it)));
  if (Array.isArray(official)) return [...enriched, ...extra];
  if (official && typeof official === 'object') {
    return {
      ...(official as Record<string, unknown>),
      items: [...enriched, ...extra],
      isIncomplete: (official as { isIncomplete?: boolean }).isIncomplete ?? false,
    };
  }
  return ownItems;
}

/** definition 类：自研非空优先 */
export function pickLocations(official: unknown, own: unknown[]): unknown {
  if (own.length > 0) return own;
  return official;
}

/** hover：自研非空优先 */
export function pickHover(official: unknown, own: unknown): unknown {
  return own ?? official;
}
