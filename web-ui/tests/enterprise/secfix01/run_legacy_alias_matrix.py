"""SEC-FIX-01 / ASTRA-001：企業模式 legacy 入口別名負向矩陣（真實伺服器行程、合成資料、PG 刻意不可連線）。

用法（repo 根目錄）：
    python3 -B tests/enterprise/secfix01/run_legacy_alias_matrix.py <matrix-output.json>

legacy mount 清單直接由 server/index.ts 的 `app.use('/api/...'` 解析，避免人工漏列。每個 mount 測：
  路徑變體：原樣、全大寫、首字大寫、百分比編碼首字元、重複斜線、結尾斜線
  方法：GET POST PUT PATCH DELETE OPTIONS HEAD
  憑證：無、合成舊 JWT（Bearer 與 ?token=）、合成 legacy API key、合成 Browser MCP token
判定：企業模式下任何 legacy 別名請求回 2xx/3xx 即 RED（FAIL）；只有 403/404/405/400 視為封閉。
對照組（CTRL）：/api/enterprise/v1/identity/me 無 token 401（證明企業路由存在且仍要身分）、根路徑導向 /office。
Exit：0＝全部封閉；1＝有繞過；2＝對照組失敗或環境錯誤。
"""
import base64
import hashlib
import hmac
import json
import re
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tests/enterprise/e03_pre'))
import run_e03_pre as base  # noqa: E402

JWT_SECRET = 'e03pre-synthetic-jwt-secret-not-for-production'  # 與 E03-PRE Server.env 相同的合成值
API_KEY = 'ck_synthetic_secfix01_' + '0' * 40
METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']


def legacy_mounts():
    source = (ROOT / 'server/index.ts').read_text()
    mounts = sorted(set(re.findall(r"app\.use\('(/api(?:/[a-z0-9-]+)?)'", source)) - {'/api/enterprise/v1'})
    if len(mounts) < 20:
        raise RuntimeError(f'parsed only {len(mounts)} legacy mounts; parser out of date')
    return mounts


def variants(path):
    first = path[1]
    return {
        'original': path,
        'upper': path.upper(),
        'capitalized': '/' + path[1:].capitalize(),
        'percent_encoded': '/%' + format(ord(first), '02X') + path[2:],
        'double_slash': '/' + path,
        'trailing_slash': path + '/',
    }


def jwt(user_id, username):
    header = base64.urlsafe_b64encode(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode()).rstrip(b'=')
    now = int(time.time())
    payload = base64.urlsafe_b64encode(json.dumps({'userId': user_id, 'username': username, 'iat': now, 'exp': now + 3600}).encode()).rstrip(b'=')
    signature = base64.urlsafe_b64encode(hmac.new(JWT_SECRET.encode(), header + b'.' + payload, hashlib.sha256).digest()).rstrip(b'=')
    return (header + b'.' + payload + b'.' + signature).decode()


class EnterpriseServer(base.Server):
    def env(self):
        env = super().env()
        env.update(DHC_DEPLOYMENT_MODE='enterprise', ENTERPRISE_DB_HOST='127.0.0.1', ENTERPRISE_DB_PORT='65534',
                   ENTERPRISE_DB_NAME='dhc_e02a_qa_0badcafe', ENTERPRISE_DB_PASSWORD='synthetic-unused', ENTERPRISE_DB_USER='dhc_app',
                   ENTERPRISE_BLOB_ROOT=str(self.fixture / 'blobs'), ENTERPRISE_RUN_WORKER='off', JWT_SECRET=JWT_SECRET)
        return env


