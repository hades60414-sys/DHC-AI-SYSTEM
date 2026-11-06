import { createHash } from 'node:crypto';

/**
 * OPS-REPORT-v1：營運週報的確定性數值引擎（docs/enterprise/scenarios/營運週報/README.md）。
 * 純函式：輸入營運明細 CSV 的 bytes、ISO 週別與明示選取的案例集，輸出 14 項主張（數值、分子分母、來源列）或拒收原因。
 * 只用整數／BigInt，不用浮點；空值是 UNKNOWN 不是 0；同週同據點多筆是 CONFLICT，不自動挑選；不呼叫模型。
 * 模型（若之後接上）只能寫敘述文字，數字必須取自本引擎結果，見 validateOpsNarrative。
 */
export const OPS_REPORT_RULE_VERSION = 'OPS-REPORT-v1';

const HEADER = ['資料標記', '案例集', '紀錄ID', '週別', '期間起', '期間迄', '據點ID', '據點名稱', '週受理件數', '週完成件數', '準時完成件數', '週末待辦件數', '作業分鐘', '資料owner', '快照ID'];
const COUNT_FIELDS = ['週受理件數', '週完成件數', '準時完成件數', '週末待辦件數', '作業分鐘'] as const;
type CountField = (typeof COUNT_FIELDS)[number];
const REQUIRED_TEXT = ['資料標記', '案例集', '資料owner', '快照ID'] as const;
export const OPS_REPORT_MAX_ROWS = 50_000;
export const OPS_REPORT_MAX_SOURCES = 5;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WEEK = /^(\d{4})-W(\d{2})$/;
const COUNT = /^(0|[1-9]\d{0,9})$/;
const TEXT_MAX = 200;

export type OpsSource = { content: Buffer; versionId: string; sha256: string };
export type OpsReportInput = { sources: OpsSource[]; week: string; datasets: string[] };
export type OpsReportError = { source: number | null; line: number | null; recordId: string | null; code: string };
export type OpsSourceRef = { versionId: string; sha256: string; line: number; recordId: string };
export type OpsClaimStatus = 'OK' | 'UNKNOWN' | 'CONFLICT';
export type OpsClaimUnit = 'count' | 'minutes' | 'percent' | 'percentage_point';
/**
 * value 為整數字串；scale＝小數位數（件數 0、比率 2，例 value "1667" scale 2 ＝ 16.67）。display 是 value 的十進位字串。
 * 比率另附未四捨五入的 numerator／denominator（整數），可獨立重算。
 */
export type OpsClaim = {
  claimId: string; label: string; unit: OpsClaimUnit; status: OpsClaimStatus;
  value: string | null; scale: 0 | 2; display: string | null; numerator: string | null; denominator: string | null;
  sites: string[]; reasons: string[]; sources: OpsSourceRef[];
};
export type OpsAnomaly = { code: 'BACKLOG_CONSERVATION' | 'ONTIME_EXCEEDS_COMPLETED' | 'SITE_SET_CHANGED'; week: string; siteId: string; recordIds: string[] };
export type OpsReportResult =
  | { status: 'rejected'; ruleVersion: string; errors: OpsReportError[] }
  | { status: 'completed'; ruleVersion: string; timezone: 'Asia/Taipei'; week: string; periodStart: string; periodEnd: string;
      previousWeek: string; previousPeriodStart: string; previousPeriodEnd: string; datasets: string[];
      sources: Array<{ versionId: string; sha256: string; rows: number }>;
      counts: { rows: number; selectedRows: number; excludedRows: number; currentSites: number; previousSites: number; conflicts: number };
      sites: string[]; claims: OpsClaim[];
      conflicts: Array<{ week: string; siteId: string; sources: OpsSourceRef[] }>; anomalies: OpsAnomaly[] };

type Row = { source: number; line: number; fields: Record<string, string>; ref: OpsSourceRef; counts: Record<CountField, bigint | null> };

/** ISO 8601 週：週一起；第 1 週含當年第一個週四。回傳 [週一, 週日] 的 YYYY-MM-DD，或週別不存在時 null。 */
export function isoWeekRange(week: string): [string, string] | null {
  const match = WEEK.exec(week);
  if (!match) return null;
  const year = Number(match[1]);
  const number = Number(match[2]);
  if (number < 1 || number > 53 || year < 1970 || year > 9999) return null;
  const jan4 = Date.UTC(year, 0, 4);
  const mondayOfWeek1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000;
  const monday = mondayOfWeek1 + (number - 1) * 7 * 86_400_000;
  if (isoWeekOf(monday) !== week) return null; // 例如沒有第 53 週的年份
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [iso(monday), iso(monday + 6 * 86_400_000)];
}

