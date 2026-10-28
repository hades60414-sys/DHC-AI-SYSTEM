import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { Workflow } from 'lucide-react';
import { afterEach, test, vi } from 'vitest';

import type * as FeatureWishesModule from '@/shared/featureWishes';
import type { FeatureWish } from '@/shared/featureWishes';

/**
 * DHC CLI 10/07 功能許願池: a handle above 待辦 opens a form (主題、描述、署名, blank = 匿名) and everyone's
 * wishes; 「跟 DHC CLI 討論」 opens a chat whose first message asks how deep the person wants to go.
 */

const store = vi.hoisted(() => ({ wishes: [] as FeatureWish[], added: [] as unknown[] }));
vi.mock('@/shared/featureWishes', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureWishesModule>()),
  startFeatureWishesSync: () => () => {},
  useFeatureWishes: () => store.wishes,
  addFeatureWish: (wish: { title: string }) => {
    if (!wish.title.trim()) return false;
    store.added.push(wish);
    return true;
  },
}));

const { default: WishPool } = await import('@/modules/wish-pool/WishPool');
const { parseFeatureWishes, wishDiscussionPrompt } = await import('@/shared/featureWishes');

type HarnessProps = { onDiscuss?: (prompt: string) => void; onOpenTool?: (id: string) => void; onOpenLibrary?: () => void };
const SLOTS = [{ id: 'plan-board', name: '規劃白板', icon: Workflow }, null, null, null, null];
// The page owns whether 功能許願池 is open (工具庫 opens it); the button below stands in for 工具庫.
function Harness({ onDiscuss = () => {}, onOpenTool = () => {}, onOpenLibrary = () => {} }: HarnessProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>工具庫的許願池</button>
      <WishPool isMobile={false} onDiscuss={onDiscuss} slots={SLOTS} onOpenTool={onOpenTool} onOpenLibrary={onOpenLibrary} wishesOpen={open} onWishesOpenChange={setOpen} />
    </>
  );
}
const openWishPool = () => {
  fireEvent.click(screen.getByRole('button', { name: '工具庫的許願池' }));
};

afterEach(() => {
  localStorage.clear();
  store.wishes = [];
  store.added = [];
});

test('a wish with a title is sent with its name, the name stays for the next one, and a blank name shows as 匿名', () => {
  store.wishes = [{ id: 'w1', title: '匯出 Excel', description: '', author: '', createdAt: '2026-10-07T02:00:00Z' }];
  render(<Harness />);
  openWishPool();
  assert.ok(screen.getByRole('dialog', { name: '功能許願池' }));
  assert.ok(screen.getByText(/匿名/));

  const send = screen.getByRole('button', { name: '許願' }) as HTMLButtonElement;
  assert.equal(send.disabled, true, 'no title, no wish');
  fireEvent.change(screen.getByLabelText('主題'), { target: { value: '待辦可以排序' } });
  fireEvent.change(screen.getByLabelText('描述'), { target: { value: '拖曳調順序' } });
  fireEvent.change(screen.getByLabelText('署名'), { target: { value: '同事A' } });
  fireEvent.click(send);

  assert.deepEqual(store.added, [{ title: '待辦可以排序', description: '拖曳調順序', author: '同事A' }]);
  assert.equal((screen.getByLabelText('主題') as HTMLInputElement).value, '');
  assert.equal((screen.getByLabelText('署名') as HTMLInputElement).value, '同事A');
});

test('discussing opens a chat with the draft in the opening message and keeps the draft for afterwards', () => {
  const prompts: string[] = [];
  const first = render(<Harness onDiscuss={(prompt) => prompts.push(prompt)} />);
  openWishPool();
  fireEvent.change(screen.getByLabelText('主題'), { target: { value: '待辦可以排序' } });
  fireEvent.click(screen.getByRole('button', { name: '跟 DHC CLI 討論' }));

  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /主題：待辦可以排序/);
  assert.match(prompts[0], /先問我想討論多詳細/);
  assert.match(prompts[0], /A\. 快速.*MVP/);
  assert.equal(screen.queryByRole('dialog'), null, 'closes so the chat is in view');
  first.unmount();

  render(<Harness />);
  openWishPool();
  assert.equal((screen.getByLabelText('主題') as HTMLInputElement).value, '待辦可以排序');
});

test('自選功能 fans out five slots on hover; the handle and empty slots open 工具庫, a filled slot opens its tool', () => {
  const opened: string[] = [];
  let library = 0;
  render(<Harness onOpenTool={(id) => opened.push(id)} onOpenLibrary={() => { library += 1; }} />);
  const handle = screen.getByRole('button', { name: '自選功能' });
  assert.equal(handle.getAttribute('aria-expanded'), 'false');
  fireEvent.mouseEnter(handle);
  assert.equal(handle.getAttribute('aria-expanded'), 'true', 'hover fans it out');
  assert.equal(screen.getAllByText('新增自選').length, 4);
  fireEvent.click(screen.getByRole('button', { name: '規劃白板' }));
  assert.deepEqual(opened, ['plan-board']);
  fireEvent.mouseEnter(handle);
  fireEvent.click(screen.getByRole('button', { name: '自選位置 3（空）：新增自選' }));
  assert.equal(library, 1, 'an empty slot opens 工具庫');
  fireEvent.click(handle);
  assert.equal(library, 2, 'clicking the handle opens 工具庫');
  assert.equal(handle.getAttribute('aria-expanded'), 'false');
});

test('stored wishes are read defensively', () => {
  assert.deepEqual(parseFeatureWishes(null), []);
  assert.deepEqual(parseFeatureWishes({ items: [{ id: 'a', title: 'x' }, { title: 'no id' }] }), [
    { id: 'a', title: 'x', description: '', author: '', createdAt: '' },
  ]);
  assert.match(wishDiscussionPrompt({ title: '', description: '' }), /（還沒想好）/);
});
