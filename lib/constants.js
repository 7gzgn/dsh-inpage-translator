/**
 * dsh-inpage-translator —— 常量与小工具（纯逻辑，不碰宿主）。
 *
 * 这里的东西都能单测：没有 DOM、没有网络、没有 ctx。
 *
 * @module dsh-inpage-translator/constants
 */

/** 插件名（宿主里的身份）。 */
export const PLUGIN_NAME = 'dsh-inpage-translator';

/** 浮层按钮根的 id（页面里唯一）。 */
export const ROOT_ID = 'dsh-ipt-root';

/** 给被翻译元素打的标（`<tag data-dsh-pt="12">`）。 */
export const NODE_ATTR = 'data-dsh-pt';

/** 不给浮层自己翻译的标记（按钮里的文字不能被当成页面内容）。 */
export const SKIP_ATTR = 'dsh-pt-skip';

/** 原始文本 / 译文 存在元素上的属性名。 */
export const ORIG_ATTR = 'data-dsh-pt-orig';
export const TRANS_ATTR = 'data-dsh-pt-trans';

/** 按钮上记录的请求状态：'' | 'pending' | 'translating' | 'ready' | 'error'。 */
export const REQ_ATTR = 'data-dsh-pt-req';

/** 按钮上记录的模式与目标语言（页面里读得到，便于插件侧回报）。 */
export const MODE_ATTR = 'data-dsh-pt-mode';
export const LANG_ATTR = 'data-dsh-pt-lang';

/** 页面视图（按钮）状态：default=没装 / idle / busy / done / error。 */
export const STATE_ATTR = 'data-dsh-pt-state';

/** 默认目标语言（用户是中文，默认译成中文）。 */
export const DEFAULT_TARGET = 'zh';

/** 支持的目标语言 → 给模型看的名字。 */
export const LANGUAGES = Object.freeze({
  zh: '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
});

/** 翻译模式。 */
export const MODES = Object.freeze({
  replace: '替换原文（默认）',
  bilingual: '原文下面补一行译文（双语对照）',
});

/** 默认值（每个都可在工具参数里覆盖）。 */
export const DEFAULTS = Object.freeze({
  target: DEFAULT_TARGET,
  mode: 'replace',
  /** 单次请求送进模型的字符上限（超出就丢弃多余部分并如实回报）。 */
  maxChars: 6000,
  /** 单个分块的字符上限。 */
  chunkChars: 2200,
  /** 单个分块里的节点数上限。 */
  chunkNodes: 40,
  /** 等用户点按钮的默认秒数。 */
  waitSec: 60,
  /** 模型单次调用的超时（毫秒）。 */
  llmTimeoutMs: 45000,
  /** 并发跑几个分块。 */
  concurrency: 2,
});

/** 译文输出的 token 上限（译文通常比原文短，留足余量）。 */
export const MAX_OUTPUT_TOKENS = 4096;

/**
 * 文本是否基本都是空白。
 * @param {string} text
 * @returns {boolean}
 */
export function isBlank(text) {
  return typeof text !== 'string' || text.trim() === '';
}

/**
 * 把空白压成单空格（送给模型前统一口径；不改页面里的原文）。
 * @param {string} text
 * @returns {string}
 */
export function squeeze(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 是否含中日韩字符 —— 用来判断"这段是不是已经不用译了"。
 * @param {string} text
 * @returns {boolean}
 */
export function hasCJK(text) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(String(text ?? ''));
}

/**
 * 这一条值不值得翻译：太短、纯数字、纯符号、纯 URL 都跳过。
 * @param {string} text 压过空白的文本
 * @param {number} [minLength]
 * @returns {boolean}
 */
export function looksTranslatable(text, minLength = 2) {
  const t = squeeze(text);
  if (t.length < minLength) return false;
  if (/^[\d\s\p{P}\p{S}]+$/u.test(t)) return false;
  if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return false;
  return /[A-Za-z\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t);
}

/**
 * 把一个长分块再切成不超过 limit 字符的小段（按句末/空格断，不硬切词）。
 * @param {string} text
 * @param {number} limit
 * @returns {string[]}
 */
export function splitLongText(text, limit) {
  const src = String(text ?? '');
  if (src.length <= limit) return src === '' ? [] : [src];
  const parts = [];
  let rest = src;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = -1;
    for (const mark of ['. ', '。', '! ', '！', '? ', '？', '; ', '；', ', ', '，', ' ']) {
      const at = window.lastIndexOf(mark);
      if (at > cut) cut = at + mark.length;
    }
    const hardFloor = Math.floor(limit * 0.6);
    if (cut < hardFloor) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim() !== '') parts.push(rest.trim());
  return parts.filter((p) => p !== '');
}

/**
 * 把节点分组：每块不超过 chunkChars 字符、chunkNodes 个节点。
 * 超长文本会先被 splitLongText 拆成多个"子节点"（沿用同一个 index，`part` 递增）。
 *
 * @param {Array<{index:number,text:string}>} nodes
 * @param {{chunkChars?:number,chunkNodes?:number,maxChars?:number}} [options]
 * @returns {{chunks:Array<{items:Array<{index:number,part:number,text:string}>}>, accepted:number, dropped:number, totalChars:number}}
 */
