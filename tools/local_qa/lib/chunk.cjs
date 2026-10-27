'use strict';
// Chunkers. Two modes:
//  1) "corpus-like" markdown: front matter (--- ... ---) + body split on level-2 (## ) headings.
//     This replicates experiments/task_design_20260926/rag/build_chunks.cjs exactly (same id format,
//     same metadata fields) so that ingesting the synthetic benchmark corpus reproduces its canonical
//     chunk_ids. Oversized sections are further split (build_chunks.cjs errors instead; here we must not
//     crash on a user's own documents), suffixed "-2", "-3", ... on the section number.
//  2) generic: any other .md / .txt / .docx text. Split on markdown headings if present (paragraph packing);
//     else on 「第X條」 lines when there are at least 2 (2026-10-01), else one section; those two pack by line.
//     Capped at ~450 chars per chunk.
const MAX_CHARS = 450;

function parseFrontMatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v === 'null' || v === '') v = null;
    else if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (/^\d+$/.test(v) && k === 'level') v = Number(v);
    meta[k] = v;
  }
  if (!meta.doc_id) return null;
  return { meta, body: m[2] };
}

function splitParagraphs(text) {
  return text.split(/\r?\n\s*\r?\n/).map(p => p.trim()).filter(Boolean);
}

// Greedy-pack paragraphs into chunks <= MAX_CHARS; a single paragraph longer than the cap is hard-sliced.
function packParagraphs(paragraphs, cap = MAX_CHARS) {
  const out = [];
  let cur = '';
  for (const p of paragraphs) {
    const candidate = cur ? cur + '\n\n' + p : p;
    if ([...candidate].length <= cap) { cur = candidate; continue; }
    if (cur) { out.push(cur); cur = ''; }
    if ([...p].length <= cap) { cur = p; continue; }
    // hard-slice an oversized paragraph
    const chars = [...p];
    for (let i = 0; i < chars.length; i += cap) out.push(chars.slice(i, i + cap).join(''));
  }
  if (cur) out.push(cur);
  return out;
}

function splitOversizeSection(text, cap = MAX_CHARS) {
  const heading = text.split(/\r?\n/)[0];
  const rest = text.split(/\r?\n/).slice(1).join('\n').trim();
  const parts = packParagraphs(splitParagraphs(rest), cap - [...heading].length - 1);
  if (!parts.length) return [text];
  return parts.map((p, i) => i === 0 ? heading + '\n' + p : heading + '（續）\n' + p);
}

