"""只在明確的本機合成 QA profile 建兩個全新 PG cluster；不接受外部 DB/備份。
先驗缺角色的還原失敗，再用既有 init hook + 新憑證恢復角色/ACL並還原。
VM 由操作者管理；本工具只清除自己隨機建立的 Compose projects/volumes/fixtures。
"""
import argparse
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
import time

ROOT = Path(__file__).resolve().parents[2]
TABLES = ['organizations', 'user_accounts', 'org_members', 'roles', 'org_member_roles',
          'tasks', 'documents', 'audit_events', 'schema_migrations']


def build_qa_environment(parent):
    env = {key: value for key, value in parent.items()
           if key in ('PATH', 'TMPDIR', 'SHELL', 'USER', 'LANG', 'LC_ALL', 'DOCKER_HOST')}
    toolchain = ROOT.parent / '工具鏈/node_modules/.bin'
    if toolchain.is_dir():
        env['PATH'] = str(toolchain) + ':' + env.get('PATH', '')
    return env


def check_capacity(profile):
    for path in [ROOT, profile]:
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/enterprise/檢查測試容量.py'),
                                 '--stage', 'running-vm', '--path', str(path)], cwd=ROOT)
        if result.returncode:
            return result.returncode
    return 0


def run_qa(out, env, profile):
    token = secrets.token_hex(8)
    temporary_root = ROOT / '.tmp'
    if temporary_root.is_symlink():
        raise SystemExit('拒絕 symlink QA fixture root')
    temporary_root.mkdir(exist_ok=True)
    directory = temporary_root / ('dr-' + token)
    directory.mkdir(mode=0o700, exist_ok=False)
    actors = []
    used_ports = set()
    steps = []
    source_sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()

    def capacity():
        code = check_capacity(profile)
        if code:
            raise SystemExit(code)

    def record(name, command, actor=None, expected=0, stdin=None, input_bytes=None):
        capacity()
        started = time.perf_counter()
        result = subprocess.run([sys.executable, 'scripts/enterprise/記錄指令.py', str(out / (name+'.txt')), *command],
                                cwd=ROOT, env=actor['env'] if actor else env, stdin=stdin, input=input_bytes)
        steps.append(dict(name=name, exit_code=result.returncode, expected=expected, elapsed_seconds=time.perf_counter()-started))
        if result.returncode != expected:
            raise RuntimeError('QA step failed: '+name)

    def sql(actor, statement):
        capacity()
        command = actor['compose'] + ['exec', '-T', 'db', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                                      '-U', 'dhc_bootstrap', '-d', actor['database'], '-c', statement]
        result = subprocess.run(command, cwd=ROOT, env=actor['env'], capture_output=True)
        with (out / 'SQL_COMMANDS.jsonl').open('a') as stream:
            stream.write(json.dumps(dict(project=actor['project'], command=command, exit_code=result.returncode), ensure_ascii=False)+'\n')
        if result.returncode:
            raise RuntimeError(result.stderr.decode(errors='replace'))
        return result.stdout

    def fingerprint(actor):
        result = {}
        for table in TABLES:
            rows = sql(actor, f'SELECT row_to_json(t)::text FROM enterprise.{table} t ORDER BY row_to_json(t)::text')
            result[table] = dict(count=len(rows.splitlines()), sha256=hashlib.sha256(rows).hexdigest())
        return result

    try:
        noop = directory / 'skip-enterprise.sh'
        noop.write_text('#!/usr/bin/env bash\n# QA virgin target: intentionally no enterprise roles or schema.\ntrue\n')
        for side in ['source', 'target']:
            secrets_dir = directory / (side+'-secrets')
            record('01-'+side+'-secrets', ['python3', 'deploy/customer-single/產生本機資料庫密碼.py', '--directory', str(secrets_dir)])
            credentials = dict(line.split('=', 1) for line in (secrets_dir / 'bootstrap.env').read_text().splitlines())
            while True:
                with socket.socket() as probe:
                    probe.bind(('127.0.0.1', 0))
                    port = probe.getsockname()[1]
                if port not in used_ports:
                    used_ports.add(port)
                    break
            database = 'dhc_e02a_qa_'+token + ('_restore' if side == 'target' else '')
            project = 'dhc-dr-'+side+'-'+token
            actor_env = dict(env, DHC_SECRET_DIR=str(secrets_dir), DHC_DATABASE_NAME=database)
            base = ['docker-compose', '-p', project, '-f', 'deploy/customer-single/compose.yaml']
            override = directory / (side+'.json')
            db = dict(networks=['enterprise-db', 'default'], ports=[f'127.0.0.1:{port}:5432'])
            if side == 'target':
                # Compose依容器target合併volume，只換這個QA cluster的init hook，不改原檔。
                db['volumes'] = [str(noop)+':/docker-entrypoint-initdb.d/10-enterprise.sh:ro']
            override.write_text(json.dumps(dict(services=dict(db=db))))
            compose = base + ['-f', str(override)]
            actor = dict(side=side, database=database, project=project, port=port, env=actor_env,
                         compose=compose, credentials=credentials)
            # 展開config含秘密，只在記憶體核對，絕不寫進log。
            base_config = json.loads(subprocess.check_output(base+['config', '--format', 'json'], cwd=ROOT, env=actor_env))
            assert not base_config['services']['db'].get('ports')
            assert base_config['networks']['enterprise-db']['internal'] is True
            assert base_config['volumes']['enterprise-pg']['name'] == project+'_enterprise-pg'
            assert not base_config['volumes']['enterprise-pg'].get('external', False)
            config = json.loads(subprocess.check_output(compose+['config', '--format', 'json'], cwd=ROOT, env=actor_env))
            if side == 'target':
                mount = next(v for v in config['services']['db']['volumes'] if v['target']=='/docker-entrypoint-initdb.d/10-enterprise.sh')
                assert mount['source'] == str(noop) and mount['read_only'] is True
            actors.append(actor)
        source, target = actors
        for actor in actors:
            record('02-'+actor['side']+'-up', actor['compose']+['up', '-d', '--wait', '--wait-timeout', '120', 'db'], actor)
        source_test_env = dict(source['env'], E02A_TEST_DATABASE=source['database'], E02A_TEST_PORT=str(source['port']),
                               E02A_TEST_ADMIN_PASSWORD=source['credentials']['POSTGRES_PASSWORD'],
                               E02A_TEST_APP_PASSWORD=source['credentials']['ENTERPRISE_APP_PASSWORD'],
                               E02A_TEST_MIGRATOR_PASSWORD=source['credentials']['ENTERPRISE_MIGRATOR_PASSWORD'])
        record('03-source-pg-tests', ['node', '--test', 'dist-server/server/modules/enterprise-persistence/tests/enterprise.integration.test.js'],
               dict(source, env=source_test_env))
        before = fingerprint(source)
        identifiers = {actor['side']: sql(actor, 'SELECT system_identifier FROM pg_control_system()').decode().strip() for actor in actors}
        assert identifiers['source'] != identifiers['target']
        assert sql(target, "SELECT count(*) FROM pg_roles WHERE rolname IN ('dhc_app','dhc_migrator')").strip() == b'0'
        (out / '04-clusters.json').write_text(json.dumps(dict(system_identifiers=identifiers,
            clusters=[{key: actor[key] for key in ['side','project','database','port']} for actor in actors]), indent=2)+'\n')
        capacity()
        dump = directory / 'synthetic.dump'
        command = source['compose']+['exec', '-T', 'db', 'pg_dump', '-U', 'dhc_bootstrap', '-Fc', '-n', 'enterprise', source['database']]
        started = time.perf_counter()
        with os.fdopen(os.open(dump, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
            result = subprocess.run(command, cwd=ROOT, env=source['env'], stdout=stream, stderr=subprocess.PIPE)
        (out / '05-dump.txt').write_bytes(result.stderr)
        (out / '05-dump.json').write_text(json.dumps(dict(command=command, exit_code=result.returncode, source_sha=source_sha,
            elapsed_seconds=time.perf_counter()-started, dump_bytes=dump.stat().st_size, dump_sha256=hashlib.sha256(dump.read_bytes()).hexdigest()), indent=2)+'\n')
        assert result.returncode == 0
        restore = target['compose']+['exec', '-T', 'db', 'pg_restore', '-U', 'dhc_bootstrap', '-d', target['database'], '--exit-on-error', '--single-transaction']
        with dump.open('rb') as stream:
            record('06-restore-missing-roles', restore, target, expected=1, stdin=stream)
        assert 'does not exist' in (out / '06-restore-missing-roles.txt').read_text()
        assert sql(target, "SELECT count(*) FROM pg_namespace WHERE nspname='enterprise'").strip() == b'0'
        assert fingerprint(source) == before
        (out / '07-red-isolation.json').write_text(json.dumps(dict(expected_failure=True, target_transaction_rolled_back=True, source_unchanged=True))+'\n')
        record('08-bootstrap-target-roles', target['compose']+['exec', '-T', 'db', 'bash', '-s'], target,
               input_bytes=(ROOT / 'deploy/customer-single/postgres-init.sh').read_bytes())
        # hook只建立空schema。無CASCADE的DROP遇到任何物件都會拒絕；不對現有資料執行clean。
        assert sql(target, "SELECT count(*) FROM pg_class WHERE relnamespace='enterprise'::regnamespace").strip() == b'0'
        record('09-drop-empty-target-schema', target['compose']+['exec', '-T', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
               '-U', 'dhc_bootstrap', '-d', target['database'], '-c', 'DROP SCHEMA enterprise'], target)
        with dump.open('rb') as stream:
            record('10-restore-green', restore, target, stdin=stream)
        restored = fingerprint(target)
        assert before == restored
        (out / '11-data-fingerprints.json').write_text(json.dumps(dict(before=before, restored=restored, equal=True), indent=2)+'\n')
        recovery_env = dict(env, E02B_DR_CONFIRM_SYNTHETIC='true', E02B_DR_DATABASE=target['database'], E02B_DR_PORT=str(target['port']),
            E02B_DR_SOURCE_DATABASE=source['database'], E02B_DR_SOURCE_PORT=str(source['port']),
            E02B_DR_SOURCE_ADMIN_PASSWORD=source['credentials']['POSTGRES_PASSWORD'], E02B_DR_ADMIN_PASSWORD=target['credentials']['POSTGRES_PASSWORD'],
            E02B_DR_SOURCE_APP_PASSWORD=source['credentials']['ENTERPRISE_APP_PASSWORD'], E02B_DR_APP_PASSWORD=target['credentials']['ENTERPRISE_APP_PASSWORD'],
            E02B_DR_MIGRATOR_PASSWORD=target['credentials']['ENTERPRISE_MIGRATOR_PASSWORD'])
        probe = ['node', '--test', 'dist-server/server/modules/enterprise-persistence/tests/recovery.integration.test.js']
        record('12-restored-contract-tests', probe, dict(target, env=recovery_env))
        with dump.open('rb') as stream:
            record('13-repeat-restore-refused', restore, target, expected=1, stdin=stream)
        assert fingerprint(target) == before and fingerprint(source) == before
        old_container = subprocess.check_output(target['compose']+['ps', '-q', 'db'], cwd=ROOT, env=target['env']).decode().strip()
        record('14-target-recreate', target['compose']+['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120', 'db'], target)
        new_container = subprocess.check_output(target['compose']+['ps', '-q', 'db'], cwd=ROOT, env=target['env']).decode().strip()
        assert old_container and new_container and old_container != new_container
        record('15-recreated-contract-tests', probe, dict(target, env=recovery_env))
        assert fingerprint(target) == before and fingerprint(source) == before
        completed = dict(status='PASS', steps=steps, source_unchanged=True, restore_equal=True,
                         container_recreated=True, old_container=old_container, new_container=new_container,
                         scope='same-host independent clusters, synthetic only; not offsite/PITR/production DR')
    finally:
        cleanups = []
        for actor in reversed(actors):
            result = subprocess.run(actor['compose']+['down', '--volumes', '--remove-orphans'], cwd=ROOT, env=actor['env'], capture_output=True)
            (out / ('cleanup-'+actor['side']+'.txt')).write_bytes(result.stdout+result.stderr)
            cleanups.append(dict(project=actor['project'], exit_code=result.returncode))
        cleaned = all(item['exit_code'] == 0 for item in cleanups)
        if cleaned:
            shutil.rmtree(directory)
        (out / 'cleanup.json').write_text(json.dumps(dict(projects=cleanups, fixtures_removed=cleaned,
                                                        fixture_path=str(directory)), indent=2)+'\n')
        if not cleaned:
            raise RuntimeError('QA cleanup failed; preserve private fixture and inspect cleanup.json')
    (out / 'RESULT.json').write_text(json.dumps(completed, indent=2)+'\n')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args(argv)
    host = os.environ.get('DOCKER_HOST', '')
    sock = Path(host.removeprefix('unix://'))
    profile = sock.parent
    storage = Path.home() / '.colima'
    if not host.startswith('unix://') or sock.name != 'docker.sock' or profile.parent != storage \
       or not re.fullmatch(r'dhc-e02b-dr-[a-z0-9-]+', profile.name) or not profile.resolve().is_relative_to(storage.resolve()):
        parser.error('DOCKER_HOST 必須明確指定本機 .colima/dhc-e02b-dr-*/docker.sock 合成QA profile')
    out = args.evidence
    if out.is_symlink() or not out.resolve().is_relative_to(ROOT / 'evidence') or out.exists():
        parser.error('evidence 必須是repo evidence內尚不存在的非symlink路徑')
    code = check_capacity(profile.resolve())
    if code:
        return code
    env = build_qa_environment(os.environ)
    if not subprocess.check_output(['node', '--version'], env=env, text=True).startswith('v22.'):
        parser.error('需要Node22工具鏈')
    if not (ROOT / 'dist-server/server/modules/enterprise-persistence/tests/recovery.integration.test.js').is_file():
        parser.error('先執行npm run build')
    out = out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    return run_qa(out, env, profile.resolve())


if __name__ == '__main__':
    raise SystemExit(main())
