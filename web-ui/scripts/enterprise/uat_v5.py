"""V5 UAT 重新計數：以 V4 逐列狀態（docs/enterprise/uat/UAT_STATUS_V4.json，V4 RC 機器生成）套用 V5_CHANGES，輸出 UAT_TRACEABILITY_V5.json／.md。
用法：python3 -B scripts/enterprise/uat_v5.py [--check]
規則：只升級「V5 新後端與測試直接補上缺口」的列；GENERIC_VERIFIED＝Builder 以合成資料工程驗證，不是情境 PASS；PASS 永遠需要真人簽認。
引用的證據檔必須存在於 repo，否則失敗。條款比對（UAT-L03／L05）維持 BLOCKED_PRODUCT_DECISION。
"""
import collections
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
V4 = ROOT / 'docs/enterprise/uat/UAT_STATUS_V4.json'
OUT_JSON = ROOT / 'docs/enterprise/uat/UAT_TRACEABILITY_V5.json'
OUT_MD = ROOT / 'docs/enterprise/uat/UAT_TRACEABILITY_V5.md'
STATUSES = ['GENERIC_VERIFIED', 'PARTIAL', 'NOT_IMPLEMENTED', 'CUSTOMER_UAT_PENDING', 'PASS']
ENGINE = 'server/modules/enterprise-persistence/tests/ops-report-v1.test.ts'
PG = 'server/modules/enterprise-api/tests/ops-report.integration.test.ts'
V5_CHANGES = {
    'OP-UAT-09': ('PARTIAL', '營運明細依明示案例集只納入 BASE 六筆（selectedRows 6／excludedRows 1）、丙站缺值旗標保留；合成事項紀錄（備註）導入仍未實作', [ENGINE, PG]),
    'OP-UAT-11': ('GENERIC_VERIFIED', '移除期間或 owner 欄 → HEADER_MISMATCH 整批拒收；owner／識別欄空白 → MISSING_*；拒收留紀錄與稽核，原文件版本不變', [ENGINE, PG]),
    'OP-UAT-14': ('GENERIC_VERIFIED', '確定性引擎 210／180／+30／16.67%、待辦 61／46／+15；BigInt＋最後一步 ROUND_HALF_UP；引擎不產生因果文字；與規格 oracle 逐項比對', [ENGINE, PG]),
    'OP-UAT-15': ('GENERIC_VERIFIED', '甲乙 150/160＝93.75%、前週 130/140＝92.86%、差 0.89 百分點（未四捨五入比率相減）；全體 UNKNOWN；分子分母與子集合 sites 明示', [ENGINE, PG]),
    'OP-UAT-16': ('PARTIAL', '缺值為 UNKNOWN（不補 0／平均／前值），原因 FIELD_UNKNOWN 指出據點與欄位、其餘主張照常；owner 需經來源列查得，未在主張直接列出，UI 未呈現', [ENGINE]),
    'OP-UAT-17': ('PARTIAL', '同週同站 70／72 → CONFLICT、列出雙方來源、受影響主張值為空，不自動挑選；週報定稿流程尚未實作（無法驗「停止定稿」）', [ENGINE, PG]),
    'OP-UAT-18': ('PARTIAL', '敘述數字守門 validateOpsNarrative 擋下引擎未產生的數字（如 35%）；但恰等於某主張值的數字擋不住（語意限制），敘述生成未實作', [ENGINE]),
    'OP-UAT-21': ('PARTIAL', '作業分鐘以「營運負荷，非工時節省」標示，引擎不計算 ROI／節省；敘述守門擋無來源數字；ROI 要求的明確拒絕回覆未實作', [ENGINE]),
    'OP-UAT-35': ('GENERIC_VERIFIED', '只取指定 ISO 週與前一週，其他週別列不入算（excludedRows 計數）；列的起訖與週別不符 → PERIOD_MISMATCH 拒收；結果含固定起迄、前週範圍與 Asia/Taipei', [ENGINE, PG]),
}


def build():
    v4 = json.loads(V4.read_text())
    rows, missing = [], []
    for row in v4['rows']:
        change = V5_CHANGES.get(row['id'])
        status, note, evidence = (change if change else (row['v4_status'], row['v4_note'], []))
        missing += [path for path in evidence if not (ROOT / path).exists()]
        rows.append({'id': row['id'], 'v4_status': row['v4_status'], 'v5_status': status, 'v5_note': note, 'evidence': evidence,
                     'changed_in_v5': bool(change) and status != row['v4_status'] or bool(change) and note != row['v4_note']})
    totals = {'v4': dict(collections.Counter(r['v4_status'] for r in rows)), 'v5': dict(collections.Counter(r['v5_status'] for r in rows))}
    totals = {k: {s: v.get(s, 0) for s in STATUSES} for k, v in totals.items()}
    data = {'schema_version': 1, 'source': 'docs/enterprise/uat/UAT_STATUS_V4.json（V4 RC 機器生成）＋V5_CHANGES', 'total_ids': len(rows), 'totals': totals,
            'pass_requires': '真人依權限簽認；本表沒有任何 PASS', 'blocked_product_decision': ['UAT-L03', 'UAT-L05'], 'rows': rows}
    md = ['# UAT 追溯（V5）', '', f"共 {len(rows)} 項。來源：V4 RC 機器生成狀態＋本輪 V5 變更（`scripts/enterprise/uat_v5.py`）。**GENERIC_VERIFIED 只代表 Builder 以合成資料工程驗證，不是情境 PASS；PASS 需要真人簽認，目前 0。**", '',
          '| 狀態 | V4 | V5 |', '|---|---|---|'] + [f"| {s} | {totals['v4'][s]} | {totals['v5'][s]} |" for s in STATUSES]
    md += ['', '條款比對（UAT-L03、UAT-L05）維持 **BLOCKED_PRODUCT_DECISION**（DEC-W6-SCOPE-01）。', '', '## V5 變更列', '', '| ID | V4 | V5 | 說明 | 證據 |', '|---|---|---|---|---|']
    md += [f"| {r['id']} | {r['v4_status']} | {r['v5_status']} | {r['v5_note']} | {'<br/>'.join(f'`{p}`' for p in r['evidence'])} |" for r in rows if r['changed_in_v5']]
    md += ['', '## 全部 66 項', '', '| ID | V5 狀態 | 說明 |', '|---|---|---|'] + [f"| {r['id']} | {r['v5_status']} | {r['v5_note'].replace('|', '／')} |" for r in rows]
    return data, '\n'.join(md) + '\n', missing


def main():
    data, md, missing = build()
    text = json.dumps(data, ensure_ascii=False, indent=1) + '\n'
    if missing:
        print(json.dumps({'missing_evidence': missing}, ensure_ascii=False))
        return 1
    if '--check' in sys.argv:
        stale = [p.name for p, t in [(OUT_JSON, text), (OUT_MD, md)] if not p.exists() or p.read_text() != t]
        print(json.dumps({'stale': stale}))
        return 1 if stale else 0
    OUT_JSON.write_text(text)
    OUT_MD.write_text(md)
    print(json.dumps({'total': data['total_ids'], 'totals': data['totals']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
