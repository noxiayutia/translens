## Task 17: `content/toast.ts` 与 `content/index.ts` — 内容脚本编排

**Files:**
- Create: `src/content/toast.ts`
- Modify: `src/content/index.ts`（替换占位内容）

- [ ] **Step 1: 写页面内轻提示**

```ts
// src/content/toast.ts

const TOAST_ID = 'jy-toast';
const VISIBLE_MS = 3200;

/** 页面内轻提示。固定挂在 documentElement 上，不受页面布局影响。 */
export function toast(message: string): void {
  const existing = document.getElementById(TOAST_ID);
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = TOAST_ID;
  host.setAttribute('data-jy-root', '');
  host.style.cssText = [
    'position:fixed',
    'z-index:2147483647',
    'left:50%',
    'bottom:32px',
    'transform:translateX(-50%)',
    'padding:10px 16px',
    'border-radius:8px',
    'background:rgba(17,24,39,0.92)',
    'color:#fff',
    'font:14px/1.5 system-ui,sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,0.24)',
    'pointer-events:none',
  ].join(';');

  const shadow = host.attachShadow({ mode: 'open' });
  const span = document.createElement('span');
  span.textContent = message;
  shadow.append(span);

  document.documentElement.append(host);
  setTimeout(() => host.remove(), VISIBLE_MS);
}
```

- [ ] **Step 2: 写内容脚本入口**

```ts
// src/content/index.ts
import { runPool } from '../core/pool';
import { planBatches, type TextSegment } from '../core/segmenter';
import { MSG, type PageState, type TranslateTextsResponse } from '../shared/messages';
import { loadSettings, type Settings } from '../shared/settings';
import { collectSegments, type ExtractedSegment } from './extractor';
import { DomRenderer } from './renderer';
import { toast } from './toast';

let renderer: DomRenderer | null = null;
let segments: ExtractedSegment[] = [];
let running = false;
let lastError: string | null = null;
let displayMode: 'bilingual' | 'replace' = 'bilingual';
const finished = new Set<string>();
const failedIds = new Set<string>();

function currentState(): PageState {
  return {
    translated: renderer !== null,
    mode: displayMode,
    total: segments.length,
    done: finished.size,
    failed: failedIds.size,
  };
}

function sendToBackground(message: unknown): Promise<TranslateTextsResponse> {
  return chrome.runtime.sendMessage(message) as Promise<TranslateTextsResponse>;
}

function describeError(response: Extract<TranslateTextsResponse, { ok: false }>): string {
  if (response.code === 'AUTH') return response.message;
  if (response.code === 'RATE_LIMIT') return '免费接口限流，请稍后重试或改用自定义 API';
  return `翻译失败：${response.message}`;
}

async function translatePage(): Promise<void> {
  if (running) return;
  // 已经翻译过就不重复翻译；要重来请先还原（避免插入两份译文）。
  if (renderer) return;

  const settings: Settings = await loadSettings();
  const collected = collectSegments(document.body, { targetLang: settings.targetLang });
  if (collected.length === 0) {
    toast('没有找到需要翻译的内容');
    return;
  }

  running = true;
  lastError = null;
  displayMode = settings.displayMode;
  finished.clear();
  failedIds.clear();
  segments = collected;
  renderer = new DomRenderer(document, settings.displayMode, (segmentId) => void retrySegment(segmentId, settings));

  for (const segment of segments) renderer.mount(segment, 'pending');

  const textSegments: TextSegment[] = segments.map((s) => ({ id: s.id, text: s.text, order: s.order }));
  const batches = planBatches(textSegments, {
    maxBatchChars: settings.maxBatchChars,
    maxSegmentsPerBatch: settings.maxSegmentsPerBatch,
  });

  try {
    await runPool(
      batches.map((batch) => async () => {
        const response = await sendToBackground({
          type: MSG.TRANSLATE_TEXTS,
          payload: {
            items: batch.map((segment) => ({ id: segment.id, text: segment.text })),
            targetLang: settings.targetLang,
          },
        });

        if (!response.ok) {
          lastError = describeError(response);
          for (const segment of batch) {
            failedIds.add(segment.id);
            renderer?.fail(segment.id, response.message);
          }
          return;
        }
        for (const result of response.results) {
          if (result.text === null) {
            failedIds.add(result.id);
            renderer?.fail(result.id, result.message ?? '翻译失败');
          } else {
            finished.add(result.id);
            renderer?.update(result.id, result.text);
          }
        }
      }),
      settings.concurrency,
    );
  } finally {
    running = false;
  }

  if (lastError) toast(lastError);
}

async function retrySegment(segmentId: string, settings: Settings): Promise<void> {
  const segment = segments.find((s) => s.id === segmentId);
  if (!segment) return;
  failedIds.delete(segmentId);
  renderer?.mount(segment, 'pending');

  const response = await sendToBackground({
    type: MSG.TRANSLATE_TEXTS,
    payload: { items: [{ id: segment.id, text: segment.text }], targetLang: settings.targetLang },
  });

  if (!response.ok) {
    failedIds.add(segmentId);
    renderer?.fail(segment.id, response.message);
    toast(describeError(response));
    return;
  }
  const [result] = response.results;
  if (result && result.text !== null) {
    finished.add(segment.id);
    renderer?.update(segment.id, result.text);
  } else {
    failedIds.add(segmentId);
    renderer?.fail(segment.id, result?.message ?? '翻译失败');
  }
}

function restorePage(): void {
  renderer?.restore();
  renderer = null;
  segments = [];
  finished.clear();
  failedIds.clear();
  lastError = null;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = (message as { type?: string } | null)?.type;

  if (type === MSG.TRANSLATE_PAGE) {
    void translatePage().then(() => sendResponse(currentState()));
    return true;
  }
  if (type === MSG.RESTORE_PAGE) {
    restorePage();
    sendResponse(currentState());
    return false;
  }
  if (type === MSG.TOGGLE_PAGE) {
    if (renderer) {
      restorePage();
      sendResponse(currentState());
      return false;
    }
    void translatePage().then(() => sendResponse(currentState()));
    return true;
  }
  if (type === MSG.GET_PAGE_STATE) {
    sendResponse(currentState());
    return false;
  }
  return false;
});
```

- [ ] **Step 3: 运行类型检查**

Run: `npm run typecheck`

Expected: 退出码 0。

- [ ] **Step 4: 构建**

Run: `npm run build`

Expected: 退出码 0，`dist/content.js` 存在且是单文件（不含 `import` 语句）。

Run: `Select-String -Path dist/content.js -Pattern '^import ' -Quiet`

Expected: 无输出（即 `$false`）。若为 `$true`，说明内容脚本被打成了 ESM，检查 `vite.content.config.ts` 的 `lib.formats`。

- [ ] **Step 5: 提交**

```bash
git add src/content/toast.ts src/content/index.ts
git commit -m "feat(content): 内容脚本编排、并发批次与页面提示"
```

---
