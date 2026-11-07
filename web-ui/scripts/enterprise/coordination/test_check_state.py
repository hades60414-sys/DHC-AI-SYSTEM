"""V5.3 WP4：check_state.py 的負向測試——在暫存複本中竄改狀態，驗證器必須拒絕。"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CASES = {
    'builder_claims_audit_verified': lambda s, l: l['findings'][0].update(builder_status='AUDIT_VERIFIED'),
    'auditor_verdict_without_receipt': lambda s, l: l['findings'][0].update(auditor_status='AUDIT_VERIFIED', auditor_receipt=None),
    'invented_finding_id': lambda s, l: l['findings'][0].update(id='NEW-999'),
    'stale_fingerprint': lambda s, l: s.update(evidence_fingerprint='0' * 64),
    'bad_sha': lambda s, l: s.update(product_sha='d38afd8'),
    'missing_state_field': lambda s, l: s.pop('next_safe_action'),
    'hidden_high': lambda s, l: s.update(open_critical_high=[]),
    'fixed_without_verification_sha': lambda s, l: l['findings'][0].update(verification_sha=None),
}
failures = []
for name, mutate in CASES.items():
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        for rel in ['scripts/enterprise/coordination/check_state.py', 'docs/enterprise/coordination', 'docs/enterprise/v51/REPOGUARD_FINDINGS_DISPOSITION.json', 'docs/enterprise/v52/ASTRA_ROLL_REMEDIATION_MATRIX.json']:
            src, dst = ROOT / rel, base / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            (shutil.copytree if src.is_dir() else shutil.copy)(src, dst)
        coord = base / 'docs/enterprise/coordination'
        state = json.loads((coord / 'STATE.json').read_text())
        ledger = json.loads((coord / 'FINDING_LEDGER.json').read_text())
        mutate(state, ledger)
        if name not in ('stale_fingerprint', 'hidden_high', 'bad_sha', 'missing_state_field'):
            # 竄改 ledger 後重新計算 fingerprint，確保失敗原因是規則本身而不是 fingerprint
            text = json.dumps(ledger, ensure_ascii=False, indent=1) + '\n'
            (coord / 'FINDING_LEDGER.json').write_text(text)
            import hashlib
            state['evidence_fingerprint'] = hashlib.sha256(text.encode()).hexdigest()
        (coord / 'STATE.json').write_text(json.dumps(state, ensure_ascii=False, indent=1) + '\n')
        result = subprocess.run([sys.executable, '-B', str(base / 'scripts/enterprise/coordination/check_state.py')], capture_output=True, text=True)
        if result.returncode == 0:
            failures.append(name)
        print(f"{name}: exit={result.returncode} {result.stdout.strip()[:160]}")
print('OK' if not failures else f'FAILED: {failures}')
sys.exit(1 if failures else 0)
