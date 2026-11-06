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


OPS_HEADER = '資料標記,案例集,紀錄ID,週別,期間起,期間迄,據點ID,據點名稱,週受理件數,週完成件數,準時完成件數,週末待辦件數,作業分鐘,資料owner,快照ID'
LEDGER_HEADER = '資料列ID,組織ID,單據ID,單據日期,客戶代碼,幣別,最小單位小數位數,應收金額_最小單位,摘要'
RECEIPT_HEADER = '資料列ID,組織ID,收款ID,收款日期,對應單據ID,客戶代碼,幣別,最小單位小數位數,收款金額_最小單位,摘要'


def ops_csv(prefix, rows):
    """V5.1：合成營運明細（W42／W43 交錯，每兩列一個據點）。"""
    lines = [OPS_HEADER]
    for i in range(rows):
        current = i % 2 == 1
        week, start, end = ('2026-W43', '2026-10-19', '2026-10-25') if current else ('2026-W42', '2026-10-12', '2026-10-18')
        lines.append(f'SYNTHETIC,BASE,{prefix}{i},{week},{start},{end},{prefix}S{i // 2},site,10,9,8,4,60,OWNER,SNAP')
    return ('\n'.join(lines) + '\n').encode()


def acc_csv(rows):
    """V5.1：合成內部帳／收款明細（多數完全匹配，少量差異與缺收款）。"""
    ledger, receipts = [LEDGER_HEADER], [RECEIPT_HEADER]
    for i in range(1, rows + 1):
        day = f'{1 + i % 28:02d}'
        amount = 1000 + (i % 997) * 100
        ledger.append(f'L{i},SYN-ORG,D{i},2026-10-{day},C{i % 300},TWD,2,{amount},synthetic')
        if i % 97:
            receipts.append(f'R{i},SYN-ORG,P{i},2026-10-{day},D{i},C{i % 300},TWD,2,{amount - 100 if i % 50 == 0 else amount},synthetic')
    return ('\n'.join(ledger) + '\n').encode(), ('\n'.join(receipts) + '\n').encode()


def upload_csv(base, token, title, content):
    status, _, created = call(base, 'POST', '/api/enterprise/v1/documents', token, raw=content, headers={'Content-Type': 'text/csv', 'x-dhc-title': title, 'x-dhc-filename': title + '.csv'})
    document_id = created.get('document', {}).get('id') or created.get('id')
    versions = call(base, 'GET', f'/api/enterprise/v1/documents/{document_id}/versions', token)[2]['items']
    return {'documentId': document_id, 'versionNumber': versions[0]['versionNumber']}


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
    # V5.1 Batch D：報表與匯出端到端（HTTP→PostgreSQL→storage→引擎→寫入）。上傳與擷取時間不計入。
    rows = int(os.environ.get('DHC_PERF_REPORT_ROWS', '10000'))
    for name in ['ops_report_create', 'ops_report_reused', 'reconciliation_create', 'export_json', 'export_csv', 'export_markdown']:
        samples[name] = []
    stamp = int(time.time())
    ops_docs = [upload_csv(base, token, f'perf-ops-{stamp}-{k}', ops_csv(f'P{stamp}K{k}N', rows)) for k in range(5)]
    for doc in ops_docs:
        status, ms, payload = call(base, 'POST', '/api/enterprise/v1/ops-reports', token, body={'sources': [doc], 'week': '2026-W43', 'datasets': ['BASE']})
        if status != 201 or payload['opsReport']['status'] != 'completed':
            raise SystemExit(f'ops report create failed: {status}')
        samples['ops_report_create'].append(ms)
    for _ in range(10):
        status, ms, payload = call(base, 'POST', '/api/enterprise/v1/ops-reports', token, body={'sources': [ops_docs[0]], 'week': '2026-W43', 'datasets': ['BASE']})
        if status != 200 or not payload.get('reused'):
            raise SystemExit(f'ops report replay not reused: {status}')
        samples['ops_report_reused'].append(ms)
    ledger, receipts = acc_csv(rows)
    ledger_doc = upload_csv(base, token, f'perf-ledger-{stamp}', ledger)
    receipts_doc = upload_csv(base, token, f'perf-receipts-{stamp}', receipts)
    status, ms, payload = call(base, 'POST', '/api/enterprise/v1/reconciliations', token, body={'ledger': ledger_doc, 'receipts': receipts_doc, 'periodStart': '2026-10-01', 'periodEnd': '2026-10-28'})
    if status != 201 or payload['reconciliation']['status'] != 'completed':
        raise SystemExit(f'reconciliation failed: {status}')
    samples['reconciliation_create'].append(ms)
    reconciliation_id = payload['reconciliation']['id']
    for fmt in ['json', 'csv', 'markdown']:
        for _ in range(5):
            status, ms, _ = call(base, 'GET', f'/api/enterprise/v1/reconciliations/{reconciliation_id}/export?format={fmt}', token)
            if status != 200:
                raise SystemExit(f'export {fmt} failed: {status}')
            samples[f'export_{fmt}'].append(ms)
    results = {name: summary(values) for name, values in samples.items() if values}
    results['report_rows'] = rows
    json.dump({'base': base, 'note': '單一用戶端序列請求；執行環境見 runner／主機紀錄（本探針不偵測硬體）；mock 模型；報表／匯出為合成 CSV（report_rows 列）', 'results': results}, open(output, 'w'), ensure_ascii=False, indent=1)
    print(json.dumps(results, ensure_ascii=False))


if __name__ == '__main__':
    main()
