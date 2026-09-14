// src/shared/host-permission.ts

/**
 * 可选宿主权限（`optional_host_permissions`）的查询与申请。
 *
 * manifest 里声明了 `http://*` 与 `https://*` 两个宿主模式（各自覆盖该协议下的全部站点），
 * 但**声明不等于已授权**：Chrome 要求可选权限必须在**用户手势**里用 `permissions.request()`
 * 申请，只声明不申请等于永远没授权，发往用户自己端点的 `fetch` 会被浏览器拦下——
 * 而拦下来只是一个失败的 fetch，错误会伪装成 `NETWORK`（断网），用户完全不知道该去哪儿授权。
 *
 * 所以这里是两个调用方共用的唯一入口：
 * - **设置页**在「保存」按钮的用户手势里申请（{@link requestHostPermission}）；
 * - **引擎**在发请求前查询（{@link hasHostPermission}），没授权就抛一句能指路的错误，
 *   而不是让浏览器的拦截伪装成网络故障。
 *
 * 对扩展 API 的访问一律先看 `typeof chrome`：`src/engines` 必须能在**纯 Node** 里被直接
 * import 并单测（见 `tests/core/layering.test.ts` 的分层守卫），拿不到权限 API 时
 * 「无从判断」按已授权处理——能把引擎拖进扩展环境模拟里的写法才是真的越界。
 */

/** 权限 API 是否可用（设置页据此决定能不能申请，而不是把「没有 API」当成「被拒绝」）。 */
export function canQueryHostPermission(): boolean {
  return typeof chrome !== 'undefined' && chrome.permissions !== undefined;
}

/**
 * 把 Base URL 变成 Chrome 需要的 origin 匹配模式（`https://api.example.com/*`）。
 *
 * 解析失败返回 `undefined`：调用方必须**明确报错**，不能静默当成"已授权"或"不用管"——
 * 一个填错的地址最该得到的就是一句"这个地址不对"。
 */
export function originPattern(baseUrl: string): string | undefined {
  try {
    return `${new URL(baseUrl.trim()).origin}/*`;
  } catch {
    return undefined;
  }
}

/** 该 origin 是否已授权。没有权限 API 的环境（纯 Node 单测）返回 true，见文件头注释。 */
export async function hasHostPermission(pattern: string): Promise<boolean> {
  if (!canQueryHostPermission()) return true;
  return chrome.permissions.contains({ origins: [pattern] });
}

/**
 * 在**用户手势**里申请该 origin 的访问权限，返回用户是否同意。
 * 不是手势里调用时 Chrome 会直接抛错，由调用方兜住并如实告诉用户。
 */
export async function requestHostPermission(pattern: string): Promise<boolean> {
  if (!canQueryHostPermission()) return false;
  return chrome.permissions.request({ origins: [pattern] });
}
