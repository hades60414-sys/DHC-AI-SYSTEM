import type { AssistMessage } from '@/shared/customTools';

/** DHC CLI 10/14 程式差異審閱台: the reviews kept per person, plus pure helpers (parsing, line diff, brief). */

export const LANGUAGES = [
  { id: 'sql', label: 'SQL' },
  { id: 'python', label: 'Python' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'json', label: 'JSON' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'text', label: '純文字' },
] as const;
export type LanguageId = (typeof LANGUAGES)[number]['id'];
const LANGUAGE_IDS = new Set<string>(LANGUAGES.map((language) => language.id));
export const languageLabel = (id: LanguageId) => LANGUAGES.find((language) => language.id === id)?.label ?? id;

export type Severity = 'high' | 'mid' | 'low';
export const SEVERITY_LABEL: Record<Severity, string> = { high: '高', mid: '中', low: '低' };
const SEVERITY_ORDER: Record<Severity, number> = { high: 0, mid: 1, low: 2 };

export type Finding = { side: 'before' | 'after'; line: number; severity: Severity; title: string; detail: string };

export type Review = {
  id: string;
  name: string;
  language: LanguageId;
  before: string;
  after: string;
  findings: Finding[];
  chat: AssistMessage[];
  updatedAt: string;
};

export const MAX_REVIEWS = 10;
const MAX_SOURCE = 200_000;
const MAX_FINDINGS = 30;

export const newReviewId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

export const emptyReview = (name: string): Review => ({
  id: newReviewId(), name, language: 'sql', before: '', after: '', findings: [], chat: [], updatedAt: new Date().toISOString(),
});

/** Findings from storage or from the AI: bad entries dropped, high severity first. */
export function parseFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_FINDINGS)
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .map((raw, index) => ({
      index,
      finding: {
        side: raw.side === 'before' ? 'before' as const : 'after' as const,
        line: Math.max(1, Math.floor(Number(raw.line)) || 1),
        severity: raw.severity === 'high' || raw.severity === 'mid' ? raw.severity : 'low' as Severity,
        title: text(raw.title, 120).trim(),
        detail: text(raw.detail, 1500).trim(),
      },
    }))
    .filter(({ finding }) => finding.title || finding.detail)
    .sort((left, right) => SEVERITY_ORDER[left.finding.severity] - SEVERITY_ORDER[right.finding.severity] || left.index - right.index)
    .map(({ finding }) => ({ ...finding, title: finding.title || finding.detail.slice(0, 30) }));
}

export function parseReviews(value: unknown): Review[] {
  const raw = (value ?? {}) as { reviews?: unknown };
  if (!Array.isArray(raw.reviews)) return [];
  return raw.reviews
    .map((entry) => (entry ?? {}) as Record<string, unknown>)
    .filter((entry) => typeof entry.id === 'string' && entry.id)
    .slice(0, MAX_REVIEWS)
    .map((entry) => ({
      id: entry.id as string,
      name: text(entry.name, 80) || '未命名',
      language: LANGUAGE_IDS.has(entry.language as string) ? entry.language as LanguageId : 'sql',
      before: text(entry.before, MAX_SOURCE),
      after: text(entry.after, MAX_SOURCE),
      findings: parseFindings(entry.findings),
      chat: Array.isArray(entry.chat)
        ? entry.chat
          .map((item) => (item ?? {}) as Record<string, unknown>)
          .filter((item) => (item.role === 'user' || item.role === 'assistant') && typeof item.text === 'string')
          .map((item) => ({ role: item.role as 'user' | 'assistant', text: text(item.text, 4000) }))
        : [],
      updatedAt: text(entry.updatedAt, 40),
    }));
}

// ---- line diff ----

export type Hunk = { beforeStart: number; afterStart: number; removed: string[]; added: string[] };

const splitLines = (source: string) => (source === '' ? [] : source.replace(/\r\n?/g, '\n').split('\n'));

/** Changed regions between two texts (line numbers from 1), by longest common subsequence after trimming the shared ends. */
export function lineDiff(before: string, after: string): Hunk[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length === 0 && midB.length === 0) return [];

  // Too big for the table: report the whole middle as one change rather than hang the page.
  if (midA.length * midB.length > 4_000_000) {
    return [{ beforeStart: head + 1, afterStart: head + 1, removed: midA, added: midB }];
  }

  const width = midB.length + 1;
  const lcs = new Uint32Array((midA.length + 1) * width);
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = midA[i] === midB[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  const flush = () => { if (current) hunks.push(current); current = null; };
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      flush();
      i += 1;
      j += 1;
    } else {
      current ??= { beforeStart: head + i + 1, afterStart: head + j + 1, removed: [], added: [] };
      if (j >= midB.length || (i < midA.length && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
        current.removed.push(midA[i]);
        i += 1;
      } else {
        current.added.push(midB[j]);
        j += 1;
      }
    }
  }
  flush();
  return hunks;
}

export const diffStats = (hunks: Hunk[]) => ({
  added: hunks.reduce((sum, hunk) => sum + hunk.added.length, 0),
  removed: hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0),
  hunks: hunks.length,
});

const BRIEF_DIFF_LIMIT = 8000;

