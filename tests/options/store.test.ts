// tests/options/store.test.ts
/**
 * 设置页存储层的单测。**不起 DOM**：这一层只跟存储打交道（`shared/settings` 是它的唯一依赖），
 * 用默认的 node 环境跑，出错时不必在 jsdom 的噪音里找线索。
 *
 * 每个用例重新 `import` 一次模块（`vi.resetModules()`）：`store.ts` 的快照与写队列都是
 * 模块级状态，跨用例共享会让"还没读出来就该拒绝"这类断言失去意义。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_VERSION, SETTINGS_KEY } from '../../src/shared/settings';
import { installChromeStub, type ChromeStub } from '../helpers/chrome-stub';

let chromeStub: ChromeStub;
let store: typeof import('../../src/options/store');

/** 往存储里写一份**故意不完整**的设置：`loadSettings` 是逐字段补齐的反序列化边界。 */
async function seed(patch: Record<string, unknown> = {}): Promise<void> {
  await chromeStub.storage.local.set({ [SETTINGS_KEY]: { version: CURRENT_VERSION, ...patch } });
}

/** 直读存储：验证"改动真的落盘了"，而不是只改了页面里的内存副本。 */
async function stored(): Promise<Record<string, unknown>> {
  const raw = await chromeStub.storage.local.get([SETTINGS_KEY]);
  return (raw[SETTINGS_KEY] ?? {}) as Record<string, unknown>;
}

beforeEach(async () => {
  vi.resetModules();
  chromeStub = installChromeStub();
  store = await import('../../src/options/store');
});

