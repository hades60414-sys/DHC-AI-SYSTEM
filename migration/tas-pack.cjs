// TAS mover: copy folder trees between machines through the public assets mailbox, encrypted.
//   node tas-pack.cjs pack <id> <outDir> <srcRoot> <rel> [<rel>...] [--exclude <regex>] [--since <iso>]
//       Walks <srcRoot>\<rel>, writes encrypted chunks <id>-NNN.bin and manifest <id>.json into <outDir>,
//       prints the hex key (keep it off the mailbox).
//   node tas-pack.cjs unpack <baseUrl> <id> <hexKey> <destRoot>
//       Downloads <baseUrl>/<id>.json and every chunk, checks hashes, decrypts and writes files under <destRoot>,
//       then checks every file's size against the manifest. Rerunnable: finished chunks are cached in <destRoot>\.tas-pack\.
// Stream format inside the decrypted chunks: repeated [uint32 header length][header JSON {p, s, m}][s bytes].
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHUNK = Number(process.env.TAS_CHUNK) || 64 * 1024 * 1024;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function* walk(root, rel, exclude, since) {
  const abs = path.join(root, rel);
  let st;
  try { st = fs.lstatSync(abs); } catch { return; }
  if (st.isSymbolicLink()) return;
  if (exclude && exclude.test(rel.replace(/\\/g, '/'))) return;
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(abs)) yield* walk(root, path.join(rel, n), exclude, since);
  } else if (st.isFile() && (!since || st.mtimeMs >= since)) {
    yield { rel, size: st.size, mtime: st.mtimeMs };
  }
}

function pack(id, outDir, srcRoot, rels, exclude, since) {
  const key = crypto.randomBytes(32);
  const manifest = { id, created: new Date().toISOString(), srcRoot, chunks: [], files: [], skipped: [] };
  let buf = [], len = 0;
  const flush = () => {
    if (!len) return;
    const plain = Buffer.concat(buf, len);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const out = Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
    const name = `${id}-${String(manifest.chunks.length).padStart(3, '0')}.bin`;
    fs.writeFileSync(path.join(outDir, name), out);
    manifest.chunks.push({ name, bytes: out.length, sha256: sha(out) });
    buf = []; len = 0;
  };
  const push = (b) => { buf.push(b); len += b.length; if (len >= CHUNK) flush(); };
  for (const rel of rels) {
    for (const f of walk(srcRoot, rel, exclude, since)) {
      let data;
      try { data = fs.readFileSync(path.join(srcRoot, f.rel)); } catch (e) { manifest.skipped.push({ p: f.rel, err: e.code }); continue; }
      const p = f.rel.replace(/\\/g, '/');
      const h = Buffer.from(JSON.stringify({ p, s: data.length, m: f.mtime }));
      const n = Buffer.alloc(4); n.writeUInt32LE(h.length);
      push(n); push(h);
      for (let o = 0; o < data.length; o += CHUNK) push(data.subarray(o, o + CHUNK));
      manifest.files.push({ p, s: data.length });
    }
  }
  flush();
  fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(manifest));
  const total = manifest.files.reduce((a, f) => a + f.s, 0);
  console.log(JSON.stringify({ id, files: manifest.files.length, bytes: total, chunks: manifest.chunks.length, skipped: manifest.skipped.length }));
  console.log('KEY ' + key.toString('hex'));
}

async function get(url) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= 5) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

async function unpack(baseUrl, id, hexKey, destRoot) {
  const key = Buffer.from(hexKey, 'hex');
  const cache = path.join(destRoot, '.tas-pack', id);
  fs.mkdirSync(cache, { recursive: true });
  const manifest = JSON.parse(await get(`${baseUrl}/${id}.json`));
  // Parser state survives chunk boundaries: a file or header may straddle two chunks.
  let pending = Buffer.alloc(0), cur = null, fd = null, left = 0;
  const open = (h) => {
    const abs = path.resolve(destRoot, ...h.p.split('/'));
    if (!abs.startsWith(path.resolve(destRoot))) throw new Error('path escapes destRoot: ' + h.p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    cur = { ...h, abs }; fd = fs.openSync(abs, 'w'); left = h.s;
  };
  const close = () => { fs.closeSync(fd); const t = new Date(cur.m); fs.utimesSync(cur.abs, t, t); cur = null; fd = null; };
  for (const ch of manifest.chunks) {
    const local = path.join(cache, ch.name + '.ok');
    let enc;
    if (fs.existsSync(local)) enc = fs.readFileSync(local);
    else {
      enc = await get(`${baseUrl}/${ch.name}`);
      if (sha(enc) !== ch.sha256) throw new Error(`hash mismatch ${ch.name}`);
      fs.writeFileSync(local, enc);
    }
    const d = crypto.createDecipheriv('aes-256-gcm', key, enc.subarray(0, 12));
    d.setAuthTag(enc.subarray(enc.length - 16));
    let b = Buffer.concat([pending, d.update(enc.subarray(12, enc.length - 16)), d.final()]);
    pending = Buffer.alloc(0);
    while (b.length) {
      if (cur) {
        const take = Math.min(left, b.length);
        fs.writeSync(fd, b, 0, take); left -= take; b = b.subarray(take);
        if (!left) close();
        continue;
      }
      if (b.length < 4) { pending = b; break; }
      const n = b.readUInt32LE(0);
      if (b.length < 4 + n) { pending = b; break; }
      open(JSON.parse(b.subarray(4, 4 + n).toString()));
      b = b.subarray(4 + n);
      if (!left) close();
    }
    console.log(`chunk ${ch.name} ok`);
  }
  if (cur || pending.length) throw new Error('stream ended mid-file');
  const bad = manifest.files.filter((f) => {
    try { return fs.statSync(path.join(destRoot, ...f.p.split('/'))).size !== f.s; } catch { return true; }
  });
  console.log(JSON.stringify({ id, files: manifest.files.length, bad: bad.length, skippedAtSource: manifest.skipped.length }));
  if (bad.length) { console.log(bad.slice(0, 20).map((f) => f.p).join('\n')); process.exit(1); }
  fs.rmSync(cache, { recursive: true, force: true });
}

const [cmd, ...a] = process.argv.slice(2);
const opt = (name) => { const i = a.indexOf(name); if (i < 0) return null; const v = a[i + 1]; a.splice(i, 2); return v; };
if (cmd === 'pack') {
  const ex = opt('--exclude'), since = opt('--since');
  const [id, outDir, srcRoot, ...rels] = a;
  pack(id, outDir, srcRoot, rels, ex && new RegExp(ex, 'i'), since && Date.parse(since));
} else if (cmd === 'unpack') {
  unpack(...a).catch((e) => { console.error('FAILED ' + e.message); process.exit(1); });
} else {
  console.error('usage: pack <id> <outDir> <srcRoot> <rel...> [--exclude re] [--since iso] | unpack <baseUrl> <id> <hexKey> <destRoot>');
  process.exit(2);
}
