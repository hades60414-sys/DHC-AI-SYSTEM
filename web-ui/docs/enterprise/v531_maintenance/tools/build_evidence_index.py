"""V5.3.1 Maintenance：從既有檔案與 GitHub API（唯讀）整理 Evidence Index 與 Finding 待命表。不改判、不產生新證據。
用法（web-ui 目錄）：python3 -B docs/enterprise/v531_maintenance/tools/build_evidence_index.py <artifact-json 目錄>
artifact-json 目錄：每個 run 一個 art_<run>.json（`gh api repos/<repo>/actions/runs/<run>/artifacts?per_page=100` 的輸出）。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DOCS = ROOT / 'docs/enterprise'
OUT = DOCS / 'v531_maintenance'
ART = Path(sys.argv[1])
PRODUCT = 'd38afd88d9630a9390785ae35b745a8ad91e6c6a'
ledger = json.loads((DOCS / 'coordination/FINDING_LEDGER.json').read_text())
sources = json.loads((DOCS / 'coordination/EVIDENCE_SOURCES.json').read_text())
matrix = json.loads((DOCS / 'v53/CI_MATRIX.json').read_text())
artifacts = {int(p.stem.split('_')[1]): json.loads(p.read_text())['artifacts'] for p in ART.glob('art_*.json')}
run_sha = {r['run_id']: matrix['head_sha'] for r in matrix['runs']}
for name, src in sources['evidence'].items():
    run_sha[src['run_id']] = src['sha']
    for h in src.get('history', []):
        run_sha.setdefault(h['run_id'], h['sha'])
run_sha.update({42276319689: PRODUCT, 42276319770: PRODUCT, 42276319968: PRODUCT,
                42247102617: '6933d5e17f1120d87126df598c594c31b4e474ed', 42247102627: '6933d5e17f1120d87126df598c594c31b4e474ed'})
jobs_f1 = {j['name']: j['id'] for r in matrix['runs'] for j in r['jobs']}
VERIFY, IMAGE, COVER = (r['run_id'] for r in matrix['runs'])
NEG, OFFICE = sources['evidence']['negative_gate_evidence'], sources['evidence']['office_e2e_evidence']


def art(run, name):
    for a in artifacts.get(run, []):
        if a['name'] == name:
            return {'artifact_id': a['id'], 'expires_at': a['expires_at'], 'expired': a['expired'], 'digest': a.get('digest')}
    return {'artifact_id': None, 'expires_at': None, 'expired': None, 'digest': None}


# 測試檔 → 目前（F1／證據 SHA）執行它的 run／job／artifact
def current_runs(paths):
    rows = []
    joined = ' '.join(paths)
    if re.search(r'server/.*integration\.test\.ts', joined):
        rows.append(('enterprise-verify', VERIFY, jobs_f1['postgres-integration'], 'enterprise-verify-postgres'))
    if re.search(r'(server/.*(?<!integration)\.test\.ts|src/.*\.test\.tsx?|test_gate\.py|test_dhc_office_images\.py|check_repo|ops-resource-probe)', joined):
        rows.append(('enterprise-verify', VERIFY, jobs_f1['static-and-unit'], 'enterprise-verify-static-unit'))
    if re.search(r'office_stale_e2e|office_e2e_redgreen', joined):
        rows.append(('office-e2e-evidence', OFFICE['run_id'], OFFICE['jobs']['office-stale-green-current'], 'office-stale-green-current'))
        rows.append(('office-e2e-evidence', OFFICE['run_id'], OFFICE['jobs']['office-stale-red-v51'], 'office-stale-red-v51'))
        rows.append(('enterprise-image-build', IMAGE, jobs_f1['delivery-amd64 / delivery'], 'enterprise-delivery-amd64'))
        rows.append(('enterprise-image-build', IMAGE, jobs_f1['delivery-arm64 / delivery'], 'enterprise-delivery-arm64'))
    if re.search(r'negative-gate|negative_gate', joined):
        rows.append(('negative-gate-evidence', NEG['run_id'], NEG['jobs']['collect'], 'negative-gate-evidence'))
    if re.search(r'enterprise-image-build|驗證AI_Office交付|SUPPLY_CHAIN', joined):
        rows.append(('enterprise-image-build', IMAGE, jobs_f1['build-amd64'], 'enterprise-image-report-amd64'))
        rows.append(('enterprise-image-build', IMAGE, jobs_f1['build-arm64'], 'enterprise-image-report-arm64'))
    if 'upgrade_rollback' in joined:
        rows.append(('enterprise-image-build', IMAGE, jobs_f1['upgrade-rollback-amd64'], 'enterprise-upgrade-rollback-amd64'))
    if 'uat_evidence_index' in joined or 'PERFORMANCE_REPORT' in joined:
        rows.append(('enterprise-verify', VERIFY, jobs_f1['static-and-unit'], 'enterprise-verify-static-unit'))
    if 'check_repo_coverage' in joined:
        rows.append(('repo-coverage', COVER, jobs_f1['coverage-contract'], 'repo-coverage'))
    out, seen = [], set()
    for wf, run, job, name in rows:
        if (run, job) in seen:
            continue
        seen.add((run, job))
        out.append({'workflow': wf, 'run_id': run, 'job_id': job, 'test_sha': run_sha.get(run), 'artifact_name': name, **art(run, name)})
    return out


LIMITS = {
    'ASTRA-ROLL-002': '審批這一半的 PG 狀態分不出缺陷與正常行為（OCR-V531-04），判定只靠瀏覽器 oracle；RED 審批正向段 timeout，不列為已重現',
    'ASTRA-ROLL-001': 'wrong_sha256／build／smoke 三案只接受「失敗」，不辨別失敗原因（OCR-V531-06）；job log 已人工確認',
    'ASTRA-ROLL-010': '5 萬列量測只記錄、不設門檻；單一衝突 sources 不設上限（DEC-05）',
}
index = []
for f in ledger['findings']:
    paths = [str(p) for p in f.get('regression', [])] + [str(e) for e in f.get('evidence', [])]
    historical = sorted({int(m) for e in f.get('evidence', []) for m in re.findall(r'actions/runs/(\d+)', str(e))})
    hist_rows = []
    for run in historical:
        arts = artifacts.get(run, [])
        hist_rows.append({'run_id': run, 'test_sha': run_sha.get(run), 'artifact_ids': [a['id'] for a in arts],
                          'earliest_expiry': min((a['expires_at'] for a in arts), default=None), 'any_expired': any(a['expired'] for a in arts)})
    limits = [LIMITS[f['id']]] if f['id'] in LIMITS else []
    if f['closure_class'] in ('NOT_IMPLEMENTED', 'HUMAN_DECISION_BLOCKED'):
        limits.append('沒有修正，所以沒有修正證據；只有工單／決策文件')
    if not current_runs(paths) and f['closure_class'] not in ('NOT_IMPLEMENTED', 'HUMAN_DECISION_BLOCKED'):
        limits.append('沒有逐項的測試對應；F1 整套 CI（verify 42349084781／image 42349084776）仍會執行全部測試，但無法指出單一 job 證明此項')
    if f['severity'].startswith('UNRATED'):
        limits.append(f"嚴重度未知（{f['severity']}）")
    if f.get('auditor_pass_invalidated_by'):
        limits.append('Astra 在 2cc9e93 判 PASS，但修正檔之後又被改：' + '、'.join(f['auditor_pass_invalidated_by'][:3]))
    index.append({'finding_id': f['id'], 'severity': f['severity'], 'closure_class': f['closure_class'], 'builder_status': f['builder_status'],
                  'auditor_status': f['auditor_status'], 'auditor_reviewed_sha': f.get('auditor_reviewed_sha'), 'product_sha': PRODUCT,
                  'fix_commit': f.get('fix_commit'), 'verification_sha': f.get('verification_sha'),
                  'current_evidence': current_runs(paths), 'historical_runs': hist_rows,
                  'evidence_paths': [p for p in paths if not p.startswith('http')], 'limitations': limits})
doc = {'schema_version': 1, 'generated_from': {'pr14_head': '38c7293d3764f61a967b2bd2e90526e218b77793', 'final_code_sha': '828a763681fc60c795df27733aaa5c1369be0571',
                                               'evidence_sha': 'c2ae88b8b93a8440a2c804fcab8b1cd72b8464f4', 'f1_ci_sha': matrix['head_sha'], 'product_sha': PRODUCT},
       'note': '只整理既有證據；auditor_status 原文照抄自 FINDING_LEDGER（源自 AUDITOR_SNAPSHOT），不改判。', 'findings': index}
(OUT / 'EVIDENCE_INDEX.json').write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n')

# Markdown 表
md = ['# Evidence Index（V5.3.1 審核版本）', '', '> 機器可讀版：`EVIDENCE_INDEX.json`。只整理既有證據，不改判。Product SHA 一律是 `d38afd8`；Test SHA 是實際執行該測試的 commit。', '',
      '| Finding | 嚴重度 | 類別 | 目前證據（workflow run／job → artifact，到期日） | Test SHA | 歷史 run（最早到期） | 證據路徑 | 驗證限制 |', '|---|---|---|---|---|---|---|---|']
for i in index:
    cur = '<br/>'.join(f"{c['workflow']} {c['run_id']}／{c['job_id']} → {c['artifact_id']}（{(c['expires_at'] or '—')[:10]}）" for c in i['current_evidence']) or '—'
    sha = '、'.join(sorted({(c['test_sha'] or '')[:7] for c in i['current_evidence']})) or '—'
    hist = '<br/>'.join(f"{h['run_id']}@{(h['test_sha'] or '')[:7]}（{(h['earliest_expiry'] or '—')[:10]}）" for h in i['historical_runs']) or '—'
    paths = '<br/>'.join(f'`{p[:70]}`' for p in i['evidence_paths'][:3]) or '—'
    md.append(f"| {i['finding_id']} | {i['severity']} | {i['closure_class']} | {cur} | {sha} | {hist} | {paths} | {'；'.join(i['limitations']) or '—'} |")
(OUT / 'EVIDENCE_INDEX.md').write_text('\n'.join(md) + '\n')
print(len(index), 'findings indexed;', sum(1 for i in index if i['current_evidence']), 'with current CI evidence')
