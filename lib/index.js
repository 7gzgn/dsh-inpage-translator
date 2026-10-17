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
import { resolveRoute, translateNodes } from './translate.js';

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
  '本机已安装 **dsh-inpage-translator（整页翻译）**：提供 `translate_page` —— 往内置浏览器的页面放一个浮层按钮（「🈯 译」），点一下就把**页面上每一个可见文本节点原地换成译文**，再点一下回到原文。',
  '**按钮是常驻的**：插件后台每 1.5 秒扫一遍所有活着的浏览器会话，自动补按钮、自动读点击（页面导航后也会重新装上）。所以用户**不需要先调工具** —— 他看到「🈯 译」点一下就会翻；只用调工具的情况是"想立刻翻、不等他点"。',
  '**交互**：长按按钮 320ms 可拖动，拖到左右边缘 48px 内自动吸成贴边小把手，点一下展开。',
  '动作：`install`（确保按钮在并**替用户等着这一次点击**，默认等 60 秒，点了就翻）、`translate`（不等，立刻翻）、`restore`（回到原文）、`status`（只读状态）、`sessions`（只读，列出所有活会话 —— 判断"按钮到底在哪个窗口"用）。',
  '典型用法：用户说"翻译这个页面"→ 直接 `translate_page(action:"translate")`，不用先装；用户问"按钮怎么没了"→ `action:"sessions"` 看会话清单，再 `action:"status"` 自证。',
  '参数：`target`（zh 默认 / en / ja / ko / ru）、`mode`（replace 替换原文（默认）| bilingual 原文下补一行译文）、`maxChars`（本次送翻的字符上限，默认 6000，超出部分如实回报）、`waitSec`（install 等点击的秒数）、`session`（显式指定会话；不传就自动用最活跃的那个）。',
  '**它不碰页面结构以外的任何东西**：只改文本、只加内联样式（绕开页面 CSP），不注入 `<style>`、不发请求、不上传内容；译文由本机 DSH 的模型服务生成，插件自己不持有任何 API key。',
  '**限制（先说清）**：① 按钮是页面内浮层，不是浏览器原生工具栏（宿主不给第三方加工具栏按钮的扩展点）；② 跨域 iframe 里的文字翻不到；③ 只翻可见文本节点，图片不处理。',
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
 * 枚举**所有活着的浏览器会话**。
 *
 * 为什么要钻这一层：`BrowserProvider.open(label)` 的语义就是「每次新开一个会话」，
 * 服务本身**没有** listSessions / activeSession 这类接口（`browser/types.ts` 里
 * 只有 `open` / `exists`）。而运行时里会话表是真实存在的（`provider.sessions`
 * 是一个 Map，`runtime.providers` 也是），所以这里**只读**地把它读出来，
 * 严格 try/catch —— 宿主结构一变就当作"什么都没发现"，退回旧路径，绝不让插件炸。
 *
 * @param {object} ctx 宿主上下文
 * @returns {Array<{id:string,label:string,url:string,tabs:number,seq:number}>} 按最近活跃排序
 */
export function discoverSessions(ctx) {
  const out = [];
  try {
    const runtime = typeof ctx?.get === 'function' ? ctx.get('browser') : undefined;
    if (!runtime) return out;
    const providers = runtime.providers;
    if (!providers || typeof providers.values !== 'function') return out;
    for (const provider of providers.values()) {
      if (!provider) continue;
      const sessions = provider.sessions;
      if (!sessions || typeof sessions.values !== 'function') continue;
      for (const session of sessions.values()) {
        if (!session || typeof session.id !== 'string' || session.id === '') continue;
        const tabs = Array.isArray(session.tabs) ? session.tabs : [];
        const index = Number.isFinite(session.activeIndex) ? session.activeIndex : 0;
        const active = tabs[index] ?? tabs[0] ?? null;
        out.push({
          id: session.id,
          label: typeof session.label === 'string' ? session.label : '',
          url: active && typeof active.url === 'string' ? active.url : '',
          tabs: tabs.length,
          seq: Number.isFinite(session.nextSeq) ? session.nextSeq : 0,
        });
      }
    }
  } catch {
    /* 宿主内部结构变了：当作"没发现"，调用方走旧路径。 */
  }
  return out.sort((a, b) => b.seq - a.seq);
}

/**
 * 从枚举结果里挑"最像用户正在看的那一个"：有页面的优先，再按活跃度。
 * @param {Array<{id:string,url:string,seq:number}>} sessions
 * @returns {object|null}
 */
export function pickSession(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const withPage = list.filter((s) => typeof s.url === 'string' && s.url !== '');
  const pool = withPage.length > 0 ? withPage : list;
  return pool[0] ?? null;
}

/**
 * 取（或开）一个会话。
 *
 * 顺序：**调用方显式给的** → **枚举到的最活跃会话** → 实在没有才新开一个。
 * 新开是最后手段：那会多弹一个窗口，对"照着页面点一下"的产品来说是坏事。
 * @param {object} ctx
 * @param {object} browser
 * @param {string|undefined} sessionKey
 * @returns {Promise<string>} 会话 id
 */
