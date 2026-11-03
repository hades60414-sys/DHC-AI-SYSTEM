// Public catalogue and password form shared by every retained front door.
// Bibliographic titles/years/DOIs checked against Crossref on 2026-11-02.
const papers = [
  { year: 1973, topic: '選擇權定價', title: 'The Pricing of Options and Corporate Liabilities', author: 'Fischer Black · Myron Scholes', doi: '10.1086/260062', note: '從動態避險出發，閱讀選擇權定價的經典起點。', keywords: 'Black Scholes BS 選擇權 定價 避險' },
  { year: 1973, topic: '選擇權定價', title: 'Theory of Rational Option Pricing', author: 'Robert C. Merton', doi: '10.2307/3003143', note: '理解理性定價、套利關係與連續時間金融的基礎。', keywords: 'Merton 選擇權 套利 連續時間' },
  { year: 1952, topic: '投資組合', title: 'Portfolio Selection', author: 'Harry Markowitz', doi: '10.1111/j.1540-6261.1952.tb01525.x', note: '以風險與報酬的取捨，建立投資組合選擇的思考框架。', keywords: 'Markowitz portfolio 投資組合 均值 變異數 風險' },
  { year: 1993, topic: '選擇權定價', title: 'A Closed-Form Solution for Options with Stochastic Volatility with Applications to Bond and Currency Options', author: 'Steven L. Heston', doi: '10.1093/rfs/6.2.327', note: '將隨機波動率納入選擇權模型，延伸定價與校準的視角。', keywords: 'Heston stochastic volatility 隨機波動率 校準' },
  { year: 1977, topic: '利率模型', title: 'An equilibrium characterization of the term structure', author: 'Oldrich Vasicek', doi: '10.1016/0304-405X(77)90016-2', note: '從短期利率模型，探索期限結構與債券定價。', keywords: 'Vasicek interest rate 利率 期限結構 債券' },
];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const normalize = (s) => s.trim().toLowerCase().replace(/[–—-]/g, ' ');
const searchable = (p) => `${p.title} ${p.author} ${p.topic} ${p.year} ${p.keywords}`.toLowerCase();

