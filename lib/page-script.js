/**
 * dsh-inpage-translator —— 页面侧脚本（字符串形态，通过 browser.execute 注入）。
 *
 * 三件事都在一个 IIFE 里：**装按钮 → 收集可译文本并打标 → 按标号回填译文/还原**。
 * 没有第二次注入，所以不存在"脚本版本对不上"的问题。
 *
 * 两条铁律（来自 dsh-builtin-browser 的 virtual-cursor.ts 注记）：
 *   1. 用**内联样式**，不用 `<style>` —— style 元素受页面 `style-src` CSP 约束，注入脚本不受；
 *   2. 文案用 `textContent` 写，**不拼 HTML 字符串** —— 页面不会因为我们注入的字符串而变形。
 *
 * 按钮交互（v0.2 起）：**常驻 + 长按拖拽 + 靠边缩进**。
 *   - 常驻：插件在后台把所有活着的浏览器会话都装上它，页面导航后由插件重新注入；
 *   - 长按拖拽：按住 320ms 后进入拖拽，拖到哪停哪（松手那一下不会误触发翻译）；
 *   - 靠边缩进：丢在左/右边缘 48px 内就吸成贴边的小把手，点一下再展开。
 *
 * @module dsh-inpage-translator/page-script
 */

import {
  DRAG_ATTR,
  EDGE_ATTR,
  LANG_ATTR,
  MODE_ATTR,
  NODE_ATTR,
  ORIG_ATTR,
  POS_ATTR,
  REQ_ATTR,
  ROOT_ID,
  SKIP_ATTR,
  STATE_ATTR,
  TRANS_ATTR,
} from './constants.js';

/**
 * 构造要注入页面的脚本（无参数，读 `window.__dshIptReq` 取本次请求）。
 *
 * 请求对象形状：
 * ```
 * { action: 'install' | 'ping' | 'translate' | 'restore' | 'probe' | 'collect' | 'error',
 *   target: 'zh', mode: 'replace' | 'bilingual', label: '译',
 *   translations: { '0': '…', '1': '…' } }
 * ```
 *
 * 返回的 JSON 里会带：`state`（按钮状态）、`request`（按钮上等待处理的请求）、
 * `nodes`（本次新打标、需要翻译的节点）、`total` / `already`（打标总数 / 已译数）。
 *
 * `ping` 是**轻量探测**：只读按钮状态与计数，不遍历 DOM（后台轮询用这条，
 * 否则每次轮询都 collect 一遍整页，开销白给）。
 *
 * @returns {string} 可直接 execute 的表达式
 */
