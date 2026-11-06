"""V5.2 RG-003：全 repository 覆蓋契約檢查。
- 每個追蹤中的頂層路徑都必須在 .github/repo-coverage-contract.json 分類，否則失敗（新目錄不能默默落在 CI 之外）。
- STATIC_SYNTAX_ONLY 元件：JS（.js/.cjs/.mjs）以 `node --check` 解析、Python 以 py_compile 編譯；不執行任何程式。C#／PowerShell 記為 NOT_RUN。
- 輸出各元件的檔案分母與檢查結果 JSON。
用法：python3 -B web-ui/scripts/enterprise/ci/check_repo_coverage.py <輸出.json>（在 repo 根目錄）
"""
import collections
import json
import py_compile
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
contract = json.loads((ROOT / '.github/repo-coverage-contract.json').read_text())['components']
files = [f for f in subprocess.run(['git', '-C', str(ROOT), 'ls-files', '-z'], capture_output=True, text=True, check=True).stdout.split('\0') if f]
by_component, problems = collections.defaultdict(list), []
root_files = set(contract.get('ROOT_FILES', {}).get('files', []))
for path in files:
    if '/' in path:
        top = path.split('/', 1)[0]
        if top not in contract:
            problems.append(f'未分類的頂層目錄：{top}')
            continue
        by_component[top].append(path)
    elif path in root_files:
        by_component['ROOT_FILES'].append(path)
    else:
        problems.append(f'未分類的頂層檔案：{path}')
report = {'contract': '.github/repo-coverage-contract.json', 'total_tracked_files': len(files), 'components': {}}
for name, meta in contract.items():
    paths = by_component.get(name, [])
    entry = {'class': meta['class'], 'files': len(paths), 'in_enterprise_image': meta.get('in_enterprise_image', False)}
    if meta['class'] == 'STATIC_SYNTAX_ONLY':
        js = [p for p in paths if p.endswith(('.js', '.cjs', '.mjs'))]
        py = [p for p in paths if p.endswith('.py')]
        js_fail, py_fail = [], []
        for p in js:
            result = subprocess.run(['node', '--check', str(ROOT / p)], capture_output=True, text=True)
            if result.returncode:
                js_fail.append({'file': p, 'error': (result.stderr.strip().splitlines() or ['?'])[-1][:200]})
        with tempfile.TemporaryDirectory() as tmp:
            for p in py:
                try:
                    py_compile.compile(str(ROOT / p), cfile=str(Path(tmp) / 'x.pyc'), doraise=True)
                except py_compile.PyCompileError as error:
                    py_fail.append({'file': p, 'error': str(error)[:200]})
        entry.update(js_checked=len(js), js_failed=js_fail, py_checked=len(py), py_failed=py_fail,
                     not_run=sum(1 for p in paths if p.endswith(('.cs', '.ps1', '.psm1'))), runtime=meta.get('runtime'))
        problems += [f"{name}: JS 語法錯誤 {item['file']}" for item in js_fail] + [f"{name}: Python 語法錯誤 {item['file']}" for item in py_fail]
    else:
        entry['runtime'] = meta.get('runtime')
    report['components'][name] = entry
report['problems'] = problems
report['status'] = 'FAIL' if problems else 'PASS'
Path(sys.argv[1]).write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
print(json.dumps({'status': report['status'], 'problems': problems[:20], 'files': {k: v['files'] for k, v in report['components'].items()}}, ensure_ascii=False))
sys.exit(1 if problems else 0)
