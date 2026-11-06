"""DHC AI Office 單客戶操作工具（Python 標準庫，不需額外套件）。

子命令：
  preflight                       檢查 docker / docker-compose / 磁碟空間 / 連接埠
  init-secrets [舊 app.env]        產生 0600 env_file（DB 密碼、BYOK 主金鑰），不覆寫；還原到新主機時沿用舊主金鑰
  up                              啟動 db → 執行 migration → 啟動 app 並等待健康
  bootstrap <slug> <名稱> <email>  建立組織與第一位管理員（密碼讀 ENTERPRISE_BOOTSTRAP_ADMIN_PASSWORD）
  subscription <slug> <plan> <status> <起> <迄> <原因>   供應商調整方案（留下 subscription_events）
  install-image <交付包目錄>      依 IMAGE_MANIFEST.json 驗證並 docker load image（含 PostgreSQL），image ID 必須相符；記錄要使用的 tag
  image-manifest <輸出目錄> <tag…>  （供應商打包用）docker save 指定 image 並產生 IMAGE_MANIFEST.json
  backup <輸出目錄>               PG 邏輯備份＋blob 封存＋MANIFEST v2（全表指紋、schema/RLS 指紋、blob 驗證），檔案 0600
  restore <備份目錄>              只還原到「全新、空的」安裝（不覆寫既有資料），驗證 SHA-256 與全表／blob 指紋
  status                          服務狀態、健康、migration 版本、資料量（不輸出秘密）
  down                            停止服務（保留 volume；不刪資料）

環境變數：COMPOSE_PROJECT_NAME（每客戶唯一）、DHC_SECRET_DIR（0700）、DHC_HTTP_PORT、DHC_IMAGE、DHC_SOURCE_SHA、DOCKER_HOST。
"""
import datetime
import tarfile
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

HERE = Path(__file__).resolve().parent
COMPOSE = ['docker-compose', '-f', str(HERE / 'compose.yaml')]
DATABASE = os.environ.get('DHC_DATABASE_NAME', 'dhc_enterprise')
MIN_FREE_BYTES = 8 * 1024 ** 3


def fail(message, code=1):
    print(json.dumps({'status': 'FAILED', 'error': message}, ensure_ascii=False))
    raise SystemExit(code)


def require_env():
    for key in ['COMPOSE_PROJECT_NAME', 'DHC_SECRET_DIR']:
        if not os.environ.get(key):
            fail(f'缺少環境變數 {key}')
    secret_dir = Path(os.environ['DHC_SECRET_DIR'])
    if secret_dir.exists() and secret_dir.stat().st_mode & 0o077:
        fail('DHC_SECRET_DIR 必須為 0700')


def compose(*args, check=True, stdin=None, stdout=None, capture=False):
    env = dict(os.environ)
    image = selected_image() if os.environ.get('DHC_SECRET_DIR') else None
    if image:
        env['DHC_IMAGE'] = image
    # 以 install-image 安裝（離線交付）的實例永不連網拉 image；缺 image 直接失敗
    if os.environ.get('DHC_SECRET_DIR') and image_env_path().exists():
        env['DHC_PULL_POLICY'] = 'never'
        values = dict(line.split('=', 1) for line in image_env_path().read_text().splitlines() if '=' in line)
        if values.get('DHC_DB_IMAGE'):
            env['DHC_DB_IMAGE'] = values['DHC_DB_IMAGE']
    result = subprocess.run(COMPOSE + list(args), stdin=stdin, stdout=subprocess.PIPE if capture else stdout,
                            stderr=subprocess.PIPE if capture else None, check=False, env=env)
    if check and result.returncode:
        fail(f'docker-compose {" ".join(args[:2])} 失敗（exit {result.returncode}）')
    return result


def psql(statement, database=None):
    result = compose('exec', '-T', 'db', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'dhc_bootstrap', '-d', database or DATABASE, '-c', statement, capture=True)
    return result.stdout.decode().strip()


# ---------------------------------------------------------------- ASTRA-017 image（manifest 驅動）

def image_env_path():
    return Path(os.environ['DHC_SECRET_DIR']) / 'image.env'


def installed_images():
    """install-image 記錄的值（image.env）；沒有離線安裝時回傳 None。"""
    path = image_env_path()
    if not path.exists():
        return None
    return dict(line.split('=', 1) for line in path.read_text().splitlines() if '=' in line)


