import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import type * as CustomToolsModule from '@/shared/customTools';
import {
  aiContext, applyStep, buildBrief, decToString, evaluateFormula, normalizeDate, parseBenchData, parseNumber, parsePaste,
  parseStep, replaySteps, toCsv, toTable,
} from '@/modules/tool-library/tools/sheetModel';
import type { Step, Table } from '@/modules/tool-library/tools/sheetModel';

/**
 * DHC CLI 10/14 試算工作台: exact decimals, the formula language, every step, paste/CSV, and a render smoke.
 */

const aiAnswer = vi.hoisted(() => ({ value: { reply: '', result: null as unknown } }));
vi.mock('@/shared/customTools', async (importOriginal) => ({
  ...(await importOriginal<typeof CustomToolsModule>()),
  askToolAssist: async () => aiAnswer.value,
  loadToolData: async () => null,
  createToolSaver: () => ({ save: () => {}, flush: async () => {} }),
}));

const { default: SheetBench } = await import('@/modules/tool-library/tools/SheetBench');

window.HTMLElement.prototype.scrollIntoView = () => {};

Element.prototype.scrollIntoView = () => {};
afterEach(() => { localStorage.clear(); });

const t = (columns: string[], rows: string[][]): Table => ({ columns, rows });
const run = (table: Table, step: unknown) => applyStep(table, parseStep(step));
const f = (formula: string, columns: string[] = [], row: string[] = []) => evaluateFormula(formula, columns, row);

test('decimals are exact where floating point is not', () => {
  assert.equal(f('0.1+0.2'), '0.3');
  assert.equal(f('1.1*1.1'), '1.21');
  assert.equal(f('0.3-0.1'), '0.2');
  assert.equal(f('19.99*3'), '59.97');
  assert.equal(f('1/3'), '0.333333333333');
  assert.equal(f('2/3'), '0.666666666667');
  assert.equal(f('10/4'), '2.5');
  assert.equal(f('-5/2'), '-2.5');
  assert.equal(f('123456789012345678*10'), '1234567890123456780');
  assert.equal(f('1.005*1000'), '1005');
});

test('round is half away from zero and exact', () => {
  assert.equal(f('round(1.005,2)'), '1.01');
  assert.equal(f('round(2.675,2)'), '2.68');
  assert.equal(f('round(-2.5,0)'), '-3');
  assert.equal(f('round(-1.005,2)'), '-1.01');
  assert.equal(f('round(0.4,0)'), '0');
  assert.equal(f('round(-0.4,0)'), '0');
  assert.equal(f('round(1234.5678,2)'), '1234.57');
  assert.equal(f('round(5,2)'), '5');
  assert.equal(f('round(10/3,2)'), '3.33');
});

test('precedence, unary minus, parentheses and column references', () => {
  assert.equal(f('1+2*3'), '7');
  assert.equal(f('(1+2)*3'), '9');
  assert.equal(f('-2*-3'), '6');
  assert.equal(f('10-2-3'), '5');
  assert.equal(f('[價]*[量]', ['價', '量'], ['1,234.50', '2']), '2469');
  assert.equal(f('[成交 金額]/100', ['成交 金額'], ['(500)']), '-5');
});

test('empty cells make arithmetic empty unless coalesce is used', () => {
  assert.equal(f('[a]+[b]', ['a', 'b'], ['', '3']), '');
  assert.equal(f('coalesce([a],0)+[b]', ['a', 'b'], ['', '3']), '3');
  assert.equal(f('if(isblank([a]),"空","有")', ['a'], ['']), '空');
  assert.equal(f('-[a]', ['a'], ['']), '');
});

