/**
 * DHC CLI 10/14 試算工作台: the table model behind the page. Everything here is pure and deterministic:
 * parsing a paste, exact decimal arithmetic (BigInt, no floating point), a tiny formula language (no eval), the
 * fixed set of steps the AI may ask for, and CSV. The AI never returns the table, only steps; the page runs them
 * with applyStep, and a sheet is always "pasted data + recorded steps" so undo is just replaying one step less.
 */

export const MAX_ROWS = 2000;
export const MAX_COLS = 50;
export const MAX_STEPS = 200;

export type Table = { columns: string[]; rows: string[][] };

// ---------------------------------------------------------------------------------------------------------------
// Paste / CSV

/** Splits delimited text into a grid, honouring "quoted, cells" with "" escapes and line breaks inside quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const grid: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let atCellStart = true;
  const endCell = () => { row.push(cell); cell = ''; atCellStart = true; };
  const endRow = () => { endCell(); grid.push(row); row = []; };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && atCellStart) {
      quoted = true;
      atCellStart = false;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
    } else if (ch === '\n') {
      endRow();
    } else {
      cell += ch;
      atCellStart = false;
    }
  }
  if (cell !== '' || row.length > 0) endRow();
  return grid;
}

export type PastedGrid = { raw: string[][]; truncated: boolean; delimiter: 'tab' | 'comma' };

/** Excel puts TSV on the clipboard; a text with no tab is read as CSV. Rows are padded to one width and capped. */
export function parsePaste(text: string): PastedGrid {
  const clean = text.replace(/^﻿/, '');
  const delimiter = clean.includes('\t') ? 'tab' : 'comma';
  let grid = parseDelimited(clean, delimiter === 'tab' ? '\t' : ',');
  while (grid.length > 0 && grid[grid.length - 1].every((cell) => cell === '')) grid.pop();
  const width = Math.min(MAX_COLS, grid.reduce((max, row) => Math.max(max, row.length), 0));
  const truncated = grid.length > MAX_ROWS + 1 || grid.some((row) => row.length > MAX_COLS);
  grid = grid.slice(0, MAX_ROWS + 1).map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
  return { raw: grid, truncated, delimiter };
}

