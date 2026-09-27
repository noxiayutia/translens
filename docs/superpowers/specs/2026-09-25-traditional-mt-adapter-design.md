# 传统翻译 API 适配器（单元 F：类型化档案 + Azure Translator）设计规格

日期：2026-09-25 · 状态：待用户执行 · 关联：`2026-09-18-multi-model-profiles-design.md`（档案列表的来源）、`2026-09-20-remove-free-engine-design.md`（§4.2 `resolveEngine` 的现状、§4.3 `supportsGlossary` 的"今日恒真"记账）、`2026-09-14-immersive-translate-extension-design.md`（§3.1 引擎抽象）

> **修订记录（供应商两次更换，逐条记账——这两条比结论本身更值钱）**
>
> | 版本 | 首选 | 为什么换 |
> | --- | --- | --- |
> | v1 | 腾讯云机器翻译 | **接口已下线**（§1.1） |
> | v2 | DeepL API Free | **免费层已停售 + 官方禁止浏览器直连**（§1.2）——用户已按此选定，随后被推翻 |
> | **v3（本文）** | **Azure Translator F0** | 存活、免费档不过期、单密钥、无签名、无浏览器禁令、语言代码与插件一致（§1.4） |
>
> **v2 → v3 的改动面**：§1、§2、§5、§6、§7、§9、§10、§11 重写；**§3（数据模型）、§4（注册表与解析）、§8（迁移）一字未改**——机制与供应商无关，这正是当初把机制单独设计的价值。
>
> **引用纪律**（承 `2026-09-20-apple-visual-style-design.md` §7）：定位代码一律用**符号名、选择器或断言措辞**，**不钉行号**——行号会漂。本文出现的任何数字都是起草时的读数，落地时以真实读数为准。

---

## 1. 需求与这次改动的由来

用户原话：**「加一个传统翻译 API 适配器」**，起点是"腾讯云机器翻译每月 500 万字符免费"这条额度。

### 1.1 腾讯云这条路已经死了

腾讯云官方**更新历史**页（`cloud.tencent.com/document/api/551/17231`，页面更新于 2026-07-08）原文：

| 发布 | 时间 | 变更 |
| --- | --- | --- |
| 第 15 次 | 2026-03-12 | **删除接口**：`TextTranslateBatch`、`FileTranslate`、`GetFileTranslate`、`ImageTranslate`、`LanguageDetect`、`SpeechTranslate` |
| 第 17 次 | 2026-07-08 | **删除接口**：`TextTranslate` |

今天 TMT 的 **API 概览**只剩 `ImageTranslateLLM`（端到端图片翻译，1 次/秒）。而**计费文档**（2026-07-15 更新）仍写着"文本翻译每月 500 万字符免费"——**两份官方文档自己就不一致，且计费页更晚**。那条 500 万字符的额度今天买不到任何东西。

### 1.2 DeepL 也走不通：三条红线（第 3 条是用户指出后补上的）

腾讯作废后首选换成 DeepL API Free（用户 2026-09-25 选定）。随后核实到**三条互相独立**的红线，任何一条都足以否掉它：

| # | 内容 | 后果 |
| --- | --- | --- |
| 1 | **"The DeepL API Free plan can no longer be purchased."**（帮助中心 "DeepL API plans"；API Pro 同样停售） | **免费层已停售**：新注册只能选 API Developer（100 万字符**累计不重置**）或 API Growth（付费档含 1M/月）。"50 万字符/月"这个数字仍留在文档里，但**今天注册不到那个档** |
| 2 | **"The DeepL API does not allow calls directly from browser-based applications."**（`best-practices/cors-requests`） | **官方明令禁止浏览器直连**：浏览器直连吃 `403 blocked by CORS`，官方要求自建后端代理、且 Key 不得出现在客户端代码里 |
| 3 | **用户判断：DeepL 在中国大陆不可访问**（我**没有**核实到官方"不服务中国"的条文；本机只测到"接口层可达"，见本节末段） | **注册与付款这一关就过不去**——拿不到 Key 的接口等于不存在。它同时**推翻了我原先写下的那句"有自建后端就能用"** |

**第 2 条是本单元最该记住的一条**：MV3 的 service worker 配上宿主权限**技术上能绕过去**（浏览器 CORS 对已授权 origin 不拦），但这个插件是**纯客户端架构、没有后端**——绕过去就是**违反供应商条款**地调用。**"技术上做得到"从来不是"可以这么做"的理由。**

#### 记账：我漏了一整栏，还写下了一句错话

1. 派研究员核查那批大模型服务商时，**"大陆是否可达"是我亲自写进任务书的一栏**；到了 DeepL 这一节，我**整栏没查**——同一份规格里两套标准。
2. 更糟的是本节原文里那句「**除非将来这个插件有了自建后端，第 2 条红线才会消失**」：它把地域问题当成不存在。**大陆用户既注册不了、也付不了款，有没有后端都不改变结论**——这句话已按上表第 3 行作废。

#### "网络可达"与"服务可用"是两件事（本机三针读数）

| 探针 | 读数 | 它证明了什么 / 证明不了什么 |
| --- | --- | --- |
| `www.deepl.com`（跟随跳转） | `301 → 200`，最终 `https://www.deepl.com/en` | 消费站**在本机是打开的**——不是被墙的超时 |
| `support.deepl.com` 的 403 正文 | `<title>Just a moment...</title>` | 那是 **Cloudflare 的机器人挑战页**，**不是地域封锁**（curl 没有 JS 就被挡） |
| `api-free.deepl.com` + **假 Key** | `403` + `{"message":"Authentication failed, provided API key is invalid…"}` | **API 层在按语义应答**：它读懂了鉴权头并按业务规则拒绝。被地域拦的话拿不到这种回答 |

**三条合起来只说明"接口层没有地域封锁"**——它们**证明不了**"大陆用户能注册、能付款、能长期稳定使用"，也**推翻不了**用户的判断。**判断一个供应商能不能用，必须问到"凭据怎么来"这一层**（这条已并入 §1.3 的硬规矩）。

### 1.3 从这几次翻车里立的一条硬规矩（长期有效）

> **任何供应商在接线之前，必须先过两道核验：**
> **① 凭据这道闸——能不能注册、能不能付款、我这个地域能不能用；**
> **② 接口这道闸——拿到凭据后真调用一次，看返回体。**
> **任何一道过不去就换家，不许"先写代码、以后再说"。**

理由是本次踩到的四个"会骗人的读数"，没有一个是假想：

1. **端点返回 200 不等于接口存在**：`tmt.tencentcloudapi.com` 对本机返回 `HTTP 200`，体里还是个结构完整的 `Response.Error` 信封——而那个产品的文本接口两个月前就删了。
2. **无签名探针区分不了 Action 是否存在**：实测对 `TextTranslate`、`TextTranslateBatch` 与**故意编造的** `NotARealActionXYZ`，网关返回的是**同一条** `InvalidParameter`（签名之前就解析失败）。**从这条读数"推出接口在"是无效推理**——我当时差点就这么干了。
3. **状态码活着，服务死了**：GitHub Models 返回 `200` + 正文 `OK`，而它已于 2026-07-30 全面退役；DeepL 的 `403` 被我读成"缺 Key 而已"，实际它头上有三条红线（§1.2）。
4. **接口可达，不等于你能用**：DeepL 的三针读数（§1.2 末段）显示域名能解析、跳转能落地、API 能按语义拒绝一个假 Key——**而"大陆用户拿不到凭据"这件事照样成立**。卡住的是**注册与付款**，不是网络。**这一条是第 ① 道闸存在的原因**：原来的规矩只问了"接口活不活"，而真正先撞上的往往是"账号能不能建"。