test('conditions, text and comparison rules', () => {
  const cols = ['代號', '數量', '日期'];
  assert.equal(f('[代號]="0050"', cols, ['0050', '1', '']), 'TRUE');
  assert.equal(f('[代號]="50"', cols, ['0050', '1', '']), 'FALSE', 'codes compare as written');
  assert.equal(f('[數量]=1.0', cols, ['0050', '1', '']), 'TRUE');
  assert.equal(f('[數量]>=10', cols, ['0050', '9', '']), 'FALSE');
  assert.equal(f('[數量]>=10', cols, ['0050', '10', '']), 'TRUE');
  assert.equal(f('[日期]>="2024-01-01"', cols, ['', '', '2024-03-01']), 'TRUE');
  assert.equal(f('[數量]>1 and [數量]<5', cols, ['', '3', '']), 'TRUE');
  assert.equal(f('or([數量]<1,[數量]>5)', cols, ['', '3', '']), 'FALSE');
  assert.equal(f('not([數量]=3)', cols, ['', '3', '']), 'FALSE');
  assert.equal(f('if([數量]>2,[數量]*2,0)', cols, ['', '3', '']), '6');
  assert.equal(f('concat([代號],"-",[數量])', cols, ['0050', '3', '']), '0050-3');
  assert.equal(f('max(1,5,3)'), '5');
  assert.equal(f('min(1.5,0.5)'), '0.5');
  assert.equal(f('abs(-3.20)'), '3.2');
});

test('bad formulas fail with a message, never evaluate code', () => {
  const cols = ['a'];
  assert.throws(() => f('[b]+1', cols, ['1']), /找不到欄位/);
  assert.throws(() => f('1+', cols, ['1']), /結束/);
  assert.throws(() => f('(1+2', cols, ['1']), /右括號/);
  assert.throws(() => f('foo(1)', cols, ['1']), /不認得/);
  assert.throws(() => f('round(1)', cols, ['1']), /參數/);
  assert.throws(() => f('1/0'), /除以零/);
  assert.throws(() => f('[a]+1', cols, ['abc']), /不是數字/);
  assert.throws(() => f('process.exit()', cols, ['1']));
  assert.throws(() => f('1; 2', cols, ['1']));
});

test('parseNumber accepts spreadsheet-style numbers and nothing else', () => {
  assert.equal(decToString(parseNumber('1,234.50')!), '1234.5');
  assert.equal(decToString(parseNumber(' (1,200) ')!), '-1200');
  assert.equal(decToString(parseNumber('+3')!), '3');
  assert.equal(decToString(parseNumber('.5')!), '0.5');
  assert.equal(decToString(parseNumber('-0.00')!), '0');
  for (const bad of ['', ' ', '12%', '1e5', '12abc', '2024-01-01', '--1', '1.2.3']) assert.equal(parseNumber(bad), null, bad);
});

test('paste: TSV with quotes, CSV, BOM, padding and trailing blank lines', () => {
  const tsv = parsePaste('名稱\t金額\r\n"a\tb"\t"1,000"\r\n"he said ""hi"""\t2\r\n\r\n');
  assert.equal(tsv.delimiter, 'tab');
  assert.deepEqual(tsv.raw, [['名稱', '金額'], ['a\tb', '1,000'], ['he said "hi"', '2']]);
  const csv = parsePaste('﻿a,b,c\n1,"x,y"\n');
  assert.equal(csv.delimiter, 'comma');
  assert.deepEqual(csv.raw, [['a', 'b', 'c'], ['1', 'x,y', '']]);
  const multi = parsePaste('a\tb\n"line1\nline2"\tz');
  assert.deepEqual(multi.raw[1], ['line1\nline2', 'z']);
});

test('paste caps rows and columns and says so', () => {
  const big = Array.from({ length: 2105 }, (_, i) => `${i}\tx`).join('\n');
  const grid = parsePaste(big);
  assert.equal(grid.raw.length, 2001);
  assert.equal(grid.truncated, true);
  const wide = parsePaste(Array.from({ length: 60 }, (_, i) => `c${i}`).join('\t'));
  assert.equal(wide.raw[0].length, 50);
  assert.equal(wide.truncated, true);
});

test('toTable names columns: header on, off, empty and repeated names', () => {
  assert.deepEqual(toTable([['a', '', 'a'], ['1', '2', '3']], true), { columns: ['a', '欄2', 'a_2'], rows: [['1', '2', '3']] });
  assert.deepEqual(toTable([['x', 'y']], false), { columns: ['欄1', '欄2'], rows: [['x', 'y']] });
});

