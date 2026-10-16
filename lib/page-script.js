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
 * @module dsh-inpage-translator/page-script
 */

import {
  LANG_ATTR,
  MODE_ATTR,
  NODE_ATTR,
  ORIG_ATTR,
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
 * { action: 'install' | 'translate' | 'restore',
 *   target: 'zh', mode: 'replace' | 'bilingual', label: '译',
 *   translations: { '0': '…', '1': '…' } }
 * ```
 *
 * 返回的 JSON 里会带：`state`（按钮状态）、`request`（按钮上等待处理的请求）、
 * `nodes`（本次新打标、需要翻译的节点）、`total` / `already`（打标总数 / 已译数）。
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
  });
  return `(function(){
  var C = ${cfg};
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
      var seen = 0;
      while (walker.nextNode()) {
        var wrapper = walker.currentNode.parentElement;
        if (!wrapper) continue;
        if (wrapper.hasAttribute(C.node)) continue;
        wrapper.setAttribute(C.node, String(next));
        wrapper.setAttribute(C.orig, wrapper.textContent || '');
        next += 1;
        nodes.push({ index: next - 1, text: (wrapper.textContent || '').replace(/\\s+/g, ' ').trim() });
        seen += 1;
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

    // ---------- 3) 按钮 ----------
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
        'user-select:none', 'pointer-events:auto'
      ].join(';');
      root.title = 'DSH 整页翻译：点一下翻译，再点一下看原文';

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
      root.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        var state = root.getAttribute(C.state);
        var pending = root.getAttribute(C.req);
        if (state === 'busy' || pending === 'pending' || pending === 'translating') return;
        root.setAttribute(C.req, state === 'done' ? 'restore' : 'pending');
        if (state === 'done') {
          root.setAttribute(C.state, 'idle');
          var l = root.querySelector('[data-dsh-pt-label]');
          if (l) l.textContent = '…';
        }
      }, true);
      return root;
    }

    // ---------- 4) 主流程 ----------
    var req = window.__dshIptReq || null;
    var action = req && typeof req.action === 'string' ? req.action : 'inspect';

    if (!existing) {
      body.appendChild(buildButton());
      existing = document.getElementById(C.rootId);
    }
    var root = existing;
    var labelEl = root.querySelector('[data-dsh-pt-label]');

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
        total: countMarked(),
        already: countTranslated(),
        bodyChars: (body.innerText || '').length
      });
    } else if (action === 'collect') {
      // 重新收一遍（译文还在页面上）：把「已译」标记清掉，让它们重新变成候选。
      var translated = document.querySelectorAll('[' + C.node + '][' + C.trans + ']');
      for (var t = 0; t < translated.length; t += 1) translated[t].removeAttribute(C.trans);
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
      window.__dshIptReq = null;
      return JSON.stringify({
        ok: true, action: 'restore', restored: restored, state: 'idle',
        total: countMarked(), already: 0, nodes: []
      });
    } else if (action === 'error') {
      setState(root, 'error', (req && req.message) || 'failed');
      window.__dshIptReq = null;
    }

    var fresh = collect();
    window.__dshIptReq = null;
    return JSON.stringify({
      ok: true,
      action: action,
      state: root.getAttribute(C.state),
      request: root.getAttribute(C.req) || '',
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
})()`;
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