落点：**§10 的第 0 步是"先拿到凭据、再用真凭据真翻一句"**——不是"端点有没有响应"，也不是"我先把代码写好再说"。它是执行的第一步，不是可选项。

### 1.4 已拍定的决定（v3）

| 决定点 | 结论 |
| --- | --- |
| 第一个适配器做谁 | **Azure Translator F0**（`kind: 'azure-translator'`） |
| 为什么是它（六条，全部有官方原文） | ①**免费档存在且不过期**："Each subscription has a free tier. The free tier has the same features and functionality as the paid plans and **doesn't expire**."（每订阅仅一个免费档资源）；②**单密钥、零签名**：`Ocp-Apim-Subscription-Key` 头，插件现有的 `apiKey` 字段直接用，不需要 HMAC/MD5；③**不需要 `region` 字段**：Global 资源 + Global 端点只需 Key（"Choose Global unless your business or application requires a specific region"）；④**批量与对序都有官方保证**：单请求最多 **1000 元素**、5 万字符，"returned in the **exact same order** as in the request"；⑤**语言代码与插件现有取值几乎一致**（`zh-Hans` / `zh-Hant` / `en`…），不需要大小写转换；⑥**没有浏览器禁用条款**，且官方为客户端场景提供了短时 token 端点（本单元不用，见 §2） |
| 其余各家 | 见 §1.5。有道/阿里云/百度**都已实测存活**但本次不做（双凭据签名 / 需要 MD5 而 WebCrypto 不提供 / 额度太小），机制上留好位置 |
| 腾讯云 | **不做**（§1.1）。README 与任何文案里都不许再出现"腾讯云机器翻译"作为可用选项 |
| DeepL | **不做**（§1.2）。同上：任何文案里都不许把 DeepL 列为可用选项 |

### 1.5 本次的两道闸读数（本机实测，2026-09-25）

| 服务 | ①凭据这道闸 | ②接口这道闸（无凭据实测） | 免费额度 | 本次 |
| --- | --- | --- | --- | --- |
| **Azure Translator F0** | ⚠️ **未核验**：Azure 账号能否从这里注册/付款**我没查**（§11 第 2 条）。**第 0 步的第 1 条就是它** | `200`（languages 端点） | 免费档**不过期**（官方原文）；**月度字符数未能核实**（官方限制页给的是 F0 **每小时 200 万字符**的节流口径，月度数字只在 JS 渲染的定价页上） | **做** |
| ~~DeepL API Free~~ | ❌ **过不去**：免费层已**停售**（红线 1），且用户判断**大陆不可访问**（红线 3） | `301→200`（消费站）、`403`+Cloudflare 挑战页（帮助站）、`403`+语义化"key invalid"（API）→ **接口层可达** | — | **不做**（两条红线，另加条款禁止，§1.2） |
| 有道智云 | ⚠️ 未核验（要实名 + 加客服才拿满体验金） | `{"errorCode":"108"}` | ¥100 体验金 ≈ 200 万字符（**一次性**） | 不做（SHA-256 签名 + 两个凭据） |
| 阿里云 alimt | ⚠️ 未核验（要阿里云账号 + AccessKey 对） | `{"Code":"MissingTimestamp"}` | **未能核实** | 不做（ACS3 签名 + 两个凭据，成本最高） |
| 百度翻译 | ⚠️ 未核验 | `{"error_code":"52003"}` | 标准版约 5 万字符/月（≈6 页/月） | 不做（**要 MD5，WebCrypto 不提供**） |
| ~~腾讯云 TMT~~ | — | 接口已下线 | 计费页仍写 500 万字符，**无接口可用** | **不做**（§1.1） |

> ⚠️ **这张表教了两件事**：①`403` / `200` 这类状态码**只能证明"端点活着"**，证明不了"这个产品今天还能用"；②**"接口活着"更证明不了"你能拿到 Key"**——DeepL 那三针全绿（接口层），而它照样是个不能选的对象。**所以第 ① 道闸（凭据）必须单独问一次，问的对象是"我这个地域、我这个支付方式"。**

---

## 2. 范围与非目标

**范围内**：`src/engines/types.ts`（`Translator` 契约加 `needsModel`）、`src/engines/registry.ts`（注册第二个适配器 + `kindNeedsModel`）、**新增** `src/engines/azure-translator.ts`、**新增** `src/engines/host-access.ts`（宿主权限那道闸提取共用）、`src/engines/openai-compat.ts`（改用共用的权限闸）、`src/shared/settings.ts`（`EngineProfile.kind`、`resolveEngine` 按类型解析、`firstUsableProfileId` 类型感知、v5 → v6 迁移、`PROVIDER_PRESETS` 加 `kind`）、`src/options/sections/engine.ts`（类型选择、字段按类型显隐、模板、行副标题）、`README.md`（§9.1 逐行给出）。

**非目标（明确不做，且每条都有理由）**：

- **不做 DeepL 适配器**（§1.2）。**不是"暂时不做"，是"不做"**——除非将来这个插件有了自建后端，第 2 条红线才会消失。
- **不做腾讯云适配器**（§1.1：文本接口已下线）。
- **不做有道 / 阿里云 / 百度适配器**：机制留好，但今天没有消费者就不写（本仓纪律："定义了没人用"的亏已经吃过）。
- **不加 `apiSecret` 字段**：它曾经的唯一消费者是腾讯（SecretId + SecretKey 双凭据），**腾讯已死**；Azure 是单密钥。等真接有道/阿里云那天再加，加的时候按 `apiKey` 那套规矩（不回填、留空保存即保留、脱敏）。
- **不加 `region` 字段**：Azure 的 Global 资源 + Global 端点只需要 Key。**如实记账一处边界**：若用户建的是**区域级**资源，不带 `Ocp-Apim-Subscription-Region` 会拿到 **401**——症状是"Key 无效"，会把用户指向错误的方向。处置：①模板与提示里**明写"资源区域选 Global"**；②适配器的 401 文案**必须同时点出这两种可能**（§7）。
- **不做术语表**：Azure 的术语能力走 dynamic dictionary（限定格式的字面替换）或 Custom Translator（要训练并部署自定义系统），与插件的 `Term` 形状对不上。v1 `supportsGlossary: false`，如实记账。
- **不做 token 鉴权（`/sts/v1.0/issueToken`）**：官方为客户端场景提供短时 token；但本插件把 Key 存在 `chrome.storage.local`、**从不进内容脚本的设置投影**（既有隐私设计），风险面已经很小，多一套 token 生命周期管理是净负债。记为**将来可加**，不是承诺。
- **不做"已用额度"显示**：响应头 `X-metered-usage` 会回本次计费字符数，但把它变成界面读数需要新的状态存储与文案，v1 不做。
- **不改缓存 key 的形状**：见 §4.5。
- **不做分块发送**：见 §5.4（这一条是**推理**，且我**不为它编一条没有牙的断言**——理由写在那一节）。

---

## 3. 数据模型：`kind`

### 3.1 `EngineProfile` 加一个字段

```ts
export interface EngineProfile {
  id: string;
  label: string;
  /** 这个档案用哪个适配器。读取口径见 §3.2：缺失 = 老数据（openai-compat），认不出的字符串 = 原样保留。 */
  kind: string;
  baseUrl: string;
  models: string[];
  activeModel: string;
  apiKey: string;
}
```

