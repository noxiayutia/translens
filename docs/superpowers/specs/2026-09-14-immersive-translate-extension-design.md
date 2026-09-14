# 浸译 — 沉浸式网页翻译浏览器扩展 设计文档

- 日期：2026-09-14
- 状态：已确认，待生成实施计划
- 工作名：浸译（可改名）

## 1. 目标与背景

做一个 Chrome/Edge 浏览器扩展，核心能力是**网页翻译**，交互形态参照「沉浸式翻译」：
在保留原文的前提下，把译文就地插入页面，让用户以双语对照方式阅读外文网页。

### 成功标准

1. 在任意普通网页上按 `Alt+T`，正文段落下方出现译文，原文布局不乱。
2. 不改任何配置（不填 API Key）即可翻译——默认走免费引擎。
3. 填入任意 OpenAI 兼容端点的 Key 后，翻译质量明显提升且术语可控。
4. 四种翻译方式（双语对照 / 整页替换 / 悬停段落 / 划词气泡）均可正常工作。
5. 同一页面重复翻译时，命中缓存的段落**不产生任何网络请求**。

### 非目标（v1 明确不做）

输入框三击空格翻译、PDF/EPUB 翻译、译文样式定制面板、翻译历史面板、
Firefox 兼容、云同步、账号体系。

## 2. 需求汇总

| 维度 | 决定 |
| --- | --- |
| 目标浏览器 | Chrome / Edge（Manifest V3） |
| 技术栈 | 原生 TypeScript + Vite，无 UI 框架 |
| 翻译引擎 | 可切换多引擎：免费公开接口 + 自定义 OpenAI 兼容 API |
| 翻译方式 | ①整页双语对照 ②整页替换 ③悬停段落翻译 ④划词翻译气泡 |
| 配套能力 | 完整设置页 + 站点规则；翻译缓存 + 智能分段合并；术语表 + 自定义提示词；快捷键 + 右键菜单 |
| 渲染方案 | 方案 A：DOM 就地注入译文节点 |

**默认值**：目标语言 = 简体中文；源语言 = 自动检测；默认引擎 = 免费 Google 接口（零配置可用）。

## 3. 总体架构

扩展运行在四个隔离环境中，通过类型化消息通信：

```
┌─────────────┐   ┌──────────────┐   ┌─────────────────┐   ┌──────────────┐
│  popup      │   │  options     │   │ service worker  │   │ content      │
│  （弹窗）    │   │ （设置页）    │   │  （后台）        │   │ script（页面）│
└──────┬──────┘   └──────┬───────┘   └────────┬────────┘   └──────┬───────┘
       │                 │                    │                   │
       └───────── chrome.runtime 消息 ────────┴───────────────────┘
                          │
                    ┌─────▼─────┐
                    │  engines  │  ← 唯一发起网络请求的地方
                    └───────────┘
```

### 职责边界

- **content script**：负责"页面上的事"——找段落、切分批、注入译文、划词、悬停。**不直接发起翻译请求**（避免页面 CSP 干扰），一律经 SW 转发；但**批次编排与并发池在内容脚本内**，因为它的生命周期与页面一致，而 SW 会被随时休眠。
- **service worker**：消息路由、右键菜单与快捷键注册、**单批次**的缓存读取、引擎调用、重试与降级。SW 保持无状态——每次消息独立完成，不在内存里保存跨批次进度。
- **engines**：网络请求的唯一出口。每个引擎是一个 `Translator` 实现。
- **core**：纯函数，零 DOM、零 `chrome.*` 依赖，100% 可单测。

### 目录结构

