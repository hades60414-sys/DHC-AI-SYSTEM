"""以唯一 Compose project 與合成 DB 驗證 E02a；需要 Docker、Node 22、已 build。
可用 --resume-state 接續本輪 QA；預設建立、驗證並刪除自己建立的 volumes/秘密。
不建立/刪除 Docker VM，不修改 Docker context，不碰既有 SQLite。
"""
import argparse
import datetime
import hashlib
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
parser.add_argument('--resume-state', type=Path)
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
capacity = subprocess.run([sys.executable,str(ROOT/'scripts/enterprise/檢查測試容量.py'),'--stage','running-vm'])
if capacity.returncode:
    raise SystemExit(capacity.returncode)
out = args.evidence.resolve()
out.mkdir(parents=True, exist_ok=False)
env = {k: v for k, v in os.environ.items() if k in ('PATH','TMPDIR','SHELL','USER','LANG','LC_ALL','DOCKER_HOST')}
local_node = ROOT.parent / '工具鏈/node_modules/.bin'
if local_node.is_dir(): env['PATH'] = str(local_node) + ':' + env.get('PATH','')
if not subprocess.check_output(['node','--version'],env=env,text=True).startswith('v22.'):
    raise SystemExit('需要 Node 22')
if not (ROOT/'dist-server/server/modules/enterprise-persistence/migrate.cli.js').exists():
    raise SystemExit('先執行 npm run build')
if args.resume_state:
    state = json.loads(args.resume_state.read_text())
else:
    token = secrets.token_hex(4)
    directory = ROOT/'.tmp'/('e02a-'+token)
    directory.mkdir(parents=True, exist_ok=False)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port = sock.getsockname()[1]
    state = dict(directory=str(directory), secret_dir=str(directory/'secrets'), project='dhc-e02a-'+token,
                 database='dhc_e02a_qa_'+token, port=port, docker_host=env.get('DOCKER_HOST',''))
    subprocess.run(['python3','deploy/customer-single/產生本機資料庫密碼.py','--directory',state['secret_dir']],check=True,env=env)
    (directory/'state.json').write_text(json.dumps(state))
directory = Path(state['directory']).resolve()
assert directory.parent == ROOT/'.tmp' and re.fullmatch(r'e02a-[a-f0-9]+',directory.name)
assert re.fullmatch(r'dhc-e02a-[a-f0-9]+',state['project'])
assert re.fullmatch(r'dhc_e02a_qa_[a-f0-9]+',state['database'])
assert Path(state['secret_dir']).resolve() == directory/'secrets'
if state.get('docker_host'): env['DOCKER_HOST'] = state['docker_host']
env.update(DHC_SECRET_DIR=state['secret_dir'],DHC_DATABASE_NAME=state['database'])
values = dict(line.split('=',1) for line in (directory/'secrets/bootstrap.env').read_text().splitlines())
env.update(E02A_TEST_DATABASE=state['database'],E02A_TEST_PORT=str(state['port']),
           E02A_TEST_ADMIN_PASSWORD=values['POSTGRES_PASSWORD'],E02A_TEST_APP_PASSWORD=values['ENTERPRISE_APP_PASSWORD'],
           E02A_TEST_MIGRATOR_PASSWORD=values['ENTERPRISE_MIGRATOR_PASSWORD'])
override = directory/'override.yaml'
override.write_text(f'services:\n  db:\n    networks: [enterprise-db, default]\n    ports:\n      - "127.0.0.1:{state["port"]}:5432"\n')
base = ['docker-compose','-p',state['project'],'-f','deploy/customer-single/compose.yaml']
compose = base + ['-f',str(override)]
steps = []

def record(name, command, expected=0, extra=None):
    result = subprocess.run(['python3','scripts/enterprise/記錄指令.py',str(out/(name+'.txt')),*command],env={**env,**(extra or {})})
    steps.append(dict(name=name,exit_code=result.returncode,expected=expected,passed=result.returncode==expected))
    assert result.returncode == expected, name

def sql(database, statement):
    return subprocess.check_output(compose+['exec','-T','db','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','dhc_bootstrap','-d',database,'-c',statement],env=env)

def fingerprint(database):
    result = {}
    for table in ['organizations','user_accounts','org_members','roles','org_member_roles','tasks','documents','audit_events','schema_migrations']:
        rows = sql(database,f"SELECT row_to_json(t)::text FROM enterprise.{table} t ORDER BY row_to_json(t)::text")
        result[table] = dict(count=len(rows.splitlines()),sha256=hashlib.sha256(rows).hexdigest())
    return result

cli = ['node','dist-server/server/modules/enterprise-persistence/migrate.cli.js']
migration_env = dict(ENTERPRISE_DB_HOST='127.0.0.1',ENTERPRISE_DB_PORT=str(state['port']),ENTERPRISE_DB_NAME=state['database'],
                     ENTERPRISE_DB_USER='dhc_migrator',ENTERPRISE_DB_PASSWORD=values['ENTERPRISE_MIGRATOR_PASSWORD'])
