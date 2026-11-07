"""V5.3.1 WP4：共享工程狀態的 schema 與一致性檢查（CI 執行，schema 2）。
- STATE.json／FINDING_LEDGER.json／EVIDENCE_SOURCES.json 必填欄位、SHA 格式、狀態列舉。
- SHA 角色分離：product_sha、ci_evidence_sha（每個證據 workflow 各一）、documentation_head_sha、pr_head_sha、auditor_last_reviewed_sha、artifact_source_sha。
- --require-git（CI 必帶）：以 git 歷史確認
  * product_sha..HEAD 沒有改產品路徑；
  * 每個證據 sha..HEAD 沒有改該證據 depends_on 的路徑（否則證據過期，除非標 pending_rerun 且 ci_status＝CI_PENDING）；
  * pr_head_sha 是 HEAD 的祖先，且 pr_head_sha..HEAD 只改 docs/enterprise/（文件版本與證據 SHA 不混用）。
- Builder 狀態不得為 AUDIT_VERIFIED；closure_class＝AUDITOR_VERIFIED 必須有 AUDITOR_SNAPSHOT 內存在的 Auditor 報告雜湊。
- 每個 Finding 的 ID 必須存在於其 registry；evidence_fingerprint＝FINDING_LEDGER.json 的 SHA-256；open_critical_high 由 ledger 推導。
用法：python3 -B scripts/enterprise/coordination/check_state.py [--require-git] [--coord <目錄>]
"""
import argparse
import fnmatch
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--require-git', action='store_true')
parser.add_argument('--web-root', type=Path, default=Path(__file__).resolve().parents[3], help='web-ui 目錄（測試用：指向暫存 clone）')
parser.add_argument('--coord', type=Path)
args = parser.parse_args()
ROOT = args.web_root.resolve()
args.coord = args.coord or ROOT / 'docs/enterprise/coordination'
COORD = args.coord
SHA = re.compile(r'^[0-9a-f]{40}$')
BUILDER = {'FIXED_PENDING_REAUDIT', 'WORK_ORDER_ISSUED', 'HUMAN_DECISION_REQUIRED', 'BLOCKED_DECISION', 'OPEN', 'ACCEPTED', 'DEFERRED'}
CLOSURE = {'AUDITOR_VERIFIED', 'BUILDER_FIXED_PENDING_REAUDIT', 'NOT_IMPLEMENTED', 'HUMAN_DECISION_BLOCKED', 'EVIDENCE_MISSING', 'RETEST_REQUIRED'}
SEVERITY = {'CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNRATED_IN_SNAPSHOT', 'UNRATED_IN_REGISTRY'}
UNRATED = ('UNRATED_IN_SNAPSHOT', 'UNRATED_IN_REGISTRY')
# V5.1 registry 沒有嚴重度欄位；以下為 Builder 指派的值，釘在檢查器中（與 build_state.py 必須同時修改才能變更）
BUILDER_ASSIGNED_SEVERITY = {'RG-V5-01': 'HIGH', 'RG-V5-02': 'MEDIUM', 'RG-V5-03': 'LOW', 'RG-V5-04': 'MEDIUM', 'RG-V5-05': 'LOW', 'RG-V5-06': 'HIGH', 'RG-V5-07': 'MEDIUM'}
FIXTURES = ['web-ui/docs/enterprise/scenarios/*']  # golden／測試資料：永遠不視為「文件」
# OCR-V531-D01／D02：已抄錄的 Auditor 報告釘選（來源雜湊＋抄錄內容雜湊）。新增或修改報告必須同時修改本檢查器，PR diff 可見；
# Astra 可用自己的原始報告跑 sync_auditor_snapshot.py 重算 content_sha256 獨立核對。此機制不能取代 Auditor 控制的錨點（見 FINAL_CLOSURE_REPORT 的殘餘風險）。
PINNED_AUDITOR_REPORTS = {
 "ASTRA-INTERIM-20261106": {
  "source_sha256": "84137ee9ef477bc8c51f20af50d849754e5b47078ccef380b29801f5248402ab",
  "content_sha256": "8c2f5089cc2967fa84f71a2c3db2a5088b27c7c9aa9438b1f1291bccab3728e8"
 },
 "ASTRA-CONTINUATION-V4-20261107": {
  "source_sha256": "690b71a3f102fe484a8220ffd526c1fc64d09000e442b53fff7871f2fa38482b",
  "content_sha256": "bed12085fe01415085e4789d7ce8900b5fe6bc7daa9929a92c0217328bba1e0c"
 }
}
V51_STATUS_MAP = {'FIXED': 'FIXED_PENDING_REAUDIT', 'MEASURED': 'FIXED_PENDING_REAUDIT', 'FAILED': 'OPEN', 'NOT_RUN': 'OPEN', 'WORK_ORDER_ISSUED': 'WORK_ORDER_ISSUED', 'BLOCKED_DECISION': 'BLOCKED_DECISION', 'PARTIAL': 'OPEN'}
SHA_ROLES = ['product_sha', 'ci_evidence_sha', 'documentation_head_sha', 'pr_head_sha', 'base_sha', 'auditor_last_reviewed_sha', 'artifact_source_sha']
STATE_KEYS = ['schema_version', 'repo', 'pr_stack', 'shas', 'evidence_sources', 'auditor_reports', 'open_critical_high', 'open_unrated_historical', 'closure_counts',
              'builder_status', 'auditor_status', 'ci_status', 'release_gates', 'human_decisions', 'evidence_fingerprint', 'last_updated_utc', 'next_safe_action']
