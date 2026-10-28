import JSZip from 'jszip';

import { parseDelimited } from '@/modules/tool-library/tools/sheetModel';

/**
 * DHC CLI 10/14 工具庫匯入: reads what people already have (CSV from Taiwan Excel, .xlsx, .docx, .pptx) and turns it
 * into plain rows or Markdown for the tools. Everything runs in the browser; Office files are zips of XML (jszip).
 */

const MAX_BYTES = 20 * 1024 * 1024;
const TOO_BIG = '檔案超過 20 MB，請先縮小或拆開再匯入。';

async function readBytes(file: File): Promise<Uint8Array> {
  if (file.size > MAX_BYTES) throw new Error(TOO_BIG);
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error('讀不到這個檔案'));
    reader.readAsArrayBuffer(file);
  });
}

/** BOM-aware UTF-8 / UTF-16, else strict UTF-8, else Big5 (Taiwan Excel's CSV). */
export async function readTextFile(file: File): Promise<string> {
  const bytes = await readBytes(file);
  let text: string;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) text = new TextDecoder('utf-8').decode(bytes.subarray(3));
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('big5').decode(bytes);
    }
  }
  return text.replace(/^﻿/, '');
}

// ---------------------------------------------------------------------------------------------------------------
// XML helpers (namespace prefixes differ between producers, so everything is matched by local name)

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('檔案內容損毀，讀不了。');
  return doc;
}
const kids = (el: Element | null | undefined, local: string): Element[] => (el ? Array.from(el.children).filter((c) => c.localName === local) : []);
const desc = (el: Element | Document, local: string): Element[] => Array.from(el.getElementsByTagNameNS('*', local));
const attr = (el: Element | null | undefined, local: string): string | null => {
  if (!el) return null;
  for (const a of Array.from(el.attributes)) if (a.localName === local) return a.value;
  return null;
};

async function openZip(file: File): Promise<JSZip> {
  const bytes = await readBytes(file);
  try {
    return await JSZip.loadAsync(bytes);
  } catch {
    throw new Error('這不是有效的 Office 檔案（可能是舊版格式或已損毀）。');
  }
}
async function zipXml(zip: JSZip, path: string): Promise<Document | null> {
  const entry = zip.file(path);
  return entry ? parseXml(await entry.async('string')) : null;
}

/** Resolves a relationship target against the folder of the part that owns the rels. */
function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = baseDir ? baseDir.split('/') : [];
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
type Rel = { target: string; type: string };
async function readRels(zip: JSZip, partPath: string): Promise<Map<string, Rel>> {
  const slash = partPath.lastIndexOf('/');
  const dir = partPath.slice(0, slash + 1);
  const doc = await zipXml(zip, `${dir}_rels/${partPath.slice(slash + 1)}.rels`);
  const map = new Map<string, Rel>();
  if (!doc) return map;
  for (const rel of desc(doc, 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id && target) map.set(id, { target: resolvePath(dir.replace(/\/$/, ''), target), type: attr(rel, 'Type') ?? '' });
  }
  return map;
}

// ---------------------------------------------------------------------------------------------------------------
// Spreadsheets

export type SheetData = { name: string; rows: string[][] };

const baseName = (name: string) => name.replace(/\.[^.\\/]+$/, '');

function squareUp(grid: string[][]): string[][] {
  const rows = grid.map((row) => [...row]);
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === '')) rows.pop();
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
}

const colIndex = (letters: string) => letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(code: string): boolean {
  const plain = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/_./g, '');
  if (/[yd]/i.test(plain)) return true;
  return /m/i.test(plain) && !/[hs]/i.test(plain);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Excel serial (1900 system, with its fake 1900-02-29) → yyyy-MM-dd, plus HH:mm:ss when there is a time part. */
function serialToDate(serial: number): string {
  const whole = Math.floor(serial);
  const seconds = Math.round((serial - whole) * 86400);
  const days = whole > 59 ? whole - 1 : whole;
  const date = new Date(Date.UTC(1899, 11, 31) + days * 86400 * 1000);
  const day = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  if (seconds <= 0 || seconds >= 86400) return day;
  return `${day} ${pad2(Math.floor(seconds / 3600))}:${pad2(Math.floor((seconds % 3600) / 60))}:${pad2(seconds % 60)}`;
}

const stringItemText = (si: Element) => desc(si, 't').filter((t) => t.parentElement?.localName !== 'rPh').map((t) => t.textContent ?? '').join('');