```
src/
  manifest.json           # MV3 清单（静态文件，构建时原样复制到 dist/）
  background/
    service-worker.ts     # 入口：消息路由、菜单、命令
    scheduler.ts          # 单批次处理：缓存命中判定、引擎调用、退避重试、降级
  content/
    index.ts              # 内容脚本入口：批次编排 + 并发池 + 总调度
    extractor.ts          # 段落识别
    renderer.ts           # 译文注入 / 还原（可插拔接口）
    styles.ts             # 译文样式常量（注入 Shadow DOM，双向隔离）
    toast.ts              # 页面内轻提示
  core/
    segmenter.ts          # 相邻短段合并 + 超长段按句子边界切分
    pool.ts               # 并发池
    cache.ts              # 两级缓存
    lang.ts               # 语种检测与目标语言决策
    hash.ts               # 稳定哈希（缓存 key）
  engines/
    types.ts              # Translator 接口与错误类型
    google.ts             # 免费 Google 网页接口
    bing.ts               # 免费 Bing 接口
    openai-compat.ts      # OpenAI 兼容 /chat/completions
    registry.ts           # 引擎注册表与选择
  popup/                  # 弹窗 UI（原生 DOM）
  options/                # 设置页 UI（原生 DOM）
  shared/
    messages.ts           # 类型化消息协议
    settings.ts           # 设置 schema、默认值、读写、迁移
    site-rules.ts         # 站点黑白名单匹配
tests/                    # Vitest 单测
```

### 关键接口

引擎统一接口，**批量**是核心设计——"智能分段合并"就落在这里：

```ts
interface Translator {
  id: string;
  name: string;
  /** 需要 API Key 的引擎返回 true，设置页据此做校验 */
  needsKey: boolean;
  /** 是否支持 system prompt（决定术语表能否生效） */
  supportsGlossary: boolean;
  translate(req: {
    texts: string[];
    from: 'auto' | string;
    to: string;
    glossary?: Term[];
    systemPrompt?: string;
    signal: AbortSignal;
  }): Promise<string[]>;
}
```

返回的数组长度必须与 `texts` 等长；不满足时抛出 `EngineError('BAD_RESPONSE')`。

渲染器接口（可插拔，为日后的阅读模式留口，v1 只有一个实现）：

```ts
interface Renderer {
  mount(segments: Segment[], results: Map<string, string>): void;
  update(segmentId: string, text: string, state: 'ok' | 'error'): void;
  restore(): void;          // 一键还原原文
  setMode(mode: 'bilingual' | 'replace'): void;
}
```

## 4. 数据流

### 4.1 整页双语对照

1. 触发：`Alt+T` 快捷键 / 弹窗"翻译此页" / 右键菜单 → popup 或 SW → 转发给 content script。
2. **抽取**（`extractor.ts`）：遍历可见 DOM，产出 `Segment[] = { id, node, text, order }`。
   跳过规则：`script/style/noscript/code/pre/textarea/input/svg/canvas`；`display:none` 或尺寸为 0；已被本插件注入的节点；
   纯数字/纯标点/单字符；已是目标语言（中文页面翻中文直接整体跳过并提示）。
3. **合并**（`segmenter.ts`）：按 DOM 顺序把相邻段落打包，单批上限约 1000 字符、最多 12 段；单段超过上限时**独占一批**不切分。切分只发生在引擎报"文本过长"的降级路径上（见第 8 节），按句子边界切并拼接。
4. **缓存查询**（`background/scheduler.ts`）：逐批计算 key，命中则直接产出，不问引擎。
5. **请求**：批次在内容脚本内经并发池（`core/pool.ts`，默认 3 路）逐批发给 SW；SW 对每批独立完成"缓存 → 引擎 → 重试"，互不依赖，因此 SW 被休眠也不会丢任务状态。
6. **渲染**（`renderer.ts`）：每个批次一返回就立刻渲染该批译文，用户能逐步看到结果。
   译文节点用 `textContent` 写入，宿主元素带 `data-jy-root` 标记并挂 Shadow DOM，防止页面 CSS 污染译文样式。
7. **增量**（`observer.ts`）：`MutationObserver` 监听 `childList`，防抖 500ms；**仅在当前页翻译已开启时**才处理新节点，且只抽取未翻译过的段落。对 X/Twitter 这类无限滚动站点必须做节流，否则会触发翻译风暴。
8. **还原**：再次 `Alt+T` 或弹窗"显示原文"，`renderer.restore()` 移除全部注入节点，页面回到原状。

