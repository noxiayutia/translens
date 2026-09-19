// src/options/rule-pattern.ts
//
// 站点规则的**输入侧**校验与规范化。纯函数，不碰 DOM、不碰存储。
//
// 为什么要有它：核心匹配器（`src/core/site-rules.ts`）刻意不做形状校验——只认
// `example.com` 与 `*.example.com`，其余写法**既不报错也不会命中**，静默地永不生效。
// 那份注释把"输入侧"的责任点给了设置页，这里就是那一侧：
//
// - 能救的救回来：整条网址 → 主机名；中文域名 → punycode（核心按 ASCII 比对）；
// - 救不回来的**明确拒绝**并说清为什么，绝不让用户填一个"存下去了但永远不生效"的规则。
import type { SiteRule } from '../shared/settings';

export type RulePatternResult = { ok: true; pattern: string } | { ok: false; reason: string };

/**
 * 主机名的形状：点分标签，每段由字母数字与连字符组成、不以连字符开头或结尾。
 *
 * **允许单标签**（`localhost`、`wiki` 这种内网短名）——**已决**：核心匹配器
 * （`src/core/site-rules.ts` 的 `hostMatchesPattern`）对任何非空 pattern 都做精确匹配，
 * `localhost` 在那边是**有效规则**；UI 这一侧凭"看起来不像域名"把它拒掉，就是凭空发明一条
 * 核心没有的限制（而且内网页面确实有人想加规则）。真正该拒的是 URL 解析都过不去的输入
 * （`???`、带空格的串）与带端口/路径/凭据的写法，那几类下面各有一条。
 */
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** 把一串"可能带 scheme、可能带路径"的输入解析成主机名；解析不出来返回 null。 */
function hostFrom(input: string): { host: string; hadPath: boolean; hadPort: boolean; hadUserInfo: boolean } | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  return {
    host: url.hostname,
    hadPath: url.pathname !== '' && url.pathname !== '/',
    hadPort: url.port !== '',
    hadUserInfo: url.username !== '' || url.password !== '',
  };
}

/**
 * 规范化一条规则域名。返回 `{ok:true, pattern}` 时 `pattern` 就可以原样写进存储；
 * 返回 `{ok:false, reason}` 时调用方**不要写存储**，把 `reason` 说给用户听。
 */
export function normalizeRulePattern(raw: string): RulePatternResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: '请填写域名' };

  if (trimmed.startsWith('*.')) {
    const rest = trimmed.slice(2).trim();
    if (rest.length === 0) return { ok: false, reason: '通配要写成 *.example.com（星号后面必须有域名）' };
    const parsed = hostFrom(rest);
    if (parsed === null || parsed.hadPath || parsed.hadPort || parsed.hadUserInfo) {
      return { ok: false, reason: '通配要写成 *.example.com，星号后面只跟域名' };
    }
    if (!HOSTNAME.test(parsed.host)) return { ok: false, reason: `这看起来不是域名：${rest}` };
    return { ok: true, pattern: `*.${parsed.host}` };
  }

  if (trimmed.startsWith('*')) {
    return { ok: false, reason: '通配只能写成 *.example.com 这种形式（星号后面要紧跟一个点）' };
  }

  const parsed = hostFrom(trimmed);
  if (parsed === null) return { ok: false, reason: `这看起来不是域名：${trimmed}` };
  if (parsed.hadUserInfo) return { ok: false, reason: '网址里不要带用户名与密码——规则只认域名' };
  if (parsed.hadPort) return { ok: false, reason: '规则只按域名匹配，不要带端口（端口会被忽略，写了也不生效）' };
  if (parsed.hadPath) {
    return { ok: false, reason: `规则只按整个域名匹配，不能带路径；要限制这个站就填 ${parsed.host}` };
  }
  if (!HOSTNAME.test(parsed.host)) return { ok: false, reason: `这看起来不是域名：${trimmed}` };
  return { ok: true, pattern: parsed.host };
}

/** 存储里那条规则的形状（本单元只写 `never`，理由见 sections/site-rules.ts）。 */
export type StoredRule = SiteRule;
