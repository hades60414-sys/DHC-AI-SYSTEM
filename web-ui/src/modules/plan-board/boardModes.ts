import type { BoardMode } from '@/shared/planBoards';

/**
 * DHC CLI 10/14 規劃白板 modes: the same canvas, but the AI lays the board out the way the mode needs (told in
 * a note added to each request) and 開工 asks for that mode's product (SOP 文件, 大綱＋待辦, 資料管線).
 */
type ModeInfo = {
  label: string;
  /** Empty-chat hint beside the canvas. */
  intro: string;
  /** Added to every request to the AI; empty for 自由. */
  aiNote: string;
  /** First line of the 開工 brief. */
  briefLead: (name: string) => string;
  /** Last line of the 開工 brief: what to produce. */
  briefAsk: string;
};

export const BOARD_MODES: Record<BoardMode, ModeInfo> = {
  free: {
    label: '自由',
    intro: '說你想規劃什麼，例如「畫一個每天抓資料庫部位、算風險、寄報表給主管的流程」。AI 會先畫方框和箭頭，你再拉動、改顏色、加文字或手繪，也可以繼續叫它改（手繪和文字註記它不會動）。',
    aiNote: '',
    briefLead: (name) => `依照這張系統規劃圖開工（白板「${name}」）。`,
    briefAsk: '先用幾句話說明你對這張圖的理解，列出執行步驟（每步怎麼驗證）；有需要我決定的地方先問我，確認後再動手。',
  },
  sop: {
    label: 'SOP 泳道',
    intro: '說是哪個作業流程、有哪些角色，例如「月底部位對帳：業務、作業、風控、會計」。AI 會一個角色一條泳道、由左到右排步驟；開工會寫成 SOP 文件。',
    aiNote: '（SOP 泳道模式：每個角色或單位一列，同一列方框的 y 相同、列距 160，最左邊第一個方框寫角色名稱；步驟由左到右照順序排，方框文字寫「動作」，第二行補輸入／輸出；判斷用菱形概念寫成「是否…？」方框，條件寫在箭頭上。）',
    briefLead: (name) => `依照這張 SOP 泳道圖寫一份作業 SOP（白板「${name}」）。`,
    briefAsk: '請產出 Word（.docx）SOP：目的、適用範圍、角色與職責、逐步驟表（步驟編號、負責角色、動作、輸入、輸出、檢核點）、例外與升級處理、相關系統與檔案。圖上看不出來的地方先列出問題問我，確認後再寫。',
  },
  mindmap: {
    label: '心智圖',
    intro: '說一個主題，例如「新人要學的工作」。AI 會把主題放中間、分支往右長成樹；開工會整理成大綱和待辦。',
    aiNote: '（心智圖模式：中心主題放在 x 0、y 0；子節點往右展開成樹，每深一層 x 加 260，同一層兄弟節點 y 間距 100、以父節點為中心上下排開，方框 w 180、h 60；箭頭從父指向子、不寫文字；每個節點文字 2–8 個字。）',
    briefLead: (name) => `依照這張心智圖整理（白板「${name}」）。`,
    briefAsk: '請整理成條列大綱（照樹的層級縮排），再把其中可以執行的項目另外列成待辦清單（每項一行、動詞開頭）。看不懂的分支先問我。',
  },
  dataflow: {
    label: '資料流程',
    intro: '說資料從哪裡來、要變成什麼，例如「從資料庫的部位表和市價表算每日損益，寫進報表」。AI 會畫來源表 → 處理 → 產出；開工會寫成可重跑的資料管線。',
    aiNote: '（資料流程模式：方框分三種——資料來源（寫成「主機.資料庫.表名」，第二行列主要欄位）、處理步驟（寫做什麼，例如「依日期 join」「算損益」）、產出（檔名、報表或目的表）；來源在最左、產出在最右；箭頭寫傳遞的資料或欄位。不知道真實表名就寫「待確認：…」，不要編。）',
    briefLead: (name) => `依照這張資料流程圖做一條資料管線（白板「${name}」）。`,
    briefAsk: '動手前先列出要讀的表與欄位並實際確認存在（標「待確認」的先問我）；用 Node.js 寫可重跑的管線（本機不跑 Python），每一步加檢核（筆數、空值、合計），輸出格式先給我看。對不上的數字列成差異，不要硬湊。',
  },
};

export const MODE_ORDER: BoardMode[] = ['free', 'sop', 'mindmap', 'dataflow'];
