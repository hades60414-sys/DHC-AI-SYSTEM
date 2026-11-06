"""V5.1 RG-V5-04：UAT 證據引用索引（機械化）。由 UAT_TRACEABILITY_V5.json＋各列說明中的證據代號／明確路徑＋明確測試對照，產生 UAT_EVIDENCE_INDEX.json。

用法：python3 -B scripts/enterprise/uat_evidence_index.py [--product-sha SHA] [--verify-run ID] [--image-run ID] [--requirements DIR] [--check]
- 證據代號依 docs/enterprise/UAT_MATRIX.md（V4）圖例；PLAN、E02b 不在圖例內，依程式內引用推定並標 alias_resolution=INFERRED。
- 測試名稱：只收「測試標題實際引用該 UAT ID」或 EXPLICIT 明確對照（標題片段必須真的存在於該檔，否則失敗）。只有檔案層級對應者標 FILE_LEVEL。
- 沒有任何證據者標 EVIDENCE_MISSING（NOT_IMPLEMENTED／CUSTOMER_UAT_PENDING 列一律如此），不推定 PASS。
- requirements：V4 情境 UAT 表所在目錄（不在公開 repo）；提供時抽「期望結果」欄並把非「主張」的「張」等人名替換為［角色］。
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TRACE = ROOT / 'docs/enterprise/uat/UAT_TRACEABILITY_V5.json'
OUT = ROOT / 'docs/enterprise/uat/UAT_EVIDENCE_INDEX.json'
PG = ('pg-integration', 'enterprise-verify / postgres-integration', 'enterprise-verify-postgres')
NODE = ('node-test', 'enterprise-verify / static-and-unit', 'enterprise-verify-static-unit（backend.tap）')
VITEST = ('vitest', 'enterprise-verify / static-and-unit', 'enterprise-verify-static-unit（vitest.json）')
DLV = ('delivery', 'enterprise-image-build / delivery-{amd64,arm64}', 'enterprise-delivery-{amd64,arm64}')
LOCAL = ('local-harness', 'NOT_IN_CI', 'V4 RC 本機證據（不在 CI）')
ALIASES = {
    'API': ('server/modules/enterprise-api/tests/enterprise-api.integration.test.ts', PG, 'LEGEND'),
    'DOC': ('server/modules/enterprise-api/tests/document-search.integration.test.ts', PG, 'LEGEND'),
    'WF': ('server/modules/enterprise-api/tests/workflow.integration.test.ts', PG, 'LEGEND'),
    'SEC': ('tests/enterprise/sec01/run_sec01.py', LOCAL, 'LEGEND'),
    'E05': ('server/modules/enterprise-persistence/tests/document-versions.integration.test.ts', PG, 'LEGEND'),
    'DLV': ('scripts/enterprise/驗證AI_Office交付.py', DLV, 'LEGEND'),
    'UI': ('src/modules/office/tests/OfficeApp.test.tsx', VITEST, 'LEGEND'),
    'PLAN': ('server/modules/enterprise-api/tests/entitlements.integration.test.ts', PG, 'INFERRED'),
    'E02b': ('server/modules/enterprise-persistence/tests/enterprise.integration.test.ts', PG, 'INFERRED'),
}
OPS_UNIT = 'server/modules/enterprise-persistence/tests/ops-report-v1.test.ts'
OPS_PG = 'server/modules/enterprise-api/tests/ops-report.integration.test.ts'
ACC_UNIT = 'server/modules/enterprise-persistence/tests/reconciliation-acc-match-v1.test.ts'
# 明確對照：(檔案, 測試標題片段)。片段必須在檔案中存在。
EXPLICIT = {
    'OP-UAT-09': [(OPS_UNIT, '正常週：14 項主張'), (OPS_PG, '正常週：14 項主張由伺服器計算')],
    'OP-UAT-11': [(OPS_UNIT, '缺欄位：識別／owner 欄空白拒收'), (OPS_PG, '拒收留痕：結構錯誤')],
    'OP-UAT-14': [(OPS_UNIT, '正常週：14 項主張'), (OPS_UNIT, 'ROUND_HALF_UP 與符號'), (OPS_PG, '正常週：14 項主張由伺服器計算')],
    'OP-UAT-15': [(OPS_UNIT, '正常週：14 項主張')],
    'OP-UAT-16': [(OPS_UNIT, '缺欄位：識別／owner 欄空白拒收'), (OPS_UNIT, '正常週：14 項主張')],
    'OP-UAT-17': [(OPS_UNIT, '重複來源（OP-NEG-02）'), (OPS_PG, '來源衝突與多來源')],
    'OP-UAT-18': [(OPS_UNIT, '敘述驗證（模型只寫文字）')],
    'OP-UAT-21': [(OPS_UNIT, '敘述驗證（模型只寫文字）')],
    'OP-UAT-35': [(OPS_UNIT, '跨月週與 ISO 週邊界'), (OPS_UNIT, '錯誤期間'), (OPS_PG, '正常週：14 項主張由伺服器計算')],
    'ACC-UAT-03': [(ACC_UNIT, '固定 fixture：9 案件')], 'ACC-UAT-04': [(ACC_UNIT, '固定 fixture：9 案件')], 'ACC-UAT-05': [(ACC_UNIT, '固定 fixture：9 案件')],
    'ACC-UAT-06': [(ACC_UNIT, '固定 fixture：9 案件')], 'ACC-UAT-07': [(ACC_UNIT, '固定 fixture：9 案件')],
    'ACC-UAT-14': [('server/modules/enterprise-api/tests/reconciliation-export.integration.test.ts', '三種格式：內容 SHA-256 與標頭一致')],
}
RUNNER_OF = {OPS_UNIT: NODE, ACC_UNIT: NODE}
TITLE = re.compile(r"""\b(?:test|it|describe)\(\s*(['"`])((?:\\.|(?!\1).)*)\1""")


def titles(path):
    text = (ROOT / path).read_text(encoding='utf-8', errors='replace')
    return [match.group(2) for match in TITLE.finditer(text)]


def runner_for(path):
    if path in RUNNER_OF:
        return RUNNER_OF[path]
    if path.endswith('.integration.test.ts'):
        return PG
    if path.endswith('.test.tsx') or path.startswith('src/'):
        return VITEST
    if path.endswith('.test.ts'):
        return NODE
    if 'e2e' in path:
        return DLV
    return LOCAL


def requirements(directory):
    if not directory:
        return {}
    base = Path(directory)
    found = {}
    import csv
    with open(base / '營運週報/UAT驗收表.csv', encoding='utf-8') as handle:
        for row in csv.DictReader(handle):
            found[row['案例ID']] = row['預期結果']
    for name, pattern, column in [('會計對帳/UAT與驗收紀錄.md', r'ACC-UAT-\d\d', 3), ('契約比對/UAT與交付邊界.md', r'UAT-L\d\d', 3)]:
        for line in (base / name).read_text(encoding='utf-8').splitlines():
            cells = [cell.strip() for cell in line.strip().strip('|').split('|')]
            if cells and re.match(pattern, cells[0]) and len(cells) > column:
                found[re.match(pattern, cells[0]).group(0)] = cells[column]
    return {key: re.sub(r'(?<!主)張', '［角色］', value) for key, value in found.items()}


ALL_TITLES = {}
for _file in sorted([*ROOT.glob('server/**/*.test.ts'), *ROOT.glob('src/**/*.test.ts'), *ROOT.glob('src/**/*.test.tsx')]):
    if 'node_modules' not in _file.parts:
        ALL_TITLES[str(_file.relative_to(ROOT))] = titles(str(_file.relative_to(ROOT)))


def build(args):
    trace = json.loads(TRACE.read_text())
    reqs = requirements(args.requirements)
    title_cache = {}
    problems = []
    rows = []
    for row in trace['rows']:
        note = row['v5_note']
        evidence = {}

        def add(path, runner, alias=None, resolution=None, names=None):
            if not (ROOT / path).exists():
                problems.append(f"{row['id']}: 證據檔不存在 {path}")
                return
            item = evidence.setdefault(path, {'path': path, 'runner': runner[0], 'ci_job': runner[1], 'artifact': runner[2], 'aliases': [], 'test_names': []})
            if alias:
                item['aliases'].append({'alias': alias, 'resolution': resolution})
            for name in names or []:
                if name not in item['test_names']:
                    item['test_names'].append(name)

        for alias, (path, runner, resolution) in ALIASES.items():
            if re.search(rf'(?<![A-Za-z0-9]){re.escape(alias)}(?![A-Za-z0-9])', note):
                add(path, runner, alias, resolution)
        for path in sorted(set(re.findall(r'((?:server|src|tests|scripts)/[\w./\-一-鿿]+?\.(?:test\.tsx?|integration\.test\.ts|mjs|py))', note))):
            add(path, runner_for(path))
        for path in row.get('evidence', []):
            add(path, runner_for(path))
        for path, fragment in EXPLICIT.get(row['id'], []):
            names = title_cache.setdefault(path, titles(path))
            hit = [name for name in names if fragment in name]
            if not hit:
                problems.append(f"{row['id']}: {path} 找不到測試標題片段「{fragment}」")
                continue
            add(path, runner_for(path), names=hit[:1])
        # 全 repo 測試標題掃描：標題直接引用該 UAT ID 者一律連結（不限於說明中出現的檔案）。
        for path, names in ALL_TITLES.items():
            hit = [name for name in names if re.search(rf'{re.escape(row["id"])}(?!\d)', name)]
            if hit:
                add(path, runner_for(path), names=hit)
        items = list(evidence.values())
        if row['v5_status'] in ('NOT_IMPLEMENTED', 'CUSTOMER_UAT_PENDING') or not items:
            status = 'EVIDENCE_MISSING'
        elif any(item['test_names'] for item in items):
            status = 'LINKED_TEST'
        else:
            status = 'FILE_LEVEL'
        if args.verify_run or args.image_run:
            for item in items:
                run = args.image_run if item['runner'] == 'delivery' else (args.verify_run if item['runner'] != 'local-harness' else None)
                item['ci_run'] = run
                item['ci_run_url'] = f'https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/{run}' if run else None
        rows.append({
            'id': row['id'], 'requirement': reqs.get(row['id']), 'v4_status': row['v4_status'], 'builder_status': row['v5_status'],
            'customer_status': 'REQUIRED_PENDING' if row['v5_status'] == 'CUSTOMER_UAT_PENDING' else 'PENDING', 'pass': False,
            'evidence_status': status, 'missing_reason': (row['v5_status'] if status == 'EVIDENCE_MISSING' and items else ('NO_EVIDENCE_REFERENCE' if not items else None)),
            'source_version': args.product_sha, 'note': note, 'evidence': items,
        })
    counts = {}
    for row in rows:
        counts[row['evidence_status']] = counts.get(row['evidence_status'], 0) + 1
    data = {'schema_version': 1, 'source': 'docs/enterprise/uat/UAT_TRACEABILITY_V5.json＋證據代號圖例（UAT_MATRIX V4）＋EXPLICIT 對照', 'product_sha': args.product_sha,
            'verify_run': args.verify_run, 'image_run': args.image_run, 'total_ids': len(rows), 'evidence_status_counts': counts,
            'builder_status_counts': trace['totals']['v5'], 'pass_count': 0,
            'legend': {k: {'path': v[0], 'runner': v[1][0], 'resolution': v[2]} for k, v in ALIASES.items()},
            'rules': ['LINKED_TEST：至少一個測試標題引用該 ID 或屬明確對照', 'FILE_LEVEL：只有檔案層級對應（舊矩陣代號）', 'EVIDENCE_MISSING：無證據或狀態為 NOT_IMPLEMENTED／CUSTOMER_UAT_PENDING',
                      'local-harness（SEC）不在 CI 執行；其證據為 V4 RC 本機歷史', 'builder_status 是 Builder 工程驗證，不是客戶 UAT；pass 一律 false'],
            'rows': rows}
    return data, problems


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--product-sha')
    parser.add_argument('--verify-run')
    parser.add_argument('--image-run')
    parser.add_argument('--requirements')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--out', default=str(OUT))
    args = parser.parse_args()
    data, problems = build(args)
    if problems:
        print(json.dumps({'problems': problems}, ensure_ascii=False, indent=1))
        return 1
    if not args.check:
        Path(args.out).write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({'total': data['total_ids'], 'evidence_status_counts': data['evidence_status_counts']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
