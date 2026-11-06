// V5：原本用 node:test 寫在 src/ 下，vitest 找不到 suite、後端 npm test 也不掃 src/ → 從未執行過。改用 vitest。
import { expect, test } from 'vitest';
import enChat from '@/modules/i18n/locales/en/chat.json';
import enSidebar from '@/modules/i18n/locales/en/sidebar.json';
import zhChat from '@/modules/i18n/locales/zh-TW/chat.json';
import zhSidebar from '@/modules/i18n/locales/zh-TW/sidebar.json';

const flat = (value: unknown, prefix = ''): string[] =>
  value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, child]) => flat(child, `${prefix}${key}.`))
    : [prefix.slice(0, -1)];

for (const [name, en, zh] of [['chat', enChat, zhChat], ['sidebar', enSidebar, zhSidebar]] as const) {
  test(`zh-TW ${name} 不缺 key`, () => {
    const have = new Set(flat(zh));
    expect(flat(en).filter((key) => !have.has(key))).toEqual([]);
  });
}