`kind` 的**唯一权威取值来源**是引擎注册表（`ENGINES.map(e => e.id)`）；界面只允许写入注册表里有的 id（§6）。类型写成 `string` 而不是联合类型，与 `engineId` 同一个理由：**存储边界能装下任何东西**，"认不出来怎么办"必须是一条显式规则（§3.2），而不是靠类型系统假装它不会发生。

### 3.2 读取口径：缺失 ≠ 认不出（本单元最要紧的一条）

| 存储里的 `kind` | 读取结果 | 理由 |
| --- | --- | --- |
| **缺失 / 非字符串**（v5 及更早的数据） | 补成 `'openai-compat'` | v5 时代**只存在一个适配器**，所以"没有这个字段"这件事**按构造**只可能是 openai-compat。这不是"替用户猜"，是"这份数据的来源只有一种可能" |
| **字符串但注册表里没有**（未来版本写的、手工改的） | **原样保留**，交给 `resolveEngine` 判成"用不了 + 一句可行动的话 + 零请求" | 反过来做（强判成 openai-compat）会把一份 Azure 的密钥拿 OpenAI 协议发出去——那是**猜**，而猜错的方向是"拿着用户的密钥发一次注定失败的请求" |

落点：`pickProfile` 只做上表第一行；第二行**不动它**。

---

## 4. 引擎注册表与解析的新形状

### 4.1 `Translator` 契约：加 `needsModel`

```ts
export interface Translator {
  id: string;
  name: string;
  needsKey: boolean;
  supportsGlossary: boolean;
  /** 这个适配器是否需要"模型"这个概念。为 false 时档案不需要模型清单，也不该因为 activeModel 为空被判成用不了。 */
  needsModel: boolean;
  translate(request: TranslateRequest, config: EngineConfig): Promise<string[]>;
}
```

取值：`openai-compat: true`、`azure-translator: false`。它是**适配器契约**（与 `needsKey` / `supportsGlossary` 同一类），不是"以后可能用得上"的字段——今天 `resolveEngine` 就靠它决定"没有模型算不算错误"。

`ENGINES` 变成两个成员。**`tests/engines/registry.test.ts` 里那条 `expect(ENGINES.map((e) => e.id)).toEqual(['openai-compat'])` 必须改成 `['openai-compat', 'azure-translator']`**——那条断言的**意图**是"引擎名单被改动时当场红"，钉住确切名单这件事要保留，**不许改成 `toContain`**（那会失去一半的牙）。

### 4.2 `resolveEngine`：唯一解析点，按类型走

```ts
export function resolveEngine(settings: Pick<Settings, 'engineId' | 'profiles'>): ResolvedEngine {
  const profile = settings.profiles.find((item) => item.id === settings.engineId);
  if (profile === undefined) return { engine: null, config: {}, problem: NO_ENGINE_PROBLEM };
  const engine = getEngine(profile.kind);
  // 认不出的类型：保留档案、不发请求、给一句可行动的话（与"没有可用引擎"同为 AUTH 路径）
  if (engine === null) return { engine: null, config: {}, problem: UNKNOWN_KIND_PROBLEM };
  const config: EngineConfig = {
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: engine.needsModel ? profile.activeModel : undefined,
  };
  if (engine.needsModel && profile.activeModel.trim().length === 0) {
    return { engine, config, problem: NO_MODEL_PROBLEM };
  }
  return { engine, config };
}
```

四条必须写下来的口径：

1. **"没有模型"只在 `needsModel` 为真时才是一个问题**。这是本单元对 v5 语义的**唯一**放宽：v5 里"有档案 ⟹ 必须有当前模型"，因为当时唯一的适配器都有模型。
2. **认不出的类型与"没有可用引擎"共用返回形状**（`engine: null` + `problem`），但**不共用文案**：`UNKNOWN_KIND_PROBLEM` 要说清"这个档案的类型本版本不认识"，而不是"去添加一个档案"——后者会让一个明明配过档案的用户去再配一遍。
3. **`config.model` 对不需要模型的类型是 `undefined`**，不是 `''`：空串会一路流进缓存 key（§4.5），而"没有模型"与"模型名是空串"是两件事。
4. **`getEngine` 一个字不改**：它对不认识的 id 返回 `null`，这条语义正是本单元要复用的。

### 4.3 `UNKNOWN_KIND_PROBLEM`：新常量，唯一来源

```ts
/** 「档案类型认不出」那句话的唯一来源（与 NO_MODEL_PROBLEM / NO_ENGINE_PROBLEM 同级）。 */
export const UNKNOWN_KIND_PROBLEM =
  '这个档案的类型当前版本不认识（可能是更高版本的插件创建的），请更新扩展或改用其它档案';
```

错误码沿用 `AUTH`（与 `NO_ENGINE_PROBLEM` 同一条路：内容脚本对 `AUTH` 原样透传 message，且 `AUTH` 不在 `RETRYABLE_CODES` 里，不会挂一排点了必然失败的重试按钮）。

### 4.4 `firstUsableProfileId` 必须变成类型感知

它今天的判据是"第一个 `activeModel` 非空的档案"。加进不需要模型的类型之后，这条判据**会把一个配好的 Azure 档案判成不可用**，于是"删掉当前档案后的回落"与"v5 迁移"两处都会跳过它。

```ts
/** 注册表里查这个类型要不要模型；认不出的类型按"要"处理（保守：不会被选中）。 */
export function kindNeedsModel(kind: string): boolean {
  return getEngine(kind)?.needsModel ?? true;
}

export function firstUsableProfileId(
  profiles: readonly Pick<EngineProfile, 'id' | 'activeModel' | 'kind'>[],
): string {
  return (
    profiles.find((p) => !kindNeedsModel(p.kind) || p.activeModel.trim().length > 0)?.id ?? ''
  );
}
```

三个调用方都要跟着改，且**判据仍然只有这一份**：`dropFreeEngineSelection`（v4 → v5 迁移，它的生数据投影要**多投影一个 `kind`**）、设置页删除当前档案的回落、以及任何读它的地方。

`kindNeedsModel` 放在 `engines/registry.ts`（它查的是 `ENGINES`），`settings.ts` 已经在 import 这个模块，不引入新的分层依赖。

### 4.5 缓存 key：只如实记账，**不改形状**

`src/core/hash.ts` 的 `buildCacheKey` 收 `engineId`，而 `scheduler.ts` 传的是 **`deps.engine.id`（适配器 id）**，不是档案 id。两个后果都在本单元之前就存在，本次**不改**：

- 同类型、同地址的两个档案（两个 Azure 密钥）**共用缓存条目**。对本插件是良性的：同一段文本的译文与用哪个 Key 无关。
- 适配器 id 变了（openai-compat → azure-translator）就换了 key 空间，**老缓存自然不会被新引擎误用**——这正是我们要的方向。

**为什么不动它**：改 key 形状 = 让所有现存缓存一次性失效（用户会觉得"更新完变慢了"），而本次没有任何一条真实威胁需要付这个代价。如实记账，不顺手改。

---

## 5. Azure Translator 适配器（`src/engines/azure-translator.ts`）

### 5.1 契约取值

```ts
export const azureTranslatorEngine: Translator = {
  id: 'azure-translator',
  name: 'Azure 翻译',
  needsKey: true,
  supportsGlossary: false,   // §2：dynamic dictionary / Custom Translator 与 Term 形状对不上
  needsModel: false,
  async translate(request, config) { /* §5.2–§5.8 */ },
};
```

