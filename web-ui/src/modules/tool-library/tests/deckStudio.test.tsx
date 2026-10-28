import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type * as CustomToolsModule from '@/shared/customTools';

const MD = '# 封面\n\n> 旁白：大家好\n> 旁白：今天報告\n\n---\n\n## 重點\n\n- 甲\n- 乙\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n---\n```\n\n---\n\n## 結尾 <script>alert(1)</script>';

vi.mock('@/shared/customTools', async (importOriginal) => ({
  ...(await importOriginal<typeof CustomToolsModule>()),
  loadToolData: async () => ({ decks: [{ id: 'd1', name: '月報', markdown: '# 封面\n\n---\n\n## 第二頁\n\n> 旁白：說明', chat: [] }], activeId: 'd1' }),
  createToolSaver: () => ({ save: () => {}, flush: async () => {} }),
}));

const { default: DeckStudio } = await import('@/modules/tool-library/tools/DeckStudio');
const { FIT_STEPS, buildDeckHtml, deckBrief, isTitleSlide, parseDeckData, pickFitScale, splitSlides } = await import('@/modules/tool-library/tools/deckModel');

Element.prototype.scrollIntoView = () => {};
// jsdom has no layout; CodeMirror measures ranges.
Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
afterEach(cleanup);

test('slides split on --- lines (not in code fences or table rules) and narration is pulled out', () => {
  const slides = splitSlides(MD);
  assert.equal(slides.length, 3);
  assert.deepEqual(slides[0].narration, ['大家好', '今天報告']);
  assert.ok(!slides[0].body.includes('旁白'));
  assert.ok(slides[1].body.includes('| 1 | 2 |'));
  assert.ok(slides[1].body.includes('```\n---\n```'));
  assert.equal(splitSlides('').length, 1);
});

test('the downloaded deck is self-contained, pre-rendered, hides narration and does not run raw html', () => {
  const html = buildDeckHtml('月報 <1>', MD);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<title>月報 &lt;1&gt;</title>'));
  assert.equal((html.match(/<section class="deck-slide[ "]/g) ?? []).length, 3);
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('ArrowRight'));
  assert.ok(!html.includes('旁白'));
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!/(src|href)="https?:/.test(html));
});

test('export carries scoped slide colours, bullets, title-slide styling and the auto-fit script; fit steps are pure', () => {
  const html = buildDeckHtml('月報', MD);
  assert.ok(html.includes('.deck-box .deck-slide h4{font-weight:700;color:#0f3d6e}'));
  assert.ok(html.includes('.deck-box .deck-slide ul{list-style:disc outside}'));
  assert.ok(html.includes('.deck-box .deck-slide ol{list-style:decimal outside}'));
  assert.ok(html.includes('class="deck-slide deck-title"'));
  assert.ok(html.includes(`var F=${JSON.stringify(FIT_STEPS)}`) && html.includes("setProperty('--fit'"));
  assert.equal(pickFitScale(() => false), 1);
  assert.equal(pickFitScale((s) => s > 0.8), 0.78);
  assert.equal(pickFitScale(() => true), 0.55);
  assert.ok(isTitleSlide('# 封面\n\n副標') && !isTitleSlide('## 重點'));
});

test('briefs name the skill and carry the script; stored decks parse defensively', () => {
  assert.match(deckBrief('月報', MD, 'pptx'), /pptx skill/);
  const mp4 = deckBrief('月報', MD, 'mp4');
  assert.match(mp4, /video-studio skill/);
  assert.ok(mp4.includes('> 旁白：大家好'));
  assert.deepEqual(parseDeckData('x'), { decks: [], activeId: null });
});

test('renders the editor, the slide preview and thumbnails, and moves between slides', async () => {
  render(<DeckStudio profileId="p1" profileName="同事A" isMobile={false} onClose={() => {}} onStartWork={() => {}} />);
  await waitFor(() => screen.getByText('1 / 2'));
  assert.ok(screen.getByRole('button', { name: '第 2 頁' }));
  fireEvent.click(screen.getByRole('button', { name: '下一頁' }));
  await waitFor(() => screen.getByText('2 / 2'));
  assert.ok(screen.getByText('說明'));
  assert.ok(screen.getByRole('button', { name: '做成 PPTX／影片' }));
});

test('handoff: markdown-slides on mount is appended to the open deck, or becomes a new deck', async () => {
  const { sendToTool } = await import('@/shared/toolHandoff');
  const { applyDeckHandoff } = await import('@/modules/tool-library/tools/handoffModel');
  sendToTool({ tool: 'deck-studio', kind: 'markdown-slides', from: "試算工作台『部位』", payload: { markdown: '## 部位\n\n| a |\n| --- |\n| 1 |', summary: '放進一頁簡報（1 列）' } });
  render(<DeckStudio profileId="p1" profileName="同事A" isMobile={false} onClose={() => {}} onStartWork={() => {}} />);
  await waitFor(() => screen.getByText('1 / 3'));
  assert.ok(screen.getByText(/已從 試算工作台『部位』放進一頁簡報（1 列）/));
  assert.equal((screen.getByRole('button', { name: '復原' }) as HTMLButtonElement).disabled, false);

  const base = { decks: [{ id: 'd1', name: '月報', markdown: '# A', chat: [] }], activeId: 'd1' };
  const fresh = applyDeckHandoff(base, { tool: 'deck-studio', kind: 'markdown-slides', from: '文件共編『x』', payload: { markdown: '# X', title: 'X', newDeck: true, summary: '做成簡報（1 頁）' } });
  assert.equal(fresh?.data.decks.length, 2);
  assert.equal(fresh?.data.decks[1].name, 'X');
  assert.equal(fresh?.data.activeId, fresh?.data.decks[1].id);
});