### 4.2 其他三种方式

- **整页替换**：复用同一套抽取结果，渲染器切换为 `replace` 模式——把译文写回原节点的 `textContent`，改写前的**子节点快照**存在 `Map` 里以便还原（用 `Map` 而不是 `WeakMap`：`restore()` 要遍历全部条目，而 `WeakMap` 既不可遍历、键也不能是字符串 id）。带行内元素（链接、`<br>`）的段落不就地替换，退回双语注入，否则行内标记会被永久毁掉。已知限制：页面在翻译后重建过节点时，缓存引用指向脱离文档的孤儿，此时靠 `data-jy-id` 重新定位；若连标记也被丢掉，这一段就还原不回来了。
- **悬停段落**：按住 `Shift` 时给段落加高亮描边，鼠标进入即对该段单独发起翻译（走缓存，重复悬停零成本），移出保留译文。
- **划词气泡**：`mouseup` 检测选区，长度 1~2000 字符才触发；气泡定位在选区下方，越界自动翻转；含"复制译文""朗读"（`speechSynthesis`）按钮。

## 5. 引擎层

| 引擎 | 需要 Key | 支持术语表 | 说明 |
| --- | --- | --- | --- |
| `google` | 否 | 否 | 免费网页接口，默认引擎，零配置可用。接口失效时明确提示用户切换。 |
| `bing` | 否 | 否 | 免费备用，Google 失败时的备选。**实施排期：二期**——它需要先抓取页面 token 再请求，两段式且易失效，放在核心链路跑通之后再做。 |
| `openai-compat` | 是 | 是 | 用户填 BaseURL + Key + 模型名，兼容 OpenAI / DeepSeek / 硅基流动 / Ollama 等。 |

`openai-compat` 的提示词策略：system message 声明"你是翻译引擎，只输出译文，不要解释、不要加引号、保持段落数一致"；
批量翻译时用编号分隔符（如 `<<<1>>>`）让模型按编号返回，再在本地按编号切分，编号缺失则回退到整批重试或逐条翻译。
**术语表只在此类引擎生效**，免费接口在设置页显示"该引擎不支持术语表"。

## 6. 缓存

- key = `sha1(engineId + targetLang + glossaryHash + systemPromptHash + text)`
- 两级：`chrome.storage.session`（会话级，快）→ `chrome.storage.local`（持久化 LRU，默认上限 5000 条，超出按最后命中时间淘汰）。
- 设置页提供"清空翻译缓存"按钮并显示当前条目数与估算占用。
- 缓存只存纯文本，不含任何页面 URL 或用户身份信息。

## 7. 界面规格

### 7.1 弹窗（popup，约 320px 宽）

自上而下：

1. 顶部主按钮：页面未翻译时显示「翻译此页」，已翻译时显示「显示原文」（一键切换）
2. 显示模式分段控件：`双语对照` / `仅译文`
3. 目标语言下拉（记忆上次选择）
4. 引擎下拉（记忆上次选择）+ 当前引擎状态点（绿=可用 / 红=未配置或缺 Key，红点可点击直达设置页）
5. 快捷开关：悬停翻译、划词翻译（两个 checkbox，改动即时生效并写入设置）
6. 底部一行：当前页面命中站点规则时的提示文案 + 齿轮图标进设置页

弹窗关闭不中断翻译任务；任务状态由 SW 与 content script 维护，重新打开弹窗时通过消息查询真实状态，不依赖弹窗内的内存变量。

### 7.2 设置页（options，单页分标签）

标签依次为：引擎 / 语言与站点 / 术语表 / 提示词 / 高级 / 关于。
「引擎」标签内含 BaseURL、API Key（密码框 + 显示切换）、模型名与「测试连接」按钮；「关于」标签展示版本号与隐私声明（见第 9 节）。

### 7.3 设置与站点规则

