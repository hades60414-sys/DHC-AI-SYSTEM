"""V5.3 WP4：共享工程狀態的 schema 與一致性檢查（CI 執行）。
- STATE.json／FINDING_LEDGER.json 必填欄位、SHA 格式、狀態列舉。
- Builder 狀態不得為 AUDIT_VERIFIED；Auditor 狀態含 AUDIT_VERIFIED 時必須有 auditor_receipt（auditor、source_sha256、generated_at）。
- 每個 Finding 的 ID 必須存在於其 registry（repo 內 registry 實際比對；Astra snapshot 必須帶來源 SHA-256）。
- STATE.evidence_fingerprint 必須等於 FINDING_LEDGER.json 的 SHA-256（狀態不可過期）；open_critical_high 必須與 ledger 推導一致。
用法：python3 -B scripts/enterprise/coordination/check_state.py
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
COORD = ROOT / 'docs/enterprise/coordination'
SHA = re.compile(r'^[0-9a-f]{40}$')
BUILDER = {'FIXED_PENDING_REAUDIT', 'WORK_ORDER_ISSUED', 'HUMAN_DECISION_REQUIRED', 'BLOCKED_DECISION', 'OPEN', 'ACCEPTED', 'DEFERRED'}
SEVERITY = {'CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNRATED_IN_SNAPSHOT'}
STATE_KEYS = ['schema_version', 'repo', 'pr_stack', 'product_sha', 'head_sha', 'base_sha', 'builder_commit', 'auditor_last_reviewed_sha', 'ci', 'open_critical_high',
              'builder_status', 'auditor_status', 'human_decisions', 'evidence_fingerprint', 'last_updated_utc', 'next_safe_action']
FINDING_KEYS = ['id', 'registry', 'severity', 'builder_status', 'auditor_status', 'root_cause', 'fix_commit', 'regression', 'verification_sha', 'evidence', 'owner', 'recheck_trigger']
problems = []
state = json.loads((COORD / 'STATE.json').read_text())
ledger_text = (COORD / 'FINDING_LEDGER.json').read_text()
ledger = json.loads(ledger_text)
for key in STATE_KEYS:
    if key not in state:
        problems.append(f'STATE 缺 {key}')
for key in ['product_sha', 'head_sha', 'base_sha', 'builder_commit']:
    if not SHA.match(str(state.get(key, ''))):
        problems.append(f'STATE.{key} 不是 40 字元 SHA')
if state.get('builder_status') not in ('BUILDER_IN_PROGRESS', 'BUILDER_SUBMITTED'):
    problems.append('STATE.builder_status 非法')
if 'VERIFIED' in str(state.get('auditor_status')) and not state.get('auditor_snapshot_sha256'):
    problems.append('STATE.auditor_status 宣稱 verified 但沒有 Auditor 收據雜湊')
if state.get('evidence_fingerprint') != hashlib.sha256(ledger_text.encode()).hexdigest():
    problems.append('STATE.evidence_fingerprint 與 FINDING_LEDGER.json 不符（狀態過期）')
registries = {}
seen = set()
for finding in ledger['findings']:
    fid = finding.get('id')
    for key in FINDING_KEYS:
        if key not in finding:
            problems.append(f'{fid}: 缺 {key}')
    if fid in seen:
        problems.append(f'{fid}: 重複')
    seen.add(fid)
    if finding.get('builder_status') not in BUILDER:
        problems.append(f"{fid}: builder_status 非法 {finding.get('builder_status')}（Builder 不得標 AUDIT_VERIFIED）")
    if finding.get('severity') not in SEVERITY:
        problems.append(f"{fid}: severity 非法 {finding.get('severity')}")
    if 'AUDIT_VERIFIED' in str(finding.get('auditor_status')):
        receipt = finding.get('auditor_receipt') or {}
        if not receipt.get('auditor') or not re.match(r'^[0-9a-f]{64}$', str(receipt.get('source_sha256', ''))) or not receipt.get('generated_at'):
            problems.append(f'{fid}: AUDIT_VERIFIED 沒有可校驗的 Auditor 收據')
    if finding.get('auditor_status') not in (None, 'NOT_YET_REVIEWED') and not (finding.get('auditor_receipt') or {}).get('source_sha256'):
        problems.append(f'{fid}: 有 Auditor 判定但沒有來源 SHA-256')
    if finding.get('builder_status') == 'FIXED_PENDING_REAUDIT' and not SHA.match(str(finding.get('verification_sha') or '')):
        problems.append(f'{fid}: FIXED_PENDING_REAUDIT 需要 verification_sha')
    registry = str(finding.get('registry', '')).split('#')[0]
    path = ROOT / registry
    if not path.exists():
        problems.append(f'{fid}: registry 不存在 {registry}')
        continue
    if registry not in registries:
        data = json.loads(path.read_text())
        ids = {f['id'] for f in data.get('findings', [])} | {f['id'] for f in data.get('original_18', [])}
        registries[registry] = ids
    if fid not in registries[registry]:
        problems.append(f'{fid}: 不在 registry {registry}（不得另立 ID）')
derived = sorted(f['id'] for f in ledger['findings'] if f['severity'] in ('CRITICAL', 'HIGH') and 'AUDIT_VERIFIED' not in str(f['auditor_status']))
if sorted(state.get('open_critical_high', [])) != derived:
    problems.append(f"STATE.open_critical_high 與 ledger 推導不一致：{derived}")
print(json.dumps({'status': 'FAIL' if problems else 'PASS', 'findings': len(ledger['findings']), 'problems': problems[:30]}, ensure_ascii=False))
sys.exit(1 if problems else 0)