try:
    # config 含密碼，只在記憶體驗證，絕不輸出/存檔。
    config = json.loads(subprocess.check_output(base+['config','--format','json'],env=env))
    assert not config['services']['db'].get('ports')
    assert config['networks']['enterprise-db']['internal'] is True
    record('01-db-up',compose+['up','-d','--wait','--wait-timeout','120','db'])
    record('02-module-tests',['node_modules/.bin/tsx','--tsconfig','server/tsconfig.json','--test','server/modules/enterprise-persistence/tests/enterprise.integration.test.ts'])
    before = fingerprint(state['database'])
    dump = directory/'synthetic.dump'
    with dump.open('xb') as target:
        os.chmod(dump,0o600)
        subprocess.run(compose+['exec','-T','db','pg_dump','-U','dhc_bootstrap','-Fc','-n','enterprise',state['database']],env=env,stdout=target,check=True)
    restore_db = state['database']+'_restore'
    sql('postgres',f'CREATE DATABASE {restore_db}')
    sql('postgres',f'REVOKE ALL ON DATABASE {restore_db} FROM PUBLIC; GRANT CONNECT ON DATABASE {restore_db} TO dhc_app,dhc_migrator;')
    with dump.open('rb') as source:
        subprocess.run(compose+['exec','-T','db','pg_restore','-U','dhc_bootstrap','-d',restore_db,'--exit-on-error','--single-transaction'],env=env,stdin=source,check=True)
    after = fingerprint(restore_db)
    assert before == after
    (out/'03-backup-restore.json').write_text(json.dumps(dict(before=before,after=after,equal=True,dump_sha256=hashlib.sha256(dump.read_bytes()).hexdigest(),dump_bytes=dump.stat().st_size),indent=2)+'\n')
    # Restore 必須保留 runtime ACL 與 RLS，不能只有 superuser count 相等。
    restore_probe = """import assert from 'node:assert/strict'; import {Pool} from 'pg';
import {createEnterprisePersistence} from './dist-server/server/modules/enterprise-persistence/index.js';
const p=new Pool({host:'127.0.0.1',port:Number(process.env.E02A_TEST_PORT),database:process.env.E02A_RESTORE_DB,user:'dhc_app',password:process.env.E02A_TEST_APP_PASSWORD});
try {const service=createEnterprisePersistence(p,async()=>({userAccountId:'00000000-0000-4000-8000-000000000101'}));
const rows=await service.withOrganization('00000000-0000-4000-8000-000000000001',s=>s.listTasks());
assert.ok(rows.length>0&&rows.every(r=>r.organizationId==='00000000-0000-4000-8000-000000000001'));
await assert.rejects(service.withOrganization('00000000-0000-4000-8000-000000000002',s=>s.listTasks()),/ENTERPRISE_SCOPE_DENIED/);
assert.equal((await p.query('SELECT * FROM enterprise.tasks')).rowCount,0);
await assert.rejects(p.query('DELETE FROM enterprise.audit_events'),{code:'42501'});
console.log('restore runtime scope/RLS/ACL: 4 assertions passed');} finally {await p.end();}"""
    record('04-restore-runtime',['node','--input-type=module','-e',restore_probe],extra={'E02A_RESTORE_DB':restore_db})
    record('05-down-refused',cli+['down'],expected=1,extra=migration_env)
    record('06-down-allowed',cli+['down','--allow-data-loss'],extra=migration_env)
    assert sql(state['database'],"SELECT count(*) FROM pg_tables WHERE schemaname='enterprise' AND tablename <> 'schema_migrations'").strip()==b'0'
    record('07-down-repeat',cli+['down'],extra=migration_env)
    # 真實 UI login / SQLite restart / authenticated WS / native app navigation，獨立 home。
    record('08-legacy-smoke-after-down',['python3','scripts/enterprise/基線啟動測試.py'])
    record('09-up-after-down',cli+['up'],extra=migration_env)
    record('10-up-repeat',cli+['up'],extra=migration_env)
    record('11-empty-safe-down',cli+['down'],extra=migration_env)
    assert fingerprint(restore_db) == before
    (out/'12-result.json').write_text(json.dumps(dict(status='PASS',steps=steps,backup_restore_equal=True,restore_untouched_by_original_down=True,base_db_ports=[],base_db_network_internal=True),indent=2)+'\n')
finally:
    # 唯一隨機 project；--volumes 只刪除這個測試建立的資料，不碰其他 project。
    cleanup = subprocess.run(compose+['down','--volumes','--remove-orphans'],env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    (out/'13-cleanup.txt').write_bytes(cleanup.stdout)
    (out/'13-cleanup.json').write_text(json.dumps(dict(exit_code=cleanup.returncode,project=state['project']))+'\n')
    shutil.rmtree(directory)
    if cleanup.returncode: raise SystemExit('QA Docker cleanup failed; inspect 13-cleanup.txt')