**`supportsGlossary: false` 让 v5 里那句"今日恒真、无判别力"的记账第一次有了判别力**：`service-worker.ts` 里 `glossary: engine.supportsGlossary ? … : undefined` 与 `systemPrompt: …` 两行从此对 Azure 走 `undefined` 分支；弹窗里那条"当前引擎不支持术语表"的分录也第一次可达。**本单元要为此补断言**（§9.2），因为这是该契约第一次真正承重。

### 5.2 端点

- 模板预填 `https://api.cognitive.microsofttranslator.com`（**Global 端点**，官方推荐写法）。
- 请求 URL = `{baseUrl 去掉尾部斜杠}/translate?api-version=3.0&to=<目标语言>[&from=<源语言>]`。
- 地址由用户填、权限按那个 origin 申请（§5.8）——与 `openai-compat` 同一条规矩：**适配器不偷偷换域名**（换了就落在没授权的 origin 上，错误会伪装成"断网"）。

### 5.3 请求

```
POST {baseUrl}/translate?api-version=3.0&to=zh-Hans[&from=en]
Ocp-Apim-Subscription-Key: {apiKey}
Content-Type: application/json; charset=UTF-8

[{"Text":"段1"},{"Text":"段2"}, …]
```

- body 是**数组**，每项一个 `Text` 字段（官方文档给的就是这个形状）；顺序即输入顺序。
- `from` **只在 `request.from !== 'auto'` 时带**；`'auto'` 时整条省略（官方："If the `from` parameter isn't specified, automatic language detection is applied"）。
- 沿用 `fetch(..., { signal: request.signal })`；`AbortError` → `EngineError('ABORTED', '请求已取消')`，与 `openai-compat` 同一口径。
- **不要手写 JSON 字符串拼接**：用 `JSON.stringify(texts.map((t) => ({ Text: t })))`。

### 5.4 批量：一次请求，**不写分块**

- Azure 单请求上限：**1000 个数组元素 / 5 万字符**（官方 "Character and array limits per request"）。
- 本插件一批最多 `maxSegmentsPerBatch` 段，而 `mergeSettings` 对它的夹取区间是 **1–50**（默认 12）；字符数另有 `maxBatchChars`（默认 1000，夹取上限 8000）⇒ **余量 20 倍与 6 倍以上，分块不可达**。
- 因此**不写**分块代码。**也不为它编一条断言**：DeepL 那边（50 条上限）值得钉一条"夹取上限 ≤ 50"的守卫，是因为两个数字**相等**、任何一方漂移都立刻出问题；这里 50 vs 1000 相差 20 倍，编一条 `expect(50).toBeLessThanOrEqual(1000)` 是**没有牙的断言**（本仓纪律：不为读不到的东西编断言）。
- ✅ **但仍要记一句触发条件**：哪天有人把 `maxBatchChars` 提到 5 万以上、或把 `maxSegmentsPerBatch` 提到 1000 以上，这条推理需要重新检查。**超长的单段**（`planBatches` 会让超过 `maxBatchChars` 的单段独占一批）由服务商的 400 如实回报，见 §5.6。

### 5.5 响应与对序

- 成功体是**数组**，每个元素对应一条输入，**顺序有官方保证**：

```json
[ { "detectedLanguage": {"language":"en","score":1.0},
    "translations": [ {"text":"你好","to":"zh-Hans"} ] } ]
```

- 校验三件事，任一不满足即 `EngineError('BAD_RESPONSE', …)`：① 顶层是数组；② `length === request.texts.length`；③ 每项 `translations[0].text` 是**非空字符串**。**不猜、不补齐、不跳过**——与 `parseNumberedResponse` 的契约同源（数量不符就是坏响应）。
- `translations[0]` 的取法：本插件一次只请求一个目标语言，所以 `to` 只会有一个；若将来要一次多目标，这里才需要按 `to` 挑。

### 5.6 状态码 → 错误码

| HTTP | 归类 | 文案要点（可行动） |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 带上正文里 `error.message`（`describeHttpError` 已经能读 `{"error":{"message":…}}`，**直接复用，不另写一份**）。超长单段也走这条，用户看得到服务商给的原因 |
| **401** | `AUTH` | **必须同时点出两种可能**：密钥不对，**或资源建在具体区域上而请求没带区域头**（§2 的边界） |
| **403** | `AUTH` | 官方：该码常表示"trial 订阅的免费翻译额度已用完"。文案要点明免费额度用尽/该密钥无权限，**不可重试** |
| 408 | `NETWORK` | 官方说"应等待后重试" → 归进可重试 |
| 429 | `RATE_LIMIT` | 沿用既有退避与降并发（`RETRYABLE_CODES` 已含它） |
| 5xx / 503 | `NETWORK` | 官方对 503 明说"Retry the request"；沿用 `statusToErrorCode` 的既有判据（`src/engines/api-error.ts`），**不再写一份** |

### 5.7 语言代码映射：**直通**（这是 Azure 相对其它几家的最大便利）

插件侧取值来自 `core/lang.ts` 的 `LANGUAGES`：`zh-Hans` / `zh-Hant` / `en` / `ja` / `ko` / `fr` / `de` / `es` / `ru`——**Azure 用的就是同一套写法**（官方示例即是 `to=zh-Hans`）。所以：

- **大小写与分隔符一律不动**，直接透传。
- **源语言**：`from === 'auto'` → 省略查询参数；否则透传。
- **认不出的代码 → `EngineError('BAD_REQUEST', 'Azure 翻译不支持目标语言「X」，请在弹窗里换一个目标语言')`，零请求**——不把原文当语言代码发出去。
- ⚠️ **执行时的第 0 步要实测 `zh-Hans` 与 `zh-Hant` 两格**（§10）：这一节是"文档说是这套写法"，而文档与实际偶有出入，实测一次的成本是 10 秒。

### 5.8 宿主权限：把这道闸提取成共用件

`openai-compat.ts` 今天内联着这段逻辑：`originPattern(baseUrl)` → 解析不出来就报"地址不是合法 URL" → `hasHostPermission(pattern)` 为假就报"未授权访问该接口地址，请到设置页保存一次以授权"。**它是纯的、与协议无关的**，第二个适配器要用同一份。

落点：**新增 `src/engines/host-access.ts`，导出 `assertHostAccess(baseUrl: string): Promise<void>`**，两个适配器都调它。两条纪律：

- **不许各写一份**（先例：`isAllowedBaseUrl` 两处各写一份必然漂移）。
- 文案的**唯一来源**留在新模块里，`openai-compat` 那两句话原样搬过去、一个字不改（有测试逐字钉着它们）。

---

## 6. 设置页 UI

### 6.1 类型选择：新增 `.profile-kind`（"类型"）

- 选项来自新的唯一来源常量 `PROFILE_KINDS`（`{ id, label, needsModel }`，`needsModel` 从注册表推导，不各写一份）。
- 位置：编辑器「自定义设置」折叠区里的**第一项**，在「服务商模板」之上（模板会写它，用户也能直接改）。
- 认不出的类型（§3.2 第二行）在下拉里**没有对应项**：显示一个"未知类型（{原值}）"的只读项，**不许**悄悄把它改成别的类型。

### 6.2 字段按类型显隐（判据来自 `needsModel`）

