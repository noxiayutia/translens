/**
 * `src/manifest.json` 的权限声明。
 *
 * 这个文件里唯一承重的断言是 `activeTab`。它值得单开一个测试文件，因为它是**改了也不会红**
 * 的那一类缺口：删掉它，全套测试照样全绿（测试里的 `chrome.tabs.query` 是替身，jsdom 也不
 * 模拟权限），而真机上弹窗会**彻底看不到站点规则**——`activeHostname()` 恒返回 null，
 * 提示行恒 hidden，「解除」按钮永远不出现。
 *
 * 为什么必须有 `activeTab`（不是可选优化）：
 * - 弹窗判定"当前站点命中永不翻译"要读活动标签页的主机名，而主机名来自 `Tab.url`；
 * - Chrome 只在两种情况下填 `Tab.url`：声明了 `tabs` 权限，**或**对该页面持有宿主权限；
 * - `content_scripts.matches` 声明的那些通配站点**不算**宿主权限——Chromium 的权限设计文档
 *   明写 scriptable hosts "do not affect any other API"（内容脚本的匹配范围不授予任何 API
 *   访问权）；
 * - `optional_host_permissions` 在用户授权前不生效，而且我们只在用户配置自定义引擎地址时
 *   才去申请它，普通网站从来不在其中。
 *
 * 选 `activeTab` 而不是 `tabs`：`tabs` 会带来"读取您的浏览记录"这条安装警告，为一个提示行
 * 不值得；`activeTab` 不产生任何安装警告，而且**点击扩展图标打开弹窗本身就是 user
 * invocation**，Chrome 会据此自动授予当前标签页 URL 的访问权——正好是本扩展的场景。
 * （另一条路是让内容脚本回报 `location.hostname`：多一条消息通道，且在内容脚本没注入的
 * 页面上同样拿不到，收益更小。）
 *
 * 读的是**源** manifest 而不是 `dist/manifest.json`：这条约束属于源码，与有没有跑过
 * `npm run build` 无关，放在 `npm test` 里必须恒定可判。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MANIFEST_PATH = join(import.meta.dirname, '..', 'src', 'manifest.json');

interface Manifest {
  permissions?: unknown;
  /** 默认主机权限：单元 E 起是**显式空数组**（`[]`），不是"这个键没了"。 */
  host_permissions?: unknown;
  /** 可选主机权限：自定义端点按需申请用，**一个字都不许动**。 */
  optional_host_permissions?: unknown;
  action?: { default_popup?: unknown };
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest;
}

describe('manifest 权限：弹窗要能读到当前标签页的 url', () => {
  it('声明了 activeTab —— 否则 tab.url 不可得，站点规则提示行永远不会出现', () => {
    const permissions = manifest().permissions;
    // 先钉住形状：万一哪天 permissions 被改成别的类型，下面那条 toContain 会以更难读的方式失败。
    expect(Array.isArray(permissions)).toBe(true);
    expect(permissions).toContain('activeTab');
  });

  it('用 activeTab 而不是 tabs：后者会带来"读取您的浏览记录"的安装警告', () => {
    // 这条是**反向**约束：如果将来真有别处需要 tabs 权限，请连注释一起改掉这条断言，
    // 别在没意识到代价的情况下把安装警告加回来。
    expect(manifest().permissions).not.toContain('tabs');
  });

  it('弹窗由工具栏图标点击打开：activeTab 的授予正来自这次 user invocation', () => {
    // 因果链：action 点击 → 打开 default_popup → 这次 user invocation 授予当前标签页的
    // activeTab 权限 → 弹窗里的 `chrome.tabs.query` 才带着 url。少了 default_popup，
    // 上面那条 activeTab 断言就只是一句没有来路的声明。
    expect(manifest().action?.default_popup).toBe('popup/popup.html');
  });

  /**
   * **安装/更新不请求任何站点访问权**这句用户可见承诺的**唯一**机器守卫。
   *
   * 牙在哪：谁把 `https://translate.googleapis.com/*`（或别的域名）加回默认主机权限，这条当场红。
   * 为什么断言 `[]` 而不是"键不存在"：显式空数组表达"我们查过这件事、结论是零权限"，
   * `toEqual([])` 同时把"不小心把键删了"钉在"这是一次遗漏"而不是"这是一次决定"上
   * （两者行为等价，但 diff 里看得见区别）。
   */
  it('默认不声明任何主机权限：安装与更新都不请求站点访问权', () => {
    expect(manifest().host_permissions).toEqual([]);
  });

  /**
   * 这条是**反向**约束（与上面「不许有 `tabs`」那条同一性质，理由也同一性质：
   * **改了也不会红**）。
   *
   * 清空 `host_permissions` 的人很容易顺手把 `optional_host_permissions` 也"一起清理干净"
   * ——那样自定义端点会**永远申请不到授权**（`shared/host-permission.ts` 申请的 origin
   * 不在可选清单里，Chrome 直接拒绝），而所有测试都是替身、**一条都不会红**：
   * 弹窗与设置页的授权断言在 `tests/helpers/chrome-stub.ts` 的 `grantedOrigins` 上，
   * 那个替身**不看 manifest**。真机上用户会看到设置页说"已授权访问"，而请求被浏览器拦下。
   */
  it('可选主机权限原样保留：自定义端点的授权链路一个字都不许动', () => {
    expect(manifest().optional_host_permissions).toEqual(['http://*/*', 'https://*/*']);
  });
});
