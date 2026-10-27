import { spawnSync } from 'node:child_process';

export function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(`ffmpeg exited ${r.status}: ${(r.stderr || '').slice(-3000)}`);
  return r.stderr;
}

export function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

export const durationOf = file => Number(probe(file).format.duration);