| 元素 | `needsModel: true`（openai-compat） | `needsModel: false`（azure-translator） |
| --- | --- | --- |
| `.models-field`（模型目录整块） | 显示 | **整块隐藏**（含「⟳ 获取可用模型」、清单、空态说明——Azure 没有 `/models`，留着按钮等于骗用户去点一个必然失败的请求） |
| `.profile-base-url` 占位符 | `https://api.openai.com/v1` | `https://api.cognitive.microsofttranslator.com` |
| Key 字段标签/占位符 | 现状（"粘贴你的 API Key"） | 「Azure 订阅密钥」+ 占位符点明"Keys and Endpoint 页里的 KEY 1" |
| 新增一行类型说明（只读） | 无 | 「免费档（F0）功能与付费档相同、**不过期**；官方按字符计费，F0 的限制口径是**每小时 200 万字符**（月度额度以 Azure 定价页为准）。⚠ 创建资源时**区域请选 Global**——区域级资源需要额外的区域头，本版本不支持，症状是「密钥无效」。」 |

**隐藏 ≠ 清空**：切类型时模型清单要**原样留在存储里**（切回 openai-compat 时还在）。这条与"显示模式改动不重译"同源——界面的可见性不该毁用户的数据。

### 6.3 服务商模板：`PROVIDER_PRESETS` 加 `kind`，并加一个 Azure 条目

```ts
{ id: 'azure', label: 'Azure 翻译（免费档）', kind: 'azure-translator',
  baseUrl: 'https://api.cognitive.microsofttranslator.com' }   // 无 model
```

- `ProviderPreset` 加 `kind`（必填），现有三条（OpenAI / DeepSeek / Ollama）都补 `kind: 'openai-compat'`。
- `applyProviderTemplate` 除地址与模型外，**还要写类型下拉**；模板不带 `model` 时**不许**动模型清单（Azure 的档案该是 `models: []`）。
- 模板匹配（`isPresetBaseUrl` 那个判据）改成**先比 `kind`、再比 `baseUrl`**：只比地址的话，未来两个模板共用域名时会认出错的模板；而 Azure 的档案一旦改过地址，下拉就该翻回「自定义」（现有语义不变）。

### 6.4 行副标题

档案行的 `baseUrl · model` 小字，对 `needsModel: false` 的类型改成 **`类型名 · baseUrl`**（Azure 行显示 `Azure 翻译 · https://api.cognitive.microsofttranslator.com`）。理由：一个恒为空的后半段（`baseUrl · `）是界面在说"这里本该有个模型"。

---

## 7. 用户可见文案（唯一来源，逐条给出落点）

| 场景 | 文案 | 由谁产出 |
| --- | --- | --- |
| 档案类型认不出 | `UNKNOWN_KIND_PROBLEM`（§4.3 字面） | `resolveEngine`（唯一来源），弹窗/设置页/后台只显示 |
| 没有可用引擎 | `NO_ENGINE_PROBLEM`（**原样不动**） | 同上 |
| 没有当前模型 | `NO_MODEL_PROBLEM`（**原样不动**，但只在 `needsModel` 为真时出现） | 同上 |
| 缺 Key / 缺地址 | 沿用引擎层的既有两句（`'尚未填写 API Key，请在设置中配置'`） | 适配器 |
| **401** | `'Azure 拒绝了这次请求：密钥无效，或这个资源建在具体区域上（本版本只支持区域为 Global 的资源）——请在设置页核对密钥与资源的区域'` | 适配器 |
| **403** | `'Azure 免费额度已用完，或该密钥没有翻译权限（免费档功能与付费档相同，但额度有限）'` | 适配器 |
| 语言不支持 | `'Azure 翻译不支持目标语言「{code}」，请在弹窗里换一个目标语言'` | 适配器 |
| 响应对不上 | 沿用 `BAD_RESPONSE` 的可读原因（"接口返回 N 条，期望 M 条"） | 适配器 |
| README | 见 §9.1 | — |

**文案纪律**：上面每一条只在一个地方写（适配器或 `settings.ts`），界面只负责显示；不许在弹窗/设置页再抄一份（先例与理由见 `NO_ENGINE_PROBLEM` 的注释）。

---

## 8. 迁移：v5 → v6

- `CURRENT_VERSION`: **5 → 6**。
- 迁移**只做一件事**：给每个档案盖上 `kind: 'openai-compat'`（v5 时代只存在这一个适配器，见 §3.2 第一行）。
  - ⚠ **该条已作废（Batch 1.5 执行时实测推翻，原文保留在此不删）**：这一步在任何路径下都**不可观测**
    ——`migrate` 的唯一调用点在 `loadSettings` 里，它的产物只经过 `mergeSettings`、**从不回写磁盘**；
    而所有落盘都走 `saveSettings(Settings)`，那份 `kind` 由读入口 `pickKind` 在下一次读时补齐。
    盖章因此只是把 §3.2 第一行的判据**抄第二遍**，而"抄第二遍"正是本仓反复记账要避免的东西
    （`isAllowedBaseUrl`、`NO_ENGINE_PROBLEM` 的先例）。**已删除该步骤，v6 只保留版本号**
    （`CURRENT_VERSION = 6` 仍是"这份数据由哪一版语义产生"的标记，也是将来 v7 的闸门）。
    kind 的唯一判据是 `pickKind`，两个使用方：`pickProfile` 与 v4 → v5 迁移的生数据投影。
    下面两条（幂等靠版本闸门、生数据先投影）作为 §8 对**任何**迁移步骤的一般纪律继续有效，
    只是 v6 今天没有步骤可套。
- 幂等靠 `migrate` 开头那道版本闸门，与 v1–v5 同一口径；**不新增第二个判据**。
- 生数据形状：`profiles` 可能是 `undefined` / 非数组 / 装着非对象（先例见 `dropFreeEngineSelection` 的注释）——迁移必须沿用"先投影形状、再问判据"的写法，不许直接 `as EngineProfile[]`。
- v5 及更早的迁移链**一个字不动**。

---

## 9. 测试与守卫（每条都要写清"牙在哪"）

### 9.1 README 必须改的行

| 位置 | 现状 | 改成 |
| --- | --- | --- |
| 「翻译引擎」表 | 只有一行「**服务商档案**（OpenAI 兼容 API）」 | 加一行「**传统翻译 API**（Azure 翻译 免费档）｜需要 Key｜走 `api.cognitive.microsofttranslator.com`，单密钥、无签名；免费档不过期，按字符计费」 |
| 「服务商模板」那句 | 「OpenAI / DeepSeek / Ollama（本机）」 | 加「Azure 翻译（免费档）」；说明模板会**同时**写好档案类型 |
| 「快速开始」第 2 步 | 三个模板 | 四个；补一句"Azure 这类没有模型清单，不需要拉模型；创建资源时区域选 Global" |
| 「当前版本的真实限制」 | 「唯一的适配器恒为 `true`（术语表）」那段记账 | 改成如实的"两个适配器：`openai-compat` 为 `true`、`azure-translator` 为 `false`；不支持术语表的引擎在弹窗里有对应提示" |
| 目录结构那节 | 「适配器（OpenAI 兼容…）」 | 「适配器（OpenAI 兼容 / Azure 翻译）」 |
| 隐私节 | 密钥规矩 | 补一句"档案的密钥规则对每种类型一致：不回填、留空保存即保留、不进内容脚本的投影" |

**不许**在 README 里出现"腾讯云机器翻译"或"DeepL"作为可用选项（§1.1、§1.2）。

### 9.2 新增测试

