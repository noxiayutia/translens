// 小探针：看清 SW 目标里有哪些执行上下文，以及在哪个上下文里 `chrome` 是真的。
import { boot } from './lib.mjs';

const api = await boot();
try {
  console.log('contexts in SW session:', JSON.stringify(api.cdp.contexts(api.sw.sessionId)));
  for (const c of api.cdp.contexts(api.sw.sessionId)) {
    const r = await api.cdp.send(
      'Runtime.evaluate',
      { expression: `typeof chrome !== 'undefined' && !!chrome.runtime && chrome.runtime.id`, contextId: c.id },
      api.sw.sessionId,
    );
    console.log(`  context ${c.id} (${c.name || '-'}/${c.origin || '-'}):`, r.result?.value ?? r.exceptionDetails?.text);
  }
  const targets = await api.cdp.targets();
  console.log('targets:', targets.map((t) => `${t.type}|${t.url.slice(0, 70)}`));
} finally {
  await api.close();
}
