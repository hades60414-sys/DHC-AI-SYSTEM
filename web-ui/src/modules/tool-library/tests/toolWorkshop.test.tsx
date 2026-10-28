import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type * as CustomToolsModule from '@/shared/customTools';
import type * as SharedToolsModule from '@/shared/sharedTools';

vi.mock('@/shared/customTools', async (importOriginal) => ({
  ...(await importOriginal<typeof CustomToolsModule>()),
  loadToolData: async () => ({ tools: [{ id: 't1', name: '費率計算', html: '<!doctype html><html><head><title>x</title></head><body>hi</body></html>', template: '計算機', chat: [] }], activeId: 't1' }),
  createToolSaver: () => ({ save: () => {}, flush: async () => {} }),
}));
vi.mock('@/shared/sharedTools', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedToolsModule>()),
  startSharedToolsSync: () => () => {},
  useSharedTools: () => [],
}));

vi.mock('@/modules/tool-library/importers', () => ({
  readTextFile: (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  }),
  readSpreadsheetFile: async () => [],
}));

const { default: ToolWorkshop } = await import('@/modules/tool-library/tools/ToolWorkshop');
const { PREVIEW_CSP, importedTool, toolNameFromFile, PREVIEW_SANDBOX, buildSrcdoc, parseWorkshopData, parseWorkshopResult, workshopBrief } = await import('@/modules/tool-library/tools/workshopModel');
const { parseSharedTools } = await import('@/shared/sharedTools');

Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);

test('srcdoc puts the no-network CSP first in the head, whatever shape the html has', () => {
  assert.ok(PREVIEW_CSP.includes("default-src 'none'"));
  const withHead = buildSrcdoc('<!doctype html><html><head><title>x</title></head><body></body></html>');
  assert.match(withHead, /<head><meta http-equiv="Content-Security-Policy"[^>]*default-src 'none'[^>]*><title>/);
  assert.match(buildSrcdoc('<html><body>a</body></html>'), /<html><head><meta http-equiv="Content-Security-Policy"/);
  assert.match(buildSrcdoc('<p>bare</p>'), /<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy".*<body><p>bare<\/p>/);
});

test('the preview iframe is sandboxed without allow-same-origin and uses srcdoc', async () => {
  assert.equal(PREVIEW_SANDBOX, 'allow-scripts allow-forms allow-modals');
  render(<ToolWorkshop profileId="p1" profileName="同事A" isMobile={false} onClose={() => {}} onStartWork={null} />);
  const frame = await waitFor(() => screen.getByTitle('預覽：費率計算')) as HTMLIFrameElement;
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-forms allow-modals');
  assert.ok(!frame.getAttribute('sandbox')!.includes('allow-same-origin'));
  assert.ok(frame.getAttribute('srcdoc')!.includes('Content-Security-Policy'));
  assert.equal(frame.getAttribute('src'), null);
});

test('stored data, AI results, shared lists and the brief are parsed defensively', () => {
  assert.deepEqual(parseWorkshopData(null), { tools: [], activeId: null });
  const data = parseWorkshopData({ tools: [{ id: 'a' }, { nope: 1 }], activeId: 'zzz' });
  assert.equal(data.tools.length, 1);
  assert.equal(data.activeId, 'a');
  assert.deepEqual(parseWorkshopResult({ name: ' 計算機 ', html: '<p>x</p>' }), { name: '計算機', html: '<p>x</p>' });
  assert.throws(() => parseWorkshopResult({ html: 'plain' }));
  assert.equal(parseSharedTools({ items: [{ id: '1', html: '<p/>' }, { id: '2' }] }).length, 1);
  assert.match(workshopBrief({ name: 'T', html: '<p>x</p>' }), /<p>x<\/p>/);
});

test('importedTool names the tool after the file, refuses non-html and files over 200KB', () => {
  const ok = importedTool('費率 計算.v2.html', '<p>hi</p>');
  assert.ok('tool' in ok);
  if ('tool' in ok) {
    assert.equal(ok.tool.name, '費率 計算.v2');
    assert.equal(ok.tool.html, '<p>hi</p>');
  }
  assert.ok('error' in importedTool('x.html', 'plain words'));
  assert.ok('error' in importedTool('big.html', '<p>' + 'a'.repeat(200 * 1024) + '</p>'));
  assert.equal(toolNameFromFile('a'.repeat(100) + '.html').length, 60);
});

test('importing html files adds tools that render only in the sandboxed srcdoc preview', async () => {
  render(<ToolWorkshop profileId="p1" profileName="同事A" isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.ok(screen.getByTestId('tool-import-input')));
  const page = new File(['<html><body><script>1</script>匯入的頁面</body></html>'], '我的小工具.html', { type: 'text/html' });
  const text = new File(['hello'], 'readme.txt');
  fireEvent.change(screen.getByTestId('tool-import-input'), { target: { files: [page, text] } });
  await waitFor(() => assert.ok(screen.getByText(/匯入了 1 個工具.*我的小工具.*readme\.txt 不是 \.html/)));
  const frame = await waitFor(() => {
    const found = document.querySelector('iframe');
    assert.ok(found?.getAttribute('srcdoc')?.includes('匯入的頁面'));
    return found as HTMLIFrameElement;
  });
  assert.equal(frame.getAttribute('sandbox'), PREVIEW_SANDBOX);
  assert.ok(frame.getAttribute('srcdoc')?.includes("default-src 'none'"));
});
