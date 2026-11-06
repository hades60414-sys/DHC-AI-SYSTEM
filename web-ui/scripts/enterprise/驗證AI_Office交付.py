"""DELIVERY-01 端到端驗收：以 deploy/ai-office 的正式安裝路徑，從乾淨環境安裝 → 完整文書流程 → 備份 → 還原到全新安裝 → 驗證。

用法（repo 根目錄；DOCKER_HOST 指向隔離 QA 的 Colima profile；Node/Python 只用於驅動）：
    python3 -B scripts/enterprise/驗證AI_Office交付.py --evidence <repo 內新目錄> [--skip-build]

只使用合成資料與 mock 模型；只建立、也只清除本次的兩個 compose project（唯一亂數名稱）與其 volume。
每一步的命令與 exit code 記錄在證據目錄；任何失敗都讓本程式以 1 結束，不重試。
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / 'deploy/ai-office/dhc-office.py'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--evidence', type=Path, required=True)
parser.add_argument('--skip-build', action='store_true')
parser.add_argument('--image', help='搭配 --skip-build：明確指定要驗證的既有 image（預設依 HEAD 推導）')
args = parser.parse_args()
out = args.evidence.resolve()
out.mkdir(parents=True, exist_ok=False)
token = secrets.token_hex(4)
work = ROOT / '.tmp' / f'delivery-{token}'
work.mkdir(parents=True, mode=0o700)
source_sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
image = args.image or f'dhc-ai-office:{source_sha[:12]}'
if args.image and not args.skip_build:
    parser.error('--image 只能搭配 --skip-build')
admin_password = 'Office-synthetic-' + secrets.token_hex(8)
steps = []
checks = []


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def project_env(name, port):
    secret_dir = work / f'{name}-secrets'
    env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'DOCKER_HOST')}
    env.update(COMPOSE_PROJECT_NAME=f'dhc-delivery-{name}-{token}', DHC_SECRET_DIR=str(secret_dir), DHC_HTTP_PORT=str(port),
               DHC_IMAGE=image, DHC_SOURCE_SHA=source_sha)
    return env


def record(name, command, env, expected=0, extra=None):
    result = subprocess.run(['python3', 'scripts/enterprise/記錄指令.py', str(out / (name + '.txt')), *command], cwd=ROOT, env={**env, **(extra or {})})
    steps.append({'name': name, 'exit_code': result.returncode, 'expected': expected})
    if result.returncode != expected:
        raise RuntimeError(f'step {name} exit {result.returncode}')


def check(name, condition, detail=''):
    checks.append({'check': name, 'passed': bool(condition), 'detail': detail})
    print(('[PASS] ' if condition else '[FAIL] ') + name + (f' :: {detail}' if detail else ''), flush=True)
    if not condition:
        raise RuntimeError('check failed: ' + name)


class Client:
    def __init__(self, port):
        self.base = f'http://127.0.0.1:{port}'
        self.token = None

    def call(self, method, path, json_body=None, body=None, headers=None, expect=None):
        request_headers = dict(headers or {})
        if self.token:
            request_headers['Authorization'] = 'Bearer ' + self.token
        data = body
        if json_body is not None:
            request_headers['Content-Type'] = 'application/json'
            data = json.dumps(json_body).encode()
        request = urllib.request.Request(self.base + path, method=method, data=data, headers=request_headers)
        opener = urllib.request.build_opener(NoRedirect)
        try:
            response = opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        raw = response.read()
        payload = json.loads(raw) if raw and 'json' in (response.headers.get('content-type') or '') else raw
        if expect is not None and response.status != expect:
            raise RuntimeError(f'{method} {path} expected {expect} got {response.status}: {str(payload)[:200]}')
        return response.status, payload, response.headers


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def synthetic_docx(paragraphs):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        body = ''.join(f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>' for text in paragraphs)
        archive.writestr('word/document.xml', f'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>')
    return buffer.getvalue()


def login(client, email):
    _, payload, _ = client.call('POST', '/api/enterprise/v1/auth/login', {'organizationSlug': 'synthetic-co', 'email': email, 'password': admin_password}, expect=200)
    client.token = payload['token']
    return client


def workflow(port):
    """完整文書流程：成員、模型、上傳、檢索、AI 草稿、修改、送審、核准、匯出；回傳之後還原比對用的指紋。"""
    anonymous = Client(port)
    status, _, headers = anonymous.call('GET', '/')
    check('根路徑導向 /office', status == 302 and headers.get('location') == '/office', f'{status} {headers.get("location")}')
    status, html, _ = anonymous.call('GET', '/office')
    check('/office 提供前端頁面', status == 200 and b'<div id="root"' in html, f'HTTP {status}')
    check('legacy REST 不可達', anonymous.call('GET', '/api/user/preferences')[0] == 403)
    check('未登入企業 API 401', anonymous.call('GET', '/api/enterprise/v1/identity/me')[0] == 401)
    admin = login(Client(port), 'admin@synthetic-co.example.invalid')
    for email, role in [('approver@synthetic-co.example.invalid', 'approver'), ('staff@synthetic-co.example.invalid', 'employee')]:
        admin.call('POST', '/api/enterprise/v1/members', {'email': email, 'password': admin_password, 'roles': [role]}, expect=201)
    admin.call('PUT', '/api/enterprise/v1/models/providers', {'key': 'offline', 'kind': 'mock', 'deployment': 'LOCAL_ONLY', 'monthlyBudgetMicros': 0}, expect=200)
    staff = login(Client(port), 'staff@synthetic-co.example.invalid')
    approver = login(Client(port), 'approver@synthetic-co.example.invalid')
    docx = synthetic_docx(['合成乙客戶 月結對帳 差異 3,200 元', '原因：合成發票 INV-0042 重複入帳', '處理：下月沖銷'])
    _, created, _ = staff.call('POST', '/api/enterprise/v1/documents', body=docx, headers={
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'x-dhc-title': urllib.parse.quote('十一月對帳說明'), 'x-dhc-filename': urllib.parse.quote('對帳.docx')}, expect=201)
    check('上傳 DOCX 並完成擷取', created['extraction']['status'] == 'succeeded', created['extraction']['status'])
    _, hits, _ = staff.call('GET', '/api/enterprise/v1/documents/search?q=' + urllib.parse.quote('重複入帳'), expect=200)
    check('檢索命中並附引用', len(hits['items']) == 1 and hits['items'][0]['citation']['versionNumber'] == 1)
    _, run, _ = staff.call('POST', '/api/enterprise/v1/runs/draft-generation', {'title': '對帳差異說明', 'query': '重複入帳 差異', 'providerKey': 'offline'},
                           headers={'Idempotency-Key': 'delivery-uat-0001'}, expect=202)
    state = None
    for _ in range(60):
        _, state, _ = staff.call('GET', f"/api/enterprise/v1/runs/{run['run']['id']}", expect=200)
        if state['status'] in ('succeeded', 'failed', 'cancelled'):
            break
        time.sleep(1)
    check('容器內 worker 完成 AI 草稿 Run', state['status'] == 'succeeded', f"{state['status']} {state.get('errorCode')}")
    draft_id = state['draftId']
    _, draft, _ = staff.call('GET', f'/api/enterprise/v1/drafts/{draft_id}', expect=200)
    check('草稿附來源引用', len(draft['revision']['citations']) >= 1)
    staff.call('PUT', f'/api/enterprise/v1/drafts/{draft_id}', {'expectedRevision': 1, 'body': '十一月對帳差異 3,200 元，原因為發票 INV-0042 重複入帳，下月沖銷 [1]。'}, expect=200)
    _, submitted, _ = staff.call('POST', f'/api/enterprise/v1/drafts/{draft_id}/submit', {'expectedRevision': 2}, expect=201)
    confirm = {'expectedRevision': submitted['revision'], 'expectedSha256': submitted['revisionSha256']}
    check('員工不能核准', staff.call('POST', f"/api/enterprise/v1/approvals/{submitted['approvalId']}/decision", {**confirm, 'decision': 'approve'})[0] == 403)
    check('審批未確認版號與 hash 被拒（ASTRA-V3-NEW-001）', approver.call('POST', f"/api/enterprise/v1/approvals/{submitted['approvalId']}/decision", {'decision': 'approve'})[0] == 409)
    approver.call('POST', f"/api/enterprise/v1/approvals/{submitted['approvalId']}/decision", {**confirm, 'decision': 'approve', 'comment': '核對無誤'}, expect=200)
    status, exported, headers = staff.call('GET', f'/api/enterprise/v1/drafts/{draft_id}/export?format=docx')
    xml = zipfile.ZipFile(io.BytesIO(exported)).read('word/document.xml').decode()
    check('匯出 DOCX 可開啟且含正文與來源', status == 200 and 'INV-0042' in xml and '— 來源 —' in xml)
    check('匯出 SHA-256 標頭正確', headers.get('x-dhc-content-sha256') == hashlib.sha256(exported).hexdigest())
    document_id = created['document']['id']
    _, content, _ = staff.call('GET', f'/api/enterprise/v1/documents/{document_id}/versions/1/content', expect=200)
    _, events, _ = admin.call('GET', '/api/enterprise/v1/audit-events?limit=100', expect=200)
    actions = {event['action'] for event in events['items']}
    check('稽核含完整鏈', {'document.created', 'run.succeeded', 'draft.revised', 'draft.submitted', 'draft.approved', 'draft.exported_docx'} <= actions)
    return {'document_id': document_id, 'draft_id': draft_id, 'document_sha256': hashlib.sha256(content).hexdigest(), 'source_docx_sha256': hashlib.sha256(docx).hexdigest(), 'audit_count': len(events['items'])}


status = 'PASS'
error = None
envs = {}
try:
    capacity = subprocess.run([sys.executable, str(ROOT / 'scripts/enterprise/檢查測試容量.py'), '--stage', 'running-vm'])
    if capacity.returncode:
        raise RuntimeError('capacity guard failed')
    envs['a'] = project_env('a', free_port())
    envs['b'] = project_env('b', free_port())
    if not args.skip_build:
        record('01-build-image', ['docker-compose', '-f', 'deploy/ai-office/compose.yaml', 'build', 'app'], envs['a'])
    record('02-image-inspect', ['docker', 'image', 'inspect', image, '--format', '{{.Id}} {{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.licenses"}}'], envs['a'])
    record('03-a-preflight', ['python3', str(TOOL), 'preflight'], envs['a'])
    record('04-a-init-secrets', ['python3', str(TOOL), 'init-secrets'], envs['a'])
    record('05-a-up', ['python3', str(TOOL), 'up'], envs['a'])
    record('06-a-bootstrap', ['python3', str(TOOL), 'bootstrap', 'synthetic-co', '合成顧問公司', 'admin@synthetic-co.example.invalid'], envs['a'],
           extra={'ENTERPRISE_BOOTSTRAP_ADMIN_PASSWORD': admin_password})
    record('07-a-bootstrap-repeat-refused', ['python3', str(TOOL), 'bootstrap', 'synthetic-co', 'x', 'x@example.invalid'], envs['a'], expected=1,
           extra={'ENTERPRISE_BOOTSTRAP_ADMIN_PASSWORD': admin_password})
    record('08-a-subscription', ['python3', str(TOOL), 'subscription', 'synthetic-co', 'team', 'active', '2026-11-01', '2027-10-31', 'delivery UAT'], envs['a'])
    fingerprint = workflow(int(envs['a']['DHC_HTTP_PORT']))
    (out / '09-a-workflow.json').write_text(json.dumps({'fingerprint': fingerprint, 'checks': checks}, ensure_ascii=False, indent=2) + '\n')
    record('10-a-up-again-idempotent', ['python3', str(TOOL), 'up'], envs['a'])
    admin_after = login(Client(int(envs['a']['DHC_HTTP_PORT'])), 'admin@synthetic-co.example.invalid')
    check('重跑 up（升級冪等）後資料仍在', admin_after.call('GET', f"/api/enterprise/v1/documents/{fingerprint['document_id']}")[0] == 200)
    backup_dir = work / 'backup-a'
    # ASTRA-015：備份期間持續有人上傳（不停機）；之後的還原必須與備份 MANIFEST 指紋完全一致
    stop_writes = threading.Event()
    written = []

    def keep_writing():
        writer = login(Client(int(envs['a']['DHC_HTTP_PORT'])), 'admin@synthetic-co.example.invalid')
        index = 0
        while not stop_writes.is_set():
            index += 1
            status_code, _, _ = writer.call('POST', '/api/enterprise/v1/documents', body=f'備份期間寫入 {index} {secrets.token_hex(8)}'.encode(), headers={
                'Content-Type': 'text/plain', 'x-dhc-title': urllib.parse.quote(f'並行寫入 {index}'), 'x-dhc-filename': 'concurrent.txt'})
            written.append(status_code)

    writer_thread = threading.Thread(target=keep_writing, daemon=True)
    writer_thread.start()
    time.sleep(1)
    record('11-a-backup', ['python3', str(TOOL), 'backup', str(backup_dir)], envs['a'])
    stop_writes.set()
    writer_thread.join(30)
    check('備份期間持續寫入成功', len(written) >= 2 and all(code == 201 for code in written), f'{len(written)} writes {sorted(set(written))}')
    manifest = json.loads((backup_dir / 'MANIFEST.json').read_text())
    (out / '11-a-backup-manifest.json').write_text(json.dumps({k: v for k, v in manifest.items() if k != 'note'}, ensure_ascii=False, indent=2) + '\n')
    check('備份檔權限 0600', all(((backup_dir / name).stat().st_mode & 0o777) == 0o600 for name in ['enterprise.dump', 'blobs.tar', 'MANIFEST.json']))
    check('MANIFEST v2：全部資料表指紋與 schema／RLS 指紋', manifest.get('schema_version') == 2 and len(manifest.get('tables', {})) >= 27 and len(manifest.get('schema_md5', '')) == 32,
          f"tables={len(manifest.get('tables', {}))}")
    check('被引用 blob 全在封存且內容相符', manifest['blob_check']['missing_count'] == 0 and manifest['blob_check']['corrupt_count'] == 0 and manifest['blob_check']['referenced'] >= 2,
          json.dumps(manifest['blob_check'])[:200])
    check('未留下 .partial 目錄', not (work / 'backup-a.partial').exists())
    # ASTRA-017：打包 image（含 PostgreSQL）→ 停 A → 從 VM 刪除 image → B 只能從交付包載入（不 pull、不 build）
    record('11b-a-down', ['python3', str(TOOL), 'down'], envs['a'])
    package = work / 'package'
    db_reference = 'postgres:16-bookworm@sha256:d81f7b51697014367236d07ec58b54153fc28f828b72bf247fe5c7487520bcb0'
    record('11c-image-manifest', ['python3', str(TOOL), 'image-manifest', str(package), image, db_reference], envs['a'])
    image_manifest = json.loads((package / 'IMAGE_MANIFEST.json').read_text())
    (out / '11c-image-manifest.json').write_text(json.dumps(image_manifest, ensure_ascii=False, indent=2) + '\n')
    record('11d-remove-images', ['docker', 'image', 'rm', '-f', image, db_reference, *[i['tag'] for i in image_manifest['images'] if i['tag'] != image]], envs['a'])
    check('刪除後 VM 內沒有這些 image', all(subprocess.run(['docker', 'image', 'inspect', i['image_id']], env=envs['a'], capture_output=True).returncode != 0 for i in image_manifest['images']))
    record('12-b-init-secrets-reuse-key', ['python3', str(TOOL), 'init-secrets', str(work / 'a-secrets' / 'app.env')], envs['b'])
    bad_package = work / 'package-tampered'
    bad_package.mkdir(mode=0o700)
    (bad_package / 'IMAGE_MANIFEST.json').write_text(json.dumps({**image_manifest, 'tar_sha256': '0' * 64}))
    os.symlink(package / 'images.tar', bad_package / 'images.tar')
    record('12b-b-install-image-tampered-refused', ['python3', str(TOOL), 'install-image', str(bad_package)], envs['b'], expected=1)
    record('12c-b-install-image', ['python3', str(TOOL), 'install-image', str(package)], envs['b'])
    check('載入後 image ID 與 manifest 相同', all(subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', i['tag']], env=envs['a'], capture_output=True, text=True).stdout.strip() == i['image_id']
                                              for i in image_manifest['images']))
    tampered = work / 'backup-tampered'
    tampered.mkdir(mode=0o700)
    for name in ['enterprise.dump', 'MANIFEST.json']:
        (tampered / name).write_bytes((backup_dir / name).read_bytes())
    (tampered / 'blobs.tar').write_bytes((backup_dir / 'blobs.tar').read_bytes() + b'x')
    record('13-b-restore-tampered-refused', ['python3', str(TOOL), 'restore', str(tampered)], envs['b'], expected=1)
    record('14-b-restore', ['python3', str(TOOL), 'restore', str(backup_dir)], envs['b'])
    restore_log = (out / '14-b-restore.txt').read_text()
    check('還原驗證全表指紋、schema 與 blob（離線 image）', '"schema": "match"' in restore_log, restore_log[-300:])
    restored = login(Client(int(envs['b']['DHC_HTTP_PORT'])), 'admin@synthetic-co.example.invalid')
    _, content, _ = restored.call('GET', f"/api/enterprise/v1/documents/{fingerprint['document_id']}/versions/1/content", expect=200)
    check('還原後原檔 SHA-256 相同', hashlib.sha256(content).hexdigest() == fingerprint['document_sha256'] == fingerprint['source_docx_sha256'])
    _, hits, _ = restored.call('GET', '/api/enterprise/v1/documents/search?q=' + urllib.parse.quote('重複入帳'), expect=200)
    check('還原後檢索與引用仍可用', len(hits['items']) == 1)
    status_code, exported, _ = restored.call('GET', f"/api/enterprise/v1/drafts/{fingerprint['draft_id']}/export?format=markdown")
    check('還原後已核准草稿可匯出', status_code == 200 and 'INV-0042' in exported.decode())
    _, events, _ = restored.call('GET', '/api/enterprise/v1/audit-events?limit=100', expect=200)
    check('還原後稽核紀錄保留', len(events['items']) >= fingerprint['audit_count'])
    record('15-a-status', ['python3', str(TOOL), 'status'], envs['a'])
    # ASTRA-011：在「還原後、以交付包離線安裝」的 B 上跑真瀏覽器 E2E（含 CSP 實測）
    record('16-b-browser-e2e', ['node', 'tests/enterprise/e2e/office_e2e.mjs', f"http://127.0.0.1:{envs['b']['DHC_HTTP_PORT']}", 'synthetic-co', str(out / '16-b-browser-e2e')],
           envs['b'], extra={'DHC_E2E_PASSWORD': admin_password})
    record('17-b-perf-baseline', ['python3', '-B', 'scripts/enterprise/rcfix/perf_probe.py', f"http://127.0.0.1:{envs['b']['DHC_HTTP_PORT']}", 'synthetic-co',
                                  'staff@synthetic-co.example.invalid', str(out / '17-b-perf-baseline.results.json'), '20'], envs['b'], extra={'DHC_PERF_PASSWORD': admin_password})
except Exception as exc:
    status = 'FAIL'
    error = f'{type(exc).__name__}: {exc}'
    print('ERROR', error, flush=True)
finally:
    cleanup = []
    for name, env in envs.items():
        result = subprocess.run(['docker-compose', '-f', 'deploy/ai-office/compose.yaml', '--profile', 'tools', 'down', '--volumes', '--remove-orphans'],
                                cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        cleanup.append({'project': env['COMPOSE_PROJECT_NAME'], 'exit_code': result.returncode})
    if work.parent == ROOT / '.tmp' and work.name.startswith('delivery-'):
        shutil.rmtree(work, ignore_errors=True)
    (out / 'RESULT.json').write_text(json.dumps({'status': status, 'error': error, 'source_sha': source_sha, 'image': image, 'steps': steps,
                                                  'checks': checks, 'cleanup': cleanup, 'work_removed': not work.exists()}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': status, 'checks_passed': sum(c['passed'] for c in checks), 'checks_total': len(checks), 'error': error}, ensure_ascii=False))
raise SystemExit(0 if status == 'PASS' and all(c['exit_code'] == 0 for c in cleanup) else 1)
