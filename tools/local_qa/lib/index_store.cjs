'use strict';
// Ingest a folder of .md/.txt/.docx into indexes/<name>/index.json: chunks + metadata + embedding vectors.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('./paths.cjs');
const chunkLib = require('./chunk.cjs');
const docx = require('./docx.cjs');
const mc = require('./model_client.cjs');
const servers = require('./servers.cjs');

const SKIP_STEMS = new Set(['readme', 'index', 'corpus']); // navigation/index files, not policy content
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const docText = c => [c.doc_id, c.metadata.title || '', c.section, c.text].join('\n');

function listSourceFiles(folder) {
  const out = [];
  const entries = fs.readdirSync(folder, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!['.md', '.txt', '.docx'].includes(ext)) continue;
    const stem = path.basename(e.name, ext);
    if (SKIP_STEMS.has(stem.toLowerCase())) continue;
    const dir = e.path || e.parentPath || folder; // node versions differ in Dirent field name
    out.push(path.join(dir, e.name));
  }
  return out.sort();
}

// Keep CJK letters in ids (a \w-only filter turned every Chinese filename into underscores, so different files collided).
const stemOf = absPath => path.basename(absPath, path.extname(absPath)).replace(/[^\p{L}\p{N}_.\-]/gu, '_');

function fileToChunks(absPath, relPath, stem = stemOf(absPath)) {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.md') {
    const raw = fs.readFileSync(absPath, 'utf8');
    const corpusChunks = chunkLib.chunkCorpusLikeMarkdown(raw, stem);
    if (corpusChunks) return corpusChunks.map(c => ({ ...c, source_file: relPath }));
    return chunkLib.chunkGeneric(raw, stem, stem).map(c => ({ ...c, source_file: relPath }));
  }
  if (ext === '.txt') {
    const raw = fs.readFileSync(absPath, 'utf8');
    return chunkLib.chunkGeneric(raw, stem, stem).map(c => ({ ...c, source_file: relPath }));
  }
  if (ext === '.docx') {
    const raw = docx.extractText(absPath);
    return chunkLib.chunkGeneric(raw, stem, stem).map(c => ({ ...c, source_file: relPath }));
  }
  throw Error('unsupported_ext:' + ext);
}

// The same filename in two subfolders would give the same chunk ids; later ones get a ~2, ~3 suffix.
function chunkFiles(files, log = () => {}) {
  const chunks = [], seen = new Map(), ids = new Set();
  for (const f of files) {
    let stem = stemOf(f.abs); const n = (seen.get(stem) || 0) + 1; seen.set(stem, n); if (n > 1) stem += '~' + n;
    let part;
    try { part = fileToChunks(f.abs, f.rel, stem); } catch (e) { log(`  skip ${f.rel}: ${e.message}`); continue; }
    // Front-matter .md files are numbered by their doc_id, so two copies collide too: the later file gets ~2, ~3.
    for (let k = 2; part.some(c => ids.has(c.chunk_id)); k++) part = part.map(c => ({ ...c, chunk_id: c.chunk_id.replace(/(~\d+)?#/, '~' + k + '#') }));
    for (const c of part) ids.add(c.chunk_id);
    chunks.push(...part);
  }
  return chunks;
}

function indexPath(name) { return path.join(P.INDEX_DIR, name, 'index.json'); }

function manifestHashOf(files) {
  const rows = files.map(f => `${f.rel}:${f.sha256}`).sort();
  return sha256(Buffer.from(rows.join('\n'), 'utf8'));
}

async function ingest(folder, name, { force = false, log = () => {} } = {}) {
  folder = path.resolve(folder);
  if (!fs.existsSync(folder)) throw Error('folder_not_found:' + folder);
  const absFiles = listSourceFiles(folder);
  if (!absFiles.length) throw Error('no_supported_files_in:' + folder);
  const files = absFiles.map(abs => ({ abs, rel: path.relative(folder, abs), sha256: sha256(fs.readFileSync(abs)) }));
  const manifestHash = manifestHashOf(files);

  const outPath = indexPath(name);
  if (!force && fs.existsSync(outPath)) {
    const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    if (prev.manifest_hash === manifestHash) { log('no source changes, skipping rebuild'); return prev; }
  }

  log(`chunking ${files.length} file(s)...`);
  const chunks = chunkFiles(files, log);
  if (!chunks.length) throw Error('no_chunks_produced');
  log(`embedding ${chunks.length} chunk(s)...`);
  await servers.ensureAll();
  const vectors = await mc.embedPassages(chunks.map(docText));

  const out = {
    schema: 'local_qa_index_v1', name, source_folder: folder, created_at: new Date().toISOString(),
    manifest_hash: manifestHash, files, chunk_count: chunks.length,
    chunks: chunks.map(({ chunk_id, doc_id, section, text, metadata, source_file }) => ({ chunk_id, doc_id, section, text, metadata, source_file })),
    vectors,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out) + '\n');
  log(`wrote ${outPath}`);
  return out;
}

function load(name) {
  const p = indexPath(name);
  if (!fs.existsSync(p)) throw Error(`index_not_found:${name} (run: node qa.cjs ingest <folder> --name ${name})`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

module.exports = { ingest, load, indexPath, docText, listSourceFiles, chunkFiles };
