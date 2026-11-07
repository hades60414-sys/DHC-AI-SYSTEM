"""V5.3.1 WP4：check_state.py 的負向測試——在暫存複本中竄改狀態，驗證器必須拒絕。
- 一般案例：只複製 coordination 目錄到暫存區，以 --coord 指向它（registry 仍讀 repo）。
- git 案例（需要完整 git 歷史，CI 會 fetch-depth: 0）：以真實歷史證明「文件 SHA／證據 SHA／產品 SHA 混用」會被拒。
"""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CHECK = ROOT / 'scripts/enterprise/coordination/check_state.py'
COORD = ROOT / 'docs/enterprise/coordination'
OLD_PR13 = '601dbb3ee1d75f94ce75947af6e1cb2eea17661c'  # 早於 V5.3 的 E2E／collector／狀態腳本
OLD_PRODUCT = '6933d5e17f1120d87126df598c594c31b4e474ed'  # V5.1 產品，之後 V5.2 改了產品程式


def first(ledger, **match):
    return next(f for f in ledger['findings'] if all(f.get(k) == v for k, v in match.items()))


CASES = {
    'builder_claims_audit_verified': (False, lambda s, l, e: first(l, id='ASTRA-ROLL-001').update(builder_status='AUDIT_VERIFIED')),
    'auditor_verified_without_pass': (False, lambda s, l, e: first(l, id='ASTRA-ROLL-001').update(closure_class='AUDITOR_VERIFIED')),
    'auditor_receipt_unknown_hash': (False, lambda s, l, e: first(l, id='RG-006')['auditor_receipt'].update(source_sha256='f' * 64)),
    'invented_finding_id': (False, lambda s, l, e: first(l, id='ASTRA-ROLL-001').update(id='NEW-999')),
    'unknown_closure_class': (False, lambda s, l, e: first(l, id='RG-001').update(closure_class='DONE')),
    'unrated_downgraded_to_low_hidden': (False, lambda s, l, e: s.update(open_unrated_historical=[])),
    'stale_fingerprint': (True, lambda s, l, e: s.update(evidence_fingerprint='0' * 64)),
    'bad_product_sha': (True, lambda s, l, e: s['shas'].update(product_sha='d38afd8')),
    'missing_sha_role': (True, lambda s, l, e: s['shas'].pop('artifact_source_sha')),
    'missing_state_field': (True, lambda s, l, e: s.pop('next_safe_action')),
    'hidden_high': (True, lambda s, l, e: s.update(open_critical_high=[])),
    'fixed_without_verification_sha': (False, lambda s, l, e: first(l, id='ASTRA-ROLL-001').update(verification_sha=None)),
    'evidence_sha_not_in_sources': (True, lambda s, l, e: s['shas']['ci_evidence_sha'].update(office_e2e_evidence=OLD_PR13)),
    'pending_rerun_but_ready': (True, lambda s, l, e: (e['evidence']['negative_gate_evidence'].update(pending_rerun=True), s.update(ci_status='CI_EVIDENCE_READY'))),
    'pr14_missing_from_stack': (True, lambda s, l, e: s.update(pr_stack=[p for p in s['pr_stack'] if p.get('pr') != 14])),
    'builder_claims_auditor_status_verified': (True, lambda s, l, e: s.update(auditor_status='AUDIT_VERIFIED')),
}
def forge_pass(s, l, e):
    """OCR-V531-01：把 Auditor 判定 FAIL 的 HIGH 偽造成 PASS，並同步 STATE 的推導欄位（完整偽造）。"""
    item = first(l, id='ASTRA-ROLL-001')
    item.update(auditor_status='PASS', auditor_problem_state='AUDIT_VERIFIED', closure_class='AUDITOR_VERIFIED')
    resync(s, l)


def downgrade(s, l, e):
    """OCR-V531-02：把 HIGH 降為 LOW 以移出 open_critical_high。"""
    first(l, id='ASTRA-ROLL-002').update(severity='LOW')
    resync(s, l)


def resync(s, l):
    s['open_critical_high'] = sorted(f['id'] for f in l['findings'] if f['severity'] in ('CRITICAL', 'HIGH') and f['closure_class'] != 'AUDITOR_VERIFIED')
    classes = sorted({f['closure_class'] for f in l['findings']} | set(s['closure_counts']))
    s['closure_counts'] = {c: sum(1 for f in l['findings'] if f['closure_class'] == c) for c in classes}


CASES['forged_auditor_pass_full_resync'] = (False, forge_pass)
CASES['severity_downgrade_full_resync'] = (False, downgrade)
GIT_CASES = {
    # 證據 SHA 早於 E2E driver 的建立 → depends_on 在其後有變更 → 證據過期
    'evidence_older_than_its_test_code': lambda s, l, e: (e['evidence']['office_e2e_evidence'].update(sha=OLD_PR13), s['shas']['ci_evidence_sha'].update(office_e2e_evidence=OLD_PR13)),
    # product_sha 指向 V5.1，之後產品程式有變更
    'product_sha_stale': lambda s, l, e: s['shas'].update(product_sha=OLD_PRODUCT),
    # 文件 head 指向 #13，之後有程式／workflow 變更 → 文件版本與證據 SHA 混用
    'doc_head_before_code_changes': lambda s, l, e: (s['shas'].update(pr_head_sha=OLD_PR13, documentation_head_sha=OLD_PR13),
                                                     [p.update(head=OLD_PR13) for p in s['pr_stack'] if p.get('pr') == 14]),
}