/** Header names: empty ones become 欄N, repeated ones get _2, _3 so every column can be addressed by name. */
export function columnNames(headerCells: string[]): string[] {
  const seen = new Map<string, number>();
  return headerCells.map((cell, index) => {
    const base = cell.trim() || `欄${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

/** The pasted grid as a table: the first row is the header, or the columns are named 欄1, 欄2… */
export function toTable(raw: string[][], header: boolean): Table {
  const width = raw.reduce((max, row) => Math.max(max, row.length), 0);
  if (header && raw.length > 0) {
    return { columns: columnNames(Array.from({ length: width }, (_, i) => raw[0][i] ?? '')), rows: raw.slice(1).map((row) => [...row]) };
  }
  return { columns: columnNames(Array.from({ length: width }, () => '')), rows: raw.map((row) => [...row]) };
}

const csvCell = (cell: string) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

/** CSV text (CRLF); the download adds the UTF-8 BOM so Excel reads 中文 correctly. */
export function toCsv(table: Table): string {
  return [table.columns, ...table.rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Exact decimals

/** value = n / 10^s, s >= 0. */
export type Dec = { n: bigint; s: number };

const pow10 = (k: number) => 10n ** BigInt(k);
const DIV_DIGITS = 12;

const normDec = (d: Dec): Dec => {
  let { n, s } = d;
  while (s > 0 && n % 10n === 0n) { n /= 10n; s -= 1; }
  return { n, s };
};
const align = (a: Dec, b: Dec): [bigint, bigint, number] => {
  const s = Math.max(a.s, b.s);
  return [a.n * pow10(s - a.s), b.n * pow10(s - b.s), s];
};
export const decAdd = (a: Dec, b: Dec): Dec => { const [x, y, s] = align(a, b); return normDec({ n: x + y, s }); };
export const decSub = (a: Dec, b: Dec): Dec => { const [x, y, s] = align(a, b); return normDec({ n: x - y, s }); };
export const decMul = (a: Dec, b: Dec): Dec => normDec({ n: a.n * b.n, s: a.s + b.s });
export const decCmp = (a: Dec, b: Dec): number => { const [x, y] = align(a, b); return x < y ? -1 : x > y ? 1 : 0; };
export const decNeg = (a: Dec): Dec => ({ n: -a.n, s: a.s });
export const decAbs = (a: Dec): Dec => ({ n: a.n < 0n ? -a.n : a.n, s: a.s });

/** Rounds half away from zero to `digits` decimals (the usual spreadsheet ROUND). */
export function decRound(a: Dec, digits: number): Dec {
  if (a.s <= digits) return normDec(a);
  const unit = pow10(a.s - digits);
  let q = a.n / unit;
  const r = a.n % unit;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= unit) q += a.n < 0n ? -1n : 1n;
  return normDec({ n: q, s: digits });
}

/** a / b to 12 decimals (rounded), so 1/3 is 0.333333333333; never used for sums or products. */
export function decDiv(a: Dec, b: Dec): Dec {
  if (b.n === 0n) throw new Error('除以零');
  // a/b = (a.n * 10^b.s) / (b.n * 10^a.s); scale by 10^(DIV_DIGITS+1) then round to DIV_DIGITS.
  const num = a.n * pow10(b.s + DIV_DIGITS + 1);
  const den = b.n * pow10(a.s);
  return decRound({ n: num / den, s: DIV_DIGITS + 1 }, DIV_DIGITS);
}

export function decToString(d: Dec): string {
  const x = normDec(d);
  const negative = x.n < 0n;
  let digits = (negative ? -x.n : x.n).toString();
  if (x.s > 0) {
    digits = digits.padStart(x.s + 1, '0');
    digits = `${digits.slice(0, -x.s)}.${digits.slice(-x.s)}`;
  }
  return negative && /[1-9]/.test(digits) ? `-${digits}` : digits;
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/**
 * Reads a cell as a number: 1,234.50 / -3 / (1,200) = -1200 / spaces and a leading + are fine. Not numbers:
 * empty text, 12%, 1e5, 12abc, dates. Returns null for those.
 */
/** A column reads as numbers when most of its filled cells (in the first 200 rows) are numbers. */
export function numericColumns(table: Table): boolean[] {
  return table.columns.map((_, c) => {
    let filled = 0;
    let numbers = 0;
    for (const row of table.rows.slice(0, 200)) {
      const cell = (row[c] ?? '').trim();
      if (!cell) continue;
      filled += 1;
      if (parseNumber(cell) !== null) numbers += 1;
    }
    return filled > 0 && numbers / filled >= 0.8;
  });
}

export function parseNumber(text: string): Dec | null {
  let t = text.trim().replace(/,/g, '');
  let negate = false;
  const paren = /^\((.*)\)$/.exec(t);
  if (paren) { t = paren[1].trim(); negate = true; }
  if (!NUMBER_RE.test(t)) return null;
  const sign = t.startsWith('-') ? -1n : 1n;
  const body = t.replace(/^[+-]/, '');
  const [whole, frac = ''] = body.split('.');
  const n = BigInt((whole || '0') + frac) * sign;
  return normDec({ n: negate ? -n : n, s: frac.length });
}

// ---------------------------------------------------------------------------------------------------------------
// Formula language: [欄名], numbers, "text", + - * /, comparisons (= <> < <= > >=), and / or / not, and functions
// round(x,n) if(c,a,b) abs min max coalesce concat isblank. Blank cells make arithmetic blank (use coalesce).

type Value = Dec | string | boolean | null;

type Node =
  | { t: 'num'; v: Dec }
  | { t: 'str'; v: string }
  | { t: 'col'; name: string; index: number }
  | { t: 'neg'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[] };

type Token = { k: 'num' | 'str' | 'col' | 'id' | 'op' | 'end'; v: string };

const isDec = (v: Value): v is Dec => typeof v === 'object' && v !== null;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '[') {
      const end = src.indexOf(']', i);
      if (end < 0) throw new Error('欄位括號 [ 沒有結尾');
      out.push({ k: 'col', v: src.slice(i + 1, end) });
      i = end + 1;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== ch) { text += src[j]; j += 1; }
      if (j >= src.length) throw new Error('文字引號沒有結尾');
      out.push({ k: 'str', v: text });
      i = j + 1;
    } else if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const text = src.slice(i, j);
      if (!NUMBER_RE.test(text)) throw new Error(`數字格式不對：${text}`);
      out.push({ k: 'num', v: text });
      i = j;
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      out.push({ k: 'id', v: src.slice(i, j).toLowerCase() });
      i = j;
    } else {
      const two = src.slice(i, i + 2);
      if (['<>', '<=', '>=', '!=', '=='].includes(two)) {
        out.push({ k: 'op', v: two === '!=' ? '<>' : two === '==' ? '=' : two });
        i += 2;
      } else if ('+-*/(),<>='.includes(ch)) {
        out.push({ k: 'op', v: ch });
        i += 1;
      } else {
        throw new Error(`看不懂的符號：${ch}`);
      }
    }
  }
  out.push({ k: 'end', v: '' });
  return out;
}

const FUNCTIONS: Record<string, [number, number]> = {
  round: [2, 2], if: [3, 3], abs: [1, 1], min: [1, 20], max: [1, 20], coalesce: [1, 20], concat: [1, 20],
  and: [1, 20], or: [1, 20], not: [1, 1], isblank: [1, 1],
};

/** Parses a formula against the table's column names; throws a readable error for anything unknown. */
export function parseFormula(src: string, columns: string[]): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const isOp = (v: string) => peek().k === 'op' && peek().v === v;
  const isWord = (v: string) => peek().k === 'id' && peek().v === v;

  const orExpr = (): Node => {
    let a = andExpr();
    while (isWord('or')) { take(); a = { t: 'call', fn: 'or', args: [a, andExpr()] }; }
    return a;
  };
  const andExpr = (): Node => {
    let a = notExpr();
    while (isWord('and')) { take(); a = { t: 'call', fn: 'and', args: [a, notExpr()] }; }
    return a;
  };
  const notExpr = (): Node => {
    if (isWord('not')) { take(); return { t: 'call', fn: 'not', args: [notExpr()] }; }
    return cmpExpr();
  };
  const cmpExpr = (): Node => {
    const a = addExpr();
    if (peek().k === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(peek().v)) {
      const op = take().v;
      return { t: 'bin', op, a, b: addExpr() };
    }
    return a;
  };
  const addExpr = (): Node => {
    let a = mulExpr();
    while (isOp('+') || isOp('-')) { const op = take().v; a = { t: 'bin', op, a, b: mulExpr() }; }
    return a;
  };
  const mulExpr = (): Node => {
    let a = unary();
    while (isOp('*') || isOp('/')) { const op = take().v; a = { t: 'bin', op, a, b: unary() }; }
    return a;
  };
  const unary = (): Node => {
    if (isOp('-')) { take(); return { t: 'neg', a: unary() }; }
    if (isOp('+')) { take(); return unary(); }
    return primary();
  };
  const primary = (): Node => {
    const tok = take();
    if (tok.k === 'num') return { t: 'num', v: parseNumber(tok.v) as Dec };
    if (tok.k === 'str') return { t: 'str', v: tok.v };
    if (tok.k === 'col') {
      const index = columns.indexOf(tok.v);
      if (index < 0) throw new Error(`找不到欄位「${tok.v}」`);
      return { t: 'col', name: tok.v, index };
    }
    if (tok.k === 'op' && tok.v === '(') {
      const inner = orExpr();
      if (!isOp(')')) throw new Error('缺少右括號 )');
      take();
      return inner;
    }
    if (tok.k === 'id') {
      const spec = FUNCTIONS[tok.v];
      if (!spec) throw new Error(`不認得的函數：${tok.v}`);
      if (!isOp('(')) throw new Error(`函數 ${tok.v} 後面要接括號`);
      take();
      const args: Node[] = [];
      if (!isOp(')')) {
        args.push(orExpr());
        while (isOp(',')) { take(); args.push(orExpr()); }
      }
      if (!isOp(')')) throw new Error('缺少右括號 )');
      take();
      if (args.length < spec[0] || args.length > spec[1]) throw new Error(`函數 ${tok.v} 的參數數量不對`);
      return { t: 'call', fn: tok.v, args };
    }
    throw new Error(tok.k === 'end' ? '公式寫到一半就結束了' : `公式裡有多餘的 ${tok.v}`);
  };

  const tree = orExpr();
  if (peek().k !== 'end') throw new Error(`公式裡有多餘的 ${peek().v}`);
  return tree;
}

const cellValue = (text: string): Value => (text === '' ? null : parseNumber(text) ?? text);

const asNumber = (v: Value): Dec | null => {
  if (v === null) return null;
  if (isDec(v)) return v;
  if (typeof v === 'string') {
    const d = parseNumber(v);
    if (d) return d;
  }
  throw new Error(`「${String(v)}」不是數字`);
};
const asText = (v: Value, raw?: string): string => (raw !== undefined ? raw : v === null ? '' : isDec(v) ? decToString(v) : String(v));
const truthy = (v: Value): boolean => {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  throw new Error('條件不是真假值');
};

/** Text a column-reference node would show (keeps 00123 as written when compared with text). */
const rawOf = (node: Node, row: string[]): string | undefined => (node.t === 'col' ? row[node.index] ?? '' : node.t === 'str' ? node.v : undefined);

function compare(op: string, a: Value, b: Value, ra: string | undefined, rb: string | undefined): boolean {
  const bothNumberCells = isDec(a) && isDec(b);
  if (op === '=' || op === '<>') {
    const same = bothNumberCells
      ? decCmp(a, b) === 0
      : typeof a === 'boolean' || typeof b === 'boolean' ? a === b : asText(a, ra) === asText(b, rb);
    return op === '=' ? same : !same;
  }
  // Ordering with a blank is never true; a number against non-numeric text cannot be ordered.
  if (a === null || b === null) return false;
  const da = isDec(a) ? a : typeof a === 'string' ? parseNumber(a) : null;
  const db = isDec(b) ? b : typeof b === 'string' ? parseNumber(b) : null;
  if ((isDec(a) && !db) || (isDec(b) && !da)) throw new Error('數字和文字無法比大小');
  let c: number;
  if (da && db) c = decCmp(da, db);
  else {
    const x = asText(a, ra);
    const y = asText(b, rb);
    c = x < y ? -1 : x > y ? 1 : 0;
  }
  return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
}

function evalNode(node: Node, row: string[]): Value {
  switch (node.t) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'col': return cellValue(row[node.index] ?? '');
    case 'neg': { const v = asNumber(evalNode(node.a, row)); return v ? decNeg(v) : null; }
    case 'bin': {
      const a = evalNode(node.a, row);
      const b = evalNode(node.b, row);
      if (['=', '<>', '<', '<=', '>', '>='].includes(node.op)) return compare(node.op, a, b, rawOf(node.a, row), rawOf(node.b, row));
      const x = asNumber(a);
      const y = asNumber(b);
      if (!x || !y) return null;
      if (node.op === '+') return decAdd(x, y);
      if (node.op === '-') return decSub(x, y);
      if (node.op === '*') return decMul(x, y);
      return decDiv(x, y);
    }
    case 'call': return evalCall(node, row);
    default: return null;
  }
}

function evalCall(node: Extract<Node, { t: 'call' }>, row: string[]): Value {
  const { fn, args } = node;
  // if/and/or evaluate lazily so the untaken branch can fail without breaking the row.
  if (fn === 'if') return truthy(evalNode(args[0], row)) ? evalNode(args[1], row) : evalNode(args[2], row);
  if (fn === 'and') { for (const a of args) if (!truthy(evalNode(a, row))) return false; return true; }
  if (fn === 'or') { for (const a of args) if (truthy(evalNode(a, row))) return true; return false; }
  const values = args.map((a) => evalNode(a, row));
  switch (fn) {
    case 'not': return !truthy(values[0]);
    case 'isblank': return values[0] === null || values[0] === '';
    case 'coalesce': return values.find((v) => v !== null && v !== '') ?? null;
    case 'concat': return values.map((v, i) => asText(v, rawOf(args[i], row))).join('');
    case 'abs': { const v = asNumber(values[0]); return v ? decAbs(v) : null; }
    case 'round': {
      const v = asNumber(values[0]);
      const k = asNumber(values[1]);
      if (!k || k.s !== 0 || k.n < 0n || k.n > 12n) throw new Error('round 的位數要是 0 到 12 的整數');
      return v ? decRound(v, Number(k.n)) : null;
    }
    case 'min':
    case 'max': {
      const nums = values.map(asNumber);
      if (nums.some((v) => v === null)) return null;
      return (nums as Dec[]).reduce((best, v) => ((fn === 'min' ? decCmp(v, best) < 0 : decCmp(v, best) > 0) ? v : best));
    }
    default: throw new Error(`不認得的函數：${fn}`);
  }
}

/** Formula result as cell text: numbers exact, blank = '', booleans TRUE/FALSE. */
export function evalToText(node: Node, row: string[]): string {
  const v = evalNode(node, row);
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return isDec(v) ? decToString(v) : v;
}

export const evalToBool = (node: Node, row: string[]): boolean => truthy(evalNode(node, row));

/** Evaluates a formula on one row; for tests and previews. */
export function evaluateFormula(src: string, columns: string[], row: string[]): string {
  return evalToText(parseFormula(src, columns), row);
}

// ---------------------------------------------------------------------------------------------------------------
// Steps

export type AggFn = 'sum' | 'count' | 'avg' | 'min' | 'max';
export type Agg = { fn: AggFn; column?: string; as?: string };

export type Step =
  | { op: 'trim'; columns?: string[] }
  | { op: 'drop_rows'; where: string }
  | { op: 'filter'; where: string }
  | { op: 'fill_empty'; column: string; value: string }
  | { op: 'rename_column'; from: string; to: string }
  | { op: 'add_column'; name: string; formula: string }
  | { op: 'drop_column'; column: string }
  | { op: 'convert_type'; column: string; to: 'number' | 'date' }
  | { op: 'dedupe'; columns?: string[] }
  | { op: 'sort'; column: string; order: 'asc' | 'desc' }
  | { op: 'group_by'; by: string[]; aggs: Agg[] }
  | { op: 'set_cell'; row: number; column: string; value: string };

export const STEP_OPS = ['trim', 'drop_rows', 'filter', 'fill_empty', 'rename_column', 'add_column', 'drop_column', 'convert_type', 'dedupe', 'sort', 'group_by', 'set_cell'] as const;

const AGG_FNS: AggFn[] = ['sum', 'count', 'avg', 'min', 'max'];

const text = (v: unknown, what: string): string => {
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  throw new Error(`缺少「${what}」`);
};
const strList = (v: unknown, what: string, required: boolean): string[] | undefined => {
  if (v === undefined || v === null) {
    if (required) throw new Error(`缺少「${what}」`);
    return undefined;
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`「${what}」要是欄名清單`);
  if (required && v.length === 0) throw new Error(`缺少「${what}」`);
  return v as string[];
};

/** Checks one step the AI (or the page) proposes; throws a readable error, returns a clean Step. */
export function parseStep(raw: unknown): Step {
  if (!raw || typeof raw !== 'object') throw new Error('步驟格式不對');
  const s = raw as Record<string, unknown>;
  switch (s.op) {
    case 'trim': return { op: 'trim', columns: strList(s.columns, 'columns', false) };
    case 'dedupe': return { op: 'dedupe', columns: strList(s.columns, 'columns', false) };
    case 'drop_rows': return { op: 'drop_rows', where: text(s.where, 'where') };
    case 'filter': return { op: 'filter', where: text(s.where, 'where') };
    case 'fill_empty': return { op: 'fill_empty', column: text(s.column, 'column'), value: typeof s.value === 'number' ? String(s.value) : String(s.value ?? '') };
    case 'rename_column': return { op: 'rename_column', from: text(s.from, 'from'), to: text(s.to, 'to') };
    case 'add_column': return { op: 'add_column', name: text(s.name, 'name'), formula: text(s.formula, 'formula') };
    case 'drop_column': return { op: 'drop_column', column: text(s.column, 'column') };
    case 'convert_type':
      if (s.to !== 'number' && s.to !== 'date') throw new Error('convert_type 的 to 只能是 number 或 date');
      return { op: 'convert_type', column: text(s.column, 'column'), to: s.to };
    case 'sort':
      return { op: 'sort', column: text(s.column, 'column'), order: s.order === 'desc' ? 'desc' : 'asc' };
    case 'group_by': {
      const by = strList(s.by, 'by', true) as string[];
      if (!Array.isArray(s.aggs) || s.aggs.length === 0) throw new Error('缺少「aggs」');
      const aggs = s.aggs.map((a): Agg => {
        const x = (a ?? {}) as Record<string, unknown>;
        if (!AGG_FNS.includes(x.fn as AggFn)) throw new Error('aggs 的 fn 只能是 sum/count/avg/min/max');
        if (x.fn !== 'count' && !x.column) throw new Error(`${String(x.fn)} 要指定 column`);
        return { fn: x.fn as AggFn, column: x.column ? text(x.column, 'column') : undefined, as: x.as ? text(x.as, 'as') : undefined };
      });
      return { op: 'group_by', by, aggs };
    }
    case 'set_cell': {
      const row = Number(s.row);
      if (!Number.isInteger(row) || row < 1) throw new Error('set_cell 的 row 要是 1 起算的整數');
      return { op: 'set_cell', row, column: text(s.column, 'column'), value: String(s.value ?? '') };
    }
    default: throw new Error(`不支援的步驟：${String(s.op)}`);
  }
}

export function describeStep(step: Step): string {
  const cols = (list?: string[]) => (list && list.length > 0 ? list.map((c) => `「${c}」`).join('、') : '所有欄');
  switch (step.op) {
    case 'trim': return `去除前後空白：${cols(step.columns)}`;
    case 'drop_rows': return `刪除符合條件的列：${step.where}`;
    case 'filter': return `只保留符合條件的列：${step.where}`;
    case 'fill_empty': return `「${step.column}」空白補成「${step.value}」`;
    case 'rename_column': return `欄位「${step.from}」改名為「${step.to}」`;
    case 'add_column': return `新增欄位「${step.name}」＝ ${step.formula}`;
    case 'drop_column': return `刪除欄位「${step.column}」`;
    case 'convert_type': return `「${step.column}」轉成${step.to === 'number' ? '數字' : '日期（yyyy-mm-dd）'}`;
    case 'dedupe': return `去除重複列（依 ${cols(step.columns)}，保留第一筆）`;
    case 'sort': return `依「${step.column}」${step.order === 'desc' ? '由大到小' : '由小到大'}排序`;
    case 'group_by': return `依 ${cols(step.by)} 彙總：${step.aggs.map((a) => `${a.fn}${a.column ? `(${a.column})` : ''}`).join('、')}`;
    case 'set_cell': return `第 ${step.row} 列「${step.column}」改成「${step.value}」`;
    default: return '';
  }
}

const needColumn = (table: Table, name: string): number => {
  const index = table.columns.indexOf(name);
  if (index < 0) throw new Error(`找不到欄位「${name}」（現有：${table.columns.join('、')}）`);
  return index;
};

/** 2024/5/6, 2024-05-06, 20240506, 民國 113/05/06 or 1130506 → yyyy-mm-dd; null when it is not a real date. */
export function normalizeDate(input: string): string | null {
  const t = input.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(t);
  let year: number;
  let month: number;
  let day: number;
  if (m) { year = +m[1]; month = +m[2]; day = +m[3]; }
  else if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) { year = +m[1]; month = +m[2]; day = +m[3]; }
  else if ((m = /^(\d{2,3})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t))) { year = +m[1] + 1911; month = +m[2]; day = +m[3]; }
  else if ((m = /^(\d{3})(\d{2})(\d{2})$/.exec(t))) { year = +m[1] + 1911; month = +m[2]; day = +m[3]; }
  else return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export type StepResult = { table: Table; note: string };

/** Runs one step; returns the new table and a short note (e.g. how many cells could not be converted). Throws on a bad step. */
export function applyStep(table: Table, step: Step): StepResult {
  const { columns } = table;
  const rows = table.rows;
  switch (step.op) {
    case 'trim': {
      const idx = step.columns ? step.columns.map((c) => needColumn(table, c)) : columns.map((_, i) => i);
      return { table: { columns, rows: rows.map((r) => r.map((c, i) => (idx.includes(i) ? c.trim() : c))) }, note: '' };
    }
    case 'drop_rows':
    case 'filter': {
      const tree = parseFormula(step.where, columns);
      let failed = 0;
      const kept = rows.filter((row) => {
        let match = false;
        try { match = evalToBool(tree, row); } catch { failed += 1; return step.op === 'drop_rows'; }
        return step.op === 'drop_rows' ? !match : match;
      });
      const note = failed > 0 ? `${failed} 列條件算不出來，${step.op === 'drop_rows' ? '已保留' : '已排除'}` : '';
      return { table: { columns, rows: kept }, note: `${rows.length} → ${kept.length} 列${note ? `；${note}` : ''}` };
    }
    case 'fill_empty': {
      const i = needColumn(table, step.column);
      let n = 0;
      const next = rows.map((r) => (r[i].trim() === '' ? (n += 1, r.map((c, j) => (j === i ? step.value : c))) : r));
      return { table: { columns, rows: next }, note: `補了 ${n} 格` };
    }
    case 'rename_column': {
      const i = needColumn(table, step.from);
      if (step.to !== step.from && columns.includes(step.to)) throw new Error(`已經有欄位叫「${step.to}」`);
      return { table: { columns: columns.map((c, j) => (j === i ? step.to : c)), rows }, note: '' };
    }
    case 'add_column': {
      if (columns.includes(step.name)) throw new Error(`已經有欄位叫「${step.name}」`);
      if (columns.length >= MAX_COLS) throw new Error(`欄位已達上限 ${MAX_COLS}`);
      const tree = parseFormula(step.formula, columns);
      let failed = 0;
      const next = rows.map((row) => {
        let out = '';
        try { out = evalToText(tree, row); } catch { failed += 1; }
        return [...row, out];
      });
      return { table: { columns: [...columns, step.name], rows: next }, note: failed > 0 ? `${failed} 列算不出來（留空）` : '' };
    }
    case 'drop_column': {
      const i = needColumn(table, step.column);
      if (columns.length === 1) throw new Error('不能刪掉最後一欄');
      return { table: { columns: columns.filter((_, j) => j !== i), rows: rows.map((r) => r.filter((_, j) => j !== i)) }, note: '' };
    }
    case 'convert_type': {
      const i = needColumn(table, step.column);
      let failed = 0;
      const next = rows.map((r) => {
        const cell = r[i];
        if (cell.trim() === '') return r;
        const converted = step.to === 'number' ? (() => { const d = parseNumber(cell); return d ? decToString(d) : null; })() : normalizeDate(cell);
        if (converted === null) { failed += 1; return r; }
        return r.map((c, j) => (j === i ? converted : c));
      });
      return { table: { columns, rows: next }, note: failed > 0 ? `${failed} 格轉不了（保持原樣）` : '' };
    }
    case 'dedupe': {
      const idx = step.columns ? step.columns.map((c) => needColumn(table, c)) : columns.map((_, i) => i);
      const seen = new Set<string>();
      const kept = rows.filter((r) => {
        const key = JSON.stringify(idx.map((i) => r[i]));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { table: { columns, rows: kept }, note: `去掉 ${rows.length - kept.length} 列` };
    }
    case 'sort': {
      const i = needColumn(table, step.column);
      const filled = rows.filter((r) => r[i].trim() !== '');
      const blanks = rows.filter((r) => r[i].trim() === '');
      const nums = filled.map((r) => parseNumber(r[i]));
      const numeric = nums.every((d) => d !== null);
      const keyed = filled.map((r, k) => ({ r, d: nums[k] }));
      keyed.sort((a, b) => {
        const c = numeric ? decCmp(a.d as Dec, b.d as Dec) : a.r[i] < b.r[i] ? -1 : a.r[i] > b.r[i] ? 1 : 0;
        return step.order === 'desc' ? -c : c;
      });
      return { table: { columns, rows: [...keyed.map((k) => k.r), ...blanks] }, note: numeric ? '' : '這欄不全是數字，依文字排序' };
    }
    case 'group_by': {
      const by = step.by.map((c) => needColumn(table, c));
      const outNames = [...step.by, ...step.aggs.map((a) => a.as ?? `${a.fn}_${a.column ?? 'rows'}`)];
      if (new Set(outNames).size !== outNames.length) throw new Error('彙總後的欄名重複，請用 as 取不同名字');
      const aggIdx = step.aggs.map((a) => (a.column ? needColumn(table, a.column) : -1));
      const groups = new Map<string, string[][]>();
      for (const row of rows) {
        const key = JSON.stringify(by.map((i) => row[i]));
        const list = groups.get(key);
        if (list) list.push(row); else groups.set(key, [row]);
      }
      const skipped = new Set<string[]>();
      const out: string[][] = [];
      for (const members of groups.values()) {
        const cells = step.aggs.map((agg, k) => {
          const i = aggIdx[k];
          if (agg.fn === 'count') return String(i < 0 ? members.length : members.filter((r) => r[i].trim() !== '').length);
          const nums: Dec[] = [];
          for (const r of members) {
            if (r[i].trim() === '') continue;
            const d = parseNumber(r[i]);
            if (d) nums.push(d); else skipped.add(r);
          }
          if (nums.length === 0) return agg.fn === 'sum' ? '0' : '';
          if (agg.fn === 'sum') return decToString(nums.reduce(decAdd));
          if (agg.fn === 'avg') return decToString(decDiv(nums.reduce(decAdd), { n: BigInt(nums.length), s: 0 }));
          return decToString(nums.reduce((best, d) => ((agg.fn === 'min' ? decCmp(d, best) < 0 : decCmp(d, best) > 0) ? d : best)));
        });
        out.push([...by.map((i) => members[0][i]), ...cells]);
      }
      return { table: { columns: outNames, rows: out }, note: `${groups.size} 組${skipped.size > 0 ? `；${skipped.size} 格不是數字，未計入` : ''}` };
    }
    case 'set_cell': {
      const i = needColumn(table, step.column);
      if (step.row > rows.length) throw new Error(`沒有第 ${step.row} 列`);
      return { table: { columns, rows: rows.map((r, k) => (k === step.row - 1 ? r.map((c, j) => (j === i ? step.value : c)) : r)) }, note: '' };
    }
    default: throw new Error('不支援的步驟');
  }
}

/** Replays steps over the base table; a step that no longer applies stops the replay (failedAt = its index). */
export function replaySteps(base: Table, steps: Step[]): { table: Table; failedAt: number | null } {
  let table = base;
  for (let i = 0; i < steps.length; i += 1) {
    try { table = applyStep(table, steps[i]).table; } catch { return { table, failedAt: i }; }
  }
  return { table, failedAt: null };
}

// ---------------------------------------------------------------------------------------------------------------
// What the AI sees, and the brief for 開工

const CELL_LIMIT = 60;
const CONTEXT_BUDGET = 80_000;

function columnStats(table: Table, index: number) {
  const values = table.rows.map((r) => r[index]).filter((c) => c.trim() !== '');
  const nums = values.map(parseNumber);
  const numeric = values.length > 0 && nums.every((d) => d !== null);
  const stats: Record<string, unknown> = {
    name: table.columns[index],
    nonEmpty: values.length,
    empty: table.rows.length - values.length,
    type: values.length === 0 ? 'empty' : numeric ? 'number' : values.every((v) => normalizeDate(v) !== null) ? 'date' : 'text',
    distinct: new Set(values).size,
  };
  if (numeric) {
    const list = nums as Dec[];
    stats.min = decToString(list.reduce((a, b) => (decCmp(b, a) < 0 ? b : a)));
    stats.max = decToString(list.reduce((a, b) => (decCmp(b, a) > 0 ? b : a)));
  } else {
    stats.samples = [...new Set(values)].slice(0, 5).map((v) => v.slice(0, CELL_LIMIT));
  }
  return stats;
}

/** A header, the first rows (as many as fit), the row count and per-column stats; never the whole table. */
export function aiContext(name: string, table: Table, steps: Step[]) {
  let count = Math.min(200, table.rows.length);
  const build = (n: number) => ({
    sheet: name,
    rowCount: table.rows.length,
    columns: table.columns.map((_, i) => columnStats(table, i)),
    sampleRows: table.rows.slice(0, n).map((r) => r.map((c) => c.slice(0, CELL_LIMIT))),
    sampleNote: n < table.rows.length ? `只給前 ${n} 列，共 ${table.rows.length} 列` : '已是全部列',
    stepsSoFar: steps.map(describeStep),
  });
  let ctx = build(count);
  while (count > 5 && JSON.stringify(ctx).length > CONTEXT_BUDGET) {
    count = Math.floor(count / 2);
    ctx = build(count);
  }
  return ctx;
}

/** 開工 brief: where the data came from, its columns, the recorded steps; asks for a re-runnable Node.js script. */
export function buildBrief(sheetName: string, source: string, base: Table, steps: Step[], finalTable: Table): string {
  const sample = base.rows.slice(0, 3).map((r) => r.map((c) => c.slice(0, CELL_LIMIT)).join(' | '));
  return [
    `我在「試算工作台」整理了一份資料「${sheetName}」，請把整理過程寫成「可重跑的 Node.js 腳本」（不要用 Python）。`,
    '',
    `資料來源：${source || '從 Excel 貼上'}（${base.rows.length} 列）`,
    `原始欄位：${base.columns.join('、')}`,
    sample.length > 0 ? `原始資料前幾列（以 | 分隔）：\n${sample.join('\n')}` : '',
    '',
    `我做過的步驟（共 ${steps.length} 步，依序）：`,
    ...steps.map((s, i) => `${i + 1}. ${describeStep(s)}`),
    '',
    '步驟的精確定義（JSON，數字運算要用十進位精確計算，不可用浮點數誤差；空白格參與四則運算結果為空白；日期統一 yyyy-mm-dd）：',
    JSON.stringify(steps),
    '',
    `整理後欄位：${finalTable.columns.join('、')}（${finalTable.rows.length} 列）`,
    '',
    '請做：1) 寫一支 Node.js 腳本，讀入輸入的 CSV，依上面步驟處理，輸出整理後的 CSV（UTF-8 含 BOM）；2) 用我給的前幾列資料實際跑過，確認結果和工作台一致；3) 告訴我怎麼執行。',
  ].filter((line) => line !== '').join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Stored data

export type SheetData = {
  id: string;
  name: string;
  /** What the person pasted: header row included. */
  raw: string[][];
  header: boolean;
  source: string;
  truncated: boolean;
  steps: Step[];
  /** The AI chat about this sheet (each sheet has its own, so one table's talk doesn't leak into another's). */
  chat: ChatLine[];
};
export type ChatLine = { role: 'user' | 'assistant'; text: string };
export type BenchData = { version: 1; activeId: string; sheets: SheetData[] };

const parseChat = (value: unknown): ChatLine[] => (Array.isArray(value) ? value : [])
  .filter((line): line is ChatLine => !!line && (line.role === 'user' || line.role === 'assistant') && typeof line.text === 'string')
  .slice(-40);

export const MAX_SHEETS = 10;

let counter = 0;
export const newSheetId = () => `s${Date.now().toString(36)}${(counter += 1).toString(36)}`;

export const emptySheet = (name: string): SheetData => ({ id: newSheetId(), name, raw: [], header: true, source: '', truncated: false, steps: [], chat: [] });

export function parseBenchData(value: unknown): BenchData {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const sheets: SheetData[] = [];
  for (const item of Array.isArray(v.sheets) ? v.sheets : []) {
    if (!item || typeof item !== 'object' || sheets.length >= MAX_SHEETS) continue;
    const s = item as Record<string, unknown>;
    const raw = (Array.isArray(s.raw) ? s.raw : []).slice(0, MAX_ROWS + 1).map((row) => (Array.isArray(row) ? row.slice(0, MAX_COLS).map((c) => String(c ?? '')) : []));
    const steps: Step[] = [];
    for (const st of Array.isArray(s.steps) ? s.steps : []) {
      try { steps.push(parseStep(st)); } catch { break; }
    }
    sheets.push({
      id: typeof s.id === 'string' && s.id ? s.id : newSheetId(),
      name: typeof s.name === 'string' && s.name.trim() ? s.name.slice(0, 40) : `工作表 ${sheets.length + 1}`,
      raw,
      header: s.header !== false,
      source: typeof s.source === 'string' ? s.source.slice(0, 200) : '',
      truncated: s.truncated === true,
      steps: steps.slice(0, MAX_STEPS),
      chat: parseChat(s.chat),
    });
  }
  if (sheets.length === 0) sheets.push(emptySheet('工作表 1'));
  const activeId = typeof v.activeId === 'string' && sheets.some((s) => s.id === v.activeId) ? v.activeId : sheets[0].id;
  // Saved before 10/14 noon: one chat for the whole bench; it belongs to the sheet that was open.
  const legacy = parseChat(v.chat);
  const active = sheets.find((sheet) => sheet.id === activeId);
  if (legacy.length > 0 && active && active.chat.length === 0) active.chat = legacy;
  return { version: 1, activeId, sheets };
}
