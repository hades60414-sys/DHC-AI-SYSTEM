import { runIsolatedExtraction } from './extraction-sandbox.js';
import { createZipReader } from './zip-reader.js';

import type { EnterpriseTextUnit } from '@/shared/index.js';

type TextUnit = EnterpriseTextUnit;
type Location = EnterpriseTextUnit['location'];

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF = 'application/pdf';
/** PDF 頁數上限（超過即 TOO_LARGE，避免大量頁面耗盡子行程時間）。 */
const MAX_PDF_PAGES = 500;
export const PDF_EXTRACTOR = 'pdf-pdfjs-6-4-299@1';
const MAX_TOTAL_TEXT = 5 * 1024 * 1024;
const MAX_CHUNKS = 5000;

function failed(): never {
  throw new Error('ENTERPRISE_EXTRACTION_FAILED');
}

function decodeXml(value: string) {
  return value.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function readPart(zip: ReturnType<typeof createZipReader>, name: string, required: boolean) {
  const text = zip.text(name);
  if (text === undefined) return required ? failed() : undefined;
  return text;
}

function loadZip(content: Buffer) {
  // ASTRA-003：先驗整個 central directory（entry 數、宣告大小、總量、比例、加密、路徑），只解壓需要的 entry。
  return createZipReader(content);
}

function linesOf(content: Buffer, kind: 'line' | 'row'): TextUnit[] {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return failed();
  }
  return text.split(/\r?\n/).flatMap((line, index) => line.trim()
    ? [{ text: line.trim(), location: (kind === 'line' ? { kind, line: index + 1 } : { kind, row: index + 1 }) as Location }]
    : []);
}

function docxUnits(content: Buffer): TextUnit[] {
  const zip = loadZip(content);
  const xml = readPart(zip, 'word/document.xml', true)!;
  const units: TextUnit[] = [];
  let paragraph = 0;
  for (const match of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const body = match[0];
    const pieces: string[] = [];
    for (const token of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
      if (token[0] === '<w:tab/>') pieces.push('\t');
      else if (token[0] === '<w:br/>') pieces.push('\n');
      else pieces.push(decodeXml(token[1]));
    }
    const text = pieces.join('').trim();
    if (text) units.push({ text, location: { kind: 'paragraph', paragraph: paragraph + 1 } });
    paragraph += 1;
  }
  return units;
}

function xlsxUnits(content: Buffer): TextUnit[] {
  const zip = loadZip(content);
  const workbook = readPart(zip, 'xl/workbook.xml', true)!;
  const rels = readPart(zip, 'xl/_rels/workbook.xml.rels', true)!;
  const shared = readPart(zip, 'xl/sharedStrings.xml', false) ?? '';
  const strings = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match =>
    [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(text => decodeXml(text[1])).join(''));
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)].map(match => [match[1], match[2]]));
  const units: TextUnit[] = [];
  for (const sheet of workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"/g)) {
    const target = targets.get(sheet[2]);
    if (!target || target.includes('..')) failed();
    const sheetXml = readPart(zip, `xl/${target.replace(/^\/?xl\//, '')}`, true)!;
    const sheetName = decodeXml(sheet[1]);
    for (const row of sheetXml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of row[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const ref = /\br="([A-Z]+\d+)"/.exec(cell[1])?.[1];
        const type = /\bt="([^"]+)"/.exec(cell[1])?.[1];
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1];
        let value: string | undefined;
        if (type === 's' && raw !== undefined) value = strings[Number(raw)];
        else if (type === 'inlineStr') value = [...cell[2].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(text => decodeXml(text[1])).join('');
        else if (raw !== undefined) value = decodeXml(raw);
        if (ref && value !== undefined && value.trim()) cells.push(`${ref}: ${value.trim()}`);
      }
      if (cells.length) units.push({ text: cells.join(' | '), location: { kind: 'row', sheet: sheetName, row: Number(row[1]) } });
    }
  }
  return units;
}

type PdfTextItem = { str?: string; hasEOL?: boolean };
type PdfDocument = { numPages: number; getPage(index: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }> }> };
/** pdfjs 6：釋放資源走 loading task 的 destroy()（document proxy 沒有 destroy）。 */
type PdfLoadingTask = { promise: Promise<PdfDocument>; destroy(): Promise<void> };
type PdfModule = { getDocument(options: Record<string, unknown>): PdfLoadingTask };

/** PDF 字型對應常把 CJK 字元映成康熙部首（如「頁」→「⾴」）；只對部首區段做 NFKC，不動全形標點。 */
function normalizePdfText(text: string) {
  return text.replace(/[\u2e80-\u2fdf]/g, char => char.normalize('NFKC'));
}

