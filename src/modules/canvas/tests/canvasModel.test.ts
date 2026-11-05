import { describe, expect, it } from 'vitest';

import { docToAutoOpen, extractCanvases, keySet, keysNotAbove, newestKeys, resolveFileVersions, undoEdit } from '@/modules/canvas/canvasModel';
import { BRIDGE_TAG, pageFor, readBridgeMessage, withBridge } from '@/modules/canvas/canvasBridge';
import type { ChatMessage } from '@/shared/types';

const at = 1_700_000_000_000;
const write = (id: string, file_path: string, content: string, isError = false): ChatMessage => ({
  type: 'assistant', isToolUse: true, toolName: 'Write', toolId: id, toolInput: { file_path, content }, timestamp: at,
  toolResult: { content: isError ? 'denied' : 'ok', isError } as never,
});
const edit = (id: string, file_path: string, old_string: string, new_string: string): ChatMessage => ({
  type: 'assistant', isToolUse: true, toolName: 'Edit', toolId: id, toolInput: { file_path, old_string, new_string }, timestamp: at,
  toolResult: { content: 'ok', isError: false } as never,
});
const waiting = (message: ChatMessage): ChatMessage => ({ ...message, toolResult: null });
const reply = (content: string, t = at): ChatMessage => ({ type: 'assistant', content, timestamp: t });
const page = (body: string) => `<!doctype html><html><head><title>試算器</title></head><body>${body}</body></html>`;

describe('extractCanvases', () => {
  it('follows a written HTML file through its edits', () => {
    const docs = extractCanvases([
      write('w1', 'D:\\p\\canvas\\calc.html', page('<b>v1</b>')),
      edit('e1', 'D:\\p\\canvas\\calc.html', '<b>v1</b>', '<b>v2</b>'),
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ id: 'file:D:\\p\\canvas\\calc.html', kind: 'html', title: '試算器' });
    expect(docs[0].versions.map((v) => v.content)).toEqual([page('<b>v1</b>'), page('<b>v2</b>')]);
  });

  it('reads tool input sent as JSON text, as the chat messages carry it', () => {
    const asText: ChatMessage = { ...write('w1', 'D:\\p\\a.html', page('x')), toolInput: JSON.stringify({ file_path: 'D:\\p\\a.html', content: page('x') }, null, 2) };
    expect(extractCanvases([asText]).map((d) => d.id)).toEqual(['file:D:\\p\\a.html']);
  });

  it('skips non-canvas files, failed writes and short or tagless fences', () => {
    const docs = extractCanvases([
      write('w1', 'D:\\p\\a.ts', 'x'),
      write('w2', 'D:\\p\\b.html', page('x'), true),
      reply('```html\n<p>hi</p>\n```'),
      reply(`\`\`\`html\n${'plain text '.repeat(20)}\n\`\`\``),
    ]);
    expect(docs).toEqual([]);
  });

  it('waits for a tool call to finish before counting it', () => {
    expect(extractCanvases([waiting(write('w1', 'D:\\p\\a.html', page('x')))])).toEqual([]);
  });

  it('gathers ```html blocks of the replies into one document', () => {
    const body = `<div>${'x'.repeat(150)}</div>`;
    const docs = extractCanvases([reply(`看這個：\n\`\`\`html\n${body}\n\`\`\``, at), reply(`改好了\n\`\`\`html\n${body}!\n\`\`\``, at + 1)]);
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe('fence');
    expect(docs[0].versions).toHaveLength(2);
  });

  it('lists the most recently touched document first', () => {
    const docs = extractCanvases([write('w1', 'D:\\p\\a.html', page('a')), write('w2', 'D:\\p\\b.svg', '<svg></svg>'), edit('e1', 'D:\\p\\a.html', 'a</body>', 'aa</body>')]);
    expect(docs.map((d) => d.kind)).toEqual(['html', 'svg']);
  });
});

describe('resolveFileVersions', () => {
  it('works edits of a file that existed before backwards from its current content', () => {
    const ops = [
      { kind: 'edit' as const, key: 'e1', edits: [{ old: 'A', next: 'B', all: false }] },
      { kind: 'edit' as const, key: 'e2', edits: [{ old: 'B', next: 'C', all: false }] },
    ];
    expect(resolveFileVersions(ops).needsCurrent).toBe(true);
    expect(resolveFileVersions(ops, 'xCx').versions.map((v) => v.content)).toEqual(['xBx', 'xCx']);
  });

  it('leaves a version unknown when its edit does not fit the content', () => {
    const ops = [
      { kind: 'write' as const, key: 'w', content: 'abc' },
      { kind: 'edit' as const, key: 'e', edits: [{ old: 'zzz', next: 'y', all: false }] },
    ];
    expect(resolveFileVersions(ops).versions.map((v) => v.content)).toEqual(['abc', null]);
  });

  it('does not walk back past a later Write', () => {
    const ops = [
      { kind: 'edit' as const, key: 'e', edits: [{ old: 'A', next: 'B', all: false }] },
      { kind: 'write' as const, key: 'w', content: 'new' },
    ];
    const result = resolveFileVersions(ops, 'new');
    expect(result).toEqual({ needsCurrent: false, versions: [{ content: null, messageKey: 'e' }, { content: 'new', messageKey: 'w' }] });
  });
});

