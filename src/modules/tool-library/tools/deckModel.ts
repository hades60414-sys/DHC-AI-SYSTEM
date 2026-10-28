import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { AssistMessage } from '@/shared/customTools';

/** DHC CLI 10/14 簡報影片工作室: stored data, slide splitting, narration, the downloadable deck and the briefs. */

export type Deck = { id: string; name: string; markdown: string; chat: AssistMessage[] };
export type DeckData = { decks: Deck[]; activeId: string | null };
export type Slide = { body: string; narration: string[] };

export const STARTER_MARKDOWN = [
  '# 簡報標題',
  '',
  '副標題或講者',
  '',
  '> 旁白：大家好，今天要跟大家報告……',
  '',
  '---',
  '',
  '## 第一個重點',
  '',
  '- 要點一',
  '- 要點二',
  '- 要點三',
  '',
  '> 旁白：先看第一個重點。',
].join('\n');

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const newDeck = (name: string, markdown = STARTER_MARKDOWN): Deck => ({ id: newId(), name, markdown, chat: [] });

export function parseDeckData(value: unknown): DeckData {
  const raw = value && typeof value === 'object' ? (value as { decks?: unknown; activeId?: unknown }) : {};
  const decks = (Array.isArray(raw.decks) ? raw.decks : [])
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof (item as { id?: unknown }).id === 'string')
    .map((item) => ({
      id: item.id as string,
      name: typeof item.name === 'string' && item.name ? item.name : '未命名簡報',
      markdown: typeof item.markdown === 'string' ? item.markdown : '',
      chat: Array.isArray(item.chat)
        ? (item.chat as unknown[]).filter((m): m is AssistMessage => (
          Boolean(m) && ((m as AssistMessage).role === 'user' || (m as AssistMessage).role === 'assistant') && typeof (m as AssistMessage).text === 'string'
        ))
        : [],
    }));
  const activeId = typeof raw.activeId === 'string' && decks.some((deck) => deck.id === raw.activeId) ? raw.activeId : (decks[0]?.id ?? null);
  return { decks, activeId };
}

const NARRATION = /^>\s*旁白\s*[：:]\s?(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/** Slides are separated by a line of only `---` (not inside a code fence); `> 旁白：` lines are pulled out as narration. */
export function splitSlides(markdown: string): Slide[] {
  const chunks: string[][] = [[]];
  let fenced = false;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    if (!fenced && /^---\s*$/.test(line)) chunks.push([]);
    else chunks[chunks.length - 1].push(line);
  }
  const slides = chunks.map((lines) => {
    const narration: string[] = [];
    const body: string[] = [];
    for (const line of lines) {
      const match = NARRATION.exec(line);
      if (match) {
        if (match[1].trim()) narration.push(match[1].trim());
      } else {
        body.push(line);
      }
    }
    return { body: body.join('\n').trim(), narration };
  });
  const nonEmpty = slides.filter((slide) => slide.body || slide.narration.length > 0);
  return nonEmpty.length > 0 ? nonEmpty : [{ body: '', narration: [] }];
}

/** A slide's markdown as static HTML (raw HTML in the script is not rendered; unsafe link schemes are dropped). */
export function renderSlideHtml(body: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, body));
}

/** Auto-fit: the slide font scale is tried from the first step down until the content fits (minimum ~55%). */
export const FIT_STEPS = [1, 0.92, 0.85, 0.78, 0.72, 0.66, 0.6, 0.55];

/** Pure: the first scale in FIT_STEPS for which `overflows(scale)` is false, else the smallest. */
export function pickFitScale(overflows: (scale: number) => boolean): number {
  for (const scale of FIT_STEPS) if (!overflows(scale)) return scale;
  return FIT_STEPS[FIT_STEPS.length - 1];
}

/** A slide starting with a `# ` heading is a title slide (big, centred). */
export const isTitleSlide = (body: string) => /^#[ \t]+\S/.test(body.trimStart());

/** Shrinks one rendered slide (`.deck-slide` > `.deck-in`) until its content fits the box; no-op without layout (jsdom). */
export function fitSlideElement(slide: HTMLElement): void {
  const inner = slide.firstElementChild as HTMLElement | null;
  if (!inner || slide.clientHeight === 0) return;
  const scale = pickFitScale((value) => {
    slide.style.setProperty('--fit', String(value));
    return inner.offsetHeight > slide.clientHeight + 1;
  });
  slide.style.setProperty('--fit', String(scale));
}

const P = '.deck-box .deck-slide';
/** Shared by the preview and the downloaded deck; sizes follow the slide box width (cqw). Every rule is scoped and
 * explicit so the site theme (dark headings, preflight list reset) cannot leak into a slide. */