function isoWeekOf(ms: number) {
  const thursday = ms + (3 - ((new Date(ms).getUTCDay() + 6) % 7)) * 86_400_000;
  const year = new Date(thursday).getUTCFullYear();
  const number = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return `${year}-W${String(number).padStart(2, '0')}`;
}

function previousWeekOf(week: string) {
  const [monday] = isoWeekRange(week)!;
  return isoWeekOf(Date.parse(`${monday}T00:00:00Z`) - 7 * 86_400_000);
}

/** 嚴格 CSV（與 ACC-MATCH-v1 相同規則）：UTF-8（可含 BOM）、LF／CRLF、雙引號；欄內換行與欄數不符一律拒收。 */
function parseCsv(content: Buffer, source: number, errors: OpsReportError[]) {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    errors.push({ source, line: null, recordId: null, code: 'ENCODING_NOT_UTF8' });
    return [];
  }
  if (text.startsWith('﻿')) text = text.slice(1);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const split = (line: string, number: number) => {
    const cells: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (quoted) {
        if (char === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (char === '"') quoted = false; else cell += char;
      } else if (char === '"' && cell === '') quoted = true;
      else if (char === ',') { cells.push(cell); cell = ''; } else cell += char;
    }
    if (quoted) { errors.push({ source, line: number, recordId: null, code: 'UNTERMINATED_QUOTE' }); return null; }
    cells.push(cell);
    return cells;
  };
  const head = lines.length ? split(lines[0], 1) : null;
  if (!head || head.join('\u0000') !== HEADER.join('\u0000')) {
    errors.push({ source, line: 1, recordId: null, code: 'HEADER_MISMATCH' });
    return [];
  }
  if (lines.length - 1 > OPS_REPORT_MAX_ROWS) { errors.push({ source, line: null, recordId: null, code: 'TOO_MANY_ROWS' }); return []; }
  const rows: Array<{ line: number; fields: Record<string, string> }> = [];
  for (let index = 1; index < lines.length; index += 1) {
    const cells = split(lines[index], index + 1);
    if (!cells) continue;
    if (cells.length !== HEADER.length) { errors.push({ source, line: index + 1, recordId: cells[2] || null, code: 'COLUMN_COUNT' }); continue; }
    rows.push({ line: index + 1, fields: Object.fromEntries(HEADER.map((name, i) => [name, cells[i]])) });
  }
  return rows;
}

const roundHalfUp = (numerator: bigint, denominator: bigint) => {
  // denominator > 0；ROUND_HALF_UP（.5 遠離 0，與 Python Decimal 相同）
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const rounded = (2n * magnitude + denominator) / (2n * denominator);
  return negative ? -rounded : rounded;
};
const hundredthsDisplay = (value: bigint) => {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  return `${negative ? '-' : ''}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, '0')}`;
};

type Part = { status: OpsClaimStatus; total: bigint | null; reasons: string[]; sources: OpsSourceRef[] };