FINDING_KEYS = ['id', 'registry', 'severity', 'builder_status', 'auditor_status', 'closure_class', 'root_cause', 'fix_commit', 'regression', 'verification_sha', 'evidence',
                'owner', 'recheck_trigger']
PRODUCT_PATHS = ['web-ui/src/*', 'web-ui/server/*', 'web-ui/deploy/*', 'web-ui/package.json', 'web-ui/package-lock.json']
PRODUCT_EXCLUDE = ['web-ui/server/*/tests/*', 'web-ui/src/*.test.*']
problems = []
state = json.loads((COORD / 'STATE.json').read_text())
ledger_text = (COORD / 'FINDING_LEDGER.json').read_text()
ledger = json.loads(ledger_text)
sources = json.loads((COORD / 'EVIDENCE_SOURCES.json').read_text())
snapshot = json.loads((COORD / 'AUDITOR_SNAPSHOT.json').read_text())
report_hashes = {r['source_sha256'] for r in snapshot.get('reports', []) if re.match(r'^[0-9a-f]{64}$', str(r.get('source_sha256', '')))}
if len(report_hashes) != len(snapshot.get('reports', [])):
    problems.append('AUDITOR_SNAPSHOT 有報告缺少有效 source_sha256')
actual_reports = {r.get('report_id'): r for r in snapshot.get('reports', [])}
if set(actual_reports) != set(PINNED_AUDITOR_REPORTS) or len(actual_reports) != len(snapshot.get('reports', [])):
    problems.append(f'AUDITOR_SNAPSHOT 報告集合 {sorted(map(str, actual_reports))} 與釘選 {sorted(PINNED_AUDITOR_REPORTS)} 不符（新增／刪除報告需同步修改檢查器）')
