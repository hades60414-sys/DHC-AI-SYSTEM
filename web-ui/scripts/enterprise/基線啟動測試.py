"""真實編譯服務的 G0 smoke；只使用合成資料，結束清除 fixture。"""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

root = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='dhc-g0-') as temporary:
    fixture = Path(temporary)
    config = fixture / 'dhc.config.json'
    config.write_text(json.dumps({'workspaceRoot': str(fixture / '工作區'), 'mode': 'personal',
        'agents': ['claude', 'codex'], 'remote': {'enabled': False}, 'domain': 'general'}))
    env = {key: value for key, value in os.environ.items()
        if key in ['PATH', 'TMPDIR', 'SHELL', 'USER', 'LANG', 'LC_ALL']}
    env.update(DHC_TEST_ROOT=temporary, DATABASE_PATH=str(fixture / 'auth.db'),
        DHC_CONFIG=str(config), WORKSPACES_ROOT=str(fixture / '工作區'),
        NODE_OPTIONS='--import="' + str(root / 'scripts/enterprise/隔離測試家目錄.mjs') + '"')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    env.update(HOST='127.0.0.1', SERVER_PORT=str(port))
    base = f'http://127.0.0.1:{port}'
    token = None
    checks = []
    def request(route, method='GET', body=None, expected=200, auth=True):
        headers = {'Content-Type': 'application/json'}
        if token and auth:
            headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request(base + route, method=method, headers=headers,
            data=json.dumps(body).encode() if body is not None else None)
        try:
            response = urllib.request.urlopen(req, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        data = response.read()
        assert response.status == expected, (route, response.status)
        return json.loads(data)
    log_path = fixture / 'server.txt'
    def start():
        process = subprocess.Popen(['npm', 'run', 'server'], cwd=root, env=env,
            stdout=log_path.open('a'), stderr=subprocess.STDOUT, start_new_session=True)
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError('server exited: ' + log_path.read_text()[-3000:])
            try:
                request('/health', auth=False)
                return process
            except urllib.error.URLError:
                time.sleep(0.2)
        raise RuntimeError('server startup timeout')
    def stop(process):
        if process.poll() is not None:
            return
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    process = start()
    try:
        assert request('/api/auth/status')['needsSetup'] is True
        request('/api/dhc/config', expected=401)
        account = {'username': 'synthetic-admin', 'password': 'Synthetic-only-2026!'}
        token = request('/api/auth/register', 'POST', account)['token']
        request('/api/auth/register', 'POST', account, expected=403)
        request('/api/auth/login', 'POST', {**account, 'password': 'wrong'}, expected=401)
        token = request('/api/auth/login', 'POST', account)['token']
        assert request('/api/auth/user')['user']['username'] == account['username']
        checks.append('首次註冊、登入、401、第二使用者403')
        cfg = request('/api/dhc/config')
        assert cfg['mode'] == 'personal' and cfg['agents'] == ['claude', 'codex']
        request('/api/user/preferences', 'PATCH', {'synthetic-g0': 'saved'})
        result = request('/api/providers/sessions', 'POST', {'provider': 'codex',
            'projectPath': str(fixture / '工作區'), 'initialMessage': '合成測試'}, expected=201)
        session_id = result['data']['sessionId']
        checks.append('個人配置、設定、Codex session 入口建立')
        request('/api/agent', 'POST', {}, expected=401, auth=False)
        # 瀏覽器使用原 login 表單與真實 HTTP；JWT 只保留在暫存 browser context。
        from playwright.sync_api import sync_playwright, expect
        # 不寫死本機路徑：DHC_CHROMIUM_PATH 指定瀏覽器執行檔；未設定時用 Playwright 預設安裝的 Chromium
        chromium = os.environ.get('DHC_CHROMIUM_PATH')
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(**({'executable_path': chromium} if chromium else {}), headless=True)
            try:
                page = browser.new_page()
                page.goto(base, wait_until='load')
                page.locator('#username').fill(account['username'])
                page.locator('#password').fill(account['password'])
                page.locator('button[type=submit]').click()
                page.wait_for_function("localStorage.getItem('auth-token') !== null")
                request('/api/user/complete-onboarding', 'POST', {})
                page.reload(wait_until='load')
                page.locator('#username').wait_for(state='hidden')
                for selector in ['[title^="例行工作："]', '[title^="查詢專區："]']:
                    navigation = page.locator(selector + ':visible')
                    navigation.click()
                    expect(navigation).to_have_attribute('aria-pressed', 'true')
                acknowledged = page.evaluate("""async (sessionId) => await new Promise((resolve, reject) => {
                    const ws = new WebSocket(`ws://${location.host}/ws?token=${localStorage.getItem('auth-token')}`);
                    const timer = setTimeout(() => { ws.close(); reject(new Error('ws timeout')); }, 10000);
                    ws.onopen = () => ws.send(JSON.stringify({type:'chat.subscribe',sessions:[{sessionId,lastSeq:0}]}));
                    ws.onmessage = e => { const d=JSON.parse(e.data); if(d.kind==='chat_subscribed') {
                        clearTimeout(timer); ws.close(); resolve(true); } };
                    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws failure')); };
                })""", session_id)
                assert acknowledged is True
                checks.append('真實瀏覽器登入、工作台、WebSocket chat.subscribe 回應')
            finally:
                browser.close()
        stop(process)
        process = start()
        assert request('/api/user/preferences')['preferences']['synthetic-g0'] == 'saved'
        assert request('/api/providers/sessions/' + session_id)['data']['sessionId'] == session_id
        checks.append('重啟後 SQLite 個人設定及 session 保留')
        print(json.dumps({'passed': len(checks), 'failed': 0, 'checks': checks,
            'provider_execution': 'PENDING：未呼叫付費模型或個人登入', 'cleanup': 'finally'}, ensure_ascii=False, indent=2))
    finally:
        stop(process)
        print("SERVER_LOG_BEGIN")
        print(log_path.read_text())
        print("SERVER_LOG_END")