test('CSV quotes what needs it and round-trips through the parser', () => {
  const table = t(['名稱', '備註'], [['a,b', 'say "hi"'], ['line\nbreak', '']]);
  const csv = toCsv(table);
  assert.equal(csv, '名稱,備註\r\n"a,b","say ""hi"""\r\n"line\nbreak",');
  assert.deepEqual(parsePaste(csv).raw, [table.columns, ...table.rows]);
});

test('trim, fill_empty, rename, drop_column, add_column', () => {
  let table = t(['a', 'b'], [[' x ', ''], ['y', ' 2 ']]);
  table = run(table, { op: 'trim' }).table;
  assert.deepEqual(table.rows, [['x', ''], ['y', '2']]);
  const filled = run(table, { op: 'fill_empty', column: 'b', value: 0 });
  assert.deepEqual(filled.table.rows, [['x', '0'], ['y', '2']]);
  assert.equal(filled.note, '補了 1 格');
  table = run(filled.table, { op: 'rename_column', from: 'a', to: 'name' }).table;
  assert.deepEqual(table.columns, ['name', 'b']);
  assert.throws(() => run(table, { op: 'rename_column', from: 'name', to: 'b' }), /已經有欄位/);
  const added = run(table, { op: 'add_column', name: 'c', formula: '[b]*1.1' });
  assert.deepEqual(added.table.rows, [['x', '0', '0'], ['y', '2', '2.2']]);
  assert.deepEqual(run(added.table, { op: 'drop_column', column: 'b' }).table.columns, ['name', 'c']);
});

test('add_column leaves unusable rows empty and counts them', () => {
  const table = t(['a'], [['1'], ['abc'], ['']]);
  const out = run(table, { op: 'add_column', name: 'b', formula: '[a]+1' });
  assert.deepEqual(out.table.rows, [['1', '2'], ['abc', ''], ['', '']]);
  assert.match(out.note, /1 列算不出來/);
});

test('drop_rows and filter', () => {
  const table = t(['side', 'qty'], [['B', '10'], ['S', '5'], ['B', ''], ['X', 'n/a']]);
  assert.deepEqual(run(table, { op: 'filter', where: '[side]="B"' }).table.rows, [['B', '10'], ['B', '']]);
  assert.deepEqual(run(table, { op: 'drop_rows', where: 'isblank([qty])' }).table.rows, [['B', '10'], ['S', '5'], ['X', 'n/a']]);
  const bad = run(table, { op: 'filter', where: '[qty]>=5' });
  assert.deepEqual(bad.table.rows.map((r) => r[1]), ['10', '5'], 'blank and text rows are not kept');
});

test('convert_type number and date, with failures reported and left as is', () => {
  const table = t(['v'], [['1,000.50'], ['(20)'], [''], ['abc']]);
  const num = run(table, { op: 'convert_type', column: 'v', to: 'number' });
  assert.deepEqual(num.table.rows.map((r) => r[0]), ['1000.5', '-20', '', 'abc']);
  assert.match(num.note, /1 格轉不了/);
  const dates = t(['d'], [['2024/5/6'], ['20240506'], ['113/05/06'], ['1130506'], ['2024-02-30'], ['2024-05-06 10:00:00']]);
  const out = run(dates, { op: 'convert_type', column: 'd', to: 'date' });
  assert.deepEqual(out.table.rows.map((r) => r[0]), ['2024-05-06', '2024-05-06', '2024-05-06', '2024-05-06', '2024-02-30', '2024-05-06']);
  assert.equal(normalizeDate('2023-02-29'), null);
  assert.equal(normalizeDate('2024-02-29'), '2024-02-29');
});

test('dedupe keeps the first row, on all columns or chosen ones', () => {
  const table = t(['k', 'v'], [['a', '1'], ['a', '1'], ['a', '2'], ['b', '1']]);
  assert.deepEqual(run(table, { op: 'dedupe' }).table.rows, [['a', '1'], ['a', '2'], ['b', '1']]);
  assert.deepEqual(run(table, { op: 'dedupe', columns: ['k'] }).table.rows, [['a', '1'], ['b', '1']]);
});

