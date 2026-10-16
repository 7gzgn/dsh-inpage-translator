# dsh-inpage-translator（整页翻译）

**你把页面给 AI 看，它替你把整页翻成中文。**

调一次 `translate_page`，页面右下角多出一个浮层按钮「🈯 译」；
点一下，页面上**每一个可见文本节点原地换成译文**；再点一下，回到原文。

> 它是第 8 个作品，也是**第一个"动别人的网页"的插件**：
> 前 7 个动的是本机、文件、窗口、发布链路，这个动的是一张陌生的页面 ——
> 所以两条边界写在最前面：**只改文本、只加内联样式**；**插件自己不持有任何 API key**。

---

## 它做什么

| 步 | 动作 | 细节 |
| --- | --- | --- |
| ① | 取浏览器会话 | 默认用自己的会话键（`dsh-inpage-translator`），也支持 `session` 参数翻别的会话 |
| ② | 装浮层按钮 | 内联样式 + `position:fixed` + `z-index:2147483647`，**不注入 `<style>`**（页面 CSP 管不到它） |
| ③ | 打标 | `TreeWalker` 遍历文本节点，可译的父元素记下原始文本与编号（`data-dsh-pt="12"`） |
| ④ | 等点击（`action=install`） | 每 1.2 秒读一次页面状态，默认等 60 秒；用户点了就在**同一次调用里**翻好 |
| ⑤ | 分块送翻 | 相同字符串只翻一次；按字符/节点数分块；译文由**宿主 LLM 服务**生成 |
| ⑥ | 回填 | 按编号写回 `textContent`，并记下译文（再点按钮即还原） |
| ⑦ | 还原 | 点按钮或 `action='restore'` → 全部回到原文 |

**回执里一定有**：送翻条数、回填条数、模型调用次数、字符数、唯一串数、
超限丢弃段数、兜底原文条数，以及任何一条警告。**不编数字，不静默丢**。

## 已知边界（先说清，再说好用）

| 边界 | 说明 |
| --- | --- |
| **不是原生工具栏按钮** | 内置浏览器的工具栏是宿主硬编码的 HTML（`dsh-builtin-browser/host-main.js:123` 的 `TOOLBAR_HTML`），宿主不读任何外部字段 —— 第三方插件**没有**加工具栏按钮的扩展点。所以按钮做进页面里。 |
| **导航后按钮会消失** | 注入是运行期一次性的（宿主没有 `addScriptToEvaluateOnNewDocument` 这类通道）。再调一次 `translate_page` 即可重装；按钮状态原本也无法跨页保留。 |
| **跨域 iframe 翻不到** | 只能进当前文档的 DOM。同源 iframe 有机会，跨域没有。 |
| **只翻可见文本节点** | 图片、`background-image`、canvas 里的文字不动；`<input>` / `<textarea>` 的值不动。 |
| **字符上限** | `maxChars` 默认 6000（省钱）。超出部分**如实回报**并跳过，不做静默丢弃。 |
| **文本节点被包了一层 `<span>`** | 元素上只打标、不重排子树（`span` 用 `display:inherit`），但页面自己重写这段 DOM 时译文可能被覆盖 —— 那时重跑一次即可。 |

## 它依赖什么

- **内置浏览器插件**（`ctx.get('browser')`）—— 没有时明确报错，不会假装能用。
- **宿主的 LLM 服务**（`ctx.get('llm')`）—— 翻译由它完成，**插件不读任何 API key、不直接调任何 HTTP**。
  调用形状与宿主里已验证的两个先例一致（`dsh-meme` 的识图、`dsh-better-sidebar` 的提交信息）：
  `resolveCallConfig` → `prepareCall` → `stream`。

## 安装

市场收录后在 DSH 里搜 `dsh-inpage-translator` 安装。手动安装：

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-inpage-translator" -Target "D:\dsh\projects\dsh-inpage-translator"
# profile 的 package.json：dependencies 加 "dsh-inpage-translator": "link:D:/dsh/projects/dsh-inpage-translator"
# 并把 "dsh-inpage-translator" 加进 dsh.profile.bundles（漏了不加载）→ 重启 DSH
```

## 用法

```
translate_page action=install        # 装按钮并等用户点（默认等 60 秒）
translate_page action=translate      # 不等点击，立刻翻
translate_page action=restore        # 回到原文
translate_page action=status         # 只读状态
```

可选参数：`target`（`zh` 默认 / `en` / `ja` / `ko` / `ru`）、
`mode`（`replace` 默认 / `bilingual` 双语对照）、`maxChars`、`waitSec`、
`session`、`provider`、`model`。

典型流程：

1. 让 AI 打开你要读的页面（浏览器窗口就在你眼前）；
2. `translate_page(action:"install")` → **你点一下右下角的「🈯 译」**；
3. 同一次调用里页面就变成中文了；
4. 想对照原文，再点一下按钮（或让 AI 调 `restore`）。

## 三条设计取舍（都被现场逼出来的）

1. **按钮为什么在页面里、而不是工具栏里**
   宿主工具栏没有第三方扩展点（见上表），而"往页面里放一个浮层"是宿主自己就在用的姿势
   （`dsh-builtin-browser` 的 `virtual-cursor.ts:69-81` 就是这么画那个虚拟光标的）。
   零宿主改动、可随时卸载、升级不会被打回。

2. **按钮点击为什么由插件处理，而不是页面自己翻译**
   页面里没有到宿主的 bridge（也没有凭据，也不该有）。所以按钮只写一个**请求标记**
   （`data-dsh-pt-req`），插件轮询读到后去翻译 —— 这样凭据永远留在宿主侧。

3. **为什么"相同文本只翻一次"**
   网页里菜单/按钮/表头经常重复几十次。去重发生在**限额之前**，
   所以 6000 字符的额度能覆盖的页面比不去重时大得多。

## 安全与隐私

- **不发外部请求**：插件自己只做两件事 —— 在页面里跑脚本、调用宿主 LLM 服务；
  没有任何 `fetch`、没有本地 HTTP 端口、没有凭据读写。
- **不改页面结构以外的东西**：只写文本、只加内联样式与三个 `data-dsh-pt*` 属性。
- **翻译内容会经过你本机配置的模型**（DSH 的 provider）—— 这是这类功能的固有代价，
  页面上若有敏感信息，请自行判断要不要翻。

## 测试

```powershell
node test/smoke.mjs        # 50 项：纯逻辑 / 页面脚本 / 编排层（假 LLM）/ 驱动层（假浏览器与假页面）
```

测试**不联网、不碰真实浏览器、不读任何凭据**。
在活代码树（`D:\dsh\projects\dsh-inpage-translator`）里跑会**直接退出**，
请先复制到 `D:\dsh\sandbox\` 再跑（避免在真宿主上生效）。

## 许可

MIT