/** 執行 OPS-REPORT-v1。輸出完全由輸入 bytes、版本、週別與案例集決定（同輸入同輸出、同 hash）。 */
export function runOpsReportV1(input: OpsReportInput): OpsReportResult {
  const reject = (errors: OpsReportError[]): OpsReportResult => ({ status: 'rejected', ruleVersion: OPS_REPORT_RULE_VERSION, errors });
  const range = isoWeekRange(input.week);
  if (!range) return reject([{ source: null, line: null, recordId: null, code: 'INVALID_WEEK' }]);
  if (!input.datasets.length || input.datasets.length > 5 || input.datasets.some(item => !ID.test(item)) || new Set(input.datasets).size !== input.datasets.length) {
    return reject([{ source: null, line: null, recordId: null, code: 'INVALID_DATASETS' }]);
  }
  if (!input.sources.length || input.sources.length > OPS_REPORT_MAX_SOURCES) return reject([{ source: null, line: null, recordId: null, code: 'INVALID_SOURCES' }]);
  const previousWeek = previousWeekOf(input.week);
  const previousRange = isoWeekRange(previousWeek)!;
  const datasets = [...input.datasets].sort();

  const errors: OpsReportError[] = [];
  const rows: Row[] = [];
  const seenRecords = new Map<string, number>();
  let totalRows = 0;
  input.sources.forEach((source, sourceIndex) => {
    const parsed = parseCsv(source.content, sourceIndex, errors);
    totalRows += parsed.length;
    for (const { line, fields } of parsed) {
      const recordId = fields['紀錄ID'];
      const fail = (code: string) => errors.push({ source: sourceIndex, line, recordId: recordId || null, code });
      if (!ID.test(recordId)) { fail(recordId ? 'INVALID_紀錄ID' : 'MISSING_紀錄ID'); continue; }
      if (seenRecords.has(recordId)) fail('DUPLICATE_RECORD_ID');
      seenRecords.set(recordId, sourceIndex);
      if (!ID.test(fields['據點ID'])) fail(fields['據點ID'] ? 'INVALID_據點ID' : 'MISSING_據點ID');
      for (const field of REQUIRED_TEXT) if (!fields[field]) fail(`MISSING_${field}`);
      for (const field of HEADER) if ((fields[field] ?? '').length > TEXT_MAX) fail(`TOO_LONG_${field}`);
      const weekRange = isoWeekRange(fields['週別']);
      if (!weekRange) fail(fields['週別'] ? 'INVALID_週別' : 'MISSING_週別');
      else if (fields['期間起'] !== weekRange[0] || fields['期間迄'] !== weekRange[1]) fail('PERIOD_MISMATCH');
      const counts = {} as Record<CountField, bigint | null>;
      for (const field of COUNT_FIELDS) {
        const value = fields[field];
        if (value === '') counts[field] = null;
        else if (COUNT.test(value)) counts[field] = BigInt(value);
        else { fail(`INVALID_${field}`); counts[field] = null; }
      }
      rows.push({ source: sourceIndex, line, fields, counts, ref: { versionId: source.versionId, sha256: source.sha256, line, recordId } });
    }
  });
  if (errors.length) return reject(errors);

  const selected = rows.filter(row => datasets.includes(row.fields['案例集']) && (row.fields['週別'] === input.week || row.fields['週別'] === previousWeek));
  const bySite = (week: string) => {
    const map = new Map<string, Row[]>();
    for (const row of selected.filter(item => item.fields['週別'] === week)) map.set(row.fields['據點ID'], [...(map.get(row.fields['據點ID']) ?? []), row]);
    return map;
  };
  const current = bySite(input.week);
  const previous = bySite(previousWeek);
  const sites = [...current.keys()].sort();
  const previousSites = [...previous.keys()].sort();
  const anomalies: OpsAnomaly[] = [];
  const conflicts = [...[...current].map(([siteId, list]) => ({ week: input.week, siteId, list })), ...[...previous].map(([siteId, list]) => ({ week: previousWeek, siteId, list }))]
    .filter(item => item.list.length > 1)
    .map(item => ({ week: item.week, siteId: item.siteId, sources: item.list.map(row => row.ref) }))
    .sort((a, b) => (a.week + a.siteId < b.week + b.siteId ? -1 : 1));

  // 準時數不可大於完成數：列異常，該列準時數視為 UNKNOWN（不刪來源、不修值）。
  const onTime = (row: Row) => {
    const value = row.counts['準時完成件數'];
    const completed = row.counts['週完成件數'];
    return value !== null && completed !== null && value <= completed ? value : null;
  };
  for (const row of selected) {
    if (row.counts['準時完成件數'] !== null && row.counts['週完成件數'] !== null && row.counts['準時完成件數']! > row.counts['週完成件數']!) {
      anomalies.push({ code: 'ONTIME_EXCEEDS_COMPLETED', week: row.fields['週別'], siteId: row.fields['據點ID'], recordIds: [row.ref.recordId] });
    }
  }
  for (const siteId of sites) {
    const [now] = current.get(siteId)!;
    const before = previous.get(siteId);
    if (current.get(siteId)!.length !== 1 || !before || before.length !== 1) continue;
    const values = [before[0].counts['週末待辦件數'], now.counts['週受理件數'], now.counts['週完成件數'], now.counts['週末待辦件數']];
    if (values.some(value => value === null)) continue;
    const [backlogBefore, intake, completed, backlog] = values as bigint[];
    if (backlogBefore + intake - completed !== backlog) anomalies.push({ code: 'BACKLOG_CONSERVATION', week: input.week, siteId, recordIds: [before[0].ref.recordId, now.ref.recordId] });
  }
  for (const siteId of [...new Set([...sites, ...previousSites])].sort()) {
    if (sites.length && previousSites.length && (!current.has(siteId) || !previous.has(siteId))) {
      anomalies.push({ code: 'SITE_SET_CHANGED', week: current.has(siteId) ? input.week : previousWeek, siteId, recordIds: [...(current.get(siteId) ?? previous.get(siteId)!)].map(row => row.ref.recordId) });
    }
  }

  /** 對 siteIds 的某週欄位加總；任一據點缺列→UNKNOWN、多列→CONFLICT、欄位空→UNKNOWN。 */
  const sum = (week: string, field: CountField, siteIds: string[], pick: (row: Row) => bigint | null = row => row.counts[field]): Part => {
    const map = week === input.week ? current : previous;
    const result: Part = { status: 'OK', total: 0n, reasons: [], sources: [] };
    if (!siteIds.length) return { status: 'UNKNOWN', total: null, reasons: [`NO_ROWS:${week}`], sources: [] };
    for (const siteId of siteIds) {
      const list = map.get(siteId);
      if (!list) { result.status = result.status === 'CONFLICT' ? 'CONFLICT' : 'UNKNOWN'; result.reasons.push(`SITE_MISSING:${week}:${siteId}`); continue; }
      result.sources.push(...list.map(row => row.ref));
      if (list.length > 1) { result.status = 'CONFLICT'; result.reasons.push(`SOURCE_CONFLICT:${week}:${siteId}`); continue; }
      const value = pick(list[0]);
      if (value === null) { result.status = result.status === 'CONFLICT' ? 'CONFLICT' : 'UNKNOWN'; result.reasons.push(`FIELD_UNKNOWN:${week}:${siteId}:${field}`); continue; }
      result.total! += value;
    }
    if (result.status !== 'OK') result.total = null;
    return result;
  };
  const merge = (...parts: Array<Pick<Part, 'status' | 'reasons' | 'sources'>>) => ({
    status: (parts.some(part => part.status === 'CONFLICT') ? 'CONFLICT' : parts.some(part => part.status === 'UNKNOWN') ? 'UNKNOWN' : 'OK') as OpsClaimStatus,
    reasons: [...new Set(parts.flatMap(part => part.reasons))],
    sources: dedupe(parts.flatMap(part => part.sources)),
  });
  const claim = (claimId: string, label: string, unit: OpsClaimUnit, sitesUsed: string[], base: ReturnType<typeof merge>,
    value: bigint | null, fraction: [bigint, bigint] | null = null): OpsClaim => {
    const ok = base.status === 'OK' && value !== null;
    const scale = unit === 'count' || unit === 'minutes' ? 0 : 2;
    return {
      claimId, label, unit, status: ok ? 'OK' : base.status === 'OK' ? 'UNKNOWN' : base.status,
      value: ok ? value!.toString() : null, scale, display: ok ? (scale === 0 ? value!.toString() : hundredthsDisplay(value!)) : null,
      numerator: ok && fraction ? fraction[0].toString() : null, denominator: ok && fraction ? fraction[1].toString() : null,
      sites: sitesUsed, reasons: base.reasons, sources: base.sources,
    };
  };
  const percent = (numerator: bigint, denominator: bigint) => roundHalfUp(numerator * 10_000n, denominator);
  const withReason = (base: ReturnType<typeof merge>, reason: string) => ({ ...base, status: base.status === 'OK' ? 'UNKNOWN' as const : base.status, reasons: [...base.reasons, reason] });

  const completedNow = sum(input.week, '週完成件數', sites);
  const completedBefore = sum(previousWeek, '週完成件數', sites);
  const intakeNow = sum(input.week, '週受理件數', sites);
  const backlogNow = sum(input.week, '週末待辦件數', sites);
  const backlogBefore = sum(previousWeek, '週末待辦件數', sites);
  const minutesNow = sum(input.week, '作業分鐘', sites);

  const claims: OpsClaim[] = [];
  claims.push(claim('OP-CLM-01', '本週完成件數', 'count', sites, merge(completedNow), completedNow.total));
  claims.push(claim('OP-CLM-02', '前週完成件數（同據點）', 'count', sites, merge(completedBefore), completedBefore.total));
  const completedDelta = merge(completedNow, completedBefore);
  claims.push(claim('OP-CLM-03', '完成件數增量', 'count', sites, completedDelta,
    completedNow.total !== null && completedBefore.total !== null ? completedNow.total - completedBefore.total : null));
  const growthBase = completedBefore.total === 0n ? withReason(completedDelta, 'DENOMINATOR_ZERO') : completedDelta;
  const growthFraction: [bigint, bigint] | null = completedNow.total !== null && completedBefore.total ? [completedNow.total - completedBefore.total, completedBefore.total] : null;
  claims.push(claim('OP-CLM-04', '完成件數週增幅', 'percent', sites, growthBase, growthFraction ? percent(...growthFraction) : null, growthFraction));
  claims.push(claim('OP-CLM-05', '本週受理件數', 'count', sites, merge(intakeNow), intakeNow.total));
  claims.push(claim('OP-CLM-06', '本週末待辦件數', 'count', sites, merge(backlogNow), backlogNow.total));
  claims.push(claim('OP-CLM-07', '前週末待辦件數（同據點）', 'count', sites, merge(backlogBefore), backlogBefore.total));
  claims.push(claim('OP-CLM-08', '週末待辦增量', 'count', sites, merge(backlogNow, backlogBefore),
    backlogNow.total !== null && backlogBefore.total !== null ? backlogNow.total - backlogBefore.total : null));

  // 準時率子集合：本週該據點唯一一列且準時數有效。任一本週據點衝突→子集合本身不可決定→CONFLICT。
  const conflictedNow = sites.filter(siteId => current.get(siteId)!.length > 1);
  const subset = sites.filter(siteId => current.get(siteId)!.length === 1 && onTime(current.get(siteId)![0]) !== null);
  const excluded = sites.filter(siteId => !conflictedNow.includes(siteId) && !subset.includes(siteId)).map(siteId => `EXCLUDED_ONTIME_UNKNOWN:${siteId}`);
  const conflictPart: Part = { status: conflictedNow.length ? 'CONFLICT' : 'OK', total: null, reasons: conflictedNow.map(siteId => `SOURCE_CONFLICT:${input.week}:${siteId}`),
    sources: conflictedNow.flatMap(siteId => current.get(siteId)!.map(row => row.ref)) };
  const rate = (week: string, siteIds: string[]) => {
    const numerator = sum(week, '準時完成件數', siteIds, onTime);
    const denominator = sum(week, '週完成件數', siteIds);
    const base = merge(conflictPart, numerator, denominator);
    const fraction: [bigint, bigint] | null = numerator.total !== null && denominator.total ? [numerator.total, denominator.total] : null;
    return { base: denominator.total === 0n ? withReason(base, 'DENOMINATOR_ZERO') : base, fraction };
  };
  const subsetNow = rate(input.week, subset);
  const subsetBefore = rate(previousWeek, subset);
  claims.push(claim('OP-CLM-09', '本週準時完成率（準時數有效據點）', 'percent', subset, { ...subsetNow.base, reasons: [...subsetNow.base.reasons, ...excluded] },
    subsetNow.fraction ? percent(...subsetNow.fraction) : null, subsetNow.fraction));
  claims.push(claim('OP-CLM-10', '前週準時完成率（同一據點子集合）', 'percent', subset, { ...subsetBefore.base, reasons: [...subsetBefore.base.reasons, ...excluded] },
    subsetBefore.fraction ? percent(...subsetBefore.fraction) : null, subsetBefore.fraction));
  const ppBase = merge(subsetNow.base, subsetBefore.base);
  const pp = subsetNow.fraction && subsetBefore.fraction
    ? [subsetNow.fraction[0] * subsetBefore.fraction[1] - subsetBefore.fraction[0] * subsetNow.fraction[1], subsetNow.fraction[1] * subsetBefore.fraction[1]] as [bigint, bigint] : null;
  claims.push(claim('OP-CLM-11', '準時完成率差（百分點）', 'percentage_point', subset, { ...ppBase, reasons: [...ppBase.reasons, ...excluded] }, pp ? percent(...pp) : null, pp));
  const all = rate(input.week, sites);
  claims.push(claim('OP-CLM-12', '本週全據點準時完成率', 'percent', sites, { ...all.base, sources: dedupe([...all.base.sources, ...sum(input.week, '週完成件數', sites).sources]) },
    all.fraction ? percent(...all.fraction) : null, all.fraction));
  claims.push(claim('OP-CLM-13', '本週作業分鐘（營運負荷，非工時節省）', 'minutes', sites, merge(minutesNow), minutesNow.total));
  const coverageBase = merge(conflictPart, { status: sites.length ? 'OK' : 'UNKNOWN', reasons: sites.length ? [] : [`NO_ROWS:${input.week}`],
    sources: sites.flatMap(siteId => current.get(siteId)!.map(row => row.ref)) });
  const coverage: [bigint, bigint] | null = sites.length ? [BigInt(subset.length), BigInt(sites.length)] : null;
  claims.push(claim('OP-CLM-14', '準時數有效據點占比', 'percent', sites, coverageBase, coverage ? percent(...coverage) : null, coverage));

  return {
    status: 'completed', ruleVersion: OPS_REPORT_RULE_VERSION, timezone: 'Asia/Taipei', week: input.week, periodStart: range[0], periodEnd: range[1],
    previousWeek, previousPeriodStart: previousRange[0], previousPeriodEnd: previousRange[1], datasets,
    sources: input.sources.map((source, index) => ({ versionId: source.versionId, sha256: source.sha256, rows: rows.filter(row => row.source === index).length })),
    counts: { rows: totalRows, selectedRows: selected.length, excludedRows: totalRows - selected.length, currentSites: sites.length, previousSites: previousSites.length, conflicts: conflicts.length },
    sites, claims, conflicts, anomalies,
  };
}

