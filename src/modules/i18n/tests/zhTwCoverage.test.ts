import assert from 'node:assert/strict';
import test from 'node:test';
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
    assert.deepEqual(flat(en).filter((key) => !have.has(key)), []);
  });
}