test('sort: numbers by value, text by text, blanks last, stable', () => {
  const table = t(['n', 'tag'], [['10', 'x'], ['9', 'y'], ['', 'z'], ['9', 'w'], ['-1', 'v']]);
  assert.deepEqual(run(table, { op: 'sort', column: 'n', order: 'asc' }).table.rows.map((r) => r[1]), ['v', 'y', 'w', 'x', 'z']);
  assert.deepEqual(run(table, { op: 'sort', column: 'n', order: 'desc' }).table.rows.map((r) => r[1]), ['x', 'y', 'w', 'v', 'z']);
  const text = run(table, { op: 'sort', column: 'tag', order: 'asc' });
  assert.deepEqual(text.table.rows.map((r) => r[1]), ['v', 'w', 'x', 'y', 'z']);
  assert.equal(text.note, '這欄不全是數字，依文字排序');
});

test('group_by sums exactly, counts, averages, min/max, and skips blanks and text', () => {
  const table = t(['客戶', '金額'], [['A', '0.1'], ['B', '5'], ['A', '0.2'], ['A', ''], ['B', 'x'], ['A', '1,000.05']]);
  const out = run(table, {
    op: 'group_by',
    by: ['客戶'],
    aggs: [
      { fn: 'sum', column: '金額' },
      { fn: 'count' },
      { fn: 'count', column: '金額', as: 'n' },
      { fn: 'avg', column: '金額', as: 'avg' },
      { fn: 'min', column: '金額', as: 'lo' },
      { fn: 'max', column: '金額', as: 'hi' },
    ],
  });
  assert.deepEqual(out.table.columns, ['客戶', 'sum_金額', 'count_rows', 'n', 'avg', 'lo', 'hi']);
  assert.deepEqual(out.table.rows, [
    ['A', '1000.35', '4', '3', '333.45', '0.1', '1000.05'],
    ['B', '5', '2', '2', '5', '5', '5'],
  ]);
  assert.match(out.note, /1 格不是數字/);
  assert.equal(run(t(['k', 'v'], [['a', '']]), { op: 'group_by', by: ['k'], aggs: [{ fn: 'sum', column: 'v' }] }).table.rows[0][1], '0');
  // Sums of many cents never drift.
  const cents = t(['v'], Array.from({ length: 1000 }, () => ['0.1']));
  assert.equal(run(cents, { op: 'group_by', by: ['v'], aggs: [{ fn: 'count', as: 'n' }, { fn: 'sum', column: 'v' }] }).table.rows[0][2], '100');
});

test('set_cell and replay: a recorded list of steps rebuilds the same table', () => {
  const base = t(['k', 'v'], [['a', '1'], ['b', '2']]);
  const steps: Step[] = [
    parseStep({ op: 'set_cell', row: 2, column: 'v', value: '5' }),
    parseStep({ op: 'add_column', name: 'w', formula: '[v]*2' }),
    parseStep({ op: 'sort', column: 'w', order: 'desc' }),
  ];
  const full = replaySteps(base, steps);
  assert.equal(full.failedAt, null);
  assert.deepEqual(full.table.rows, [['b', '5', '10'], ['a', '1', '2']]);
  assert.deepEqual(replaySteps(base, steps.slice(0, -1)).table.rows, [['a', '1', '2'], ['b', '5', '10']], 'undo = one step fewer');
  assert.deepEqual(base.rows, [['a', '1'], ['b', '2']], 'the base is never changed');
  assert.equal(replaySteps(base, [{ op: 'drop_column', column: 'zzz' }]).failedAt, 0);
});

test('parseStep rejects what the AI should not send', () => {
  assert.throws(() => parseStep({ op: 'run_js', code: '1' }), /不支援/);
  assert.throws(() => parseStep({ op: 'convert_type', column: 'a', to: 'text' }), /number 或 date/);
  assert.throws(() => parseStep({ op: 'group_by', by: ['a'], aggs: [{ fn: 'median', column: 'b' }] }), /fn 只能/);
  assert.throws(() => parseStep({ op: 'group_by', by: ['a'], aggs: [{ fn: 'sum' }] }), /column/);
  assert.throws(() => parseStep({ op: 'filter' }), /where/);
  assert.throws(() => parseStep(null), /格式/);
  assert.throws(() => run(t(['a'], [['1']]), { op: 'sort', column: 'nope', order: 'asc' }), /找不到欄位/);
});

