"""CI 基線比對（fail closed）：只有「基線以外」的失敗、或測試清單／數量異常才讓 CI 失敗。

用法：
  python3 scripts/enterprise/ci/compare_known_failures.py backend  <node --test 的 TAP 輸出> [--runner-exit N]
  python3 scripts/enterprise/ci/compare_known_failures.py frontend <vitest --reporter=json 輸出> [--runner-exit N]
  python3 scripts/enterprise/ci/compare_known_failures.py lint     <oxlint -f json 輸出> [--runner-exit N]
  （V5.2 ASTRA-ROLL-008：--runner-exit 帶入原工具退出碼；輸出沒有失敗卻非 0 結束＝未處理例外或崩潰，一律 FAIL。）
  python3 scripts/enterprise/ci/compare_known_failures.py snapshot <backend.tap> <vitest.json> <lint.json>   # 重寫清單欄位（人工審查後才提交）

基線檔 known-v32-baseline-failures.json：
- backend_tests_detail／frontend_test_files_detail：仍允許的已知失敗（名稱＠檔案＋失敗特徵＋owner＋expires）。企業測試不得列入。
- backend_inventory：所有測試名稱的多重集合與總數下限——整個測試檔沒跑、測試被刪或 TAP 截斷都會被抓到。
- frontend_inventory：測試檔清單與總數下限。
- lint_counts：(檔案|規則) → 次數上限；同檔同規則次數增加即為新錯誤；lint_allowances 記錄 owner／到期。
- skipped_allowed（V5.2 ASTRA-ROLL-009）：允許 skip／todo 的測試名稱與理由；不在清單內的 skip／todo、或原本執行的測試變成 skip，都是失敗。
  理由 RUNS_IN_POSTGRES_INTEGRATION 表示該測試在本 job 因沒有資料庫而 skip，實際在 postgres-integration job 執行。
- lint_inventory.min_files：lint 掃描檔案數下限（掃描範圍縮小即失敗）。
輸出 JSON 摘要到 stdout；exit 0＝沒有問題，1＝有新失敗、清單異常、基線無效或輸入無法解析。
"""
import collections
import datetime
import json
import re
import sys
from pathlib import Path

import os  # noqa: E402
BASELINE_PATH = Path(os.environ.get('DHC_CI_BASELINE') or Path(__file__).parent / 'known-v32-baseline-failures.json')  # 測試可指定合成基線
TEST_LINE = re.compile(r'^(\s*)(not ok|ok) \d+ - (.+?)(?: # (SKIP|TODO).*)?$')


def load_baseline(path=BASELINE_PATH, today=None):
    data = json.loads(Path(path).read_text())
    today = today or datetime.date.today().isoformat()
    problems = []
    for item in data.get('backend_tests_detail', []) + data.get('frontend_test_files_detail', []) + data.get('lint_allowances', []):
        label = item.get('test_name') or item.get('file') or item.get('scope')
        if not item.get('expires') or item['expires'] < today:
            problems.append(f'基線項目已過期或沒有到期日：{label}')
        if not item.get('owner') or not item.get('remove_when'):
            problems.append(f'基線項目缺 owner／remove_when：{label}')
    for item in data.get('skipped_allowed', []):
        if not item.get('test_name') or not item.get('reason'):
            problems.append(f"skipped_allowed 項目缺 test_name／reason：{item}")
        elif item['reason'] != 'RUNS_IN_POSTGRES_INTEGRATION' and (not item.get('owner') or not item.get('expires') or item['expires'] < today):
            problems.append(f"skipped_allowed 非 PG 項目需 owner 與未過期 expires：{item.get('test_name')}")
    for location in [i.get('file') or '' for i in data.get('backend_tests_detail', []) + data.get('frontend_test_files_detail', [])] + list(data.get('lint_counts', {})):
        if re.search(r'enterprise|/office/', location, re.I):
            problems.append(f'企業測試或企業程式不得列入允許清單：{location}')
    return data, problems