async function pdfUnits(content: Buffer): Promise<TextUnit[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs' as string) as PdfModule;
  const task = pdfjs.getDocument({ data: new Uint8Array(content), isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
    stopAtErrors: true, verbosity: 0, enableXfa: false });
  let document: PdfDocument;
  try {
    document = await task.promise;
  } catch {
    await task.destroy().catch(() => undefined);
    return failed(); // 損毀、加密（PasswordException）或非 PDF
  }
  try {
    if (document.numPages > MAX_PDF_PAGES) throw new Error('ENTERPRISE_EXTRACTION_TOO_LARGE');
    const units: TextUnit[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const items = (await page.getTextContent()).items;
      const text = normalizePdfText(items.map(item => (item.str ?? '') + (item.hasEOL ? '\n' : '')).join(''));
      text.split('\n').forEach((line, index) => {
        if (line.trim()) units.push({ text: line.trim(), location: { kind: 'page', page: pageNumber, line: index + 1 } });
      });
    }
    // 沒有文字層（掃描 PDF）：不支援 OCR，明確標示，不假裝擷取成功
    if (units.length === 0) throw new Error('ENTERPRISE_EXTRACTION_NO_TEXT_LAYER');
    return units;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/**
 * 只在隔離子行程（extraction-worker）內呼叫：依 media type 擷取可引用的文字單位。
 * 支援：純文字／Markdown（逐行）、CSV（逐列）、DOCX（逐段落）、XLSX（逐列含工作表與儲存格參照）、PDF 文字層（逐頁逐行）。
 * 圖片與無文字層 PDF 不支援（不做 OCR）；格式損壞回 ENTERPRISE_EXTRACTION_FAILED。
 */
export async function extractInProcess(mediaType: string, content: Buffer): Promise<{ extractor: string; units: TextUnit[] }> {
  let result: { extractor: string; units: TextUnit[] };
  if (mediaType === 'text/plain' || mediaType === 'text/markdown') result = { extractor: 'text-utf8@1', units: linesOf(content, 'line') };
  else if (mediaType === 'text/csv') result = { extractor: 'csv-utf8@1', units: linesOf(content, 'row') };
  else if (mediaType === DOCX) result = { extractor: 'docx-ooxml@2', units: docxUnits(content) };
  else if (mediaType === XLSX) result = { extractor: 'xlsx-ooxml@2', units: xlsxUnits(content) };
  else if (mediaType === PDF) result = { extractor: PDF_EXTRACTOR, units: await pdfUnits(content) };
  else throw new Error('ENTERPRISE_EXTRACTION_UNSUPPORTED');
  if (result.units.reduce((total, unit) => total + unit.text.length, 0) > MAX_TOTAL_TEXT) throw new Error('ENTERPRISE_EXTRACTION_TOO_LARGE');
  return result;
}

/**
 * 供同模組 enterprise.service 使用。純文字類在主行程（線性、受上傳大小限制）；
 * DOCX／XLSX／PDF 這類需要解析不可信結構的格式，一律在有記憶體／時間上限、無環境變數的子行程執行（DEC-PDF-01、ASTRA-003）。
 */
export async function extractDocumentText(mediaType: string, content: Buffer, options: { timeoutMs?: number; heapMb?: number } = {}) {
  if (mediaType === DOCX || mediaType === XLSX || mediaType === PDF) return runIsolatedExtraction(mediaType, content, options);
  return extractInProcess(mediaType, content);
}

/** 供 PDF/圖片等不支援型別記錄 extractor 名稱（擷取狀態仍為 unsupported）。 */
export function unsupportedExtractorName(mediaType: string) {
  return mediaType === PDF ? PDF_EXTRACTOR : 'binary-none@1';
}

/**
 * 供同模組 enterprise.service 使用：把相鄰單位合併成 ≤ maxChars 的 chunk，位置記錄起訖單位；單一過長單位切成多段並標 part。
 * 超過 5000 個 chunk 丟 ENTERPRISE_EXTRACTION_TOO_LARGE。
 */
export function chunkUnits(units: TextUnit[], maxChars = 800) {
  const chunks: Array<{ text: string; location: Record<string, unknown> }> = [];
  let pending: TextUnit[] = [];
  const flush = () => {
    if (!pending.length) return;
    chunks.push({ text: pending.map(unit => unit.text).join('\n'), location: { kind: pending[0].location.kind, from: pending[0].location, to: pending[pending.length - 1].location } });
    pending = [];
  };
  for (const unit of units) {
    if (unit.text.length > maxChars) {
      flush();
      for (let offset = 0, part = 1; offset < unit.text.length; offset += maxChars, part += 1) {
        chunks.push({ text: unit.text.slice(offset, offset + maxChars), location: { kind: unit.location.kind, from: unit.location, to: unit.location, part } });
      }
      continue;
    }
    const length = pending.reduce((total, item) => total + item.text.length + 1, 0) + unit.text.length;
    if (pending.length && length > maxChars) flush();
    pending.push(unit);
  }
  flush();
  if (chunks.length > MAX_CHUNKS) throw new Error('ENTERPRISE_EXTRACTION_TOO_LARGE');
  return chunks;
}
