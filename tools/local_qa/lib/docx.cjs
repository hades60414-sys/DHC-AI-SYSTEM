'use strict';
// Extract plain text (with paragraph breaks) from a .docx file: docx = zip; word/document.xml is WordprocessingML.
const fs = require('node:fs');
const zip = require('./zip.cjs');

function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function extractText(filePath) {
  const buf = fs.readFileSync(filePath);
  const entries = zip.readEntries(buf, ['word/document.xml']);
  const xml = entries['word/document.xml'];
  if (!xml) throw Error('docx_missing_document_xml:' + filePath);
  return xmlToText(xml.toString('utf8'));
}

function xmlToText(s) {
  s = s.replace(/<w:tab\/>/g, '\t');
  // 2026-10-01：表格一列一行、儲存格用 " | " 隔開（原本每格各一行，限額表之類的列關係會散掉）；與 DocQa.ExtractDocxText 相同
  s = s.replace(/<\/w:p>\s*<\/w:tc>/g, '</w:tc>');
  s = s.replace(/<\/w:tc>/g, ' | ');
  s = s.replace(/<\/w:p>/g, '\n');           // paragraph break
  s = s.replace(/<\/w:tr>/g, '\n');           // table row break
  s = s.replace(/<[^>]+>/g, '');              // strip all remaining tags (runs, formatting, etc.)
  s = decodeEntities(s);
  return s.split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { extractText, xmlToText };
