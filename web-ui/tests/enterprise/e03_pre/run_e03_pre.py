"""E03-PRE：Legacy 入口負向特徵矩陣（黑箱、真實伺服器行程、合成資料）。

用法（repo 根目錄）：
    python3 -B tests/enterprise/e03_pre/run_e03_pre.py <matrix-output.json>

每個 REQ 案例斷言「企業模式應有的安全行為」；目前原系統違反時記 RED，如實保留，
不為綠燈弱化測試。CTRL 案例是對照組，用來證明 harness 確實打到真實驗證層：
對照組失敗代表 harness 無效（exit 2），不可拿來解讀 RED。

Exit code：0＝全部 REQ GREEN；1＝至少一個 REQ RED（E03-PRE 預期）；2＝對照組失敗或環境錯誤。

安全邊界：只用暫存目錄的合成帳號與 SQLite；HOME/os.homedir 指向暫存區；Shell 只執行
printf 標記字串；Agent API 只送會在輸入驗證就被拒的空 body，不呼叫任何模型或外部網路。
"""
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ws_client import UpgradeRejected, WebSocket  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
HOST = '127.0.0.1'
ACCOUNT = {'username': 'synthetic-admin', 'password': 'Synthetic-only-2026!'}
SYNTHETIC_MCP_TOKEN = 'e03pre-synthetic-browser-mcp-token-' + '0' * 28
ASSET_NAME = '1700000000000-1-e03pre-synthetic.txt'
ASSET_BODY = b'E03PRE synthetic asset owned by synthetic-admin\n'

results = []


def record(case_id, kind, entry, mode, requirement, observed, secure, severity=None, note=None):
    verdict = ('PASS' if secure else 'FAIL') if kind == 'CTRL' else ('GREEN' if secure else 'RED')
    row = {'id': case_id, 'kind': kind, 'entry': entry, 'mode': mode, 'requirement': requirement,
           'observed': observed, 'verdict': verdict}
    if severity and not secure:
        row['severity_if_red'] = severity
    if note:
        row['note'] = note
    results.append(row)
    print(f'[{verdict}] {case_id} {entry} :: {observed}', flush=True)


def free_port():
    with socket.socket() as probe:
        probe.bind((HOST, 0))
        return probe.getsockname()[1]


class Server:
    def __init__(self, fixture, platform):
        self.fixture = fixture
        self.platform = platform
        self.port = free_port()
        self.log = fixture / ('server-platform.txt' if platform else 'server-oss.txt')
        self.process = None

    @property
    def base(self):
        return f'http://{HOST}:{self.port}'

    def env(self):
        keep = ['PATH', 'TMPDIR', 'USER', 'LANG', 'LC_ALL']
        env = {k: v for k, v in os.environ.items() if k in keep}
        workspace = self.fixture / 'workspace'
        env.update(HOME=str(self.fixture / 'home'), SHELL='/bin/sh', DHC_TEST_ROOT=str(self.fixture / 'home'),
                   DATABASE_PATH=str(self.fixture / 'auth.db'), DHC_CONFIG=str(self.fixture / 'dhc.config.json'),
                   WORKSPACES_ROOT=str(workspace), HOST=HOST, SERVER_PORT=str(self.port),
                   JWT_SECRET='e03pre-synthetic-jwt-secret-not-for-production',
                   NODE_OPTIONS='--import="' + str(ROOT / 'scripts/enterprise/隔離測試家目錄.mjs') + '"')
        env.pop('API_KEY', None)  # 刻意不設定：E03-PRE-REQ-API_KEY_MISSING 的前提
        if self.platform:
            env['VITE_IS_PLATFORM'] = 'true'
        return env

    def start(self):
        command = [str(ROOT / 'node_modules/.bin/tsx'), '--tsconfig', 'server/tsconfig.json', 'server/index.ts']
        self.process = subprocess.Popen(command, cwd=ROOT, env=self.env(), stdout=self.log.open('a'),
                                        stderr=subprocess.STDOUT, start_new_session=True)
        for _ in range(300):
            if self.process.poll() is not None:
                raise RuntimeError('server exited early: ' + self.log.read_text()[-3000:])
            try:
                status, _ = http(self, '/health')
                if status == 200:
                    return
            except (urllib.error.URLError, ConnectionError, OSError):
                pass
            time.sleep(0.2)
        raise RuntimeError('server startup timeout')

    def stop(self):
        if not self.process or self.process.poll() is not None:
            return
        os.killpg(self.process.pid, signal.SIGTERM)
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait()


