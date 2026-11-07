"""V5.3 WP2：彙整負向閘門證據（V5.3.1：fail closed 強化）。
每個案例必須同時符合：
- 恰好一個 `case-<name>` job（缺少、重複、或出現未預期的 `case-*` job 都算不符）；job conclusion＝預期。
- 恰好一個 gate step，其 conclusion＝預期；artifact 裡的 step-outcome.json 必須存在且與 API 一致。
- 使用 gate.sh 的案例：`<kind>-exit.json` 必須存在且 tool／comparator／gate 退出碼等於本檔的獨立預期表。
- （有 --workflow 時）case job 不得含 continue-on-error。
全部符合時 exit 0（collect job 綠），否則 exit 1。
用法：collect_negative_gate.py <jobs.json> <cases 目錄> <輸出.json> <run_id> <run_attempt> <sha> [--workflow <negative-gate-evidence.yml>]
"""
import json
import sys
from pathlib import Path

args = sys.argv[1:]
workflow_path = None
if '--workflow' in args:
    index = args.index('--workflow')
    workflow_path = Path(args[index + 1])
    del args[index:index + 2]
jobs_path, cases_dir, output, run_id, attempt, sha = args[:6]
jobs = json.loads(Path(jobs_path).read_text())['jobs']
# 獨立預期：(gate.sh kind, tool_exit, comparator_exit, gate_exit)；None＝不經 gate.sh（以 pipefail 傳遞真實失敗）
EXPECTED_RECEIPT = {
    'positive_control': ('backend', 0, 0, 0), 'tool_nonzero_output_all_pass': ('backend', 1, 1, 1), 'comparator_nonzero_new_fail': ('backend', 1, 1, 1),
    'new_skip': ('backend', 0, 1, 1), 'new_todo': ('backend', 0, 1, 1), 'missing_output': ('backend', 0, 1, 1), 'truncated_report': ('backend', 0, 1, 1),
    'frontend_exit1_all_pass': ('frontend', 1, 1, 1), 'wrong_sha256': None, 'build_failure': None, 'smoke_failure': None,
}
expected = {name: ('success' if name == 'positive_control' else 'failure') for name in EXPECTED_RECEIPT}
problems = []

continue_on_error_found = None
if workflow_path is not None:
    import yaml
    workflow = yaml.safe_load(workflow_path.read_text())
    case_job = workflow['jobs']['case']
    continue_on_error_found = bool(case_job.get('continue-on-error')) or any(step.get('continue-on-error') for step in case_job['steps'])
    if continue_on_error_found:
        problems.append('case job 含 continue-on-error')

case_jobs = [j for j in jobs if j['name'].startswith('case-')]
unexpected = sorted({j['name'] for j in case_jobs} - {f'case-{n}' for n in expected})
if unexpected:
    problems.append(f'未預期的 case job：{unexpected}')
rows = []
for name, want in expected.items():
    reasons = []
    matching = [j for j in case_jobs if j['name'] == f'case-{name}']
    if len(matching) != 1:
        reasons.append(f'case job 數量 {len(matching)}（應為 1）')
    job = matching[0] if matching else None
    gate_steps = [s for s in (job or {}).get('steps', []) if s['name'].startswith('gate')]
    if job and len(gate_steps) != 1:
        reasons.append(f'gate step 數量 {len(gate_steps)}（應為 1）')
    step = gate_steps[0] if gate_steps else None
    if job and job['conclusion'] != want:
        reasons.append(f"job conclusion {job['conclusion']}≠{want}")
    if step and step['conclusion'] != want:
        reasons.append(f"gate step conclusion {step['conclusion']}≠{want}")
    folder = Path(cases_dir) / f'negative-case-{name}'
    receipts = {p.name: json.loads(p.read_text()) for p in sorted(folder.glob('*-exit.json'))} if folder.exists() else {}
    outcome_file = folder / 'step-outcome.json'
    outcome = json.loads(outcome_file.read_text()) if outcome_file.exists() else None
    if outcome is None:
        reasons.append('缺 step-outcome.json')
    elif outcome.get('gate_step_outcome') != want or (step and outcome.get('gate_step_outcome') != step['conclusion']):
        reasons.append(f"step-outcome.json {outcome.get('gate_step_outcome')} 與 API／預期不符")
    spec = EXPECTED_RECEIPT[name]
    if spec is None:
        if receipts:
            reasons.append(f'不經 gate.sh 的案例卻有退出碼收據 {sorted(receipts)}')
    else:
        kind, tool, comparator, gate = spec
        receipt = receipts.get(f'{kind}-exit.json')
        if receipt is None:
            reasons.append(f'缺 {kind}-exit.json')
        elif (receipt.get('tool_exit'), receipt.get('comparator_exit'), receipt.get('gate_exit')) != (tool, comparator, gate):
            reasons.append(f"退出碼收據 {(receipt.get('tool_exit'), receipt.get('comparator_exit'), receipt.get('gate_exit'))}≠預期 {(tool, comparator, gate)}")
        if len(receipts) != 1:
            reasons.append(f'退出碼收據數量 {len(receipts)}（應為 1）')
    rows.append({'case': name, 'expected_job_conclusion': want, 'job_conclusion': job and job['conclusion'], 'job_id': job and job['id'],
                 'gate_step_conclusion': step and step['conclusion'], 'gate_step_outcome_reported': outcome and outcome.get('gate_step_outcome'),
                 'expected_exit_receipt': None if spec is None else dict(zip(['kind', 'tool_exit', 'comparator_exit', 'gate_exit'], spec)),
                 'exit_receipts': receipts, 'reasons': reasons, 'matches': not reasons})
report = {'run_id': run_id, 'run_attempt': attempt, 'sha': sha, 'collector': 'V5.3.1 fail-closed', 'cases': rows, 'problems': problems,
          'continue_on_error_found': continue_on_error_found,
          'all_match': not problems and all(r['matches'] for r in rows),
          'workflow_conclusion_expected': 'failure（負向案例 job 預期失敗；本 collect job 只證明每個案例的失敗／成功符合預期）'}
Path(output).write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
print(json.dumps({'all_match': report['all_match'], 'problems': problems, 'mismatches': {r['case']: r['reasons'] for r in rows if r['reasons']}}, ensure_ascii=False))
sys.exit(0 if report['all_match'] else 1)