export function installScript() {
  const cfg = JSON.stringify({
    rootId: ROOT_ID,
    skip: SKIP_ATTR,
    node: NODE_ATTR,
    orig: ORIG_ATTR,
    trans: TRANS_ATTR,
    req: REQ_ATTR,
    mode: MODE_ATTR,
    lang: LANG_ATTR,
    state: STATE_ATTR,
    pos: POS_ATTR,
    edge: EDGE_ATTR,
    drag: DRAG_ATTR,
  });
  return `(function(__reqJson){
  var C = ${cfg};
  var HOLD_MS = 320;        // 按住多久才算"长按拖拽"
  var MOVE_TOLERANCE = 10;  // 长按之前移动超过这个距离，就不当点击（留点手抖余量）
  var EDGE_MARGIN = 48;     // 距离左右边缘多近时吸附

  try {
    var body = document.body || document.documentElement;
    if (!body) return JSON.stringify({ ok: false, error: 'no-body' });

    var existing = document.getElementById(C.rootId);
    var prevState = existing ? (existing.getAttribute(C.state) || 'idle') : '';

    // ---------- 1) 收藏可译文本并打标 ----------
    function collect() {
      var nodes = [];
      var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          var p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          if (p.closest('[' + C.skip + ']')) return NodeFilter.FILTER_REJECT;
          if (p.closest('script,style,noscript,template,textarea,select,svg,canvas')) return NodeFilter.FILTER_REJECT;
          var tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'SELECT') return NodeFilter.FILTER_REJECT;
          if (p.hasAttribute('contenteditable')) return NodeFilter.FILTER_REJECT;
          if (p.hasAttribute('aria-hidden') && p.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
          var text = n.nodeValue || '';
          if (text.replace(/\\s+/g, ' ').trim().length < 2) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      var next = 0;
      while (walker.nextNode()) {
        var wrapper = walker.currentNode.parentElement;
        if (!wrapper) continue;
        if (wrapper.hasAttribute(C.node)) continue;
        wrapper.setAttribute(C.node, String(next));
        wrapper.setAttribute(C.orig, wrapper.textContent || '');
        next += 1;
        nodes.push({ index: next - 1, text: (wrapper.textContent || '').replace(/\\s+/g, ' ').trim() });
      }
      return nodes;
    }

    // ---------- 2) 回填 / 还原 ----------
    function countMarked() {
      return document.querySelectorAll('[' + C.node + ']').length;
    }
    function countTranslated() {
      return document.querySelectorAll('[' + C.node + '][' + C.trans + ']').length;
    }
    function apply(mode, table) {
      var list = document.querySelectorAll('[' + C.node + ']');
      var hit = 0;
      for (var i = 0; i < list.length; i += 1) {
        var el = list[i];
        var key = el.getAttribute(C.node);
        if (table && Object.prototype.hasOwnProperty.call(table, key)) {
          var value = String(table[key]);
          el.textContent = value;
          el.setAttribute(C.trans, value);
          hit += 1;
        }
      }
      return hit;
    }
    function restore() {
      var list = document.querySelectorAll('[' + C.node + ']');
      for (var i = 0; i < list.length; i += 1) {
        var el = list[i];
        if (el.hasAttribute(C.orig)) el.textContent = el.getAttribute(C.orig);
        el.removeAttribute(C.trans);
      }
      return list.length;
    }

    // ---------- 3) 按钮状态 ----------
    function setState(root, next, hint) {
      root.setAttribute(C.state, next);
      var label = root.querySelector('[data-dsh-pt-label]');
      if (label) {
        if (next === 'busy') label.textContent = '…';
        else if (next === 'done') label.textContent = hint || '原';
        else if (next === 'error') label.textContent = '!';
        else label.textContent = hint || '译';
      }
      var note = root.querySelector('[data-dsh-pt-note]');
      if (note) {
        note.textContent = next === 'error' ? String(hint || '') : '';
        note.style.display = next === 'error' ? 'inline' : 'none';
      }
    }

    // ---------- 4) 吸附 / 展开 ----------
    function applyEdge(root, edge) {
      var label = root.querySelector('[data-dsh-pt-label]');
      var note = root.querySelector('[data-dsh-pt-note]');
      if (edge === 'left' || edge === 'right') {
        root.setAttribute(C.edge, edge);
        root.style.borderRadius = edge === 'left' ? '0 999px 999px 0' : '999px 0 0 999px';
        root.style.padding = '10px 8px';
        if (label) label.style.display = 'none';
        if (note) note.style.display = 'none';
        root.title = 'DSH 整页翻译：点一下展开';
      } else {
        root.removeAttribute(C.edge);
        root.style.borderRadius = '999px';
        root.style.padding = '8px 12px';
        if (label) label.style.display = '';
        root.title = 'DSH 整页翻译：点一下翻译，按住可拖动';
      }
    }

    function placeAfterDrag(root) {
      var r = root.getBoundingClientRect();
      var w = window.innerWidth || 0;
      var h = window.innerHeight || 0;
      var edge = '';
      if (r.left < EDGE_MARGIN) edge = 'left';
      else if (w - r.right < EDGE_MARGIN) edge = 'right';
      if (edge === 'left') {
        root.style.left = '0px';
        root.style.right = 'auto';
      } else if (edge === 'right') {
        root.style.right = '0px';
        root.style.left = 'auto';
      } else {
        root.style.left = Math.max(0, Math.min(w - root.offsetWidth, r.left)) + 'px';
        root.style.right = 'auto';
      }
      root.style.top = Math.max(0, Math.min(h - root.offsetHeight, r.top)) + 'px';
      root.style.bottom = 'auto';
      applyEdge(root, edge);
      try {
        root.setAttribute(C.pos, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), edge: edge }));
      } catch (e) {}
    }

    // ---------- 5) 长按拖拽 ----------
    function attachDrag(root) {
      if (root.getAttribute(C.drag) === 'bound') return;
      root.setAttribute(C.drag, 'bound');

      var hold = null;      // { x, y, left, top }
      var holdTimer = null;
      var dragging = false;
      var movedBeforeHold = false;
      var suppressClick = false;

      function onDown(event) {
        if (event.button !== undefined && event.button !== 0) return;
        // 注意：**翻译中（busy）也必须能拖** —— 翻译要几十秒，这期间按钮卡死不动
        // 会被当成"拖不动"（真机反馈就是这么来的）。点击另有一层 busy 判断，不会误翻。
        var rect = root.getBoundingClientRect();
        hold = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
        dragging = false;
        movedBeforeHold = false;
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = setTimeout(function () {
          if (!hold) return;
          dragging = true;
          suppressClick = true;
          root.setAttribute(C.drag, 'dragging');
          root.style.transition = 'none';
          root.style.cursor = 'grabbing';
        }, HOLD_MS);
        window.addEventListener('mousemove', onMove, true);
        window.addEventListener('mouseup', onUp, true);
      }

      function onMove(event) {
        if (!hold) return;
        var dx = event.clientX - hold.x;
        var dy = event.clientY - hold.y;
        if (!dragging) {
          if (Math.abs(dx) <= MOVE_TOLERANCE && Math.abs(dy) <= MOVE_TOLERANCE) return;
          // 按住之后还在移动 —— 这就是想拖，**立刻进入**，不用先等满 320ms。
          // （长按只是"按住不动也想拖"的预热；真正想拖的人不该被时间挡在门外。）
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
          movedBeforeHold = true;
          dragging = true;
          suppressClick = true;
          root.setAttribute(C.drag, 'dragging');
          root.style.transition = 'none';
          root.style.cursor = 'grabbing';
        }
        event.preventDefault();
        event.stopPropagation();
        var w = window.innerWidth || 0;
        var h = window.innerHeight || 0;
        var left = Math.max(0, Math.min(w - root.offsetWidth, hold.left + dx));
        var top = Math.max(0, Math.min(h - root.offsetHeight, hold.top + dy));
        root.style.left = left + 'px';
        root.style.top = top + 'px';
        root.style.right = 'auto';
        root.style.bottom = 'auto';
      }

      function onUp() {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (dragging) {
          dragging = false;
          root.setAttribute(C.drag, 'bound');
          root.style.transition = 'left .16s ease, top .16s ease, border-radius .16s ease, padding .16s ease';
          root.style.cursor = 'pointer';
          placeAfterDrag(root);
          setTimeout(function () { suppressClick = false; }, 60);
        } else if (movedBeforeHold) {
          // 按得不久却移了：既不拖也不点，避免误翻。
          suppressClick = true;
          setTimeout(function () { suppressClick = false; }, 60);
        }
        hold = null;
      }

      root.addEventListener('mousedown', onDown, true);
      root.addEventListener('click', function (event) {
        if (suppressClick) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        // 吸附成小把手时：第一下只负责展开。
        var edge = root.getAttribute(C.edge);
        if (edge === 'left' || edge === 'right') {
          applyEdge(root, '');
          if (edge === 'left') root.style.left = '8px';
          else { root.style.left = 'auto'; root.style.right = '8px'; }
          root.style.transition = 'left .16s ease, right .16s ease, border-radius .16s ease, padding .16s ease';
          return;
        }
        var state = root.getAttribute(C.state);
        var pending = root.getAttribute(C.req);
        if (state === 'busy' || pending === 'pending' || pending === 'translating') return;
        root.setAttribute(C.req, state === 'done' ? 'restore' : 'pending');
        var hint = root.querySelector('[data-dsh-pt-label]');
        if (state === 'done') {
          root.setAttribute(C.state, 'idle');
          if (hint) hint.textContent = '…';
        } else {
          // 要翻译：先给一个"在处理"的反馈 —— 巡场最多 1.5 秒后才接手，不给反馈会显得没反应。
          root.setAttribute(C.state, 'busy');
          if (hint) hint.textContent = '…';
        }
      }, true);
    }

    function buildButton() {
      var root = document.createElement('div');
      root.id = C.rootId;
      root.setAttribute(C.skip, '');
      root.setAttribute(C.state, 'idle');
      root.style.cssText = [
        'position:fixed', 'right:16px', 'bottom:88px', 'z-index:2147483647',
        'display:flex', 'align-items:center', 'gap:6px',
        'padding:8px 12px', 'border-radius:999px',
        'background:rgba(28,30,36,.92)', 'color:#fff',
        'font:13px/1 system-ui,"Segoe UI",Arial,sans-serif', 'cursor:pointer',
        'box-shadow:0 6px 18px rgba(0,0,0,.35)', 'border:1px solid rgba(255,255,255,.18)',
        'user-select:none', 'pointer-events:auto', 'touch-action:none'
      ].join(';');
      root.title = 'DSH 整页翻译：点一下翻译，按住可拖动';

      var glyph = document.createElement('span');
      glyph.setAttribute('data-dsh-pt-glyph', '');
      glyph.textContent = '🈯';
      glyph.style.cssText = 'font-size:14px;line-height:1';

      var label = document.createElement('span');
      label.setAttribute('data-dsh-pt-label', '');
      label.textContent = '译';

      var note = document.createElement('span');
      note.setAttribute('data-dsh-pt-note', '');
      note.style.cssText = 'display:none;color:#ffb4b4;font-size:11px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

      root.appendChild(glyph);
      root.appendChild(label);
      root.appendChild(note);
      attachDrag(root);
      return root;
    }

    // ---------- 6) 主流程 ----------
    // 请求由宿主 execute 的 args 送进来（provider 把 args 变成 arguments[0]）。
    var req = null;
    if (typeof __reqJson === 'string' && __reqJson !== '') {
      try { req = JSON.parse(__reqJson); } catch (e) { req = null; }
    }
    var action = req && typeof req.action === 'string' ? req.action : 'inspect';

    if (!existing) {
      body.appendChild(buildButton());
      existing = document.getElementById(C.rootId);
    }
    var root = existing;
    var labelEl = root.querySelector('[data-dsh-pt-label]');

    // ping：轻量探测（后台轮询用）——不 collect、不改状态，只如实回报。
    if (action === 'ping') {
      return JSON.stringify({
        ok: true,
        action: 'ping',
        url: location.href,
        title: document.title,
        state: root.getAttribute(C.state) || 'idle',
        request: root.getAttribute(C.req) || '',
        edge: root.getAttribute(C.edge) || '',
        total: countMarked(),
        already: countTranslated(),
        bodyChars: (body.innerText || '').length
      });
    }

    if (action === 'install' || action === 'inspect') {
      if (prevState === '' || prevState === 'idle') setState(root, 'idle', (req && req.label) || '译');
    } else if (action === 'probe') {
      // 只读自证：这张页面是谁、按钮在不在、打了多少标 —— 用来定位"插件到底在看哪张页面"。
      return JSON.stringify({
        ok: true,
        action: 'probe',
        url: location.href,
        title: document.title,
        state: root.getAttribute(C.state) || 'idle',
        request: root.getAttribute(C.req) || '',
        edge: root.getAttribute(C.edge) || '',
        total: countMarked(),
        already: countTranslated(),
        bodyChars: (body.innerText || '').length
      });
    } else if (action === 'collect') {
      // 重新收一遍：把上一次的打标**全部清掉**，整页重新成为候选。
      // v0.2.1 修：以前只清 trans 标记、留着 node 标记，于是 collect() 把它们全跳过
      // → 每次只返回"新节点"（实际是 0 个）→ 回执"送翻 0 条"，翻译永远不发生。
      var stale = document.querySelectorAll('[' + C.node + ']');
      for (var s = 0; s < stale.length; s += 1) {
        stale[s].removeAttribute(C.node);
        stale[s].removeAttribute(C.orig);
        stale[s].removeAttribute(C.trans);
      }
    } else if (action === 'translate') {
      root.setAttribute(C.lang, (req && req.target) || 'zh');
      root.setAttribute(C.mode, (req && req.mode) || 'replace');
      root.setAttribute(C.req, '');
      var applied = apply((req && req.mode) || 'replace', req && req.translations);
      setState(root, 'done', '原');
    } else if (action === 'restore') {
      root.setAttribute(C.req, '');
      var restored = restore();
      setState(root, 'idle', (req && req.label) || '译');
      if (labelEl) labelEl.textContent = (req && req.label) || '译';
      return JSON.stringify({
        ok: true, action: 'restore', restored: restored, state: 'idle',
        total: countMarked(), already: 0, nodes: []
      });
    } else if (action === 'error') {
      setState(root, 'error', (req && req.message) || 'failed');
    }

    var fresh = collect();
    return JSON.stringify({
      ok: true,
      action: action,
      state: root.getAttribute(C.state),
      request: root.getAttribute(C.req) || '',
      edge: root.getAttribute(C.edge) || '',
      target: root.getAttribute(C.lang) || '',
      mode: root.getAttribute(C.mode) || '',
      added: fresh.length,
      nodes: fresh,
      total: countMarked(),
      already: countTranslated()
    });
  } catch (error) {
    return JSON.stringify({ ok: false, error: String((error && error.message) || error) });
  }
})(arguments[0])`;
}

/**
 * 从 execute 的返回值里解析页面回报（execute 可能返回字符串、也可能是 JSON 字符串包在对象里）。
 * @param {unknown} value
 * @returns {object|null}
 */
export function parsePageReport(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