**`tests/engines/azure-translator.test.ts`（新文件）**：

1. **请求形状**：URL 含 `api-version=3.0` 与 `to=zh-Hans`；方法 POST；`Ocp-Apim-Subscription-Key` 头正确；body 是 `[{"Text":…}]` 数组且**顺序与输入一致**。**牙**：把 body 拼成单个字符串、或把顺序打乱，这条红。
2. **`auto` 源语言**：`from: 'auto'` 时 **URL 里没有 `from=`**；`from: 'en'` 时有 `from=en`。**牙**：无条件带 `from=auto` 时红。
3. **对序与条数**：两段输入 → 断言返回顺序；响应数组只有 1 条时抛 `BAD_RESPONSE`；`translations[0].text` 为空串时抛 `BAD_RESPONSE`。**牙**：删掉长度校验或空值校验，对应那条红。
4. **状态映射**：401 → `AUTH`；**403 → `AUTH` 且 `retryable === false`**；429 → `RATE_LIMIT` 且 `retryable === true`；400 → `BAD_REQUEST`；503 → `NETWORK`。**牙**：把 403 归进 `RATE_LIMIT`（挂重试）时，`retryable === false` 那条红。
5. **前置闸**：空 `apiKey` / 空 `baseUrl` → `AUTH`，**`fetch` 未被调用**（成对断言：填好之后 `fetch` 被调用一次）。**牙**：把判空删掉时后半条红。
6. **不认识的语言**：`to: 'xx-Unknown'` → `BAD_REQUEST` **且零请求**。
7. **取消**：`abort` 之后抛 `ABORTED`。
8. **两条契约常量**：`needsModel === false`、`supportsGlossary === false`（后者今天承重，见 §5.1）。

**`tests/engines/registry.test.ts`**：名单断言改成两个成员（§4.1）；补 `kindNeedsModel('azure-translator') === false`、`kindNeedsModel('openai-compat') === true`、`kindNeedsModel('不认识') === true`（**成对三条**，第三条是"认不出按要模型处理"的牙）。

**`tests/shared/settings.test.ts`**：

- `resolveEngine` 按 `kind` 取到 `azure-translator`，且 `config.model === undefined`；
- **成对**：Azure 档案 `activeModel: ''` **不**带 `NO_MODEL_PROBLEM`；openai-compat 档案 `activeModel: ''` **带**它（两半都要有，否则"放宽"会变成恒真）；
- 认不出的 `kind` → `engine === null` + `UNKNOWN_KIND_PROBLEM` + **零请求**（成对正例：同一条数据把 kind 换成 `azure-translator` 就能发出去）；
- `pickProfile`：`kind` 缺失 → `'openai-compat'`；`kind: '未来类型'` → **原样保留**（§3.2 第二行的牙）；
- v5 → v6 迁移：老数据每个档案都盖上 `kind`；重复读幂等；`profiles` 缺失/脏形状不抛；
- `firstUsableProfileId`：Azure 档案（无模型）**算可用**；openai-compat 无模型**不算**（成对）。

**`tests/options/*`**：

- 类型下拉切换 → `.models-field` 的 `hidden` 跟着变（**两个方向都测**）；
- 切类型**不清空**已存的模型清单；
- 模板选中 → 类型、地址（、模型，若有）三样都写对；Azure 模板**不动**模型清单；
- `.profile-api-key` 的 **value 恒为空**（现有断言在新类型下**也要成立**——参数化，而不是只测 openai 那条路径）；
- 行副标题对 azure 显示 `类型名 · baseUrl`。

**`tests/background/service-worker.test.ts`**：一个**没有模型**的 Azure 档案能真的发出请求（成对：同样没有模型的 openai-compat 档案被 `NO_MODEL_PROBLEM` 拦下、零请求）。**牙**：把 `needsModel` 判断删掉，前半条红。

**`tests/engines/openai-compat.test.ts`**（已存在）：权限那道闸搬到 `host-access.ts` 之后，**原有断言一个字不改地继续绿**——这是"提取共用件没有改变行为"的证据。

**`tests/core/layering.test.ts`**：`src/engines/*` 仍必须能在纯 Node 里 import（`host-access` 不许在模块顶层碰 `chrome`）。

### 9.3 不许编的断言

- 不为"未知类型"在 UI 上的渲染单编一条只读它的断言——它由 §9.2 的 `resolveEngine` 两条成对用例覆盖。
- 不为 §5.4 的"分块不可达"编断言（**没有牙**，理由已写在那一节）。
- 不给 `supportsGlossary` 恒真分支补"测了等于没测"的用例（v5 的纪律照旧）；本单元补的是 **Azure 侧为 `false`** 的那一条，它有判别力。

---

## 10. 执行顺序（第 0 步是两道闸核验，不可跳过）

**第 0 步——两道闸（做完再写一行代码）**

**0-A 凭据闸 —— 先做这道，它才是最容易卡住的那道：**

1. 建 Azure 账号 → 建 **「Translator」单服务资源**，**区域选 Global**，定价层选 **F0（免费）**；在「Keys and Endpoint」页复制 **KEY 1** 与端点。
2. ⚠️ **这一步过不去就当场换方案，不要"再等等"。** 以本机的网络处境（google.com / openai.com / huggingface.co 全部不可达），"国际版 Azure 能不能从这里注册、能不能付款"是一个**真实存在的不确定性**，而它**不是代码能解决的**。
   换什么：**本机自建 LibreTranslate**（Docker 起一个服务即可）——**没有账号、没有额度、没有地域问题、没有条款限制**，`POST /translate` 的 `q` 支持数组且天然对序，适配器的形状与 Azure 这版几乎一样（同样单密钥、可留空、`needsModel: false`）。代价是翻译质量低于商业 MT、且要跑一个本地服务（与 Ollama 同一类取舍）。**这个回退方案本文不展开，等第 0 步的结果再定——但它必须在第 0 步就被想到，而不是写完全部代码之后才发现。**

**0-B 接口闸 —— 拿到 KEY 1 之后：**

本机真调用一次。**⚠ 不要把 JSON 内联进命令行**——Windows PowerShell 会吃掉内嵌双引号，本次已经在腾讯那轮栽过一次（送出去的 body 变成坏 JSON，而三条不同 Action 返回同一条错误、读数完全无效）。**写进文件再送**：

```powershell
$body = '[{"Text":"hello"},{"Text":"world"}]'
$f = Join-Path $env:TEMP 'az.json'
[System.IO.File]::WriteAllText($f, $body, (New-Object System.Text.UTF8Encoding($false)))

curl.exe -s -X POST "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans" `
  -H "Ocp-Apim-Subscription-Key: <KEY1>" `
  -H "Content-Type: application/json; charset=UTF-8" `
  --data-binary "@$f"