async function openSession(ctx, browser, sessionKey) {
  if (typeof sessionKey === 'string' && sessionKey.trim() !== '') return sessionKey.trim();
  const found = pickSession(discoverSessions(ctx));
  if (found) return found.id;
  try {
    const created = await browser.open(PLUGIN_NAME);
    if (created) return created;
  } catch (error) {
    throw new Error(`打不开浏览器会话：${String((error && error.message) || error)}`);
  }
  throw new Error('打不开浏览器会话（宿主没有返回会话 id）');
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
      route: context.route,
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
 * 后台巡场：扫一遍所有活会话 → 补按钮（ping 自带建按钮）→ 有人点了就立刻翻。
 *
 * 这是"按钮常驻"的实现：不等 `translate_page` 被调用，用户任何时刻点按钮，
 * 下一次 tick 就会被处理。**只读 + 幂等**：重复 ping 不会改页面内容。
 * @param {object} ctx
 * @param {object} browser
 * @param {object} state 巡场状态（busy / marks / target / mode / maxChars / llm）
 * @returns {Promise<void>}
 */
async function sweepOnce(ctx, browser, state) {
  if (state.busy) return;
  state.busy = true;
  try {
    const sessions = discoverSessions(ctx).filter((s) => s.url !== '');
    if (sessions.length === 0) return;
    for (const info of sessions.slice(0, DEFAULTS.sweepLimit)) {
      const mark = state.marks.get(info.id) ?? { fails: 0 };
      if (mark.fails >= DEFAULTS.sweepMaxFails) continue;
      let report = null;
      try {
        report = await runInPage(browser, info.id, { action: 'ping' }, 8000);
        mark.fails = 0;
      } catch {
        mark.fails += 1;
        state.marks.set(info.id, mark);
        continue;
      }
      state.marks.set(info.id, mark);

      // 用户点了「原」—— 要的是立即还原，不需要模型，也不该去解析模型路线。
      if (report.request === 'restore') {
        try {
          await runInPage(browser, info.id, { action: 'restore', label: '译' }, 15000);
        } catch {
          /* 还原失败：留到下一轮再试，不把巡场拖垮 */
        }
        return;
      }

      if (report.request !== 'pending' && report.state !== 'busy') continue;

      // 有人点了按钮 —— 不在等下一次工具调用，直接在这里把活干完。
      let route = null;
      try {
        route = resolveRoute(ctx, {});
      } catch (error) {
        try {
          await runInPage(browser, info.id, { action: 'error', message: String((error && error.message) || error) }, 6000);
        } catch {
          /* 连错误都写不回去：下次 tick 再说 */
        }
        continue;
      }
      try {
        await handleClick(browser, info.id, report, {
          target: state.target,
          mode: state.mode,
          maxChars: state.maxChars,
          llm: state.llm,
          llmOptions: {},
          route,
        });
      } catch (error) {
        try {
          await runInPage(browser, info.id, { action: 'error', message: String((error && error.message) || error) }, 6000);
        } catch {
          /* 同上 */
        }
      }
      return; // 一次 tick 只处理一次翻译，避免把 tick 拖长
    }
  } finally {
    state.busy = false;
  }
}

/**
 * 干活的主循环：先看页面状态，再决定"翻 / 还原 / 继续等用户点"。
 * @param {object} ctx 宿主上下文（解析默认模型路线用）
 * @param {object} browser
 * @param {object} session
 * @param {object} args 工具参数
 * @param {object} llm
 * @returns {Promise<object>} 给工具用的结果对象
 */
async function drive(ctx, browser, session, args, llm) {
  const target = typeof args.target === 'string' && LANGUAGES[args.target] ? args.target : DEFAULT_TARGET;
  const mode = typeof args.mode === 'string' && MODES[args.mode] ? args.mode : DEFAULTS.mode;
  const maxChars = Number.isFinite(args.maxChars) ? Math.max(0, Number(args.maxChars)) : DEFAULTS.maxChars;
  const action = String(args.action ?? 'install').trim().toLowerCase();
  const llmOptions = {};
  if (typeof args.provider === 'string' && args.provider !== '') llmOptions.provider = args.provider;
  if (typeof args.model === 'string' && args.model !== '') llmOptions.model = args.model;

  // 模型路线：显式给的优先，否则读宿主默认模型（拿不到就明确报错，不瞎猜 provider）
  const route = resolveRoute(ctx, { provider: args.provider, model: args.model });

  const context = { target, mode, maxChars, llm, llmOptions, route };

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
      edge: probe && probe.edge ? probe.edge : '',
      session,
      sessions: discoverSessions(ctx),
      tabs,
      probe,
    };
  }

  // ---- 只读：把所有活着的浏览器会话列出来（"按钮到底在哪个窗口"的唯一可信答案） ----
  if (action === 'sessions') {
    const found = discoverSessions(ctx);
    const picked = pickSession(found);
    return {
      ok: true,
      action: 'sessions',
      session: picked ? picked.id : '',
      sessions: found,
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
        `🈯 状态：${value.state}｜可译 ${value.total} 个节点｜已译 ${value.translated} 个${value.edge ? `｜已吸附到${value.edge === 'left' ? '左' : '右'}边` : ''}`,
        value.probe && value.probe.url ? `  插件看到的页面：${value.probe.title || '(无标题)'} — ${value.probe.url}（正文 ${value.probe.bodyChars} 字符）` : '',
        Array.isArray(value.sessions) && value.sessions.length > 0
          ? `  活会话 ${value.sessions.length} 个：${value.sessions.map((s) => `${s.id.slice(0, 18)}…${s.url ? ` (${s.url.slice(0, 60)})` : ' (空)'}`).join('；')}`
          : '  没发现别的活会话。',
      ].filter(Boolean).join('\n');
    case 'sessions': {
      const list = Array.isArray(value.sessions) ? value.sessions : [];
      if (list.length === 0) return '🈯 没有发现活着的浏览器会话（还没开过页面，或者宿主结构变了）。';
      return [
        `🈯 活着的浏览器会话 ${list.length} 个（按钮会自动装到每一个有页面的上面）：`,
        ...list.slice(0, 10).map((s, i) => `  ${i === 0 ? '▶' : ' '} ${s.id}｜${s.tabs} 个标签｜${s.url ? s.url.slice(0, 90) : '(还没有页面)'}`),
      ].join('\n');
    }
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
        '给内置浏览器**每一个活着的页面**装一个「整页翻译」浮层按钮，并把页面上每一个可见文本节点**原地换成译文**（再点一下回到原文）。',
        '**按钮是常驻的**：插件后台每 1.5 秒扫一遍所有浏览器会话，自动补按钮、自动读点击（页面导航后也会重新装上）。所以用户**不需要先调工具**，看到「🈯 译」点一下就会翻。',
        "action='install'（默认）：确保按钮在（还没装就装），并**替用户等着这一次点击**（默认 60 秒）；用户点了就在同一次调用里翻好。",
        "action='translate'：不等点击，立刻翻当前页面。",
        "action='restore'：把页面恢复成原文。",
        "action='status'：只读，看按钮状态、已译节点数，以及**所有活会话的清单**。",
        "action='sessions'：只读，列出所有活着的浏览器会话（id / 页面 URL / 标签数），用来判断按钮到底在哪个窗口。",
        '**交互**：长按按钮 320ms 可拖动，拖到左右边缘 48px 内会自动吸成贴边小把手，点一下展开。',
        '参数：target（zh 默认 / en / ja / ko / ru）、mode（replace 默认 | bilingual 双语对照）、maxChars（本次送翻上限，默认 6000）、waitSec（install 等点击秒数）、session（显式指定会话；不传就自动用最活跃的那个）。',
        '译文由本机 DSH 的模型服务生成，插件自己不持有任何 API key；它只改页面文本，不加 `<style>`、不发外部请求。',
        '**已知边界**：按钮是页面内浮层（不是浏览器原生工具栏 —— 宿主没有给第三方插件的工具栏扩展点）；跨域 iframe 与图片翻不到。',
      ].join('\n'),
      timeoutMs: TOOL_TIMEOUT_MS,
      parameters: {
        action: {
          type: 'string',
          description: "One of: install（默认，确保按钮在并等点击）, translate（立刻翻）, restore（还原）, status（只读状态）, sessions（只读，列出所有活会话）。",
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
            edge: { type: 'string' },
            session: { type: 'string' },
            sessions: { type: 'json' },
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
        if (!['install', 'translate', 'restore', 'status', 'sessions'].includes(action)) {
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
          const session = await openSession(ctx, browser, a.session);
          const out = await drive(ctx, browser, session, { ...a, action }, llm);
          return out;
        } catch (error) {
          return { ok: false, action, error: error instanceof Error ? error.message : String(error) };
        }
      },
    })));
  }

  // ---- 后台巡场：让按钮"常驻"（用户不用先调工具，导航后也会自动补上） ----
  if (cfg.autoInject !== false) {
    const sweep = {
      busy: false,
      marks: new Map(),
      target: typeof cfg.target === 'string' && LANGUAGES[cfg.target] ? cfg.target : DEFAULT_TARGET,
      mode: typeof cfg.mode === 'string' && MODES[cfg.mode] ? cfg.mode : DEFAULTS.mode,
      maxChars: Number.isFinite(cfg.maxChars) ? Math.max(0, Number(cfg.maxChars)) : DEFAULTS.maxChars,
      llm: ctx.get('llm'),
    };
    if (sweep.llm !== undefined && sweep.llm !== null) {
      const timer = setInterval(() => {
        const browser = browserOf(ctx);
        if (!browser) return;
        // 巡场自己出错绝不能冒成未处理的 rejection —— 按钮是附加功能，坏了自己重试下一轮。
        void sweepOnce(ctx, browser, sweep).catch(() => {});
      }, DEFAULTS.sweepMs);
      // 别让这个定时器把宿主进程吊着（Node 侧才有效，宿主没有就忽略）。
      if (timer && typeof timer.unref === 'function') timer.unref();
      disposers.push(() => clearInterval(timer));
    }
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
export { drive, renderText, runInPage, handleClick, sweepOnce };
