"""SEC-01：E03-PRE 11 個企業安全要求的修補驗證矩陣（真實伺服器行程、真 PostgreSQL、合成資料）。

用法（repo 根目錄，由 scripts/enterprise/驗證文件版本.py 在 QA DB 內呼叫，或自行提供 E02A_TEST_* 環境變數）：
    python3 -B tests/enterprise/sec01/run_sec01.py <matrix-output.json>

沿用 E03-PRE harness（tests/enterprise/e03_pre，來源 commit 91e05b0）的 Server／HTTP／WS 工具，只 import、不修改。
每個 E03-PRE REQ 依其目標模式重新判定：
  GREEN               需求在目標模式成立
  RED                 仍不成立（會使本程式 exit 1）
  RESIDUAL_PERSONAL   只在 personal（單人本機）模式保留的既有行為，企業模式已封閉；列入發行說明，不算 GREEN
CTRL 對照組任何失敗 → exit 2（harness 無效）。

副作用邊界：Shell 只執行 printf 標記；Agent API 只送空 body（輸入驗證即停止）；不呼叫模型或外部網路。
"""
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/enterprise/e03_pre'))
import run_e03_pre as base  # noqa: E402
from ws_client import UpgradeRejected, WebSocket  # noqa: E402

ADMIN_PASSWORD = 'Sec01-synthetic-' + secrets.token_hex(6)
results = []


def record(case_id, kind, mode, requirement, observed, verdict, source=None):
    row = dict(id=case_id, kind=kind, mode=mode, requirement=requirement, observed=observed, verdict=verdict)
    if source:
        row['e03_pre_source'] = source
    results.append(row)
    print(f'[{verdict}] {case_id} ({mode}) :: {observed}', flush=True)


def req(case_id, mode, requirement, observed, ok, source=None, residual=False):
    record(case_id, 'REQ', mode, requirement, observed, 'GREEN' if ok else ('RESIDUAL_PERSONAL' if residual else 'RED'), source)


def ctrl(case_id, mode, requirement, observed, ok):
    record(case_id, 'CTRL', mode, requirement, observed, 'PASS' if ok else 'FAIL')