export function libraryHtml({ next = '/', error = '', query = '' } = {}) {
  // Submitted text can be a password: use it for matching only, never reflect it into HTML.
  const term = typeof query === 'string' ? normalize(query) : '';
  const count = papers.filter((p) => searchable(p).includes(term)).length;
  const topics = ['所有論文', ...new Set(papers.map((p) => p.topic))];
  const nav = topics.map((topic, i) => `<button class="topic${i ? '' : ' active'}" type="button" data-topic="${i ? topic : ''}" aria-pressed="${!i}">${topic}<span>${i ? papers.filter((p) => p.topic === topic).length : papers.length}</span></button>`).join('');
  const cards = papers.map((p, i) => `<article class="paper" data-search="${esc(searchable(p))}" data-category="${p.topic}"${!searchable(p).includes(term) ? ' hidden' : ''}>
    <div class="paper-index">${String(i + 1).padStart(2, '0')}</div><div class="paper-content"><div class="meta">${p.topic}<span> / </span>${p.year}</div>
    <h3><a href="${esc('https://doi.org/' + p.doi)}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a></h3>
    <p class="author">${esc(p.author)}</p><p class="note">${p.note}</p></div>
    <a class="read" href="${esc('https://doi.org/' + p.doi)}" aria-label="閱讀 ${esc(p.title)}" target="_blank" rel="noopener noreferrer">閱讀 <span aria-hidden="true">↗</span></a></article>`).join('');
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="same-origin">
<title>財務工程論文圖書館</title>
<style>
:root{--paper:#f7f5ef;--ink:#203832;--muted:#59665e;--line:#d8ddd3;--accent:#235b49;--white:#fffefa}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 "Segoe UI","Microsoft JhengHei",sans-serif}a{color:inherit;text-decoration:none}button,input{font:inherit}button,a,input{-webkit-tap-highlight-color:transparent}button,a{touch-action:manipulation}a:hover{color:var(--accent)}:focus-visible{outline:3px solid var(--accent);outline-offset:4px}[hidden]{display:none!important}.wrap{max-width:1160px;margin:auto;padding:0 40px}
header{border-bottom:1px solid var(--line)}.header-inner{min-height:86px;display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{display:flex;align-items:center;gap:14px;min-height:44px;font-weight:650;letter-spacing:.06em}.mark{width:34px;height:34px;flex:none}.edition{font-size:12px;letter-spacing:.15em;color:var(--muted)}
.hero{padding:64px 0 44px;max-width:850px}.eyebrow{color:var(--accent);font-size:12px;letter-spacing:.2em;font-weight:650}.hero h1{font:normal clamp(30px,4vw,48px)/1.35 Georgia,"PMingLiU",serif;letter-spacing:.04em;margin:16px 0}.intro{color:var(--muted);margin:0 0 28px}.search-label{display:block;font-size:13px;margin-bottom:8px}.search-box{display:flex;min-height:58px;border:1px solid #7d8f82;background:var(--white);border-radius:4px;padding:5px}.search-box:focus-within{outline:2px solid var(--accent);outline-offset:3px}.search-box input{min-width:0;flex:1;border:0;outline:none;background:transparent;padding:8px 14px;color:var(--ink);width:100%}.search-box input::placeholder{color:var(--muted)}.search-box button{border:0;border-radius:2px;background:var(--accent);color:white;min-width:92px;min-height:46px;cursor:pointer}.search-box button:hover{background:#184533}.hint{font-size:12px;color:var(--muted);margin:10px 0 0}.error{color:#923b2d;font-size:14px;margin:12px 0 0}
.catalogue{display:grid;grid-template-columns:210px minmax(0,1fr);gap:48px;padding:12px 0 64px}.sidebar h2{font-size:12px;color:var(--muted);letter-spacing:.12em;margin:6px 0 16px}.topics{display:grid;gap:6px}.topic{display:flex;justify-content:space-between;align-items:center;gap:12px;background:transparent;border:0;text-align:left;color:var(--muted);border-radius:4px;padding:10px 12px;min-height:46px;cursor:pointer}.topic.active{background:#e4eade;color:var(--ink);font-weight:650}.topic:hover{background:#e9ede5}.topic span{font-size:12px;font-variant-numeric:tabular-nums}.sidebar-note{border-top:1px solid var(--line);padding-top:20px;margin-top:28px;color:var(--muted);font-size:13px}.shelf-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding-bottom:16px;border-bottom:1px solid var(--ink)}.shelf-head h2{font-size:20px;font-weight:500;margin:0}.count{color:var(--muted);font-size:13px}.paper{display:flex;align-items:flex-start;gap:20px;padding:26px 0;border-bottom:1px solid var(--line)}.paper-index{font:italic 16px Georgia,serif;color:var(--muted);padding-top:4px}.paper-content{flex:1;min-width:0}.meta{font-size:12px;color:var(--accent)}.meta span{color:var(--muted);padding:0 8px}h3{font:normal 21px/1.4 Georgia,"Times New Roman",serif;margin:8px 0;overflow-wrap:anywhere}h3 a:hover{text-decoration:underline;text-underline-offset:4px}.author{font-size:13px;color:var(--muted);margin:0}.note{font-size:14px;color:var(--muted);margin:10px 0 0}.read{font-size:13px;white-space:nowrap;min-height:44px;display:flex;align-items:center;gap:8px;margin-top:20px}.empty{padding:32px 0;color:var(--muted)}footer{border-top:1px solid var(--line);font-size:12px;color:var(--muted)}.footer-inner{padding-top:24px;padding-bottom:28px;display:flex;justify-content:space-between;gap:16px}
@media(max-width:700px){.wrap{padding-left:22px;padding-right:22px}.header-inner{min-height:72px}.edition{display:none}.brand{font-size:14px;gap:10px}.hero{padding:40px 0 32px}.intro{font-size:14px}.catalogue{grid-template-columns:1fr;gap:24px}.sidebar h2,.sidebar-note{display:none}.topics{display:flex;flex-wrap:wrap;gap:8px}.topic{gap:12px;padding:9px 12px;font-size:14px}.paper{gap:12px;flex-wrap:wrap}.paper-index{display:none}.paper-content{flex-basis:calc(100% - 64px)}h3{font-size:20px}.read{margin-top:18px}.footer-inner{flex-direction:column;gap:4px}.search-box input{padding-left:10px;font-size:16px}.search-box button{min-width:72px}.hint{max-width:34em}}
</style></head><body data-entrance="current">
<header><div class="wrap header-inner"><a class="brand" href="/_gate"><svg class="mark" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 6h9l3 3 3-3h9v21h-9l-3 2-3-2H4zM16 9v20M8 12h4M8 17h4M20 12h4M20 17h4"/></svg>財務工程論文圖書館</a><span class="edition">FINANCIAL ENGINEERING LIBRARY</span></div></header>
<main class="wrap"><section class="hero" aria-labelledby="title"><div class="eyebrow">MODELS · MARKETS · IDEAS</div><h1 id="title">從經典論文，理解金融的結構。</h1><p class="intro">選擇權、投資組合與利率模型。讓每一次閱讀，回到問題的起點。</p>
<form method="post" action="/_gate" autocomplete="off"><input type="hidden" name="next" value="${esc(next)}">
<label class="search-label" for="query">搜尋館藏</label><div class="search-box"><input id="query" name="pw" type="search" placeholder="論文標題、作者或研究主題" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="search" aria-describedby="search-hint"><button type="submit">查詢 <span aria-hidden="true">↗</span></button></div>
<p class="hint" id="search-hint">試試 Black–Scholes、Heston 或投資組合；輸入關鍵字即可篩選館藏。</p>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}</form></section>
<section class="catalogue" aria-label="論文目錄"><aside class="sidebar"><h2>依研究主題瀏覽</h2><nav class="topics" aria-label="研究主題">${nav}</nav><p class="sidebar-note">從一個模型開始，<br>沿著問題延伸閱讀。<br><br>書目連結至原出版來源；全文取得方式依出版者規定。</p></aside>
<div><div class="shelf-head"><h2 id="shelf-title">經典論文選讀</h2><span class="count" id="result-count" role="status" aria-live="polite">${count} 篇論文</span></div><div id="papers">${cards}</div><p id="empty" class="empty"${count ? ' hidden' : ''}>沒有符合的論文，請試試其他作者或主題。</p></div></section></main>
<footer><div class="wrap footer-inner"><span>財務工程論文圖書館 · 經典選讀</span><span>書目來源：Crossref / DOI · 核對於 2026.11.02</span></div></footer>
<script>
{
  const input=document.getElementById('query'),items=[...document.querySelectorAll('.paper')],topics=[...document.querySelectorAll('[data-topic]')];let topic='';
  function filter(){const q=input.value.trim().toLowerCase().replace(/[–—-]/g,' ');let count=0;for(const item of items){item.hidden=!(item.dataset.search.includes(q)&&(!topic||item.dataset.category===topic));if(!item.hidden)count++;}document.getElementById('result-count').textContent=count+' 篇論文';document.getElementById('empty').hidden=count>0;}
  input.addEventListener('input',filter);
  topics.forEach(button=>button.addEventListener('click',()=>{topic=button.dataset.topic;topics.forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});filter();}));
  // Clear potentially sensitive input before this document can be restored from browser history.
  addEventListener('pagehide',()=>{input.value='';});
}
</script></body></html>`;
}