def run_case(mutate, refingerprint, git_mode):
    with tempfile.TemporaryDirectory() as tmp:
        coord = Path(tmp) / 'coordination'
        shutil.copytree(COORD, coord)
        state = json.loads((coord / 'STATE.json').read_text())
        ledger = json.loads((coord / 'FINDING_LEDGER.json').read_text())
        sources = json.loads((coord / 'EVIDENCE_SOURCES.json').read_text())
        mutate(state, ledger, sources)
        text = json.dumps(ledger, ensure_ascii=False, indent=1) + '\n'
        (coord / 'FINDING_LEDGER.json').write_text(text)
        if refingerprint and 'evidence_fingerprint' in state and state['evidence_fingerprint'] != '0' * 64:
            state['evidence_fingerprint'] = hashlib.sha256(text.encode()).hexdigest()
        (coord / 'STATE.json').write_text(json.dumps(state, ensure_ascii=False, indent=1) + '\n')
        (coord / 'EVIDENCE_SOURCES.json').write_text(json.dumps(sources, ensure_ascii=False, indent=1) + '\n')
        command = [sys.executable, '-B', str(CHECK), '--coord', str(coord)] + (['--require-git'] if git_mode else [])
        return subprocess.run(command, capture_output=True, text=True)


failures = []
baseline = subprocess.run([sys.executable, '-B', str(CHECK), '--require-git'], capture_output=True, text=True)
git_available = '不是完整 git 歷史' not in baseline.stdout
print(f'baseline: exit={baseline.returncode} {baseline.stdout.strip()[:160]}')
if baseline.returncode != 0 and git_available:
    failures.append('baseline')
for name, (state_only, mutate) in CASES.items():
    result = run_case(mutate, refingerprint=True, git_mode=False)
    if result.returncode == 0:
        failures.append(name)
    print(f"{name}: exit={result.returncode} {result.stdout.strip()[:150]}")
if git_available:
    for name, mutate in GIT_CASES.items():
        result = run_case(mutate, refingerprint=True, git_mode=True)
        if result.returncode == 0:
            failures.append(name)
        print(f"{name}: exit={result.returncode} {result.stdout.strip()[:170]}")
elif '--require-git' in sys.argv:
    failures.append('git history unavailable')
else:
    print('SKIP git 案例：沒有完整 git 歷史（CI 必帶 --require-git）')


def clone_case(name, rel_path, edit, expect_fail):
    """OCR-V531-03：在暫存 clone 中真的 commit 一個變更，確認 pr_head 之後的『非文件』變更（含 golden fixture）會被擋，純文件變更不會。"""
    with tempfile.TemporaryDirectory() as tmp:
        clone = Path(tmp) / 'repo'
        repo_root = ROOT.parent
        subprocess.run(['git', 'clone', '-q', '--no-hardlinks', str(repo_root), str(clone)], check=True)
        subprocess.run(['git', '-C', str(clone), 'checkout', '-q', subprocess.run(['git', '-C', str(repo_root), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()], check=True)
        target = clone / rel_path
        before = target.read_text()
        target.write_text(edit(before))
        assert target.read_text() != before, f'{name}: 編輯沒有改到內容'
        env = {'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.invalid', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.invalid', 'PATH': '/usr/bin:/bin:/usr/local/bin'}
        subprocess.run(['git', '-C', str(clone), '-c', 'commit.gpgsign=false', 'commit', '-qam', name], check=True, env=env)
        # 以「目前工作樹的檢查器」檢查 clone 的歷史與狀態檔
        result = subprocess.run([sys.executable, '-B', str(CHECK), '--require-git', '--web-root', str(clone / 'web-ui')], capture_output=True, text=True)
        ok = (result.returncode != 0) == expect_fail
        print(f"{name}: exit={result.returncode} expect_fail={expect_fail} {result.stdout.strip()[:170]}")
        return ok


if git_available:
    golden = 'web-ui/docs/enterprise/scenarios/會計對帳/golden/跨側同列ID_預期.json'
    if not clone_case('golden_fixture_changed_after_pr_head', golden, lambda t: t.replace('"isolatedLedgerMinor": "3000"', '"isolatedLedgerMinor": "103000"', 1), True):
        failures.append('golden_fixture_changed_after_pr_head')
    if not clone_case('docs_only_change_after_pr_head_positive', 'web-ui/docs/enterprise/coordination/CHANGELOG.md', lambda t: t + '\n- test\n', False):
        failures.append('docs_only_change_after_pr_head_positive')
print('OK' if not failures else f'FAILED: {failures}')
sys.exit(1 if failures else 0)
