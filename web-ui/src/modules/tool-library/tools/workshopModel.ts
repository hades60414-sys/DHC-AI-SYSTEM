import type { AssistMessage } from '@/shared/customTools';

/** DHC CLI 10/14 小工具工坊: stored data, the sandboxed preview document, and the 開工 brief. */

export type WorkshopTool = {
  id: string;
  name: string;
  html: string;
  template: string;
  chat: AssistMessage[];
};
export type WorkshopData = { tools: WorkshopTool[]; activeId: string | null };

export const WORKSHOP_TEMPLATES: Array<{ name: string; hint: string }> = [
  { name: '空白', hint: '從零開始，描述你要的工具。' },
  { name: '計算機', hint: '例如：算損益、費率、換算，填數字就出結果。' },
  { name: '表單／檢核清單', hint: '例如：每日開盤前檢核清單，可勾選並統計完成度。' },
  { name: '儀表板（貼資料出圖）', hint: '例如：貼上一欄日期一欄數字，畫成折線圖或長條圖。' },
];

/** The iframe sandbox: scripts and forms run, but the page is an opaque origin (no allow-same-origin). */
export const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals';
export const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;

/** The document for the preview iframe's srcdoc: the page with the network-forbidding CSP first in its head. */
export function buildSrcdoc(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + CSP_META + html.slice(head.index + head[0].length);
  const root = /<html(\s[^>]*)?>/i.exec(html);
  if (root) return `${html.slice(0, root.index + root[0].length)}<head>${CSP_META}</head>${html.slice(root.index + root[0].length)}`;
  return `<!doctype html><html><head><meta charset="utf-8">${CSP_META}</head><body>${html}</body></html>`;
}

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const newWorkshopTool = (name: string, template = '空白', html = ''): WorkshopTool => ({
  id: newId(), name, html, template, chat: [],
});

export function parseWorkshopData(value: unknown): WorkshopData {
  const raw = value && typeof value === 'object' ? (value as { tools?: unknown; activeId?: unknown }) : {};
  const tools = (Array.isArray(raw.tools) ? raw.tools : [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof (item as { id?: unknown }).id === 'string')
    .map((item) => ({
      id: item.id as string,
      name: typeof item.name === 'string' && item.name ? item.name : '未命名工具',
      html: typeof item.html === 'string' ? item.html : '',
      template: typeof item.template === 'string' ? item.template : '空白',
      chat: Array.isArray(item.chat)
        ? (item.chat as unknown[]).filter((m): m is AssistMessage => (
          Boolean(m) && ((m as AssistMessage).role === 'user' || (m as AssistMessage).role === 'assistant') && typeof (m as AssistMessage).text === 'string'
        ))
        : [],
    }));
  const activeId = typeof raw.activeId === 'string' && tools.some((tool) => tool.id === raw.activeId) ? raw.activeId : (tools[0]?.id ?? null);
  return { tools, activeId };
}

/** What the AI's `result` must hold: a name and a full page. Throws (so the frame says 格式不對) otherwise. */
export function parseWorkshopResult(result: unknown): { name: string; html: string } {
  const value = result as { name?: unknown; html?: unknown } | null;
  if (!value || typeof value.html !== 'string' || !/<\w/.test(value.html)) throw new Error('bad result');
  return { name: typeof value.name === 'string' ? value.name.trim().slice(0, 60) : '', html: value.html };
}

export const safeFileName = (name: string) => `${name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'tool'}`;

export function workshopBrief(tool: Pick<WorkshopTool, 'name' | 'html'>): string {
  return [
    `我在「小工具工坊」做了一個小工具「${tool.name}」，想把它做成正式的頁面／功能。`,
    '',
    '請先看一下下面這份單一檔案 HTML 的功能，確認需求後（有疑問先問我）把它整理成正式版本：沿用同樣的操作與畫面，補齊必要的資料來源、錯誤處理與存放位置。',
    '',
    '```html',
    tool.html,
    '```',
  ].join('\n');
}

/** Same size cap as sharing (200KB), so an imported tool can always be shared later. */
export const MAX_IMPORT_HTML = 200 * 1024;

/** A tool name from a file name: extension dropped, 60 characters at most. */
export const toolNameFromFile = (fileName: string) => fileName.replace(/\.[^.]*$/, '').trim().slice(0, 60) || '匯入的工具';

/** The tool for one imported .html file, or the reason it was refused. */
export function importedTool(fileName: string, html: string): { tool: WorkshopTool } | { error: string } {
  if (!/<\w/.test(html)) return { error: `${fileName} 裡沒有看得出來的 HTML` };
  if (new Blob([html]).size > MAX_IMPORT_HTML) return { error: `${fileName} 超過 200KB，太大沒有匯入` };
  return { tool: newWorkshopTool(toolNameFromFile(fileName), '匯入', html) };
}
