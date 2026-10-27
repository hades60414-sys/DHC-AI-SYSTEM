// One-time (idempotent) setup of the studio home: pinned npm packages installed without lifecycle scripts, plus licensed assets
// from assets.json verified by sha256. Rerun any time; finished pieces are skipped.
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { SKILL, HOME } from './env.mjs';
import { generateSounds, LIBRARY } from './audio-gen.mjs';

const PACKAGES = { gsap: '3.15.0', 'playwright-core': '1.63.0', 'lucide-static': '1.49.0' };
const TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

const sha256 = f => createHash('sha256').update(readFileSync(f)).digest('hex');

async function download(url, dest) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(`${dest}.part`));
  renameSync(`${dest}.part`, dest);
}

export async function setup() {
  mkdirSync(HOME, { recursive: true });
  const pkgFile = path.join(HOME, 'package.json');
  const want = { name: 'video-studio-home', private: true, dependencies: PACKAGES };
  const have = existsSync(pkgFile) ? readFileSync(pkgFile, 'utf8') : '';
  if (have !== JSON.stringify(want, null, 2) || !existsSync(path.join(HOME, 'node_modules', 'gsap'))) {
    writeFileSync(pkgFile, JSON.stringify(want, null, 2));
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const r = spawnSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact'], { cwd: HOME, stdio: 'inherit', shell: true });
    if (r.status !== 0) throw new Error('npm install failed');
  }
  console.log(`packages: ${Object.entries(PACKAGES).map(([k, v]) => `${k}@${v}`).join(', ')}`);

  const manifest = JSON.parse(readFileSync(path.join(SKILL, 'assets.json'), 'utf8'));
  const dir = path.join(HOME, 'assets');
  mkdirSync(dir, { recursive: true });
  let fetched = 0;
  for (const a of manifest.assets) {
    const target = path.join(dir, a.path);
    if (existsSync(target) && (!a.sha256 || sha256(target) === a.sha256)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    if (a.extract) {
      const tmp = path.join(dir, '_downloads', path.basename(new URL(a.url).pathname));
      mkdirSync(path.dirname(tmp), { recursive: true });
      if (!existsSync(tmp) || (a.archiveSha256 && sha256(tmp) !== a.archiveSha256)) await download(a.url, tmp);
      if (a.archiveSha256 && sha256(tmp) !== a.archiveSha256) throw new Error(`checksum mismatch: ${a.url}`);
      const r = spawnSync(TAR, ['-xf', tmp, '-C', path.dirname(target), a.extract], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`extract ${a.extract} from ${tmp}: ${r.stderr}`);
      const extracted = path.join(path.dirname(target), a.extract);
      if (extracted !== target) renameSync(extracted, target);
    } else {
      await download(a.url, target);
    }
    if (a.sha256 && sha256(target) !== a.sha256) throw new Error(`checksum mismatch: ${a.path}`);
    fetched++;
  }
  const generated = await generateSounds();
  writeFileSync(path.join(dir, 'LICENSES.md'), ['# Asset licenses', '',
    ...manifest.assets.map(a => `- ${a.path}: ${a.license} (${a.source})`),
    ...LIBRARY.map(([f]) => `- gen/${f}: generated locally by video-studio runtime/synth.js (no third-party material)`)].join('\n'));
  console.log(`assets: ${manifest.assets.length} in ${dir} (${fetched} fetched now); generated sounds: ${LIBRARY.length} (${generated} rendered now)`);
}