/** The diff as text for the brief: each changed region with its line numbers, capped so the brief stays readable. */
export function diffSummary(before: string, after: string): string {
  const hunks = lineDiff(before, after);
  if (hunks.length === 0) return '兩版完全相同。';
  const stats = diffStats(hunks);
  const lines = [`共 ${stats.hunks} 處差異，新版增加 ${stats.added} 行、刪除 ${stats.removed} 行。`];
  let size = 0;
  let shown = 0;
  for (const hunk of hunks) {
    const block = [
      `@@ 舊版第 ${hunk.beforeStart} 行 → 新版第 ${hunk.afterStart} 行 @@`,
      ...hunk.removed.map((line) => `- ${line}`),
      ...hunk.added.map((line) => `+ ${line}`),
    ].join('\n');
    if (size + block.length > BRIEF_DIFF_LIMIT && shown > 0) break;
    lines.push(block);
    size += block.length;
    shown += 1;
  }
  if (shown < hunks.length) lines.push(`（還有 ${hunks.length - shown} 處差異沒列出，請直接比對兩版全文）`);
  return lines.join('\n');
}

export type LineDecoration = { side: 'before' | 'after'; line: number; severity: Severity; title: string };

/** One decoration spec per finding, in the order given; several on one line are all kept (the editor shows the worst). */
export const findingDecorations = (findings: Finding[]): LineDecoration[] => findings.map((finding) => ({
  side: finding.side, line: finding.line, severity: finding.severity, title: finding.title,
}));

/** 「高 2・中 1・低 3」: only severities that occur; empty when there are no findings. */
export const severitySummary = (findings: Finding[]): string => (['high', 'mid', 'low'] as const)
  .map((severity) => ({ severity, count: findings.filter((finding) => finding.severity === severity).length }))
  .filter(({ count }) => count > 0)
  .map(({ severity, count }) => `${SEVERITY_LABEL[severity]} ${count}`)
  .join('・');

const sideLabel = (side: Finding['side']) => (side === 'after' ? '新版' : '舊版');

/** Work order for the chat: where the two versions differ plus the findings the person ticked. */
export function reviewBrief(review: Review, chosen: Finding[]): string {
  const lines = [
    `請幫我處理程式差異審閱「${review.name}」（${languageLabel(review.language)}）。`,
    '',
    '【兩版差異】',
    diffSummary(review.before, review.after),
  ];
  if (chosen.length > 0) {
    lines.push('', '【要處理的問題】');
    chosen.forEach((finding, index) => {
      lines.push(`${index + 1}. [${SEVERITY_LABEL[finding.severity]}] ${finding.title}（${sideLabel(finding.side)}第 ${finding.line} 行）`);
      if (finding.detail) lines.push(`   ${finding.detail.replace(/\s+/g, ' ')}`);
    });
  }
  lines.push('', '請先確認你看得到這段程式（找不到就問我檔案位置），再逐項說明打算怎麼改；改完說明怎麼驗證。');
  return lines.join('\n');
}

// ---- import: files become the old / new side ----
const EXTENSION_LANGUAGE: Record<string, LanguageId> = {
  sql: 'sql', py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript',
  json: 'json', html: 'html', htm: 'html', css: 'css', md: 'markdown',
};

/** Language from the file extension; null when unknown (the caller keeps the current one). */
export function languageFromFileName(name: string): LanguageId | null {
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  if (!extension) return null;
  return EXTENSION_LANGUAGE[extension] ?? null;
}

export type ImportedSource = { name: string; lastModified: number; text: string };
export type CodeImportPlan = { before: string; after: string; language: LanguageId | null; message: string };

/**
 * One file goes to the empty side (舊版 first), or to 新版 when both are filled; two files go older -> 舊版, newer -> 新版.
 * Files that look binary are skipped; more than two: only the first two are used.
 */
export function planCodeImport(files: ImportedSource[], current: { before: string; after: string }): CodeImportPlan | null {
  const readable = files.filter((file) => !file.text.includes('\u0000'));
  const binary = files.length - readable.length;
  const notes: string[] = [];
  if (binary > 0) notes.push(`${binary} 個看起來不是文字檔，已略過`);
  if (readable.length === 0) return null;
  const used = readable.slice(0, 2);
  if (readable.length > 2) notes.push(`一次最多放 2 個檔案，其餘 ${readable.length - 2} 個沒放`);
  const cut = (file: ImportedSource) => file.text.slice(0, MAX_SOURCE);
  const truncated = used.filter((file) => file.text.length > MAX_SOURCE).map((file) => file.name);
  if (truncated.length > 0) notes.push(`${truncated.join('、')} 超過 ${MAX_SOURCE} 字，只放前面的部分`);
  let before = current.before;
  let after = current.after;
  let message: string;
  if (used.length === 2) {
    const [older, newer] = [...used].sort((left, right) => left.lastModified - right.lastModified);
    before = cut(older);
    after = cut(newer);
    message = `舊版：${older.name}（較早修改），新版：${newer.name}`;
  } else if (!current.before) {
    before = cut(used[0]);
    message = `已放進左邊的舊版：${used[0].name}`;
  } else if (!current.after) {
    after = cut(used[0]);
    message = `已放進右邊的新版：${used[0].name}`;
  } else {
    after = cut(used[0]);
    message = `兩邊都有內容，已取代右邊的新版：${used[0].name}`;
  }
  const language = [...used].reverse().map((file) => languageFromFileName(file.name)).find((id) => id !== null) ?? null;
  return { before, after, language, message: [message, ...notes].join('；') };
}
