"""V5.3 WP4：由既有 Finding 登錄檔機械產生共享工程狀態（不建立新的 Finding ID 系統）。
來源：
- docs/enterprise/v51/REPOGUARD_FINDINGS_DISPOSITION.json（RG-V5-*、BD-*）
- docs/enterprise/v52/ASTRA_ROLL_REMEDIATION_MATRIX.json（ASTRA-ROLL-*、RG-001..008）
- docs/enterprise/coordination/AUDITOR_SNAPSHOT.json（Astra 判定抄錄，含來源 SHA-256；Builder 不改判）
- 本檔的 V53_UPDATES（V5.3 新增的證據）與 --ci 參數。
用法：python3 -B scripts/enterprise/coordination/build_state.py --product-sha SHA --base-sha SHA --pr-head-sha <產生時 HEAD>（證據來源見 EVIDENCE_SOURCES.json）
輸出：docs/enterprise/coordination/FINDING_LEDGER.json、STATE.json（evidence_fingerprint＝FINDING_LEDGER.json 的 SHA-256）。
"""
import argparse
import datetime
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
COORD = ROOT / 'docs/enterprise/coordination'
V51 = 'docs/enterprise/v51/REPOGUARD_FINDINGS_DISPOSITION.json'
V52 = 'docs/enterprise/v52/ASTRA_ROLL_REMEDIATION_MATRIX.json'
SNAP = 'docs/enterprise/coordination/AUDITOR_SNAPSHOT.json'
SOURCES = 'docs/enterprise/coordination/EVIDENCE_SOURCES.json'
# 里程碑固定的 PR #14 稽核快照 HEAD（與 check_state.py PINNED_PR14_HEAD 一致）
PINNED_PR14_HEAD = '38c7293d3764f61a967b2bd2e90526e218b77793'
CLOSURE_CLASSES = ['AUDITOR_VERIFIED', 'BUILDER_FIXED_PENDING_REAUDIT', 'NOT_IMPLEMENTED', 'HUMAN_DECISION_BLOCKED', 'EVIDENCE_MISSING', 'RETEST_REQUIRED']

# Builder 對根因的簡述（Astra 原文在其報告中，這裡不改寫 Auditor 判定）
ROOT_CAUSE = {
    'ASTRA-ROLL-001': 'workflow 預設 bash -e 無 pipefail；品質 step 以 || true＋| tee 收尾',
    'ASTRA-ROLL-002': 'useOfficeQuery 在 key 變更／失敗時仍回前一資源資料；動作以 selected id 搭配舊資料版號送出',
    'ASTRA-ROLL-003': '隔離集合以裸 rowId 混合兩側',
    'ASTRA-ROLL-004': 'CSV parser 離開引號狀態後直接接字元',
    'ASTRA-ROLL-005': '幣別查表以 obj[key] 命中原型鍵',
    'ASTRA-ROLL-006': '期間只驗格式，非法日期在 DB cast 才失敗',
    'ASTRA-ROLL-007': 'selected_image 優先環境變數，與 assert_offline_images 驗證對象不同',
    'ASTRA-ROLL-008': 'vitest 退出碼被 || true 丟棄；JSON reporter 不含未處理例外',
    'ASTRA-ROLL-009': 'TAP skip／todo 計入 names；無 skip 許可清單',
    'ASTRA-ROLL-010': '每列 spread 複製陣列＋Array.includes（V5.1 已改）',
    'ASTRA-ROLL-011': '1970-W01 的前週超出 isoWeekRange 下限',
    'RG-003': 'workflow path filter／cwd 只涵蓋 web-ui',
    'RG-006': '台帳 after 停在 369837b',
    'RG-007': 'Dockerfile 寫死上游 dhc-cli 為 source label',
}
# V5.3 新增證據（GitHub run 由 --ci 帶入後解析）
V53_UPDATES = {
    'ASTRA-ROLL-002': {'regression_add': ['tests/enterprise/e2e/office_stale_e2e.mjs', 'scripts/enterprise/ci/office_e2e_redgreen.py'],
                       'evidence_add': ['ci:office_e2e_evidence（RED V5.1 image／GREEN 本次 image，真 Chromium＋PostgreSQL）', 'ci:image_build（delivery 兩架構 office-stale GREEN）']},
    'ASTRA-ROLL-001': {'regression_add': ['.github/workflows/negative-gate-evidence.yml', 'scripts/enterprise/ci/negative_gate_case.py'], 'evidence_add': ['ci:negative_gate_evidence（NEGATIVE_GATE_EVIDENCE.json）']},
    'ASTRA-ROLL-008': {'evidence_add': ['ci:negative_gate_evidence（frontend_exit1_all_pass、tool_nonzero_output_all_pass）']},
    'ASTRA-ROLL-009': {'evidence_add': ['ci:negative_gate_evidence（new_skip、new_todo）']},
    'ASTRA-ROLL-003': {'regression_add': ['docs/enterprise/scenarios/會計對帳/golden/跨側同列ID_預期.json', 'server/modules/enterprise-api/tests/reconciliation-export.integration.test.ts（golden 三格式）']},
    'ASTRA-ROLL-010': {'evidence_add': ['scripts/enterprise/ci/ops-resource-probe.ts same_site_conflict_50k（ms／cpu_ms／maxRSS）']},
}
CLOSED_FOR_COUNT = {'AUDIT_VERIFIED'}


