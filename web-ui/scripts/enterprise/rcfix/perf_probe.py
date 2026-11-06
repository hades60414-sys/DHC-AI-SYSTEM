"""效能基線探針（只讀與小量合成寫入）：對執行中的實例量測主要 API 的延遲 p50／p95 與 Run（mock）完成時間。

用法：DHC_PERF_PASSWORD=… python3 -B scripts/enterprise/rcfix/perf_probe.py <base-url> <org-slug> <email> <輸出 JSON> [次數]
這不是負載測試：單一用戶端、序列請求，用來建立回歸基線並發現明顯退化。
"""
import json
import os
import statistics
import sys
import time
import urllib.request


def call(base, method, path, token=None, body=None, raw=None, headers=None):
    request_headers = dict(headers or {})
    if token:
        request_headers['Authorization'] = 'Bearer ' + token
    data = raw
    if body is not None:
        request_headers['Content-Type'] = 'application/json'
        data = json.dumps(body).encode()
    started = time.perf_counter()
    with urllib.request.urlopen(urllib.request.Request(base + path, method=method, data=data, headers=request_headers), timeout=60) as response:
        payload = response.read()
        status = response.status
    return status, (time.perf_counter() - started) * 1000, json.loads(payload) if payload[:1] in (b'{', b'[') else payload


def summary(samples):
    ordered = sorted(samples)
    return {'n': len(ordered), 'p50_ms': round(statistics.median(ordered), 1), 'p95_ms': round(ordered[max(0, int(len(ordered) * 0.95) - 1)], 1), 'max_ms': round(ordered[-1], 1)}


def main():
    base, slug, email, output = sys.argv[1:5]
    n = int(sys.argv[5]) if len(sys.argv) > 5 else 20
    password = os.environ['DHC_PERF_PASSWORD']
    results, samples = {}, {name: [] for name in ['login', 'identity', 'documents_list', 'search', 'upload_1kb', 'run_to_completion']}
    token = None
    for _ in range(n):
        _, ms, payload = call(base, 'POST', '/api/enterprise/v1/auth/login', body={'organizationSlug': slug, 'email': email, 'password': password})
        samples['login'].append(ms)
        token = payload['token']
        samples['identity'].append(call(base, 'GET', '/api/enterprise/v1/identity/me', token)[1])
        samples['documents_list'].append(call(base, 'GET', '/api/enterprise/v1/documents?limit=50', token)[1])
        samples['search'].append(call(base, 'GET', '/api/enterprise/v1/documents/search?q=' + urllib.request.quote('交付期限'), token)[1])
    for index in range(n):
        samples['upload_1kb'].append(call(base, 'POST', '/api/enterprise/v1/documents', token, raw=('效能 基線 交付期限 ' * 60 + str(index)).encode(),
                                          headers={'Content-Type': 'text/plain', 'x-dhc-title': 'perf', 'x-dhc-filename': 'perf.txt'})[1])
    for index in range(min(n, 10)):
        _, _, created = call(base, 'POST', '/api/enterprise/v1/runs/draft-generation', token, body={'title': 'perf', 'query': '交付期限', 'providerKey': 'offline'},
                             headers={'idempotency-key': f'perf-{int(time.time())}-{index:04d}'})
        started = time.perf_counter()
        while True:
            run = call(base, 'GET', f"/api/enterprise/v1/runs/{created['run']['id']}", token)[2]
            if run['status'] not in ('queued', 'running'):
                break
            time.sleep(0.2)
        samples['run_to_completion'].append((time.perf_counter() - started) * 1000)
    results = {name: summary(values) for name, values in samples.items() if values}
    json.dump({'base': base, 'note': '單一用戶端序列請求；QA VM 2 vCPU／4 GiB；mock 模型', 'results': results}, open(output, 'w'), ensure_ascii=False, indent=1)
    print(json.dumps(results, ensure_ascii=False))


if __name__ == '__main__':
    main()
