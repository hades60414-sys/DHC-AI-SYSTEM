"""V5.3.1 Maintenance：Evidence Index 自我驗證（唯讀）。
檢查：51 項唯一 ID、與 FINDING_LEDGER 的 ID／closure_class／auditor_status 一致；24 項有逐項 CI 證據；
其餘 27 項必須有「沒有逐項的測試對應」或「沒有修正」的限制說明；artifact 到期狀態與 GitHub API（art_<run>.json）一致；
並以產生器重產一次，比對與已提交檔案位元相同（可重現）。
用法（web-ui 目錄）：python3 -B docs/enterprise/v531_maintenance/tools/validate_evidence_index.py <artifact-json 目錄> [--now <UTC ISO>]
"""
import datetime
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent
ROOT = HERE.parents[3]
ART = Path(sys.argv[1])
now = sys.argv[sys.argv.index('--now') + 1] if '--now' in sys.argv else datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
problems, report = [], {}
index = json.loads((OUT / 'EVIDENCE_INDEX.json').read_text())['findings']
ledger = {f['id']: f for f in json.loads((ROOT / 'docs/enterprise/coordination/FINDING_LEDGER.json').read_text())['findings']}
ids = [i['finding_id'] for i in index]
report['total'] = len(ids)
if len(ids) != 51 or len(set(ids)) != 51:
    problems.append(f'Finding 數量或唯一性錯誤：{len(ids)} 筆、{len(set(ids))} 個唯一 ID')
if set(ids) != set(ledger):
    problems.append(f'與 ledger ID 不一致：{sorted(set(ids) ^ set(ledger))}')
for i in index:
    f = ledger.get(i['finding_id'], {})
    for key in ('closure_class', 'auditor_status', 'severity'):
        if i[key] != f.get(key):
            problems.append(f"{i['finding_id']}: {key} 與 ledger 不符（Index 不得改判）")
with_evidence = [i for i in index if i['current_evidence']]
without = [i for i in index if not i['current_evidence']]
report['with_current_evidence'], report['without_current_evidence'] = len(with_evidence), len(without)
if (len(with_evidence), len(without)) != (24, 27):
    problems.append(f'逐項證據數量 {len(with_evidence)}／{len(without)}，預期 24／27')
for i in without:
    if not any(('沒有逐項的測試對應' in l) or ('沒有修正' in l) for l in i['limitations']):
        problems.append(f"{i['finding_id']}: 沒有逐項證據，卻缺少限制說明")
api = {}
for p in ART.glob('art_*.json'):
    api.update({a['id']: a for a in json.loads(p.read_text())['artifacts']})
expiry = {'expired': [], 'expires_within_24h': [], 'ok': 0}
limit = (datetime.datetime.fromisoformat(now.replace('Z', '+00:00')) + datetime.timedelta(hours=24)).isoformat()
for i in index:
    for c in i['current_evidence']:
        a = api.get(c['artifact_id'])
        if a is None:
            problems.append(f"{i['finding_id']}: artifact {c['artifact_id']} 不在 API 快照")
            continue
        if a['expires_at'] != c['expires_at'] or a['expired'] != c['expired']:
            problems.append(f"{i['finding_id']}: artifact {c['artifact_id']} 到期資訊與 API 不符")
        stamp = a['expires_at'].replace('Z', '+00:00')
        if a['expired'] or stamp <= now.replace('Z', '+00:00'):
            expiry['expired'].append(c['artifact_id'])
        elif stamp <= limit:
            expiry['expires_within_24h'].append(c['artifact_id'])
        else:
            expiry['ok'] += 1
expiry['expired'] = sorted(set(expiry['expired']))
expiry['expires_within_24h'] = sorted(set(expiry['expires_within_24h']))
report['artifact_expiry_at'] = now
report['artifact_expiry'] = expiry
with tempfile.TemporaryDirectory() as tmp:
    copy = Path(tmp) / 'web-ui'
    for rel in ['docs/enterprise/coordination', 'docs/enterprise/v53', 'docs/enterprise/v531_maintenance']:
        shutil.copytree(ROOT / rel, copy / rel)
    result = subprocess.run([sys.executable, '-B', str(copy / 'docs/enterprise/v531_maintenance/tools/build_evidence_index.py'), str(ART)], capture_output=True, text=True)
    same = result.returncode == 0 and all((copy / 'docs/enterprise/v531_maintenance' / n).read_bytes() == (OUT / n).read_bytes() for n in ('EVIDENCE_INDEX.json', 'EVIDENCE_INDEX.md'))
    report['regenerated_identical'] = same
    if not same:
        problems.append(f'產生器重產結果與已提交的檔案不同：{result.stderr[-200:]}')
report['status'] = 'PASS' if not problems else 'FAIL'
report['problems'] = problems
print(json.dumps(report, ensure_ascii=False, indent=1))
sys.exit(1 if problems else 0)
