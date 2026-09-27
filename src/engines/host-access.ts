// src/engines/host-access.ts
import { hasHostPermission, originPattern } from '../shared/host-permission';
import { EngineError } from './types';

/**
 * 「这个接口地址的 origin，用户授权过了吗」——**发请求之前**的那道闸，适配器共用一份。
 *
 * 为什么需要它：manifest 只声明了 `optional_host_permissions`，而 Chrome 要求可选权限在
 * **用户手势**里申请（设置页的「保存」按钮做这件事）。没申请就发请求时浏览器会把它拦下，
 * 而我们拿到的只是一个失败的 `fetch`——错误会伪装成 `NETWORK`（"断网"），用户既查不出真正
 * 的原因，也找不到该去哪儿点。
 *
 * 为什么必须是**一个**共用件而不是各写一份：第二个适配器（传统翻译 API，§5）要问的是同一个
 * 问题，两处各写一份时"没授权时报什么话"必然漂移，先例见 `isAllowedBaseUrl` 与
 * `NO_ENGINE_PROBLEM` 的注释。文案在这里是**唯一来源**，两句都是从 `openai-compat` 原样搬来、
 * 一个字没改（`tests/engines/openai-compat.test.ts` 逐字钉着它们，那条文件在本步**不许有 diff**
 * ——它就是"提取没有改变行为"的证据）。
 *
 * 对扩展 API 的访问全部下沉到 `shared/host-permission`：本模块**顶层不碰任何宿主全局**，
 * `src/engines/*` 必须能在纯 Node 里被直接 import（`tests/core/layering.test.ts` 守着这条，
 * 它按源码字面量匹配、**含注释**，所以这里连那个名字都不写）。
 * 拿不到权限 API 的环境（纯 Node 单测）里 `hasHostPermission` 恒为 true——引擎因此可独立单测。
 */
export async function assertHostAccess(baseUrl: string): Promise<void> {
  const pattern = originPattern(baseUrl);
  if (pattern === undefined) {
    throw new EngineError('AUTH', `接口地址不是合法的 URL：${baseUrl}，请在设置中修正`);
  }
  if (!(await hasHostPermission(pattern))) {
    throw new EngineError('AUTH', '未授权访问该接口地址，请到设置页保存一次以授权');
  }
}
