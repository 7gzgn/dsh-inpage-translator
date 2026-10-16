/**
 * dsh-inpage-translator —— 宿主入口。
 *
 * 一句话：**你把页面给 agent 看，它替你把整页翻成中文** —— 往页面里放一个浮层按钮，
 * 点一下，页面上每一个可见文本节点原地换成译文，再点一下回到原文。
 *
 * 三条设计取舍（都是被现场逼出来的）：
 *   1. **不碰原生工具栏**：内置浏览器的工具栏是宿主硬编码的 HTML，第三方插件没有扩展点
 *      （`dsh-builtin-browser/host-main.js:123` 的 TOOLBAR_HTML，宿主不读任何外部字段）。
 *      所以按钮做成页面内的浮层 —— 零宿主改动，导航后在下次调用时重装。
 *   2. **翻译走宿主的 LLM 服务**（`ctx.get('llm')`）：插件自己不持有、不读取任何 API key。
 *   3. **按钮点击 → 插件处理**：页面里没有 bridge，所以按钮只写一个请求标记，
 *      由插件轮询读到后去翻译（`action='install'` 会替用户等着这一次点击）。
 *
 * @module dsh-inpage-translator
 */

import {
  DEFAULT_TARGET,
  DEFAULTS,
  LANGUAGES,
  MODES,
  PLUGIN_NAME,
} from './constants.js';
import { installScript, parsePageReport } from './page-script.js';
import { translateNodes } from './translate.js';

/** 插件身份。 */
export const name = PLUGIN_NAME;

/** 需要宿主注入的服务（browser / llm 都用 ctx.get 取 —— 取不到就给明确错误，不让插件加载失败）。 */
export const inject = ['tools', 'systemPrompt'];

const SECTION_ORDER = 214;
const TOOL_TIMEOUT_MS = 240000;
/** 轮询间隔：等用户点按钮时每 1.2 秒看一次页面。 */
const POLL_MS = 1200;

/** 面向模型的公告（常驻那一段）。 */
export const INPAGE_TRANSLATOR_GUIDANCE = [
  '本机已安装 **dsh-inpage-translator（整页翻译）**：提供 `translate_page` —— 往内置浏览器的当前页面放一个浮层按钮（右下角「🈯 译」），点一下就把**页面上每一个可见文本节点原地换成译文**，再点一下回到原文。',
  '动作：`install`（装按钮并**替用户等着这一次点击**，默认等 60 秒，点了就翻）、`translate`（不等，立刻翻）、`restore`（回到原文）、`status`（只读状态）。',
  '典型用法：`translate_page(action:"install")` → 用户点按钮 → 同一次调用里就翻好了；之后用户再点就是切回原文（插件下一次 `status` 就能看到）。',
  '参数：`target`（zh 默认 / en / ja / ko / ru）、`mode`（replace 替换原文（默认）| bilingual 原文下补一行译文）、`maxChars`（本次送翻的字符上限，默认 6000，超出部分如实回报）、`waitSec`（install 等点击的秒数）、`session`（复用别的浏览器会话，默认用自己的）。',
  '**它不碰页面结构以外的任何东西**：只改文本、只加内联样式（绕开页面 CSP），不注入 `<style>`、不发请求、不上传内容；译文由本机 DSH 的模型服务生成，插件自己不持有任何 API key。',
  '**限制（先说清）**：① 按钮是页面内浮层，不是浏览器原生工具栏（宿主不给第三方加工具栏按钮的扩展点）；② **导航到新页面后按钮会消失**，再调一次 `translate_page` 即可重装；③ 跨域 iframe 里的文字翻不到；④ 只翻可见文本节点，图片不处理。',
].join('\n');

/** 动态取 defineTool：宿主里有就用真的，单测场景退化成恒等。 */
let defineTool = (def) => def;
try {
  const mod = await import('@deepseek-ai/dsh-tools');
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool;
} catch {
  /* 宿主外运行 */
}

/**
 * 取浏览器服务（照官方姿势：`ctx.get('browser')`，拿不到就是 undefined）。
 * @param {object} ctx
 * @returns {object|null}
 */
export function browserOf(ctx) {
  try {
    const browser = typeof ctx?.get === 'function' ? ctx.get('browser') : undefined;
    if (browser && typeof browser.open === 'function' && typeof browser.execute === 'function') return browser;
  } catch {
    /* 没有浏览器插件：当作没有 */
  }
  return null;
}

/**
 * 在页面里跑一次脚本，并把页面回报解析出来。
 * @param {object} browser
 * @param {object} session
 * @param {object} request 页面侧请求（install / translate / restore / error）
 * @param {number} [timeoutMs]
 * @returns {Promise<object>} 页面回报
 */
