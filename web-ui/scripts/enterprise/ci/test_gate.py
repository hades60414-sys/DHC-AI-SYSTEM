"""V5.2 ASTRA-ROLL-001／008／009：CI 閘門負向測試（在 GitHub static-and-unit 實際執行）。
以假工具＋合成輸出呼叫 gate.sh，驗證：新失敗、未處理例外（輸出全過但非 0）、截斷／缺檔、未許可 skip、lint 範圍縮小／非預期退出碼 → 閘門非 0；
正常輸出 → 0。另驗證 `| tee` 在 pipefail 下保留 checksum 失敗，且三個 workflow 的每個 job 都宣告 shell: bash。
用法：python3 -B scripts/enterprise/ci/test_gate.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
GATE = HERE / 'gate.sh'
REPO_ROOT = HERE.parents[3]


def tap(results, footer=True):
    lines, totals = [], {'tests': 0, 'pass': 0, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}
    for index, (status, name) in enumerate(results, 1):
        totals['tests'] += 1
        if status == 'ok':
            lines.append(f'ok {index} - {name}'); totals['pass'] += 1
        elif status == 'skip':
            lines.append(f'ok {index} - {name} # SKIP'); totals['skipped'] += 1
        else:
            lines += [f'not ok {index} - {name}', '  ---', "  location: '/w/web-ui/server/m/t.test.ts:1:1'", "  code: 'ERR_ASSERTION'", '  ...']; totals['fail'] += 1
    lines += [f'# {k} {v}' for k, v in totals.items()]
    if footer:
        lines.append('# duration_ms 1')
    return '\n'.join(lines) + '\n'


class Gate(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        baseline = {'backend_tests_detail': [], 'frontend_test_files_detail': [], 'lint_allowances': [],
                    'backend_inventory': {'min_tests': 2, 'test_names': {'a': 1, 'b': 1}},
                    'frontend_inventory': {'min_tests': 1, 'test_files': ['src/x.test.ts']},
                    'lint_counts': {}, 'lint_inventory': {'min_files': 10},
                    'skipped_allowed': [{'test_name': 'pg-suite', 'reason': 'RUNS_IN_POSTGRES_INTEGRATION'}]}
        (self.dir / 'baseline.json').write_text(json.dumps(baseline))
        self.env = {**os.environ, 'DHC_CI_BASELINE': str(self.dir / 'baseline.json')}

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def gate(self, kind, content, tool_exit=0, write=True):
        out = self.dir / f'{kind}.out'
        if write:
            out.write_text(content)
        elif out.exists():
            out.unlink()
        result = subprocess.run(['bash', str(GATE), kind, str(out), str(self.dir / kind), '--', 'bash', '-c', f'exit {tool_exit}'], env=self.env, capture_output=True, text=True)
        exits = json.loads((self.dir / f'{kind}-exit.json').read_text())
        self.assertEqual(exits['tool_exit'], tool_exit)
        self.assertEqual(exits['gate_exit'], result.returncode)
        return result.returncode

    def vitest(self, success=True, failed=False, pending=0):
        return json.dumps({'numTotalTests': 1, 'numPassedTests': 0 if failed else 1, 'numFailedTests': 1 if failed else 0, 'numTotalTestSuites': 1, 'numFailedTestSuites': 1 if failed else 0,
                           'numPendingTests': pending, 'numTodoTests': 0, 'success': success,
                           'testResults': [{'name': '/w/web-ui/src/x.test.ts', 'status': 'failed' if failed else 'passed',
                                            'assertionResults': [{'fullName': 'x', 'status': 'pending' if pending else ('failed' if failed else 'passed')}]}]})

    def test_backend_clean_passes(self):
        self.assertEqual(self.gate('backend', tap([('ok', 'a'), ('ok', 'b'), ('skip', 'pg-suite')])), 0)

    def test_backend_new_failure_fails(self):
        self.assertEqual(self.gate('backend', tap([('ok', 'a'), ('fail', 'b')]), tool_exit=1), 1)

    def test_backend_unhandled_error_fails_even_if_tap_clean(self):
        self.assertEqual(self.gate('backend', tap([('ok', 'a'), ('ok', 'b')]), tool_exit=1), 1)

    def test_backend_truncated_and_missing_fail(self):
        self.assertEqual(self.gate('backend', tap([('ok', 'a'), ('ok', 'b')], footer=False)), 1)
        self.assertEqual(self.gate('backend', '', write=False), 1)

    def test_backend_new_skip_fails(self):
        self.assertEqual(self.gate('backend', tap([('ok', 'a'), ('skip', 'b')])), 1)

    def test_frontend(self):
        self.assertEqual(self.gate('frontend', self.vitest()), 0)
        self.assertEqual(self.gate('frontend', self.vitest(), tool_exit=1), 1, '全過但非 0（未處理例外）')
        self.assertEqual(self.gate('frontend', self.vitest(success=False)), 1)
        self.assertEqual(self.gate('frontend', self.vitest(pending=1)), 1)
        self.assertEqual(self.gate('frontend', self.vitest(failed=True), tool_exit=1), 1)
        self.assertEqual(self.gate('frontend', '', write=False), 1)

    def test_lint(self):
        lint = lambda files, pairs: json.dumps({'number_of_files': files, 'diagnostics': [{'severity': 'error', 'filename': f, 'code': c} for f, c in pairs]})
        self.assertEqual(self.gate('lint', lint(10, [])), 0)
        self.assertEqual(self.gate('lint', lint(10, [('src/a.ts', 'eslint(no-eval)')]), tool_exit=1), 1)
        self.assertEqual(self.gate('lint', lint(9, [])), 1, '掃描範圍縮小')
        self.assertEqual(self.gate('lint', lint(10, []), tool_exit=2), 1, 'oxlint 執行失敗')


class Shell(unittest.TestCase):
    def test_tee_masks_failure_without_pipefail_but_not_with_bash_pipefail(self):
        work = Path(tempfile.mkdtemp())
        (work / 'f').write_text('x')
        (work / 'SUMS').write_text('0' * 64 + '  f\n')
        tool = 'sha256sum' if shutil.which('sha256sum') else 'shasum -a 256'
        cmd = f'cd {work} && ({tool} -c SUMS) | tee out.txt'
        self.assertEqual(subprocess.run(['bash', '-e', '-c', cmd], capture_output=True).returncode, 0, '對照：沒有 pipefail 時 tee 遮蔽失敗（原缺陷）')
        self.assertNotEqual(subprocess.run(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', cmd], capture_output=True).returncode, 0, 'GitHub shell: bash 會失敗')
        shutil.rmtree(work, ignore_errors=True)

    def test_every_workflow_job_declares_bash(self):
        import yaml
        for name in ['enterprise-verify.yml', 'enterprise-image-build.yml', 'enterprise-delivery-smoke.yml', 'repo-coverage.yml', 'negative-gate-evidence.yml', 'office-e2e-evidence.yml']:
            workflow = yaml.safe_load((REPO_ROOT / '.github/workflows' / name).read_text())
            top = ((workflow.get('defaults') or {}).get('run') or {}).get('shell')
            for job_name, job in workflow['jobs'].items():
                if 'uses' in job:
                    continue
                job_shell = ((job.get('defaults') or {}).get('run') or {}).get('shell') or top
                for step in job.get('steps', []):
                    if 'run' in step:
                        self.assertEqual(step.get('shell') or job_shell, 'bash', f'{name}:{job_name}:{step.get("name")} 沒有 shell: bash（pipefail）')


if __name__ == '__main__':
    unittest.main(verbosity=2)
