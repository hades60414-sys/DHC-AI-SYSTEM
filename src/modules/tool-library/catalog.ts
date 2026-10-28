import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { FileText, GitCompare, Hammer, Kanban, Presentation, Table2, Workflow } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** What every tool window gets from 自選功能. */
export type ToolProps = {
  /** Whose data: this device's 專案設定 profile. */
  profileId: string;
  profileName: string;
  /** The person's own project (their 待辦 live under it); null when the profile has none. */
  projectId?: string | null;
  isMobile: boolean;
  onClose: () => void;
  /** Opens a new chat in the person's project and sends the brief; null when the profile has no project. */
  onStartWork: ((brief: string) => void) | null;
};

export type ToolCategory = '規劃' | '資料與程式' | '產出';
export const TOOL_CATEGORIES: ToolCategory[] = ['規劃', '資料與程式', '產出'];

export type ToolInfo = {
  id: string;
  name: string;
  category: ToolCategory;
  icon: LucideIcon;
  /** One line on the card. */
  summary: string;
  /** What it does, shown when the card is opened. */
  details: string[];
};

/** DHC CLI 10/14 工具庫: every tool on the shelf, in the order shown. */
export const TOOL_CATALOG: ToolInfo[] = [
  {
    id: 'plan-board',
    name: '規劃白板',
    category: '規劃',
    icon: Workflow,
    summary: '畫流程、SOP、心智圖、資料流程，AI 先畫骨架，按開工交給 AI 做。',
    details: ['開源白板 Excalidraw，方框、箭頭、手繪、顏色都能改', '模式：自由／SOP 泳道／心智圖／資料流程', '右邊 AI 對話幫你畫、幫你改', '開工：整張圖變成工作說明，開新對話送出'],
  },
  {
    id: 'project-board',
    name: '專案板',
    category: '規劃',
    icon: Kanban,
    summary: '看板＋甘特圖同一批工作，拖到「交給 AI」就開對話去做。',
    details: ['看板與甘特圖一鍵切換', 'AI 幫你拆工作、排時程', '卡片拖到「交給 AI」欄：開新對話執行這張卡', '開工：整個板子交給對話規劃執行'],
  },
  {
    id: 'sheet-bench',
    name: '試算工作台',
    category: '資料與程式',
    icon: Table2,
    summary: '貼上 Excel，請 AI 清理、加欄位、做樞紐，最後轉成可重跑的腳本。',
    details: ['從 Excel 直接貼上表格', '請 AI 清理、算新欄位、彙總', '每一步都記下來，可以復原', '匯出 CSV；開工：把步驟寫成可重跑的程式'],
  },
  {
    id: 'code-review',
    name: '程式差異審閱台',
    category: '資料與程式',
    icon: GitCompare,
    summary: '貼兩版 SP 或程式，並排比對，AI 逐段標風險。',
    details: ['左右兩版並排、差異上色', 'AI 逐段註解風險與疑點', '開工：把要改的清單交給對話去改'],
  },
  {
    id: 'tool-workshop',
    name: '小工具工坊',
    category: '資料與程式',
    icon: Hammer,
    summary: '一句話做出計算機、表單、儀表板等小工具，可以分享給同事。',
    details: ['描述想要的工具，AI 做成單一網頁', '在旁邊直接試用、繼續叫它改', '分享到「大家的工具」，同事可以複製一份來改', '下載成 HTML 檔'],
  },
  {
    id: 'doc-editor',
    name: '文件共編',
    category: '產出',
    icon: FileText,
    summary: '寫報告、SOP、說明文件，AI 幫你補段落、改寫，匯出 Word。',
    details: ['左邊寫、右邊即時預覽（Markdown）', 'AI 補章節、改寫、統一用語', '匯出 Word（.docx）', '開工：交給對話繼續做'],
  },
  {
    id: 'deck-studio',
    name: '簡報影片工作室',
    category: '產出',
    icon: Presentation,
    summary: '一份稿子出簡報，加上旁白就能做成影片。',
    details: ['用一份稿子寫投影片，即時預覽、全螢幕播放', 'AI 幫你排大綱、寫每頁、寫旁白', '下載成網頁簡報', '開工：做成 PPTX 或配音 MP4'],
  },
];

export const findTool = (id: string | null | undefined) => TOOL_CATALOG.find((tool) => tool.id === id) ?? null;

/**
 * The windows that are built, loaded the first time they open. 規劃白板 has its own window (ProjectWishPool);
 * a catalog entry missing here shows as 製作中 and cannot be picked.
 */
export const TOOL_WINDOWS: Record<string, LazyExoticComponent<ComponentType<ToolProps>>> = {
  'project-board': lazy(() => import('@/modules/tool-library/tools/ProjectBoard')),
  'code-review': lazy(() => import('@/modules/tool-library/tools/CodeReview')),
  'tool-workshop': lazy(() => import('@/modules/tool-library/tools/ToolWorkshop')),
  'sheet-bench': lazy(() => import('@/modules/tool-library/tools/SheetBench')),
  'doc-editor': lazy(() => import('@/modules/tool-library/tools/DocEditor')),
  'deck-studio': lazy(() => import('@/modules/tool-library/tools/DeckStudio')),
};

export const isToolReady = (id: string) => id === 'plan-board' || id in TOOL_WINDOWS;
