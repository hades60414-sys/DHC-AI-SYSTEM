// Frame-accurate renderer. Serves the project over localhost, seeks the in-page GSAP master timeline frame by frame in
// headless Chrome, and pipes PNG frames to ffmpeg. Workers render contiguous frame ranges in parallel; segments are
// concatenated without re-encoding. --blur N averages N sub-frames per frame (180-degree shutter) for motion blur.
import http from 'node:http';
import { createReadStream, existsSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { SKILL, HOME } from './env.mjs';
import { ffmpeg } from './ff.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.lottie': 'application/json',
};

export function serve(projectDir) {
  const mounts = [['/studio/', path.join(SKILL, 'runtime')], ['/vendor/', path.join(HOME, 'node_modules')],
    ['/assets/', path.join(HOME, 'assets')], ['/', projectDir]].map(([prefix, root]) => [prefix, path.resolve(root)]);
  const server = http.createServer((req, res) => {
    let url = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.endsWith('/')) url += 'index.html';
    const [prefix, root] = mounts.find(([p]) => url.startsWith(p));
    const file = path.join(root, url.slice(prefix.length));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end(`not found: ${url}`);
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

async function launch() {
  const { chromium } = createRequire(path.join(HOME, 'package.json'))('playwright-core');
  return chromium.launch({ channel: 'chrome', headless: true, args: ['--force-color-profile=srgb', '--hide-scrollbars', '--font-render-hinting=none'] });
}

const PNG = { format: 'png', optimizeForSpeed: true };
const JPEG = { format: 'jpeg', quality: 90, optimizeForSpeed: true };

async function openPage(browser, url, canvas, scale, capture = PNG) {
  const page = await browser.newPage({ viewport: { width: canvas.width, height: canvas.height }, deviceScaleFactor: scale });
  const problems = [];
  page.on('pageerror', e => problems.push(e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push(`${m.text()} ${m.location()?.url ?? ''}`); });
  page.on('requestfailed', r => problems.push(`request failed: ${r.url()}`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`); });
  await page.goto(url);
  await page.waitForFunction(() => window.__studio?.ready || window.__studioError, null, { timeout: 90000 });
  const err = await page.evaluate(() => window.__studioError);
  if (err || problems.length) throw new Error(`page failed to boot:\n${[err, ...problems].filter(Boolean).join('\n')}`);
  const cdp = await page.context().newCDPSession(page);
  const shot = async () => Buffer.from((await cdp.send('Page.captureScreenshot', capture)).data, 'base64');
  const seek = t => page.evaluate(x => window.__studio.seek(x), t);
  return { page, shot, seek };
}

function encoder(out, fps, blur, inputCodec) {
  const vf = blur > 1 ? [`tmix=frames=${blur}`, `select='not(mod(n+1,${blur}))'`, `setpts=N/(${fps}*TB)`] : [];
  // ffmpeg 9 lets per-frame color properties override encoder flags, so tag the frames themselves.
  vf.push('scale=out_color_matrix=bt709:out_range=tv', 'format=yuv420p', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv');
  const ff = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(fps * blur), '-c:v', inputCodec, '-i', '-',
    '-vf', vf.join(','), '-r', String(fps), '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-tune', 'animation', '-x264-params', 'aq-mode=3',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', out], { stdio: ['pipe', 'ignore', 'pipe'] });
  let log = '';
  ff.stderr.on('data', d => { log += d; });
  return {
    async write(buf) { if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain'); },
    async close() {
      ff.stdin.end();
      const [code] = await once(ff, 'close');
      if (code !== 0) throw new Error(`ffmpeg exited ${code} for ${out}: ${log.slice(-2000)}`);
    },
  };
}

// Each worker (browser + GPU process + x264) commits about 2.5 GB at 1080p. On Windows, cap workers so at least 3 GB of
// commit stays free for the rest of the machine; exhausting it crashes unrelated processes (0x800705AF / 0xC000012D).
function capWorkers(requested) {
  if (process.platform !== 'win32') return requested;
  const r = spawnSync('typeperf', ['\\Memory\\Committed Bytes', '\\Memory\\Commit Limit', '-sc', '1'], { encoding: 'utf8' });
  const row = (r.stdout ?? '').split('\n').find(l => /^"\d/.test(l));
  if (!row) return requested;
  const [, used, limit] = row.split(',').map(v => Number(v.replace(/"/g, '')));
  const cap = Math.max(1, Math.floor((limit - used - 3e9) / 2.5e9));
  if (cap < requested) console.log(`render: ${requested} workers would exhaust memory (${((limit - used) / 1e9).toFixed(1)} GB commit free); using ${cap}`);
  return Math.min(requested, cap);
}

const loadTimeline = p => {
  const f = path.join(p.build, 'timeline.json');
  if (!existsSync(f)) throw new Error('build/timeline.json missing: run voice and timeline first');
  return JSON.parse(readFileSync(f, 'utf8'));
};

export async function render(p, flags = {}) {
  const tl = loadTimeline(p);
  const { fps } = tl.canvas;
  const workers = capWorkers(Math.max(1, Number(flags.workers ?? 6)));
  const draft = !!flags.draft;
  const blur = draft ? 1 : Math.max(1, Number(flags.blur ?? 1));
  const scale = Number(flags.scale ?? 1);
  const total = Math.round(tl.duration * fps);
  const from = flags.from ? Math.round(Number(flags.from) * fps) : 0;
  const to = flags.to ? Math.min(total, Math.round(Number(flags.to) * fps)) : total;
  const segDir = path.join(p.build, 'segments');
  mkdirSync(segDir, { recursive: true });

  const { server, url } = await serve(p.dir);
  // One browser per worker: pages sharing a browser serialize their screenshots through one GPU process.
  const browsers = [];
  const started = Date.now();
  let done = 0;
  const ticker = setInterval(() => {
    const s = (Date.now() - started) / 1000, rate = done / s;
    console.log(`render ${done}/${to - from} frames, ${rate.toFixed(1)} fps, eta ${Math.round((to - from - done) / Math.max(rate, 0.01))}s`);
  }, 10000);
  try {
    const per = Math.ceil((to - from) / workers);
    const ranges = Array.from({ length: workers }, (_, i) => [from + i * per, Math.min(to, from + (i + 1) * per)]).filter(([a, b]) => b > a);
    const segments = await Promise.all(ranges.map(async ([a, b], i) => {
      const out = path.join(segDir, `seg-${String(i).padStart(2, '0')}.mp4`);
      const browser = await launch();
      browsers.push(browser);
      const { page, shot, seek } = await openPage(browser, url, tl.canvas, scale, draft ? JPEG : PNG);
      const enc = encoder(out, fps, blur, draft ? 'mjpeg' : 'png');
      for (let f = a; f < b; f++) {
        for (let k = 0; k < blur; k++) {
          await seek(blur > 1 ? Math.max(0, (f + ((k + 0.5) / blur) * 0.5 - 0.25) / fps) : f / fps);
          await enc.write(await shot());
        }
        done++;
      }
      await enc.close();
      await page.close();
      return out;
    }));
    const list = path.join(segDir, 'list.txt');
    writeFileSync(list, segments.map(s => `file '${s.replace(/\\/g, '/')}'`).join('\n'));
    const out = path.join(p.build, 'video.mp4');
    ffmpeg(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
    const secs = (Date.now() - started) / 1000;
    console.log(`render: ${to - from} frames (${draft ? 'draft jpeg' : 'png'}, blur ${blur}, ${workers} workers) in ${secs.toFixed(1)}s -> ${out}`);
    return out;
  } finally {
    clearInterval(ticker);
    await Promise.all(browsers.map(b => b.close()));
    server.close();
  }
}

// Stills for review. Default: frame 0 (the usual thumbnail, where start-state bugs show), then each scene 0.8 s in and
// 0.3 s before its end; --at 1.5,7,12.2 for explicit seconds.
export async function preview(p, flags = {}) {
  const tl = loadTimeline(p);
  const times = flags.at
    ? String(flags.at).split(',').map(Number)
    : [0, ...tl.scenes.flatMap(s => [Math.min(s.start + 0.8, s.end), Math.max(s.start, s.end - 0.3)])];
  const dir = path.join(p.build, 'preview');
  mkdirSync(dir, { recursive: true });
  const { server, url } = await serve(p.dir);
  const browser = await launch();
  try {
    const { shot, seek } = await openPage(browser, url, tl.canvas, 1);
    const files = [];
    for (const t of times) {
      await seek(t);
      const f = path.join(dir, `t${t.toFixed(2).padStart(6, '0')}.png`);
      writeFileSync(f, await shot());
      files.push(f);
    }
    const list = path.join(dir, 'list.txt');
    writeFileSync(list, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    const cols = Math.min(4, files.length), rows = Math.ceil(files.length / cols);
    const sheet = path.join(dir, 'sheet.jpg');
    ffmpeg(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=480:-2,tile=${cols}x${rows}:padding=4:color=0x111111`,
      '-frames:v', '1', '-q:v', '3', sheet]);
    console.log(`preview: ${files.length} stills at ${times.map(t => t.toFixed(2)).join(', ')}s -> ${sheet}`);
    return { files, sheet };
  } finally {
    await browser.close();
    server.close();
  }
}
