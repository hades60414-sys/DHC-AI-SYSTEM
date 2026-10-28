import type { DeckData } from '@/modules/tool-library/tools/deckModel';
import { newDeck, splitSlides } from '@/modules/tool-library/tools/deckModel';
import type { DocsData } from '@/modules/tool-library/tools/docModel';
import { MAX_DOCS, MAX_DOC_CHARS, emptyDoc } from '@/modules/tool-library/tools/docModel';
import type { Table } from '@/modules/tool-library/tools/sheetModel';
import type { ToolHandoff } from '@/shared/toolHandoff';

/**
 * DHC CLI 10/14 工具庫串接: the conversions between 試算工作台 tables, 文件共編 documents and 簡報影片工作室 slides,
 * and how the two receivers fold a handoff into their stored data. Pure, so the tests need no windows.
 */

export const DOC_TABLE_ROWS = 200;
export const SLIDE_TABLE_ROWS = 15;
const SLIDE_MAX_BULLETS = 6;
const SLIDE_MAX_TABLE_ROWS = 8;
const SLIDE_SEPARATOR = '\n\n---\n\n';

const cell = (text: string) => (text.replace(/\r?\n|\r/g, ' ').replace(/\|/g, '\\|').trim() || ' ');

/** A GFM Markdown table of the first `cap` rows; when rows are left out, a line below says how many there are. */
export function tableToMarkdown(table: Table, cap: number, withCapLine = true): { markdown: string; shown: number } {
  const columns = table.columns.length > 0 ? table.columns : [''];
  const shown = Math.min(table.rows.length, cap);
  const line = (cells: string[]) => `| ${columns.map((_, i) => cell(cells[i] ?? '')).join(' | ')} |`;
  const lines = [line(columns), `| ${columns.map(() => '---').join(' | ')} |`, ...table.rows.slice(0, shown).map(line)];
  if (withCapLine && table.rows.length > cap) lines.push('', `（共 ${table.rows.length} 列，只放前 ${cap} 列）`);
  return { markdown: lines.join('\n'), shown };
}

const rowsSummary = (total: number, shown: number) => (total > shown ? `前 ${shown} 列，共 ${total} 列` : `${total} 列`);

/** 試算工作台 → 文件共編. */
export function sheetToDocHandoff(sheetName: string, table: Table): ToolHandoff {
  const { markdown, shown } = tableToMarkdown(table, DOC_TABLE_ROWS);
  return {
    tool: 'doc-editor',
    kind: 'markdown-insert',
    from: `試算工作台『${sheetName}』`,
    payload: { markdown, title: sheetName, summary: `放進表格（${rowsSummary(table.rows.length, shown)}）` },
  };
}

/** 試算工作台 → 簡報影片工作室: one slide, `## name` and the table. */
export function sheetToSlideHandoff(sheetName: string, table: Table): ToolHandoff {
  const { markdown, shown } = tableToMarkdown(table, SLIDE_TABLE_ROWS, false);
  const more = table.rows.length > shown ? `\n\n（共 ${table.rows.length} 列，只放前 ${shown} 列）` : '';
  return {
    tool: 'deck-studio',
    kind: 'markdown-slides',
    from: `試算工作台『${sheetName}』`,
    payload: { markdown: `## ${sheetName}\n\n${markdown}${more}`, title: sheetName, summary: `放進一頁簡報（${rowsSummary(table.rows.length, shown)}）` },
  };
}

const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const match = /^(.+?[。！？!?]|.+?\.(?=\s|$))/.exec(flat);
  const sentence = match ? match[1] : flat;
  return sentence.length > 120 ? `${sentence.slice(0, 118)}…` : sentence;
}

