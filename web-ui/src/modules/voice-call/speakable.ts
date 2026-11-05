/**
 * Turns streamed assistant markdown into sentences worth reading aloud. Code and tables are announced, not read;
 * sentences come out as soon as they are complete, and the total is capped so a long answer does not monopolize
 * the call (the full text is on screen anyway).
 */
export type SpeechBuffer = {
  /** Raw text after the last complete line. */
  partial: string;
  inFence: boolean;
  inTable: boolean;
  spokenChars: number;
  capped: boolean;
};

export const CODE_PLACEHOLDER = '（程式碼略，請看畫面）';
export const TABLE_PLACEHOLDER = '（表格請看畫面）';
export const CAP_NOTICE = '其餘內容請看畫面。';

export const emptySpeechBuffer = (): SpeechBuffer => ({ partial: '', inFence: false, inTable: false, spokenChars: 0, capped: false });

export function cleanInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '（連結）')
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__|~~|\*|`)/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*([-*_]\s*){3,}$/, '')
    .trim();
}

const SENTENCE_END = /([。！？!?]+|\.(?=\s))/g;

function splitSentences(text: string): { done: string[]; rest: string } {
  const done: string[] = [];
  let last = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    done.push(text.slice(last, end));
    last = end;
  }
  return { done, rest: text.slice(last) };
}

const isWorthSaying = (s: string) => /[\p{L}\p{N}]/u.test(s);

function take(buffer: SpeechBuffer, sentences: string[], maxChars: number, out: string[]) {
  for (const raw of sentences) {
    const s = raw.trim();
    if (buffer.capped || !isWorthSaying(s)) continue;
    if (buffer.spokenChars + s.length > maxChars) {
      buffer.capped = true;
      out.push(CAP_NOTICE);
      continue;
    }
    buffer.spokenChars += s.length;
    out.push(s);
  }
}

function takeLine(buffer: SpeechBuffer, line: string, maxChars: number, out: string[]) {
  const trimmed = line.trim();
  if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
    buffer.inFence = !buffer.inFence;
    if (buffer.inFence) take(buffer, [CODE_PLACEHOLDER], maxChars, out);
    return;
  }
  if (buffer.inFence) return;
  if (trimmed.startsWith('|')) {
    if (!buffer.inTable) take(buffer, [TABLE_PLACEHOLDER], maxChars, out);
    buffer.inTable = true;
    return;
  }
  buffer.inTable = false;
  const { done, rest } = splitSentences(cleanInline(line));
  take(buffer, [...done, rest], maxChars, out);
}

/** Feed streamed text; returns the sentences that became complete. */
export function feedSpeech(prev: SpeechBuffer, text: string, maxChars: number): { buffer: SpeechBuffer; sentences: string[] } {
  const buffer = { ...prev };
  const out: string[] = [];
  const lines = (buffer.partial + text).split('\n');
  buffer.partial = lines.pop() ?? '';
  for (const line of lines) takeLine(buffer, line, maxChars, out);

  // A partial line is spoken up to its last full sentence, unless it may still turn into code or a table.
  const head = buffer.partial.trimStart();
  if (!buffer.inFence && head && !head.startsWith('|') && !head.startsWith('`') && !head.startsWith('~')) {
    const { done, rest } = splitSentences(buffer.partial);
    if (done.length > 0) {
      take(buffer, done.map(cleanInline), maxChars, out);
      buffer.partial = rest;
    }
  }
  return { buffer, sentences: out };
}

/** End of the run: whatever is left is a sentence. */
export function flushSpeech(prev: SpeechBuffer, maxChars: number): { buffer: SpeechBuffer; sentences: string[] } {
  const buffer = { ...prev };
  const out: string[] = [];
  if (buffer.partial) takeLine(buffer, buffer.partial, maxChars, out);
  buffer.partial = '';
  return { buffer, sentences: out };
}

const QUOTA_PATTERN = /(usage limit|rate limit|limit reached|hit your limit|429|quota|too many requests|額度|用量上限|使用上限)/i;

export function looksLikeQuota(text: string): boolean {
  return QUOTA_PATTERN.test(text);
}