def selected_image():
    """V5.2 ASTRA-ROLL-007：離線安裝（有 image.env）時，實際使用的 reference 只能是 install-image 記錄並驗證過的那一個；
    環境變數 DHC_IMAGE 若指向別的 reference 一律拒絕（不再「驗 A、啟 B」）。沒有離線安裝時沿用 DHC_IMAGE（開發／CI 用），
    都沒有時沿用 compose 預設。"""
    installed = installed_images()
    override = os.environ.get('DHC_IMAGE')
    if installed is not None:
        recorded = installed.get('DHC_IMAGE', '').strip()
        if override and override != recorded:
            fail(f'離線安裝只能使用 install-image 驗證過的 image {recorded}；拒絕環境變數 DHC_IMAGE={override}（請 unset DHC_IMAGE 或重新 install-image）')
        return recorded
    return override or None


def docker(*args, capture=True, stdin=None):
    return subprocess.run(['docker', *args], stdin=stdin, stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE if capture else None, check=False)


def image_id(reference):
    result = docker('image', 'inspect', '--format', '{{.Id}}', reference)
    return result.stdout.decode().strip() if result.returncode == 0 else None


def image_manifest(output, *tags):
    """供應商打包：docker save 指定 tags（app 與 PostgreSQL），記錄每個 tag 的 image ID 與 tar SHA-256。"""
    target = Path(output).resolve()
    target.mkdir(parents=True, exist_ok=True)
    images, save_tags = [], []
    for index, reference in enumerate(tags):
        identifier = image_id(reference)
        if not identifier:
            fail(f'找不到 image {reference}')
        tag = reference
        if '@sha256:' in reference:
            # docker save/load 不保留 RepoDigest：以 digest 釘選的 image 另打本機 tag 出貨，安裝時以 image ID 驗證內容
            tag = f"dhc-{'postgres' if 'postgres' in reference else 'pinned'}:{reference.split('@sha256:')[1][:12]}"
            if docker('tag', reference, tag).returncode:
                fail(f'無法為 {reference} 建立本機 tag')
        save_tags.append(tag)
        labels = json.loads(docker('image', 'inspect', '--format', '{{json .Config.Labels}}', reference).stdout.decode() or 'null') or {}
        images.append({'tag': tag, 'original_reference': reference, 'role': 'app' if index == 0 else ('db' if 'postgres' in reference else 'support'), 'image_id': identifier,
                       'source_revision': labels.get('org.opencontainers.image.revision'), 'profile': labels.get('com.dhc.image.profile')})
    tar_path = target / 'images.tar'
    with open(os.open(tar_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        if subprocess.run(['docker', 'save', *save_tags], stdout=stream, check=False).returncode:
            fail('docker save 失敗')
    manifest = {'schema_version': 1, 'images': images, 'app_tag': save_tags[0], 'tar': 'images.tar', 'tar_sha256': sha256_file(tar_path), 'tar_bytes': tar_path.stat().st_size,
                'docs_sha': os.environ.get('DHC_DOCS_SHA', 'unrecorded'), 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (target / 'IMAGE_MANIFEST.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': 'OK', 'images': images, 'tar_sha256': manifest['tar_sha256']}, ensure_ascii=False))


def install_image(package):
    """離線安裝：驗 tar SHA-256 → docker load → 每個 tag 的 image ID 必須與 manifest 相同 → 記錄 app tag。不會連網拉 image。"""
    require_env()
    package = Path(package).resolve()
    manifest = json.loads((package / 'IMAGE_MANIFEST.json').read_text())
    tar_path = package / manifest['tar']
    if sha256_file(tar_path) != manifest['tar_sha256']:
        fail('images.tar 的 SHA-256 與 IMAGE_MANIFEST 不符，拒絕載入')
    with open(tar_path, 'rb') as stream:
        if docker('load', stdin=stream).returncode:
            fail('docker load 失敗')
    for image in manifest['images']:
        loaded = image_id(image['tag'])
        if loaded != image['image_id']:
            fail(f"載入後 {image['tag']} 的 image ID {loaded} 與 manifest {image['image_id']} 不符")
    Path(os.environ['DHC_SECRET_DIR']).mkdir(parents=True, mode=0o700, exist_ok=True)
    with open(os.open(image_env_path(), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        support = {i['tag']: i['image_id'] for i in manifest['images'] if i['tag'] != manifest['app_tag']}
        db = next((i['tag'] for i in manifest['images'] if i.get('role') == 'db'), None)
        stream.write(f"DHC_IMAGE={manifest['app_tag']}\nDHC_IMAGE_ID={next(i['image_id'] for i in manifest['images'] if i['tag'] == manifest['app_tag'])}\n"
                     f"DHC_SUPPORT_IMAGES={json.dumps(support)}\n" + (f"DHC_DB_IMAGE={db}\n" if db else ''))
    print(json.dumps({'status': 'OK', 'app_image': manifest['app_tag'], 'images': [i['tag'] for i in manifest['images']]}, ensure_ascii=False))


def wait_health(seconds=180):
    port = os.environ.get('DHC_HTTP_PORT', '3001')
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/enterprise/v1/health/ready', timeout=5) as response:
                if response.status == 200:
                    return True
        except OSError:
            pass
        time.sleep(2)
    return False


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def preflight():
    checks = {}
    checks['docker'] = shutil.which('docker') is not None
    checks['docker_compose'] = shutil.which('docker-compose') is not None
    checks['docker_daemon'] = subprocess.run(['docker', 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    free = shutil.disk_usage(Path.cwd()).free
    checks['disk_free_bytes'] = free
    checks['disk_ok'] = free >= MIN_FREE_BYTES
    port = int(os.environ.get('DHC_HTTP_PORT', '3001'))
    with socket.socket() as probe:
        checks['port_free'] = probe.connect_ex(('127.0.0.1', port)) != 0
    ok = all(value for key, value in checks.items() if key != 'disk_free_bytes')
    print(json.dumps({'status': 'OK' if ok else 'FAILED', 'checks': checks}, ensure_ascii=False))
    return 0 if ok else 1


def offline_install():
    return image_env_path().exists()


def assert_offline_images():
    """離線安裝：所需 image 必須已由 install-image 載入且 ID 相符；不允許 compose 自行 build 或 pull。"""
    values = installed_images()
    reference = selected_image()  # ROLL-007：驗證「最後實際交給 compose 的」reference
    if image_id(reference) != values.get('DHC_IMAGE_ID'):
        fail(f"離線安裝的 image {reference} 不存在或 ID 不符；請重新執行 install-image")
    for reference, expected in json.loads(values.get('DHC_SUPPORT_IMAGES', '{}')).items():
        if image_id(reference) != expected:
            fail(f'離線安裝的 image {reference} 不存在或 ID 不符；請重新執行 install-image')


def up():
    require_env()
    no_build = []
    if offline_install():
        assert_offline_images()
        no_build = ['--no-build']
    compose('up', '-d', *no_build, '--wait', '--wait-timeout', '180', 'db')
    compose('run', '--rm', '-T', 'migrate')
    compose('up', '-d', *no_build, 'app')
    if not wait_health():
        fail('app 未在時限內就緒；請執行 status 查看')
    print(json.dumps({'status': 'OK', 'ready': True}))


def run_admin_cli(*args, extra_env=None):
    command = ['run', '--rm', '-T']
    # 只傳變數名稱，值由 docker-compose 從本行程環境繼承，避免秘密出現在命令列參數。
    for key in (extra_env or {}):
        command += ['-e', key]
    command += ['--entrypoint', 'node', 'migrate', 'dist-server/server/modules/enterprise-persistence/enterprise-admin.cli.js', *args]
    result = compose(*command, check=False, capture=True)
    sys.stdout.write(result.stdout.decode())
    if result.returncode:
        fail(result.stderr.decode().strip().splitlines()[-1] if result.stderr else 'admin CLI 失敗')


# ---------------------------------------------------------------- ASTRA-015 備份一致性

SCHEMA_FINGERPRINT_SQL = """SELECT md5(coalesce(string_agg(line, E'\\n' ORDER BY line), '')) FROM (
  SELECT 'policy ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') AS line FROM pg_policies WHERE schemaname = 'enterprise'
  UNION ALL SELECT 'rls ' || c.relname || ' ' || c.relrowsecurity || ' ' || c.relforcerowsecurity FROM pg_class c WHERE c.relnamespace = 'enterprise'::regnamespace AND c.relkind = 'r'
  UNION ALL SELECT 'grant ' || table_name || ' ' || grantee || ' ' || privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'enterprise'
  UNION ALL SELECT 'colgrant ' || table_name || ' ' || column_name || ' ' || grantee || ' ' || privilege_type FROM information_schema.column_privileges WHERE table_schema = 'enterprise' AND grantee = 'dhc_app'
  UNION ALL SELECT 'constraint ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'enterprise'::regnamespace
) q"""


FIXED_SESSION = "SET TimeZone TO 'UTC'; SET DateStyle TO 'ISO, YMD'; SET IntervalStyle TO 'postgres'; SET extra_float_digits TO 1; "


def fingerprint(database):
    """全表筆數＋內容 md5（依整列文字排序，與實體順序無關）＋schema/RLS/grant/constraint 指紋＋被引用 blob 清單。
    以固定的 session 設定（UTC、ISO 日期）計算，跨主機 PostgreSQL 設定不同也不會誤判。"""
    tables = psql("SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'enterprise'", database).split(',')
    parts = [f"SELECT '{t}' AS t, count(*)::bigint AS n, coalesce(md5(string_agg(x::text, E'\\n' ORDER BY x::text)), '') AS h FROM enterprise.\"{t}\" x" for t in tables if t]
    rows = json.loads(psql(FIXED_SESSION + f"SELECT json_object_agg(t, json_build_object('rows', n, 'md5', h)) FROM ({' UNION ALL '.join(parts)}) s", database))
    blobs = psql("SELECT coalesce(string_agg(organization_id::text || '/' || sha256, ',' ORDER BY 1), '') FROM enterprise.document_blobs", database)
    return {'tables': rows, 'schema_md5': psql(FIXED_SESSION + SCHEMA_FINGERPRINT_SQL, database), 'blob_refs': [ref for ref in blobs.split(',') if ref]}


def archived_volume_hashes():
    """串流封存目前的 blob volume 並雜湊（不把整個封存讀進記憶體）。"""
    env = dict(os.environ)
    image = selected_image()
    if image:
        env['DHC_IMAGE'] = image
    if image_env_path().exists():
        env['DHC_PULL_POLICY'] = 'never'
        values = dict(line.split('=', 1) for line in image_env_path().read_text().splitlines() if '=' in line)
        if values.get('DHC_DB_IMAGE'):
            env['DHC_DB_IMAGE'] = values['DHC_DB_IMAGE']
    process = subprocess.Popen(COMPOSE + ['run', '--rm', '-T', 'blobs', '-C', '/var/lib/dhc/blobs', '-cf', '-', '.'], stdout=subprocess.PIPE, env=env)
    try:
        hashes = tar_blob_hashes(process.stdout)
    finally:
        process.stdout.close()
        code = process.wait()
    if code:
        fail('封存 blob volume 失敗')
    return hashes


def tar_blob_hashes(stream):
    """回傳 tar 中 {org/sha256: 實際內容 sha256}；路徑格式 ./<org>/<sha2>/<sha256>。"""
    found = {}
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for member in archive:
            if not member.isfile():
                continue
            parts = Path(member.name).parts
            parts = parts[1:] if parts and parts[0] == '.' else parts
            if len(parts) != 3:
                continue
            digest = hashlib.sha256()
            source = archive.extractfile(member)
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
            found[f'{parts[0]}/{parts[2]}'] = digest.hexdigest()
    return found


def verify_blob_refs(refs, hashes):
    missing = [ref for ref in refs if ref not in hashes]
    corrupt = [ref for ref in refs if ref in hashes and hashes[ref] != ref.split('/', 1)[1]]
    return {'referenced': len(refs), 'archived_files': len(hashes), 'missing': missing[:20], 'missing_count': len(missing),
            'corrupt': corrupt[:20], 'corrupt_count': len(corrupt), 'orphans_count': len(set(hashes) - set(refs))}


def backup(target):
    """一致性策略（不停機）：先 pg_dump（單一 MVCC snapshot T），再封存 blob。blob 內容定址、先寫檔再提交 DB、永不刪除，
    所以 T 時被引用的每個 blob 必在之後的封存中（可能多出孤兒，無害）。接著把 dump 還原到暫存 DB 計算全表／schema 指紋，
    並逐一驗證被引用 blob 的內容雜湊。全部寫在 <目錄>.partial，成功才改名；失敗清除，不影響原實例。"""
    require_env()
    target = Path(target).resolve()
    partial = target.with_name(target.name + '.partial')
    if target.exists() or partial.exists():
        fail('備份目錄已存在；拒絕覆寫')
    partial.mkdir(parents=True, mode=0o700)
    scratch = f"dhc_backup_verify_{os.urandom(4).hex()}"
    timings, clock = {}, time.monotonic
    try:
        started = clock()
        dump, blobs = partial / 'enterprise.dump', partial / 'blobs.tar'
        with open(os.open(dump, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
            compose('exec', '-T', 'db', 'pg_dump', '-U', 'dhc_bootstrap', '-Fc', '-n', 'enterprise', DATABASE, stdout=stream)
        timings['pg_dump_seconds'] = round(clock() - started, 2)
        with open(os.open(blobs, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
            # 不停機備份：封存期間仍可能有新 blob 寫入，GNU tar 會以 exit 1（file changed as we read it）結束——
            # 依一致性論證這是預期的（新檔＝snapshot 之後的孤兒），被引用 blob 由下方逐一雜湊驗證；exit ≥ 2 才是致命錯誤。
            # 排除寫入中的暫存檔（<sha>.<隨機>.tmp，寫完才 rename 成正式檔名）。
            archive = compose('run', '--rm', '-T', 'blobs', '--warning=no-file-changed', '--exclude=*.tmp', '-C', '/var/lib/dhc/blobs', '-cf', '-', '.',
                              stdout=stream, check=False)
            if archive.returncode not in (0, 1):
                fail(f'封存 blob 失敗（tar exit {archive.returncode}）')
        timings['blob_archive_seconds'] = round(clock() - started - timings['pg_dump_seconds'], 2)
        restore_started = clock()
        psql(f'CREATE DATABASE "{scratch}"')
        try:
            with open(dump, 'rb') as stream:
                compose('exec', '-T', 'db', 'pg_restore', '-U', 'dhc_bootstrap', '-d', scratch, '--exit-on-error', '--single-transaction', stdin=stream)
            timings['scratch_restore_seconds'] = round(clock() - restore_started, 2)
            prints = fingerprint(scratch)
            # migration 清單也取自 dump 本身（與資料同一 snapshot）
            migrations = psql('SELECT string_agg(version, \',\' ORDER BY version) FROM enterprise.schema_migrations', scratch).split(',')
        finally:
            psql(f'DROP DATABASE IF EXISTS "{scratch}"')
        with open(blobs, 'rb') as stream:
            blob_check = verify_blob_refs(prints['blob_refs'], tar_blob_hashes(stream))
        if blob_check['missing_count'] or blob_check['corrupt_count']:
            fail(f"備份中被引用的 blob 缺少 {blob_check['missing_count']}、內容不符 {blob_check['corrupt_count']}；備份作廢")
        manifest = {
            'schema_version': 2, 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'project': os.environ['COMPOSE_PROJECT_NAME'], 'source_sha': os.environ.get('DHC_SOURCE_SHA', 'unrecorded'), 'migrations': migrations,
            'consistency': 'pg_dump snapshot first, then content-addressed append-only blob archive; fingerprints computed from the dump itself',
            'tables': prints['tables'], 'schema_md5': prints['schema_md5'], 'blob_check': blob_check, 'timings': timings,
            'recovery_point': 'logical backup only (no WAL/PITR): data written after this backup is not recoverable from it',
            'counts': {name: prints['tables'][name]['rows'] for name in ['organizations', 'documents', 'document_blobs', 'drafts', 'audit_events'] if name in prints['tables']},
            'files': {name: {'sha256': sha256_file(partial / name), 'bytes': (partial / name).stat().st_size} for name in ['enterprise.dump', 'blobs.tar']},
            'note': '備份含客戶資料與已加密的 BYOK 金鑰；還原需同一份 ENTERPRISE_SECRET_KEY。請存放於加密媒體並另存異機複本。',
        }
        with open(os.open(partial / 'MANIFEST.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
            json.dump(manifest, stream, ensure_ascii=False, indent=2)
        partial.rename(target)
    except BaseException:
        shutil.rmtree(partial, ignore_errors=True)
        raise
    print(json.dumps({'status': 'OK', 'backup': str(target), 'tables': len(manifest['tables']), 'blob_refs': blob_check['referenced']}, ensure_ascii=False))


def restore(source):
    require_env()
    started = time.monotonic()
    source = Path(source).resolve()
    if offline_install():
        assert_offline_images()  # ROLL-007：restore 也只用驗證過的 image，且在動資料庫前檢查
    manifest = json.loads((source / 'MANIFEST.json').read_text())
    for name, meta in manifest['files'].items():
        if sha256_file(source / name) != meta['sha256']:
            fail(f'備份檔 {name} 的 SHA-256 不符，拒絕還原')
    compose('up', '-d', '--wait', '--wait-timeout', '180', 'db')
    tables = psql("SELECT count(*) FROM pg_tables WHERE schemaname='enterprise'")
    if tables != '0':
        fail('目標資料庫已有 enterprise 資料表；只允許還原到全新安裝')
    # 全新安裝的 init script 已建立空 schema；改由備份重建（含 owner、grant、RLS policy）
    psql('DROP SCHEMA enterprise')
    with open(source / 'enterprise.dump', 'rb') as stream:
        compose('exec', '-T', 'db', 'pg_restore', '-U', 'dhc_bootstrap', '-d', DATABASE, '--exit-on-error', '--single-transaction', stdin=stream)
    with open(source / 'blobs.tar', 'rb') as stream:
        compose('run', '--rm', '-T', 'blobs', '-C', '/var/lib/dhc/blobs', '-xf', '-', stdin=stream)
    if manifest.get('schema_version', 1) >= 2:
        prints = fingerprint(DATABASE)
        if prints['tables'] != manifest['tables']:
            diff = sorted(t for t in set(prints['tables']) | set(manifest['tables']) if prints['tables'].get(t) != manifest['tables'].get(t))
            fail(f'還原後資料表指紋與備份不符：{diff[:10]}')
        if prints['schema_md5'] != manifest['schema_md5']:
            fail('還原後 schema／RLS／權限指紋與備份不符')
        # 重新封存 volume 並雜湊，證明實際寫入的 blob 內容正確
        blob_check = verify_blob_refs(prints['blob_refs'], archived_volume_hashes())
        if blob_check['missing_count'] or blob_check['corrupt_count']:
            fail(f"還原後 blob 缺少 {blob_check['missing_count']}、內容不符 {blob_check['corrupt_count']}")
        verified = {'tables': len(prints['tables']), 'schema': 'match', 'blob_refs': blob_check['referenced']}
    else:
        restored = json.loads(psql("SELECT json_build_object('organizations',(SELECT count(*) FROM enterprise.organizations),'documents',(SELECT count(*) FROM enterprise.documents),'document_blobs',(SELECT count(*) FROM enterprise.document_blobs),'drafts',(SELECT count(*) FROM enterprise.drafts),'audit_events',(SELECT count(*) FROM enterprise.audit_events))"))
        if restored != manifest['counts']:
            fail('還原後資料筆數與備份 MANIFEST 不符')
        verified = {'legacy_v1_counts_only': restored}
    compose('up', '-d', *(['--no-build'] if offline_install() else []), 'app')
    if not wait_health():
        fail('還原後 app 未就緒')
    print(json.dumps({'status': 'OK', 'verified': verified, 'restore_seconds': round(time.monotonic() - started, 2)}, ensure_ascii=False))


def status():
    require_env()
    services = compose('ps', '--format', 'json', capture=True, check=False).stdout.decode()
    report = {'services': services.strip()[:2000], 'ready': wait_health(5)}
    try:
        report['migrations'] = psql('SELECT string_agg(version, \',\' ORDER BY version) FROM enterprise.schema_migrations')
    except SystemExit:
        report['migrations'] = 'UNAVAILABLE'
    print(json.dumps(report, ensure_ascii=False))


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    command, args = argv[0], argv[1:]
    if command == 'preflight':
        return preflight()
    if command == 'init-secrets':
        require_env()
        extra = ['--reuse-secret-key-from', args[0]] if len(args) == 1 else []
        return subprocess.run([sys.executable, str(HERE / 'generate-secrets.py'), '--directory', os.environ['DHC_SECRET_DIR'], *extra]).returncode
    if command == 'up':
        up()
    elif command == 'bootstrap' and len(args) == 3:
        require_env()
        password = os.environ.get('ENTERPRISE_BOOTSTRAP_ADMIN_PASSWORD')
        if not password:
            fail('請以環境變數 ENTERPRISE_BOOTSTRAP_ADMIN_PASSWORD 提供第一位管理員密碼')
        run_admin_cli('bootstrap', *args, extra_env={'ENTERPRISE_BOOTSTRAP_ADMIN_PASSWORD': password})
    elif command == 'subscription' and len(args) == 6:
        require_env()
        run_admin_cli('subscription', *args)
    elif command == 'install-image' and len(args) == 1:
        install_image(args[0])
    elif command == 'image-manifest' and len(args) >= 2:
        image_manifest(args[0], *args[1:])
    elif command == 'backup' and len(args) == 1:
        backup(args[0])
    elif command == 'restore' and len(args) == 1:
        restore(args[0])
    elif command == 'status':
        status()
    elif command == 'down':
        require_env()
        compose('down')
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
