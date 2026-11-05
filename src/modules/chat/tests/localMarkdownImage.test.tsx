import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { ChatProjectContext } from '@/modules/chat/context/ChatProjectContext';
import { Markdown } from '@/modules/chat/transcript/Markdown';
import { LOCAL_IMAGE_PREFIX, rewriteLocalImages } from '@/modules/chat/transcript/LocalMarkdownImage';

const BS = String.fromCharCode(92);
const WIN = ['C:', 'Users', 'demo', 'DHC Workspace', '工具實驗', '截圖', '1-設定.png'].join(BS);
const readFileBlob = vi.fn();
vi.mock('@/shared/api', () => ({ api: { readFileBlob: (...a: unknown[]) => readFileBlob(...a) }, transcribeVoice: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@/modules/code-editor', () => ({ MermaidDiagram: () => null }));

beforeEach(() => {
  readFileBlob.mockReset();
  (URL as any).createObjectURL = vi.fn(() => 'blob:fake');
  (URL as any).revokeObjectURL = vi.fn();
});

test('rewriteLocalImages：反斜線、正斜線、中文與空白路徑都改寫；http／data 與非圖片不動', () => {
  const a = rewriteLocalImages(`![1-設定](${WIN})`);
  assert.equal(a, `![1-設定](${LOCAL_IMAGE_PREFIX}${encodeURIComponent(WIN)})`);
  assert.ok(rewriteLocalImages('![x](D:/path/a.JPG)').includes(LOCAL_IMAGE_PREFIX));
  assert.equal(rewriteLocalImages('![x](https://a.com/a.png)'), '![x](https://a.com/a.png)');
  assert.equal(rewriteLocalImages('![x](data:image/png;base64,AAA)'), '![x](data:image/png;base64,AAA)');
  assert.equal(rewriteLocalImages(`![x](D:${BS}a${BS}b.pdf)`), `![x](D:${BS}a${BS}b.pdf)`);
});

test('訊息中的本機圖片：以專案端點讀取並顯示，點擊可放大', async () => {
  readFileBlob.mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['x']) });
  render(
    <ChatProjectContext.Provider value="proj1">
      <Markdown>{`看圖 ![1-設定](${WIN})`}</Markdown>
    </ChatProjectContext.Provider>,
  );
  const img = await screen.findByRole('img', { name: '1-設定' });
  assert.equal(img.getAttribute('src'), 'blob:fake');
  assert.deepEqual(readFileBlob.mock.calls[0].slice(0, 2), ['proj1', WIN]);
  fireEvent.click(screen.getByRole('button', { name: /放大圖片/ }));
  assert.ok(screen.getByRole('dialog'));
});

test('專案外的路徑（403）：顯示可見的失敗訊息與路徑', async () => {
  readFileBlob.mockResolvedValue({ ok: false, status: 403 });
  render(
    <ChatProjectContext.Provider value="proj1">
      <Markdown>{'![x](E:/other/a.png)'}</Markdown>
    </ChatProjectContext.Provider>,
  );
  await waitFor(() => assert.ok(screen.getByText(/圖片無法顯示：E:\/other\/a\.png/)));
  assert.ok(screen.getByText(/路徑在專案目錄之外/));
});

test('一般 https 圖片照常顯示', () => {
  render(<Markdown>{'![x](https://example.com/a.png)'}</Markdown>);
  assert.equal(screen.getByRole('img', { name: 'x' }).getAttribute('src'), 'https://example.com/a.png');
  assert.equal(readFileBlob.mock.calls.length, 0);
});