async function runInPage(browser, session, request, timeoutMs = 30000) {
  const result = await browser.execute(session, {
    script: installScript(),
    args: [JSON.stringify(request ?? {})],
    timeoutMs,
  });
  if (result && result.ok === false) {
    throw new Error('页面脚本执行失败：' + String(result.exception ?? result.error ?? 'unknown'));
  }
  const report = parsePageReport(result && 'value' in result ? result.value : result);
  if (!report) throw new Error('页面没有回报可解析的结果（可能页面已关闭或脚本被 CSP 拦下）');
  if (report.ok === false) throw new Error('页面侧报错：' + String(report.error ?? 'unknown'));
  return report;
}

/**
 * 取（或开）一个会话。默认用插件自己的会话键，保证按钮状态跨调用不丢。
 * @param {object} browser
 * @param {string|undefined} sessionKey
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function openSession(browser, sessionKey, options = {}) {
  const key = typeof sessionKey === 'string' && sessionKey.trim() !== '' ? sessionKey.trim() : PLUGIN_NAME;
  try {
    const session = await browser.open(key);
    if (session) return session;
  } catch (error) {
    throw new Error(`打不开浏览器会话「${key}」：${String((error && error.message) || error)}`);
  }
  throw new Error(`打不开浏览器会话「${key}」`);
}

/**
 * 把一次「用户点了按钮」处理完：收集 → 翻译 → 回填。
 * @param {object} browser
 * @param {object} session
 * @param {object} report 上一次页面回报
 * @param {{target:string,mode:string,maxChars:number,llm:object,llmOptions:object}} context
 * @returns {Promise<object>} 本次处理结果
 */
async function handleClick(browser, session, report, context) {
  const collect = await runInPage(browser, session, { action: 'collect' });
  const nodes = Array.isArray(collect.nodes) ? collect.nodes : [];
  let translation = { translations: {}, stats: null, warnings: [] };
  if (nodes.length > 0) {
    translation = await translateNodes(context.llm, nodes, {
      target: context.target,
      maxChars: context.maxChars,
      ...context.llmOptions,
    });
  }
  const applied = await runInPage(browser, session, {
    action: 'translate',
    target: context.target,
    mode: context.mode,
    translations: translation.translations,
  });
  return { collected: nodes.length, report: applied, translation };
}

/**
 * 干活的主循环：先看页面状态，再决定"翻 / 还原 / 继续等用户点"。
 * @param {object} browser
 * @param {object} session
 * @param {object} args 工具参数
 * @param {object} llm
 * @returns {Promise<object>} 给工具用的结果对象
 */
