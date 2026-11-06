"""compare_known_failures.py 的單元測試（合成 fixture）。用法：python3 -B scripts/enterprise/ci/test_compare_known_failures.py"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compare_known_failures as c  # noqa: E402

FUTURE = '2099-01-01'


def tap(results, extra_totals=None, footer=True):
    """results：[(status, name, code, file)]；status ∈ ok／not ok／skip／cancelled。"""
    lines, totals = [], {'tests': 0, 'pass': 0, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}
    for index, (status, name, code, file) in enumerate(results, 1):
        totals['tests'] += 1
        if status == 'ok':
            lines.append(f'ok {index} - {name}'); totals['pass'] += 1
        elif status == 'skip':
            lines.append(f'ok {index} - {name} # SKIP'); totals['skipped'] += 1
        else:
            lines.append(f'not ok {index} - {name}')
            lines += ['  ---', f"  location: '/w/web-ui/{file}:1:1'", f"  code: '{code}'", '  ...']
            totals['cancelled' if status == 'cancelled' else 'fail'] += 1
    totals.update(extra_totals or {})
    lines += [f'# {k} {v}' for k, v in totals.items()]
    if footer:
        lines.append('# duration_ms 12.5')
    return '\n'.join(lines) + '\n'


class Base(unittest.TestCase):
    def baseline(self, **overrides):
        data = {'backend_tests_detail': [], 'frontend_test_files_detail': [], 'lint_allowances': [],
                'backend_inventory': {'min_tests': 2, 'test_names': {'a': 1, 'b': 1}},
                'frontend_inventory': {'min_tests': 2, 'test_files': ['src/x.test.ts', 'src/y.test.ts']},
                'lint_counts': {'src/z.tsx|boundaries(dependencies)': 2}}
        data.update(overrides)
        handle = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False)
        json.dump(data, handle); handle.close()
        return handle.name

    def check(self, kind, text, baseline=None, today='2026-11-06'):
        handle = tempfile.NamedTemporaryFile('w', delete=False)
        handle.write(text); handle.close()
        return c.run(kind, handle.name, baseline or self.baseline(), today)


class Backend(Base):
    def test_clean_run_passes(self):
        self.assertEqual(self.check('backend', tap([('ok', 'a', None, None), ('ok', 'b', None, None)]))['status'], 'PASS')

    def test_new_failure_fails(self):
        r = self.check('backend', tap([('ok', 'a', None, None), ('not ok', 'b', 'ERR_ASSERTION', 'server/m/t.test.ts')]))
        self.assertEqual(r['status'], 'FAIL'); self.assertIn('b@server/m/t.test.ts', r['new_failures'])

    def test_cancelled_counts_as_failure(self):
        r = self.check('backend', tap([('ok', 'a', None, None), ('cancelled', 'b', 'ERR_TEST_FAILURE', 'server/m/t.test.ts')]))
        self.assertEqual(r['status'], 'FAIL'); self.assertEqual(r['totals']['cancelled'], 1)

    def test_known_failure_same_signature_passes_but_new_reason_fails(self):
        known = [{'test_name': 'b', 'file': 'server/m/t.test.ts', 'failure_signature': {'code': 'ERR_ASSERTION'}, 'owner': 'o', 'remove_when': 'r', 'expires': FUTURE}]
        base = self.baseline(backend_tests_detail=known)
        self.assertEqual(self.check('backend', tap([('ok', 'a', None, None), ('not ok', 'b', 'ERR_ASSERTION', 'server/m/t.test.ts')]), base)['status'], 'PASS')
        r = self.check('backend', tap([('ok', 'a', None, None), ('not ok', 'b', 'ERR_TEST_FAILURE', 'server/m/t.test.ts')]), base)
        self.assertEqual(r['status'], 'FAIL'); self.assertIn('失敗特徵改變', r['new_failures'][0])

    def test_same_name_in_other_file_is_new(self):
        known = [{'test_name': 'b', 'file': 'server/m/t.test.ts', 'failure_signature': {'code': 'ERR_ASSERTION'}, 'owner': 'o', 'remove_when': 'r', 'expires': FUTURE}]
        r = self.check('backend', tap([('ok', 'a', None, None), ('not ok', 'b', 'ERR_ASSERTION', 'server/other/t.test.ts')]), self.baseline(backend_tests_detail=known))
        self.assertEqual(r['status'], 'FAIL')

    def test_missing_test_file_detected(self):
        r = self.check('backend', tap([('ok', 'a', None, None), ('ok', 'c', None, None)]))
        self.assertEqual(r['status'], 'FAIL'); self.assertEqual(r['missing_tests'], ['b'])

    def test_total_decrease_detected(self):
        r = self.check('backend', tap([('ok', 'a', None, None)]))
        self.assertEqual(r['status'], 'FAIL'); self.assertTrue(any('低於基線' in p for p in r['problems']))

    def test_truncated_tap_fails_closed(self):
        r = self.check('backend', tap([('ok', 'a', None, None), ('ok', 'b', None, None)], footer=False))
        self.assertEqual(r['status'], 'FAIL'); self.assertIn('截斷', r['error'])

    def test_inconsistent_totals_fail_closed(self):
        r = self.check('backend', tap([('ok', 'a', None, None), ('ok', 'b', None, None)], extra_totals={'tests': 9}))
        self.assertEqual(r['status'], 'FAIL'); self.assertIn('不一致', r['error'])

    def test_expired_baseline_fails(self):
        known = [{'test_name': 'b', 'file': 'server/m/t.test.ts', 'failure_signature': {'code': 'X'}, 'owner': 'o', 'remove_when': 'r', 'expires': '2026-01-01'}]
        r = self.check('backend', tap([('ok', 'a', None, None), ('ok', 'b', None, None)]), self.baseline(backend_tests_detail=known))
        self.assertEqual(r['status'], 'FAIL'); self.assertTrue(any('過期' in p for p in r['problems']))

    def test_enterprise_test_in_allowlist_rejected(self):
        known = [{'test_name': 'b', 'file': 'server/modules/enterprise-api/tests/x.test.ts', 'failure_signature': {'code': 'X'}, 'owner': 'o', 'remove_when': 'r', 'expires': FUTURE}]
        r = self.check('backend', tap([('ok', 'a', None, None), ('ok', 'b', None, None)]), self.baseline(backend_tests_detail=known))
        self.assertEqual(r['status'], 'FAIL'); self.assertTrue(any('企業' in p for p in r['problems']))

    def test_missing_owner_rejected(self):
        known = [{'test_name': 'b', 'file': 'server/m/t.test.ts', 'failure_signature': {'code': 'X'}, 'expires': FUTURE}]
        r = self.check('backend', tap([('ok', 'a', None, None), ('ok', 'b', None, None)]), self.baseline(backend_tests_detail=known))
        self.assertEqual(r['status'], 'FAIL')


class Frontend(Base):
    def report(self, files, failed=(), total=2):
        return json.dumps({'numTotalTests': total, 'numPassedTests': total, 'numFailedTests': 0, 'numTotalTestSuites': len(files), 'numFailedTestSuites': len(failed),
                           'testResults': [{'name': f'/w/web-ui/{f}', 'status': 'failed' if f in failed else 'passed'} for f in files]})

    def test_clean(self):
        self.assertEqual(self.check('frontend', self.report(['src/x.test.ts', 'src/y.test.ts']))['status'], 'PASS')

    def test_suite_missing(self):
        r = self.check('frontend', self.report(['src/x.test.ts']))
        self.assertEqual(r['status'], 'FAIL'); self.assertEqual(r['missing_tests'], ['src/y.test.ts'])

    def test_failed_suite(self):
        self.assertEqual(self.check('frontend', self.report(['src/x.test.ts', 'src/y.test.ts'], failed=['src/y.test.ts']))['status'], 'FAIL')

    def test_total_decrease(self):
        self.assertEqual(self.check('frontend', self.report(['src/x.test.ts', 'src/y.test.ts'], total=1))['status'], 'FAIL')


class Lint(Base):
    def report(self, pairs, files=10):
        return json.dumps({'number_of_files': files, 'diagnostics': [{'severity': 'error', 'filename': f, 'code': r} for f, r in pairs]})

    def test_within_allowance(self):
        r = self.check('lint', self.report([('src/z.tsx', 'boundaries(dependencies)')] * 2))
        self.assertEqual(r['status'], 'PASS')

    def test_same_pair_more_times_is_new(self):
        r = self.check('lint', self.report([('src/z.tsx', 'boundaries(dependencies)')] * 3))
        self.assertEqual(r['status'], 'FAIL'); self.assertIn('3 > 允許 2', r['new_failures'][0])

    def test_new_pair(self):
        self.assertEqual(self.check('lint', self.report([('server/a.ts', 'eslint(no-eval)')]))['status'], 'FAIL')

    def test_improvement_reported(self):
        r = self.check('lint', self.report([('src/z.tsx', 'boundaries(dependencies)')]))
        self.assertEqual(r['status'], 'PASS'); self.assertEqual(r['improved_pairs_to_prune'], ['src/z.tsx|boundaries(dependencies)'])

    def test_no_files_fail_closed(self):
        self.assertEqual(self.check('lint', self.report([], files=0))['status'], 'FAIL')

    def test_github_annotation_text_rejected(self):
        self.assertEqual(self.check('lint', '::error file=a.ts,title=x::a.ts:1:1: msg\nFound 0 warnings and 1 error.\n')['status'], 'FAIL')

    def test_enterprise_lint_allowance_rejected(self):
        r = self.check('lint', self.report([]), self.baseline(lint_counts={'server/modules/enterprise-api/x.ts|eslint(no-eval)': 1}))
        self.assertEqual(r['status'], 'FAIL')


class RealBaseline(unittest.TestCase):
    def test_repository_baseline_is_valid_today(self):
        _, problems = c.load_baseline()
        self.assertEqual(problems, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
