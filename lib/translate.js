/**
 * dsh-inpage-translator —— 翻译编排（宿主侧）。
 *
 * 只做三件事：把节点切成块 → 调宿主的 LLM 服务逐块翻 → 把译文对齐回标号。
 * 所有网络/模型细节都藏在 `ctx.get('llm')` 后面 —— 插件自己**不碰任何 API key**。
 *
 * 调用形状照抄宿主里已验证的两个先例（`dsh-meme` 的识图、`dsh-better-sidebar` 的提交信息）：
 *   `llm.resolveCallConfig(...)` → `llm.prepareCall(...)` → `prepared.stream({...})`
 * 直接 `llm.stream()` 在没 materialize 默认配置时会报「prepared LLM call config changed」。
 *
 * @module dsh-inpage-translator/translate
 */

import {
  DEFAULT_TARGET,
  DEFAULTS,
  MAX_OUTPUT_TOKENS,
  alignTranslations,
  buildPrompt,
  chunkNodes,
  extractJsonObject,
  normalizeTranslations,
  squeeze,
} from './constants.js';

/**
 * 给模型用的一句话（可被插件配置覆盖）。
 * @typedef {object} TranslateOptions
 * @property {string} [target] 目标语言（zh/en/ja/ko/ru）
 * @property {number} [maxChars] 本次最多送多少字符进模型
 * @property {number} [chunkChars] 单个分块字符上限
 * @property {number} [chunkNodes] 单个分块节点数上限
 * @property {number} [concurrency] 并发块数（默认 1：省钱、好限流）
 * @property {number} [llmTimeoutMs] 单块超时
 * @property {string} [provider] 覆盖 provider（默认交给宿主默认模型）
 * @property {string} [model] 覆盖 model
 * @property {{provider:string,model:string}} [route] 已解析的模型路线（由 resolveRoute 得到）
 */

/**
 * 解析这次该用哪个 provider/model 路线。
 *
 * ① 调用方显式给的 provider/model；
 * ② 宿主的默认模型选择：settings 命名空间 `agent-default-model`，
 *    服务名 `ctx.get('agentDefaultModel')` → `currentSelection()`；
 * ③ 都没有 → **明确报错**（绝不瞎猜 —— 否则会撞上
 *    `no adapter registered for provider "undefined"`）。
 *
 * @param {object} ctx
 * @param {{provider?:string,model?:string}} [request]
 * @returns {{provider:string,model:string,source:string}}
 */
export function resolveRoute(ctx, request = {}) {
  const explicitProvider = typeof request.provider === 'string' ? request.provider.trim() : '';
  const explicitModel = typeof request.model === 'string' ? request.model.trim() : '';
  if (explicitProvider !== '' && explicitModel !== '') {
    return { provider: explicitProvider, model: explicitModel, source: 'explicit' };
  }
  let selection = null;
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined;
    if (service && typeof service.currentSelection === 'function') selection = service.currentSelection();
  } catch {
    selection = null;
  }
  const provider = typeof selection?.provider === 'string' ? selection.provider.trim() : '';
  const model = typeof selection?.model === 'string' ? selection.model.trim() : '';
  if (provider !== '' && model !== '') return { provider, model, source: 'agent-default-model' };
  const error = new Error(
    '解析不出要用的模型：调用方没给 provider/model，宿主也没暴露默认模型（ctx.get("agentDefaultModel")）—— 请显式传 provider 与 model',
  );
  error.code = 'no-model-route';
  throw error;
}

/**
 * 取宿主的 LLM 服务，拿不到就抛一个**说得清**的错。
 * @param {object} ctx
 * @returns {object}
 */
export function llmOf(ctx) {
  const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
  if (llm === null || llm === undefined) {
    const error = new Error('宿主没有提供 LLM 服务（ctx.get("llm") 为空），无法翻译');
    error.code = 'llm-unavailable';
    throw error;
  }
  return llm;
}

/**
 * 把模型返回的文本块拼起来（只取 text-delta；reasoning-delta 不参与翻译结果）。
 * @param {object} prepared
 * @param {object} base
 * @param {string} system
 * @param {string} user
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
async function streamOnce(prepared, base, system, user, timeoutMs) {
  let text = '';
  let failure = null;
  const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
  try {
    for await (const chunk of prepared.stream({
      ...base,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      system,
      ...(signal ? { signal } : {}),
    })) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        failure = chunk.reason.failure ?? chunk.reason;
      }
    }
  } catch (error) {
    if (error && error.name === 'AbortError') return text;
    throw error;
  }
  text = text.trim();
  if (text === '' && failure) throw new Error('模型调用失败：' + (failure.message ?? JSON.stringify(failure)));
  return text;
}

/**
 * 字符串级译文缓存（按 llm 实例分开：单测每次新建假 llm，天然互不污染）。
 * 进程内有效，重启即空 —— 不做持久化，避免把用户看过的页面内容写进磁盘。
 */
