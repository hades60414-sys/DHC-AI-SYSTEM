import JSZip from 'jszip';

/**
 * DHC CLI 10/14 文件共編: the model behind the page. Stored data parsing, what the AI sees and how its answer is
 * applied, and a small Markdown → Word (.docx) writer (headings, paragraphs, bullet/numbered lists, bold/italic,
 * code, quotes and simple tables) that produces minimal valid OOXML with jszip.
 */

export const MAX_DOCS = 30;
export const MAX_DOC_CHARS = 200_000;

export type DocItem = { id: string; title: string; markdown: string; updatedAt: string };
export type DocsData = { version: 1; activeId: string; docs: DocItem[]; chat: Array<{ role: 'user' | 'assistant'; text: string }> };

let counter = 0;
export const newDocId = () => `d${Date.now().toString(36)}${(counter += 1).toString(36)}`;

export const emptyDoc = (title: string): DocItem => ({ id: newDocId(), title, markdown: '', updatedAt: new Date().toISOString() });

export function parseDocsData(value: unknown): DocsData {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const docs: DocItem[] = [];
  for (const item of Array.isArray(v.docs) ? v.docs : []) {
    if (!item || typeof item !== 'object' || docs.length >= MAX_DOCS) continue;
    const d = item as Record<string, unknown>;
    docs.push({
      id: typeof d.id === 'string' && d.id ? d.id : newDocId(),
      title: typeof d.title === 'string' && d.title.trim() ? d.title.slice(0, 80) : `文件 ${docs.length + 1}`,
      markdown: typeof d.markdown === 'string' ? d.markdown.slice(0, MAX_DOC_CHARS) : '',
      updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : new Date().toISOString(),
    });
  }
  if (docs.length === 0) docs.push(emptyDoc('我的第一份文件'));
  const chat = (Array.isArray(v.chat) ? v.chat : [])
    .filter((m): m is { role: 'user' | 'assistant'; text: string } => !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .slice(-40);
  const activeId = typeof v.activeId === 'string' && docs.some((d) => d.id === v.activeId) ? v.activeId : docs[0].id;
  return { version: 1, activeId, docs, chat };
}

// ---------------------------------------------------------------------------------------------------------------
// AI

export type Selection = { from: number; to: number; text: string };

const CONTEXT_DOC = 90_000;
const CONTEXT_SELECTION = 20_000;

/** What the AI sees: title, the document (capped), and the selected text if any. */
export function docContext(title: string, markdown: string, selection: Selection | null) {
  return {
    title,
    markdown: markdown.slice(0, CONTEXT_DOC),
    truncated: markdown.length > CONTEXT_DOC,
    selection: selection ? selection.text.slice(0, CONTEXT_SELECTION) : '',
    selectionTruncated: selection ? selection.text.length > CONTEXT_SELECTION : false,
  };
}

/** Applies the AI's {markdown} or {replaceSelection}; returns the new text, or throws a readable error. */
export function applyDocResult(markdown: string, selection: Selection | null, result: unknown, truncated: boolean): { markdown: string; note: string } {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  if (typeof r.replaceSelection === 'string') {
    if (!selection || !selection.text) throw new Error('沒有選取文字');
    let from = selection.from;
    let to = selection.to;
    // The selection may have moved while the AI was thinking; find the same text again or give up.
    if (markdown.slice(from, to) !== selection.text) {
      from = markdown.indexOf(selection.text);
      if (from < 0) throw new Error('選取的文字已經改過了');
      to = from + selection.text.length;
    }
    return { markdown: markdown.slice(0, from) + r.replaceSelection + markdown.slice(to), note: '已替換選取的文字，可按「復原 AI 修改」' };
  }
  if (typeof r.markdown === 'string') {
    if (truncated) throw new Error('文件太長，AI 只看到前半部，不能整份取代');
    return { markdown: r.markdown.slice(0, MAX_DOC_CHARS), note: '已更新整份文件，可按「復原 AI 修改」' };
  }
  throw new Error('no change');
}

export function docBrief(title: string, markdown: string): string {
  return [
    `我在「文件共編」寫了一份文件「${title}」（Markdown），請接著把它寫完、補齊並檢查：`,
    '1) 補完缺的章節與細節，保持原有的語氣與用語；2) 找出前後矛盾或不清楚的地方並修正；3) 完成後把最終版存成 .md 檔，告訴我檔案位置。',
    '',
    '--- 文件開始 ---',
    markdown,
    '--- 文件結束 ---',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown → blocks

type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean; br?: boolean };
type Block =
  | { t: 'heading'; level: number; runs: Run[] }
  | { t: 'para'; runs: Run[]; quote?: boolean }
  | { t: 'item'; level: number; numId: number; runs: Run[] }
  | { t: 'code'; text: string }
  | { t: 'hr' }
  | { t: 'table'; rows: Run[][][] };

/** Inline Markdown (code, **bold**, *italic*, links, images) to styled runs. */
export function parseInline(src: string, style: { bold?: boolean; italic?: boolean } = {}): Run[] {
  const runs: Run[] = [];
  let buf = '';
  const flush = () => { if (buf) { runs.push({ text: buf, ...style }); buf = ''; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    if (ch === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|>~]/.test(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) { flush(); runs.push({ text: src.slice(i + 1, end), ...style, code: true }); i = end + 1; continue; }
    }
    if (rest.startsWith('**') || rest.startsWith('__')) {
      const mark = rest.slice(0, 2);
      const end = src.indexOf(mark, i + 2);
      if (end > i + 2 && !/\s/.test(src[i + 2])) {
        flush();
        runs.push(...parseInline(src.slice(i + 2, end), { ...style, bold: true }));
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && !/\s/.test(src[i + 1] ?? ' ') && !(ch === '_' && /[A-Za-z0-9]/.test(src[i - 1] ?? ' '))) {
      let end = i + 1;
      while (end < src.length && !(src[end] === ch && src[end + 1] !== ch && src[end - 1] !== ch && !/\s/.test(src[end - 1]))) end += 1;
      if (end < src.length && end > i + 1) {
        flush();
        runs.push(...parseInline(src.slice(i + 1, end), { ...style, italic: true }));
        i = end + 1;
        continue;
      }
    }
    if (ch === '~' && rest.startsWith('~~')) {
      const end = src.indexOf('~~', i + 2);
      if (end > i + 2) { buf += src.slice(i + 2, end); i = end + 2; continue; }
    }
    const image = /^!\[([^\]]*)\]\([^)]*\)/.exec(rest);
    if (image) { buf += `[圖片${image[1] ? `：${image[1]}` : ''}]`; i += image[0].length; continue; }
    const link = /^\[([^\]]*)\]\(([^)\s]*)[^)]*\)/.exec(rest);
    if (link) {
      buf += link[1] && link[1] !== link[2] ? `${link[1]} (${link[2]})` : link[2] || link[1];
      i += link[0].length;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush();
  return runs;
}

