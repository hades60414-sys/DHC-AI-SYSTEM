"""V5.3 WP2：負向閘門案例的合成輸入與「與正式 workflow 相同的閘門指令」。
用法：python3 -B negative_gate_case.py <case> <工作目錄>  → 產生輸入並印出要在 GitHub step（shell: bash／pipefail）執行的指令。
案例與正式 CI 使用同一個 gate.sh／比較器；基線用合成的 DHC_CI_BASELINE（不碰正式基線）。
"""
import json
import sys
from pathlib import Path

case, work = sys.argv[1], Path(sys.argv[2])
work.mkdir(parents=True, exist_ok=True)
baseline = {'backend_tests_detail': [], 'frontend_test_files_detail': [], 'lint_allowances': [],
            'backend_inventory': {'min_tests': 2, 'test_names': {'a': 1, 'b': 1}}, 'frontend_inventory': {'min_tests': 1, 'test_files': ['src/x.test.ts']},
            'lint_counts': {}, 'lint_inventory': {'min_files': 1}, 'skipped_allowed': []}
(work / 'baseline.json').write_text(json.dumps(baseline))


def tap(results, footer=True):
    lines, totals = [], {'tests': 0, 'pass': 0, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}
    for index, (status, name) in enumerate(results, 1):
        totals['tests'] += 1
        if status == 'ok':
            lines.append(f'ok {index} - {name}'); totals['pass'] += 1
        elif status in ('skip', 'todo'):
            lines.append(f'ok {index} - {name} # {status.upper()}'); totals['skipped' if status == 'skip' else 'todo'] += 1
        else:
            lines += [f'not ok {index} - {name}', '  ---', "  location: '/w/web-ui/server/m/t.test.ts:1:1'", "  code: 'ERR_ASSERTION'", '  ...']; totals['fail'] += 1
    lines += [f'# {k} {v}' for k, v in totals.items()]
    if footer:
        lines.append('# duration_ms 1')
    return '\n'.join(lines) + '\n'


GATE = 'bash scripts/enterprise/ci/gate.sh'
clean = tap([('ok', 'a'), ('ok', 'b')])
vitest_pass = json.dumps({'numTotalTests': 1, 'numPassedTests': 1, 'numFailedTests': 0, 'numTotalTestSuites': 1, 'numFailedTestSuites': 0, 'numPendingTests': 0, 'numTodoTests': 0, 'success': True,
                          'testResults': [{'name': '/w/web-ui/src/x.test.ts', 'status': 'passed', 'assertionResults': [{'fullName': 'x', 'status': 'passed'}]}]})
cases = {
    'positive_control': (clean, 'backend', 0),
    'tool_nonzero_output_all_pass': (clean, 'backend', 1),
    'comparator_nonzero_new_fail': (tap([('ok', 'a'), ('fail', 'b')]), 'backend', 1),
    'new_skip': (tap([('ok', 'a'), ('skip', 'b')]), 'backend', 0),
    'new_todo': (tap([('ok', 'a'), ('todo', 'b')]), 'backend', 0),
    'missing_output': (None, 'backend', 0),
    'truncated_report': (tap([('ok', 'a'), ('ok', 'b')], footer=False), 'backend', 0),
    'frontend_exit1_all_pass': (vitest_pass, 'frontend', 1),
}
if case in cases:
    content, kind, tool_exit = cases[case]
    target = work / ('vitest.json' if kind == 'frontend' else 'backend.tap')
    if content is not None:
        target.write_text(content)
    print(f'DHC_CI_BASELINE={work / "baseline.json"} {GATE} {kind} {target} {work / kind} -- bash -c "exit {tool_exit}"')
elif case == 'wrong_sha256':
    (work / 'artifact.tar.gz').write_bytes(b'synthetic artifact')
    (work / 'SHA256SUMS').write_text('0' * 64 + '  artifact.tar.gz\n')
    print(f'(cd {work} && sha256sum -c SHA256SUMS) | tee {work}/sha-check.txt')
elif case == 'build_failure':
    (work / 'Dockerfile').write_text('FROM scratch\nCOPY missing-file /missing\n')
    print(f'docker buildx build --progress=plain -f {work}/Dockerfile {work} 2>&1 | tee {work}/build.log')
elif case == 'smoke_failure':
    print(f'docker run --rm --network none --entrypoint sh busybox:1.36.1 -c "echo smoke; exit 3" | tee {work}/smoke.txt')
else:
    raise SystemExit(f'unknown case {case}')
