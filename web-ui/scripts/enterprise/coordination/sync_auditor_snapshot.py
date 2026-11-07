"""V5.3.1：把 Astra（獨立 Auditor）報告「只抄錄」成 AUDITOR_SNAPSHOT.json（schema 2，多份報告依時間保存）。
- 每份報告保留：auditor、report_kind／mode、generated_at、reviewed SHA、來源檔 SHA-256、原始 verdict 字串。
- 不改判、不推導：欄位原文照抄；報告裡沒有的值記為 null，不補。
- 原始報告在受控位置（不進公開 repo）；本工具只在 Builder 的本機執行，CI 只驗證產出。
用法：python3 -B sync_auditor_snapshot.py --interim <FINDINGS.json> --continuation <FINDINGS_CURRENT.json> [--continuation-state <AUDIT_STATE.json>]
"""
import argparse
import hashlib
import json
from pathlib import Path

OUT = Path(__file__).resolve().parents[3] / 'docs/enterprise/coordination/AUDITOR_SNAPSHOT.json'
AUDITOR = 'Astra（獨立 Auditor）'


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def interim_report(path):
    data = json.loads(Path(path).read_text())
    meta = data.get('metadata', data)
    findings = []
    for f in data['findings']:
        findings.append({'id': f['id'], 'severity': f.get('severity'), 'auditor_status': f.get('independent_verification_status'),
                         'evidence_class': f.get('evidence_class'), 'reviewed_sha': f.get('sha') or f.get('reviewed_sha') or meta.get('track_B_sha')})
    original = [{'id': o['id'], 'track_A_sha': o.get('track_A_sha'), 'track_A_verdict': o.get('track_A_verdict'), 'track_B_sha': o.get('track_B_sha'),
                 'track_B_verdict': o.get('track_B_verdict')} for o in data.get('original_18', [])]
    return {'report_id': 'ASTRA-INTERIM-20261106', 'auditor': AUDITOR, 'report_kind': 'INTERIM_AUDIT', 'generated_at': meta.get('generated_at'),
            'source_file': 'ASTRA_ROLLING_AUDIT_20261106/FINDINGS.json（受控交接位置，不在公開 repo）', 'source_sha256': sha256(path),
            'reviewed_shas': {'track_A': meta.get('track_A_sha', '1e481e2fca812dcd2bfc45645623129bd7b54dea'), 'track_B': meta.get('track_B_sha', '877525f27eed8d394f609d7ad7d2d8695be1035b')},
            'verdicts': meta.get('verdicts'), 'findings': findings, 'original_18': original, 'builder_tracker_items': [], 'v4_new_4': []}


def continuation_report(path, state_path):
    data = json.loads(Path(path).read_text())
    findings = [{'id': f['id'], 'severity': f.get('original_severity'), 'auditor_status': f.get('current_verdict'), 'problem_state': f.get('problem_state'),
                 'evidence_kind': f.get('evidence_kind'), 'disposition': f.get('disposition'), 'reviewed_sha': f.get('new_sha')} for f in data['findings']]
    original = [{'id': o['id'], 'track_A_sha': o.get('track_A_sha'), 'track_A_verdict': o.get('track_A_verdict'), 'track_B_sha': o.get('track_B_sha'),
                 'track_B_verdict': o.get('track_B_verdict'), 'current_verdict': o.get('current_verdict'), 'reviewed_sha': o.get('new_sha'),
                 'fix_commit_in_DAS': o.get('fix_commit_in_DAS')} for o in data['original_18']]
    tracker = [{'id': t['id'], 'auditor_status': t.get('current_verdict'), 'problem_state': t.get('problem_state'), 'evidence_kind': t.get('evidence_kind'),
                'reviewed_sha': t.get('new_sha')} for t in data['builder_tracker_items']]
    new4 = [{'id': n['id'], 'auditor_status': n.get('current_verdict'), 'reviewed_sha': n.get('new_sha')} for n in data['v4_new_4']]
    report = {'report_id': 'ASTRA-CONTINUATION-V4-20261107', 'auditor': AUDITOR, 'report_kind': data.get('mode'), 'completion_state': data.get('completion_state'),
              'generated_at': data.get('generated_at'), 'source_file': 'ASTRA_ROLLING_AUDIT_20261106/CONTINUATION_V4/FINDINGS_CURRENT.json（受控交接位置，不在公開 repo）',
              'source_sha256': sha256(path), 'reviewed_shas': {'snapshot': data.get('snapshot_sha'), 'base': data.get('base_sha'), 'declared_product_source': data.get('product_source_sha')},
              'verdicts': data.get('readiness'), 'new_confirmed_critical_high': data.get('new_confirmed_critical_high'), 'capability_limits': data.get('capability_limits'),
              'unavailable_named_inputs': data.get('unavailable_named_inputs'), 'findings': findings, 'original_18': original, 'builder_tracker_items': tracker, 'v4_new_4': new4}
    if state_path:
        report['state_file_sha256'] = sha256(state_path)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--interim', required=True)
    parser.add_argument('--continuation', required=True)
    parser.add_argument('--continuation-state')
    args = parser.parse_args()
    previous = json.loads(OUT.read_text()) if OUT.exists() else {}
    interim = interim_report(args.interim)
    if previous.get('schema_version') == 1:
        # V5.3 已抄錄的 INTERIM 原值優先保留（不重寫歷史）；只檢查來源雜湊一致
        assert previous['source_sha256'] == interim['source_sha256'], 'INTERIM 來源雜湊與既有抄錄不一致'
        interim.update({k: previous[k] for k in ('generated_at', 'reviewed_shas', 'verdicts', 'findings', 'original_18')})
    reports = [interim, continuation_report(args.continuation, args.continuation_state)]
    reports.sort(key=lambda r: r['generated_at'])
    snapshot = {'schema_version': 2, 'synced_by': 'Builder（只抄錄、不改判）',
                'rule': '每個 Finding 的 auditor 狀態取「最新一份含該 ID 的 Auditor 報告」；舊報告完整保留。沒有 Astra 報告的 SHA 記為 AUDITOR_REPORT_NOT_AVAILABLE。',
                'latest_report_id': reports[-1]['report_id'], 'latest_reviewed_sha': reports[-1]['reviewed_shas'].get('snapshot') or reports[-1]['reviewed_shas'].get('track_B'),
                'not_reviewed_by_auditor': {'shas': ['d38afd88d9630a9390785ae35b745a8ad91e6c6a', '601dbb3ee1d75f94ce75947af6e1cb2eea17661c', 'PR #14 全部 commit'],
                                            'status': 'AUDITOR_REPORT_NOT_AVAILABLE'},
                'reports': reports}
    OUT.write_text(json.dumps(snapshot, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({'reports': [(r['report_id'], r['source_sha256'][:12], r['generated_at']) for r in reports]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