async function readXlsx(file: File): Promise<SheetData[]> {
  const zip = await openZip(file);
  const workbook = await zipXml(zip, 'xl/workbook.xml');
  if (!workbook) throw new Error('這不是有效的 Excel 檔案。');
  const rels = await readRels(zip, 'xl/workbook.xml');

  const shared = (await zipXml(zip, 'xl/sharedStrings.xml'));
  const strings = shared ? kids(desc(shared, 'sst')[0], 'si').map(stringItemText) : [];

  // Which cell styles are dates.
  const styles = await zipXml(zip, 'xl/styles.xml');
  const customFormats = new Map<number, string>();
  const dateStyle: boolean[] = [];
  if (styles) {
    for (const fmt of desc(styles, 'numFmt')) customFormats.set(Number(attr(fmt, 'numFmtId')), attr(fmt, 'formatCode') ?? '');
    const xfs = kids(desc(styles, 'cellXfs')[0], 'xf');
    for (const xf of xfs) {
      const id = Number(attr(xf, 'numFmtId') ?? 0);
      dateStyle.push(BUILTIN_DATE_IDS.has(id) || (customFormats.has(id) && isDateFormat(customFormats.get(id) ?? '')));
    }
  }

  const sheets: SheetData[] = [];
  for (const sheet of desc(workbook, 'sheet')) {
    const name = attr(sheet, 'name') ?? `工作表${sheets.length + 1}`;
    const rel = rels.get(attr(sheet, 'id') ?? '');
    const doc = rel ? await zipXml(zip, rel.target) : null;
    if (!doc) continue;
    const grid: string[][] = [];
    let rowNo = 0;
    for (const row of desc(doc, 'row')) {
      const declared = Number(attr(row, 'r'));
      rowNo = declared > 0 ? declared : rowNo + 1;
      let colNo = -1;
      for (const cell of kids(row, 'c')) {
        const ref = /^([A-Z]+)(\d+)$/.exec(attr(cell, 'r') ?? '');
        colNo = ref ? colIndex(ref[1]) : colNo + 1;
        const r = ref ? Number(ref[2]) : rowNo;
        if (r > 200_000 || colNo > 16_383) continue;
        const type = attr(cell, 't');
        const v = kids(cell, 'v')[0]?.textContent ?? '';
        let text: string;
        if (type === 's') text = strings[Number(v)] ?? '';
        else if (type === 'inlineStr') text = desc(cell, 't').map((t) => t.textContent ?? '').join('');
        else if (type === 'b') text = v.trim() === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'd') text = v.trim().slice(0, 10);
        else if (type === 'str' || type === 'e') text = v;
        else {
          text = v.trim();
          const style = Number(attr(cell, 's') ?? 0);
          const n = Number(text);
          if (text !== '' && dateStyle[style] && Number.isFinite(n) && n >= 0) text = serialToDate(n);
        }
        while (grid.length < r) grid.push([]);
        const target = grid[r - 1];
        while (target.length < colNo) target.push('');
        target[colNo] = text;
      }
    }
    sheets.push({ name, rows: squareUp(grid.map((row) => row.map((cell) => cell ?? ''))) });
  }
  if (sheets.length === 0) throw new Error('這個 Excel 檔裡沒有工作表。');
  return sheets;
}

export async function readSpreadsheetFile(file: File): Promise<SheetData[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.xls')) throw new Error('舊版 .xls 讀不了，請在 Excel 另存成 .xlsx 或 CSV');
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return readXlsx(file);
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
    const text = await readTextFile(file);
    const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
    const bare = firstLine.replace(/"[^"]*"/g, '');
    const tabs = (bare.match(/\t/g) ?? []).length;
    const commas = (bare.match(/,/g) ?? []).length;
    const delimiter = tabs > 0 && tabs >= commas ? '\t' : ',';
    return [{ name: baseName(file.name), rows: squareUp(parseDelimited(text, delimiter)) }];
  }
  throw new Error('不支援這種檔案，請用 .xlsx、.csv、.tsv 或 .txt');
}

// ---------------------------------------------------------------------------------------------------------------
// Word → Markdown

type Seg = { t: string; b: boolean; i: boolean };
const IMAGE_NOTE = '（圖片未匯入）';

const flagOn = (rPr: Element | undefined, local: string) => {
  const el = kids(rPr, local)[0];
  if (!el) return false;
  const v = attr(el, 'val');
  return !(v === '0' || v === 'false' || v === 'off');
};

function runSegs(run: Element): Seg[] {
  const rPr = kids(run, 'rPr')[0];
  const b = flagOn(rPr, 'b');
  const i = flagOn(rPr, 'i');
  let text = '';
  for (const c of Array.from(run.children)) {
    if (c.localName === 't') text += c.textContent ?? '';
    else if (c.localName === 'tab') text += '\t';
    else if (c.localName === 'br' || c.localName === 'cr') text += '\n';
    else if (c.localName === 'noBreakHyphen') text += '-';
  }
  if (desc(run, 'drawing').length > 0 || desc(run, 'pict').length > 0) text += IMAGE_NOTE;
  return text ? [{ t: text, b, i }] : [];
}

