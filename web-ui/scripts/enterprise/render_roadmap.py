"""由 docs/enterprise/architecture/roadmap.json 產生 ROADMAP_TUI.md 與 TECHNICAL_ROADMAP.mmd。
用法：python3 -B scripts/enterprise/render_roadmap.py [--check]
--check：只比對產出是否與檔案一致（CI 可用），不一致 exit 1。evidence 路徑不存在的項目標 MISSING_EVIDENCE 並 exit 1。
"""
import json
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / 'docs/enterprise/architecture'
ORDER = ['CURRENT', 'NEW_IN_V5', 'NEW_IN_V51', 'PLANNED', 'BLOCKED_DECISION']
MARK = {'CURRENT': '■', 'NEW_IN_V5': '◆', 'NEW_IN_V51': '◇', 'PLANNED': '□', 'BLOCKED_DECISION': '✕'}


def width(text):
    return sum(2 if unicodedata.east_asian_width(ch) in 'WF' else 1 for ch in text)


def pad(text, size):
    return text + ' ' * max(0, size - width(text))


def render(data):
    items = data['items']
    missing = [item['id'] for item in items if item['status'] in ('CURRENT', 'NEW_IN_V5', 'NEW_IN_V51') and (not item['evidence'] or any(not (ROOT / p).exists() for p in item['evidence']))]
    counts = {status: sum(item['status'] == status for item in items) for status in ORDER}
    done = counts['CURRENT'] + counts['NEW_IN_V5'] + counts['NEW_IN_V51']
    bar_size = 40
    filled = round(bar_size * done / len(items))
    inner = 78
    line = lambda text='': f'│ {pad(text, inner)} │'
    out = ['┌' + '─' * (inner + 2) + '┐', line('DHC AI Office 後端路線圖（由 roadmap.json 產生，勿手改）'), line(),
           line(f'完成度 [{"█" * filled}{"░" * (bar_size - filled)}] {done}/{len(items)}'),
           line('  '.join(f'{MARK[s]} {s} {counts[s]}' for s in ORDER)), '├' + '─' * (inner + 2) + '┤']
    for track in dict.fromkeys(item['track'] for item in items):
        out.append(line(f'▸ {track}'))
        for item in [i for i in items if i['track'] == track]:
            flag = '  ⚠ MISSING_EVIDENCE' if item['id'] in missing else ''
            text = f"  {MARK[item['status']]} {item['id']:<7} {item['title']}"
            if width(text + flag) > inner:
                while width(text + '…' + flag) > inner:
                    text = text[:-1]
                text += '…'
            out.append(line(text + flag))
        out.append(line())
    out[-1] = '└' + '─' * (inner + 2) + '┘'
    md = ['# 後端路線圖（TUI 檢視）', '', '> 由 `scripts/enterprise/render_roadmap.py` 依 `roadmap.json` 產生；CURRENT／NEW_IN_V5／NEW_IN_V51 項目的 evidence 路徑皆經存在性檢查。', '',
          '```text', *out, '```', '', '| ID | 軌道 | 項目 | 狀態 | 證據 |', '|---|---|---|---|---|']
    md += [f"| {i['id']} | {i['track']} | {i['title']} | {i['status']} | {'<br/>'.join(f'`{p}`' for p in i['evidence']) or '—'} |" for i in items]
    mmd = ['%% 由 scripts/enterprise/render_roadmap.py 依 roadmap.json 產生，勿手改。', 'flowchart LR',
           '  classDef current fill:#e8f1e8,stroke:#3d6b3d,color:#2A2A2A', '  classDef newv5 fill:#e6eef8,stroke:#2f5d8a,color:#2A2A2A',
           '  classDef newv51 fill:#e9e6f6,stroke:#5a4a9a,color:#2A2A2A',
           '  classDef planned fill:#f4f1e6,stroke:#8a7a2f,color:#2A2A2A,stroke-dasharray:4 3', '  classDef blocked fill:#f6e8e8,stroke:#8a2f2f,color:#2A2A2A,stroke-dasharray:2 2']
    css = {'CURRENT': 'current', 'NEW_IN_V5': 'newv5', 'NEW_IN_V51': 'newv51', 'PLANNED': 'planned', 'BLOCKED_DECISION': 'blocked'}
    for index, status in enumerate(ORDER):
        mmd.append(f'  subgraph S{index}["{status}"]')
        for item in [i for i in items if i['status'] == status]:
            node = item['id'].replace('-', '_')
            mmd.append(f'    {node}["{item["id"]}<br/>{item["title"].replace(chr(34), "")}"]:::{css[status]}')
        mmd.append('  end')
    mmd += ['  S0 --> S1 --> S2 --> S3', '  S4 -.->|"人類決策後才排入"| S3']
    return '\n'.join(md) + '\n', '\n'.join(mmd) + '\n', missing


def main():
    data = json.loads((DIR / 'roadmap.json').read_text())
    md, mmd, missing = render(data)
    targets = {DIR / 'ROADMAP_TUI.md': md, DIR / 'TECHNICAL_ROADMAP.mmd': mmd}
    if '--check' in sys.argv:
        stale = [p.name for p, text in targets.items() if not p.exists() or p.read_text() != text]
        print(json.dumps({'stale': stale, 'missing_evidence': missing}, ensure_ascii=False))
        return 1 if stale or missing else 0
    for path, text in targets.items():
        path.write_text(text)
    print(json.dumps({'written': [p.name for p in targets], 'missing_evidence': missing, 'items': len(data['items'])}, ensure_ascii=False))
    return 1 if missing else 0


if __name__ == '__main__':
    raise SystemExit(main())
