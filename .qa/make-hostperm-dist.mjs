// 把 dist 复制成一份「预授权」版本，专供自动化台架使用。
//
// 只改 manifest 的一个字段：把假引擎的 origin 从 optional_host_permissions 挪进
// host_permissions（开发者加载的扩展，必选 host 权限在安装时即生效，不再弹授权框）。
// 目的是让台架可以**无人值守**地连铺十几个站点——扩展的 JS 代码一字节没动，
// 被测的采集/渲染/还原/缓存逻辑与真产物完全一致。
// 真实权限流程（点保存才申请、没授权时报 AUTH 且零请求）已在本轮早些时候单独验过。
import { cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(root, 'dist');
const dst = join(here, 'dist-perm');

rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });

const manifestPath = join(dst, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const ENGINE_ORIGIN = 'http://127.0.0.1:8787/*';
manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ENGINE_ORIGIN])];
manifest.optional_host_permissions = (manifest.optional_host_permissions ?? []).filter(
  (p) => p !== ENGINE_ORIGIN,
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('已产出', dst);
console.log('host_permissions =', JSON.stringify(manifest.host_permissions));
console.log('optional_host_permissions =', JSON.stringify(manifest.optional_host_permissions));