def load(path):
    return json.loads((ROOT / path).read_text())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--product-sha', required=True)
    parser.add_argument('--base-sha', required=True)
    parser.add_argument('--pr-head-sha', required=True, help='產生本檔時 PR #14 的 HEAD（本檔所在 commit 之前）')
    args = parser.parse_args()
    v51, v52, snap = load(V51), load(V52), load(SNAP)
    sources = load(SOURCES)
    assert snap['schema_version'] == 2, 'AUDITOR_SNAPSHOT 必須是 schema 2（多報告）'
    reports = sorted(snap['reports'], key=lambda r: r['generated_at'])

    def receipt(report):
        return {'report_id': report['report_id'], 'auditor': report['auditor'], 'report_kind': report['report_kind'], 'generated_at': report['generated_at'],
                'source_file': report['source_file'], 'source_sha256': report['source_sha256']}

    latest = {}
    for report in reports:  # 後面的報告覆蓋前面的；歷史另存 auditor_history
        for group in ('findings', 'builder_tracker_items', 'original_18'):
            for item in report.get(group, []):
                status = item.get('auditor_status') or item.get('current_verdict') or (f"track_B {item.get('track_B_verdict')}（track_A {item.get('track_A_verdict')}）" if item.get('track_B_verdict') else None)
                latest.setdefault(item['id'], []).append({'status': status, 'problem_state': item.get('problem_state'), 'reviewed_sha': item.get('reviewed_sha') or item.get('track_B_sha'),
                                                          'severity': item.get('severity'), 'fix_commit_in_DAS': item.get('fix_commit_in_DAS'), 'receipt': receipt(report)})

    def auditor_fields(fid):
        history = latest.get(fid)
        if not history:
            return {'auditor_status': 'NOT_YET_REVIEWED', 'auditor_problem_state': None, 'auditor_reviewed_sha': None, 'auditor_receipt': None, 'auditor_history': []}
        last = history[-1]
        return {'auditor_status': last['status'], 'auditor_problem_state': last['problem_state'], 'auditor_reviewed_sha': last['reviewed_sha'], 'auditor_receipt': last['receipt'],
                'auditor_history': [{'report_id': h['receipt']['report_id'], 'status': h['status'], 'reviewed_sha': h['reviewed_sha']} for h in history]}

    def after_review(commits, reviewed_sha):
        """True＝修正 commit 不在 Auditor 審過的 SHA 之內（審核之後才修）。"""
        if not commits or not reviewed_sha:
            return None
        for commit in commits:
            if subprocess.run(['git', '-c', 'core.quotepath=false', 'merge-base', '--is-ancestor', commit, reviewed_sha], cwd=ROOT, capture_output=True).returncode != 0:
                return True
        return False

    def touched_after(commits, reviewed_sha):
        """Auditor PASS 之後，修正 commit 碰過的檔案是否又在 reviewed_sha..product_sha 被改（是＝PASS 不再直接適用）。"""
        if not commits or not reviewed_sha:
            return []
        files = set()
        for commit in commits:
            files |= set(subprocess.run(['git', '-c', 'core.quotepath=false', 'show', '--name-only', '--format=', commit], cwd=ROOT, capture_output=True, text=True).stdout.split())
        later = set(subprocess.run(['git', '-c', 'core.quotepath=false', 'diff', '--name-only', f'{reviewed_sha}..{args.product_sha}'], cwd=ROOT, capture_output=True, text=True).stdout.split())
        return sorted(f for f in files & later if not f.startswith('web-ui/docs/'))

    def closure(builder_status, auditor, commits):
        status, problem = str(auditor['auditor_status']), str(auditor['auditor_problem_state'])
        if builder_status in ('BLOCKED_DECISION', 'HUMAN_DECISION_REQUIRED'):
            return 'HUMAN_DECISION_BLOCKED'
        if builder_status in ('WORK_ORDER_ISSUED', 'OPEN'):
            return 'NOT_IMPLEMENTED'
        later = after_review(commits, auditor['auditor_reviewed_sha'])
        if later:
            return 'BUILDER_FIXED_PENDING_REAUDIT'
        if problem == 'AUDIT_VERIFIED' or status.startswith('PASS') or 'track_B PASS' in status:
            touched = touched_after(commits, auditor['auditor_reviewed_sha'])
            if touched:
                auditor['auditor_pass_invalidated_by'] = touched[:8]
                return 'RETEST_REQUIRED'
            return 'AUDITOR_VERIFIED'
        if 'NOT_RUN' in status:
            return 'EVIDENCE_MISSING'
        if auditor['auditor_status'] == 'NOT_YET_REVIEWED':
            return 'BUILDER_FIXED_PENDING_REAUDIT'
        return 'RETEST_REQUIRED'

    def short(value):
        return [c for c in re.findall(r'\b[0-9a-f]{7,40}\b', str(value or ''))]

    ledger = []
    for f in v52['findings']:
        fid = f['id']
        update = V53_UPDATES.get(fid, {})
        evidence = [e for e in [f.get('red'), f.get('evidence'), (f.get('ci') or {}).get('run')] if e] + update.get('evidence_add', [])
        auditor = auditor_fields(fid)
        ledger.append({'id': fid, 'registry': V52, 'severity': f['severity'], 'severity_source': 'auditor' if fid in latest else 'builder',
                       'builder_status': f['status'], 'closure_class': closure(f['status'], auditor, short(f.get('commit'))), **auditor,
                       'root_cause': ROOT_CAUSE.get(fid, f.get('note')), 'fix_commit': f.get('commit'), 'regression': list(f.get('tests', [])) + update.get('regression_add', []),
                       'verification_sha': v52['product_source_sha'] if f['status'] == 'FIXED_PENDING_REAUDIT' else None, 'evidence': evidence,
                       'owner': 'TAS Team' if fid in ('ASTRA-ROLL-012', 'ASTRA-ROLL-013', 'RG-002') else ('RD／Security owner' if fid == 'RG-001' else ('人類 owner（Security／Legal／Business）' if fid in ('RG-005', 'RG-008') else 'Builder')),
                       'recheck_trigger': '受影響程式／CI／fixture 變更，或新的固定 HEAD 有同 SHA CI 證據'})
    severity_v51 = {'RG-V5-01': 'HIGH', 'RG-V5-02': 'MEDIUM', 'RG-V5-03': 'LOW', 'RG-V5-04': 'MEDIUM', 'RG-V5-05': 'LOW', 'RG-V5-06': 'HIGH', 'RG-V5-07': 'MEDIUM'}
    status_map = {'FIXED': 'FIXED_PENDING_REAUDIT', 'MEASURED': 'FIXED_PENDING_REAUDIT', 'FAILED': 'OPEN', 'NOT_RUN': 'OPEN', 'WORK_ORDER_ISSUED': 'WORK_ORDER_ISSUED', 'BLOCKED_DECISION': 'BLOCKED_DECISION', 'PARTIAL': 'OPEN'}
    for f in v51['findings']:
        fid = f['id']
        builder = status_map.get(f['status'], 'OPEN')
        auditor = auditor_fields(fid)
        ledger.append({'id': fid, 'registry': V51, 'severity': severity_v51.get(fid, 'UNRATED_IN_REGISTRY'), 'severity_source': 'builder_assigned' if fid in severity_v51 else 'none_in_registry', 'builder_status': builder, 'closure_class': closure(builder, auditor, f.get('commits', [])), **auditor,
                       
                       'root_cause': f.get('root_cause') or f['title'], 'fix_commit': ', '.join(f.get('commits', [])) or None, 'regression': [e for e in f.get('evidence', []) if 'test' in e],
                       'verification_sha': v51['product_source_sha'] if builder == 'FIXED_PENDING_REAUDIT' else None, 'evidence': f.get('evidence', []),
                       'owner': 'TAS Team' if fid in ('RG-V5-06', 'RG-V5-07') else ('人類 owner' if builder == 'BLOCKED_DECISION' else 'Builder'),
                       'recheck_trigger': '受影響程式／CI 變更或新的固定 HEAD'})
    for o in reports[-1]['original_18']:
        fid = o['id']
        auditor = auditor_fields(fid)
        commits = short(o.get('fix_commit_in_DAS'))
        ledger.append({'id': fid, 'registry': SNAP + '#reports[*].original_18（Astra 原始 18 項；Builder 整改在 V4 RC-FIX）', 'severity': 'UNRATED_IN_SNAPSHOT',
                       'severity_note': '歷史報告未給嚴重度；保留未知，不推定為 LOW', 'severity_source': 'auditor', 'builder_status': 'FIXED_PENDING_REAUDIT', 'closure_class': closure('FIXED_PENDING_REAUDIT', auditor, commits), **auditor,
                        'root_cause': None, 'fix_commit': o.get('fix_commit_in_DAS'), 'regression': [],
                       'verification_sha': o.get('track_B_sha'), 'evidence': [SNAP], 'owner': 'Builder', 'recheck_trigger': 'Astra 下一輪 track 複驗'})
    ledger_doc = {'schema_version': 2, 'rules': ['Builder 最高只能標 FIXED_PENDING_REAUDIT', 'AUDITOR_VERIFIED 只能來自 Astra 報告（auditor_receipt.source_sha256 必填）',
                                                 'Finding ID 沿用各 registry，不另立 ID', 'closure_class 由 builder_status＋最新 Auditor 判定＋修正 commit 是否晚於審核 SHA 機械推導'],
                  'closure_classes': CLOSURE_CLASSES, 'findings': ledger}
    ledger_text = json.dumps(ledger_doc, ensure_ascii=False, indent=1) + '\n'
    (COORD / 'FINDING_LEDGER.json').write_text(ledger_text)
    high = sorted(f['id'] for f in ledger if f['severity'] in ('CRITICAL', 'HIGH') and f['closure_class'] != 'AUDITOR_VERIFIED')
    unrated_open = sorted(f['id'] for f in ledger if f['severity'] in ('UNRATED_IN_SNAPSHOT', 'UNRATED_IN_REGISTRY') and f['closure_class'] != 'AUDITOR_VERIFIED')
    counts = {c: sum(1 for f in ledger if f['closure_class'] == c) for c in CLOSURE_CLASSES}
    state = {
        'schema_version': 2, 'repo': 'hades60414-sys/DHC-AI-SYSTEM',
        'pr_stack': [{'pr': 10, 'head': '1e481e2fca812dcd2bfc45645623129bd7b54dea'}, {'pr': 11, 'head': '877525f27eed8d394f609d7ad7d2d8695be1035b'},
                     {'pr': 12, 'head': '2cc9e93e75133dc4247e7af3b959865cf8d9d05d'}, {'pr': 13, 'head': '601dbb3ee1d75f94ce75947af6e1cb2eea17661c'},
                     {'pr': 14, 'branch': 'fix/ai-office-v53-closure', 'head': PINNED_PR14_HEAD, 'head_note': '里程碑固定的 PR #14 稽核快照；shas.pr_head_sha 為產生本 STATE 的分支 HEAD（兩者語意不同）'}],
        'shas': {
            'product_sha': args.product_sha,
            'ci_evidence_sha': {name: src['sha'] for name, src in sources['evidence'].items()},
            'documentation_head_sha': args.pr_head_sha,
            'pr_head_sha': args.pr_head_sha,
            'base_sha': args.base_sha,
            'auditor_last_reviewed_sha': snap['latest_reviewed_sha'],
            'artifact_source_sha': sources['artifact_source_sha'],
        },
        'sha_rules': ['product_sha..HEAD 不得改產品路徑', '每個 ci_evidence_sha..HEAD 不得改該證據 depends_on 的路徑', 'pr_head_sha 必須是 HEAD 的祖先（或等於 HEAD）且其後只改文件／狀態',
                      'artifact_source_sha＝image label revision（CI_MATRIX／SUPPLY_CHAIN_PROVENANCE）'],
        'evidence_sources': 'EVIDENCE_SOURCES.json',
        'auditor_reports': [{'report_id': r['report_id'], 'generated_at': r['generated_at'], 'source_sha256': r['source_sha256'], 'reviewed_shas': r['reviewed_shas']} for r in reports],
        'auditor_coverage': snap['not_reviewed_by_auditor'],
        'open_critical_high': high, 'open_unrated_historical': unrated_open, 'closure_counts': counts,
        'builder_status': 'BUILDER_SUBMITTED', 'auditor_status': 'ASTRA_INDEPENDENT_REAUDIT_PENDING', 'ci_status': 'CI_PENDING' if any(src.get('pending_rerun') for src in sources['evidence'].values()) else 'CI_EVIDENCE_READY',
        'release_gates': {'customer_uat': 'CUSTOMER_UAT_NOT_APPROVED', 'commercial_release': 'COMMERCIAL_RELEASE_NO_GO'},
        'human_decisions': {key: 'PENDING' for key in ['SEC-01', 'SEC-02', 'DEC-05', 'DEC-07', 'SC-OWNER', 'UAT-66', 'RD-002', 'RD-003', 'IP-AGPL-SDK-DAS', 'SOW-PRICING-EXPIRY-MAINTENANCE']},
        'evidence_fingerprint': hashlib.sha256(ledger_text.encode()).hexdigest(),
        'last_updated_utc': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'next_safe_action': 'Astra 以唯讀方式複驗 product_sha 與 EVIDENCE_SOURCES 列出的 CI 證據；Builder 在收到 Auditor 收據前不改判、不推 #10～#13',
        'update_triggers': ['PR push', 'workflow completion', '明確人工 handoff'], 'no_background_poller': True,
    }
    (COORD / 'STATE.json').write_text(json.dumps(state, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({'findings': len(ledger), 'open_high': high, 'counts': counts, 'fingerprint': state['evidence_fingerprint'][:16]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