test('stored data is parsed defensively', () => {
  const data = parseBenchData({ sheets: [{ raw: [['a'], [1, null]], steps: [{ op: 'trim' }, { op: 'bogus' }, { op: 'dedupe' }] }], activeId: 'nope', chat: [{ role: 'user', text: 'x' }, 5] });
  assert.equal(data.sheets.length, 1);
  assert.deepEqual(data.sheets[0].raw, [['a'], ['1', '']]);
  assert.equal(data.sheets[0].steps.length, 1, 'stops at the first bad step');
  assert.equal(data.activeId, data.sheets[0].id);
  assert.equal(data.sheets[0].chat.length, 1, 'an old bench-wide chat goes to the open sheet');
  assert.equal(parseBenchData(null).sheets.length, 1);
});

test('the AI context is a sample plus stats, never the whole table, and stays under the budget', () => {
  const rows = Array.from({ length: 1500 }, (_, i) => Array.from({ length: 40 }, (_, c) => `${'v'.repeat(50)}${i}-${c}`));
  const table = t(Array.from({ length: 40 }, (_, c) => `col${c}`), rows);
  const ctx = aiContext('big', table, [{ op: 'trim' }]);
  assert.equal(ctx.rowCount, 1500);
  assert.ok(ctx.sampleRows.length < 1500 && ctx.sampleRows.length >= 5);
  assert.ok(JSON.stringify(ctx).length <= 80_000);
  assert.match(ctx.sampleNote, /共 1500 列/);
  const small = aiContext('s', t(['n', 'd', 'x'], [['1.50', '2024-01-02', 'a'], ['3', '2024-01-03', 'b']]), []);
  assert.deepEqual(small.columns.map((c) => c.type), ['number', 'date', 'text']);
  assert.equal(small.columns[0].max, '3');
});

test('the 開工 brief carries the source, columns, steps and asks for Node.js', () => {
  const base = t(['a', 'b'], [['1', '2']]);
  const steps: Step[] = [{ op: 'add_column', name: 'c', formula: '[a]+[b]' }];
  const brief = buildBrief('表一', '從 Excel 貼上', base, steps, replaySteps(base, steps).table);
  assert.match(brief, /Node\.js/);
  assert.match(brief, /不要用 Python/);
  assert.match(brief, /a、b/);
  assert.match(brief, /新增欄位「c」/);
  assert.match(brief, /"op":"add_column"/);
});