describe('undoEdit', () => {
  it('gives up when the new text is there more than once, or the edit replaced all', () => {
    expect(undoEdit('總計…總計', { old: '合計', next: '總計', all: false })).toBeNull();
    expect(undoEdit('a總計b', { old: '合計', next: '總計', all: true })).toBeNull();
    expect(undoEdit('a總計b', { old: '合計', next: '總計', all: false })).toBe('a合計b');
  });
});

describe('docToAutoOpen', () => {
  const first = [write('w1', 'D:\\p\\a.html', page('a'))];
  it('opens on a new HTML version but not on Markdown or an unchanged transcript', () => {
    const before = newestKeys(extractCanvases(first));
    expect(docToAutoOpen(extractCanvases(first), before)).toBeNull();
    const next = extractCanvases([...first, edit('e1', 'D:\\p\\a.html', 'a</body>', 'b</body>')]);
    expect(docToAutoOpen(next, before)?.id).toBe('file:D:\\p\\a.html');
    expect(docToAutoOpen(extractCanvases([...first, write('m', 'D:\\p\\notes.md', '# x')]), before)).toBeNull();
  });

  it('does not open when older history is loaded above', () => {
    const before = newestKeys(extractCanvases(first));
    const withOlder = extractCanvases([write('w0', 'D:\\p\\a.html', page('old')), ...first]);
    expect(docToAutoOpen(withOlder, before)).toBeNull();
  });

  const feedStep = (shown: ChatMessage[], next: ChatMessage[]) =>
    docToAutoOpen(extractCanvases(next), newestKeys(extractCanvases(shown)), keysNotAbove(next, keySet(shown)))?.id ?? null;

  it('does not open a file that only older history loaded above brought in', () => {
    const shown = [reply('hi', at + 5)];
    expect(feedStep(shown, [write('w0', 'D:\\p\\old.html', page('old')), ...shown])).toBeNull();
    expect(feedStep(shown, [...shown, write('w1', 'D:\\p\\new.html', page('new'))])).toBe('file:D:\\p\\new.html');
  });

  it('opens a file whose waiting Write just got its result', () => {
    const shown = [reply('hi', at + 5), waiting(write('w1', 'D:\\p\\a.html', page('a')))];
    expect(feedStep(shown, [shown[0], write('w1', 'D:\\p\\a.html', page('a'))])).toBe('file:D:\\p\\a.html');
  });

  it('leaves html blocks in replies to be opened by hand', () => {
    const shown = [reply('hi', at + 5)];
    expect(feedStep(shown, [...shown, reply(`\`\`\`html\n<div>${'x'.repeat(150)}</div>\n\`\`\``, at + 6)])).toBeNull();
  });
});

describe('readBridgeMessage', () => {
  const frame = {} as Window;
  const event = (data: unknown, source: unknown = frame) => ({ data, source }) as MessageEvent;
  it("takes only this frame's messages and cuts what a page could stuff in", () => {
    expect(readBridgeMessage(event({ [BRIDGE_TAG]: 1, type: 'ready' }, {}), frame)).toBeNull();
    const picked = readBridgeMessage(event({ [BRIDGE_TAG]: 1, type: 'select', selector: 'b', html: '```' + 'x'.repeat(9000), text: 't' }), frame);
    expect(picked).toMatchObject({ type: 'select', selector: 'b' });
    const html = (picked as { html: string }).html;
    expect(html).toHaveLength(4000);
    expect(html.startsWith("'''")).toBe(true);
    expect(readBridgeMessage(event({ [BRIDGE_TAG]: 1, type: 'other' }), frame)).toBeNull();
  });
});

describe('canvas page', () => {
  it('puts the bridge before the last </body>, or at the end', () => {
    expect(withBridge('<html><body>x</body></html>')).toMatch(/x<script>[\s\S]*<\/script><\/body><\/html>$/);
    expect(withBridge('<p>x</p>')).toMatch(/^<meta http-equiv="Content-Security-Policy"[^>]*><p>x<\/p><script>/);
    expect(withBridge('<!doctype html><html><head><title>t</title></head><body></body></html>'))
      .toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*"><title>/);
  });
  it('wraps SVG and escapes unrendered Markdown', () => {
    expect(pageFor('svg', '<svg/>')).toContain('<body style="margin:0;display:flex;justify-content:center;align-items:flex-start"><svg/>');
    expect(pageFor('md', '<b>')).toContain('<pre>&lt;b&gt;</pre>');
  });
});
