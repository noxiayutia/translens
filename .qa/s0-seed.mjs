// 阶段 0：只验「设置页建档 + 授权」这一条路，顺便看清 Chrome 的权限弹框是什么形态。
import { boot, seedProfileViaUi } from './lib.mjs';

const api = await boot();
try {
  console.log('扩展 id:', api.id);
  console.log('建档前该 origin 已授权?', await api.extEval(`chrome.permissions.contains({ origins: ['http://127.0.0.1:8787/*'] })`));

  const r = await seedProfileViaUi(api);
  console.log('建档结果:', JSON.stringify({ granted: r.granted, status: r.status, models: r.models, error: r.error }));

  console.log('点击保存后的 targets:');
  for (const t of await api.cdp.targets()) console.log('  ', `${t.type}|${(t.title ?? '').slice(0, 30)}|${t.url.slice(0, 70)}`);

  console.log('storage 顶层键:', await api.extEval(`chrome.storage.local.get(null).then(o => JSON.stringify(Object.keys(o)))`));
  console.log(
    '档案内容(去 Key):',
    await api.extEval(
      `chrome.storage.local.get('jinyi:settings').then(o => JSON.stringify((o['jinyi:settings']?.profiles ?? []).map(p => ({id:p.id,label:p.label,baseUrl:p.baseUrl,models:p.models,activeModel:p.activeModel,keyLen:(p.apiKey??'').length}))))`,
    ),
  );
  console.log(
    'engineId/版本:',
    await api.extEval(
      `chrome.storage.local.get('jinyi:settings').then(o => JSON.stringify({v:o['jinyi:settings']?.version, engineId:o['jinyi:settings']?.engineId}))`,
    ),
  );
} finally {
  await api.close();
}