def http(server, route, method='GET', body=None, headers=None):
    request_headers = {'Content-Type': 'application/json'}
    request_headers.update(headers or {})
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(server.base + route, method=method, headers=request_headers, data=data)
    try:
        response = urllib.request.urlopen(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read()
    try:
        payload = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        payload = raw[:200].decode(errors='replace')
    return response.status, payload


def ws_open(server, path, token=None):
    return WebSocket.connect(HOST, server.port, path + (f'?token={token}' if token else ''))


def ws_upgrade_status(server, path, token=None):
    try:
        ws = ws_open(server, path, token)
    except UpgradeRejected as rejected:
        return 'REJECTED ' + rejected.status_line
    ws.close()
    return 'ACCEPTED 101'


def shell_marker_run(ws, project_path, marker_suffix, interactive=False):
    """用 plain shell 只執行 printf；回傳是否在輸出中看到組合後的標記。"""
    command = f"printf 'E03%s\\n' {marker_suffix}"
    marker = 'E03' + marker_suffix
    if interactive:
        # plain shell 的空 initialCommand 會變成 `bash -c ""` 立即結束；用 /bin/sh 保持 PTY 存活。
        ws.send_json({'type': 'init', 'projectPath': str(project_path), 'provider': 'plain-shell',
                      'isPlainShell': True, 'initialCommand': '/bin/sh', 'cols': 80, 'rows': 24})
        ws.collect_text(3)
        ws.send_json({'type': 'input', 'data': command + '\n'})
    else:
        ws.send_json({'type': 'init', 'projectPath': str(project_path), 'provider': 'plain-shell',
                      'isPlainShell': True, 'initialCommand': command, 'cols': 80, 'rows': 24})
    output = ''.join(ws.collect_text(12, stop_marker=marker))
    return marker_seen(output, command, marker), output[-300:]


def marker_seen(output, command, marker):
    """只有命令真的被執行才算看到標記；PTY 回顯的命令文字本身不能造成假 RED。"""
    return marker in output.replace(command, '')


def set_active(fixture, active):
    with sqlite3.connect(fixture / 'auth.db') as db:
        db.execute('UPDATE users SET is_active = ? WHERE username = ?', (1 if active else 0, ACCOUNT['username']))


def seed(fixture):
    with sqlite3.connect(fixture / 'auth.db') as db:
        db.execute('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)',
                   ('browser_use_mcp_token', SYNTHETIC_MCP_TOKEN))
    assets = fixture / 'home' / '.cloudcli' / 'assets'
    assets.mkdir(parents=True, exist_ok=True)
    (assets / ASSET_NAME).write_bytes(ASSET_BODY)


def phase_oss(fixture):
    server = Server(fixture, platform=False)
    server.start()
    try:
        status, _ = http(server, '/api/user/preferences')
        record('CTRL-OSS-HTTP-NO-TOKEN', 'CTRL', 'GET /api/user/preferences', 'OSS',
               'no credential -> 401', f'HTTP {status}', status == 401)

        status, payload = http(server, '/api/auth/register', 'POST', ACCOUNT)
        token = (payload or {}).get('token')
        record('CTRL-OSS-REGISTER', 'CTRL', 'POST /api/auth/register', 'OSS',
               'synthetic first account can be created', f'HTTP {status}', status == 200 and bool(token))
        auth = {'Authorization': 'Bearer ' + token}
        seed(fixture)

        status, _ = http(server, '/api/user/preferences', headers=auth)
        record('CTRL-OSS-HTTP-JWT', 'CTRL', 'GET /api/user/preferences', 'OSS',
               'valid bearer JWT -> 200', f'HTTP {status}', status == 200)

        status, _ = http(server, '/api/auth/status')
        record('E03-PRE-REQ-API_KEY_MISSING', 'REQ', 'validateApiKey on /api/*', 'OSS(API_KEY unset)',
               'enterprise mode must fail closed when the API gate secret is not configured '
               '(refuse start or reject); a missing setting must not silently disable the gate',
               f'API_KEY unset; /api/auth/status without x-api-key -> HTTP {status} (gate skipped)',
               status in (401, 403, 503), 'HIGH')

        status, _ = http(server, '/api/user/preferences?token=' + token)
        record('E03-PRE-REQ-JWT_QUERY', 'REQ', 'authenticateToken ?token=', 'OSS',
               'bearer credentials must not be accepted from the URL query on non-SSE REST routes '
               '(URLs leak via logs, history, Referer)',
               f'GET /api/user/preferences?token=<jwt> -> HTTP {status}', status == 401, 'MEDIUM')

        status, _ = http(server, '/api/agent', 'POST', {})
        record('CTRL-OSS-AGENT-NO-KEY', 'CTRL', 'POST /api/agent', 'OSS',
               'no agent API key -> 401', f'HTTP {status}', status == 401)

        status, _ = http(server, '/api/browser-use-mcp/tools/browser_list_sessions', 'POST', {},
                         headers={'Authorization': 'Bearer wrong-token'})
        record('CTRL-OSS-BMCP-WRONG-TOKEN', 'CTRL', 'POST /api/browser-use-mcp/tools/*', 'OSS',
               'wrong MCP token -> 401', f'HTTP {status}', status == 401)

        status, payload = http(server, '/api/browser-use-mcp/tools/browser_list_sessions', 'POST', {},
                               headers={'Authorization': 'Bearer ' + SYNTHETIC_MCP_TOKEN})
        record('E03-PRE-REQ-BMCP_UNBOUND_TOKEN', 'REQ', 'POST /api/browser-use-mcp/tools/*', 'OSS',
               'a host-wide MCP token alone must not grant tool access; caller must resolve to a named '
               'service actor bound to principal/org with scope and revocation',
               f'MCP token without any user JWT -> HTTP {status}', status in (401, 403), 'HIGH',
               note='token seeded into the synthetic app_config table; real hosts generate it on MCP registration')

        for path in ['/ws', '/shell', '/plugin-ws/e03pre', '/desktop-notifications']:
            observed = ws_upgrade_status(server, path)
            record('CTRL-OSS-WS-NO-TOKEN' + path.replace('/', '_').upper(), 'CTRL', 'WS ' + path, 'OSS',
                   'upgrade without token -> rejected', observed, observed.startswith('REJECTED'))

        status, _ = http(server, '/api/assets/files/' + ASSET_NAME, headers=auth)
        record('CTRL-OSS-ASSET-JWT', 'CTRL', 'GET /api/assets/files/:name', 'OSS',
               'owner JWT can read its synthetic asset (proves the path used later is real)',
               f'HTTP {status}', status == 200)

        outside = fixture / 'outside-workspace'
        outside.mkdir(exist_ok=True)
        ws = ws_open(server, '/shell', token)
        try:
            executed, tail = shell_marker_run(ws, outside, 'PRE_OUTSIDE_OK')
        finally:
            ws.close()
        record('E03-PRE-REQ-PTY_WORKSPACE_SCOPE', 'REQ', 'WS /shell init projectPath', 'OSS',
               'PTY must only start inside a workspace the principal is authorized for '
               '(WORKSPACES_ROOT / resource ACL); the actor must be bound to the PTY',
               'plain shell executed outside WORKSPACES_ROOT' if executed else 'refused / no execution: ' + tail[-120:],
               not executed, 'HIGH')

        workspace = fixture / 'workspace'
        workspace.mkdir(exist_ok=True)
        ws = ws_open(server, '/shell', token)
        try:
            before, _ = shell_marker_run(ws, workspace, 'PRE_BEFORE_REVOKE', interactive=True)
            record('CTRL-OSS-PTY-BEFORE-REVOKE', 'CTRL', 'WS /shell input', 'OSS',
                   'active user PTY input executes (baseline for revocation)',
                   'executed' if before else 'not executed', before)
            set_active(fixture, False)
            status, _ = http(server, '/api/user/preferences', headers=auth)
            record('CTRL-OSS-HTTP-AFTER-DEACTIVATE', 'CTRL', 'GET /api/user/preferences', 'OSS',
                   'deactivated user JWT on new HTTP request -> 401', f'HTTP {status}', status == 401)
            observed = ws_upgrade_status(server, '/ws', token)
            record('CTRL-OSS-WS-NEW-AFTER-DEACTIVATE', 'CTRL', 'WS /ws upgrade', 'OSS',
                   'deactivated user cannot open a new WS', observed, observed.startswith('REJECTED'))
            after, _ = _input_only(ws, 'PRE_AFTER_REVOKE')
        finally:
            ws.close()
            set_active(fixture, True)
        record('E03-PRE-REQ-REVOKED_OPEN_PTY', 'REQ', 'WS /shell (already open)', 'OSS',
               'after the principal is deactivated/revoked, an already-open PTY must stop accepting input '
               '(terminate or reject) within a measured bound',
               'open PTY still executed input after deactivation' if after else 'input rejected / PTY ended',
               not after, 'CRITICAL')
    finally:
        server.stop()


def _input_only(ws, marker_suffix):
    command = f"printf 'E03%s\\n' {marker_suffix}"
    marker = 'E03' + marker_suffix
    try:
        ws.send_json({'type': 'input', 'data': command + '\n'})
    except OSError:
        return False, 'socket closed before send'
    output = ''.join(ws.collect_text(8, stop_marker=marker))
    return marker_seen(output, command, marker), output[-300:]


def phase_platform(fixture):
    server = Server(fixture, platform=True)
    server.start()
    try:
        status, _ = http(server, '/api/user/preferences')
        record('E03-PRE-REQ-PLATFORM_HTTP_FIRST_USER', 'REQ', 'authenticateToken (IS_PLATFORM)', 'PLATFORM',
               'enterprise mode must never map an unauthenticated request to the first active user',
               f'GET /api/user/preferences with no credential -> HTTP {status}', status == 401, 'CRITICAL')

        status, _ = http(server, '/api/user/preferences', headers={'Authorization': 'Bearer not-a-jwt'})
        record('E03-PRE-REQ-PLATFORM_FORGED_TOKEN', 'REQ', 'authenticateToken (IS_PLATFORM)', 'PLATFORM',
               'an invalid bearer token must be rejected',
               f'garbage bearer token -> HTTP {status}', status == 401, 'CRITICAL')

        status, payload = http(server, '/api/agent', 'POST', {})
        record('E03-PRE-REQ-PLATFORM_AGENT_API', 'REQ', 'POST /api/agent validateExternalApiKey', 'PLATFORM',
               'Agent API must require a principal-bound credential; no key -> 401 before any input handling',
               f'empty body, no key -> HTTP {status} {json.dumps(payload, ensure_ascii=False)[:90]} '
               '(400 = auth already passed; no agent was started because validation stops it)',
               status == 401, 'CRITICAL')

        status, _ = http(server, '/api/assets/files/' + ASSET_NAME)
        record('E03-PRE-REQ-PLATFORM_ASSET_BY_NAME', 'REQ', 'GET /api/assets/files/:name', 'PLATFORM',
               'stored assets must require an authenticated principal with access to the owning resource; '
               'knowing/guessing a filename must not be enough',
               f'no credential -> HTTP {status}', status in (401, 403, 404), 'HIGH')

        observed = ws_upgrade_status(server, '/ws')
        record('E03-PRE-REQ-PLATFORM_WS_FIRST_USER', 'REQ', 'WS /ws upgrade (IS_PLATFORM)', 'PLATFORM',
               'WS upgrade without credential must be rejected', observed, observed.startswith('REJECTED'),
               'CRITICAL')

        workspace = fixture / 'workspace'
        workspace.mkdir(exist_ok=True)
        try:
            ws = ws_open(server, '/shell')
        except UpgradeRejected as rejected:
            executed, observed = False, 'REJECTED ' + rejected.status_line
        else:
            try:
                executed, _ = shell_marker_run(ws, workspace, 'PRE_ANON_SHELL_OK')
            finally:
                ws.close()
            observed = 'anonymous WS /shell executed a command' if executed else 'upgrade accepted, no execution'
        record('E03-PRE-REQ-PLATFORM_ANON_SHELL', 'REQ', 'WS /shell (IS_PLATFORM)', 'PLATFORM',
               'no anonymous PTY/shell execution', observed, not executed, 'CRITICAL')
    finally:
        server.stop()


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: run_e03_pre.py <matrix-output.json>')
    output = Path(sys.argv[1]).resolve()
    if output.exists():
        raise SystemExit('refusing to overwrite existing evidence: ' + str(output))
    with tempfile.TemporaryDirectory(prefix='dhc-e03pre-') as temporary:
        fixture = Path(temporary)
        (fixture / 'home').mkdir()
        (fixture / 'workspace').mkdir()
        (fixture / 'dhc.config.json').write_text(json.dumps({
            'workspaceRoot': str(fixture / 'workspace'), 'mode': 'personal', 'agents': ['claude', 'codex'],
            'remote': {'enabled': False}, 'domain': 'general'}))
        error = None
        try:
            phase_oss(fixture)
            phase_platform(fixture)
        except Exception as exc:  # 環境錯誤要如實輸出，不轉成 PASS
            error = f'{type(exc).__name__}: {exc}'
        logs = {}
        for name in ['server-oss.txt', 'server-platform.txt']:
            path = fixture / name
            if path.exists():
                logs[name] = path.read_text(errors='replace').replace(str(fixture), '<FIXTURE>')
    not_run = [{
        'id': 'E03-PRE-REQ-REVOKED_BACKGROUND_RUN', 'kind': 'REQ', 'verdict': 'NOT_RUN',
        'entry': 'scheduled-messages / night-queue / chat run resume',
        'requirement': 'a background run created before revocation must re-check the principal before each step',
        'reason': 'needs a real provider CLI/model execution; out of scope for synthetic no-model E03-PRE. '
                  'Static reference only: server/modules/scheduled-messages, night-queue dispatchers run under the '
                  'single SQLite owner.'}, {
        'id': 'E03-PRE-REQ-AGENT_KEY_QUERY', 'kind': 'REQ', 'verdict': 'NOT_RUN',
        'entry': 'POST /api/agent ?apiKey=',
        'requirement': 'agent API key must not be accepted from the URL query',
        'reason': 'requires creating a real agent API key through the UI flow; static evidence: '
                  'server/modules/agent/agent.routes.ts validateExternalApiKey reads req.query.apiKey'}, {
        'id': 'E03-PRE-REQ-DAS_WORKER_COOKIE', 'kind': 'REQ', 'verdict': 'NOT_APPLICABLE',
        'entry': 'DAS V3.1 web-ops/worker cookie gate',
        'requirement': 'shared-password edge gate must not substitute per-user identity',
        'reason': 'DAS self-authored code is LICENSE_BLOCKED and must not be executed (05 contract); '
                  'read-only finding recorded in the handoff instead'}]
    req = [r for r in results if r['kind'] == 'REQ']
    ctrl = [r for r in results if r['kind'] == 'CTRL']
    summary = {
        'req_total_run': len(req), 'req_red': sum(r['verdict'] == 'RED' for r in req),
        'req_green': sum(r['verdict'] == 'GREEN' for r in req), 'ctrl_total': len(ctrl),
        'ctrl_fail': sum(r['verdict'] == 'FAIL' for r in ctrl), 'not_run': len(not_run), 'harness_error': error}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({'schema_version': 1, 'slice_id': 'E03-PRE', 'summary': summary,
                                  'cases': results + not_run}, ensure_ascii=False, indent=2) + '\n')
    log_dir = output.parent / (output.stem + '-server-logs')
    log_dir.mkdir(exist_ok=False)
    for name, text in logs.items():
        (log_dir / name).write_text(text)
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    if error or summary['ctrl_fail']:
        return 2
    return 1 if summary['req_red'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
