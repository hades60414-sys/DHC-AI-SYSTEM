import type { CanvasKind } from '@/modules/canvas/canvasModel';

/**
 * The page shown in the canvas runs in an iframe with `sandbox="allow-scripts …"` and no `allow-same-origin`, so it
 * gets an opaque origin: it can't read this site's storage, cookies or API (a login here is a shell on the host).
 * This small script, put into the page, is its only way out: console lines and errors, the element picked in
 * 框選修改 mode, and highlighted text, all as postMessage to the panel.
 */
export const BRIDGE_TAG = '__dhcCanvas';
export const COMMAND_TAG = '__dhcCanvasCmd';
/** The sandbox for every canvas page (panel and whiteboard card). Never add allow-same-origin. */
export const CANVAS_SANDBOX = 'allow-scripts allow-forms allow-modals allow-pointer-lock';

export type CanvasRect = { x: number; y: number; w: number; h: number };
export type BridgeMessage =
  | { type: 'ready' }
  | { type: 'console'; level: 'log' | 'info' | 'warn' | 'error'; text: string }
  | { type: 'select'; selector: string; html: string; text: string; rect: CanvasRect }
  | { type: 'text'; text: string; rect: CanvasRect };

const BRIDGE_SCRIPT = `(function(){
var T=${JSON.stringify(BRIDGE_TAG)},C=${JSON.stringify(COMMAND_TAG)};
function post(m){m[T]=1;try{parent.postMessage(m,'*')}catch(e){}}
function str(a){if(typeof a==='string')return a;try{return JSON.stringify(a)}catch(e){return String(a)}}
['log','info','warn','error'].forEach(function(k){var o=console[k];console[k]=function(){post({type:'console',level:k,text:[].map.call(arguments,str).join(' ').slice(0,2000)});if(o)o.apply(console,arguments)}});
addEventListener('error',function(e){post({type:'console',level:'error',text:(e.message||'錯誤')+(e.lineno?' （第 '+e.lineno+' 行）':'')})});
addEventListener('unhandledrejection',function(e){post({type:'console',level:'error',text:'未處理的錯誤：'+str(e.reason)})});
var on=false,box=document.createElement('div');
box.setAttribute('data-dhc-canvas-box','');
box.style.cssText='position:fixed;pointer-events:none;border:2px solid #f59e0b;background:rgba(245,158,11,.14);z-index:2147483647;display:none;border-radius:3px';
function rect(r){return{x:r.left,y:r.top,w:r.width,h:r.height}}
function show(el){if(!el||!el.getBoundingClientRect){box.style.display='none';return}var r=el.getBoundingClientRect();box.style.display='block';box.style.left=r.left+'px';box.style.top=r.top+'px';box.style.width=r.width+'px';box.style.height=r.height+'px'}
function path(el){var parts=[];while(el&&el.nodeType===1&&el!==document.body&&el!==document.documentElement&&parts.length<6){var s=el.tagName.toLowerCase();if(el.id){parts.unshift(s+'#'+el.id);break}var c=typeof el.className==='string'?el.className.trim().split(/\\s+/).filter(Boolean).slice(0,2).join('.'):'';if(c)s+='.'+c;var p=el.parentElement;if(p){var same=[].filter.call(p.children,function(x){return x.tagName===el.tagName});if(same.length>1)s+=':nth-of-type('+(same.indexOf(el)+1)+')'}parts.unshift(s);el=p}return parts.join(' > ')}
addEventListener('message',function(e){var d=e.data||{};if(d[C]==='select'){on=!!d.on;if(!box.parentNode)document.documentElement.appendChild(box);show(null);document.documentElement.style.cursor=on?'crosshair':''}});
document.addEventListener('mouseover',function(e){if(on)show(e.target)},true);
document.addEventListener('click',function(e){if(!on)return;e.preventDefault();e.stopPropagation();var el=e.target;if(!el||!el.outerHTML)return;post({type:'select',selector:path(el),html:el.outerHTML.slice(0,4000),text:(el.innerText||el.textContent||'').slice(0,500),rect:rect(el.getBoundingClientRect())})},true);
document.addEventListener('mouseup',function(){if(on)return;var s=window.getSelection&&getSelection();var t=s?s.toString():'';if(t.trim().length>1&&s.rangeCount)post({type:'text',text:t.slice(0,2000),rect:rect(s.getRangeAt(0).getBoundingClientRect())})});
post({type:'ready'});
})();`;

