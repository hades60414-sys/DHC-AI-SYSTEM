# 武器 ③ 風格指向(aesthetic direction / redesign)

當畫面需要一個**明確的設計語言**(不只是打磨,而是定調),或要**對標某個漂亮網站**、或從零建立 design system。產出一份**一致的 design tokens** 再套用,不要逐頁亂湊。

## 流程

1. **定方向**:從產品調性/brief 推一個風格(見下方選單),或由使用者指定一個參考站。
2. **抽 tokens**:色票、type scale、spacing、radius、shadow、motion 風格,寫成一份規範。
3. **落地**:Tailwind 專案寫進 `tailwind.config` 的 `theme.extend`;Streamlit 注入 `<style>`;靜態頁寫 CSS variables。
4. **一致套用**:所有元件只能用 tokens 裡的值,不開後門。

## 風格選單(各附:氣質 / 適合什麼產品 / token 取向)

| 風格 | 氣質 | 適合 | tokens 取向 |
|---|---|---|---|
| **Minimal / Editorial** | 克制、留白、文字優先,標題可用襯線 | 內容站、作品集、文件 | 近白底、黑灰字、少色、大行距、細邊 |
| **Soft / Premium** | 柔和、圓潤、spring 動效、親和 | 消費級 App、SaaS、訂閱 | 中性偏暖、柔陰影、radius 大、漸層克制 |
| **Brutalist / Industrial** | 硬邊、高對比、Swiss 字體、實驗排版、有個性 | 開發者工具、作品集、想被記住 | 純色塊、無圓角或極小、粗框、單色強調 |
| **High-end / Calm** | 昂貴感、低飽和、大留白、慢動效 | 金融、精品、B2B 高端 | 深中性 + 一個沉穩主色、細字重對比、寬鬆 |
| **Glass / Dark-tech** | 玻璃擬態、深色、霓虹點綴、資料感 | 科技產品、儀表板、交易工具 | 深底 `#0a0e1a`、半透明卡 `backdrop-blur`、青/藍點綴、發光邊 |

> 若是**金融/數據/工具**類專案 → **High-end/Calm** 與 **Glass/Dark-tech** 通常最對味;個人作品集可考慮 Brutalist。

## 逆向參考站(reverse-engineer)

使用者丟一個「我覺得這個漂亮」的網站時,**抽出它的 design tokens 並解釋 WHY,不只 WHAT**:
- 色:主色/中性階/語意色的 hex 與用法比例。
- 字:字體家族、type scale 的比例、字重對比、字距。
- 空間:spacing 單位、區塊節奏、容器寬。
- 形:radius、border、shadow 的強度。
- 動:過場時長/ease 的調性(快脆 vs 慢柔)。
- **trade-off 說明**:它為什麼這樣選(例:大留白換資訊密度、襯線換信任感)——讓使用者知道套過來會得到什麼、失去什麼。

然後產出對應 tokens 套到目標專案,而不是像素級照抄(避免侵權,也未必合身)。

## 落地範例(Tailwind)

```js
// tailwind.config.js — theme.extend
colors: { brand: '#2C5C88', ink: '#0a0e1a', /* 中性階 50–900 */ },
borderRadius: { card: '14px' },
boxShadow: { soft: '0 8px 30px rgba(0,0,0,.08)' },
fontSize: { /* 鎖死 type scale */ },
```
Streamlit:用 `st.markdown("<style>:root{--brand:#2C5C88;…}</style>", unsafe_allow_html=True)` 注入,元件 className 套用。

## 驗收
全頁是否只用 tokens 裡的值(grep 隨手色/隨手 px)、風格是否一致到每個元件、深淺色與斷點都成立。給一張 before/after 與 tokens 清單。
