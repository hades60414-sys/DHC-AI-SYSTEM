"""V5.3 WP1：ASTRA-ROLL-002 的瀏覽器＋真 PostgreSQL RED／GREEN 證據。
以指定 image 建一個全新、隔離的 compose project（合成組織），執行 tests/enterprise/e2e/office_stale_e2e.mjs，
再以 psql 直接查 PostgreSQL（draft_revisions、approvals、audit_events）交叉核對，最後刪除本 project 的容器與 volume。

用法（web-ui 目錄）：python3 -B scripts/enterprise/ci/office_e2e_redgreen.py --image <tag> --expect red|green --evidence <新目錄>
- green：瀏覽器沒有任何 violation；B 只有自己的第 1 版＋合法修改的第 2 版、沒有任何一版等於 A 的內容；B 只有 1 筆 draft.revised、0 筆 draft.submitted；
  approval D 已核准、C 仍 pending，稽核事件一致。
- red（舊版 image，只用來重現缺陷）：瀏覽器記錄到 violation，且 PostgreSQL 實際出現「B 的某一版內容等於 A」或 B 被錯誤送審。
exit 0＝符合預期；1＝不符合；不會把 red 結果當成產品通過。
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess

ROOT = Path(__file__).resolve().parents[3]
TOOL = ROOT / 'deploy/ai-office/dhc-office.py'
COMPOSE_FILE = ROOT / 'deploy/ai-office/compose.yaml'
parser = argparse.ArgumentParser()
parser.add_argument('--image', required=True)
parser.add_argument('--expect', choices=['red', 'green'], required=True)
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
out = args.evidence.resolve()
out.mkdir(parents=True, exist_ok=False)
token = secrets.token_hex(4)
work = ROOT / '.tmp' / f'stale-{token}'
work.mkdir(parents=True, mode=0o700)
password = 'Stale-synthetic-' + secrets.token_hex(8)
slug = 'stale-co'


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


env = {k: v for k, v in os.environ.items() if k in ('PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'DOCKER_HOST')}
env.update(COMPOSE_PROJECT_NAME=f'dhc-stale-{token}', DHC_SECRET_DIR=str(work / 'secrets'), DHC_HTTP_PORT=str(free_port()), DHC_IMAGE=args.image)
steps = []


def run(name, command, extra=None, expected=0):
    result = subprocess.run(command, cwd=ROOT, env={**env, **(extra or {})}, capture_output=True, text=True)
    (out / f'{name}.txt').write_text(f'$ {" ".join(command)}\nexit={result.returncode}\n--- stdout\n{result.stdout[-4000:]}\n--- stderr\n{result.stderr[-4000:]}\n')
    steps.append({'name': name, 'exit_code': result.returncode})
    if result.returncode != expected:
        raise RuntimeError(f'{name} exit {result.returncode}')
    return result.stdout


def psql(sql):
    result = subprocess.run(['docker', 'compose', '-f', str(COMPOSE_FILE), 'exec', '-T', 'db', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'dhc_bootstrap', '-d', 'dhc_enterprise', '-c', sql],
                            cwd=ROOT, env=env, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'psql failed: {result.stderr[-300:]}')
    return result.stdout.strip()


def q(value):
    return "'" + str(value).replace("'", "''") + "'"


status, error, db, checks = 'FAIL', None, {}, []
try:
    run('01-init-secrets', ['python3', str(TOOL), 'init-secrets'])
    run('02-up', ['python3', str(TOOL), 'up'])
    run('03-bootstrap', ['python3', str(TOOL), 'bootstrap', slug, '合成切換測試', f'admin@{slug}.example.invalid'], extra={'ENTERPRISE_BOOTSTRAP_ADMIN_PASSWORD': password})
    run('04-subscription', ['python3', str(TOOL), 'subscription', slug, 'team', 'active', '2026-11-01', '2027-10-31', 'stale e2e'])
    driver = subprocess.run(['node', 'tests/enterprise/e2e/office_stale_e2e.mjs', f"http://127.0.0.1:{env['DHC_HTTP_PORT']}", slug, str(out / 'browser')],
                            cwd=ROOT, env={**env, 'DHC_E2E_PASSWORD': password}, capture_output=True, text=True)
    (out / '05-browser.txt').write_text(f'exit={driver.returncode}\n{driver.stdout[-4000:]}\n{driver.stderr[-4000:]}\n')
    browser = json.loads((out / 'browser' / 'RESULT.json').read_text())
    if browser['status'] == 'ERROR':
        raise RuntimeError(f"browser driver error: {browser['fatal']}")
    ids, bodies = browser['ids'], browser['seeded']['bodies']
    revisions_b = [line.split('|', 1) for line in psql(f"SELECT revision, md5(body) FROM enterprise.draft_revisions WHERE draft_id={q(ids['draftB'])} ORDER BY revision").splitlines() if line]
    md5 = lambda text: subprocess.run(['python3', '-c', 'import hashlib,sys;print(hashlib.md5(sys.stdin.read().encode()).hexdigest())'], input=text, capture_output=True, text=True).stdout.strip()
    a_md5 = md5(bodies['draftA'])
    db['draftB_revisions'] = [{'revision': int(r), 'body_md5': h, 'equals_A_body': h == a_md5} for r, h in revisions_b]
    db['draftB_status'] = psql(f"SELECT status FROM enterprise.drafts WHERE id={q(ids['draftB'])}")
    for action in ['draft.revised', 'draft.submitted']:
        db[f'audit_{action}_B'] = int(psql(f"SELECT count(*) FROM enterprise.audit_events WHERE resource_type='draft' AND resource_id={q(ids['draftB'])} AND action={q(action)}"))
    for key in ['C', 'D']:
        db[f'approval_{key}'] = psql(f"SELECT status FROM enterprise.approvals WHERE id={q(ids['approval' + key])}")
        db[f'audit_decided_{key}'] = int(psql(f"SELECT count(*) FROM enterprise.audit_events WHERE resource_type='draft' AND resource_id={q(ids['draft' + key])} AND action LIKE 'draft.approv%'"))
    db['draftA_revisions'] = int(psql(f"SELECT count(*) FROM enterprise.draft_revisions WHERE draft_id={q(ids['draftA'])}"))
    db['citation_hashes_differ_A_B'] = browser['seeded']['citationHashes']['draftA'] != browser['seeded']['citationHashes']['draftB']
    db['approval_C_D_same_sha'] = browser['seeded']['approvals']['C']['sha'] == browser['seeded']['approvals']['D']['sha']

    def check(name, condition):
        checks.append({'name': name, 'passed': bool(condition)})
    if args.expect == 'green':
        check('瀏覽器：沒有任何 violation（所有情境）', browser['status'] == 'PASS' and not browser['violations'])
        check('PG：B 沒有任何一版內容等於 A', not any(item['equals_A_body'] for item in db['draftB_revisions']))
        check('PG：B 只有第 1 版＋合法修改的第 2 版', [item['revision'] for item in db['draftB_revisions']] == [1, 2])
        check('PG：B 的 draft.revised 稽核恰 1 筆、draft.submitted 0 筆（與 revision 一致）', db['audit_draft.revised_B'] == 1 and db['audit_draft.submitted_B'] == 0)
        check('PG：B 仍為 draft（未被錯誤送審）', db['draftB_status'] == 'draft')
        check('PG：approval D 已核准、C 仍 pending；核准稽核 D=1、C=0', db['approval_D'] == 'approved' and db['approval_C'] == 'pending' and db['audit_decided_D'] == 1 and db['audit_decided_C'] == 0)
        check('PG：A 未被修改（1 版）', db['draftA_revisions'] == 1)
    else:
        check('瀏覽器：舊版確實出現 violation（A 內容顯示在 B 或寫入 B）', browser['status'] == 'VIOLATIONS' and any(v['code'] in ('FROM_BODY_SHOWN_UNDER_TO', 'WROTE_FROM_BODY_TO_TARGET') for v in browser['violations']))
        check('PG：舊版實際把 A 的內容寫成 B 的新版本或錯誤送審 B', any(item['equals_A_body'] for item in db['draftB_revisions']) or db['draftB_status'] != 'draft' or db['audit_draft.submitted_B'] > 0)
    status = 'PASS' if all(item['passed'] for item in checks) else 'FAIL'
except Exception as exc:
    status, error = 'FAIL', f'{type(exc).__name__}: {exc}'
finally:
    down = subprocess.run(['docker', 'compose', '-f', str(COMPOSE_FILE), '--profile', 'tools', 'down', '--volumes', '--remove-orphans'], cwd=ROOT, env=env, capture_output=True, text=True)
    subprocess.run(['rm', '-rf', str(work)])
    (out / 'RESULT.json').write_text(json.dumps({'status': status, 'expect': args.expect, 'image': args.image, 'error': error, 'steps': steps, 'checks': checks, 'db': db,
                                               'cleanup_exit_code': down.returncode}, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({'status': status, 'expect': args.expect, 'checks': f"{sum(c['passed'] for c in checks)}/{len(checks)}", 'error': error}, ensure_ascii=False))
raise SystemExit(0 if status == 'PASS' else 1)