// Returns null if the file is not corpus-like (no usable front matter).
function chunkCorpusLikeMarkdown(raw, docIdFallback) {
  const fm = parseFrontMatter(raw);
  if (!fm) return null;
  const { meta, body } = fm;
  const parts = body.split(/\r?\n(?=## )/);
  parts.shift(); // drop title / preamble before the first "## " section
  const chunks = [];
  const metadata = {
    doc_no: meta.doc_no || meta.doc_id, title: meta.title || meta.doc_id, doc_type: meta.doc_type || null,
    level: meta.level ?? null, version: meta.version || null, status: meta.status || null,
    publish_date: meta.publish_date || null, effective_date: meta.effective_date || null,
    repealed_date: meta.repealed_date || null, owner: meta.owner || null, synthetic: meta.synthetic ?? false,
  };
  parts.forEach((raw2, idx) => {
    const text = raw2.trim();
    const heading = text.split(/\r?\n/)[0].replace(/^##\s*/, '');
    const base = `${meta.doc_id}#${String(idx + 1).padStart(2, '0')}`;
    if ([...text].length <= MAX_CHARS) {
      chunks.push({ chunk_id: base, doc_id: meta.doc_id, section: heading, text, metadata });
    } else {
      const subs = splitOversizeSection(text);
      subs.forEach((sub, j) => chunks.push({ chunk_id: subs.length > 1 ? `${base}-${j + 1}` : base, doc_id: meta.doc_id, section: heading, text: sub, metadata }));
    }
  });
  return chunks;
}

// Generic .md/.txt: split on markdown headings (#, ##, ###) if present, else blank-line paragraphs.
// 2026-10-01：沒有 markdown 標題的 .txt／.docx（公司規章多半只打「第X條」、沒用標題樣式）依條切段，段名＝「第X條」加短標題，
// 「第X章／編／節」那行併到下一條開頭；至少 2 條才啟用。這類文件改成依行打包（docx 段落之間沒有空行，原本整份每 450 字硬切）。
// 與 gemma-offline/agent-channel/DocQa.cs 相同；make-chunk-parity.cjs 產生 chunk-parity.json 給 C# 測試比對。
// 「第 2-1 條」是全國法規資料庫的寫法；條號後面接「、」多半是內文引用（「第七條、第八條之規定…」），不算新的一條
const ARTICLE_RE = /^[ \t　]*(第[ \t　]*[〇零一二三四五六七八九十百千０-９0-9]+(?:[-－][０-９0-9]+)?[ \t　]*條(?:之[一二三四五六七八九十０-９0-9]+)?)(?=$|[ \t　（(【：:])[ \t　]*(.*)$/;
const CHAPTER_RE = /^[ \t　]*第[ \t　]*[〇零一二三四五六七八九十百千０-９0-9]+[ \t　]*[章編節](?=$|[ \t　（(【：:])/;
const MAX_SECTION_CHARS = 200;
const capText = (s, max) => (s != null && s.length > max ? s.slice(0, max) : s);
function articleLabel(m) {
  const label = m[1].replace(/[ \t　]+/g, '');
  const rest = m[2].trim();
  const paren = rest.match(/^[（(【][^）)】]{1,20}[）)】]/);
  if (paren) return label + paren[0];
  if (rest.length > 0 && rest.length <= 20 && !/[。，；：、,;:]/.test(rest)) return label + ' ' + rest;
  return label;
}
function articleSections(text, title) {
  const lines = text.split(/\r?\n/);
  if (lines.filter(l => ARTICLE_RE.test(l)).length < 2) return null;
  const sections = [];
  let body = [], heading = title, pending = null;
  const flush = () => { const b = body.join('\n').trim(); if (b.length > 0) sections.push({ heading, body: b }); body = []; };
  for (const line of lines) {
    const m = line.match(ARTICLE_RE);
    if (m) { flush(); heading = capText(articleLabel(m), MAX_SECTION_CHARS); if (pending !== null) { body.push(pending); pending = null; } body.push(line); }
    else if (CHAPTER_RE.test(line)) pending = pending === null ? line.trim() : pending + '\n' + line.trim();
    else body.push(line);
  }
  if (pending !== null) body.push(pending);
  flush();
  return sections;
}
function packLines(text, cap = MAX_CHARS) {
  const out = [];
  let cur = '';
  for (const raw of text.split(/\r?\n/)) {
    const ln = raw.trimEnd();
    if (ln.trim().length === 0) continue;
    if (cur.length > 0 && cur.length + 1 + ln.length <= cap) { cur += '\n' + ln; continue; }
    if (ln.length <= cap) { if (cur.length > 0) out.push(cur); cur = ln; continue; }
    // 超長的一行：前面累積的（例如「第五條 計算」那行）接在它前面一起每 cap 字切，最後一截留著接後面的行
    const s = cur.length > 0 ? cur + '\n' + ln : ln;
    let i = 0;
    for (; s.length - i > cap; i += cap) out.push(s.slice(i, i + cap));
    cur = s.slice(i);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function chunkGeneric(text, docId, title) {
  text = text.replace(/^﻿/, '');   // Node 讀 .txt 不會去掉 BOM（C# 讀檔時會），否則第一行的「第一條」認不出來
  const metadata = { doc_no: docId, title: title || docId, doc_type: null, level: null, version: null, status: null, publish_date: null, effective_date: null, repealed_date: null, owner: null, synthetic: false };
  const hasHeadings = /^#{1,6}\s+\S/m.test(text);
  let sections, byLines = false;
  if (hasHeadings) {
    const parts = text.split(/\r?\n(?=#{1,6}\s)/).map(s => s.trim()).filter(Boolean);
    sections = parts.map(p => ({ heading: p.split(/\r?\n/)[0].replace(/^#{1,6}\s*/, ''), body: p }));
  } else {
    sections = articleSections(text, capText(title || docId, MAX_SECTION_CHARS)) || [{ heading: title || docId, body: text }];
    byLines = true;
  }
  const chunks = [];
  let n = 0;
  for (const sec of sections) {
    const parts = byLines ? packLines(sec.body) : packParagraphs(splitParagraphs(sec.body));
    parts.forEach(p => { n++; chunks.push({ chunk_id: `${docId}#${String(n).padStart(2, '0')}`, doc_id: docId, section: sec.heading, text: p, metadata }); });
  }
  return chunks;
}

module.exports = { MAX_CHARS, parseFrontMatter, chunkCorpusLikeMarkdown, chunkGeneric, packParagraphs, splitParagraphs, articleSections, packLines };