def parse_tap(text):
    if not re.search(r'(?m)^# duration_ms ', text):
        raise ValueError('TAP 缺少結尾 # duration_ms（輸出可能被截斷）')
    totals = {k: int(v) for k, v in re.findall(r'(?m)^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', text)}
    for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']:
        if key not in totals:
            raise ValueError(f'TAP 缺少合計 # {key}')
    if totals['pass'] + totals['fail'] + totals['cancelled'] + totals['skipped'] + totals['todo'] != totals['tests']:
        raise ValueError(f'TAP 合計不一致：{totals}')
    lines = text.splitlines()
    names, failures, skipped = collections.Counter(), {}, collections.Counter()
    for index, line in enumerate(lines):
        match = TEST_LINE.match(line)
        if not match:
            continue
        names[match.group(3)] += 1
        if match.group(4):
            skipped[match.group(3)] += 1
        if match.group(2) != 'not ok':
            continue
        location = code = None
        for follow in lines[index + 1:index + 60]:
            if TEST_LINE.match(follow):
                break
            stripped = follow.strip()
            found = re.search(r"location: '([^']+)'", stripped)
            if found and not location:
                location = found.group(1)
            if stripped.startswith('code:') and not code:
                code = stripped.split(':', 1)[1].strip().strip("'")
        file = location[location.find('server/'):].rsplit(':', 2)[0] if location and 'server/' in location else None
        failures[f'{match.group(3)}@{file}'] = {'code': code}
    return totals, names, failures, skipped


def skip_problems(skipped, baseline):
    allowed = collections.Counter({item['test_name']: item.get('count', 1) for item in baseline.get('skipped_allowed', []) if item.get('test_name')})
    extra = skipped - allowed
    return [f'有未獲許可的 skip／todo：{name}' for name in sorted(extra)]


def backend(text, baseline, runner_exit=None):
    totals, names, failures, skipped = parse_tap(text)
    known = {f"{item['test_name']}@{item['file']}": item for item in baseline.get('backend_tests_detail', [])}
    new = []
    for key, signature in sorted(failures.items()):
        item = known.get(key)
        if not item:
            new.append(key)
        elif (item.get('failure_signature') or {}).get('code') != signature['code']:
            new.append(f"{key}（失敗特徵改變：{(item.get('failure_signature') or {}).get('code')} → {signature['code']}）")
    inventory = baseline.get('backend_inventory') or {}
    expected = collections.Counter(inventory.get('test_names') or {})
    missing = sorted((expected - names).elements())
    problems = []
    if not inventory:
        problems.append('基線缺 backend_inventory（無法判斷測試是否被漏跑）')
    if totals['tests'] < inventory.get('min_tests', 0):
        problems.append(f"測試總數 {totals['tests']} 低於基線 {inventory.get('min_tests')}")
    if missing:
        problems.append(f'有 {len(missing)} 個基線測試沒有出現在本次輸出（測試檔未執行或被刪）')
    problems += skip_problems(skipped, baseline)
    if runner_exit not in (None, 0) and not failures:
        problems.append(f'測試程式以 {runner_exit} 結束但 TAP 沒有失敗（未處理例外、崩潰或被中止）')
    return {'totals': totals, 'new_failures': new, 'missing_tests': missing[:50], 'problems': problems,
            'added_tests': sum((names - expected).values()), 'skipped': dict(skipped), 'runner_exit': runner_exit}


