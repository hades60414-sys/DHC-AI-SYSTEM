import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type * as CustomToolsModule from '@/shared/customTools';

/** DHC CLI 10/14 程式差異審閱台: model helpers (line diff, findings, brief) and one render of the window. */

const store = vi.hoisted(() => ({ data: null as unknown, saved: [] as unknown[] }));
vi.mock('@/shared/customTools', async (importOriginal) => ({
  ...(await importOriginal<typeof CustomToolsModule>()),
  loadToolData: async () => store.data,
  createToolSaver: () => ({ save: (value: unknown) => { store.saved.push(value); }, flush: async () => {} }),
}));

vi.mock('@/modules/tool-library/importers', () => ({
  readTextFile: (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  }),
  readSpreadsheetFile: async () => [],
}));

const model = await import('@/modules/tool-library/tools/codeReviewModel');
const { default: CodeReview } = await import('@/modules/tool-library/tools/CodeReview');

// jsdom has no scrollIntoView (the AI chat panel calls it).
Element.prototype.scrollIntoView = () => {};
// CodeMirror measures text with Range rects, which jsdom lacks.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

afterEach(() => {
  cleanup();
  store.data = null;
  store.saved = [];
});

test('lineDiff finds changed, added and removed lines with 1-based numbers', () => {
  const hunks = model.lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0], { beforeStart: 2, afterStart: 2, removed: ['b'], added: ['B'] });
  assert.deepEqual(hunks[1], { beforeStart: 5, afterStart: 5, removed: [], added: ['e'] });
  assert.deepEqual(model.diffStats(hunks), { added: 2, removed: 1, hunks: 2 });
  assert.deepEqual(model.lineDiff('same', 'same'), []);
  assert.equal(model.lineDiff('', 'x').length, 1);
});

test('parseFindings sorts by severity, clamps lines and drops empty entries', () => {
  const findings = model.parseFindings([
    { side: 'after', line: 3, severity: 'low', title: '小' },
    { side: 'before', line: -2, severity: 'high', title: '大', detail: 'd' },
    { title: '', detail: '' },
    { line: 'x', severity: 'weird', title: '怪' },
  ]);
  assert.deepEqual(findings.map((finding) => finding.title), ['大', '小', '怪']);
  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].side, 'before');
  assert.equal(findings[2].severity, 'low');
  assert.deepEqual(model.parseFindings(null), []);
});

test('parseReviews keeps valid reviews and defaults unknown languages to SQL', () => {
  const reviews = model.parseReviews({ reviews: [{ id: 'r1', name: 'SP', language: 'cobol', before: 'a', after: 'b' }, { name: 'no id' }] });
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].language, 'sql');
  assert.deepEqual(model.parseReviews(undefined), []);
});

test('reviewBrief holds the diff and only the chosen findings', () => {
  const review = { ...model.emptyReview('月結 SP'), before: 'select 1', after: 'select 2' };
  const brief = model.reviewBrief(review, [{ side: 'after', line: 1, severity: 'high', title: '少了條件', detail: 'WHERE 被拿掉' }]);
  assert.match(brief, /月結 SP/);
  assert.match(brief, /- select 1/);
  assert.match(brief, /\+ select 2/);
  assert.match(brief, /\[高\] 少了條件（新版第 1 行）/);
  assert.match(brief, /WHERE 被拿掉/);
});

test('window opens the saved review with its findings and sends the ticked ones on 開工', async () => {
  store.data = {
    reviews: [{
      id: 'r1',
      name: '月結 SP',
      language: 'sql',
      before: 'select 1\nfrom t',
      after: 'select 2\nfrom t',
      findings: [
        { side: 'after', line: 1, severity: 'high', title: '少了條件', detail: 'WHERE 被拿掉' },
        { side: 'after', line: 2, severity: 'low', title: '別名', detail: '' },
      ],
    }],
  };
  const onStartWork = vi.fn();
  render(<CodeReview profileId="p1" profileName="小明" isMobile={false} onClose={() => {}} onStartWork={onStartWork} />);

  await waitFor(() => assert.ok(screen.getByText('少了條件')));
  await waitFor(() => assert.ok(screen.getByTestId('diff-panes').querySelector('.cm-editor'), 'the merge view is mounted'));
  assert.ok(screen.getByText(/1 處差異/));

  fireEvent.click(screen.getByLabelText('處理：少了條件'));
  fireEvent.click(screen.getByRole('button', { name: '開工' }));
  await waitFor(() => assert.equal(onStartWork.mock.calls.length, 1));
  const brief = onStartWork.mock.calls[0][0] as string;
  assert.match(brief, /少了條件/);
  assert.doesNotMatch(brief, /別名/);
});

test('languageFromFileName picks the language by extension and returns null for unknown ones', () => {
  assert.equal(model.languageFromFileName('a.sql'), 'sql');
  assert.equal(model.languageFromFileName('a.PY'), 'python');
  assert.equal(model.languageFromFileName('x.tsx'), 'javascript');
  assert.equal(model.languageFromFileName('notes.md'), 'markdown');
  assert.equal(model.languageFromFileName('x.vb'), null);
  assert.equal(model.languageFromFileName('Makefile'), null);
});