class ModeServer(base.Server):
    """在 E03-PRE Server 之上加入額外環境變數（部署模式、企業 DB、platform opt-in）。"""

    def __init__(self, fixture, platform, extra, label):
        super().__init__(fixture, platform)
        self.extra = extra
        self.log = fixture / f'server-{label}.txt'

    def env(self):
        env = super().env()
        env.update(self.extra)
        return env

    def start_expect_refusal(self, seconds=60):
        """行程必須在不提供服務的情況下自行結束（非 0）；回傳 (refused, exit_code)。"""
        command = [str(ROOT / 'node_modules/.bin/tsx'), '--tsconfig', 'server/tsconfig.json', 'server/index.ts']
        self.process = subprocess.Popen(command, cwd=ROOT, env=self.env(), stdout=self.log.open('a'), stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            code = self.process.poll()
            if code is not None:
                return code != 0, code
            try:
                if base.http(self, '/health')[0] == 200:
                    return False, 'SERVING'
            except (urllib.error.URLError, ConnectionError, OSError):
                pass
            time.sleep(0.2)
        return False, 'TIMEOUT'


def bearer(token):
    return {'Authorization': 'Bearer ' + token}


def ws_status(server, path, token=None):
    return base.ws_upgrade_status(server, path, token)


def enterprise_env(fixture):
    return dict(DHC_DEPLOYMENT_MODE='enterprise', ENTERPRISE_DB_HOST='127.0.0.1', ENTERPRISE_DB_PORT=os.environ['E02A_TEST_PORT'],
                ENTERPRISE_DB_NAME=os.environ['E02A_TEST_DATABASE'], ENTERPRISE_DB_USER='dhc_app',
                ENTERPRISE_DB_PASSWORD=os.environ['E02A_TEST_APP_PASSWORD'], ENTERPRISE_BLOB_ROOT=str(fixture / 'blobs'))


def phase_enterprise(fixture):
    prepared = subprocess.run([str(ROOT / 'node_modules/.bin/tsx'), '--tsconfig', 'server/tsconfig.json', 'tests/enterprise/sec01/prepare_enterprise_db.ts'],
                              cwd=ROOT, env={**os.environ, 'SEC01_ADMIN_PASSWORD': ADMIN_PASSWORD}, capture_output=True, text=True)
    if prepared.returncode:
        raise RuntimeError('enterprise DB prepare failed: ' + prepared.stdout[-500:] + prepared.stderr[-1500:])

    refused = ModeServer(fixture, True, enterprise_env(fixture), 'enterprise-platform')
    ok, code = refused.start_expect_refusal()
    refused.stop()
    req('SEC01-PLATFORM_FIRST_USER', 'ENTERPRISE+VITE_IS_PLATFORM', 'enterprise mode must never map requests to the first user',
        f'server refused to start (exit {code})' if ok else f'server state: {code}', ok,
        'E03-PRE-REQ-PLATFORM_HTTP_FIRST_USER / FORGED_TOKEN / AGENT_API / WS_FIRST_USER / ANON_SHELL / ASSET_BY_NAME')

    server = ModeServer(fixture, False, enterprise_env(fixture), 'enterprise')
    server.start()
    try:
        status, payload = base.http(server, '/api/enterprise/v1/auth/login', 'POST',
                                    {'organizationSlug': 'sec01', 'email': 'admin@sec01.example.invalid', 'password': ADMIN_PASSWORD})
        admin_token = (payload or {}).get('token', '')
        ctrl('CTRL-ENT-LOGIN', 'ENTERPRISE', 'bootstrapped admin can log in', f'HTTP {status}', status == 200 and admin_token.startswith('dhcs1.'))
        status, _ = base.http(server, '/api/enterprise/v1/identity/me', headers=bearer(admin_token))
        ctrl('CTRL-ENT-ME', 'ENTERPRISE', 'valid bearer -> 200 (harness reaches real auth)', f'HTTP {status}', status == 200)

        status, _ = base.http(server, '/api/enterprise/v1/identity/me')
        req('SEC01-HTTP_NO_CREDENTIAL', 'ENTERPRISE', 'no credential -> 401', f'HTTP {status}', status == 401, 'E03-PRE-REQ-PLATFORM_HTTP_FIRST_USER')
        status, _ = base.http(server, '/api/enterprise/v1/identity/me', headers=bearer('not-a-jwt'))
        req('SEC01-FORGED_TOKEN', 'ENTERPRISE', 'forged bearer -> 401', f'HTTP {status}', status == 401, 'E03-PRE-REQ-PLATFORM_FORGED_TOKEN')
        status, _ = base.http(server, '/api/user/preferences')
        status_auth, _ = base.http(server, '/api/user/preferences', headers=bearer(admin_token))
        req('SEC01-LEGACY_REST_DISABLED', 'ENTERPRISE', 'legacy REST unreachable with or without enterprise token',
            f'no token HTTP {status}; enterprise token HTTP {status_auth}', status == 403 and status_auth == 403, 'E03-PRE-REQ-PLATFORM_HTTP_FIRST_USER')
        status, _ = base.http(server, '/api/agent', 'POST', {})
        req('SEC01-AGENT_API', 'ENTERPRISE', 'Agent API must not run without a principal-bound credential; legacy agent disabled',
            f'POST /api/agent -> HTTP {status}', status == 403, 'E03-PRE-REQ-PLATFORM_AGENT_API')
        status, _ = base.http(server, '/api/auth/status')
        status_reg, _ = base.http(server, '/api/auth/register', 'POST', base.ACCOUNT)
        req('SEC01-API_KEY_MISSING', 'ENTERPRISE(API_KEY unset)', 'missing legacy gate secret must not open any legacy entry',
            f'/api/auth/status HTTP {status}; /api/auth/register HTTP {status_reg}', status == 403 and status_reg == 403, 'E03-PRE-REQ-API_KEY_MISSING')
        status, _ = base.http(server, '/api/enterprise/v1/identity/me?access_token=' + admin_token, headers=bearer(admin_token))
        req('SEC01-TOKEN_IN_URL', 'ENTERPRISE', 'credentials in URL query are refused', f'HTTP {status}', status == 400, 'E03-PRE-REQ-JWT_QUERY')

        with sqlite3.connect(fixture / 'auth.db') as db:
            db.execute('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)', ('browser_use_mcp_token', base.SYNTHETIC_MCP_TOKEN))
        status, _ = base.http(server, '/api/browser-use-mcp/tools/browser_list_sessions', 'POST', {}, headers=bearer(base.SYNTHETIC_MCP_TOKEN))
        req('SEC01-BMCP_UNBOUND_TOKEN', 'ENTERPRISE', 'host-wide MCP token grants nothing', f'HTTP {status}', status == 403, 'E03-PRE-REQ-BMCP_UNBOUND_TOKEN')

        assets = fixture / 'home' / '.cloudcli' / 'assets'
        assets.mkdir(parents=True, exist_ok=True)
        (assets / base.ASSET_NAME).write_bytes(base.ASSET_BODY)
        get_status, _ = base.http(server, '/api/assets/files/' + base.ASSET_NAME)
        post_status, _ = base.http(server, '/api/assets/files', 'POST', {}, headers={'Content-Type': 'multipart/form-data; boundary=x'})
        req('SEC01-ASSET_AND_EDGE_EXCEPTION', 'ENTERPRISE', 'asset read-by-filename and cookie-less upload paths (DAS edge exceptions) are closed',
            f'GET by name HTTP {get_status}; POST upload HTTP {post_status}', get_status == 403 and post_status == 403,
            'E03-PRE-REQ-PLATFORM_ASSET_BY_NAME + DAS gate.mjs exemptions (independent equivalent)')

        ws = {path: (ws_status(server, path), ws_status(server, path, admin_token)) for path in ['/ws', '/shell', '/plugin-ws/x', '/desktop-notifications']}
        ok = all(a.startswith('REJECTED') and b.startswith('REJECTED') for a, b in ws.values())
        req('SEC01-LEGACY_WS_AND_PTY', 'ENTERPRISE', 'no legacy WS/PTY channel for any caller', json.dumps(ws), ok,
            'E03-PRE-REQ-PLATFORM_WS_FIRST_USER / PLATFORM_ANON_SHELL / PTY_WORKSPACE_SCOPE')

        status, created = base.http(server, '/api/enterprise/v1/members', 'POST',
                                    {'email': 'staff@sec01.example.invalid', 'password': ADMIN_PASSWORD, 'roles': ['employee']}, headers=bearer(admin_token))
        member_id = (created or {}).get('id', '')
        _, staff = base.http(server, '/api/enterprise/v1/auth/login', 'POST',
                             {'organizationSlug': 'sec01', 'email': 'staff@sec01.example.invalid', 'password': ADMIN_PASSWORD})
        staff_token = (staff or {}).get('token', '')
        before, _ = base.http(server, '/api/enterprise/v1/documents', headers=bearer(staff_token))
        ctrl('CTRL-ENT-STAFF-BEFORE', 'ENTERPRISE', 'employee session works before revocation', f'create HTTP {status}; list HTTP {before}', status == 201 and before == 200)
        base.http(server, f'/api/enterprise/v1/members/{member_id}/disable', 'POST', {}, headers=bearer(admin_token))
        after, _ = base.http(server, '/api/enterprise/v1/documents', headers=bearer(staff_token))
        req('SEC01-REVOKED_SESSION', 'ENTERPRISE', 'an already-issued session stops working on the next request after disable',
            f'after disable HTTP {after}', after == 401, 'E03-PRE-REQ-REVOKED_OPEN_PTY (enterprise equivalent: no PTY exists)')

        status, _ = base.http(server, '/api/scheduled-messages', 'POST', {}, headers=bearer(admin_token))
        log = server.log.read_text(errors='replace')
        disabled = 'legacy background dispatchers and plugin servers are disabled' in log
        req('SEC01-BACKGROUND_RUN', 'ENTERPRISE', 'no owner-privileged background runs; legacy schedulers unreachable',
            f'scheduled-messages HTTP {status}; dispatcher-disabled log={disabled}', status == 403 and disabled, 'E03-PRE-REQ-REVOKED_BACKGROUND_RUN')
    finally:
        server.stop()


def personal_env():
    return dict(DHC_DEPLOYMENT_MODE='personal')


def phase_personal(fixture):
    refused = ModeServer(fixture, True, personal_env(), 'personal-platform-no-optin')
    ok, code = refused.start_expect_refusal()
    refused.stop()
    req('SEC01-PERSONAL_PLATFORM_WITHOUT_OPTIN', 'PERSONAL+VITE_IS_PLATFORM', 'platform first-user mode needs explicit loopback opt-in',
        f'server refused to start (exit {code})' if ok else f'server state: {code}', ok, 'E03-PRE PLATFORM_* cases')

    server = ModeServer(fixture, False, personal_env(), 'personal')
    server.start()
    try:
        status, _ = base.http(server, '/api/user/preferences')
        ctrl('CTRL-OSS-HTTP-NO-TOKEN', 'PERSONAL', 'no credential -> 401', f'HTTP {status}', status == 401)
        status, payload = base.http(server, '/api/auth/register', 'POST', base.ACCOUNT)
        token = (payload or {}).get('token', '')
        ctrl('CTRL-OSS-REGISTER', 'PERSONAL', 'first synthetic account', f'HTTP {status}', status == 200 and bool(token))
        status, _ = base.http(server, '/api/user/preferences', headers=bearer(token))
        ctrl('CTRL-OSS-HTTP-JWT', 'PERSONAL', 'valid bearer -> 200', f'HTTP {status}', status == 200)
        status, _ = base.http(server, '/api/providers/search/sessions?q=x&token=' + token)
        ctrl('CTRL-OSS-SSE-QUERY-TOKEN', 'PERSONAL', 'documented SSE endpoint still accepts query token (EventSource compatibility)',
             f'HTTP {status}', status != 401)
        status, _ = base.http(server, '/api/user/preferences?token=' + token)
        req('SEC01-JWT_QUERY', 'PERSONAL', 'non-SSE REST must reject query JWT', f'HTTP {status}', status == 401, 'E03-PRE-REQ-JWT_QUERY')

        status, payload = base.http(server, '/api/settings/api-keys', 'POST', {'keyName': 'sec01'}, headers=bearer(token))
        api_key = ''
        stack = [payload]
        while stack:
            item = stack.pop()
            if isinstance(item, dict):
                if isinstance(item.get('apiKey'), str):
                    api_key = item['apiKey']
                stack.extend(item.values())
        query_status, _ = base.http(server, '/api/agent?apiKey=' + api_key, 'POST', {})
        header_status, _ = base.http(server, '/api/agent', 'POST', {}, headers={'x-api-key': api_key})
        ctrl('CTRL-OSS-AGENT-KEY-HEADER', 'PERSONAL', 'agent key in header passes auth (400 = input validation, no agent started)',
             f'create HTTP {status}; header HTTP {header_status}', bool(api_key) and header_status == 400)
        req('SEC01-AGENT_KEY_QUERY', 'PERSONAL', 'agent API key must not be accepted from URL query', f'HTTP {query_status}', query_status == 401,
            'E03-PRE-REQ-AGENT_KEY_QUERY (was NOT_RUN)')

        for path in ['/ws', '/shell', '/plugin-ws/e03pre', '/desktop-notifications']:
            observed = ws_status(server, path)
            ctrl('CTRL-OSS-WS-NO-TOKEN' + path.replace('/', '_').upper(), 'PERSONAL', 'upgrade without token rejected', observed, observed.startswith('REJECTED'))

        outside = fixture / 'outside-workspace'
        outside.mkdir(exist_ok=True)
        ws = base.ws_open(server, '/shell', token)
        try:
            executed, _ = base.shell_marker_run(ws, outside, 'SEC_OUTSIDE')
        finally:
            ws.close()
        req('SEC01-PTY_WORKSPACE_SCOPE', 'PERSONAL', 'PTY only inside WORKSPACES_ROOT', 'executed outside' if executed else 'refused', not executed,
            'E03-PRE-REQ-PTY_WORKSPACE_SCOPE')

        workspace = fixture / 'workspace'
        ws = base.ws_open(server, '/shell', token)
        try:
            before, _ = base.shell_marker_run(ws, workspace, 'SEC_BEFORE', interactive=True)
            ctrl('CTRL-OSS-PTY-BEFORE-REVOKE', 'PERSONAL', 'active user PTY executes', 'executed' if before else 'not executed', before)
            base.set_active(fixture, False)
            after, _ = base._input_only(ws, 'SEC_AFTER')
        finally:
            ws.close()
            base.set_active(fixture, True)
        req('SEC01-REVOKED_OPEN_PTY', 'PERSONAL', 'open PTY stops after the user is deactivated',
            'still executed' if after else 'input refused / PTY terminated', not after, 'E03-PRE-REQ-REVOKED_OPEN_PTY')

        with sqlite3.connect(fixture / 'auth.db') as db:
            db.execute('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)', ('browser_use_mcp_token', base.SYNTHETIC_MCP_TOKEN))
        status, _ = base.http(server, '/api/browser-use-mcp/tools/browser_list_sessions', 'POST', {}, headers=bearer(base.SYNTHETIC_MCP_TOKEN))
        req('SEC01-PERSONAL_BMCP_TOKEN', 'PERSONAL', 'host-local MCP token (single-user personal mode)', f'HTTP {status}', status in (401, 403),
            'E03-PRE-REQ-BMCP_UNBOUND_TOKEN', residual=True)
        status, _ = base.http(server, '/api/auth/status')
        req('SEC01-PERSONAL_API_KEY_OPTIONAL', 'PERSONAL', 'optional legacy API_KEY gate (single-user personal mode)', f'HTTP {status}',
            status in (401, 403, 503), 'E03-PRE-REQ-API_KEY_MISSING', residual=True)
    finally:
        server.stop()

    optin = ModeServer(fixture, True, dict(DHC_DEPLOYMENT_MODE='personal', DHC_ALLOW_PLATFORM_FIRST_USER='loopback-only'), 'personal-platform-optin')
    optin.start()
    try:
        status, _ = base.http(optin, '/api/user/preferences')
        req('SEC01-PERSONAL_PLATFORM_OPTIN', 'PERSONAL+PLATFORM(opt-in, loopback)', 'explicit single-user loopback platform mode',
            f'anonymous HTTP {status}', status == 401, 'E03-PRE PLATFORM_* cases', residual=True)
    finally:
        optin.stop()


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: run_sec01.py <matrix-output.json>')
    output = Path(sys.argv[1]).resolve()
    if output.exists():
        raise SystemExit('refusing to overwrite existing evidence: ' + str(output))
    for key in ['E02A_TEST_DATABASE', 'E02A_TEST_PORT', 'E02A_TEST_APP_PASSWORD', 'E02A_TEST_MIGRATOR_PASSWORD', 'E02A_TEST_ADMIN_PASSWORD']:
        if not os.environ.get(key):
            raise SystemExit('missing ' + key)
    error = None
    logs = {}
    with tempfile.TemporaryDirectory(prefix='dhc-sec01-') as temporary:
        fixture = Path(temporary)
        for name in ['home', 'workspace', 'blobs']:
            (fixture / name).mkdir()
        os.chmod(fixture / 'blobs', 0o700)
        (fixture / 'dhc.config.json').write_text(json.dumps({'workspaceRoot': str(fixture / 'workspace'), 'mode': 'personal',
                                                            'agents': ['claude'], 'remote': {'enabled': False}, 'domain': 'general'}))
        try:
            phase_enterprise(fixture)
            phase_personal(fixture)
        except Exception as exc:
            error = f'{type(exc).__name__}: {exc}'
        for path in fixture.glob('server-*.txt'):
            logs[path.name] = path.read_text(errors='replace').replace(str(fixture), '<FIXTURE>').replace(ADMIN_PASSWORD, '<REDACTED>')
    summary = {
        'req_green': sum(r['verdict'] == 'GREEN' for r in results), 'req_red': sum(r['verdict'] == 'RED' for r in results),
        'req_residual_personal': sum(r['verdict'] == 'RESIDUAL_PERSONAL' for r in results),
        'ctrl_pass': sum(r['verdict'] == 'PASS' for r in results), 'ctrl_fail': sum(r['verdict'] == 'FAIL' for r in results), 'harness_error': error}
    output.write_text(json.dumps({'schema_version': 1, 'slice_id': 'SEC-01', 'summary': summary, 'cases': results}, ensure_ascii=False, indent=2) + '\n')
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