def frontend(text, baseline, runner_exit=None):
    report = json.loads(text)
    files, failures = set(), set()
    for result in report.get('testResults', []):
        name = result.get('name', '')
        rel = name[name.find('src/'):] if 'src/' in name else name
        files.add(rel)
        if result.get('status') == 'failed':
            failures.add(rel)
    totals = {k: report.get(k) for k in ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numTotalTestSuites', 'numFailedTestSuites']}
    known = {item['file'] for item in baseline.get('frontend_test_files_detail', [])}
    inventory = baseline.get('frontend_inventory') or {}
    problems = []
    if not inventory:
        problems.append('基線缺 frontend_inventory')
    if (totals['numTotalTests'] or 0) < inventory.get('min_tests', 0):
        problems.append(f"前端測試總數 {totals['numTotalTests']} 低於基線 {inventory.get('min_tests')}")
    missing = sorted(set(inventory.get('test_files', [])) - files)
    if missing:
        problems.append(f'有 {len(missing)} 個前端測試檔沒有執行')
    skipped = collections.Counter()
    for result in report.get('testResults', []):
        for assertion in result.get('assertionResults', []):
            if assertion.get('status') in ('skipped', 'pending', 'todo', 'disabled'):
                skipped[assertion.get('fullName') or assertion.get('title') or '?'] += 1
    problems += skip_problems(skipped, baseline)
    if (report.get('numPendingTests') or 0) + (report.get('numTodoTests') or 0) > sum(skipped.values()):
        problems.append('vitest 回報 pending／todo 測試，但無法逐一辨識')
    if report.get('success') is False and not failures:
        problems.append('vitest success=false 但沒有失敗的測試檔（未處理例外或執行器錯誤）')
    if runner_exit not in (None, 0) and not failures:
        problems.append(f'vitest 以 {runner_exit} 結束但沒有失敗的測試檔（未處理例外或執行器錯誤）')
    return {'totals': totals, 'new_failures': sorted(failures - known), 'missing_tests': missing[:50], 'problems': problems, 'skipped': dict(skipped), 'runner_exit': runner_exit}


def lint(text, baseline, runner_exit=None):
    report = json.loads(text)
    if not isinstance(report, dict) or not report.get('number_of_files'):
        raise ValueError('oxlint JSON 缺少 number_of_files（可能沒有執行或沒有掃到檔案）')
    errors = [item for item in report.get('diagnostics', []) if item.get('severity') == 'error']
    if any(not item.get('filename') or not item.get('code') for item in errors):
        raise ValueError('有 error 缺少 filename／code')
    counts = collections.Counter(f"{item['filename'].removeprefix('./')}|{item['code']}" for item in errors)
    allowed = baseline.get('lint_counts') or {}
    new = sorted(f'{pair}（{count} > 允許 {allowed.get(pair, 0)}）' for pair, count in counts.items() if count > allowed.get(pair, 0))
    improved = sorted(pair for pair, count in allowed.items() if counts.get(pair, 0) < count)
    problems = []
    min_files = (baseline.get('lint_inventory') or {}).get('min_files', 0)
    if report['number_of_files'] < min_files:
        problems.append(f"lint 掃描檔案數 {report['number_of_files']} 低於基線 {min_files}（掃描範圍縮小）")
    if runner_exit not in (None, 0, 1):
        problems.append(f'oxlint 以 {runner_exit} 結束（0＝無錯、1＝有 lint 錯誤；其他值為執行失敗）')
    return {'totals': {'files': report['number_of_files'], 'errors': len(errors), 'error_pairs': len(counts)},
            'new_failures': new, 'improved_pairs_to_prune': improved, 'problems': problems, 'runner_exit': runner_exit}


def snapshot(tap, vitest, lint_json):
    """以目前輸出重寫清單欄位（不改已知失敗清單）。只在人工確認輸出正確後使用。"""
    data = json.loads(BASELINE_PATH.read_text())
    totals, names, _, _ = parse_tap(Path(tap).read_text(errors='replace'))
    data['backend_inventory'] = {'min_tests': totals['tests'], 'test_names': dict(sorted(names.items()))}
    report = json.loads(Path(vitest).read_text())
    files = sorted({r['name'][r['name'].find('src/'):] for r in report['testResults'] if 'src/' in r['name']})
    data['frontend_inventory'] = {'min_tests': report['numTotalTests'], 'test_files': files}
    lint_report = json.loads(Path(lint_json).read_text())
    counts = collections.Counter(f"{i['filename'].removeprefix('./')}|{i['code']}" for i in lint_report['diagnostics'] if i['severity'] == 'error')
    data['lint_counts'] = dict(sorted(counts.items()))
    BASELINE_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n')
    return {'backend_tests': totals['tests'], 'frontend_files': len(files), 'lint_pairs': len(counts), 'lint_errors': sum(counts.values())}


def run(kind, path, baseline_path=BASELINE_PATH, today=None, runner_exit=None):
    try:
        baseline, problems = load_baseline(baseline_path, today)
        result = {'backend': backend, 'frontend': frontend, 'lint': lint}[kind](Path(path).read_text(errors='replace'), baseline, runner_exit)
    except (KeyError, ValueError, OSError) as error:
        return {'kind': kind, 'status': 'FAIL', 'error': f'無法判定：{error}'}
    result['problems'] = problems + result['problems']
    result['kind'] = kind
    result['status'] = 'FAIL' if result['new_failures'] or result['problems'] else 'PASS'
    return result


def main():
    if sys.argv[1] == 'snapshot':
        print(json.dumps(snapshot(*sys.argv[2:5]), ensure_ascii=False))
        return 0
    runner_exit = None
    if '--runner-exit' in sys.argv:
        runner_exit = int(sys.argv[sys.argv.index('--runner-exit') + 1])
    result = run(sys.argv[1], sys.argv[2], runner_exit=runner_exit)
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0 if result['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
