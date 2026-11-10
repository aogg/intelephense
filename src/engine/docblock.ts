/**
 * engine/docblock.ts：自研轻量 docblock 解析器（正则 + 缩进对齐，无第三方依赖）。
 * 抽取标签：@var / @property[-read|-write] / @mixin / @method / @return / @param / @throws / @see / @inheritDoc
 */

export interface DocVar {
  type: string;
  name?: string;
}
export interface DocProperty {
  type: string;
  name: string; // 不含 $
  read: boolean;
  write: boolean;
}
export interface DocMixin {
  type: string;
  alias?: string;
}
export interface DocMethod {
  static: boolean;
  type?: string;
  name: string;
  params: string;
}
export interface DocblockInfo {
  raw: string;
  summary: string;
  vars: DocVar[];
  properties: DocProperty[];
  mixins: DocMixin[];
  methods: DocMethod[];
  returns: string[];
  params: DocVar[];
  throws: string[];
  see: string[];
  inheritDoc: boolean;
}

export function parseDocblock(rawText: string): DocblockInfo {
  const info: DocblockInfo = {
    raw: rawText,
    summary: '',
    vars: [],
    properties: [],
    mixins: [],
    methods: [],
    returns: [],
    params: [],
    throws: [],
    see: [],
    inheritDoc: false,
  };
  // 去 /** */ 与行首 * 前缀
  const lines = rawText
    .replace(/^\/\*\*/, '')
    .replace(/\*\/\s*$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trimEnd());

  const proseLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('@')) {
      parseTag(trimmed, info);
    } else if (proseLines.length === 0 && info.vars.length === 0) {
      proseLines.push(trimmed);
    }
  }
  info.summary = proseLines.join(' ').trim();
  return info;
}

function parseTag(line: string, info: DocblockInfo): void {
  // @tag 后的全部内容（可能有内联 {Type} 形式）
  const m = /^@([\w-]+)\s+(.*)$/.exec(line) ?? /^@([\w-]+)$/.exec(line);
  if (!m) return;
  const tag = m[1].toLowerCase();
  let rest = (m[2] ?? '').trim();
  rest = rest.replace(/^\{([^}]*)\}\s*/, '$1 ').trim(); // {@var Type} → Type

  switch (tag) {
    case 'var': {
      const vm = /^([\s\S]*?)(?:\s+(\$\w+))?$/.exec(rest);
      if (vm) info.vars.push({ type: vm[1].trim(), name: vm[2] ? vm[2].slice(1) : undefined });
      break;
    }
    case 'property':
    case 'property-read':
    case 'property-write': {
      const pm = /^(\S+)\s+\$(\w+)\s*$/.exec(rest);
      if (pm) {
        info.properties.push({
          type: pm[1],
          name: pm[2],
          read: tag !== 'property-write',
          write: tag !== 'property-read',
        });
      }
      break;
    }
    case 'mixin': {
      const mm = /^(\S+)(?:\s+(\$\w+|\w+))?$/.exec(rest);
      if (mm) info.mixins.push({ type: mm[1], alias: mm[2] ? mm[2].replace(/^\$/, '') : undefined });
      break;
    }
    case 'method': {
      const sm = /^(static\s+)?([\w\\|?[\]<>,\s]+?)\s+(\w+)\s*\(([^)]*)\)/.exec(rest);
      if (sm) info.methods.push({ static: !!sm[1], type: sm[2].trim(), name: sm[3], params: sm[4] });
      else {
        const nm = /^(static\s+)?(\w+)\s*\(([^)]*)\)/.exec(rest);
        if (nm) info.methods.push({ static: !!nm[1], name: nm[2], params: nm[3] });
      }
      break;
    }
    case 'return':
      if (rest) info.returns.push(rest.split(/\s{2,}|\s+\S.*$/)[0].trim() || rest);
      break;
    case 'param': {
      const pm = /^(\S+)\s+\$(\w+)/.exec(rest);
      if (pm) info.params.push({ type: pm[1], name: pm[2] });
      break;
    }
    case 'throws':
      info.throws.push(rest.split(/\s+/)[0]);
      break;
    case 'see':
      info.see.push(rest);
      break;
    case 'inheritdoc':
      info.inheritDoc = true;
      break;
    default:
      break;
  }
}

/** 便捷取首个 @var 类型（属性 docblock A 通道） */
export function firstVarType(info: DocblockInfo | undefined): string | undefined {
  return info && info.vars.length > 0 ? info.vars[0].type : undefined;
}
