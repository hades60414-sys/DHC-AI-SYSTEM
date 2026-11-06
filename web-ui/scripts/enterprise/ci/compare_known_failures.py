"""CI：把測試／lint 的失敗與 known-v32-baseline-failures.json 比對；只有「清單以外」的失敗才讓 CI 失敗。

用法：
  python3 scripts/enterprise/ci/compare_known_failures.py backend  <node --test 的 TAP 輸出檔>
  python3 scripts/enterprise/ci/compare_known_failures.py frontend <vitest --reporter=json 的輸出檔>
  python3 scripts/enterprise/ci/compare_known_failures.py lint     <oxlint 輸出檔>
基線是 DHC CLI V3.2 原本就有的失敗（以未合併的 V3.2 實測）；企業測試不在清單內，企業測試失敗一律讓 CI 失敗。
輸出 JSON 摘要到 stdout；exit 0＝沒有新失敗，1＝有新失敗或輸入無法解析（fail closed）。
"""
import json
import re
import sys
from pathlib import Path

BASELINE = json.loads((Path(__file__).parent / 'known-v32-baseline-failures.json').read_text())


def backend(text):
    """失敗識別＝「測試名稱＠所在檔案」；名稱與檔案都相同才算已知（避免別檔同名新失敗被白名單蓋掉）。"""
    lines = text.splitlines()
    failures = set()
    for index, line in enumerate(lines):
        match = re.match(r'^\s*not ok \d+ - (.+)$', line)
        if not match:
            continue
        location = None
        for follow in lines[index + 1:index + 40]:
            if re.match(r'^\s*(not )?ok \d+ - ', follow):
                break
            found = re.search(r"location: '([^']+)'", follow)
            if found:
                location = found.group(1)
                break
        file = location[location.find('server/'):].rsplit(':', 2)[0] if location and 'server/' in location else None
        failures.add(f'{match.group(1)}@{file}')
    totals = dict(re.findall(r'(?m)^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', text))
    if 'tests' not in totals:
        raise ValueError('找不到 TAP 合計（# tests）')
    known = {f"{item['test_name']}@{item['file']}" for item in BASELINE['backend_tests_detail']}
    return failures, known, totals


def frontend(text):
    report = json.loads(text)
    failures = set()
    for result in report.get('testResults', []):
        name = result.get('name', '')
        rel = name[name.find('src/'):] if 'src/' in name else name
        if result.get('status') == 'failed':
            failures.add(rel)
    totals = {k: report.get(k) for k in ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numTotalTestSuites', 'numFailedTestSuites']}
    return failures, set(BASELINE['frontend_test_files']), totals


def lint(text):
    failures = {f'{m.group(1)}|{m.group(2)}' for m in re.finditer(r'(?m)^(\S+?):\d+:\d+: error (\S+)', text)}
    return failures, set(BASELINE['lint_errors_file_rule']), {'error_pairs': len(failures)}


def main():
    kind, path = sys.argv[1], Path(sys.argv[2])
    try:
        failures, known, totals = {'backend': backend, 'frontend': frontend, 'lint': lint}[kind](path.read_text(errors='replace'))
    except (KeyError, ValueError, OSError) as error:
        print(json.dumps({'kind': kind, 'status': 'FAIL', 'error': f'無法解析：{error}'}, ensure_ascii=False))
        return 1
    new = sorted(failures - known)
    result = {'kind': kind, 'status': 'FAIL' if new else 'PASS', 'totals': totals, 'new_failures': new,
              'known_baseline_failures_seen': sorted(failures & known), 'known_baseline_size': len(known)}
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 1 if new else 0


if __name__ == '__main__':
    raise SystemExit(main())