test('render: paste a table, sort by a header, undo, edit a cell', async () => {
  render(<SheetBench profileId="p1" profileName="同事A" isMobile={false} onClose={() => {}} onStartWork={null} />);
  const box = await waitFor(() => screen.getByLabelText('貼上表格'));
  fireEvent.change(box, { target: { value: '客戶\t金額\nA\t10\nB\t9\nC\t11' } });
  fireEvent.click(screen.getByRole('button', { name: '轉成表格' }));
  await waitFor(() => assert.ok(screen.getByText('3 列 × 2 欄')));

  fireEvent.click(screen.getByRole('button', { name: /^金額/ }));
  assert.ok(screen.getByText('依「金額」由小到大排序'));
  assert.equal(document.querySelectorAll('tbody tr')[0].querySelectorAll('td')[1].textContent, 'B');

  fireEvent.click(screen.getByRole('button', { name: /復原最後一步/ }));
  assert.equal(screen.queryByText('依「金額」由小到大排序'), null);
  assert.equal(document.querySelectorAll('tbody tr')[0].querySelectorAll('td')[1].textContent, 'A');

  fireEvent.click(document.querySelectorAll('tbody tr')[0].querySelectorAll('td')[2]);
  const input = screen.getByLabelText('金額 第 1 列');
  fireEvent.change(input, { target: { value: '99' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  assert.ok(screen.getByText('第 1 列「金額」改成「99」'));
  assert.equal(document.querySelectorAll('tbody tr')[0].querySelectorAll('td')[2].textContent, '99');
});

test('handoff: a table becomes a GFM table (pipes escaped, 200-row cap) or a 15-row slide', async () => {
  const { tableToMarkdown, sheetToDocHandoff, sheetToSlideHandoff } = await import('@/modules/tool-library/tools/handoffModel');
  const small: Table = { columns: ['名稱', '備註'], rows: [['a|b', 'x\ny'], ['c', '']] };
  assert.equal(tableToMarkdown(small, 200).markdown, '| 名稱 | 備註 |\n| --- | --- |\n| a\\|b | x y |\n| c |   |');
  const big: Table = { columns: ['n'], rows: Array.from({ length: 250 }, (_, i) => [String(i)]) };
  const doc = sheetToDocHandoff('部位', big);
  const md = (doc.payload as { markdown: string }).markdown;
  assert.equal(doc.tool, 'doc-editor');
  assert.equal(doc.kind, 'markdown-insert');
  assert.equal(doc.from, "試算工作台『部位』");
  assert.equal(md.split('\n').filter((l) => /^\| \d+ \|$/.test(l)).length, 200);
  assert.ok(md.endsWith('（共 250 列，只放前 200 列）'));
  const slide = sheetToSlideHandoff('部位', big);
  const sm = (slide.payload as { markdown: string }).markdown;
  assert.ok(sm.startsWith('## 部位\n\n| n |'));
  assert.equal(sm.split('\n').filter((l) => /^\| \d+ \|$/.test(l)).length, 15);
  assert.equal(slide.kind, 'markdown-slides');
});

test('an AI 彙總 lands on a new sheet built from the table so far, and the detail rows stay', async () => {
  aiAnswer.value = { reply: '好', result: { steps: [
    { op: 'fill_empty', column: '金額', value: '0' },
    { op: 'group_by', by: ['客戶'], aggs: [{ fn: 'sum', column: '金額', as: '合計' }] },
  ] } };
  render(<SheetBench profileId="p1" profileName="同事A" isMobile={false} onClose={() => {}} onStartWork={null} />);
  const box = await waitFor(() => screen.getByLabelText('貼上表格'));
  fireEvent.change(box, { target: { value: '客戶\t金額\nA\t10.1\nA\t\nB\t0.2' } });
  fireEvent.click(screen.getByRole('button', { name: '轉成表格' }));
  await waitFor(() => assert.ok(screen.getByText('3 列 × 2 欄')));
  fireEvent.change(screen.getByRole('textbox', { name: '跟 AI 說' }), { target: { value: '依客戶加總' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: '跟 AI 說' }), { key: 'Enter' });
  await waitFor(() => assert.ok(screen.getByText(/彙總放在新的工作表/)));
  const picker = screen.getAllByRole('combobox')[0] as HTMLSelectElement;
  assert.match(picker.selectedOptions[0].textContent ?? '', /-彙總$/);
  const cells = [...document.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].slice(1).map((cell) => cell.textContent));
  assert.deepEqual(cells, [['A', '10.1'], ['B', '0.2']]);
  fireEvent.change(picker, { target: { value: picker.options[0].value } });
  await waitFor(() => assert.equal(document.querySelectorAll('tbody tr').length, 3, 'detail rows kept on the first sheet'));
});

test('each sheet keeps its own AI chat, and number columns are recognised', async () => {
  const { numericColumns } = await import('@/modules/tool-library/tools/sheetModel');
  assert.deepEqual(numericColumns(t(['名稱', '價格', '日期'], [['A', '101.6', '2026-10-01'], ['B', '-7.56', '2026-10-02'], ['C', '', '']])), [false, true, false]);
  const data = parseBenchData({ sheets: [{ id: 'a', raw: [['x']], chat: [{ role: 'user', text: '第一張' }] }, { id: 'b', raw: [['y']] }], activeId: 'b' });
  assert.deepEqual(data.sheets.map((sheet) => sheet.chat.length), [1, 0]);
});