async function drive(browser, session, args, llm) {
  const target = typeof args.target === 'string' && LANGUAGES[args.target] ? args.target : DEFAULT_TARGET;
  const mode = typeof args.mode === 'string' && MODES[args.mode] ? args.mode : DEFAULTS.mode;
  const maxChars = Number.isFinite(args.maxChars) ? Math.max(0, Number(args.maxChars)) : DEFAULTS.maxChars;
  const action = String(args.action ?? 'install').trim().toLowerCase();
  const llmOptions = {};
  if (typeof args.provider === 'string' && args.provider !== '') llmOptions.provider = args.provider;
  if (typeof args.model === 'string' && args.model !== '') llmOptions.model = args.model;

  const context = { target, mode, maxChars, llm, llmOptions };

  // ---- 只读：会话自证（列标签 + 读页面标志），用来回答"插件到底在看哪张页面" ----
  if (action === 'status') {
    let tabs = null;
    let probe = null;
    try {
      if (typeof browser.listTabs === 'function') tabs = await browser.listTabs(session);
    } catch (error) {
      tabs = 'listTabs failed: ' + String((error && error.message) || error);
    }
    try {
      probe = await runInPage(browser, session, { action: 'probe' });
    } catch (error) {
      probe = 'probe failed: ' + String((error && error.message) || error);
    }
    return {
      ok: true,
      action: 'status',
      state: probe && probe.state ? probe.state : 'unknown',
      total: probe && typeof probe.total === 'number' ? probe.total : 0,
      translated: probe && typeof probe.already === 'number' ? probe.already : 0,
      tabs,
      probe,
    };
  }

  const first = await runInPage(browser, session, { action: 'install', target, mode });

  // ---- 还原 ----
  if (action === 'restore') {
    const back = await runInPage(browser, session, { action: 'restore', label: '译' });
    return { ok: true, action: 'restore', restored: back.restored ?? 0, state: back.state };
  }

  // ---- 立即翻 ----
  if (action === 'translate') {
    const handled = await handleClick(browser, session, first, context);
    return {
      ok: true,
      action: 'translate',
      target,
      mode,
      collected: handled.collected,
      applied: handled.report.already ?? handled.collected,
      total: handled.report.total ?? 0,
      stats: handled.translation.stats,
      warnings: handled.translation.warnings,
      state: handled.report.state,
    };
  }

  if (action !== 'install') {
    return { ok: false, action, error: `unknown action: ${action}` };
  }

  // ---- install：装好按钮，并替用户等着这一次点击 ----
  const waitSec = Number.isFinite(args.waitSec) ? Math.max(0, Math.min(600, Number(args.waitSec))) : DEFAULTS.waitSec;
  const deadline = Date.now() + waitSec * 1000;
  let report = first;
  let waited = 0;
  let timedOut = waitSec > 0;

  while (waitSec > 0 && Date.now() < deadline) {
    if (report.state === 'done' && report.request !== 'restore') {
      // 用户上一轮翻译完又点了回来 —— 这一次不翻译，只还原。
      const back = await runInPage(browser, session, { action: 'restore', label: '译' });
      return { ok: true, action: 'restore', restored: back.restored ?? 0, state: back.state, waitedMs: waited };
    }
    const pending = report.request === 'pending' || report.state === 'busy';
    if (pending) {
      const handled = await handleClick(browser, session, report, context);
      return {
        ok: true,
        action: 'translate',
        triggered: 'button-click',
        waitedMs: waited,
        target,
        mode,
        collected: handled.collected,
        applied: handled.report.already ?? handled.collected,
        total: handled.report.total ?? 0,
        stats: handled.translation.stats,
        warnings: handled.translation.warnings,
        state: handled.report.state,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    waited += POLL_MS;
    report = await runInPage(browser, session, { action: 'inspect' });
    timedOut = true;
  }

  return {
    ok: true,
    action: 'install',
    installed: true,
    waitedMs: waited,
    timedOut,
    target,
    mode,
    total: report.total ?? 0,
    before: 0,
    translated: report.already ?? 0,
    state: report.state,
  };
}

/** 把结果压成给模型看的一段话。 */
function renderText(value) {
  if (value.ok === false) return `translate_page 失败：${String(value.error ?? '未知错误')}`;
  switch (value.action) {
    case 'install': {
      const waited = Math.round((value.waitedMs ?? 0) / 1000);
      const lines = [
        `🈯 翻译按钮已就位${value.timedOut ? '（等了一会儿，还没人点）' : ''}`,
        `  页面可译节点：${value.total} 个｜已译：${value.translated} 个｜状态：${value.state}`,
        value.timedOut
          ? `  已等 ${waited} 秒 —— 用户还没点按钮。可以再调一次 \`translate_page(action:"install")\` 继续等，或 \`action:"translate"\` 直接翻。`
          : (waited > 0
            ? '  用户点了按钮，这一次调用里已经按请求处理。'
            : '  按钮在页面右下角（「🈯 译」）—— 让用户点一下即可；也可以直接调 `action:"translate"` 立刻翻。'),
      ];
      return lines.join('\n');
    }
    case 'translate': {
      const stats = value.stats ?? {};
      const lines = [
        `🈯 整页翻译完成（${value.target}｜${value.mode}${value.triggered === 'button-click' ? '｜由按钮点击触发' : ''}）`,
        `  本次送翻 ${value.collected} 条 → 已回填 ${value.applied} 条｜页面打标总计 ${value.total} 条`,
        `  分块 ${stats.chunks ?? 0} 次模型调用｜字符 ${stats.chars ?? 0}｜唯一串 ${stats.unique ?? 0}${stats.dropped ? `｜超限丢弃 ${stats.dropped} 段` : ''}${stats.salvaged ? `｜兜底原文 ${stats.salvaged} 条` : ''}`,
        '  按钮现在显示「原」—— 点它回到原文；或 `translate_page(action:"restore")`。',
      ];
      if (Array.isArray(value.warnings) && value.warnings.length > 0) {
        for (const warning of value.warnings.slice(0, 4)) lines.push(`  ⚠ ${warning}`);
      }
      return lines.join('\n');
    }
    case 'restore':
      return `🈯 已还原原文（${value.restored} 个节点）｜按钮回到「译」`;
    case 'status':
      return [
        `🈯 状态：${value.state}｜可译 ${value.total} 个节点｜已译 ${value.translated} 个`,
        value.probe && value.probe.url ? `  插件看到的页面：${value.probe.title || '(无标题)'} — ${value.probe.url}（正文 ${value.probe.bodyChars} 字符）` : '',
      ].filter(Boolean).join('\n');
    default:
      return `translate_page ${value.action}：${JSON.stringify(value).slice(0, 600)}`;
  }
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ announceToAgent?: boolean, enabled?: boolean, target?: string, mode?: string, maxChars?: number }} [config]
 */
export function apply(ctx, config) {
  const cfg = config ?? {};
  if (cfg.enabled === false) return;
  const disposers = [];

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    disposers.push(ctx.tools.register(defineTool({
      name: 'translate_page',
      description: [
        '给内置浏览器的当前页面加一个「整页翻译」浮层按钮，并把页面上每一个可见文本节点**原地换成译文**（再点一下回到原文）。',
        "action='install'（默认）：装按钮并**替用户等着这一次点击**（默认 60 秒）；用户点了就在同一次调用里翻好。",
        "action='translate'：不等点击，立刻翻当前页面。",
        "action='restore'：把页面恢复成原文。",
        "action='status'：只读，看按钮状态与已译节点数。",
        '参数：target（zh 默认 / en / ja / ko / ru）、mode（replace 默认 | bilingual 双语对照）、maxChars（本次送翻上限，默认 6000）、waitSec（install 等点击秒数）、session（复用别的浏览器会话）。',
        '译文由本机 DSH 的模型服务生成，插件自己不持有任何 API key；它只改页面文本，不加 `<style>`、不发外部请求。',
        '**已知边界**：按钮是页面内浮层（不是原生工具栏）；导航到新页面后会消失，再调一次即可重装；跨域 iframe 与图片翻不到。',
      ].join('\n'),
      timeoutMs: TOOL_TIMEOUT_MS,
      parameters: {
        action: {
          type: 'string',
          description: "One of: install（默认，装按钮并等点击）, translate（立刻翻）, restore（还原）, status（只读）。",
        },
        target: {
          type: 'string',
          description: `目标语言：${Object.keys(LANGUAGES).join(' / ')}（默认 ${DEFAULT_TARGET}）`,
        },
        mode: {
          type: 'string',
          description: 'replace（默认，替换原文）| bilingual（原文下补一行译文）',
        },
        maxChars: {
          type: 'number',
          description: `本次最多送多少字符进模型（默认 ${DEFAULTS.maxChars}，超出部分如实回报并跳过）`,
        },
        waitSec: {
          type: 'number',
          description: `install 等用户点按钮的秒数（默认 ${DEFAULTS.waitSec}；0 = 装完就返回）`,
        },
        session: {
          type: 'string',
          description: '复用哪个浏览器会话键（默认用插件自己的；想翻别的会话就传那个 key）',
        },
        provider: {
          type: 'string',
          description: '可选：覆盖模型 provider（默认交给宿主默认模型）',
        },
        model: {
          type: 'string',
          description: '可选：覆盖模型（默认交给宿主默认模型）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true },
            error: { type: 'string' },
            state: { type: 'string' },
            target: { type: 'string' },
            mode: { type: 'string' },
            tabs: { type: 'json' },
            probe: { type: 'json' },
            installed: { type: 'boolean' },
            timedOut: { type: 'boolean' },
            waitedMs: { type: 'number' },
            triggered: { type: 'string' },
            collected: { type: 'number' },
            applied: { type: 'number' },
            restored: { type: 'number' },
            total: { type: 'number' },
            before: { type: 'number' },
            translated: { type: 'number' },
            stats: { type: 'json' },
            warnings: { type: 'json' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: renderText(value) }],
      },
      async execute(args) {
        const a = args ?? {};
        const action = String(a.action ?? 'install').trim().toLowerCase();
        if (!['install', 'translate', 'restore', 'status'].includes(action)) {
          return { ok: false, action, error: `unknown action: ${action}` };
        }
        const browser = browserOf(ctx);
        if (!browser) {
          return { ok: false, action, error: '没有可用的浏览器服务（ctx.get("browser") 为空）—— 请先安装/启用内置浏览器插件' };
        }
        const llm = ctx.get('llm');
        if (llm === undefined || llm === null) {
          return { ok: false, action, error: '宿主没有提供 LLM 服务（ctx.get("llm") 为空），无法翻译' };
        }
        try {
          const session = await openSession(browser, a.session);
          const out = await drive(browser, session, { ...a, action }, llm);
          return out;
        } catch (error) {
          return { ok: false, action, error: error instanceof Error ? error.message : String(error) };
        }
      },
    })));
  }

  if (cfg.announceToAgent !== false && ctx.systemPrompt !== undefined
    && typeof ctx.systemPrompt.section === 'function') {
    disposers.push(ctx.systemPrompt.section({
      name: 'plugin:inpage-translator',
      order: SECTION_ORDER,
      text: INPAGE_TRANSLATOR_GUIDANCE,
    }));
  }

  if (typeof ctx.effect === 'function' && disposers.length > 0) {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          /* 卸载失败不阻断其它清理 */
        }
      }
    }, 'dsh-inpage-translator: teardown');
  }
}

/** 供测试直接使用。 */
export { drive, renderText, runInPage, handleClick };
