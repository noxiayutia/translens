// tests/options/prompt.test.ts
/**
 * @vitest-environment jsdom
 *
 * §3.6 自定义提示词：多行文本、失焦才写、留空即内置。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { bubble, chromeStub, loadOptions, pick, resetOptionsPage, seedSettings, settle, storedSettings, waitFor } from './harness';

function textarea(): HTMLTextAreaElement {
  return pick<HTMLTextAreaElement>('system-prompt');
}

function status(): HTMLElement {
  return pick<HTMLElement>('prompt-status');
}

beforeEach(() => {
  resetOptionsPage();
});

describe('设置页：自定义提示词', () => {
  it('按存储回填（多行原样）', async () => {
    await seedSettings({ systemPrompt: 'IT 术语保留英文原文。\n数字与单位不改动。' });
    await loadOptions();

    expect(textarea().value).toBe('IT 术语保留英文原文。\n数字与单位不改动。');
  });

  it('打字过程中存储不变，失焦（change）之后才写', async () => {
    await seedSettings({ systemPrompt: '' });
    await loadOptions();

    textarea().value = '语气正式一点';
    textarea().dispatchEvent(bubble('input'));
    // 让排队中的微任务跑完再读数：写路径是"排队 + 好几次 await"才落盘的，不 flush 就查存储
    // 等于在写落地之前抢跑——那样这句断言**恒真**，它本该守住的变异会被放过去
    // （实测：把监听从 `change` 改成 `input`，不加这句这条用例仍然绿）。
    await settle();
    expect((await storedSettings()).systemPrompt).toBe('');
    // 第二个见证：打字这一路上**一次保存都不该发生过**——状态行的 data-kind 还从没被设过。
    expect(status().dataset.kind).toBeUndefined();

    textarea().dispatchEvent(bubble('change'));
    await waitFor(async () => (await storedSettings()).systemPrompt === '语气正式一点');
    expect(status().dataset.kind).toBe('ok');
  });

  it('清空即回到内置提示词：存储里是空串，不是空白串', async () => {
    await seedSettings({ systemPrompt: '先前的提示词' });
    await loadOptions();

    textarea().value = '';
    textarea().dispatchEvent(bubble('change'));

    await waitFor(async () => (await storedSettings()).systemPrompt === '');
    expect((await storedSettings()).systemPrompt).toBe('');
  });

  it('前后空白原样存进去（存的是用户敲的那一份，判断"空不空"是消费者的事）', async () => {
    // 这条是**决策**不是装饰：存 `value` 还是存 `value.trim()` 只能选一个。
    // 选"原样"的理由：消费者（`openai-compat.ts` 的 buildMessages）本来就 `trim()` 之后再判断
    // 追加与否，所以两边都 trim 只会让"界面里看到的"与"存储里的"不一致；而界面上显示的
    // 永远是 textarea 里的原文。这条用例把选择钉住——谁把实现改成 `.trim()`，这里当场红。
    await seedSettings({ systemPrompt: '' });
    await loadOptions();

    textarea().value = '  语气正式一点  ';
    textarea().dispatchEvent(bubble('change'));

    await waitFor(async () => (await storedSettings()).systemPrompt === '  语气正式一点  ');
    expect((await storedSettings()).systemPrompt).toBe('  语气正式一点  ');
  });

  it('写入被拒时如实报错，界面不假装成功', async () => {
    await seedSettings({ systemPrompt: '' });
    await loadOptions();
    chromeStub.storage.local.set = async () => {
      throw new Error('存储写入失败');
    };

    textarea().value = '写不进去';
    textarea().dispatchEvent(bubble('change'));

    await waitFor(() => status().dataset.kind === 'err');
    expect(status().textContent).toContain('保存提示词失败');
    expect((await storedSettings()).systemPrompt).toBe('');
  });

  it('界面上如实说明「留空即使用内置提示词」——用户可见的承诺，不只是装饰', async () => {
    // 独立成例而不是并进上面某条：这句话住在静态 HTML 里，**没有前置条件**，
    // 并进别的用例只会让它的读数被那一条的前置挡在前面（本单元反复踩过的坑）。
    await seedSettings({ systemPrompt: '' });
    await loadOptions();

    expect(pick<HTMLElement>('sec-prompt').textContent ?? '').toContain('留空即使用内置提示词');
  });
});
