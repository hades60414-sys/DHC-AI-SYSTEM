"""在乾淨、無 .env 的授權 checkout 重跑 G0；輸出使用新目錄，不覆寫紀錄。"""
import argparse
import datetime
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--only', choices=['ci','build','backend','client','typecheck','lint','smoke'])
args = parser.parse_args()
env = {key:value for key,value in os.environ.items()
    if key in ['PATH','TMPDIR','SHELL','USER','LANG','LC_ALL']}
local_tools = root.parent / '工具鏈/node_modules/.bin'
if local_tools.is_dir():
    env['PATH'] = str(local_tools) + ':' + env.get('PATH','')
node = subprocess.check_output(['node','--version'],env=env,text=True).strip()
if not node.startswith('v22.'):
    raise SystemExit('請在 PATH 提供 Node 22；目前 ' + node)
if (root / '.env').exists():
    raise SystemExit('請使用無 .env、無真實資料的隔離 checkout')
output = 'evidence/G0/重跑_' + datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f')
commands = {
    'ci':['npm','ci','--no-audit','--no-fund'],
    'build':['npm','run','build'],
    'backend':['npm','test'],
    'client':['npm','run','test:client'],
    'typecheck':['npm','run','typecheck'],
    'lint':['npm','run','lint'],
    'smoke':['python3','scripts/enterprise/基線啟動測試.py'],
}
for name, command in commands.items():
    if args.only and name != args.only:
        continue
    with tempfile.TemporaryDirectory(prefix='dhc-g0-') as fixture:
        check_env = env.copy()
        check_env['ELECTRON_SKIP_BINARY_DOWNLOAD'] = '1'
        if name == 'backend':
            check_env.update(DHC_TEST_ROOT=fixture,DATABASE_PATH=fixture+'/auth.db',
                WORKSPACES_ROOT=fixture,
                NODE_OPTIONS='--import="'+str(root/'scripts/enterprise/隔離測試家目錄.mjs')+'"')
        result = subprocess.run(['python3','scripts/enterprise/記錄指令.py',
            output+'/'+name+'.txt',*command], cwd=root,env=check_env)
        if result.returncode:
            raise SystemExit(result.returncode)
print('G0 通過；證據：' + output)
