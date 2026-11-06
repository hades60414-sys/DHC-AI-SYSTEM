"""E01 真實 Compose 驗收。僅刪除此程式建立的隨機 QA project volume。"""
import json
import os
import re
from pathlib import Path
import socket
import subprocess
import time
import tempfile
import sys
import urllib.error
import urllib.request
import uuid
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
capacity = subprocess.run([sys.executable,str(root/'scripts/enterprise/檢查測試容量.py'),'--stage','running-vm'])
if capacity.returncode:
    raise SystemExit(capacity.returncode)
project = 'dhc-e01-' + uuid.uuid4().hex[:10]
env = os.environ.copy()
secret_fixture = tempfile.TemporaryDirectory(prefix='dhc-e01-db-secrets-')
env['DHC_SECRET_DIR'] = str(Path(secret_fixture.name) / 'secrets')
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
env['DHC_HTTP_PORT'] = str(port)
compose = ['docker', 'compose', '-p', project, '-f', str(root / 'deploy/customer-single/compose.yaml')]
checks = []
token = None

def run(args, expected=0):
    result = subprocess.run(args, cwd=root, env=env, capture_output=True, text=True)
    assert result.returncode == expected, (args, result.returncode, result.stdout, result.stderr)
    return result.stdout

def request(route, method='GET', body=None, expected=200, auth=True):
    headers = {'Content-Type': 'application/json'}
    if token and auth:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(f'http://127.0.0.1:{port}' + route, method=method,
        headers=headers, data=json.dumps(body).encode() if body is not None else None)
    try:
        response = urllib.request.urlopen(req, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    data = response.read()
    assert response.status == expected, (route, response.status)
    return json.loads(data)

try:
    run(['python3', str(root / 'deploy/customer-single/產生本機資料庫密碼.py'), '--directory', env['DHC_SECRET_DIR']])
    run(compose + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '120', 'app'])
    container = run(compose + ['ps', '-q', 'app']).strip()
    inspection = json.loads(run(['docker', 'inspect', container]))[0]
    assert inspection['Config']['User'] == 'node'
    assert inspection['HostConfig']['ReadonlyRootfs'] is True
    assert inspection['HostConfig']['Privileged'] is False
    bindings = inspection['HostConfig']['PortBindings']['3001/tcp']
    assert bindings == [{'HostIp':'127.0.0.1','HostPort':str(port)}]
    assert all(m['Type'] != 'bind' for m in inspection['Mounts'])
    assert 'no-new-privileges:true' in inspection['HostConfig']['SecurityOpt']
    checks.append('非root、唯讀rootfs、無privileged/host bind、僅127.0.0.1 port')
    health = request('/health', auth=False)
    assert health['status'] == 'ok' and health['version'] == '1.37.3'
    request('/api/dhc/config', expected=401)
    account = {'username':'synthetic-container', 'password':'Synthetic-container-2026!'}
    token = request('/api/auth/register', 'POST', account)['token']
    request('/api/auth/register', 'POST', account, expected=403)
    request('/api/auth/login', 'POST', {**account,'password':'wrong'}, expected=401)
    cfg = request('/api/dhc/config')
    assert cfg['mode'] == 'personal' and cfg['agents'] == ['claude','codex']
    request('/api/agent', 'POST', {}, expected=401, auth=False)
    checks.append('原註冊/登入拒絕路徑、personal配置、Agent API無key拒絕')
    request('/api/user/preferences', 'PATCH', {'synthetic-container':'persisted'})
    session = request('/api/providers/sessions', 'POST', {'provider':'codex',
        'projectPath':'/home/node/DHC Workspace', 'initialMessage':'合成容器驗收'}, expected=201)['data']['sessionId']
    request('/api/user/complete-onboarding', 'POST', {})
    with sync_playwright() as playwright:
        # 不寫死本機路徑：DHC_CHROMIUM_PATH 指定瀏覽器執行檔；未設定時用 Playwright 預設安裝的 Chromium
        chromium = os.environ.get('DHC_CHROMIUM_PATH')
        browser = playwright.chromium.launch(**({'executable_path': chromium} if chromium else {}), headless=True)
        try:
            page = browser.new_page()
            page.goto(f'http://127.0.0.1:{port}', wait_until='load')
            page.locator('#username').fill(account['username'])
            page.locator('#password').fill(account['password'])
            page.locator('button[type=submit]').click()
            page.wait_for_function("localStorage.getItem('auth-token') !== null")
            page.locator('#username').wait_for(state='hidden')
            for selector in ['[title^="例行工作："]', '[title^="查詢專區："]']:
                navigation = page.locator(selector + ':visible')
                navigation.click()
                expect(navigation).to_have_attribute('aria-pressed', 'true')
            assert page.evaluate("""async (sessionId) => await new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://${location.host}/ws?token=${localStorage.getItem('auth-token')}`);
                const timer = setTimeout(() => { ws.close(); reject(new Error('ws timeout')); }, 10000);
                ws.onopen = () => ws.send(JSON.stringify({type:'chat.subscribe',sessions:[{sessionId,lastSeq:0}]}));
                ws.onmessage = e => { if(JSON.parse(e.data).kind==='chat_subscribed') {
                    clearTimeout(timer); ws.close(); resolve(true); } };
                ws.onerror = () => { clearTimeout(timer); reject(new Error('ws failure')); };
            })""", session) is True
            checks.append('容器中原UI真實表單登入、工作台、WS chat.subscribe')
        finally:
            browser.close()
    run(compose + ['exec', '-T', 'app', 'env', 'SERVER_PORT=1', 'node',
        'deploy/customer-single/healthcheck.mjs'], expected=1)
    checks.append('healthcheck 連錯port exit 1')
    # 真正移除並重建容器／network，保留唯一 QA volume，驗證資料可重掛。
    run(compose + ['down'])
    run(compose + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '120', 'app'])
    token = request('/api/auth/login','POST',account)['token']
    assert request('/api/user/preferences')['preferences']['synthetic-container'] == 'persisted'
    assert request('/api/providers/sessions/' + session)['data']['sessionId'] == session
    checks.append('down/up後原帳號、SQLite個人設定與session保留')
    container = run(compose + ['ps', '-q', 'app']).strip()
    version = run(compose + ['exec', '-T', 'app', 'node', '--version']).strip()
    image_id = json.loads(run(['docker','inspect',container]))[0]['Image']
    print(json.dumps({'project':project,'passed':len(checks),'failed':0,'checks':checks,
        'image_id':image_id,'node':version,'provider_execution':'PENDING；未送模型請求'}, ensure_ascii=False,indent=2))
finally:
    logs = subprocess.run(compose + ['logs','--no-color'], cwd=root, env=env,
        capture_output=True,text=True)
    print('CONTAINER_STARTUP_LOG_BEGIN')
    print(re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', 'REDACTED_JWT', logs.stdout))
    print('CONTAINER_STARTUP_LOG_END')
    # 僅此隨機 project 的合成 volume；不接觸使用者既有部署。
    cleanup = subprocess.run(compose + ['down','--volumes','--remove-orphans'], cwd=root,
        env=env, capture_output=True,text=True)
    secret_fixture.cleanup()
    assert cleanup.returncode == 0, cleanup.stderr
    assert not run(['docker','ps','-aq','--filter','label=com.docker.compose.project='+project]).strip()
    assert not run(['docker','volume','ls','-q','--filter','label=com.docker.compose.project='+project]).strip()
    print('QA_CLEANUP_PASS：容器、network、合成volume已移除；browser context已關閉')
