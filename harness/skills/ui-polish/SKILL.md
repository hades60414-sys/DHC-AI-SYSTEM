---
name: ui-polish
description: UI 優化武器庫。當使用者要「優化 UI / 讓畫面更好看 / 加動效 / 改版 redesign / 這畫面太 AI 太模板 / design polish / 調排版間距配色」時使用。先問要打哪一面(品味打磨 / 動效 / 風格指向),再讀對應 reference 套用;內建技術棧適配與可量測的驗收迴圈。萃取自 GSAP 官方 skills 與 taste-skill 系列的精華,重寫為自有內容(無第三方程式碼/殘留注入)。
---

# ui-polish — UI 優化武器庫

一套挑著用的 UI 升級工具。**核心鐵則:先問再動。** 除非使用者已明講要做哪一面,否則**先問清楚**再讀對應 reference 動手。別一被叫起來就埋頭亂改整頁。

## 武器庫(挑著用,各標適合的任務)

| 武器 | 適合什麼任務 | reference |
|---|---|---|
| **① 品味打磨**(anti-slop) | 畫面「能用但很平/很模板/很 AI」——排版尺度、間距節奏、對比層級、留白、配色、去 generic 感、補元件狀態 | `references/taste.md` |
| **② 動效**(motion) | landing / hero / 行銷頁、想要質感與 delight——scroll reveal、timeline、微互動、entrance;GSAP 為主、CSS/Framer 為輔 | `references/motion.md` |
| **③ 風格指向**(aesthetic / redesign) | 要一個明確風格、要對標某漂亮網站、從零定 design language——產出一致的 design tokens 再套用 | `references/aesthetics.md` |

> 可複選/組合(例:landing 常是 ①+② ;redesign 常是 ③+①)。

## 被觸發時的協定(Step 0:先問到位,再動手)

**動工前先把需求問到雙方有共識**(本機若裝有 grill-me 類的需求釐清 skill 可用它,沒有就直接照下面五問)。使用者常不確定自己要什麼;不懂的地方**給具體例子讓他挑**,別只問一句就埋頭做。深度隨任務規模:大改版往死裡問、小調整問到夠動工即止。至少釘死這五件:

1. **要打哪一面?** ① 品味打磨 ② 動效 ③ 風格指向(可複選)
2. **目標是哪個畫面/檔案?**(具體到專案 + 頁面/元件)
3. **想要的氣質 / 參考?**(一個形容詞,或一個他覺得漂亮的網站)
4. **不能動的東西?**(算錢/資料邏輯、既有元件、品牌色…)
5. **成功長什麼樣?**(可驗收的:對比達標、mobile 不溢出、加了 X 動效…)

問清楚 → 讀對應 reference → 動手 → 驗收(量 computed 值 + 看版面)→ 給 before/after。
即使使用者一開始就講得很具體,也至少補完「**不能動的**」與「**成功標準**」兩項再動手。

## 共通鐵則(三件武器都適用)

**技術棧適配(先認棧再下手):**
- **React + Vite / Tailwind**:改 `tailwind.config` 的 `theme.extend` + 元件 className;動效優先沿用專案既有庫(已用 Framer 就別硬加 GSAP)。
- **Next**:同上,注意 server/client component 邊界,動效放 client。
- **Streamlit**(資料儀表板 / 多頁工作台):沒有自由 DOM,靠 `st.markdown(unsafe_allow_html=True)` 注入 `<style>` + 善用 columns/container;每頁 `initial_sidebar_state="expanded"`(窄視窗會收合丟導覽)。
- **靜態 HTML / CJK 投影片**:手寫 HTML/CSS(`@page` 設版面)→ Edge headless `--print-to-pdf` 出 PDF。

**只動「呈現」,不碰「算錢/資料邏輯」。** 若專案在算真錢/處理重要資料——UI 優化只動樣式與呈現層,不改計算、資料流、schema。動到結構就先說明。

**要引入新的第三方套件先掃。** 動效/風格有時要裝庫(GSAP、lottie、icon set、UI kit…)——裝前先走 `[[scan-before-install]]` 掃過綠燈、或使用者明確確認,**絕不默默 `npm i` 外來套件**。能用既有依賴或純 CSS 解決就不新增。

**驗收迴圈(改完一定驗,別只靠肉眼想像;工具名依當前環境,原則不變):**
1. **起 dev server 開預覽**(Claude Code 用 preview/browser 工具;Vite 記得釘固定 port,若連不到留意 IPv6-only 綁定問題,設 `server.host: true`)。
2. **量 computed 值**——用瀏覽器 JS 執行工具(如 `javascript_tool` / console)讀 `getComputedStyle`:顏色(rgb)、間距、z-index、字級;responsive 用視窗 resize(mobile/desktop)後量 `scrollHeight`、flex-direction。**量測比肉眼準。**
3. **看版面**:能截圖就截圖比對;截圖工具失效時 fallback:Edge `--print-to-pdf`(PowerShell `Start-Process -Wait` + 全新 profile + 先砍殘留 msedge)→ `pymupdf` render 成 PNG 再讀。多頁用 Pillow 拼 montage。
4. 給使用者 **before/after 重點**,不誇大;測 mobile + desktop 兩個斷點。

**已知踩點(原機經驗,換環境先驗證再套):**
- Framer `AnimatePresence` 的 exit 在某些設定下**不會完成** → 改條件卸載 / enter-only 動畫。
- 主題 live 切 CSS 變數時 **body 底色可能不重繪、getComputedStyle 回過期值** → 底色用 inline 固定 `.app-bg` 層。

**收尾原則:** 改了什麼、為什麼、量到的關鍵值(對比/間距/fps),據實說。沒把握的標出來。