test('planCodeImport: one file fills 左 first, then 右, then replaces 右; two files go older -> 舊版', () => {
  const file = (name: string, lastModified: number, text: string) => ({ name, lastModified, text });
  const empty = { before: '', after: '' };
  assert.equal(model.planCodeImport([file('a.sql', 1, 'A')], empty)?.before, 'A');
  const second = model.planCodeImport([file('b.sql', 2, 'B')], { before: 'A', after: '' });
  assert.equal(second?.before, 'A');
  assert.equal(second?.after, 'B');
  const third = model.planCodeImport([file('c.sql', 3, 'C')], { before: 'A', after: 'B' });
  assert.equal(third?.before, 'A');
  assert.equal(third?.after, 'C');
  const two = model.planCodeImport([file('new.py', 20, 'N'), file('old.py', 10, 'O')], { before: 'x', after: 'y' });
  assert.equal(two?.before, 'O');
  assert.equal(two?.after, 'N');
  assert.equal(two?.language, 'python');
  assert.equal(model.planCodeImport([file('bin.dat', 1, 'a\u0000b')], empty), null);
});

test('importing two files fills both sides, older on the left, and picks the language', async () => {
  store.data = { reviews: [{ id: 'r1', name: '審閱', language: 'sql', before: '', after: '', findings: [], chat: [] }] };
  render(<CodeReview profileId="p1" profileName="小明" isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.ok(screen.getByTestId('tool-import-input')));
  const newer = new File(['print(2)'], 'new.py', { lastModified: 2000 });
  const older = new File(['print(1)'], 'old.py', { lastModified: 1000 });
  fireEvent.change(screen.getByTestId('tool-import-input'), { target: { files: [newer, older] } });
  await waitFor(() => assert.ok(screen.getByText(/舊版：old\.py/)));
  await waitFor(() => {
    const saved = store.saved.at(-1) as { reviews: Array<{ before: string; after: string; language: string }> };
    assert.equal(saved.reviews[0].before, 'print(1)');
    assert.equal(saved.reviews[0].after, 'print(2)');
    assert.equal(saved.reviews[0].language, 'python');
  });
});

const { sqlToken } = await import('@/modules/tool-library/tools/sqlLanguage');
const { StringStream } = await import('@codemirror/language');

/** Runs the T-SQL tokenizer over lines and returns [text, token] pairs for non-plain tokens. */
function tokenize(source: string) {
  const state = { inComment: false };
  const out: Array<[string, string]> = [];
  for (const line of source.split('\n')) {
    const stream = new StringStream(line, 2, 2);
    while (!stream.eol()) {
      stream.start = stream.pos;
      const token = sqlToken(stream, state);
      if (token) out.push([stream.current(), token]);
    }
  }
  return out;
}

test('T-SQL tokenizer classifies keywords, functions, strings, comments, variables and numbers', () => {
  const tokens = tokenize("select isnull(@x, 0) from [dbo].[T] where n = N'it''s' -- tail\n/* multi\nline */ and 1.5 > 0x1F");
  const has = (text: string, kind: string) => assert.ok(tokens.some(([t, k]) => t === text && k === kind), `${text} -> ${kind}`);
  has('select', 'keyword');
  has('from', 'keyword');
  has('and', 'keyword');
  has('isnull', 'builtin');
  has('@x', 'variableName');
  has('[dbo]', 'variableName.special');
  has("N'it''s'", 'string');
  has('-- tail', 'comment');
  has('/* multi', 'comment');
  has('line */', 'comment');
  has('0', 'number');
  has('1.5', 'number');
  has('0x1F', 'number');
});

test('findings map to line decoration specs and the severity summary counts them', () => {
  const findings = model.parseFindings([
    { side: 'after', line: 4, severity: 'low', title: 'a' },
    { side: 'before', line: 2, severity: 'high', title: 'b' },
    { side: 'after', line: 9, severity: 'high', title: 'c' },
    { side: 'after', line: 9, severity: 'mid', title: 'd' },
    { side: 'after', line: 1, severity: 'low', title: 'e' },
    { side: 'after', line: 3, severity: 'low', title: 'f' },
  ]);
  assert.deepEqual(model.findingDecorations(findings.slice(0, 2)), [
    { side: 'before', line: 2, severity: 'high', title: 'b' },
    { side: 'after', line: 9, severity: 'high', title: 'c' },
  ]);
  assert.equal(model.severitySummary(findings), '高 2・中 1・低 3');
  assert.equal(model.severitySummary(findings.filter((finding) => finding.severity === 'low')), '低 3');
  assert.equal(model.severitySummary([]), '');
});

test('findings pane shows the count and severity summary, and collapses to a slim bar when empty', async () => {
  store.data = {
    reviews: [{
      id: 'r1', name: 'SP', language: 'sql', before: 'select 1', after: 'select 2',
      findings: [{ side: 'after', line: 1, severity: 'high', title: 'x' }, { side: 'before', line: 1, severity: 'low', title: 'y' }],
    }, { id: 'r2', name: '空', language: 'sql', before: '', after: '', findings: [] }],
  };
  render(<CodeReview profileId="p1" profileName="小明" isMobile={false} onClose={() => {}} onStartWork={null} />);
  await waitFor(() => assert.equal(screen.getByTestId('severity-summary').textContent, '高 1・低 1'));
  assert.ok(screen.getByText('AI 發現的問題（2）'));
  assert.ok(screen.getByTestId('findings-handle'));
  await waitFor(() => assert.ok(screen.getByTestId('diff-panes').querySelector('.cm-finding-high'), 'finding line is marked in the editor'));
  fireEvent.change(screen.getByLabelText('選擇審閱'), { target: { value: 'r2' } });
  await waitFor(() => assert.ok(screen.getByText('AI 發現的問題（0）')));
  assert.equal(screen.queryByTestId('findings-handle'), null);
});
