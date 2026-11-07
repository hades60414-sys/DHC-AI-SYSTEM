"""V5.3.1：collect_negative_gate.py 的合成負向測試。
每個測試以「獨立預期值」判斷（collector 的退出碼與 all_match），不讀報告裡的 matches 欄位當依據。
用法：python3 -B scripts/enterprise/ci/test_collect_negative_gate.py
"""
import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
COLLECTOR = HERE / 'collect_negative_gate.py'
WORKFLOW = HERE.parents[2].parent / '.github/workflows/negative-gate-evidence.yml'
# 獨立預期：與 collector 內的表無關，在此重寫一次
GATE_CASES = {'positive_control': ('backend', 0, 0, 0), 'tool_nonzero_output_all_pass': ('backend', 1, 1, 1), 'comparator_nonzero_new_fail': ('backend', 1, 1, 1),
              'new_skip': ('backend', 0, 1, 1), 'new_todo': ('backend', 0, 1, 1), 'missing_output': ('backend', 0, 1, 1), 'truncated_report': ('backend', 0, 1, 1),
              'frontend_exit1_all_pass': ('frontend', 1, 1, 1)}
PIPE_CASES = ['wrong_sha256', 'build_failure', 'smoke_failure']


def good_inputs():
    jobs, receipts, outcomes = [], {}, {}
    for index, name in enumerate(list(GATE_CASES) + PIPE_CASES):
        want = 'success' if name == 'positive_control' else 'failure'
        jobs.append({'id': 1000 + index, 'name': f'case-{name}', 'conclusion': want,
                     'steps': [{'name': '產生案例輸入與閘門指令', 'conclusion': 'success'}, {'name': 'gate（與正式 CI 相同的 shell 與閘門；不容錯）', 'conclusion': want}]})
        if name in GATE_CASES:
            kind, tool, comparator, gate = GATE_CASES[name]
            receipts[name] = {f'{kind}-exit.json': {'kind': kind, 'tool_exit': tool, 'comparator_exit': comparator, 'gate_exit': gate}}
        outcomes[name] = {'case': name, 'gate_step_outcome': want}
    jobs.append({'id': 2000, 'name': 'collect', 'conclusion': None, 'steps': []})
    return {'jobs': jobs, 'receipts': receipts, 'outcomes': outcomes}


def run(inputs, workflow=None):
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        (base / 'jobs.json').write_text(json.dumps({'jobs': inputs['jobs']}))
        for name in set(inputs['receipts']) | set(inputs['outcomes']):
            folder = base / 'cases' / f'negative-case-{name}'
            folder.mkdir(parents=True)
            for file, content in inputs['receipts'].get(name, {}).items():
                (folder / file).write_text(json.dumps(content))
            if name in inputs['outcomes']:
                (folder / 'step-outcome.json').write_text(json.dumps(inputs['outcomes'][name]))
        args = [sys.executable, '-B', str(COLLECTOR), str(base / 'jobs.json'), str(base / 'cases'), str(base / 'out.json'), '1', '1', 'a' * 40]
        if workflow is not None:
            (base / 'wf.yml').write_text(workflow)
            args += ['--workflow', str(base / 'wf.yml')]
        result = subprocess.run(args, capture_output=True, text=True)
        report = json.loads((base / 'out.json').read_text()) if (base / 'out.json').exists() else None
        return result.returncode, report, result.stdout + result.stderr


class Collector(unittest.TestCase):
    def assertRejected(self, inputs, workflow=None):
        code, report, output = run(inputs, workflow)
        self.assertNotEqual(code, 0, output)
        if report is not None:
            self.assertFalse(report['all_match'], output)

    def test_positive_baseline_accepted(self):
        code, report, output = run(good_inputs())
        self.assertEqual(code, 0, output)
        self.assertTrue(report['all_match'])

    def test_missing_job(self):
        inputs = good_inputs()
        inputs['jobs'] = [j for j in inputs['jobs'] if j['name'] != 'case-new_skip']
        self.assertRejected(inputs)

    def test_job_success_but_expected_failure(self):
        inputs = good_inputs()
        job = next(j for j in inputs['jobs'] if j['name'] == 'case-new_todo')
        job['conclusion'] = 'success'
        job['steps'][1]['conclusion'] = 'success'
        self.assertRejected(inputs)

    def test_job_failure_but_gate_step_success(self):
        inputs = good_inputs()
        next(j for j in inputs['jobs'] if j['name'] == 'case-truncated_report')['steps'][1]['conclusion'] = 'success'
        self.assertRejected(inputs)

    def test_gate_step_missing(self):
        inputs = good_inputs()
        job = next(j for j in inputs['jobs'] if j['name'] == 'case-missing_output')
        job['steps'] = job['steps'][:1]
        self.assertRejected(inputs)

    def test_exit_receipt_missing(self):
        inputs = good_inputs()
        inputs['receipts'].pop('comparator_nonzero_new_fail')
        self.assertRejected(inputs)

    def test_exit_receipt_tampered(self):
        inputs = good_inputs()
        inputs['receipts']['new_skip']['backend-exit.json']['gate_exit'] = 0
        self.assertRejected(inputs)

    def test_exit_receipt_wrong_tool_exit(self):
        inputs = good_inputs()
        inputs['receipts']['tool_nonzero_output_all_pass']['backend-exit.json']['tool_exit'] = 0
        self.assertRejected(inputs)

    def test_step_outcome_receipt_missing(self):
        inputs = good_inputs()
        inputs['outcomes'].pop('smoke_failure')
        self.assertRejected(inputs)

    def test_step_outcome_receipt_disagrees_with_api(self):
        inputs = good_inputs()
        inputs['outcomes']['build_failure']['gate_step_outcome'] = 'success'
        self.assertRejected(inputs)

    def test_unexpected_extra_case_job(self):
        inputs = good_inputs()
        extra = copy.deepcopy(inputs['jobs'][0])
        extra.update(id=3000, name='case-surprise')
        inputs['jobs'].append(extra)
        self.assertRejected(inputs)

    def test_duplicate_case_job(self):
        inputs = good_inputs()
        dup = copy.deepcopy(next(j for j in inputs['jobs'] if j['name'] == 'case-new_skip'))
        dup.update(id=3001, conclusion='success')
        dup['steps'][1]['conclusion'] = 'success'
        inputs['jobs'].append(dup)
        self.assertRejected(inputs)

    def test_continue_on_error_in_workflow(self):
        workflow = WORKFLOW.read_text().replace("        id: gate\n", "        id: gate\n        continue-on-error: true\n")
        self.assertIn('continue-on-error: true', workflow)
        self.assertRejected(good_inputs(), workflow)

    def test_real_workflow_has_no_continue_on_error(self):
        code, report, output = run(good_inputs(), WORKFLOW.read_text())
        self.assertEqual(code, 0, output)
        self.assertFalse(report['continue_on_error_found'])


if __name__ == '__main__':
    unittest.main(verbosity=1)
