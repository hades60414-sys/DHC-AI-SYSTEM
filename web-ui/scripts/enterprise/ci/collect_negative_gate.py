"""V5.3 WP2：彙整負向閘門證據。比對每個案例 job 的實際 conclusion／gate step outcome 與預期（正向＝success，其餘＝failure），
並附 tool／comparator／gate 退出碼收據。全部符合預期時 exit 0（collect job 綠），否則 exit 1。
用法：collect_negative_gate.py <jobs.json> <cases 目錄> <輸出.json> <run_id> <run_attempt> <sha>
"""
import json
import sys
from pathlib import Path

jobs_path, cases_dir, output, run_id, attempt, sha = sys.argv[1:7]
jobs = json.loads(Path(jobs_path).read_text())['jobs']
expected = {name: ('success' if name == 'positive_control' else 'failure') for name in
            ['positive_control', 'tool_nonzero_output_all_pass', 'comparator_nonzero_new_fail', 'wrong_sha256', 'new_skip', 'new_todo', 'missing_output', 'truncated_report',
             'frontend_exit1_all_pass', 'build_failure', 'smoke_failure']}
rows = []
for name, want in expected.items():
    job = next((j for j in jobs if j['name'] == f'case-{name}'), None)
    folder = Path(cases_dir) / f'negative-case-{name}'
    receipts = {p.name: json.loads(p.read_text()) for p in folder.glob('*-exit.json')} if folder.exists() else {}
    outcome = json.loads((folder / 'step-outcome.json').read_text()) if (folder / 'step-outcome.json').exists() else {}
    step = next((s for s in (job or {}).get('steps', []) if s['name'].startswith('gate')), None)
    rows.append({'case': name, 'expected_job_conclusion': want, 'job_conclusion': job and job['conclusion'], 'job_id': job and job['id'],
                 'gate_step_conclusion': step and step['conclusion'], 'gate_step_outcome_reported': outcome.get('gate_step_outcome'),
                 'exit_receipts': receipts, 'continue_on_error': False, 'matches': bool(job) and job['conclusion'] == want and (step or {}).get('conclusion') == want})
report = {'run_id': run_id, 'run_attempt': attempt, 'sha': sha, 'cases': rows, 'all_match': all(r['matches'] for r in rows),
          'workflow_conclusion_expected': 'failure（負向案例 job 預期失敗；本 collect job 只證明每個案例的失敗／成功符合預期）',
          'note': '案例 step 未使用 continue-on-error；failure 由 bash pipefail＋gate.sh 的真實退出碼造成。'}
Path(output).write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
print(json.dumps({'all_match': report['all_match'], 'cases': [(r['case'], r['job_conclusion'], r['matches']) for r in rows]}, ensure_ascii=False))
sys.exit(0 if report['all_match'] else 1)