/** One `##` section's lines → slide body: paragraphs shortened to a first sentence, list items kept, small tables kept. */
function sectionToSlide(heading: string, lines: string[]): string {
  const bullets: string[] = [];
  const tables: string[] = [];
  let paragraph: string[] = [];
  let fenced = false;
  const flush = () => {
    if (paragraph.length > 0) bullets.push(`- ${firstSentence(paragraph.join(' '))}`);
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE.test(line)) { flush(); fenced = !fenced; continue; }
    if (fenced) continue;
    if (/^\s*\|/.test(line)) {
      flush();
      const block: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { block.push(lines[i].trim()); i += 1; }
      i -= 1;
      if (block.length - 2 <= SLIDE_MAX_TABLE_ROWS) tables.push(block.join('\n'));
      continue;
    }
    if (!line.trim() || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); continue; }
    if (LIST_ITEM.test(line)) {
      flush();
      bullets.push(`${/^\s{2,}/.test(line) ? '  ' : ''}- ${line.replace(LIST_ITEM, '').trim()}`);
      continue;
    }
    const sub = /^#{3,6}\s+(.*)$/.exec(line);
    if (sub) { flush(); bullets.push(`- **${sub[1].trim()}**`); continue; }
    paragraph.push(line.trim());
  }
  flush();
  return [`## ${heading}`, ...(bullets.length > 0 ? ['', bullets.slice(0, SLIDE_MAX_BULLETS).join('\n')] : []), ...tables.flatMap((t) => ['', t])].join('\n');
}