def raw_request(server, method, path, headers):
    """用 http.client 送出原樣路徑（urllib 會正規化部分路徑）。"""
    import http.client
    connection = http.client.HTTPConnection('127.0.0.1', server.port, timeout=15)
    try:
        connection.request(method, path, body=b'{}' if method in ('POST', 'PUT', 'PATCH') else None,
                           headers={'Content-Type': 'application/json', **headers})
        response = connection.getresponse()
        body = response.read(300)
        return response.status, body
    finally:
        connection.close()


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: run_legacy_alias_matrix.py <matrix-output.json>')
    output = Path(sys.argv[1]).resolve()
    if output.exists():
        raise SystemExit('refusing to overwrite existing evidence')
    cases, controls, error = [], [], None
    mounts = legacy_mounts()
    with tempfile.TemporaryDirectory(prefix='dhc-secfix01-') as temporary:
        fixture = Path(temporary)
        for name in ['home', 'workspace', 'blobs']:
            (fixture / name).mkdir()
        (fixture / 'blobs').chmod(0o700)
        (fixture / 'dhc.config.json').write_text(json.dumps({'workspaceRoot': str(fixture / 'workspace'), 'mode': 'personal', 'agents': [],
                                                            'remote': {'enabled': False}, 'domain': 'general'}))
        server = EnterpriseServer(fixture, False)
        try:
            server.start()
            # 合成舊帳號、API key、MCP token、資產：模擬「升級前留下的 personal 資料」
            with sqlite3.connect(fixture / 'auth.db') as db:
                db.execute("INSERT INTO users (username, password_hash) VALUES ('legacy-user', 'x')")
                user_id = db.execute("SELECT id FROM users WHERE username='legacy-user'").fetchone()[0]
                db.execute("INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, 'synthetic', ?)", (user_id, API_KEY))
            base.seed(fixture)
            token = jwt(user_id, 'legacy-user')
            credentials = {
                'none': ({}, ''),
                'legacy_jwt_bearer': ({'Authorization': 'Bearer ' + token}, ''),
                'legacy_jwt_query': ({}, '?token=' + token),
                'legacy_api_key': ({'x-api-key': API_KEY}, ''),
                'browser_mcp_token': ({'Authorization': 'Bearer ' + base.SYNTHETIC_MCP_TOKEN}, ''),
            }
            status, _ = raw_request(server, 'GET', '/api/enterprise/v1/identity/me', {})
            controls.append({'id': 'CTRL-ENTERPRISE-ROUTE-REQUIRES-AUTH', 'observed': status, 'pass': status == 401})
            status, _ = raw_request(server, 'GET', '/', {})
            controls.append({'id': 'CTRL-ROOT-REDIRECTS-OFFICE', 'observed': status, 'pass': status == 302})
            targets = {mount: [mount + suffix for suffix in ['', '/status', '/files/' + base.ASSET_NAME, '/preferences', '/tools/browser_list_sessions']] for mount in mounts}
            for mount, paths in targets.items():
                for target in paths:
                    for variant, path in variants(target).items():
                        for credential, (headers, query) in credentials.items():
                            methods = METHODS if credential in ('none', 'legacy_jwt_bearer') else ['GET', 'POST']
                            for method in methods:
                                code, body = raw_request(server, method, path + query, headers)
                                closed = code in (400, 403, 404, 405)
                                cases.append({'mount': mount, 'path': path, 'variant': variant, 'credential': credential, 'method': method,
                                              'status': code, 'verdict': 'CLOSED' if closed else 'BYPASS',
                                              'body_head': body[:120].decode(errors='replace') if not closed else ''})
        except Exception as exc:
            error = f'{type(exc).__name__}: {exc}'
        finally:
            server.stop()
            log = server.log.read_text(errors='replace').replace(str(fixture), '<FIXTURE>') if server.log.exists() else ''
    bypass = [case for case in cases if case['verdict'] == 'BYPASS']
    summary = {'legacy_mounts': len(mounts), 'requests': len(cases), 'bypass': len(bypass), 'closed': len(cases) - len(bypass),
               'controls_pass': sum(c['pass'] for c in controls), 'controls_total': len(controls), 'harness_error': error,
               'bypass_by_variant': {v: sum(1 for c in bypass if c['variant'] == v) for v in ['original', 'upper', 'capitalized', 'percent_encoded', 'double_slash', 'trailing_slash']}}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({'schema_version': 1, 'finding': 'ASTRA-001', 'summary': summary, 'mounts': mounts, 'controls': controls,
                                  'bypass_samples': bypass[:60], 'cases': cases}, ensure_ascii=False, indent=1) + '\n')
    (output.parent / (output.stem + '-server.log')).write_text(log)
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    if error or not all(c['pass'] for c in controls):
        return 2
    return 1 if bypass else 0


if __name__ == '__main__':
    raise SystemExit(main())