export const DECK_CSS = `
.deck-box{container-type:inline-size;aspect-ratio:16/9;width:100%;background:#fff;color:#1f2937;overflow:hidden;position:relative}
${P}{position:absolute;inset:0;font-size:calc(2.4cqw*var(--fit,1));line-height:1.5;display:flex;flex-direction:column;justify-content:center;overflow:hidden;background:#fff;font-family:system-ui,"Microsoft JhengHei","PingFang TC",sans-serif}
${P} .deck-in{box-sizing:border-box;width:100%;padding:6cqw 7cqw}
${P},${P} *{color:#1f2937}
${P} h1,${P} h2,${P} h3,${P} h4{font-weight:700;color:#0f3d6e}
${P} h1{font-size:2.17em;line-height:1.2;margin:0 0 .5em}
${P} h2{font-size:1.5em;line-height:1.25;margin:0 0 .6em;border-bottom:.25cqw solid #2f7fc1;padding-bottom:.3em}
${P} h3{font-size:1.17em;margin:.6em 0 .3em;color:#1f4f82}
${P} h4{font-size:1em;margin:.5em 0 .3em;color:#1f4f82}
${P} p{margin:.4em 0}
${P} strong,${P} b{font-weight:700;color:#1f2937}
${P} em,${P} i{font-style:italic;color:#1f2937}
${P} a{color:#1d4ed8;text-decoration:underline}
${P} ul,${P} ol{margin:.4em 0;padding-left:1.5em}
${P} ul{list-style:disc outside}
${P} ul ul{list-style-type:circle}
${P} ul ul ul{list-style-type:square}
${P} ol{list-style:decimal outside}
${P} ol ol{list-style-type:lower-alpha}
${P} ul ul,${P} ol ol,${P} ul ol,${P} ol ul{margin:.15em 0}
${P} li{display:list-item;margin:.25em 0}
${P} table{border-collapse:collapse;font-size:.9em;margin:.5em 0}
${P} th,${P} td{border:1px solid #cbd5e1;padding:.25em .7em;color:#1f2937}
${P} th{background:#e8f1fa;font-weight:700}
${P} code{background:#eef2f6;padding:.05em .3em;border-radius:.2em;font-size:.9em;color:#1f2937}
${P} pre{background:#eef2f6;padding:.6em .9em;border-radius:.4em;overflow:hidden;font-size:.85em}
${P} pre code{background:none;padding:0}
${P} blockquote{margin:.5em 0;padding:.1em .9em;border-left:.3cqw solid #2f7fc1;color:#475569}
${P} blockquote *{color:#475569}
${P} img{max-width:100%;max-height:60%}
${P}.deck-title{text-align:center}
${P}.deck-title h1{font-size:3.2em;margin:0 0 .35em}
${P}.deck-title p{font-size:.95em;margin:.25em 0;color:#475569}
${P}.deck-title ul,${P}.deck-title ol{display:inline-block;text-align:left}
`;

export const escapeHtml = (text: string) => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A self-contained .html presentation: slides pre-rendered, arrows / click / Space to move, F for full screen. */
export function buildDeckHtml(title: string, markdown: string): string {
  const slides = splitSlides(markdown);
  const sections = slides.map((slide, index) => (
    `<section class="deck-slide${isTitleSlide(slide.body) ? ' deck-title' : ''}" data-i="${index}"${index === 0 ? '' : ' hidden'}><div class="deck-in">${renderSlideHtml(slide.body)}</div></section>`
  )).join('\n');
  const script = `(function(){var s=[].slice.call(document.querySelectorAll('.deck-slide')),n=s.length,i=0,c=document.getElementById('c');
var F=${JSON.stringify(FIT_STEPS)};
function fit(){var e=s[i],m=e.firstElementChild;for(var k=0;k<F.length;k++){e.style.setProperty('--fit',F[k]);if(m.offsetHeight<=e.clientHeight+1)break}}
window.addEventListener('resize',function(){fit()});
function go(k){i=Math.max(0,Math.min(n-1,k));s.forEach(function(e,j){e.hidden=j!==i});fit();c.textContent=(i+1)+' / '+n;location.hash='#'+(i+1)}
var h=parseInt(location.hash.slice(1),10);if(h)go(h-1);else go(0);
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key==='PageDown'||e.key===' ')go(i+1);else if(e.key==='ArrowLeft'||e.key==='PageUp')go(i-1);else if(e.key==='Home')go(0);else if(e.key==='End')go(n-1);else if(e.key==='f'||e.key==='F'){if(document.fullscreenElement)document.exitFullscreen();else document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen()}});
document.getElementById('b').addEventListener('click',function(e){go(e.clientX<window.innerWidth/3?i-1:i+1)});})();`;
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>html,body{margin:0;height:100%;background:#111}body{display:flex;align-items:center;justify-content:center}
#b{position:relative;width:min(100vw,calc(100vh*16/9));cursor:pointer}
#c{position:fixed;right:12px;bottom:8px;color:#9ca3af;font:12px system-ui}
${DECK_CSS}</style></head>
<body><div id="b" class="deck-box">
${sections}
</div><div id="c"></div>
<script>${script}</script></body></html>
`;
}

export type DeckTarget = 'pptx' | 'mp4';

/** The 開工 message for 做成 PPTX／影片: the script plus which skill to use. */
export function deckBrief(name: string, markdown: string, target: DeckTarget): string {
  const slides = splitSlides(markdown);
  const withNarration = slides.filter((slide) => slide.narration.length > 0).length;
  const how = target === 'pptx'
    ? '請用 pptx skill 做成 PowerPoint（.pptx）：每個 `---` 一頁，`> 旁白：` 的內容放進該頁的講者備忘稿，不要顯示在投影片上；版面乾淨一致。'
    : `請用 video-studio skill 做成有配音的 MP4：每個 \`---\` 一頁，畫面是該頁的內容，唸出該頁 \`> 旁白：\` 的文字（共 ${withNarration} / ${slides.length} 頁有旁白；沒有旁白的頁面請問我要不要補，或停留數秒）。`;
  return [
    `我在「簡報影片工作室」寫好了簡報「${name}」（共 ${slides.length} 頁），想${target === 'pptx' ? '做成 PPTX' : '做成配音 MP4'}。`,
    '',
    how,
    '完成後告訴我檔案位置；內容有缺漏或不通順的地方先問我，不要自己編造數字。',
    '',
    '稿子（Markdown，投影片以單獨一行 `---` 分隔）：',
    '',
    '~~~markdown',
    markdown,
    '~~~',
  ].join('\n');
}
