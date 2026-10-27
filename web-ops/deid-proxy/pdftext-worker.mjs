// Worker thread for pdftext.cjs: pulls the text layer out of a PDF with Mozilla's pdf.js, so a big file never blocks
// the proxy's event loop. Gets { id, data (base64) }, answers { id, kind, pages, text } or { id, kind: 'error', why }.
// kind 'text': every page either has text or is blank. kind 'scan': some page has an image but no text (a scan),
// so the text alone would leave content out.
import { parentPort } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.join(here, 'node_modules', 'pdfjs-dist');
const pdfjs = await import(pathToFileURL(path.join(lib, 'legacy', 'build', 'pdf.mjs')).href);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(lib, 'legacy', 'build', 'pdf.worker.mjs')).href;
// Chinese PDFs use CID fonts; their character maps ship with the package. pdf.js wants forward slashes and a trailing one.
const CMAPS = path.join(lib, 'cmaps').replace(/\\/g, '/') + '/';
const FONTS = path.join(lib, 'standard_fonts').replace(/\\/g, '/') + '/';
const MIN_CHARS = 10;

async function extract(data) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(Buffer.from(data, 'base64')), cMapUrl: CMAPS, cMapPacked: true, standardFontDataUrl: FONTS,
    isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pages = [];
    let scanned = false;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('').replace(/[ \t]+\n/g, '\n').trim();
      if (text.replace(/\s/g, '').length < MIN_CHARS) {
        const ops = await page.getOperatorList();
        const OPS = pdfjs.OPS;
        if (ops.fnArray.some((f) => f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject || f === OPS.paintImageXObjectRepeat)) scanned = true;
      }
      pages.push(text);
      page.cleanup();
    }
    return { kind: scanned ? 'scan' : 'text', pages: doc.numPages, text: pages.map((t, i) => `--- 第 ${i + 1} 頁 ---\n${t}`).join('\n\n') };
  } finally { await task.destroy(); }
}

parentPort.on('message', async ({ id, data }) => {
  try { parentPort.postMessage({ id, ...(await extract(data)) }); }
  catch (e) { parentPort.postMessage({ id, kind: 'error', why: String(e && e.message || e) }); }
});