function dedupe(refs: OpsSourceRef[]) {
  const seen = new Set<string>();
  return refs.filter(ref => {
    const key = `${ref.versionId}#${ref.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 正規 JSON（物件鍵依碼位排序、陣列保持順序）的 SHA-256；與 ACC-MATCH-v1 的 resultSha256 規則相同。 */
export function opsReportResultSha256(result: OpsReportResult) {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  return createHash('sha256').update(canonical(result)).digest('hex');
}

export type OpsNarrativeViolation = { token: string; code: 'NUMBER_NOT_FROM_ENGINE' | 'PERCENTAGE_POINT_AS_PERCENT' | 'UNKNOWN_CLAIM_REFERENCE' | 'CLAIM_NOT_OK' };

/**
 * 「模型只寫文字」的硬邊界：敘述中的每個數字都必須等於某個 OK 主張的 display／分子／分母，或是本報告的週別／日期；
 * 引用 [OP-CLM-xx] 必須存在且為 OK；百分點主張的值後面不得接 %（0.89 百分點≠0.89%）。違規時呼叫端不得把文字放進草稿。
 * 限制：只核對「數值是否出自引擎」，不理解語意——恰好等於某主張值的錯誤敘述（例如把增量 30 寫成「節省 30%」）擋不住，仍需人審。
 */
export function validateOpsNarrative(text: string, result: Extract<OpsReportResult, { status: 'completed' }>) {
  const violations: OpsNarrativeViolation[] = [];
  const byId = new Map(result.claims.map(item => [item.claimId, item]));
  const allowed = new Set<string>();
  const ppValues = new Set<string>();
  for (const item of result.claims.filter(entry => entry.status === 'OK')) {
    for (const value of [item.display, item.numerator, item.denominator]) if (value) allowed.add(value.replace(/^-/, ''));
    if (item.unit === 'percentage_point' && item.display) ppValues.add(item.display.replace(/^-/, ''));
  }
  let rest = text.replace(/\[(OP-CLM-\d{2})\]/g, (_, id: string) => {
    const item = byId.get(id);
    if (!item) violations.push({ token: id, code: 'UNKNOWN_CLAIM_REFERENCE' });
    else if (item.status !== 'OK') violations.push({ token: id, code: 'CLAIM_NOT_OK' });
    return ' ';
  });
  for (const token of [result.week, result.previousWeek, result.periodStart, result.periodEnd, result.previousPeriodStart, result.previousPeriodEnd]) rest = rest.split(token).join(' ');
  for (const match of rest.matchAll(/\d+(?:\.\d+)?(\s*%)?/g)) {
    const number = match[0].replace(/\s*%$/, '');
    if (!allowed.has(number)) violations.push({ token: match[0], code: 'NUMBER_NOT_FROM_ENGINE' });
    else if (match[1] && ppValues.has(number)) violations.push({ token: match[0], code: 'PERCENTAGE_POINT_AS_PERCENT' });
  }
  return { ok: violations.length === 0, violations };
}
