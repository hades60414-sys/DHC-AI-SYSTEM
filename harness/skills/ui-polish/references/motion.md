# 武器 ② 動效(motion)

動效是為了**引導注意力與傳達質感**,不是炫技。鐵則:服務內容、克制、效能優先、永遠尊重 reduced-motion。

## 0. 先選對工具(別硬套 GSAP)

| 需求 | 用什麼 |
|---|---|
| hover、簡單過場、狀態變化 | **純 CSS** `transition` / `@keyframes`(最輕、最穩) |
| React 元件進出場、layout 動畫、手勢 | 專案若**已用 Framer Motion** 就用它(別再加第二套庫) |
| scroll 驅動、複雜時間軸編排、pin、視差、count-up | **GSAP**(timeline + ScrollTrigger 最強) |

> 一個專案**只用一套動畫庫**。同時 GSAP + Framer 容易打架。

## 1. GSAP 正確用法(萃取自官方 skills)

- **React**:用 `useGSAP()`(`@gsap/react`)包動畫,scope 傳 ref;它自動用 `gsap.context()` 在卸載時清乾淨。**不要**在 `useEffect` 裡手刻 cleanup。
- **plugin 註冊一次**:`gsap.registerPlugin(ScrollTrigger)` 放 app 入口或模組頂層,別重複註冊。
- **timeline 優於一堆 delay**:用 `tl.to(...).to(..., "<")` 與 label 編排,別用 `delay:` 串。
- **只動 transform 與 opacity**:用 `x / y / scale / rotation / autoAlpha`(`autoAlpha` = opacity + visibility),**不要**動 `width/height/top/left/margin`(會觸發 layout、掉 fps)。
- **ScrollTrigger**:把 `scrollTrigger:{trigger, start, end, scrub}` 掛在 tween/timeline 上;DOM 變動(換頁、圖載入、展開)後呼叫 `ScrollTrigger.refresh()`。
- **responsive + 無障礙用 `gsap.matchMedia()`**:
  ```js
  const mm = gsap.matchMedia();
  mm.add("(prefers-reduced-motion: no-preference)", () => { /* 動畫只在這裡 */ });
  mm.add("(max-width: 640px)", () => { /* 手機改較淺的 start/end/scrub */ });
  ```
  → 偏好減量動態的人**直接不跑**動畫,且 mm 卸載自動還原。
- **效能**:`will-change` 只加在頻繁動的元素、動完移除;多元素用 `stagger` 而非各自 tween;先批次讀 DOM 再進動畫迴圈。
- GSAP 現已**全免費**(含全部 plugin,標準授權):`npm i gsap @gsap/react`。**但本 skill 不自動裝**,由專案決定要不要引入。

## 2. 常用 pattern(挑一兩個就夠,別堆)

- **Entrance reveal**:`gsap.from(el, {autoAlpha:0, y:24, duration:.6, ease:"power2.out"})`;進 viewport 才觸發 → 配 ScrollTrigger `start:"top 85%"`。
- **Stagger 列表**:`gsap.from(".card", {y:20, autoAlpha:0, stagger:0.08})`。
- **Scroll-pinned hero / 視差**:`scrollTrigger:{pin:true, scrub:true}` 做釘住 + 隨捲動推進。
- **Magnetic / hover 微互動**:滑鼠靠近時 `x/y` 輕微跟隨(小幅、`power2`);離開歸位。
- **Count-up 數字**:儀表板數字用 `gsap.to(obj,{val:target, onUpdate})`(金融頁很吃這個質感)。
- ease 預設用 `power2.out`(自然);別用 linear 當入場。時長 0.3–0.8s,UI 微互動 ≤ 0.2s。

## 3. 常見環境踩點

- **Framer `AnimatePresence` 的 exit 動畫在某些設定下不會完成** → 別依賴 exit;改**條件卸載**或只做 **enter-only**。
- 改完動畫若 Vite 卡舊錯誤 → 重啟 dev server。
- **務必加** `@media (prefers-reduced-motion: reduce)` 的 CSS 後備(GSAP 走 matchMedia,純 CSS 動畫也要關)。

## 4. 驗收
量 fps 觀感(只動 transform/opacity 才穩 60fps)、確認 reduced-motion 開啟時動畫關閉、mobile 不卡。錄一句 before/after 描述即可(動效截圖意義不大)。