const CACHE_LIMIT = 4000;
const cacheByLlm = new WeakMap();

/**
 * 取（或建）某个 llm 实例的缓存表。
 * @param {object} llm
 * @returns {Map<string,string>|null}
 */
function cacheFor(llm) {
  if (llm === null || typeof llm !== 'object') return null;
  let map = cacheByLlm.get(llm);
  if (!map) {
    map = new Map();
    cacheByLlm.set(llm, map);
  }
  return map;
}

/**
 * 缓存键：目标语言 + 原文（同一串换目标语言当然要重翻）。
 * @param {string} target
 * @param {string} text
 * @returns {string}
 */
function cacheKey(target, text) {
  return `${target}\u0000${text}`;
}

/**
 * 清空缓存（同一 llm 实例）。测试与排查用。
 * @param {object} [llm]
 */
export function clearTranslationCache(llm) {
  if (llm) cacheByLlm.delete(llm);
}

/**
 * 写缓存（带 LRU 上限：超过就丢最旧的一条）。
 * @param {Map<string,string>|null} map
 * @param {string} target
 * @param {string} text
 * @param {string} value
 */
function remember(map, target, text, value) {
  if (!map || typeof value !== 'string' || value.trim() === '') return;
  const key = cacheKey(target, text);
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_LIMIT) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

/**
 * 本次送翻的字符上限：显式给了正数就照办；否则按页面唯一文本量自适应。
 * @param {object} opts
 * @param {number} uniqueChars
 * @returns {number}
 */
function resolveCharCap(opts, uniqueChars) {
  const explicit = Number(opts.maxChars);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const min = Math.max(500, Number(opts.adaptiveMinChars) || DEFAULTS.adaptiveMinChars);
  const max = Math.max(min, Number(opts.adaptiveMaxChars) || DEFAULTS.adaptiveMaxChars);
  return Math.max(min, Math.min(max, Math.ceil(uniqueChars * 1.2)));
}

/**
 * 把「唯一串编号 → 译文」摊回页面标号。
 * @param {Record<string,string>|Map<string,string>} table
 * @param {Map<string,number[]>} indexMap
 * @returns {Record<string,string>}
 */
function expandTranslations(table, indexMap) {
  const translations = {};
  const entries = typeof table?.entries === 'function' ? [...table.entries()] : Object.entries(table ?? {});
  for (const [key, value] of entries) {
    const indexes = indexMap.get(String(key));
    if (!indexes) continue;
    for (const index of indexes) translations[String(index)] = value;
  }
  return translations;
}

/**
 * 翻译一批文本（纯函数式：不碰 ctx，除 llm）。
 *
 * 两份提速，都不改变"翻什么"：
 *   ① **字符串级缓存**：同一个 llm 实例翻过的串不再请求（同页翻第二次几乎瞬时）；
 *   ② **分块并行**：`concurrency` 块同时跑（默认 3，token 花销不变，只是不排队）。
 *
 * @param {object} llm 宿主 LLM 服务
 * @param {Array<{index:number,text:string}>} rawNodes 从页面收集到的可译节点
 * @param {TranslateOptions} [options]
 * @returns {Promise<{translations:Record<string,string>, stats:object, warnings:string[]}>}
 */