const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const splitRow = (line: string): string[] => {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
};

const joinLines = (lines: string[]): Run[] => {
  const runs: Run[] = [];
  lines.forEach((line, index) => {
    const hard = / {2,}$/.test(line) || line.endsWith('\\');
    const body = line.trim().replace(/\\$/, '');
    if (index > 0) {
      const prev = lines[index - 1].trim();
      // A soft line break is a space between words, nothing between Chinese characters.
      if (!(/[^\x00-\x7F]$/.test(prev) && /^[^\x00-\x7F]/.test(body))) runs.push({ text: ' ' });
    }
    runs.push(...parseInline(body));
    if (hard && index < lines.length - 1) runs.push({ text: '', br: true });
  });
  return runs;
};

export function parseBlocks(markdown: string): { blocks: Block[]; orderedLists: number } {
  const lines = markdown.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const blocks: Block[] = [];
  let nextNumId = 2; // 1 is the bullet list; every ordered list gets its own so it restarts at 1.
  let indents: number[] = [];
  let ordered: Record<number, number> = {};
  const resetList = () => { indents = []; ordered = {}; };
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) blocks.push({ t: 'para', runs: joinLines(para) });
    para = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flushPara();
      resetList();
      const fence = FENCE.exec(line)![1];
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) { code.push(lines[i]); i += 1; }
      blocks.push({ t: 'code', text: code.join('\n') });
      continue;
    }
    // A blank line ends a paragraph but not a list: items separated by blank lines are still one list.
    if (line.trim() === '') { flushPara(); continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushPara();
      resetList();
      blocks.push({ t: 'heading', level: heading[1].length, runs: parseInline(heading[2]) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); resetList(); blocks.push({ t: 'hr' }); continue; }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushPara();
      resetList();
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) { rows.push(splitRow(lines[i])); i += 1; }
      i -= 1;
      blocks.push({ t: 'table', rows: rows.map((r) => r.map((cell) => parseInline(cell))) });
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      resetList();
      blocks.push({ t: 'para', runs: parseInline(quote[1]), quote: true });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushPara();
      const indent = item[1].length;
      while (indents.length > 0 && indents[indents.length - 1] > indent) indents.pop();
      if (indents.length === 0 || indents[indents.length - 1] < indent) indents.push(indent);
      const level = Math.min(2, indents.length - 1);
      for (const key of Object.keys(ordered)) if (Number(key) > level) delete ordered[Number(key)];
      const isOrdered = /\d/.test(item[2]);
      let numId = 1;
      if (isOrdered) {
        if (ordered[level] === undefined) { ordered[level] = nextNumId; nextNumId += 1; }
        numId = ordered[level];
      } else delete ordered[level];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
      const body = task ? `${task[1] === ' ' ? '☐' : '☑'} ${task[2]}` : item[3];
      blocks.push({ t: 'item', level, numId, runs: parseInline(body) });
      continue;
    }
    // An indented line right after a list item continues that item.
    const last = blocks[blocks.length - 1];
    if (para.length === 0 && indents.length > 0 && last?.t === 'item' && /^\s+\S/.test(line)) {
      last.runs.push({ text: ' ' }, ...parseInline(line.trim()));
      continue;
    }
    resetList();
    para.push(line);
  }
  flushPara();
  return { blocks, orderedLists: nextNumId - 2 };
}