const WRAPPERS = new Set(['hyperlink', 'ins', 'smartTag', 'sdt', 'sdtContent', 'fldSimple']);
function collectRuns(node: Element, out: Seg[]) {
  for (const c of Array.from(node.children)) {
    if (c.localName === 'r') out.push(...runSegs(c));
    else if (WRAPPERS.has(c.localName)) collectRuns(c, out);
  }
}

function mergeSegs(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.b === s.b && last.i === s.i) last.t += s.t;
    else out.push({ ...s });
  }
  return out;
}

function renderSegs(segs: Seg[], lineBreak: string): string {
  return mergeSegs(segs).map((s) => {
    const body = s.t.replace(/\n/g, lineBreak);
    const core = body.trim();
    if (!core || (!s.b && !s.i)) return body;
    const mark = s.b && s.i ? '***' : s.b ? '**' : '*';
    const lead = body.slice(0, body.indexOf(core));
    const tail = body.slice(lead.length + core.length);
    return `${lead}${mark}${core}${mark}${tail}`;
  }).join('');
}

type DocBlock = { text: string; list: boolean };

export async function readDocxAsMarkdown(file: File): Promise<string> {
  const zip = await openZip(file);
  const main = await zipXml(zip, 'word/document.xml');
  if (!main) throw new Error('這不是有效的 Word 檔案（.docx）。');

  const styleNames = new Map<string, string>();
  const styles = await zipXml(zip, 'word/styles.xml');
  if (styles) for (const s of desc(styles, 'style')) styleNames.set(attr(s, 'styleId') ?? '', attr(kids(s, 'name')[0], 'val') ?? '');

  const levelFormat = new Map<string, string>(); // `${numId}:${ilvl}` → numFmt
  const numbering = await zipXml(zip, 'word/numbering.xml');
  if (numbering) {
    const abstract = new Map<string, Map<string, string>>();
    for (const a of desc(numbering, 'abstractNum')) {
      const levels = new Map<string, string>();
      for (const lvl of kids(a, 'lvl')) levels.set(attr(lvl, 'ilvl') ?? '0', attr(kids(lvl, 'numFmt')[0], 'val') ?? '');
      abstract.set(attr(a, 'abstractNumId') ?? '', levels);
    }
    for (const n of desc(numbering, 'num')) {
      const levels = abstract.get(attr(kids(n, 'abstractNumId')[0], 'val') ?? '');
      levels?.forEach((fmt, ilvl) => levelFormat.set(`${attr(n, 'numId')}:${ilvl}`, fmt));
    }
  }

  const headingLevel = (p: Element): number => {
    const id = attr(kids(kids(p, 'pPr')[0], 'pStyle')[0], 'val');
    if (!id) return 0;
    for (const candidate of [id, styleNames.get(id) ?? '']) {
      const m = /^(?:heading|標題)\s*([1-6])$/i.exec(candidate.trim());
      if (m) return Number(m[1]);
      if (/^(?:title|標題)$/i.test(candidate.trim())) return 1; // Word's Title style; Subtitle/副標題 stays a normal paragraph
    }
    return 0;
  };

  const paragraphText = (p: Element, lineBreak: string): string => {
    const segs: Seg[] = [];
    collectRuns(p, segs);
    return renderSegs(segs, lineBreak);
  };

  const blocks: DocBlock[] = [];
  const walk = (container: Element | undefined) => {
    for (const c of Array.from(container?.children ?? [])) {
      if (c.localName === 'sdt') walk(kids(c, 'sdtContent')[0]);
      else if (c.localName === 'p') {
        const level = headingLevel(c);
        if (level > 0) {
          const segs: Seg[] = [];
          collectRuns(c, segs);
          const title = segs.map((s) => s.t).join('').replace(/\s+/g, ' ').trim();
          if (title) blocks.push({ text: `${'#'.repeat(level)} ${title}`, list: false });
          continue;
        }
        const text = paragraphText(c, '  \n').replace(/^\n+|\n+$/g, '').trim();
        if (!text) continue;
        const numPr = kids(kids(c, 'pPr')[0], 'numPr')[0];
        if (numPr) {
          const numId = attr(kids(numPr, 'numId')[0], 'val') ?? '';
          const ilvl = attr(kids(numPr, 'ilvl')[0], 'val') ?? '0';
          if (numId !== '0') {
            const bullet = (levelFormat.get(`${numId}:${ilvl}`) ?? 'bullet') === 'bullet';
            blocks.push({ text: `${'  '.repeat(Number(ilvl) || 0)}${bullet ? '- ' : '1. '}${text}`, list: true });
            continue;
          }
        }
        blocks.push({ text, list: false });
      } else if (c.localName === 'tbl') {
        const rows = kids(c, 'tr').map((tr) => kids(tr, 'tc').map((tc) => kids(tc, 'p')
          .map((p) => paragraphText(p, '<br>').trim())
          .filter(Boolean)
          .join('<br>')
          .replace(/\|/g, '\\|')));
        const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
        if (rows.length === 0 || width === 0) continue;
        const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
        blocks.push({
          text: [line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n'),
          list: false,
        });
      }
    }
  };
  walk(desc(main, 'body')[0]);

  let out = '';
  blocks.forEach((block, index) => {
    if (index > 0) out += block.list && blocks[index - 1].list ? '\n' : '\n\n';
    out += block.text;
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// PowerPoint → Markdown (the deck format: slides split by `---`, `> 旁白：` lines)

const SKIP_PLACEHOLDERS = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);

function drawingParagraphs(shape: Element): Array<{ text: string; level: number }> {
  const body = kids(shape, 'txBody')[0];
  return kids(body, 'p').map((p) => {
    let text = '';
    for (const c of Array.from(p.children)) {
      if (c.localName === 'r' || c.localName === 'fld') text += kids(c, 't').map((t) => t.textContent ?? '').join('');
      else if (c.localName === 'br') text += ' ';
    }
    return { text: text.trim(), level: Number(attr(kids(p, 'pPr')[0], 'lvl')) || 0 };
  }).filter((p) => p.text);
}

const placeholderType = (shape: Element) => attr(desc(shape, 'ph')[0], 'type') ?? (desc(shape, 'ph').length > 0 ? 'body' : '');

export async function readPptxAsMarkdown(file: File): Promise<string> {
  const zip = await openZip(file);
  const presentation = await zipXml(zip, 'ppt/presentation.xml');
  if (!presentation) throw new Error('這不是有效的簡報檔案（.pptx）。');
  const rels = await readRels(zip, 'ppt/presentation.xml');

  const slides: string[] = [];
  for (const sldId of desc(presentation, 'sldId')) {
    const rel = rels.get(sldId.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? '');
    const slide = rel ? await zipXml(zip, rel.target) : null;
    if (!slide) continue;
    const first = slides.length === 0;

    let title = '';
    const bullets: string[] = [];
    const walk = (node: Element) => {
      for (const c of Array.from(node.children)) {
        if (c.localName === 'grpSp') walk(c);
        else if (c.localName === 'sp') {
          const type = placeholderType(c);
          if (SKIP_PLACEHOLDERS.has(type)) continue;
          const paragraphs = drawingParagraphs(c);
          if (type === 'title' || type === 'ctrTitle') title = [title, ...paragraphs.map((p) => p.text)].filter(Boolean).join(' ');
          else for (const p of paragraphs) bullets.push(`${'  '.repeat(p.level)}- ${p.text}`);
        } else if (c.localName === 'graphicFrame') {
          const rows = desc(c, 'tr').map((tr) => kids(tr, 'tc').map((tc) => kids(kids(tc, 'txBody')[0], 'p')
            .map((p) => kids(p, 'r').map((r) => kids(r, 't')[0]?.textContent ?? '').join('').trim()).filter(Boolean).join('<br>').replace(/\|/g, '\\|')));
          const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
          if (rows.length === 0 || width === 0) continue;
          const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
          bullets.push('', line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line), '');
        }
      }
    };
    walk(desc(slide, 'spTree')[0]);

    const notes: string[] = [];
    const slideRels = await readRels(zip, rel!.target);
    const notesRel = Array.from(slideRels.values()).find((r) => r.type.endsWith('/notesSlide'));
    const notesDoc = notesRel ? await zipXml(zip, notesRel.target) : null;
    if (notesDoc) {
      for (const sp of desc(notesDoc, 'sp')) {
        if (placeholderType(sp) !== 'body') continue;
        for (const p of drawingParagraphs(sp)) notes.push(`> 旁白：${p.text}`);
      }
    }

    const parts: string[] = [];
    if (title) parts.push(`${first ? '#' : '##'} ${title}`);
    const body = bullets.join('\n').replace(/^\n+|\n+$/g, '');
    if (body) parts.push(body);
    if (notes.length > 0) parts.push(notes.join('\n'));
    if (parts.length > 0) slides.push(parts.join('\n\n'));
  }
  if (slides.length === 0) throw new Error('這份簡報裡沒有讀到文字。');
  return slides.join('\n\n---\n\n');
}
