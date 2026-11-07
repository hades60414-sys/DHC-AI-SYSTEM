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

ROOT = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument('--require-git', action='store_true')
parser.add_argument('--coord', type=Path, default=ROOT / 'docs/enterprise/coordination')
args = parser.parse_args()
COORD = args.coord
SHA = re.compile(r'^[0-9a-f]{40}$')
BUILDER = {'FIXED_PENDING_REAUDIT', 'WORK_ORDER_ISSUED', 'HUMAN_DECISION_REQUIRED', 'BLOCKED_DECISION', 'OPEN', 'ACCEPTED', 'DEFERRED'}
CLOSURE = {'AUDITOR_VERIFIED', 'BUILDER_FIXED_PENDING_REAUDIT', 'NOT_IMPLEMENTED', 'HUMAN_DECISION_BLOCKED', 'EVIDENCE_MISSING', 'RETEST_REQUIRED'}
SEVERITY = {'CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNRATED_IN_SNAPSHOT'}
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
    return [p for p in result.stdout.split() if any(fnmatch.fnmatch(p, g) or p == g.rstrip('*').rstrip('/') for g in patterns) and not any(fnmatch.fnmatch(p, e) for e in exclude)]


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
            after = [p for p in git('diff', '--name-only', f'{head}..HEAD').stdout.split() if not p.startswith('web-ui/docs/enterprise/')]
            if after:
                problems.append(f'pr_head_sha 之後有非文件變更（文件版本與證據 SHA 混用）：{after[:5]}')

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
    if finding.get('closure_class') == 'AUDITOR_VERIFIED':
        status, problem = str(finding.get('auditor_status')), str(finding.get('auditor_problem_state'))
        if receipt.get('source_sha256') not in report_hashes or not (problem == 'AUDIT_VERIFIED' or status.startswith('PASS') or 'track_B PASS' in status):
            problems.append(f'{fid}: AUDITOR_VERIFIED 沒有可校驗的 Auditor PASS 收據')
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
unrated = sorted(f['id'] for f in ledger['findings'] if f['severity'] == 'UNRATED_IN_SNAPSHOT' and f.get('closure_class') != 'AUDITOR_VERIFIED')
if sorted(state.get('open_unrated_historical', [])) != unrated:
    problems.append('STATE.open_unrated_historical 與 ledger 推導不一致')
counts = {c: sum(1 for f in ledger['findings'] if f.get('closure_class') == c) for c in sorted(CLOSURE)}
if {k: v for k, v in sorted(state.get('closure_counts', {}).items())} != counts:
    problems.append('STATE.closure_counts 與 ledger 不一致')
print(json.dumps({'status': 'FAIL' if problems else 'PASS', 'findings': len(ledger['findings']), 'git_checked': git_checked, 'pending_rerun': pending,
                  'problems': problems[:30]}, ensure_ascii=False))
sys.exit(1 if problems else 0)
