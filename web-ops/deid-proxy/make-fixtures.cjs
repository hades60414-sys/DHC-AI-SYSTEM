// Builds fake test PDFs for test-pdf.cjs in testdata\ (no real data; the ID number is computed so it passes the checksum).
//   text.pdf     two-page Chinese PDF printed by Edge from fake.html (real fonts, real text layer)
//   scan.pdf     one page that is only an image (stands in for a scan)
//   blank2.pdf   page 1 text, page 2 blank: still counts as a text PDF
//   big.pdf      300 pages, for the does-not-block check
// usage: node make-fixtures.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { twIdOk } = require('./deid.cjs');

const T = path.join(__dirname, 'testdata');
fs.mkdirSync(T, { recursive: true });

let id = 'A1' + '2345678';
for (let d = 0; d <= 9; d++) if (twIdOk(id.slice(0, 9) + d)) { id = id.slice(0, 9) + d; break; }
const pw = 'Zx' + '9fake' + 'Pass77';
const fake = { id, emp: 'J' + '7654321', mail: 'wang.test' + '@example.com', phone: '09' + '12-345-678', ip: '10.' + '20.30.40', unc: '\\\\' + 'fs01\\share', pw, name: '王' + '大明', amt: '-1,234,' + '567' };
fs.writeFileSync(path.join(T, 'fake.json'), JSON.stringify(fake, null, 1));

fs.writeFileSync(path.join(T, 'fake.html'), `<html><head><meta charset="utf-8"></head><body style="font-family:'Microsoft JhengHei'">
<h1>測試報告（假資料）</h1>
<p>客戶身分證 ${fake.id}，員工編號 ${fake.emp}，聯絡信箱 ${fake.mail}，手機 ${fake.phone}。</p>
<p>資料庫主機 ${fake.ip}，共用資料夾 ${fake.unc}\\report。</p>
<p>承辦人：${fake.name}經理，今日損益 ${fake.amt} 元。</p>
<table border="1"><tr><td>帳號</td><td>password=${fake.pw}</td></tr></table>
<p style="page-break-before:always">第二頁：再提一次 ${fake.id} 與 ${fake.ip}。</p>
</body></html>`);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
execFileSync(edge, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--user-data-dir=' + path.join(T, 'edgeprof'),
  '--print-to-pdf=' + path.join(T, 'text.pdf'), 'file:///' + path.join(T, 'fake.html').replace(/\\/g, '/')], { stdio: 'ignore', timeout: 60000 });
// shot.png: the same page as a 900x400 screenshot (test-img.cjs); shot.jpg: the same picture as JPEG.
execFileSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=900,400', '--user-data-dir=' + path.join(T, 'edgeprof'),
  '--screenshot=' + path.join(T, 'shot.png'), 'file:///' + path.join(T, 'fake.html').replace(/\\/g, '/')], { stdio: 'ignore', timeout: 60000 });
fs.writeFileSync(path.join(T, 'clean.html'), `<html><head><meta charset="utf-8"></head><body style="font-family:'Microsoft JhengHei'">
<h2>季度工作摘要</h2><p>本季完成三項系統調整，下季繼續追蹤。</p></body></html>`);
execFileSync(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=600,200', '--user-data-dir=' + path.join(T, 'edgeprof'),
  '--screenshot=' + path.join(T, 'clean.png'), 'file:///' + path.join(T, 'clean.html').replace(/\\/g, '/')], { stdio: 'ignore', timeout: 60000 });
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile('${path.join(T, 'shot.png')}'); $i.Save('${path.join(T, 'shot.jpg')}', [System.Drawing.Imaging.ImageFormat]::Jpeg); $i.Dispose()`], { stdio: 'ignore', timeout: 60000 });

// 300 pages, to check the proxy keeps answering while a big file is read.
fs.writeFileSync(path.join(T, 'big.html'), '<html><head><meta charset="utf-8"></head><body>'
  + Array.from({ length: 300 }, (_, i) => `<p style="page-break-after:always">第 ${i + 1} 頁 測試段落 ${'資料內容'.repeat(200)} 主機 ${fake.ip}</p>`).join('') + '</body></html>');
execFileSync(edge, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--user-data-dir=' + path.join(T, 'edgeprof'),
  '--print-to-pdf=' + path.join(T, 'big.pdf'), 'file:///' + path.join(T, 'big.html').replace(/\\/g, '/')], { stdio: 'ignore', timeout: 120000 });

// Hand-written PDFs. Offsets in the xref table are computed, so the files are valid.
function pdf(objects) {
  let out = '%PDF-1.4\n';
  const offs = [];
  objects.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const stream = (s) => `<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}\nendstream`;
const img = '\xff\x00\x00\xff'; // 2x2 gray
fs.writeFileSync(path.join(T, 'scan.pdf'), pdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
  stream('q 200 0 0 200 0 0 cm /Im1 Do Q'),
  `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n${img}\nendstream`,
]));
fs.writeFileSync(path.join(T, 'blank2.pdf'), pdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>',
  stream(`BT /F1 12 Tf 20 100 Td (Host ${fake.ip} owner ${fake.emp}) Tj ET`),
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
]));
for (const f of ['text.pdf', 'big.pdf', 'scan.pdf', 'blank2.pdf']) console.log(f, fs.statSync(path.join(T, f)).size, 'bytes');