for report_id, pin in PINNED_AUDITOR_REPORTS.items():
    report = actual_reports.get(report_id)
    if report is None:
        continue
    content = hashlib.sha256(json.dumps(report, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    if report.get('source_sha256') != pin['source_sha256'] or content != pin['content_sha256']:
        problems.append(f'AUDITOR_SNAPSHOT 報告 {report_id} 的抄錄內容或來源雜湊被改動（content {content[:12]}≠釘選 {pin["content_sha256"][:12]}）')

for key in STATE_KEYS:
    if key not in state:
        problems.append(f'STATE 缺 {key}')
shas = state.get('shas', {})
for role in SHA_ROLES:
    value = shas.get(role)
    values = list(value.values()) if isinstance(value, dict) else [value]
    if role not in shas or not values or not all(SHA.match(str(v)) for v in values):
        problems.append(f'STATE.shas.{role} 缺少或不是 40 字元 SHA')
if shas.get('documentation_head_sha') != shas.get('pr_head_sha'):
    problems.append('documentation_head_sha 與 pr_head_sha 應為同一個產生時 HEAD')
pr14 = [p for p in state.get('pr_stack', []) if p.get('pr') == 14]
if len(pr14) != 1 or pr14[0].get('head') != shas.get('pr_head_sha'):
    problems.append('pr_stack 必須含 PR #14 且 head＝shas.pr_head_sha')
if state.get('builder_status') not in ('BUILDER_IN_PROGRESS', 'BUILDER_SUBMITTED'):
    problems.append('STATE.builder_status 非法')
if 'VERIFIED' in str(state.get('auditor_status')):
    problems.append('STATE.auditor_status 不得由 Builder 宣稱 verified')
if state.get('evidence_fingerprint') != hashlib.sha256(ledger_text.encode()).hexdigest():
    problems.append('STATE.evidence_fingerprint 與 FINDING_LEDGER.json 不符（狀態過期）')
declared = {name: src['sha'] for name, src in sources.get('evidence', {}).items()}
if shas.get('ci_evidence_sha') != declared:
    problems.append('STATE.shas.ci_evidence_sha 與 EVIDENCE_SOURCES.json 不一致')
if shas.get('artifact_source_sha') != sources.get('artifact_source_sha'):
    problems.append('STATE.shas.artifact_source_sha 與 EVIDENCE_SOURCES.json 不一致')
if shas.get('auditor_last_reviewed_sha') != snapshot.get('latest_reviewed_sha'):
    problems.append('auditor_last_reviewed_sha 與 AUDITOR_SNAPSHOT.latest_reviewed_sha 不一致')
pending = sorted(name for name, src in sources.get('evidence', {}).items() if src.get('pending_rerun'))
if pending and state.get('ci_status') != 'CI_PENDING':
    problems.append(f'證據 {pending} 標 pending_rerun，但 ci_status 不是 CI_PENDING')
for name, src in sources.get('evidence', {}).items():
    for key in ('sha', 'workflow', 'run_id', 'attempt', 'depends_on', 'expected_conclusion'):
        if key not in src:
            problems.append(f'EVIDENCE_SOURCES.{name} 缺 {key}')


def git(*command):
    return subprocess.run(['git', '-c', 'core.quotepath=false', *command], cwd=ROOT, capture_output=True, text=True)


def changed(old, patterns, exclude=()):
    result = git('diff', '--name-only', f'{old}..HEAD')
    if result.returncode != 0:
        problems.append(f'git diff {old[:7]}..HEAD 失敗：{result.stderr.strip()[:120]}')
        return []
    return [p for p in result.stdout.split() if any(fnmatch.fnmatch(p, g) or p == g.rstrip('*').rstrip('/') for g in patterns)
            and (any(fnmatch.fnmatch(p, f) for f in FIXTURES) or not any(fnmatch.fnmatch(p, e) for e in exclude))]


git_checked = False
inside = git('rev-parse', '--is-inside-work-tree').stdout.strip() == 'true' and git('rev-parse', '--is-shallow-repository').stdout.strip() == 'false'
if args.require_git and not inside:
    problems.append('--require-git：不是完整 git 歷史（CI checkout 需要 fetch-depth: 0）')
if inside and args.require_git:
    git_checked = True
    for role, value in shas.items():
        for sha in (value.values() if isinstance(value, dict) else [value]):
            if SHA.match(str(sha)) and git('cat-file', '-e', f'{sha}^{{commit}}').returncode != 0 and role != 'auditor_last_reviewed_sha':
                problems.append(f'{role} {sha[:7]} 不存在於 git 歷史')
    if SHA.match(str(shas.get('product_sha'))):
        moved = changed(shas['product_sha'], PRODUCT_PATHS, PRODUCT_EXCLUDE)
        if moved:
            problems.append(f'product_sha 之後產品路徑有變更（product_sha 過期）：{moved[:5]}')
    for name, src in sources.get('evidence', {}).items():
        if SHA.match(str(src.get('sha'))) and not src.get('pending_rerun'):
            moved = changed(src['sha'], src.get('depends_on', []), src.get('depends_on_exclude', []))
            if moved:
                problems.append(f'證據 {name}（{src["sha"][:7]}）之後其依賴路徑有變更，證據過期：{moved[:5]}')
    head = shas.get('pr_head_sha')
    if SHA.match(str(head)):
        if git('merge-base', '--is-ancestor', head, 'HEAD').returncode != 0:
            problems.append('pr_head_sha 不是 HEAD 的祖先')
        else:
            after = [p for p in git('diff', '--name-only', f'{head}..HEAD').stdout.split()
                     if not p.startswith('web-ui/docs/enterprise/') or any(fnmatch.fnmatch(p, f) for f in FIXTURES)]
            if after:
                problems.append(f'pr_head_sha 之後有非文件變更（文件版本與證據 SHA 混用）：{after[:5]}')

# OCR-V531-01：Auditor 判定由 AUDITOR_SNAPSHOT 重新推導（不信任 ledger 自述）
derived_auditor = {}
for report in sorted(snapshot.get('reports', []), key=lambda r: r['generated_at']):
    for group in ('findings', 'builder_tracker_items', 'original_18'):
        for item in report.get(group, []):
            status = item.get('auditor_status') or item.get('current_verdict') or (f"track_B {item.get('track_B_verdict')}（track_A {item.get('track_A_verdict')}）" if item.get('track_B_verdict') else None)
            derived_auditor[item['id']] = {'status': status, 'problem_state': item.get('problem_state'), 'reviewed_sha': item.get('reviewed_sha') or item.get('track_B_sha'),
                                           'severity': item.get('severity'), 'source_sha256': report['source_sha256']}
v52_registry = json.loads((ROOT / 'docs/enterprise/v52/ASTRA_ROLL_REMEDIATION_MATRIX.json').read_text())['findings']
registry_severity = {f['id']: f.get('severity') for f in v52_registry}
# OCR-V531-D03：builder_status 必須等於 registry 的狀態（V5.1 依固定對照）
registry_status = {f['id']: f['status'] for f in v52_registry}
registry_status.update({f['id']: V51_STATUS_MAP.get(f['status'], 'OPEN') for f in json.loads((ROOT / 'docs/enterprise/v51/REPOGUARD_FINDINGS_DISPOSITION.json').read_text())['findings']})
state_reports = [(r.get('report_id'), r.get('source_sha256')) for r in state.get('auditor_reports', [])]
if sorted(state_reports) != sorted((r.get('report_id'), r.get('source_sha256')) for r in snapshot.get('reports', [])):
    problems.append('STATE.auditor_reports 與 AUDITOR_SNAPSHOT 報告清單不一致')


def auditor_pass(record):
    status, problem = str(record.get('status')), str(record.get('problem_state'))
    return problem == 'AUDIT_VERIFIED' or status.startswith('PASS') or 'track_B PASS' in status


registries, seen = {}, set()
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
    if finding.get('closure_class') not in CLOSURE:
        problems.append(f"{fid}: closure_class 非法 {finding.get('closure_class')}")
    receipt = finding.get('auditor_receipt') or {}
    if finding.get('auditor_status') not in (None, 'NOT_YET_REVIEWED') and receipt.get('source_sha256') not in report_hashes:
        problems.append(f'{fid}: Auditor 判定的來源雜湊不在 AUDITOR_SNAPSHOT 報告中')
    truth = derived_auditor.get(fid)
    if truth is None:
        if finding.get('auditor_status') != 'NOT_YET_REVIEWED':
            problems.append(f'{fid}: AUDITOR_SNAPSHOT 沒有此 ID，auditor_status 只能是 NOT_YET_REVIEWED')
    else:
        for key, value in (('auditor_status', truth['status']), ('auditor_problem_state', truth['problem_state']), ('auditor_reviewed_sha', truth['reviewed_sha'])):
            if finding.get(key) != value:
                problems.append(f'{fid}: {key}＝{finding.get(key)!r} 與 AUDITOR_SNAPSHOT 最新報告 {value!r} 不符（不得改判）')
        if receipt.get('source_sha256') != truth['source_sha256']:
            problems.append(f'{fid}: auditor_receipt 不是最新含此 ID 的 Auditor 報告')
    if finding.get('closure_class') == 'AUDITOR_VERIFIED' and not (truth and auditor_pass(truth)):
        problems.append(f'{fid}: AUDITOR_VERIFIED 但 AUDITOR_SNAPSHOT 的最新判定不是 PASS')
    builder_status = finding.get('builder_status')
    want_status = registry_status.get(fid, 'FIXED_PENDING_REAUDIT' if fid not in registry_status else None)
    if builder_status != want_status:
        problems.append(f'{fid}: builder_status {builder_status} 與 registry 狀態 {want_status} 不符')
    expected_class = {'BLOCKED_DECISION': 'HUMAN_DECISION_BLOCKED', 'HUMAN_DECISION_REQUIRED': 'HUMAN_DECISION_BLOCKED', 'WORK_ORDER_ISSUED': 'NOT_IMPLEMENTED', 'OPEN': 'NOT_IMPLEMENTED'}.get(builder_status)
    if expected_class and finding.get('closure_class') != expected_class:
        problems.append(f'{fid}: builder_status {builder_status} 應對應 closure_class {expected_class}')
    # OCR-V531-02：嚴重度以 snapshot／registry／釘選值為準
    want = (truth or {}).get('severity') or registry_severity.get(fid) or BUILDER_ASSIGNED_SEVERITY.get(fid)
    if str(finding.get('registry', '')).endswith('（Astra 原始 18 項；Builder 整改在 V4 RC-FIX）'):
        want = 'UNRATED_IN_SNAPSHOT'
    if want is None:
        want = 'UNRATED_IN_REGISTRY'
    if finding.get('severity') != want:
        problems.append(f"{fid}: severity {finding.get('severity')} 與來源 {want} 不符")
    if finding.get('builder_status') == 'FIXED_PENDING_REAUDIT' and not SHA.match(str(finding.get('verification_sha') or '')):
        problems.append(f'{fid}: FIXED_PENDING_REAUDIT 需要 verification_sha')
    registry = str(finding.get('registry', '')).split('#')[0]
    path = ROOT / registry
    if not path.exists():
        problems.append(f'{fid}: registry 不存在 {registry}')
        continue
    if registry not in registries:
        data = json.loads(path.read_text())
        groups = [data] + data.get('reports', [])
        registries[registry] = {f['id'] for g in groups for key in ('findings', 'original_18', 'builder_tracker_items') for f in g.get(key, [])}
    if fid not in registries[registry]:
        problems.append(f'{fid}: 不在 registry {registry}（不得另立 ID）')
derived = sorted(f['id'] for f in ledger['findings'] if f['severity'] in ('CRITICAL', 'HIGH') and f.get('closure_class') != 'AUDITOR_VERIFIED')
if sorted(state.get('open_critical_high', [])) != derived:
    problems.append(f'STATE.open_critical_high 與 ledger 推導不一致：{derived}')
unrated = sorted(f['id'] for f in ledger['findings'] if f['severity'] in UNRATED and f.get('closure_class') != 'AUDITOR_VERIFIED')
if sorted(state.get('open_unrated_historical', [])) != unrated:
    problems.append('STATE.open_unrated_historical 與 ledger 推導不一致')
counts = {c: sum(1 for f in ledger['findings'] if f.get('closure_class') == c) for c in sorted(CLOSURE)}
if {k: v for k, v in sorted(state.get('closure_counts', {}).items())} != counts:
    problems.append('STATE.closure_counts 與 ledger 不一致')
print(json.dumps({'status': 'FAIL' if problems else 'PASS', 'findings': len(ledger['findings']), 'git_checked': git_checked, 'pending_rerun': pending,
                  'problems': problems[:30]}, ensure_ascii=False))
sys.exit(1 if problems else 0)