const MD_STYLE = `body{font:15px/1.7 system-ui,-apple-system,"Microsoft JhengHei",sans-serif;max-width:860px;margin:24px auto;padding:0 20px;color:#1f2328;background:#fff}
h1,h2,h3{line-height:1.3}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:4px 10px}
code{background:#f3f4f6;padding:1px 4px;border-radius:4px}pre{background:#f6f8fa;padding:12px;overflow:auto;border-radius:6px}pre code{background:none;padding:0}
blockquote{margin:0;padding-left:12px;border-left:3px solid #d0d7de;color:#57606a}img{max-width:100%}`;

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** A whole page for the kind: HTML as is, SVG centred on a page, Markdown already rendered to HTML by the caller. */
export function pageFor(kind: CanvasKind, content: string, renderedMarkdown?: string): string {
  if (kind === 'html') return content;
  if (kind === 'svg') return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;display:flex;justify-content:center;align-items:flex-start">${content}</body></html>`;
  const body = renderedMarkdown ?? `<pre>${escapeHtml(content)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${MD_STYLE}</style></head><body>${body}</body></html>`;
}

/**
 * The sandbox keeps the page off this site; this keeps it off the network too: no fetch, no outside images or
 * scripts, no form posts, so data put into a page (P&L, positions) can't be sent anywhere and HTML quoted from a web
 * page can't call home. Inline script, style and data: images still work, which is all a self-contained page needs.
 */
export const CANVAS_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'";

/** The page with the network lock first: right after <head>, else after the doctype, else at the start. */
export function withNetworkLock(page: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">`;
  const head = /<head[^>]*>/i.exec(page) ?? /^\s*<!doctype[^>]*>/i.exec(page);
  return head ? `${page.slice(0, head.index + head[0].length)}${meta}${page.slice(head.index + head[0].length)}` : `${meta}${page}`;
}

/** The page for the panel: the network lock, and the bridge before the last </body> (else at the end). */
export function withBridge(page: string): string {
  const locked = withNetworkLock(page);
  const script = `<script>${BRIDGE_SCRIPT}</script>`;
  const at = locked.toLowerCase().lastIndexOf('</body>');
  return at === -1 ? `${locked}${script}` : `${locked.slice(0, at)}${script}${locked.slice(at)}`;
}

const text = (value: unknown, max: number) => String(value ?? '').slice(0, max);

/**
 * A bridge message from this exact frame, or null for anything else posted to the window. The page can post
 * whatever it likes, so the texts are cut to size again and backticks dropped (they go into a ``` block of a prompt).
 */
export function readBridgeMessage(event: MessageEvent, frame: Window | null | undefined): BridgeMessage | null {
  if (!frame || event.source !== frame) return null;
  const data = event.data as Record<string, unknown> | null;
  if (!data || data[BRIDGE_TAG] !== 1 || typeof data.type !== 'string') return null;
  const r = (data.rect ?? {}) as Record<string, unknown>;
  const rect = { x: Number(r.x) || 0, y: Number(r.y) || 0, w: Number(r.w) || 0, h: Number(r.h) || 0 };
  const clean = (value: unknown, max: number) => text(value, max).replace(/`/g, "'");
  switch (data.type) {
    case 'ready': return { type: 'ready' };
    case 'console': {
      const level = ['log', 'info', 'warn', 'error'].includes(String(data.level)) ? data.level as 'log' : 'log';
      return { type: 'console', level, text: text(data.text, 2000) };
    }
    case 'select': return { type: 'select', selector: clean(data.selector, 300), html: clean(data.html, 4000), text: clean(data.text, 300), rect };
    case 'text': return { type: 'text', text: clean(data.text, 2000), rect };
    default: return null;
  }
}

export const selectCommand = (on: boolean) => ({ [COMMAND_TAG]: 'select', on });
