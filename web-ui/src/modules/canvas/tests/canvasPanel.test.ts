import { describe, expect, it } from 'vitest';

import { pageOfDoc, selectionPrompt } from '@/modules/canvas/CanvasPanel';
import { canvasLinkOf, storedNameOfLink } from '@/modules/canvas/CanvasEmbed';
import type { CanvasDoc } from '@/modules/canvas/canvasModel';

const fileDoc: CanvasDoc = { id: 'file:D:\\p\\canvas\\a.html', kind: 'html', title: 'A', path: 'D:\\p\\canvas\\a.html', versions: [] };

describe('pageOfDoc', () => {
  it('renders Markdown with tables into a styled page', () => {
    const page = pageOfDoc({ ...fileDoc, kind: 'md' }, '# 標題\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(page).toContain('<h1>標題</h1>');
    expect(page).toContain('<table>');
    expect(page).toMatch(/^<!doctype html>/);
  });
});

describe('selectionPrompt', () => {
  it('asks for an Edit of just the picked part of a file', () => {
    const text = selectionPrompt(fileDoc, 2, { snippet: '<button id="calc">計算</button>', selector: 'button#calc' }, ' 改成綠色 ');
    expect(text).toContain('[畫布框選修改] 檔案：D:\\p\\canvas\\a.html（畫布第 2 版）');
    expect(text).toContain('選取器：button#calc');
    expect(text).toContain('要求：改成綠色');
    expect(text).toContain('用 Edit 只改這一段');
  });
  it('asks for the whole block back for a page that lives in a reply', () => {
    const text = selectionPrompt({ ...fileDoc, id: 'fence', path: undefined }, 1, { snippet: '表格文字' }, '加總');
    expect(text).toContain('回覆裡的網頁（畫布第 1 版）');
    expect(text).not.toContain('選取器');
    expect(text).toContain('```html 區塊');
  });
});

describe('canvas card links', () => {
  it('round-trips the stored name and ignores other links', () => {
    expect(storedNameOfLink(canvasLinkOf('1700-ab-計算機.html'))).toBe('1700-ab-計算機.html');
    expect(storedNameOfLink('https://app.example.dev/api/assets/files/x.html#dhc-canvas')).toBe('x.html');
    expect(storedNameOfLink('https://www.youtube.com/watch?v=1')).toBeNull();
    expect(storedNameOfLink('https://a.dev/api/assets/files/x.html')).toBeNull();
  });
});