export function chunkNodes(nodes, options = {}) {
  const chunkChars = Math.max(200, Number(options.chunkChars) || DEFAULTS.chunkChars);
  const maxNodes = Math.max(1, Number(options.chunkNodes) || DEFAULTS.chunkNodes);
  const maxChars = Math.max(0, Number(options.maxChars) || DEFAULTS.maxChars);

  const items = [];
  let accepted = 0;
  let dropped = 0;
  let totalChars = 0;

  for (const node of Array.isArray(nodes) ? nodes : []) {
    const text = squeeze(node?.text);
    if (!looksTranslatable(text)) continue;
    const parts = splitLongText(text, chunkChars);
    for (let part = 0; part < parts.length; part += 1) {
      const piece = parts[part];
      if (maxChars > 0 && totalChars + piece.length > maxChars) {
        dropped += 1;
        continue;
      }
      items.push({ index: Number(node.index), part, text: piece });
      totalChars += piece.length;
      accepted += 1;
    }
  }

  const chunks = [];
  let current = { items: [] };
  let currentChars = 0;
  for (const item of items) {
    const tooBig = currentChars + item.text.length > chunkChars;
    const tooMany = current.items.length >= maxNodes;
    if (current.items.length > 0 && (tooBig || tooMany)) {
      chunks.push(current);
      current = { items: [] };
      currentChars = 0;
    }
    current.items.push(item);
    currentChars += item.text.length;
  }
  if (current.items.length > 0) chunks.push(current);

  return { chunks, accepted, dropped, totalChars };
}

/**
 * 拼一个分块给模型看的输入：编号列表（编号就是节点 index，模型要原样回）。
 * @param {{items:Array<{index:number,text:string}>}} chunk
 * @returns {string}
 */
export function renderChunkInput(chunk) {
  return (chunk?.items ?? [])
    .map((item) => `[${item.index}] ${item.text}`)
    .join('\n');
}

/**
 * 从模型回复里挖出 JSON 对象（可能被 ```json 围栏包着，或混在解释文字里）。
 * 策略：先剥围栏、再整体 parse、再退化成"第一个平衡括号块"。
 * @param {string} raw
 * @returns {object|null}
 */
export function extractJsonObject(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  const direct = tryParse(text);
  if (direct) return direct;

  const braced = firstBalancedObject(text);
  if (braced) {
    const parsed = tryParse(braced);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * 宽松解析：接受 {items:{...}} / {translations:{...}} / 裸 {index:text} 三种形状。
 * @param {object|null} parsed
 * @returns {Record<string,string>} index(字符串) → 译文
 */
export function normalizeTranslations(parsed) {
  if (parsed === null || typeof parsed !== 'object') return {};
  // 裸数组：模型有时候直接回 [{index,text}, …]
  if (Array.isArray(parsed)) return fromEntryList(parsed);
  const candidates = [parsed.items, parsed.translations, parsed.result, parsed.data];
  let bag = null;
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      bag = Array.isArray(candidate) ? fromEntryList(candidate) : candidate;
      break;
    }
  }
  if (bag === null) bag = parsed;

  const out = {};
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value === 'string') out[String(key)] = value;
    else if (value && typeof value === 'object') {
      const text = value.text ?? value.translation ?? value.t;
      if (typeof text === 'string') out[String(key)] = text;
    }
  }
  return out;
}

/**
 * 内部：[{index,text}, …] → {index: text}
 * @param {Array<object>} list
 * @returns {Record<string,string>}
 */
function fromEntryList(list) {
  const out = {};
  for (const entry of list) {
    const index = entry?.index ?? entry?.id ?? entry?.i;
    const text = entry?.text ?? entry?.translation ?? entry?.t ?? entry?.value;
    if (index === undefined || typeof text !== 'string') continue;
    out[String(index)] = text;
  }
  return out;
}

/**
 * 把「模型产出的译文表」对齐回节点：产出里缺的 index 会用原值兜底（不做静默丢失）。
 * @param {Record<string,string>} table
 * @param {Array<{index:number,orig:string,part:number,parts:number}>} nodes
 * @returns {{applied:Array<{index:number,text:string,orig:string}>, missing:number[], unchanged:number[]}}
 */
export function alignTranslations(table, nodes) {
  const applied = [];
  const missing = [];
  const unchanged = [];
  const byIndex = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const list = byIndex.get(node.index) ?? [];
    list.push(node);
    byIndex.set(node.index, list);
  }
  for (const [key, list] of byIndex) {
    const translated = table?.[key];
    if (typeof translated !== 'string' || translated.trim() === '') {
      missing.push(Number(key));
      continue;
    }
    const target = list[0];
    if (translated === target.orig) unchanged.push(Number(key));
    applied.push({ index: Number(key), text: translated, orig: target.orig });
  }
  return { applied, missing, unchanged };
}

/**
 * 拼给模型的提示词（一个分块一次调用）。
 * @param {{items:Array<{index:number,text:string}>}} chunk
 * @param {{target:string}} options
 * @returns {{system:string,user:string}}
 */
export function buildPrompt(chunk, options) {
  const language = LANGUAGES[options?.target] ?? LANGUAGES[DEFAULTS.target];
  const system = [
    `你是网页整页翻译引擎。把用户给你的每一行译成${language}。`,
    '规则（必须全部遵守）：',
    '1. 只输出一个 JSON 对象，形如 {"1":"译文","2":"译文"}，键就是行首方括号里的编号（原样字符串），值是译文。',
    '2. 逐行一一对应：给了 N 行就必须回 N 个键，不许合并、拆分、增删、漏行。',
    '3. 只翻译，不要解释、不要加任何前后缀文字、不要用 markdown 代码围栏。',
    '4. 已经是目标语言的行，原样返回（不要改写）。',
    '5. 专有名词、产品名、代码、变量名、URL、邮箱、数字与单位保持原样。',
    '6. 保留标点风格；译文要通顺自然，别逐字硬译。',
    '7. 行内如果有 HTML 标签或占位符，原样保留其位置。',
  ].join('\n');
  const user = renderChunkInput(chunk);
  return { system, user };
}

/** 内部：JSON.parse 的容错包装。 */
function tryParse(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 内部：找第一段括号平衡的 {...}（跳过字符串里的括号）。 */
function firstBalancedObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
