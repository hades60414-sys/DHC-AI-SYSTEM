"""V5.1 RG-V5-02：以 LibreOffice Calc 無頭模式實際匯入 CSV（開啟「求值公式」），再匯出儲存格「顯示值」，檢查 payload 是否被當公式求值。
用法：python3 -B check_spreadsheet_import.py <csv-formula-fixtures 輸出目錄> <結果.json>
判定：control.csv 中被求值的 payload（顯示值與原文不同）證明該設定確實會求值；guarded.csv 中同一 payload 的顯示值必須仍含原文（未被求值）。
"""
import csv
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

src, out = Path(sys.argv[1]), Path(sys.argv[2])
payloads = json.loads((src / 'payloads.json').read_text())
soffice = shutil.which('soffice') or shutil.which('libreoffice')
if not soffice:
    out.write_text(json.dumps({'status': 'NOT_RUN', 'reason': 'LibreOffice 不存在'}, ensure_ascii=False))
    sys.exit(1)
version = subprocess.run([soffice, '--version'], capture_output=True, text=True).stdout.strip()
# 匯入：逗號、雙引號、UTF-8(76)、第 1 行起、英文語系、引號欄位不強制文字、第 13 項＝求值公式 true
IMPORT = 'CSV:44,34,76,1,,1033,false,false,false,false,false,-1,true'
# 匯出：第 9 項「依顯示內容儲存」true、第 10 項「匯出公式」false → 取得求值後的顯示值
EXPORT = 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,false,-1'


def displayed(name):
    with tempfile.TemporaryDirectory() as work:
        profile = Path(work) / 'profile'
        shutil.copy(src / name, Path(work) / 'in.csv')
        result = subprocess.run([soffice, f'-env:UserInstallation=file://{profile}', '--headless', f'--infilter={IMPORT}', '--convert-to', EXPORT, '--outdir', str(Path(work) / 'o'),
                                 str(Path(work) / 'in.csv')], capture_output=True, text=True, timeout=180)
        produced = Path(work) / 'o' / 'in.csv'
        if not produced.exists():
            raise RuntimeError(f'LibreOffice 轉換失敗：{result.stderr[-500:]}')
        return [row for row in csv.reader(produced.read_text(encoding='utf-8-sig').splitlines())]


control = displayed('control.csv')
control_cells = [row[0] if row else '' for row in control[1:]]
guarded = displayed('guarded.csv')
header = guarded[0]
column = header.index('資料列ID')
guarded_cells = [row[column] for row in guarded[1:] if len(row) > column]
rows = []
for payload, shown in zip(payloads, control_cells):
    evaluated = shown.strip() != payload.strip()
    match = [cell for cell in guarded_cells if payload.strip().lstrip("'") in cell]
    rows.append({'payload': payload, 'control_displayed': shown, 'control_evaluated': evaluated, 'guarded_displayed': match[0] if match else None,
                 'guarded_safe': bool(match)})
unsafe = [row['payload'] for row in rows if not row['guarded_safe']]
report = {'status': 'PASS' if not unsafe else 'FAIL', 'libreoffice': version, 'import_filter': IMPORT, 'export_filter': EXPORT,
          'control_evaluated_count': sum(row['control_evaluated'] for row in rows), 'payloads': len(rows), 'unsafe': unsafe, 'rows': rows,
          'excel': 'NOT_RUN（GitHub Linux runner 無 Excel）'}
out.write_text(json.dumps(report, ensure_ascii=False, indent=1))
print(json.dumps({k: report[k] for k in ['status', 'libreoffice', 'control_evaluated_count', 'payloads', 'unsafe']}, ensure_ascii=False))
sys.exit(0 if not unsafe and report['control_evaluated_count'] > 0 else 1)