/** A document as slides: `#` title slide, each `##` section one slide. Returns the deck script and the page count. */
export function docToSlides(markdown: string, fallbackTitle: string): { title: string; markdown: string; pages: number } {
  const slides: string[] = [];
  let title = '';
  let intro: string[] = [];
  let section: { heading: string; lines: string[] } | null = null;
  let fenced = false;
  const closeSection = () => { if (section) slides.push(sectionToSlide(section.heading, section.lines)); section = null; };
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    const h1 = fenced ? null : /^#\s+(.*)$/.exec(line);
    const h2 = fenced ? null : /^##\s+(.*)$/.exec(line);
    if (h1 && !title && !section) { title = h1[1].trim(); continue; }
    if (h2 || h1) {
      closeSection();
      section = { heading: (h2 || h1)?.[1].trim() ?? '', lines: [] };
      continue;
    }
    if (section) section.lines.push(line);
    else intro.push(line);
  }
  closeSection();
  const heading = title || fallbackTitle;
  const subtitle = firstSentence(intro.filter((l) => l.trim() && !/^#|^\s*\|/.test(l)).join(' '));
  const head = `# ${heading}${subtitle ? `\n\n${subtitle}` : ''}`;
  // A table or list before the first ## (a doc with only a title, e.g. a table sent from 試算工作台) gets its own slide.
  if (intro.some((line) => /^\s*\|/.test(line) || LIST_ITEM.test(line))) slides.unshift(sectionToSlide(heading, intro));
  return { title: heading, markdown: [head, ...slides].join(SLIDE_SEPARATOR), pages: slides.length + 1 };
}

/** 文件共編 → 簡報影片工作室. */
export function docToDeckHandoff(docTitle: string, markdown: string): ToolHandoff {
  const deck = docToSlides(markdown, docTitle);
  return {
    tool: 'deck-studio',
    kind: 'markdown-slides',
    from: `文件共編『${docTitle}』`,
    payload: { title: deck.title.slice(0, 60), markdown: deck.markdown, newDeck: true, summary: `做成簡報（${deck.pages} 頁）` },
  };
}

/** Slides as a document: the title slide's `#` becomes the document title, other slide titles `##`, narration a paragraph. */
export function slidesToDoc(deckName: string, markdown: string): { title: string; markdown: string; pages: number } {
  const slides = splitSlides(markdown);
  let title = deckName;
  const parts: string[] = [];
  slides.forEach((slide, index) => {
    const lines = slide.body.split('\n');
    const first = lines.findIndex((l) => l.trim());
    const match = first >= 0 ? /^(#{1,6})\s+(.*)$/.exec(lines[first]) : null;
    let rest = lines;
    let head = '';
    if (match) {
      rest = [...lines.slice(0, first), ...lines.slice(first + 1)];
      if (index === 0 && match[1] === '#') { title = match[2].trim() || deckName; head = `# ${title}`; } else head = `## ${match[2].trim()}`;
    }
    const body = rest.join('\n').trim();
    const narration = slide.narration.join(' ');
    parts.push([head, body, narration].filter(Boolean).join('\n\n'));
  });
  const text = parts.filter(Boolean).join('\n\n');
  return { title, markdown: /^# /.test(text) ? text : `# ${title}\n\n${text}`, pages: slides.length };
}

/** 簡報影片工作室 → 文件共編. */
export function deckToDocHandoff(deckName: string, markdown: string): ToolHandoff {
  const doc = slidesToDoc(deckName, markdown);
  return {
    tool: 'doc-editor',
    kind: 'markdown-doc',
    from: `簡報影片工作室『${deckName}』`,
    payload: { title: doc.title.slice(0, 80), markdown: doc.markdown, summary: `轉成文件（${doc.pages} 頁）` },
  };
}

type Payload = { markdown: string; title: string; newDeck: boolean; summary: string };
function readPayload(handoff: ToolHandoff): Payload | null {
  const p = handoff.payload as Partial<Payload> | null;
  if (!p || typeof p.markdown !== 'string' || !p.markdown.trim()) return null;
  return { markdown: p.markdown, title: typeof p.title === 'string' && p.title ? p.title : '來自其他工具', newDeck: p.newDeck === true, summary: typeof p.summary === 'string' ? p.summary : '放進內容' };
}
const noteOf = (handoff: ToolHandoff, payload: Payload) => `已從 ${handoff.from}${payload.summary}`;

export type Applied<T> = { data: T; note: string; /** What 復原 should put back. */ undo?: { id: string; markdown: string } };

/** 文件共編 takes 'markdown-insert' (append to the open doc, or a new doc when none has text) and 'markdown-doc' (a new doc). */
export function applyDocHandoff(data: DocsData, handoff: ToolHandoff): Applied<DocsData> | null {
  if (handoff.kind !== 'markdown-insert' && handoff.kind !== 'markdown-doc') return null;
  const payload = readPayload(handoff);
  if (!payload) return null;
  const now = new Date().toISOString();
  const active = data.docs.find((doc) => doc.id === data.activeId);
  if (handoff.kind === 'markdown-insert' && active && active.markdown.trim()) {
    const joined = `${active.markdown.replace(/\s+$/, '')}\n\n${payload.markdown}\n`;
    if (joined.length > MAX_DOC_CHARS) return { data, note: `${handoff.from}的內容放不進來：文件會超過 ${MAX_DOC_CHARS} 字。` };
    return {
      data: { ...data, docs: data.docs.map((doc) => (doc.id === active.id ? { ...doc, markdown: joined, updatedAt: now } : doc)) },
      note: `${noteOf(handoff, payload)}，接在「${active.title}」最後（可按「復原 AI 修改」）`,
      undo: { id: active.id, markdown: active.markdown },
    };
  }
  const markdown = handoff.kind === 'markdown-insert' ? `# ${payload.title}\n\n${payload.markdown}\n` : payload.markdown;
  if (active && !active.markdown.trim()) {
    return { data: { ...data, docs: data.docs.map((doc) => (doc.id === active.id ? { ...doc, title: payload.title, markdown, updatedAt: now } : doc)) }, note: noteOf(handoff, payload) };
  }
  if (data.docs.length >= MAX_DOCS) return { data, note: `文件已達 ${MAX_DOCS} 份上限，先刪掉不要的再送一次。` };
  const doc = { ...emptyDoc(payload.title), markdown: markdown.slice(0, MAX_DOC_CHARS) };
  return { data: { ...data, docs: [doc, ...data.docs], activeId: doc.id }, note: `${noteOf(handoff, payload)}，放在新文件「${payload.title}」` };
}

/** 簡報影片工作室 takes 'markdown-slides': new slides after the open deck's last one, or a new deck when asked to. */
export function applyDeckHandoff(data: DeckData, handoff: ToolHandoff): Applied<DeckData> | null {
  if (handoff.kind !== 'markdown-slides') return null;
  const payload = readPayload(handoff);
  if (!payload) return null;
  const active = data.decks.find((deck) => deck.id === data.activeId);
  if (!payload.newDeck && active) {
    const markdown = active.markdown.trim() ? `${active.markdown.replace(/\s+$/, '')}${SLIDE_SEPARATOR}${payload.markdown}` : payload.markdown;
    return {
      data: { ...data, decks: data.decks.map((deck) => (deck.id === active.id ? { ...deck, markdown } : deck)) },
      note: `${noteOf(handoff, payload)}，接在「${active.name}」最後（可按「復原」）`,
      undo: { id: active.id, markdown: active.markdown },
    };
  }
  const deck = newDeck(payload.title.slice(0, 60), payload.markdown);
  return { data: { decks: [...data.decks, deck], activeId: deck.id }, note: `${noteOf(handoff, payload)}，放在新簡報「${deck.name}」` };
}
