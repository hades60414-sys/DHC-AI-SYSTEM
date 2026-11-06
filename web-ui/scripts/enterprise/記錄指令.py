"""保存不可覆寫的指令證據；在 repo 根目錄執行。"""
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
output = root / sys.argv[1]
command = sys.argv[2:]
output.parent.mkdir(parents=True, exist_ok=True)
metadata = output.with_suffix('.json')
if output.exists() or metadata.exists():
    raise SystemExit('拒絕覆寫既有證據：' + str(output))
started = datetime.datetime.now().astimezone().isoformat()
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
with output.open('x') as stream:
    result = subprocess.run(command, cwd=root, stdout=stream, stderr=subprocess.STDOUT)
metadata.write_text(json.dumps({
    'command': command, 'cwd': str(root), 'source_sha': sha,
    'started_at': started, 'finished_at': datetime.datetime.now().astimezone().isoformat(),
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'npm': subprocess.check_output(['npm', '--version'], text=True).strip(),
    'exit_code': result.returncode,
}, ensure_ascii=False, indent=2) + '\n')
print(str(output.relative_to(root)), 'exit_code=', result.returncode)
raise SystemExit(result.returncode)
