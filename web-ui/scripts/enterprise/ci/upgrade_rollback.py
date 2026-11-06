"""V5.1 Batch D：跨版本升級與回退（V4 PR #10 image → V5.1 image），在 GitHub Actions 原生 runner 執行；只用合成資料與 mock 模型。
由 V4 RC 的 scripts/enterprise/rcfix/upgrade_rollback.py（ASTRA-011，本機 QA VM 版）改寫：舊 image 由 CI 從固定來源 SHA 建置後以 tag 傳入。

用法（repo 的 web-ui 目錄）：
  python3 -B scripts/enterprise/ci/upgrade_rollback.py --old-image <tag> --old-source <sha> --new-image <tag> --new-source <sha> --evidence <新目錄>
流程：舊版安裝並以舊 API 產生資料（文件、核准草稿、ACC-MATCH 對帳）→ 升級前備份 → 同一 project 換新 image 跑 up（套用 0013–0014）→
新版讀舊資料、匯出舊核准草稿、新 Run、新功能（OPS-REPORT、對帳匯出）→ 回退：舊 image 建全新 project，還原升級前備份 → 舊版服務資料。
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[3]  # web-ui
TOOL = ROOT / 'deploy/ai-office/dhc-office.py'
parser = argparse.ArgumentParser()
parser.add_argument('--old-image', required=True)
parser.add_argument('--old-source', required=True)
parser.add_argument('--new-image', required=True)
parser.add_argument('--new-source', required=True)
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
out = args.evidence.resolve()
out.mkdir(parents=True, exist_ok=False)
token = secrets.token_hex(4)
work = ROOT / '.tmp' / f'upgrade-{token}'
work.mkdir(parents=True, mode=0o700)
password = 'Upgrade-synthetic-' + secrets.token_hex(8)
OLD_TAG = args.old_image
FIXTURE = ROOT / 'docs/enterprise/scenarios'
steps, checks, envs = [], [], {}


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def project_env(name, image):
    env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'DOCKER_HOST')}
    env.update(COMPOSE_PROJECT_NAME=f'dhc-upgrade-{name}-{token}', DHC_SECRET_DIR=str(work / f'{name}-secrets'), DHC_HTTP_PORT=str(free_port()), DHC_IMAGE=image)
    return env


def record(name, command, env, expected=0, extra=None, stdin_path=None):
    full = ['python3', 'scripts/enterprise/記錄指令.py', str(out / (name + '.txt')), *command]
    result = subprocess.run(full, cwd=ROOT, env={**env, **(extra or {})})
    steps.append({'name': name, 'exit_code': result.returncode, 'expected': expected})
    if result.returncode != expected:
        raise RuntimeError(f'step {name} exit {result.returncode}')


def check(name, condition, detail=''):
    checks.append({'name': name, 'passed': bool(condition), 'detail': str(detail)[:300]})
    if not condition:
        raise RuntimeError(f'check failed: {name} {detail}')


def call(port, method, path, token_value=None, body=None, raw=None, headers=None, expect=None):
    request_headers = dict(headers or {})
    if token_value:
        request_headers['Authorization'] = 'Bearer ' + token_value
    data = raw
    if body is not None:
        request_headers['Content-Type'] = 'application/json'
        data = json.dumps(body).encode()
    request = urllib.request.Request(f'http://127.0.0.1:{port}{path}', method=method, data=data, headers=request_headers)
    try:
        response = urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    content = response.read()
    payload = json.loads(content) if content and 'json' in (response.headers.get('content-type') or '') else content
    if expect is not None and response.status != expect:
        raise RuntimeError(f'{method} {path} expected {expect} got {response.status}: {str(payload)[:200]}')
    return response.status, payload


def login(port, email):
    return call(port, 'POST', '/api/enterprise/v1/auth/login', body={'organizationSlug': 'upgrade-co', 'email': email, 'password': password}, expect=200)[1]['token']


def wait_run(port, token_value, run_id):
    for _ in range(60):
        run = call(port, 'GET', f'/api/enterprise/v1/runs/{run_id}', token_value, expect=200)[1]
        if run['status'] not in ('queued', 'running'):
            return run
        time.sleep(1)
    raise RuntimeError('run did not finish')


status, error = 'PASS', None
try:
    images = {}
    for role, tag, sha in [('old', OLD_TAG, args.old_source), ('new', args.new_image, args.new_source)]:
        meta = json.loads(subprocess.run(['docker', 'image', 'inspect', tag], capture_output=True, text=True, check=True).stdout)[0]
        images[role] = {'tag': tag, 'id': meta['Id'], 'architecture': f"{meta['Os']}/{meta['Architecture']}", 'source_revision': (meta['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')}
        check(f'{role} image 的 source label 等於預期來源 SHA', images[role]['source_revision'] == sha, images[role])
    (out / '01-images.json').write_text(json.dumps(images, ensure_ascii=False, indent=1) + '\n')

    envs['u'] = project_env('u', OLD_TAG)
    record('02-old-init-secrets', ['python3', str(TOOL), 'init-secrets'], envs['u'])
    record('03-old-up', ['python3', str(TOOL), 'up'], envs['u'])
    record('04-old-bootstrap', ['python3', str(TOOL), 'bootstrap', 'upgrade-co', '合成升級公司', 'admin@upgrade-co.example.invalid'], envs['u'],
           extra={'ENTERPRISE_BOOTSTRAP_ADMIN_PASSWORD': password})
    record('05-old-subscription', ['python3', str(TOOL), 'subscription', 'upgrade-co', 'team', 'active', '2026-11-01', '2027-10-31', 'upgrade test'], envs['u'])
    port = int(envs['u']['DHC_HTTP_PORT'])
    admin = login(port, 'admin@upgrade-co.example.invalid')
    for email, role in [('approver@upgrade-co.example.invalid', 'approver'), ('staff@upgrade-co.example.invalid', 'employee')]:
        call(port, 'POST', '/api/enterprise/v1/members', admin, body={'email': email, 'password': password, 'roles': [role]}, expect=201)
    call(port, 'PUT', '/api/enterprise/v1/models/providers', admin, body={'key': 'offline', 'kind': 'mock', 'deployment': 'LOCAL_ONLY', 'monthlyBudgetMicros': 0}, expect=200)
    staff, approver = login(port, 'staff@upgrade-co.example.invalid'), login(port, 'approver@upgrade-co.example.invalid')
    source = '舊版文件 升級測試 交付期限 2026/12/31 金額 88,000'.encode()
    created = call(port, 'POST', '/api/enterprise/v1/documents', staff, raw=source, headers={'Content-Type': 'text/plain', 'x-dhc-title': 'upgrade', 'x-dhc-filename': 'u.txt'}, expect=201)[1]
    run = call(port, 'POST', '/api/enterprise/v1/runs/draft-generation', staff, body={'title': '升級前草稿', 'query': '升級測試', 'providerKey': 'offline'},
               headers={'idempotency-key': 'upgrade-run-0001'}, expect=202)[1]['run']
    run = wait_run(port, staff, run['id'])
    check('舊版 Run 完成', run['status'] == 'succeeded', run)
    draft_id = run['draftId']
    call(port, 'PUT', f'/api/enterprise/v1/drafts/{draft_id}', staff, body={'expectedRevision': 1, 'body': '依來源 [1]，交付期限 2026/12/31。'}, expect=200)
    # 舊版忽略多出的欄位；新版（0011 起）要求送審版號與審批確認的版號／hash
    approval = call(port, 'POST', f'/api/enterprise/v1/drafts/{draft_id}/submit', staff, body={'expectedRevision': 2}, expect=201)[1]
    call(port, 'POST', f"/api/enterprise/v1/approvals/{approval['approvalId']}/decision", approver,
         body={'decision': 'approve', 'expectedRevision': approval.get('revision', 2), 'expectedSha256': approval.get('revisionSha256')}, expect=200)
    # 舊版（V4）也建立一筆 ACC-MATCH 對帳，確認升級後舊對帳可用 V5.1 匯出
    acc = FIXTURE / '會計對帳'
    ledger_doc = call(port, 'POST', '/api/enterprise/v1/documents', staff, raw=(acc / '合成內部帳.csv').read_bytes(), headers={'Content-Type': 'text/csv', 'x-dhc-title': 'ledger', 'x-dhc-filename': 'ledger.csv'}, expect=201)[1]
    receipts_doc = call(port, 'POST', '/api/enterprise/v1/documents', staff, raw=(acc / '合成收款明細.csv').read_bytes(), headers={'Content-Type': 'text/csv', 'x-dhc-title': 'receipts', 'x-dhc-filename': 'receipts.csv'}, expect=201)[1]
    doc_id = lambda d: d.get('document', {}).get('id') or d.get('id')
    old_recon = call(port, 'POST', '/api/enterprise/v1/reconciliations', staff, body={'ledger': {'documentId': doc_id(ledger_doc), 'versionNumber': 1},
        'receipts': {'documentId': doc_id(receipts_doc), 'versionNumber': 1}, 'periodStart': '2026-10-01', 'periodEnd': '2026-10-28'}, expect=201)[1]['reconciliation']
    check('舊版對帳完成', old_recon['status'] == 'completed', old_recon['status'])
    old_migrations = subprocess.run(['python3', str(TOOL), 'status'], cwd=ROOT, env=envs['u'], capture_output=True, text=True).stdout
    (out / '06-old-status.json').write_text(old_migrations)
    check('舊版（V4）到 0012、沒有 0013', '0012_reconciliations' in old_migrations and '0013' not in old_migrations, old_migrations[-200:])

    backup = work / 'pre-upgrade'
    record('07-pre-upgrade-backup', ['python3', str(TOOL), 'backup', str(backup)], envs['u'])
    manifest = json.loads((backup / 'MANIFEST.json').read_text())
    (out / '07-pre-upgrade-manifest.json').write_text(json.dumps({k: v for k, v in manifest.items() if k != 'note'}, ensure_ascii=False, indent=1) + '\n')

    # 升級：同一 project 換新 image
    envs['u']['DHC_IMAGE'] = args.new_image
    record('08-upgrade-up', ['python3', str(TOOL), 'up'], envs['u'])
    new_status = subprocess.run(['python3', str(TOOL), 'status'], cwd=ROOT, env=envs['u'], capture_output=True, text=True).stdout
    (out / '09-new-status.json').write_text(new_status)
    check('升級後套用到 0014', '0014_reconciliation_exports' in new_status and '0013_ops_reports' in new_status, new_status[-200:])
    staff = login(port, 'staff@upgrade-co.example.invalid')
    content = call(port, 'GET', f"/api/enterprise/v1/documents/{created['document']['id']}/versions/1/content", staff, expect=200)[1]
    check('升級後舊文件原檔 SHA-256 不變', hashlib.sha256(content).hexdigest() == hashlib.sha256(source).hexdigest())
    draft = call(port, 'GET', f'/api/enterprise/v1/drafts/{draft_id}', staff, expect=200)[1]
    check('升級後舊草稿仍為已核准，且新版引用檢查判定 VALID', draft['draft']['status'] == 'approved' and draft['revision']['citationStatus'] == 'VALID', draft['revision'].get('citationStatus'))
    status_code, exported = call(port, 'GET', f'/api/enterprise/v1/drafts/{draft_id}/export?format=markdown', staff)
    check('升級後可匯出舊核准草稿', status_code == 200 and '2026/12/31' in exported.decode())
    new_run = call(port, 'POST', '/api/enterprise/v1/runs/draft-generation', staff, body={'title': '升級後草稿', 'query': '升級測試', 'providerKey': 'offline'},
                   headers={'idempotency-key': 'upgrade-run-0002'}, expect=202)[1]['run']
    check('升級後新 Run 可完成', wait_run(port, staff, new_run['id'])['status'] == 'succeeded')
    status_code, exported = call(port, 'GET', f"/api/enterprise/v1/reconciliations/{old_recon['id']}/export?format=json", staff)
    exported_doc = exported if isinstance(exported, dict) else json.loads(exported)  # call() 已把 application/json 解析成 dict
    check('升級後舊版對帳可匯出（V5.1）且結果 hash 不變', status_code == 200 and exported_doc['reconciliation']['resultSha256'] == old_recon['resultSha256'], status_code)
    ops_doc = call(port, 'POST', '/api/enterprise/v1/documents', staff, raw=(FIXTURE / '營運週報' / '合成營運明細.csv').read_bytes(), headers={'Content-Type': 'text/csv', 'x-dhc-title': 'ops', 'x-dhc-filename': 'ops.csv'}, expect=201)[1]
    ops = call(port, 'POST', '/api/enterprise/v1/ops-reports', staff, body={'sources': [{'documentId': doc_id(ops_doc), 'versionNumber': 1}], 'week': '2026-W43', 'datasets': ['BASE']}, expect=201)[1]['opsReport']
    claim = next(item for item in ops['result']['claims'] if item['claimId'] == 'OP-CLM-01')
    check('升級後新功能 OPS-REPORT 可用（本週完成 210）', ops['status'] == 'completed' and claim['display'] == '210', claim.get('display'))

    # 回退：舊 image、全新 project、還原升級前備份
    envs['r'] = project_env('r', OLD_TAG)
    record('10-rollback-init-secrets', ['python3', str(TOOL), 'init-secrets', str(work / 'u-secrets' / 'app.env')], envs['r'])
    record('11-rollback-restore', ['python3', str(TOOL), 'restore', str(backup)], envs['r'])
    restore_log = (out / '11-rollback-restore.txt').read_text()
    check('回退還原：全表、schema、blob 指紋與升級前備份相同', '"schema": "match"' in restore_log, restore_log[-300:])
    rport = int(envs['r']['DHC_HTTP_PORT'])
    rstaff = login(rport, 'staff@upgrade-co.example.invalid')
    content = call(rport, 'GET', f"/api/enterprise/v1/documents/{created['document']['id']}/versions/1/content", rstaff, expect=200)[1]
    check('回退後舊版服務原檔', hashlib.sha256(content).hexdigest() == hashlib.sha256(source).hexdigest())
    check('回退後舊版可匯出升級前核准草稿', call(rport, 'GET', f'/api/enterprise/v1/drafts/{draft_id}/export?format=markdown', rstaff)[0] == 200)
    check('回退後舊版仍讀得到升級前對帳', call(rport, 'GET', f"/api/enterprise/v1/reconciliations/{old_recon['id']}", rstaff)[0] == 200)
    check('回退後的 schema 為舊版（沒有 0013）', '0013' not in subprocess.run(['python3', str(TOOL), 'status'], cwd=ROOT, env=envs['r'], capture_output=True, text=True).stdout)
except Exception as exc:
    status, error = 'FAIL', f'{type(exc).__name__}: {exc}'
    print('ERROR', error, flush=True)
finally:
    cleanup = []
    for name, env in envs.items():
        result = subprocess.run(['docker-compose', '-f', 'deploy/ai-office/compose.yaml', '--profile', 'tools', 'down', '--volumes', '--remove-orphans'],
                                cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        cleanup.append({'project': env['COMPOSE_PROJECT_NAME'], 'exit_code': result.returncode})
    shutil.rmtree(work, ignore_errors=True)
    (out / 'RESULT.json').write_text(json.dumps({'status': status, 'error': error, 'old_image': OLD_TAG, 'old_source': args.old_source, 'new_image': args.new_image, 'new_source': args.new_source, 'steps': steps, 'checks': checks,
                                                  'cleanup': cleanup}, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({'status': status, 'checks': f"{sum(c['passed'] for c in checks)}/{len(checks)}", 'error': error}, ensure_ascii=False))
raise SystemExit(0 if status == 'PASS' else 1)