describe('设置页存储层：单字段写回', () => {
  it('改一个字段：整份写回，其余字段原样', async () => {
    await seed({ engineId: 'p-a', targetLang: 'zh-Hans', concurrency: 5 });
    await store.loadSnapshot();

    await store.patchSettings({ targetLang: 'en' });

    const saved = await stored();
    expect(saved.targetLang).toBe('en');
    expect(saved.engineId).toBe('p-a');
    expect(saved.concurrency).toBe(5);
    // 版本号由 saveSettings 统一写成当前版本，不被调用方摆布。
    expect(saved.version).toBe(CURRENT_VERSION);
  });

  it('连着改两个字段：两次都落盘，后一次不抹掉前一次（写队列的见证用例）', async () => {
    // 这就是"改完目标语言顺手改显示模式"的真实序列：两个 change 之间没有任何 await。
    await seed({ targetLang: 'zh-Hans', displayMode: 'translated-only' });
    await store.loadSnapshot();

    const first = store.patchSettings({ targetLang: 'en' });
    const second = store.patchSettings({ displayMode: 'bilingual' });
    await Promise.all([first, second]);

    const saved = await stored();
    expect(saved.targetLang).toBe('en');
    expect(saved.displayMode).toBe('bilingual');
  });

  it('写回前重读存储：期间在别处（弹窗）改过的字段不会被旧快照抹掉', async () => {
    await seed({ targetLang: 'zh-Hans', concurrency: 3 });
    await store.loadSnapshot();

    // 页面已经打开，用户在弹窗里改了并发数（本页快照里还是 3）。
    const current = await stored();
    await chromeStub.storage.local.set({ [SETTINGS_KEY]: { ...current, concurrency: 7 } });

    await store.patchSettings({ targetLang: 'ja' });

    const saved = await stored();
    expect(saved.targetLang).toBe('ja');
    expect(saved.concurrency).toBe(7);
  });

  it('设置还没读出来就写：拒绝并给出可读原因，存储一个字节都不动', async () => {
    await seed({ targetLang: 'zh-Hans' });

    await expect(store.patchSettings({ targetLang: 'en' })).rejects.toThrow('设置还没读出来');

    expect((await stored()).targetLang).toBe('zh-Hans');
    expect(store.currentSettings()).toBeNull();
  });

  it('一次写失败不阻塞下一次写：失败之后队列照样能往下走', async () => {
    await seed({ targetLang: 'zh-Hans' });
    await store.loadSnapshot();

    // 注入一次性失败：这是"存储满了 / 版本被拒绝"这类真实失败的最小替身。
    const realSet = chromeStub.storage.local.set.bind(chromeStub.storage.local);
    let failNext = true;
    chromeStub.storage.local.set = async (items: Record<string, unknown>) => {
      if (failNext) {
        failNext = false;
        throw new Error('存储写入失败');
      }
      await realSet(items);
    };

    await expect(store.patchSettings({ targetLang: 'en' })).rejects.toThrow('存储写入失败');

    // 队列没被那次失败卡死：下一次写必须真的写进去。
    await store.patchSettings({ targetLang: 'ja' });
    expect((await stored()).targetLang).toBe('ja');
  });

  it('快照只在写成功后更新：写失败时快照还是上一次那份', async () => {
    await seed({ targetLang: 'zh-Hans' });
    await store.loadSnapshot();
    expect(store.currentSettings()?.targetLang).toBe('zh-Hans');

    chromeStub.storage.local.set = async () => {
      throw new Error('存储写入失败');
    };
    await expect(store.patchSettings({ targetLang: 'en' })).rejects.toThrow('存储写入失败');

    expect(store.currentSettings()?.targetLang).toBe('zh-Hans');
  });

  it('快照必须是存储里真正生效的值：越界写入被夹后，快照与存储一致', async () => {
    // 这条是"快照 = 落盘"这条不变式的**直接**读数：快照是设置页所有区块读"生效值"的地方，
    // 它一旦拿的是"请求值"，界面就会显示一个没生效的数字。此前这条不变式只有一条**间接**
    // 读数（`cache-section.test.ts` 的「越界的数字被夹到允许范围」——它经由区块的输入框回填
    // 才看得见夹取），存储层自己少一次 `mergeSettings` 却未必有人发现，所以这里直接钉住。
    await seed({ concurrency: 3 });
    await store.loadSnapshot();

    // 999 越界：`mergeSettings` 的 clampInt 会把它夹到并发允许范围的上限 8。
    await store.patchSettings({ concurrency: 999 });

    // ① 存储里是生效值，不是提交上来的那个请求值。
    expect((await stored()).concurrency).toBe(8);
    // ② 快照与存储同一个值：读快照的地方（各区块的 `settings()`）拿到的就是生效值。
    expect(store.currentSettings()?.concurrency).toBe(8);
    // ③ 重新读一遍存储，快照与它逐字段一致：上一步的快照不是"另写了一份看起来对的数字"。
    const reloaded = await store.loadSnapshot();
    expect(reloaded).toEqual(store.currentSettings());
  });

  it('成功加载之后再加载失败：保留上一次成功的快照，写仍可用（失败原因是版本，不是还没读出来）', async () => {
    // 这条把 `loadSnapshot` 的**失败语义**从"碰巧"变成"契约"：它的两种失败后果不同。
    // 首次失败必须留下 null（否则拿空设置覆盖存储，见上一条用例）；**已经加载过之后**失败
    // 则保留上一份可用数据——`reload()` 正是这条路径的调用点（Task 3 的 `sections/engine.ts`
    // 删档案之后的 `renderFromStorage`），所以它必须有读数守着，否则把实现改成"失败就清空"
    // 或"失败就留着旧的、却看起来像成功"都不会有人发现。
    await seed({ targetLang: 'zh-Hans' });
    await store.loadSnapshot();
    expect(store.currentSettings()?.targetLang).toBe('zh-Hans');

    // 存储被换成比本代码更新的 schema：`loadSettings` 会永久拒绝，光重试没有用。
    await seed({ targetLang: 'ja', version: CURRENT_VERSION + 1 });

    await expect(store.loadSnapshot()).rejects.toThrow('高于当前支持');

    // ① 保留的是"上一次成功那一份"：不是 null，也不是存储里那一份（ja）。
    expect(store.currentSettings()?.targetLang).toBe('zh-Hans');

    // ② 写没被 null 守卫拦下：它照样读写存储，最后败在版本门禁上而不是 NOT_LOADED。
    const error = await store.patchSettings({ targetLang: 'en' }).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('设置还没读出来');
    expect((error as Error).message).toContain('高于当前支持');

    // ③ 失败没有污染快照，存储也一个字节没动。
    expect(store.currentSettings()?.targetLang).toBe('zh-Hans');
    expect((await stored()).targetLang).toBe('ja');
  });
});
