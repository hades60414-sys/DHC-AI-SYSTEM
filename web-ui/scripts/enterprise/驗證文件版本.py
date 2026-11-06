"""E05-DOC-01 QA 驅動：以唯一 Compose project 啟動合成 PostgreSQL，逐檔序列執行指定的整合測試，結束刪除自己建立的資源。

用法（repo 根目錄、DOCKER_HOST 指向隔離 QA 的 Colima profile）：
    python3 -B scripts/enterprise/驗證文件版本.py --evidence <新目錄> <test.ts> [<test.ts> ...]

- 每個測試檔各自一個 記錄指令.py 證據（命令、source SHA、exit code、原始輸出），檔案之間序列執行，
  因為兩個整合測試都會重建同一個合成 QA DB 的 enterprise schema。
- 任何測試失敗都照實記錄並讓本程式以 1 結束；不重試、不跳過。
- 不建立/刪除 Docker VM、不改 Docker context、不碰 SQLite、不印出密碼（密碼只在子行程環境變數）。
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
os.chdir(ROOT)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--evidence', type=Path, required=True)
parser.add_argument('tests', nargs='+')
args = parser.parse_args()
HARNESSES = {'tests/enterprise/sec01/run_sec01.py'}
for test_file in args.tests:
    allowed = test_file in HARNESSES or re.fullmatch(r'server/modules/enterprise-(persistence|api)/tests/[a-z.-]+\.integration\.test\.ts', test_file)
    if not allowed or not Path(test_file).is_file():
        raise SystemExit('只允許 enterprise-persistence / enterprise-api 整合測試或 SEC-01 harness：' + test_file)
capacity = subprocess.run([sys.executable, str(ROOT / 'scripts/enterprise/檢查測試容量.py'), '--stage', 'running-vm'])
if capacity.returncode:
    raise SystemExit(capacity.returncode)
out = args.evidence.resolve()
out.mkdir(parents=True, exist_ok=False)
env = {k: v for k, v in os.environ.items() if k in ('PATH', 'TMPDIR', 'SHELL', 'USER', 'LANG', 'LC_ALL', 'DOCKER_HOST')}
if not subprocess.check_output(['node', '--version'], env=env, text=True).startswith('v22.'):
    raise SystemExit('需要 Node 22')

token = secrets.token_hex(4)
directory = ROOT / '.tmp' / ('e05-' + token)
directory.mkdir(parents=True, exist_ok=False)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
project, database = 'dhc-e05-' + token, 'dhc_e02a_qa_' + token
secret_dir = directory / 'secrets'
subprocess.run(['python3', 'deploy/customer-single/產生本機資料庫密碼.py', '--directory', str(secret_dir)], check=True, env=env)
env.update(DHC_SECRET_DIR=str(secret_dir), DHC_DATABASE_NAME=database)
values = dict(line.split('=', 1) for line in (secret_dir / 'bootstrap.env').read_text().splitlines())
test_env = dict(E02A_TEST_DATABASE=database, E02A_TEST_PORT=str(port), E02A_TEST_ADMIN_PASSWORD=values['POSTGRES_PASSWORD'],
                E02A_TEST_APP_PASSWORD=values['ENTERPRISE_APP_PASSWORD'], E02A_TEST_MIGRATOR_PASSWORD=values['ENTERPRISE_MIGRATOR_PASSWORD'])
override = directory / 'override.yaml'
override.write_text(f'services:\n  db:\n    networks: [enterprise-db, default]\n    ports:\n      - "127.0.0.1:{port}:5432"\n')
compose = ['docker-compose', '-p', project, '-f', 'deploy/customer-single/compose.yaml', '-f', str(override)]
steps = []


def record(name, command, extra=None):
    result = subprocess.run(['python3', 'scripts/enterprise/記錄指令.py', str(out / (name + '.txt')), *command], env={**env, **(extra or {})})
    steps.append(dict(name=name, exit_code=result.returncode))
    return result.returncode


status = 'PASS'
try:
    if record('01-db-up', compose + ['up', '-d', '--wait', '--wait-timeout', '180', 'db']):
        raise RuntimeError('DB 啟動失敗')
    for index, test_file in enumerate(args.tests, start=2):
        if test_file in HARNESSES:
            name = f'{index:02d}-' + Path(test_file).stem
            # 矩陣輸出用 .matrix.json，避免與記錄器的 <name>.json metadata 同名覆蓋。
            code = record(name, ['python3', '-B', test_file, str(out / (name + '.matrix.json'))], test_env)
        else:
            name = f'{index:02d}-' + Path(test_file).name.removesuffix('.integration.test.ts')
            code = record(name, ['node_modules/.bin/tsx', '--tsconfig', 'server/tsconfig.json', '--test', test_file], test_env)
        if code:
            status = 'FAIL'
except Exception as error:  # 環境錯誤照實寫入結果
    status = 'ERROR: ' + type(error).__name__ + ': ' + str(error)
finally:
    cleanup = subprocess.run(compose + ['down', '--volumes', '--remove-orphans'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (out / '99-cleanup.txt').write_bytes(cleanup.stdout)
    shutil.rmtree(directory)
    (out / 'RESULT.json').write_text(json.dumps(dict(status=status, project=project, steps=steps,
        cleanup_exit_code=cleanup.returncode, fixture_removed=not directory.exists()), ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(dict(status=status, steps=steps, cleanup_exit_code=cleanup.returncode), ensure_ascii=False))
raise SystemExit(0 if status == 'PASS' and cleanup.returncode == 0 else 1)
