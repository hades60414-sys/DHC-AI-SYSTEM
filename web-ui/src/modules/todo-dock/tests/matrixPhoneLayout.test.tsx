import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import EisenhowerMatrix from '@/modules/todo-dock/EisenhowerMatrix';

const original = { w: window.innerWidth, h: window.innerHeight };
const setViewport = (w: number, h: number) => {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
};
afterEach(() => setViewport(original.w, original.h));

test('橫握手機 844x390（isMobile=false）也走手機版：不出現今日待辦欄、不旋轉', () => {
  setViewport(844, 390);
  render(<EisenhowerMatrix personId="p1" personName="甲" isMobile={false} onClose={() => {}} />);
  assert.equal(screen.queryByRole('complementary', { name: '今日待辦' }), null);
  const root = screen.getByRole('dialog', { name: '全部待辦' }).parentElement!;
  assert.equal(root.style.transform, '');
});

test('直握手機 390x844：外框轉 90 度，寬 = 844、高 = 390', () => {
  setViewport(390, 844);
  render(<EisenhowerMatrix personId="p1" personName="甲" isMobile onClose={() => {}} />);
  const root = screen.getByRole('dialog', { name: '全部待辦' }).parentElement!;
  assert.equal(root.style.transform, 'rotate(90deg)');
  assert.equal(root.style.width, '844px');
  assert.equal(root.style.height, '390px');
  assert.ok(screen.getByRole('button', { name: '收起全部待辦' }));
});

test('桌面 1280x800 維持桌面版（有今日待辦欄）', () => {
  setViewport(1280, 800);
  render(<EisenhowerMatrix personId="p1" personName="甲" isMobile={false} onClose={() => {}} />);
  assert.ok(screen.getByRole('complementary', { name: '今日待辦' }));
});

test('旋轉直握（390x844）與真橫握（844x390）內部 class 結構完全相同，且不靠 max-md:／md: 變體', () => {
  const html = (w: number, h: number) => {
    setViewport(w, h);
    const { unmount } = render(<EisenhowerMatrix personId="p1" personName="甲" isMobile={w < 768} onClose={() => {}} />);
    const out = screen.getByRole('dialog', { name: '全部待辦' }).outerHTML;
    unmount();
    return out;
  };
  const rotated = html(390, 844);
  const landscape = html(844, 390);
  assert.equal(rotated, landscape);
  assert.ok(!/max-md:|\smd:/.test(rotated.replace(/aria-label="[^"]*"/g, '')));
  assert.ok(rotated.includes('w-56'));
});