设置项（`shared/settings.ts` 定义 schema 与默认值，含版本号与迁移函数）：

- 引擎：引擎选择、BaseURL、API Key、模型名、"测试连接"按钮
- 语言：目标语言、源语言（默认 auto）
- 站点规则：`*.example.com` 支持通配符；每条规则可选"自动翻译 / 永不翻译"；列表按顺序匹配，先命中者生效
- 行为：默认显示模式（双语/替换）、悬停翻译开关、划词翻译开关、自动翻译延时（页面加载后 N 秒）
- 术语表：`[{ from, to }]` 表格编辑器，支持导入/导出 JSON
- 自定义提示词：多行文本，仅对支持 system prompt 的引擎生效
- 高级：并发数（默认 3）、每批字符上限（默认 1000）、缓存上限

API Key 存在 `chrome.storage.local`，**不参与任何形式的同步或上报**；设置页明确标注这一点。

## 8. 错误处理

| 情况 | 处理 |
| --- | --- |
| 网络错误 / 超时 | 指数退避重试 2 次（500ms → 1500ms） |
| 429 限流 | 退避重试，并临时降低该引擎并发到 1 |
| 401/403 鉴权失败 | 不重试；页面 toast + 弹窗红点，点击直达设置页 |
| 响应过长 / 413 | 把该批二次切分后重试 |
| 返回条目数不匹配 | 该批降级为逐条翻译 |
| 批次最终失败 | 在对应原文下方渲染一个"重试"小按钮，**绝不静默失败** |
| 免费接口失效 | toast 提示"免费接口暂不可用，请在设置中切换到自定义 API" |
| SW 被休眠 | 所有任务状态落 storage；content script 侧对请求加超时，超时后提示重试 |

## 9. 安全与隐私

- 权限最小化：`permissions: ["storage", "activeTab", "scripting", "contextMenus"]`。
  host_permissions 只声明免费引擎域名与用户自定义端点（`optional_host_permissions` 动态申请）。
- 译文一律用 `textContent` 写入，**禁止 `innerHTML`**，杜绝来自引擎返回内容的 XSS。
- 不注入、不执行任何远程代码（MV3 硬性要求）；不引入 CDN 资源。
- 不采集、不上报任何浏览数据；除翻译请求本身外不发任何网络请求。
- 译文容器使用 Shadow DOM + `jy-` 前缀类名，双向隔离样式。

## 10. 测试策略

**单元测试（Vitest）**

- `core/segmenter`：短段合并边界、超长段按句子切分、空输入、纯标点输入
- `core/cache`：key 稳定性（同输入同 key）、LRU 淘汰、glossary 变更导致 key 变化
- `core/glossary`：提示词组装、术语为空时的输出
- `core/lang`：中英日韩识别、已是目标语言的跳过判定
- `engines/*`：mock `fetch` 覆盖成功、429、401、超时、条目数不匹配、多段编号解析
- `background/scheduler`：并发上限、退避时序（假定时器）、失败降级路径

**手动验收清单**（每个都要实际跑）

1. 维基百科长条目：双语对照、还原、滚动手感
2. Medium：flex 布局下译文不撑破容器
3. X/Twitter：SPA 动态加载内容的增量翻译不风暴
4. 含表格的文档页：表格单元格译文不错位
5. 划词气泡：长选区自动翻转、复制按钮
6. 悬停翻译：Shift 高亮、重复悬停命中缓存
7. 断网 / 错误 Key：分别出现正确提示且可重试
8. 中文页面：整体跳过并提示，不发无谓请求

## 11. 交付物

- `dist/`：可直接"加载已解压的扩展程序"的构建产物
- `npm run build` / `npm run dev`（watch）/ `npm run test` / `npm run zip`
- 中文 `README.md`：安装步骤、各模式用法、引擎配置说明、常见问题
- 本地 git 仓库，按阶段提交

## 12. 待定项

无。所有会影响实现的决策均已在本文档中固定；实现阶段若发现与此处冲突，先改文档再改代码。
