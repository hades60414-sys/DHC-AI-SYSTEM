/* chartkit.js — tas-charts 的圖表小工具。單檔、零外部依賴、純 SVG，內網離線可開。
 * 用法：CK.use('ink') 一頁一次 → CK.bar('#id', {...}) 等。每個圖出錯時在容器裡顯示紅框，不會靜默跳過。
 * body 上的 data-ck-charts / data-ck-errors 給 check.mjs --render 驗收用。 */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  let W = 640; // 每張圖畫之前改成容器實際寬度，字級才是真實像素
  const FONT = '"Microsoft JhengHei","PingFang TC","Noto Sans TC","Segoe UI",system-ui,sans-serif';

  // ── 色系 ── 每套都有同樣的角色；圖只從角色取色，不散寫色碼。
  const PALETTES = {
    ink: { // 灰階保底：明度＝重要性
      bg: '#F3F2EE', card: '#FFFFFF', txt: '#1C1C1A', mut: '#5F5E59', grid: '#E3E1DB',
      ramp: ['#ECEAE5', '#C9C6BF', '#9A978F', '#5F5D57', '#1C1C1A'],
      cat: ['#1C1C1A', '#5F5D57', '#8C8981'], data: '#5F5D57', hero: '#1C1C1A', soft: '#9A978F'
    },
    harbor: { // 單色相藍階：有序資料、單一序列
      bg: '#F1F4F7', card: '#FFFFFF', txt: '#15202B', mut: '#55606B', grid: '#DFE5EB',
      ramp: ['#E3EBF3', '#B4C8DD', '#7499BE', '#3A6A9B', '#173F6B'],
      cat: ['#173F6B', '#3A6A9B', '#6A90B6'], data: '#3A6A9B', hero: '#173F6B', soft: '#8FADCB'
    },
    jade: { // 分類色：無序類目 ≤5
      bg: '#F2F3EF', card: '#FFFFFF', txt: '#1E2421', mut: '#59615C', grid: '#E1E4DE',
      ramp: ['#E2ECE7', '#B3CFC3', '#77A592', '#3F7A64', '#1F4E3E'],
      cat: ['#2F6B5A', '#A67522', '#4E74A0', '#A44A55', '#6E5E94'], data: '#2F6B5A', hero: '#1F4E3E', soft: '#93B5A7'
    },
    signal: { // 灰階＋一個強調色：只標一個主角
      bg: '#F3F3F2', card: '#FFFFFF', txt: '#1A1A1A', mut: '#5E5E5E', grid: '#E4E4E2',
      ramp: ['#EDEDEB', '#C8C8C5', '#9B9B97', '#5E5E5B', '#1A1A1A'],
      cat: ['#1A1A1A', '#8C8C88'], data: '#8C8C88', hero: '#1F5FD6', soft: '#B5B5B1'
    }
  };
  // 漲跌語意色獨立於色系：台灣慣例紅漲綠跌（tw），國際慣例相反（intl）。
  const UPDOWN = { tw: { up: '#C8352B', down: '#1F7A4D' }, intl: { up: '#1F7A4D', down: '#C8352B' } };
  const ALERT = { warn: '#A86B0C', breach: '#B3261E' };

  let P = null, paletteName = null, count = 0;
  const errors = [];

  // ── 小工具 ──
  function hex(c) { const n = parseInt(c.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function toHex(a) { return '#' + a.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase(); }
  function mix(a, b, t) { const x = hex(a), y = hex(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); }
  function lum(c) { return hex(c).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0); }
  function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
  function rampAt(t) { // 0..1 在 ramp 上內插
    const r = P.ramp, k = Math.max(0, Math.min(1, t)) * (r.length - 1), i = Math.min(r.length - 2, Math.floor(k));
    return mix(r[i], r[i + 1], k - i);
  }
  function ink(bg) { return contrast(bg, P.txt) >= contrast(bg, P.card) ? P.txt : P.card; }

  const UNITS = { '千': 1e3, '萬': 1e4, '百萬': 1e6, '千萬': 1e7, '億': 1e8 };
  function toUnit(v, u) { if (!UNITS[u]) throw new Error('不認得的單位 ' + u); return v / UNITS[u]; }
  function fmt(v, o) {
    o = o || {};
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v), d = o.digits != null ? o.digits : (a >= 100 ? 0 : a >= 10 ? 1 : 2);
    let s = a.toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
    if (v < 0 && Number(s.replace(/,/g, '')) !== 0) s = o.parens ? '(' + s + ')' : '-' + s;
    else if (o.sign && v > 0) s = '+' + s;
    return s + (o.unit || '');
  }
  function nice(lo, hi, n) {
    if (lo === hi) { if (lo === 0) hi = 1; else { lo = Math.min(0, lo); hi = Math.max(0, hi); } }
    const step0 = (hi - lo) / (n || 5), mag = Math.pow(10, Math.floor(Math.log10(step0))), e = step0 / mag;
    const step = (e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1) * mag;
    const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step, ticks = [];
    for (let v = a; v <= b + step / 2; v += step) ticks.push(+v.toFixed(10));
    return { lo: a, hi: b, ticks };
  }
  function tw(s, size) { // 估字寬：中文 1em、英數約 0.6em
    let w = 0; for (const ch of String(s)) w += /[⺀-￿]/.test(ch) ? 1 : 0.6;
    return w * (size || 13);
  }

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function txt(parent, x, y, s, a) { const t = el('text', Object.assign({ x, y }, a), parent); t.textContent = s; return t; }
  function host(target) {
    const h = typeof target === 'string' ? document.querySelector(target) : target;
    if (!h) throw new Error('找不到圖表容器 ' + target);
    return h;
  }
  function canvas(target, h) {
    const box = host(target); box.innerHTML = '';
    return el('svg', { viewBox: `0 0 ${W} ${h}`, class: 'ck-svg', role: 'img' }, box);
  }
  function arr(o, k) { const v = o[k]; if (!Array.isArray(v) || !v.length) throw new Error(`缺少 ${k}（要一個非空陣列）`); return v; }
  function num(v, where) { if (typeof v !== 'number' || !isFinite(v)) throw new Error(`${where} 不是數字：${v}`); return v; }
  function f(o) { return v => fmt(v, { digits: o.digits, unit: o.unit, parens: o.parens }); }
  function isHi(o, label) { const h = o.highlight; return h != null && (Array.isArray(h) ? h.includes(label) : h === label); }
  function fillFor(o, label, v) {
    if (o.pnl) return v >= 0 ? P.up : P.down;
    if (o.highlight != null) return isHi(o, label) ? P.hero : P.soft;
    return P.data;
  }
  function delay(i, step) { return `animation-delay:${Math.min(i * (step || 50), 900)}ms`; }

  // 刻度只寫數字（單位寫在副標），小數位跟著刻度間距走
  function tickFmt(sc) { const st = sc.ticks.length > 1 ? sc.ticks[1] - sc.ticks[0] : 1; const d = Math.max(0, -Math.floor(Math.log10(st) + 1e-9)); return v => fmt(v, { digits: d }); }
  // 數值軸（直向）：格線＋刻度＋零線
  function yAxis(s, sc, y, x0, x1) {
    const fm = tickFmt(sc);
    sc.ticks.forEach(v => {
      el('line', { x1: x0, x2: x1, y1: y(v), y2: y(v), class: v === 0 ? 'ck-zero' : 'ck-gridline' }, s);
      txt(s, x0 - 6, y(v) + 4, fm(v), { class: 'ck-tick', 'text-anchor': 'end' });
    });
  }
  function xAxis(s, sc, x, y0, y1) {
    const fm = tickFmt(sc);
    sc.ticks.forEach(v => {
      el('line', { x1: x(v), x2: x(v), y1: y0, y2: y1, class: v === 0 ? 'ck-zero' : 'ck-gridline' }, s);
      txt(s, x(v), y1 + 16, fm(v), { class: 'ck-tick', 'text-anchor': 'middle' });
    });
  }
  function legend(s, items, y) { // items: [{name,color}]，畫在圖頂一列
    let x = 0;
    items.forEach(it => {
      el('rect', { x, y: y - 9, width: 10, height: 10, rx: 2, fill: it.color }, s);
      txt(s, x + 15, y, it.name, { class: 'ck-tick' });
      x += 15 + tw(it.name, 12) + 18;
    });
  }
  function spread(items, minGap, lo, hi) { // 末端標籤互推，避免重疊
    items.sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) if (items[i].y - items[i - 1].y < minGap) items[i].y = items[i - 1].y + minGap;
    const over = items.length ? items[items.length - 1].y - hi : 0;
    if (over > 0) items.forEach(it => { it.y -= over; });
    items.forEach(it => { if (it.y < lo) it.y = lo; });
    return items;
  }

  // ── 樣式 ──
  function css() {
    return `
:root{--ck-bg:${P.bg};--ck-card:${P.card};--ck-txt:${P.txt};--ck-mut:${P.mut};--ck-grid:${P.grid};--ck-up:${P.up};--ck-down:${P.down};--ck-warn:${ALERT.warn};--ck-breach:${ALERT.breach};--ck-hero:${P.hero}}
body{margin:0;background:var(--ck-bg);color:var(--ck-txt);font-family:${FONT};font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.ck-page{max-width:1080px;margin:0 auto;padding:32px 24px 48px}
.ck-head{margin-bottom:20px}
.ck-head h1{font-size:28px;line-height:1.3;margin:0 0 6px;font-weight:700}
.ck-meta{color:var(--ck-mut);font-size:13px;letter-spacing:.04em}
.ck-lede{font-size:15px;line-height:1.7;margin:10px 0 0;max-width:760px}
.ck-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin-top:20px}
.ck-wide{grid-column:1/-1}
@media (max-width:760px){.ck-grid{grid-template-columns:1fr}}
.ck-card{background:var(--ck-card);border-radius:14px;padding:20px 22px 14px;min-width:0}
.ck-card h2{font-size:18px;line-height:1.4;margin:0 0 4px;font-weight:700}
.ck-sub{color:var(--ck-mut);font-size:13px;line-height:1.5;margin-bottom:12px}
.ck-src{color:var(--ck-mut);font-size:11.5px;letter-spacing:.05em;margin-top:10px;border-top:1px solid var(--ck-grid);padding-top:8px}
.ck-note{font-size:14px;line-height:1.7;margin:10px 0 0}
.ck-section{font-size:13px;font-weight:700;letter-spacing:.12em;color:var(--ck-mut);margin:28px 0 -8px}
.ck-svg{width:100%;height:auto;display:block;overflow:visible}
.ck-svg text{font-family:${FONT};fill:var(--ck-txt)}
.ck-svg .ck-tick{font-size:12px;fill:var(--ck-mut)}
.ck-svg .ck-lab{font-size:13px;font-weight:600}
.ck-svg .ck-val{font-size:12.5px;font-weight:700}
.ck-gridline{stroke:var(--ck-grid);stroke-width:1}
.ck-zero{stroke:var(--ck-txt);stroke-width:1.2}
.ck-link{stroke:var(--ck-mut);stroke-width:1;stroke-dasharray:3 3}
[data-tip]{cursor:default}
@keyframes ck-gy{from{transform:scaleY(0)}}@keyframes ck-gx{from{transform:scaleX(0)}}
@keyframes ck-fade{from{opacity:0}}@keyframes ck-draw{to{stroke-dashoffset:0}}
.ck-gy,.ck-gyt,.ck-gx,.ck-gxr{transform-box:fill-box;animation:.55s cubic-bezier(.2,.8,.2,1) both}
.ck-gy{transform-origin:50% 100%;animation-name:ck-gy}.ck-gyt{transform-origin:50% 0;animation-name:ck-gy}
.ck-gx{transform-origin:0 50%;animation-name:ck-gx}.ck-gxr{transform-origin:100% 50%;animation-name:ck-gx}
.ck-fade{animation:ck-fade .5s ease-out both}
.ck-draw{stroke-dasharray:1;stroke-dashoffset:1;animation:ck-draw .9s ease-out forwards}
@media (prefers-reduced-motion:reduce){.ck-svg *{animation:none!important}.ck-draw{stroke-dashoffset:0}}
.ck-tip{position:fixed;pointer-events:none;background:var(--ck-txt);color:var(--ck-card);font-size:12px;line-height:1.5;padding:6px 9px;border-radius:6px;opacity:0;transition:opacity .12s;z-index:99;white-space:pre}
.ck-err{color:${ALERT.breach};border:1px dashed ${ALERT.breach};padding:10px 12px;font-size:13px;border-radius:8px;white-space:pre-wrap}
.ck-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.ck-kpi{background:var(--ck-card);border-radius:14px;padding:14px 16px}
.ck-kpi .l{font-size:13px;color:var(--ck-mut)}
.ck-kpi .v{font-size:26px;font-weight:800;line-height:1.25;margin-top:4px}
.ck-kpi .v small{font-size:14px;font-weight:600;margin-left:3px;color:var(--ck-mut)}
.ck-kpi .d{font-size:13px;font-weight:700;margin-top:2px}
.ck-kpi .n{font-size:12px;color:var(--ck-mut);margin-top:2px}
.ck-status{background:var(--ck-card);border-radius:10px;padding:12px 16px;border-left:6px solid var(--ck-mut);font-size:15px;font-weight:600}
.ck-status.ok{border-left-color:${P.data}}.ck-status.warn{border-left-color:var(--ck-warn)}.ck-status.breach{border-left-color:var(--ck-breach)}
.ck-status b{margin-right:8px}
.ck-table{width:100%;border-collapse:collapse;font-size:13px}
.ck-table th{text-align:left;color:var(--ck-mut);font-weight:600;border-bottom:1px solid var(--ck-txt);padding:6px 8px}
.ck-table td{border-bottom:1px solid var(--ck-grid);padding:6px 8px}
.ck-table .num{text-align:right}
.ck-empty{color:var(--ck-mut);font-size:13px;padding:8px 0}
@media print{body{background:#fff}.ck-page{max-width:none;padding:0}.ck-card,.ck-kpi,.ck-status{border:1px solid var(--ck-grid);break-inside:avoid}.ck-svg *{animation:none!important}.ck-draw{stroke-dashoffset:0}@page{size:A4;margin:12mm}}
`;
  }

  // ── 色系鎖定 ──
  function use(name, opt) {
    opt = opt || {};
    const key = typeof name === 'string' ? name : 'custom';
    if (P) {
      if (paletteName === key) return CK;
      throw new Error(`同一頁只能用一套色系：已用 ${paletteName}，又要 ${key}`);
    }
    let base;
    if (typeof name === 'string') {
      base = PALETTES[name];
      if (!base) throw new Error('沒有這套色系：' + name + '（可用 ' + Object.keys(PALETTES).join('、') + '）');
      base = Object.assign({}, base);
    } else {
      const c = name || {};
      ['bg', 'card', 'txt', 'mut', 'grid', 'data', 'hero'].forEach(k => {
        if (!/^#[0-9A-Fa-f]{6}$/.test(c[k] || '')) throw new Error(`自訂色系缺 ${k}（要 #RRGGBB）`);
      });
      base = Object.assign({}, c);
      base.ramp = c.ramp || [.12, .32, .55, .78, 1].map(t => mix(c.card, c.data, t));
      base.cat = c.cat || [c.hero, c.data];
      base.soft = c.soft || mix(c.card, c.data, .45);
    }
    const ud = UPDOWN[opt.updown || 'tw'];
    if (!ud) throw new Error('updown 只能是 tw 或 intl');
    P = Object.assign(base, ud);
    paletteName = key;
    const bad = [['txt', 4.5], ['mut', 4.5]].filter(([k, min]) => contrast(P[k], P.card) < min)
      .concat(P.cat.filter(c => contrast(c, P.card) < 3).map(c => ['cat ' + c, 3]));
    if (bad.length) errors.push('對比不足：' + bad.map(b => b[0]).join('、'));
    const st = document.createElement('style'); st.id = 'ck-style'; st.textContent = css();
    document.head.appendChild(st);
    tipInit();
    mark();
    return CK;
  }

  // ── 提示框 ──
  let tip;
  function tipInit() {
    if (tip) return;
    tip = document.createElement('div'); tip.className = 'ck-tip';
    (document.body || document.documentElement).appendChild(tip);
    document.addEventListener('mousemove', e => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (!t) { tip.style.opacity = 0; return; }
      tip.textContent = t.getAttribute('data-tip');
      const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
      tip.style.left = x + 'px'; tip.style.top = (e.clientY + 14) + 'px'; tip.style.opacity = 1;
    });
  }

  function mark() {
    if (!document.body) return;
    document.body.dataset.ckCharts = count;
    document.body.dataset.ckErrors = errors.length;
    document.body.dataset.ckPalette = paletteName || '';
  }
  function chart(name, fn) {
    return function (target, o) {
      try {
        if (!P) use('ink');
        W = Math.max(320, Math.min(1400, Math.round(host(target).clientWidth || 640)));
        const r = fn(target, o || {});
        count++; mark();
        return r;
      } catch (e) {
        errors.push(name + '：' + e.message); mark();
        try { host(target).innerHTML = `<div class="ck-err">${name} 畫不出來：${String(e.message).replace(/</g, '&lt;')}</div>`; } catch (_) { /* 容器本身不存在，錯誤已記在 data-ck-errors */ }
        if (root.console) console.error('[chartkit]', name, e);
      }
    };
  }

  // ── 直條：少類目比較；不斷軸，負值往下 ──
  const bar = chart('bar', (t, o) => {
    const d = arr(o, 'data'); d.forEach((r, i) => num(r.value, `data[${i}].value`));
    const h = o.height || 300, s = canvas(t, h), F = f(o);
    const m = { l: 52, r: 6, t: 22, b: 30 };
    const v = d.map(r => r.value), sc = nice(Math.min(0, ...v), Math.max(0, ...v), 5);
    const y = x => m.t + (sc.hi - x) / (sc.hi - sc.lo) * (h - m.t - m.b);
    yAxis(s, sc, y, m.l, W - m.r, F);
    const bw = (W - m.l - m.r) / d.length, gap = bw * .3, showVal = d.length <= 14;
    const labStep = Math.max(1, Math.ceil(Math.max(...d.map(r => tw(r.label))) / (bw - 4)));
    d.forEach((r, i) => {
      const x = m.l + i * bw + gap / 2, w = bw - gap, y0 = y(0), y1 = y(r.value);
      el('rect', { x, y: Math.min(y0, y1), width: w, height: Math.max(1, Math.abs(y1 - y0)), rx: Math.min(3, w / 4),
        fill: fillFor(o, r.label, r.value), class: r.value >= 0 ? 'ck-gy' : 'ck-gyt', style: delay(i), 'data-tip': `${r.label}\n${F(r.value)}` }, s);
      if (showVal) txt(s, x + w / 2, r.value >= 0 ? y1 - 6 : y1 + 15, F(r.value), { class: 'ck-val ck-fade', 'text-anchor': 'middle' });
      if (i % labStep === 0) txt(s, x + w / 2, h - m.b + 19, r.label, { class: 'ck-lab', 'text-anchor': 'middle' });
    });
  });

  // ── 橫條：類目名長、要排名；有負值時零線在中間 ──
  function hbarImpl(t, o) {
    const d = arr(o, 'data').slice(); d.forEach((r, i) => num(r.value, `data[${i}].value`));
    if (o.sort) d.sort((a, b) => o.sort === 'asc' ? a.value - b.value : b.value - a.value);
    const F = f(o), row = o.rowH || 30, lw = Math.min(230, Math.max(...d.map(r => tw(r.label))) + 12);
    const vw = Math.max(...d.map(r => tw(F(r.value), 12.5))) + 10;
    const m = { l: lw, r: vw, t: 6, b: 26 }, h = d.length * row + m.t + m.b, s = canvas(t, h);
    const v = d.map(r => r.value), sc = nice(Math.min(0, ...v), Math.max(0, ...v), 4);
    const neg = sc.lo < 0;
    const x = z => m.l + (neg ? vw : 0) + (z - sc.lo) / (sc.hi - sc.lo) * (W - m.l - m.r - (neg ? vw : 0));
    xAxis(s, sc, x, m.t, h - m.b + 2, F);
    d.forEach((r, i) => {
      const yc = m.t + i * row + row / 2, bh = row * .58, x0 = x(0), x1 = x(r.value);
      txt(s, m.l - 10, yc + 4.5, r.label, { class: 'ck-lab', 'text-anchor': 'end' });
      el('rect', { x: Math.min(x0, x1), y: yc - bh / 2, width: Math.max(1, Math.abs(x1 - x0)), height: bh, rx: 3,
        fill: fillFor(o, r.label, r.value), class: r.value >= 0 ? 'ck-gx' : 'ck-gxr', style: delay(i), 'data-tip': `${r.label}\n${F(r.value)}` }, s);
      txt(s, r.value >= 0 ? x1 + 6 : x1 - 6, yc + 4.5, F(r.value), { class: 'ck-val ck-fade', 'text-anchor': r.value >= 0 ? 'start' : 'end' });
    });
  }
  const hbar = chart('hbar', hbarImpl);
  const diverging = chart('diverging', (t, o) => hbarImpl(t, Object.assign({ pnl: true }, o)));

  // ── 折線／面積：時間序列；系列名標在線尾，不另放圖例 ──
  function lineImpl(t, o, area) {
    const xs = arr(o, 'x'), ser = arr(o, 'series');
    ser.forEach((sr, k) => {
      if (!Array.isArray(sr.values) || sr.values.length !== xs.length) throw new Error(`series[${k}].values 長度要等於 x（${xs.length}）`);
      sr.values.forEach((v, i) => { if (v != null) num(v, `series[${k}].values[${i}]`); });
    });
    if (area && ser.length !== 1) throw new Error('面積圖只畫一條序列；多條請用 line 或 stacked');
    const multi = ser.length > 1;
    if (multi && o.highlight == null && ser.length > P.cat.length) throw new Error(`${ser.length} 條線超過這套色系的 ${P.cat.length} 色；請拆圖、改用 highlight 只標主角，或換 jade`);
    const F = f(o), h = o.height || 300;
    const endW = multi ? Math.max(...ser.map(sr => tw(sr.name, 12.5))) + 16 : 10;
    const m = { l: 52, r: endW, t: 14, b: 30 }, s = canvas(t, h);
    const all = [].concat(...ser.map(sr => sr.values)).filter(v => v != null);
    const sc = nice(o.zero || area ? Math.min(0, ...all) : Math.min(...all), o.zero || area ? Math.max(0, ...all) : Math.max(...all), 5);
    const x = i => m.l + (xs.length === 1 ? 0.5 : i / (xs.length - 1)) * (W - m.l - m.r);
    const y = v => m.t + (sc.hi - v) / (sc.hi - sc.lo) * (h - m.t - m.b);
    yAxis(s, sc, y, m.l, W - m.r, F);
    const step = Math.max(1, Math.ceil(xs.length / Math.floor((W - m.l - m.r) / (Math.max(...xs.map(v => tw(v, 12))) + 14))));
    xs.forEach((lab, i) => { if (i % step === 0 || i === xs.length - 1 && (xs.length - 1) % step > step / 2) txt(s, x(i), h - m.b + 19, lab, { class: 'ck-tick', 'text-anchor': 'middle' }); });
    const colorOf = (sr, k) => !multi ? P.hero : o.highlight != null ? (sr.name === o.highlight ? P.hero : P.soft) : P.cat[k];
    const order = ser.map((sr, k) => k).sort((a, b) => (ser[a].name === o.highlight) - (ser[b].name === o.highlight));
    const ends = [];
    order.forEach(k => {
      const sr = ser[k], c = colorOf(sr, k), segs = [];
      let cur = [];
      sr.values.forEach((v, i) => { if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(v), i]); });
      if (cur.length) segs.push(cur);
      segs.forEach(sg => {
        const dpath = sg.map((p, j) => (j ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
        if (area) el('path', { d: dpath + `L${sg[sg.length - 1][0].toFixed(1)} ${y(0)}L${sg[0][0].toFixed(1)} ${y(0)}Z`, fill: P.ramp[1], class: 'ck-fade' }, s);
        el('path', { d: dpath, fill: 'none', stroke: c, 'stroke-width': sr.name === o.highlight || !multi ? 2.4 : 1.8, 'stroke-linejoin': 'round', pathLength: 1, class: 'ck-draw' }, s);
        if (xs.length <= 24) sg.forEach(p => el('circle', { cx: p[0], cy: p[1], r: 3.2, fill: c, class: 'ck-fade', 'data-tip': `${sr.name || ''} ${xs[p[2]]}\n${F(sr.values[p[2]])}` }, s));
        else sg.forEach(p => el('circle', { cx: p[0], cy: p[1], r: 6, fill: 'transparent', 'data-tip': `${sr.name || ''} ${xs[p[2]]}\n${F(sr.values[p[2]])}` }, s));
      });
      const li = sr.values.map((v, i) => v == null ? -1 : i).filter(i => i >= 0).pop();
      if (li != null) ends.push({ k, c, y: y(sr.values[li]) + 4, x: x(li) });
    });
    if (multi) spread(ends, 14, m.t + 4, h - m.b).forEach(e => txt(s, W - m.r + 8, e.y, ser[e.k].name, { class: 'ck-val', style: `fill:${e.c}` }));
    else if (ends.length) { const e = ends[0]; txt(s, e.x, e.y - 12, F(ser[0].values[ser[0].values.length - 1]), { class: 'ck-val', 'text-anchor': 'end' }); }
  }
  const line = chart('line', (t, o) => lineImpl(t, o, false));
  const area = chart('area', (t, o) => lineImpl(t, o, true));

  // ── 堆疊直條：各期構成＋總量；值不得為負 ──
  const stacked = chart('stacked', (t, o) => {
    const xs = arr(o, 'x'), ser = arr(o, 'series');
    ser.forEach((sr, k) => {
      if (!Array.isArray(sr.values) || sr.values.length !== xs.length) throw new Error(`series[${k}].values 長度要等於 x`);
      sr.values.forEach((v, i) => { num(v, `series[${k}].values[${i}]`); if (v < 0) throw new Error(`堆疊圖不收負值（series[${k}].values[${i}]=${v}）；有正負請用 diverging 或 waterfall`); });
    });
    const colors = o.ordered ? ser.map((_, k) => rampAt(1 - k / Math.max(1, ser.length - 1) * .75)) : P.cat;
    if (ser.length > colors.length) throw new Error(`${ser.length} 個組成超過這套色系的 ${colors.length} 色；請合併成「其他」、設 ordered:true，或換 jade`);
    const F = f(o), h = o.height || 320, m = { l: 52, r: 6, t: 34, b: 30 }, s = canvas(t, h);
    legend(s, ser.map((sr, k) => ({ name: sr.name, color: colors[k] })), 12);
    const tot = xs.map((_, i) => ser.reduce((a, sr) => a + sr.values[i], 0)), sc = nice(0, Math.max(...tot), 5);
    const y = v => m.t + (sc.hi - v) / (sc.hi - sc.lo) * (h - m.t - m.b);
    yAxis(s, sc, y, m.l, W - m.r, F);
    const bw = (W - m.l - m.r) / xs.length, gap = bw * .3;
    xs.forEach((lab, i) => {
      let acc = 0; const x = m.l + i * bw + gap / 2, w = bw - gap;
      const g = el('g', { class: 'ck-gy', style: delay(i, 70) }, s);
      ser.forEach((sr, k) => {
        const v = sr.values[i], y1 = y(acc + v), y0 = y(acc); acc += v;
        if (v > 0) el('rect', { x, y: y1, width: w, height: Math.max(.5, y0 - y1), fill: colors[k], stroke: P.card, 'stroke-width': .8, 'data-tip': `${lab} ${sr.name}\n${F(v)}（${fmt(v / tot[i] * 100, { digits: 1 })}%）` }, g);
      });
      if (xs.length <= 14) txt(s, x + w / 2, y(tot[i]) - 6, F(tot[i]), { class: 'ck-val ck-fade', 'text-anchor': 'middle' });
      txt(s, x + w / 2, h - m.b + 19, lab, { class: 'ck-lab', 'text-anchor': 'middle' });
    });
  });

  // ── 啞鈴：兩個時點的前後對比 ──
  const dumbbell = chart('dumbbell', (t, o) => {
    const d = arr(o, 'data'); d.forEach((r, i) => { num(r.a, `data[${i}].a`); num(r.b, `data[${i}].b`); });
    const F = f(o), row = o.rowH || 30, lw = Math.min(230, Math.max(...d.map(r => tw(r.label))) + 12);
    const m = { l: lw, r: 64, t: 30, b: 26 }, h = d.length * row + m.t + m.b, s = canvas(t, h);
    const aN = o.aName || '前', bN = o.bName || '後';
    const v = [].concat(...d.map(r => [r.a, r.b])), sc = nice(o.zero ? Math.min(0, ...v) : Math.min(...v), o.zero ? Math.max(0, ...v) : Math.max(...v), 4);
    const x = z => m.l + (z - sc.lo) / (sc.hi - sc.lo) * (W - m.l - m.r);
    legend(s, [{ name: aN, color: P.soft }, { name: bN, color: P.hero }], 12);
    xAxis(s, sc, x, m.t, h - m.b + 2, F);
    d.forEach((r, i) => {
      const yc = m.t + i * row + row / 2, c = o.pnl ? (r.b >= r.a ? P.up : P.down) : P.hero;
      txt(s, m.l - 10, yc + 4.5, r.label, { class: 'ck-lab', 'text-anchor': 'end' });
      el('line', { x1: x(r.a), x2: x(r.b), y1: yc, y2: yc, stroke: P.soft, 'stroke-width': 3, 'stroke-linecap': 'round', class: 'ck-fade' }, s);
      el('circle', { cx: x(r.a), cy: yc, r: 5.5, fill: P.card, stroke: P.soft, 'stroke-width': 2, 'data-tip': `${r.label} ${aN}\n${F(r.a)}` }, s);
      el('circle', { cx: x(r.b), cy: yc, r: 6, fill: c, class: 'ck-fade', style: delay(i), 'data-tip': `${r.label} ${bN}\n${F(r.b)}（變動 ${fmt(r.b - r.a, { digits: o.digits, unit: o.unit, sign: true })}）` }, s);
      const right = r.b >= r.a;
      txt(s, x(r.b) + (right ? 10 : -10), yc + 4.5, F(r.b), { class: 'ck-val', 'text-anchor': right ? 'start' : 'end' });
    });
  });

  // ── 瀑布：損益歸因、增減分解 ──
  const waterfall = chart('waterfall', (t, o) => {
    const steps = arr(o, 'steps'); steps.forEach((r, i) => num(r.value, `steps[${i}].value`));
    const F = f(o), FS = v => fmt(v, { digits: o.digits, unit: o.unit, sign: true });
    const start = o.start ? num(o.start.value, 'start.value') : null;
    const bars = []; let acc = start || 0;
    if (o.start) bars.push({ label: o.start.label, a: 0, b: acc, kind: 'total' });
    steps.forEach(r => { bars.push({ label: r.label, a: acc, b: acc + r.value, kind: r.value >= 0 ? 'up' : 'down', v: r.value }); acc += r.value; });
    bars.push({ label: o.endLabel || '合計', a: 0, b: acc, kind: 'total' });
    const h = o.height || 320, m = { l: 52, r: 6, t: 20, b: 30 }, s = canvas(t, h);
    const v = [].concat(...bars.map(b => [b.a, b.b])), sc = nice(Math.min(0, ...v), Math.max(0, ...v), 5);
    const y = z => m.t + (sc.hi - z) / (sc.hi - sc.lo) * (h - m.t - m.b);
    yAxis(s, sc, y, m.l, W - m.r, F);
    const bw = (W - m.l - m.r) / bars.length, gap = bw * .28, pn = o.pnl !== false;
    bars.forEach((b, i) => {
      const x = m.l + i * bw + gap / 2, w = bw - gap, top = y(Math.max(b.a, b.b)), bot = y(Math.min(b.a, b.b));
      const c = b.kind === 'total' ? P.hero : pn ? (b.kind === 'up' ? P.up : P.down) : (b.kind === 'up' ? P.data : P.soft);
      el('rect', { x, y: top, width: w, height: Math.max(1, bot - top), rx: 2, fill: c, class: 'ck-fade', style: delay(i, 90),
        'data-tip': `${b.label}\n${b.kind === 'total' ? F(b.b) : FS(b.v)}` }, s);
      if (i < bars.length - 1) el('line', { x1: x + w, x2: x + bw, y1: y(b.b), y2: y(b.b), class: 'ck-link' }, s);
      const val = b.kind === 'total' ? F(b.b) : FS(b.v), up = b.kind === 'total' ? b.b >= 0 : b.kind === 'up';
      txt(s, x + w / 2, up ? top - 6 : bot + 15, val, { class: 'ck-val ck-fade', 'text-anchor': 'middle' });
      txt(s, x + w / 2, h - m.b + 19, b.label, { class: 'ck-lab', 'text-anchor': 'middle' });
    });
  });

  // ── 熱力格：類目×類目；有正負時用漲跌雙色 ──
  const heatmap = chart('heatmap', (t, o) => {
    const rows = arr(o, 'rows'), cols = arr(o, 'cols'), vals = arr(o, 'values');
    if (vals.length !== rows.length) throw new Error('values 列數要等於 rows');
    vals.forEach((r, i) => { if (!Array.isArray(r) || r.length !== cols.length) throw new Error(`values[${i}] 長度要等於 cols`); r.forEach((v, j) => { if (v != null) num(v, `values[${i}][${j}]`); }); });
    const F = f(o), lw = Math.min(200, Math.max(...rows.map(r => tw(r))) + 12), chH = o.cellH || 28;
    const m = { l: lw, r: 4, t: 24, b: 6 }, cw = (W - m.l - m.r) / cols.length, h = rows.length * chH + m.t + m.b, s = canvas(t, h);
    const flat = [].concat(...vals).filter(v => v != null), lo = Math.min(...flat), hi = Math.max(...flat);
    const div = lo < 0 && hi > 0, amax = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    const color = v => v == null ? P.bg : div ? mix(P.card, v >= 0 ? P.up : P.down, .12 + .88 * Math.abs(v) / amax) : rampAt(hi === lo ? .6 : (v - lo) / (hi - lo));
    const cstep = Math.max(1, Math.ceil(Math.max(...cols.map(c => tw(c, 12))) / (cw - 2)));
    cols.forEach((c, j) => { if (j % cstep === 0) txt(s, m.l + j * cw + cw / 2, m.t - 8, c, { class: 'ck-tick', 'text-anchor': 'middle' }); });
    rows.forEach((r, i) => {
      txt(s, m.l - 10, m.t + i * chH + chH / 2 + 4.5, r, { class: 'ck-lab', 'text-anchor': 'end' });
      cols.forEach((c, j) => {
        const v = vals[i][j], bg = color(v), x = m.l + j * cw, y = m.t + i * chH;
        el('rect', { x: x + .75, y: y + .75, width: cw - 1.5, height: chH - 1.5, rx: 3, fill: bg, class: 'ck-fade', style: delay(i + j, 12), 'data-tip': `${r} × ${c}\n${F(v)}` }, s);
        const lab = v == null ? '' : F(v);
        if (lab && tw(lab, 12) + 6 <= cw) txt(s, x + cw / 2, y + chH / 2 + 4, lab, { class: 'ck-tick', 'text-anchor': 'middle', style: `fill:${ink(bg)}` });
      });
    });
  });

  // ── 散點：兩個連續量的關係；size 用面積編碼（開根號） ──
  const scatter = chart('scatter', (t, o) => {
    const d = arr(o, 'data'); d.forEach((p, i) => { num(p.x, `data[${i}].x`); num(p.y, `data[${i}].y`); if (p.size != null && num(p.size, `data[${i}].size`) < 0) throw new Error('size 不可為負'); });
    const fx = v => fmt(v, { digits: o.xDigits, unit: o.xUnit }), fy = v => fmt(v, { digits: o.yDigits, unit: o.yUnit });
    const h = o.height || 340, m = { l: 56, r: 16, t: 14, b: 44 }, s = canvas(t, h);
    const xs = nice(Math.min(...d.map(p => p.x)), Math.max(...d.map(p => p.x)), 5), ys = nice(Math.min(...d.map(p => p.y)), Math.max(...d.map(p => p.y)), 5);
    const x = v => m.l + (v - xs.lo) / (xs.hi - xs.lo) * (W - m.l - m.r), y = v => m.t + (ys.hi - v) / (ys.hi - ys.lo) * (h - m.t - m.b);
    yAxis(s, ys, y, m.l, W - m.r, fy); xAxis(s, xs, x, m.t, h - m.b, fx);
    if (o.xName) txt(s, W - m.r, h - 4, o.xName + ' →', { class: 'ck-tick', 'text-anchor': 'end' });
    if (o.yName) txt(s, m.l + 4, m.t + 10, '↑ ' + o.yName, { class: 'ck-tick' });
    const smax = Math.max(0, ...d.map(p => p.size || 0)) || 1;
    d.slice().sort((a, b) => (b.size || 0) - (a.size || 0)).forEach((p, i) => {
      const r = p.size != null ? 3 + Math.sqrt(p.size / smax) * 15 : 4.5, hi = isHi(o, p.label);
      el('circle', { cx: x(p.x), cy: y(p.y), r, fill: o.highlight != null ? (hi ? P.hero : P.soft) : P.data, 'fill-opacity': p.size != null ? .82 : 1,
        stroke: P.card, 'stroke-width': 1, class: 'ck-fade', style: delay(i, 15), 'data-tip': `${p.label || ''}\n${o.xName || 'x'}：${fx(p.x)}\n${o.yName || 'y'}：${fy(p.y)}${p.size != null ? `\n${o.sizeName || 'size'}：${fmt(p.size, { digits: o.sizeDigits })}` : ''}` }, s);
      if (p.label && (hi || o.labelAll)) txt(s, x(p.x) + r + 4, y(p.y) + 4, p.label, { class: 'ck-val' });
    });
  });

  // ── 百格圖：100% 構成（取代圓餅）；每格 1%，用最大餘數法湊滿 100 ──
  const waffle = chart('waffle', (t, o) => {
    const d = arr(o, 'data'); d.forEach((r, i) => { if (num(r.value, `data[${i}].value`) < 0) throw new Error('構成比不可為負'); });
    if (d.length > P.cat.length) throw new Error(`${d.length} 類超過這套色系的 ${P.cat.length} 色；把小類合併成「其他」或換 jade`);
    const tot = d.reduce((a, r) => a + r.value, 0); if (!(tot > 0)) throw new Error('總和要大於 0');
    const raw = d.map(r => r.value / tot * 100), n = raw.map(Math.floor);
    raw.map((v, i) => [v - n[i], i]).sort((a, b) => b[0] - a[0]).slice(0, 100 - n.reduce((a, b) => a + b, 0)).forEach(([, i]) => n[i]++);
    const h = o.height || 250, s = canvas(t, h), cell = (h - 10) / 10, F = f(o);
    let k = 0;
    n.forEach((cnt, ci) => { for (let j = 0; j < cnt; j++, k++) {
      const col = Math.floor(k / 10), rw = k % 10;
      el('rect', { x: col * cell + 1, y: (9 - rw) * cell + 1, width: cell - 2.5, height: cell - 2.5, rx: 2, fill: P.cat[ci], class: 'ck-fade', style: delay(k, 6), 'data-tip': `${d[ci].label}\n${fmt(raw[ci], { digits: 1 })}%` }, s);
    } });
    const lx = cell * 10 + 28;
    d.forEach((r, i) => {
      const yy = 22 + i * 34;
      el('rect', { x: lx, y: yy - 11, width: 12, height: 12, rx: 2, fill: P.cat[i] }, s);
      txt(s, lx + 20, yy, r.label, { class: 'ck-lab' });
      txt(s, lx + 20, yy + 16, `${fmt(raw[i], { digits: 1 })}%` + (o.unit ? ` · ${F(r.value)}` : ''), { class: 'ck-tick' });
    });
  });

  // ── 限額使用率：value/limit，soft 預警線、1.0 為上限 ──
  const limits = chart('limits', (t, o) => {
    const d = arr(o, 'data');
    d.forEach((r, i) => { num(r.value, `data[${i}].value`); if (!(num(r.limit, `data[${i}].limit`) > 0)) throw new Error(`data[${i}].limit 要大於 0`); });
    const soft = o.soft != null ? o.soft : .8, F = f(o), row = o.rowH || 34, lw = Math.min(230, Math.max(...d.map(r => tw(r.label))) + 12);
    const u = d.map(r => Math.abs(r.value) / r.limit), umax = Math.max(1.2, ...u.map(v => Math.ceil(v * 10) / 10));
    const m = { l: lw, r: 58, t: 8, b: 26 }, h = d.length * row + m.t + m.b, s = canvas(t, h);
    const x = v => m.l + v / umax * (W - m.l - m.r);
    [0, .5, soft, 1].filter((v, i, a) => a.indexOf(v) === i).forEach(v => {
      el('line', { x1: x(v), x2: x(v), y1: m.t, y2: h - m.b + 2, class: v === 1 ? 'ck-zero' : 'ck-gridline', 'stroke-dasharray': v === soft ? '4 3' : null }, s);
      txt(s, x(v), h - m.b + 18, (v === 1 ? '上限 ' : v === soft ? '預警 ' : '') + fmt(v * 100, { digits: 0 }) + '%', { class: 'ck-tick', 'text-anchor': 'middle' });
    });
    d.forEach((r, i) => {
      const yc = m.t + i * row + row / 2, bh = row * .5, c = u[i] >= 1 ? ALERT.breach : u[i] >= soft ? ALERT.warn : P.data;
      txt(s, m.l - 10, yc + 4.5, r.label, { class: 'ck-lab', 'text-anchor': 'end' });
      el('rect', { x: m.l, y: yc - bh / 2, width: x(umax) - m.l, height: bh, rx: 3, fill: P.bg }, s);
      el('rect', { x: m.l, y: yc - bh / 2, width: Math.max(1, x(u[i]) - m.l), height: bh, rx: 3, fill: c, class: 'ck-gx', style: delay(i),
        'data-tip': `${r.label}\n使用 ${F(r.value)} / 限額 ${F(r.limit)}\n使用率 ${fmt(u[i] * 100, { digits: 1 })}%` }, s);
      txt(s, x(u[i]) + 6, yc + 4.5, fmt(u[i] * 100, { digits: 0 }) + '%', { class: 'ck-val', style: u[i] >= soft ? `fill:${c}` : null });
    });
  });

  // ── HTML 元件：KPI 列、狀態行、表格 ──
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
  const kpi = chart('kpi', (t, o) => {
    const items = arr(o, 'items'), box = host(t);
    box.classList.add('ck-kpis');
    box.innerHTML = items.map((it, i) => {
      num(it.value, `items[${i}].value`);
      let d = '';
      if (it.delta != null) {
        num(it.delta, `items[${i}].delta`);
        const c = it.neutral ? P.mut : it.delta > 0 ? P.up : it.delta < 0 ? P.down : P.mut;
        d = `<div class="d" style="color:${c}">${it.delta > 0 ? '▲' : it.delta < 0 ? '▼' : '—'} ${esc(fmt(Math.abs(it.delta), { digits: it.deltaDigits != null ? it.deltaDigits : it.digits, unit: it.deltaUnit != null ? it.deltaUnit : it.unit }))} ${esc(it.deltaLabel || '')}</div>`;
      }
      return `<div class="ck-kpi"><div class="l">${esc(it.label)}</div><div class="v">${esc(fmt(it.value, { digits: it.digits, parens: it.parens }))}<small>${esc(it.unit || '')}</small></div>${d}${it.note ? `<div class="n">${esc(it.note)}</div>` : ''}</div>`;
    }).join('');
  });
  const status = chart('status', (t, o) => {
    const lv = o.level || 'ok', name = { ok: '正常', warn: '注意', breach: '超限' }[lv];
    if (!name) throw new Error('level 只能是 ok / warn / breach');
    const box = host(t);
    box.className = 'ck-status ' + lv;
    box.innerHTML = `<b style="color:${lv === 'ok' ? P.txt : ALERT[lv]}">${name}</b>${esc(o.text || '')}`;
  });
  const table = chart('table', (t, o) => {
    const cols = arr(o, 'columns'), rows = o.rows || [], box = host(t);
    if (!rows.length) { box.innerHTML = `<div class="ck-empty">${esc(o.empty || '本期無資料')}</div>`; return; }
    const cell = (c, r) => {
      const v = r[c.key];
      if (!c.num) return `<td>${esc(v)}</td>`;
      const col = c.pnl && typeof v === 'number' ? (v > 0 ? P.up : v < 0 ? P.down : '') : '';
      return `<td class="num"${col ? ` style="color:${col}"` : ''}>${esc(typeof v === 'number' ? fmt(v, { digits: c.digits, unit: c.unit, parens: c.parens, sign: c.sign }) : v)}</td>`;
    };
    box.innerHTML = `<table class="ck-table"><thead><tr>${cols.map(c => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => cell(c, r)).join('')}</tr>`).join('')}</tbody></table>`;
  });

  // 確定性示意資料（同一 seed 每次一樣）；正式交付不用
  function demo(i, k) { const x = Math.sin((i + 1) * 12.9898 + (k || 0) * 78.233) * 43758.5453; return x - Math.floor(x); }

  const CK = { use, bar, hbar, diverging, line, area, stacked, dumbbell, waterfall, heatmap, scatter, waffle, limits, kpi, status, table,
    fmt, toUnit, mix, contrast, demo, palettes: PALETTES, get palette() { return P; }, errors };
  root.CK = CK;
})(window);
