"""V5.3 WP4：由既有 Finding 登錄檔機械產生共享工程狀態（不建立新的 Finding ID 系統）。
來源：
- docs/enterprise/v51/REPOGUARD_FINDINGS_DISPOSITION.json（RG-V5-*、BD-*）
- docs/enterprise/v52/ASTRA_ROLL_REMEDIATION_MATRIX.json（ASTRA-ROLL-*、RG-001..008）
- docs/enterprise/coordination/AUDITOR_SNAPSHOT.json（Astra 判定抄錄，含來源 SHA-256；Builder 不改判）
- 本檔的 V53_UPDATES（V5.3 新增的證據）與 --ci 參數。
用法：python3 -B scripts/enterprise/coordination/build_state.py --product-sha SHA --head-sha SHA --base-sha SHA [--ci name=run:attempt:artifact,...]
輸出：docs/enterprise/coordination/FINDING_LEDGER.json、STATE.json（evidence_fingerprint＝FINDING_LEDGER.json 的 SHA-256）。
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
COORD = ROOT / 'docs/enterprise/coordination'
V51 = 'docs/enterprise/v51/REPOGUARD_FINDINGS_DISPOSITION.json'
V52 = 'docs/enterprise/v52/ASTRA_ROLL_REMEDIATION_MATRIX.json'
SNAP = 'docs/enterprise/coordination/AUDITOR_SNAPSHOT.json'

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
    parser.add_argument('--head-sha', required=True)
    parser.add_argument('--base-sha', required=True)
    parser.add_argument('--ci', default='')
    args = parser.parse_args()
    ci = {}
    for item in filter(None, args.ci.split(',')):
        name, rest = item.split('=', 1)
        run, attempt, artifact = (rest.split(':') + ['', ''])[:3]
        ci[name] = {'run_id': run, 'attempt': attempt or None, 'artifact': artifact or None, 'url': f'https://github.com/hades60414-sys/DHC-AI-SYSTEM/actions/runs/{run}'}
    v51, v52, snap = load(V51), load(V52), load(SNAP)
    auditor = {f['id']: f for f in snap['findings']}
    original = {f['id']: f for f in snap['original_18']}
    provenance = {'auditor': snap['auditor'], 'source_file': snap['source_file'], 'source_sha256': snap['source_sha256'], 'generated_at': snap['generated_at'], 'report_kind': snap['report_kind']}
    ledger = []

    def auditor_fields(fid):
        if fid in auditor:
            a = auditor[fid]
            return {'auditor_status': a['auditor_status'], 'auditor_reviewed_sha': a['reviewed_sha'], 'auditor_receipt': provenance}
        if fid in original:
            o = original[fid]
            return {'auditor_status': f"track_B {o['track_B_verdict']}（track_A {o['track_A_verdict']}）", 'auditor_reviewed_sha': o['track_B_sha'], 'auditor_receipt': provenance}
        return {'auditor_status': 'NOT_YET_REVIEWED', 'auditor_reviewed_sha': None, 'auditor_receipt': None}

    for f in v52['findings']:
        fid = f['id']
        update = V53_UPDATES.get(fid, {})
        evidence = [e for e in [f.get('red'), f.get('evidence'), (f.get('ci') or {}).get('run')] if e] + update.get('evidence_add', [])
        ledger.append({'id': fid, 'registry': V52, 'severity': f['severity'], 'severity_source': 'auditor' if fid in auditor else 'builder',
                       'builder_status': f['status'], **auditor_fields(fid), 'root_cause': ROOT_CAUSE.get(fid, f.get('note')),
                       'fix_commit': f.get('commit'), 'regression': list(f.get('tests', [])) + update.get('regression_add', []),
                       'verification_sha': v52['product_source_sha'] if f['status'] == 'FIXED_PENDING_REAUDIT' else None, 'evidence': evidence,
                       'owner': 'TAS Team' if fid in ('ASTRA-ROLL-012', 'ASTRA-ROLL-013', 'RG-002') else ('RD／Security owner' if fid == 'RG-001' else ('人類 owner（Security／Legal／Business）' if fid in ('RG-005', 'RG-008') else 'Builder')),
                       'recheck_trigger': '受影響程式／CI／fixture 變更，或新的固定 HEAD 有同 SHA CI 證據'})
    severity_v51 = {'RG-V5-01': 'HIGH', 'RG-V5-02': 'MEDIUM', 'RG-V5-03': 'LOW', 'RG-V5-04': 'MEDIUM', 'RG-V5-05': 'LOW', 'RG-V5-06': 'HIGH', 'RG-V5-07': 'MEDIUM'}
    status_map = {'FIXED': 'FIXED_PENDING_REAUDIT', 'MEASURED': 'FIXED_PENDING_REAUDIT', 'FAILED': 'OPEN', 'NOT_RUN': 'OPEN', 'WORK_ORDER_ISSUED': 'WORK_ORDER_ISSUED', 'BLOCKED_DECISION': 'BLOCKED_DECISION', 'PARTIAL': 'OPEN'}
    for f in v51['findings']:
        fid = f['id']
        builder = status_map.get(f['status'], 'OPEN')
        ledger.append({'id': fid, 'registry': V51, 'severity': severity_v51.get(fid, 'LOW'), 'severity_source': 'builder', 'builder_status': builder, **auditor_fields(fid),
                       'root_cause': f.get('root_cause') or f['title'], 'fix_commit': ', '.join(f.get('commits', [])) or None, 'regression': [e for e in f.get('evidence', []) if 'test' in e],
                       'verification_sha': v51['product_source_sha'] if builder == 'FIXED_PENDING_REAUDIT' else None, 'evidence': f.get('evidence', []),
                       'owner': 'TAS Team' if fid in ('RG-V5-06', 'RG-V5-07') else ('人類 owner' if builder == 'BLOCKED_DECISION' else 'Builder'),
                       'recheck_trigger': '受影響程式／CI 變更或新的固定 HEAD'})
    for fid, o in original.items():
        ledger.append({'id': fid, 'registry': SNAP + '#original_18（Astra 原始 18 項；Builder 整改在 V4 RC-FIX）', 'severity': 'UNRATED_IN_SNAPSHOT', 'severity_source': 'auditor',
                       'builder_status': 'FIXED_PENDING_REAUDIT', **auditor_fields(fid), 'root_cause': None, 'fix_commit': None, 'regression': [],
                       'verification_sha': o['track_B_sha'], 'evidence': [SNAP], 'owner': 'Builder', 'recheck_trigger': 'Astra 下一輪 track 複驗'})
    ledger_doc = {'schema_version': 1, 'rules': ['Builder 最高只能標 FIXED_PENDING_REAUDIT', 'AUDIT_VERIFIED 只能來自 Astra 獨立收據（auditor_receipt.source_sha256 必填）',
                                                 'Finding ID 沿用各 registry，不另立 ID'], 'findings': ledger}
    ledger_text = json.dumps(ledger_doc, ensure_ascii=False, indent=1) + '\n'
    (COORD / 'FINDING_LEDGER.json').write_text(ledger_text)
    high = [f['id'] for f in ledger if f['severity'] in ('CRITICAL', 'HIGH') and 'AUDIT_VERIFIED' not in str(f['auditor_status'])]
    state = {
        'schema_version': 1, 'repo': 'hades60414-sys/DHC-AI-SYSTEM',
        'pr_stack': [{'pr': 10, 'head': '1e481e2fca812dcd2bfc45645623129bd7b54dea'}, {'pr': 11, 'head': '877525f27eed8d394f609d7ad7d2d8695be1035b'},
                     {'pr': 12, 'head': '2cc9e93e75133dc4247e7af3b959865cf8d9d05d'}, {'pr': 13, 'head': '601dbb3ee1d75f94ce75947af6e1cb2eea17661c'}, {'pr': 'V5.3', 'head': args.head_sha}],
        'product_sha': args.product_sha, 'head_sha': args.head_sha, 'base_sha': args.base_sha, 'builder_commit': args.head_sha,
        'head_sha_note': 'head_sha 是產生本檔時的 commit；本檔所在的文件提交會在其後（文件不改產品）。',
        'auditor_last_reviewed_sha': snap['reviewed_shas'], 'auditor_snapshot_sha256': snap['source_sha256'],
        'ci': ci, 'open_critical_high': high,
        'builder_status': 'BUILDER_SUBMITTED', 'auditor_status': 'ASTRA_REAUDIT_PENDING', 'ci_status': 'CI_EVIDENCE_READY' if ci else 'CI_PENDING',
        'human_decisions': {key: 'PENDING' for key in ['SEC-01', 'SEC-02', 'DEC-05', 'DEC-07', 'SC-OWNER', 'UAT-66', 'RD-002', 'RD-003', 'IP-AGPL-SDK-DAS', 'SOW-PRICING-EXPIRY-MAINTENANCE']},
        'evidence_fingerprint': hashlib.sha256(ledger_text.encode()).hexdigest(),
        'last_updated_utc': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'next_safe_action': 'Astra 以唯讀方式複驗固定 product_sha 與 CI 證據；Builder 在收到 Auditor 收據前不改判、不推 #10～#13',
        'update_triggers': ['PR push', 'workflow completion', '明確人工 handoff'], 'no_background_poller': True,
    }
    (COORD / 'STATE.json').write_text(json.dumps(state, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({'findings': len(ledger), 'open_high': high, 'fingerprint': state['evidence_fingerprint'][:16]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