```

2. 判据（四条都要满足）：返回 JSON **数组**、两条译文、**顺序与输入一致**、`to` 回显 `zh-Hans`。
3. 再各跑一次：`to=zh-Hant`（验繁体代码）、**省略 `from`**（验自动检测与 §5.3 的口径）。
4. 若上两条不成立 → **停下来，把读数写回本规格**（改的是对应那一节的表格，不是悄悄改代码）；**也不要把"接口通了"当成"凭据闸也过了"**——那是 §1.3 第 4 条明令禁止的推论。

**第 1 步**：`Translator.needsModel` + 注册表 + `kindNeedsModel`（§4.1、§4.4）——纯契约层，测试先绿。
**第 2 步**：`EngineProfile.kind` + `pickProfile` 口径 + `resolveEngine` 重写 + `UNKNOWN_KIND_PROBLEM` + v6 迁移（§3、§4.2–§4.4、§8）。
**第 3 步**：`host-access.ts` 提取，`openai-compat` 改用共用件（**原有测试必须全绿**，§9.2）。
**第 4 步**：`azure-translator.ts` + 它的单测（§5、§9.2）。
**第 5 步**：设置页 UI（类型下拉、字段显隐、模板、行副标题）+ UI 测试（§6、§9.2）。
**第 6 步**：README 六处（§9.1）。
**第 7 步（真机验收，必须人操作）**：设置页新增一个 Azure 档案 → 「测试连接」出译文 → 回弹窗选中它 → 翻一个真实英文页 → DevTools Network 里**请求数 ≈ 批次数（每批 ≤12 段一条请求）**、译文段落数与原文一致 → 恢复原文再翻一次，**全部命中缓存（零请求）**。

---

## 11. 自审：本规格里"未核实"与"刻意留白"的清单

1. **Azure F0 的月度免费字符数未能核实**：官方限制页给的是 **F0 每小时 200 万字符**（滑动窗口，约 33,300 字符/分钟）这一档**节流**口径；月度数字只在 JS 渲染的定价页上。**执行前建议在 Azure 门户的定价层页面自己看一眼**——这是唯一一个会直接影响"能翻多少页"的数字。
2. **凭据闸整个没核验过**（§1.3 的第 ① 道闸）：Azure 账号**能不能从这里注册**、**要不要信用卡**、**账户地区会不会影响 F0 资源的创建**——三条都未核实。官方只说 "you need an active Azure account"，未提支付方式或地区。**这是你在第 0 步会立刻撞到的事**（比接口那一步更早），也是把两道闸放在最前面的原因。**过不去就换 LibreTranslate（§10 的 0-A 第 2 条）。**
3. **区域级资源的 401 症状未实测**：官方文档说明区域资源需要区域头，但"缺它到底报 401 还是别的码"没有实测（我没有 Azure 凭据）。适配器的 401 文案因此**同时点了两种可能**（§7），而不是赌一种。
4. **`zh-Hans` / `zh-Hant` 的实际接受情况未实测**（§5.7）——第 0 步第 4 条覆盖。
5. **Azure 是否对"浏览器扩展直连"有隐含限制**：文档里**没有** DeepL 那种明示禁止条款，且官方为客户端场景提供 token 端点；但"没有明示禁止"不等于"官方背书这种用法"。**如实记为推断**，不是核实过的事实。
6. **腾讯云文本翻译是否有替代产品**（例如迁到"大模型翻译"名下）**未查**——若以后想再评估中国厂商，这是第一个要查的问题；查法按 §1.3 的规矩：**先存活核验，再看价格表**。
7. **本规格一个字都还没执行**：`CURRENT_VERSION` 仍是 5，`ENGINES` 仍是一个成员，`EngineProfile` 仍没有 `kind`。落地时的第一份读数是 `npx vitest run` 的真实输出，不是本文里的任何数字。
8. **DeepL 在中国大陆的可用性我仍未核实**（§1.2 第 3 行）：**用户的判断是"不可访问"，我没有找到官方"不服务中国"的条文，也没有推翻它的读数**——本机那三针只覆盖了接口层（域名可解析、跳转可落地、API 按语义拒绝假 Key），**没有覆盖注册与付款**。这一条如实留在"未核实"里，不写成"已确认不可用"：**订正结论的方向要朝着证据，不能朝着方便。**

---

## 12. 执行记账（Batch 1：第 1–3 步）

### a) 授权来源与为什么可以插队

指挥官授权**第 1–3 步先于 §10 第 0 步（两道闸）执行**，第 4 步及以后仍然卡在凭据闸之后。
理由不是"先写点算一点"，而是本规格自己的修订记录：v1→v2→v3 换了两次供应商，
**§3（数据模型）、§4（注册表与解析）、§8（迁移）一字未改**——机制与供应商无关，
所以这三步的产物不会因为第 0 步的结论而作废。具体到本批：如果第 0 步最后落在 LibreTranslate
（§10 的 0-A 第 2 条），需要改的只有 `ENGINES` 里多注册谁、以及 §5 那个适配器，
**本批的 12 条新用例与全部机制代码一字不动**。

### b) 本轮真实读数（照抄命令输出，不是概括）

| 命令 | 输出 |
| --- | --- |
| `npx vitest run` | `Test Files  57 passed (57)` / `Tests  1186 passed (1186)` / `Duration  25.48s` |
| 基线对比 | 开工前 `57 files / 1171 tests`（51.03s）→ 本批 **+15 条用例**（B1 +3、B2 +12），全绿 |
| `npm run typecheck` | 两个 tsconfig 均 0 错误（`grep -c "error TS"` → `0`） |
| `npm run build` | `✓ 产物校验全部通过（14 项）` |
| `npm run zip` | `✓ D:\翻译-插件\translens-0.1.0.zip：16 个文件，69565 字节——已解回临时目录逐字节比对通过` |
| `git diff --stat -- tests/engines/openai-compat.test.ts` | **空**（第 3 步"提取未改变行为"的证据） |
| `npx vitest run tests/core/layering.test.ts` | 全绿（新模块顶层不碰宿主全局） |

提交：`33ded22` 第 1 步 / `c9e0d5c` 第 2 步 / `86f3bf4` 第 3 步（另 `d98d6f0` `1b9b9e0` `1add3e6` 为 A0 三份产物入库）。

### c) 欠账清单（只有第 4 步适配器注册进来之后才成立，本批**故意没写**）

1. `ENGINES` 变成两个成员，`tests/engines/registry.test.ts` 的名单断言改成
   `toEqual(['openai-compat', 'azure-translator'])`（**保持确切名单，不许退成 `toContain`**）。
2. `kindNeedsModel('azure-translator') === false` —— 现在写只能靠 `?? true` 蒙对或硬编码，没有牙。
3. `resolveEngine`：azure 档案 `activeModel: ''` **不带** `NO_MODEL_PROBLEM`，与 openai-compat
   同数据**带**它，成对两条。
4. `UNKNOWN_KIND_PROBLEM` 零请求的**成对正例**换成 azure（本批用 openai-compat 顶的位置）。
5. `firstUsableProfileId` 的"不需要模型的档案算可用"那一半（本批只钉住了保守方向：
   认不出的类型缺模型**不算**可用，它已有牙——把兜底写成 `?? false` 会当场红）。
6. `config.model === undefined` 那一支（`needsModel` 为假）在本批**无任何用例覆盖**——
   注册表里今天没有 `needsModel: false` 的成员，写了就是恒真。
7. `host-access.ts` 的第二个使用方（azure 侧）与它"两处共用一份文案"的守卫。
8. §9.2 里 `tests/engines/azure-translator.test.ts` 那 8 条、`tests/options/*` 那 5 条、
   `tests/background/service-worker.test.ts` 那条成对，全部依赖第 4/5 步。

### d) 本批没做的事（越界清单，逐条对应 §10 的步骤号）

- **第 4 步**：没有新建 `src/engines/azure-translator.ts`，`ENGINES` 仍是一个成员。
- **第 5 步**：`src/options/sections/engine.ts` 只做了**类型必填打破的机械补全**——没有加
  「类型」下拉、没有做字段按类型显隐、没有加 Azure 模板、没有改行副标题。
  新建档案恒为 `openai-compat`，编辑与「测试连接」都**原样带上存储里的 kind**（不重置）。
- **第 6 步**：README 一字未改（§9.1 那六处仍待第 4/5 步之后一起改）。
- **§4.5**：`src/core/hash.ts` 的缓存 key 形状未动。

### e) 执行中发现的、与规格或常识不符之处（只记录，未改正文）

1. **§11.7 已经过期**：那句"本规格一个字都还没执行"在本批之后不再成立（`CURRENT_VERSION`
   已是 6、`EngineProfile` 已有 `kind`）。按纪律不就地改正文，此处记账为准。
2. **§9.2 有几条用例在本批结构上写不出来**（不是遗漏，是缺依赖）：凡断言
   `needsModel === false` 那一支的，都要等注册表里真有一个不需要模型的成员——已逐条列入 (c)。
   本批没有用"造一个假引擎塞进 ENGINES"之类的办法绕过，那会让名单断言与真实注册表脱钩。
3. **`npm run typecheck` 是 `tsc -p tsconfig.json && tsc -p tsconfig.node.json`**：第一个失败会
   **短路**，测试侧的错误根本不会被报出。本批第 2 步就是这样——第一轮只看到 src 的 4 个错误，
   误以为测试侧干净，修完 src 才暴露出测试助手与期望值的 12 处。任何"typecheck 干净"的结论
   都必须建立在两个 config 都真的跑过之上。
4. **分层守卫按源码字面量匹配、含注释**（`tests/core/layering.test.ts` 自己写着"注释里也就别写
   这些标识符了"）。新模块的注释因此不能出现那个扩展 API 的名字——第一次提交就被这条判红，
   是守卫正常工作，不是守卫太严。
5. **机械补全的清单**（`kind` 变必填所打破的全部位置，全部是类型/形状补全，无一条行为断言被改）：
   `src/options/sections/engine.ts` 三处档案字面量 + 一处 import；
   `tests/shared/settings.test.ts` 的 `profile()` 助手 + 10 处整份形状期望 + 1 处键集合断言；
   `tests/background/models.test.ts` 的 `profile()` 助手；`tests/options/options.test.ts` 一处
   "落盘字段一字不差"的期望；`tests/background/scheduler.test.ts` 四处 fake `Translator`
   （那是第 1 步 `needsModel` 造成的，同为纯类型补全）。
   其中键集合那条（`Object.keys(...).sort()`）的牙是"旧字段 `model` 不许残留"，加 `kind` 不削弱它。
6. **§8 要求的 v6 盖章步骤，在本批的可观测面里没有独立的牙——这条要如实报，别让它被"15 条用例"
   这个数字盖过去。** 实现照 §8 做了（`stampProfileKinds`），但它与 §3.2 第一行的读取口径
   （`pickKind`：缺失 → openai-compat）**是同一个判据的两次应用**：`loadSettings` 永远走
   `mergeSettings`，所以无论迁移盖不盖章，交出来的档案都带 `kind`。
   **这条已经实测过，不是推理**：把 `migrate` 里 `if (storedVersion < 6) …` 整块删掉、并把
   `stampProfileKinds` 改名成没人调用的样子，`npx vitest run tests/shared/settings.test.ts` 仍然
   `Tests 85 passed (85)` —— 本批 12 条新用例**一条都不会红**。
   两种处置，请指挥官定：
   - **保留（本批的做法）**：它是"存储形状自己收敛"的保险——任何一次 `saveSettings` 之后，
     磁盘上的档案就真的带 `kind` 了，不依赖每个读方都记得走 `mergeSettings`；
     代价是这一步目前没有独立证据。
   - **要让它有牙**：得改成断言**存储里**的形状（`loadSettings` 之后 `area.get(SETTINGS_KEY)`
     的原始 JSON 里每个档案都有 `kind`）——但那测的是"迁移写过 + 有人保存过"这条链，
     而 `saveSettings` 只在用户改动时发生，读一次并不会回写。
   本批没有为它编一条恒真的断言（§9.3），只把这个空档记在这里。

### f) Batch 1.5 的追记（同一批次内的自我更正）

**裁决来源**：指挥官。Batch 1 复核结论"通过"，但对本节 (e)6 自曝的那件事下了处置令——
**删掉那一步，不是保留**，理由不是"它多余"，而是"不可观测的代码不该留在机制层里冒充证据"。

**证据（三方独立，结论一致）**：

1. **本批 (e)6 的变异**：删掉 `migrate` 里 `if (storedVersion < 6)` 整块 + 让 `stampProfileKinds`
   无人调用 → `tests/shared/settings.test.ts` 仍 `Tests 85 passed (85)`（12 条新用例一条不红）。
2. **指挥官独立复现**同一个变异，读数相同。
3. **指挥官追了调用链**：`src/shared/settings.ts` 里 `migrate` 的唯一调用点在 `loadSettings` 内，
   其产物只经过 `mergeSettings`；全仓无任何地方直接读 `SETTINGS_KEY` 的原始值；所有落盘都走
   `saveSettings(Settings)`，而 `Settings` 是带 `kind` 的类型。⇒ 盖章在任何路径上不可观测。

**落地后的改动**：

- 删除 `stampProfileKinds` 与 `migrate` 里的那一步；`CURRENT_VERSION = 6` 保留（版本号语义见 §8
  的更正标注）。`pickKind` 的注释从"三处共用"改成"两处"——它不能再谎称有一个已不存在的第三方。
- **§8 就地更正**（见该节的 ⚠ 标注）：原文保留、标明作废，不删。先例是 commit `6f6b246`
  ——被实测推翻的结论就地改，不留暗账。
- **§11 的第 8 条归位**：Batch 1 追加 §12 时把它挤到了文件末尾，读起来像 §12(e) 的第 8 条；
  现在 §11 的 1–8 连续，§12 在文末。
- **四条迁移用例逐条复核并改名重对准**（"迁移盖章"这层含义已经不在了，名字留着就是谎）：
  盖章 → 「读一份 v5 数据：版本号抬到 6，缺失的 kind 由读入口补成 openai-compat」；
  不覆盖 → 「已经写着别的类型的 v5 档案，走存储路径读回来仍是那个类型」（与 `mergeSettings`
  层那条**同判据**，差别只在入口多走版本闸门与 `migrate`，这一点如实写在用例注释里）；
  幂等 → 保留；脏形状 → 名字里的"迁移"改成"读入口"。**没有删除任何一条用例**，也**没有**
  为已消失的步骤留恒真断言。
- **新增一条正面证据**：「读迁移不回写：磁盘上那份还是原样（没有 kind、版本仍是 5）」——
  它钉的正是"删除盖章步骤"所依赖的那个性质的反面：任何"迁移顺手回写存储"的改动都会让它红。
- **守卫没有跟着步骤一起消失**（(e)6 当时留下的问题，这里给出实测答案）：把 `pickKind` 的
  "缺失 → openai-compat"兜底改成返回空串，**39 条用例红，横跨 6 个文件**
  （`settings` 12 / `service-worker` 13 / `engine-health` 6 / `popup` 5 / `options` 2 /
  `engine-models` 1）。kind 的兜底是被整条链路消费的，不是被某一步迁移消费的。

**读数**：57 files / **1187** tests（1186 + 1 新增，0 删除）、两个 tsconfig 分别跑各 exit=0、
`npm run build` 含 `verify:dist` 14 项通过。提交：`1ac2a42`（代码与用例）+ 本条所属的文档提交。