export async function translateNodes(llm, rawNodes, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const warnings = [];

  // 相同的字符串只翻一次（页面里重复的菜单/按钮很常见），再映射回每个标号。
  const unique = new Map();
  for (const node of Array.isArray(rawNodes) ? rawNodes : []) {
    const text = squeeze(node?.text);
    if (text === '') continue;
    const index = Number(node.index);
    if (!Number.isFinite(index)) continue;
    if (!unique.has(text)) unique.set(text, []);
    unique.get(text).push(index);
  }
  const deduped = [...unique.entries()].map(([text, indexes], position) => ({ index: position, text, indexes }));
  const indexMap = new Map(deduped.map((entry) => [String(entry.index), entry.indexes]));

  // 缓存：同一个 llm 实例在进程内共享。命中的串直接跳过模型。
  const cache = options.cache === false ? null : cacheFor(llm);
  const reused = new Map();
  const misses = [];
  for (const entry of deduped) {
    const hit = cache ? cache.get(cacheKey(opts.target, entry.text)) : undefined;
    if (typeof hit === 'string' && hit.trim() !== '') reused.set(entry.index, hit);
    else misses.push(entry);
  }

  const uniqueChars = deduped.reduce((sum, entry) => sum + entry.text.length, 0);
  const cap = resolveCharCap(opts, uniqueChars);
  const { chunks, accepted, dropped, totalChars } = chunkNodes(
    misses.map((entry) => ({ index: entry.index, text: entry.text })),
    { ...opts, maxChars: cap },
  );
  if (dropped > 0) {
    warnings.push(
      `超出本次字符上限（${cap}${Number(opts.maxChars) > 0 ? '' : '，按页面自适应'}），有 ${dropped} 段没有送翻`,
    );
  }

  if (chunks.length === 0) {
    return {
      translations: expandTranslations(reused, indexMap),
      stats: {
        chunks: 0,
        accepted: 0,
        dropped,
        chars: 0,
        charsTotal: uniqueChars,
        cap,
        unique: deduped.length,
        cached: reused.size,
        calls: 0,
        salvaged: 0,
      },
      warnings,
    };
  }

  const resolved = await resolvePrepared(llm, opts);

  /** 单块：失败返回 {}（不炸整轮），并把原因记进 warnings。 */
  async function runChunk(chunk) {
    const { system, user } = buildPrompt(chunk, opts);
    let raw = '';
    try {
      raw = await streamOnce(resolved.prepared, resolved.base, system, user, opts.llmTimeoutMs);
    } catch (error) {
      warnings.push('模型调用出错：' + String((error && error.message) || error));
      return {};
    }
    const parsed = extractJsonObject(raw);
    if (parsed === null) {
      warnings.push('模型没有返回可解析的 JSON（该块按原文处理）');
      return {};
    }
    return normalizeTranslations(parsed);
  }

  const tables = [];
  const concurrency = Math.max(1, Math.min(4, Number(opts.concurrency) || 1));
  for (let start = 0; start < chunks.length; start += concurrency) {
    const slice = chunks.slice(start, start + concurrency);
    // 默认 3 块并行：token 花销与串行一样，只是不排队等上一块。
    const results = await Promise.all(slice.map((chunk) => runChunk(chunk)));
    for (const table of results) tables.push(table);
  }

  // 合并：先铺缓存命中的，再用模型这一轮的结果覆盖。
  const merged = {};
  for (const [index, value] of reused) merged[String(index)] = value;
  for (const table of tables) Object.assign(merged, table);

  // 把这一轮真正翻出来的串写进缓存（只缓存成功且非空的）。
  if (cache) {
    for (const entry of misses) remember(cache, opts.target, entry.text, merged[String(entry.index)]);
  }

  const translations = expandTranslations(merged, indexMap);

  // 统计：有多少条被"兜底"（模型没给 / 给空）
  let salvaged = 0;
  for (const entry of deduped) {
    if (typeof merged[String(entry.index)] !== 'string' || merged[String(entry.index)].trim() === '') salvaged += 1;
  }

  return {
    translations,
    stats: {
      chunks: chunks.length,
      accepted,
      dropped,
      chars: totalChars,
      charsTotal: uniqueChars,
      cap,
      unique: deduped.length,
      cached: reused.size,
      calls: chunks.length,
      salvaged,
    },
    warnings,
  };
}

/**
 * 把「送翻的节点」与「模型产出」对齐（给测试与回执用）。
 * @param {Record<string,string>} table
 * @param {Array<{index:number,orig:string}>} nodes
 */
export function alignResult(table, nodes) {
  return alignTranslations(table, nodes);
}

/**
 * 解析出可直接 stream 的调用配置。
 * @param {object} llm
 * @param {TranslateOptions & {maxTokens?:number, route?:{provider:string,model:string}}} opts
 * @returns {Promise<{base:object,prepared:object}>}
 */
async function resolvePrepared(llm, opts) {
  if (typeof llm.resolveCallConfig !== 'function') {
    const error = new Error('宿主 LLM 服务缺少 resolveCallConfig —— 版本不兼容');
    error.code = 'llm-incompatible';
    throw error;
  }
  if (!opts.route || !opts.route.provider || !opts.route.model) {
    const error = new Error('翻译需要一条已解析的模型路线（route.provider / route.model）');
    error.code = 'no-model-route';
    throw error;
  }
  const requested = { maxTokens: MAX_OUTPUT_TOKENS, provider: opts.route.provider, model: opts.route.model };
  const base = await llm.resolveCallConfig(requested);
  const prepared = typeof llm.prepareCall === 'function' ? await llm.prepareCall(base) : { stream: (request) => llm.stream(request) };
  return { base, prepared };
}

/**
 * 目标语言是否"已经就是它"（用于跳过 —— 例如中文页面译中文时给个准话）。
 * @param {string} target
 * @returns {string}
 */
export function targetName(target) {
  return target || DEFAULT_TARGET;
}