// ---------------------------------------------------------------------------------------------------------------
// Blocks → OOXML

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const FONT_EAST_ASIA = '微軟正黑體';

// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
export const escapeXml = (text: string) => text.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const runXml = (run: Run, extra = ''): string => {
  if (run.br) return '<w:r><w:br/></w:r>';
  const props = [
    run.code ? `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="${FONT_EAST_ASIA}"/>` : '',
    run.bold ? '<w:b/>' : '',
    run.italic ? '<w:i/>' : '',
    extra,
    run.code ? '<w:shd w:val="clear" w:color="auto" w:fill="EDEDED"/>' : '',
  ].join('');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
};

const paragraph = (runs: Run[], pPr = '', extraRun = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs.map((r) => runXml(r, extraRun)).join('')}</w:p>`;

const BORDER = '<w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/>';

function tableXml(rows: Run[][][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const width = Math.floor(9000 / cols);
  const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join('');
  const body = rows.map((row, ri) => {
    const cells = Array.from({ length: cols }, (_, ci) => {
      const runs = (row[ci] ?? []).map((r) => (ri === 0 ? { ...r, bold: true } : r));
      const shade = ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="E7E6E6"/>' : '';
      return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}</w:tcPr>${paragraph(runs.length > 0 ? runs : [{ text: '' }], '<w:spacing w:before="40" w:after="40"/>')}</w:tc>`;
    }).join('');
    return `<w:tr>${ri === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${BORDER}</w:tblBorders><w:tblLayout w:type="autofit"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

function blockXml(block: Block): string {
  switch (block.t) {
    case 'heading': return paragraph(block.runs, `<w:pStyle w:val="Heading${Math.min(3, block.level)}"/>`);
    case 'para': return paragraph(block.runs, block.quote ? '<w:pStyle w:val="Quote"/>' : '');
    case 'item': return paragraph(block.runs, `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${block.level}"/><w:numId w:val="${block.numId}"/></w:numPr>`);
    case 'code': return block.text.split('\n').map((line) => paragraph([{ text: line, code: true }], '<w:pStyle w:val="CodeBlock"/>')).join('');
    case 'hr': return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>';
    case 'table': return `${tableXml(block.rows)}<w:p/>`;
    default: return '';
  }
}

export function documentXml(markdown: string): string {
  const { blocks } = parseBlocks(markdown);
  const body = blocks.map(blockXml).join('');
  return `${XML_HEAD}<w:document ${NS}><w:body>${body || '<w:p/>'}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

const fonts = (ascii = 'Calibri') => `<w:rFonts w:ascii="${ascii}" w:hAnsi="${ascii}" w:eastAsia="${FONT_EAST_ASIA}" w:cs="${ascii}"/>`;
const headingStyle = (n: number, size: number, before: number) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr>${fonts()}<w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;

export function stylesXml(): string {
  return `${XML_HEAD}<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr>${fonts()}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-TW"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + headingStyle(1, 40, 360) + headingStyle(2, 32, 280) + headingStyle(3, 26, 200)
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BBBBBB"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>'
    + `<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr>${fonts('Consolas')}<w:sz w:val="20"/></w:rPr></w:style>`
    + '</w:styles>';
}

export function numberingXml(orderedLists: number): string {
  const bullets = ['•', '◦', '▪'];
  const bulletLevels = bullets.map((b, l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${b}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
  const decimalLevels = [0, 1, 2].map((l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman'][l]}"/><w:lvlText w:val="%${l + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
  const nums = ['<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'];
  for (let n = 0; n < orderedLists; n += 1) {
    nums.push(`<w:num w:numId="${n + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`);
  }
  return `${XML_HEAD}<w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bulletLevels}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${decimalLevels}</w:abstractNum>${nums.join('')}</w:numbering>`;
}

const CONTENT_TYPES = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`;
const ROOT_RELS = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOC_RELS = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`;

/** Every part of the .docx as text, by path. */
export function docxParts(markdown: string): Record<string, string> {
  const { orderedLists } = parseBlocks(markdown);
  return {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'word/document.xml': documentXml(markdown),
    'word/_rels/document.xml.rels': DOC_RELS,
    'word/styles.xml': stylesXml(),
    'word/numbering.xml': numberingXml(orderedLists),
  };
}

/** The .docx file as bytes. */
export async function buildDocx(markdown: string): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(docxParts(markdown))) zip.file(path, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
