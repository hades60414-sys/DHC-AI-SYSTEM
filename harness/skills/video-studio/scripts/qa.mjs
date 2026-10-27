#!/usr/bin/env node
// Usage: node qa.mjs <video.mp4> [--timeline build/timeline.json] [--srt final.srt] [--out dir] [--lufs=-16]
// Exit 1 when any check FAILs. Writes report.json and contact.jpg (20 evenly spaced frames, left-to-right, top-to-bottom).
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ffmpeg, probe } from './ff.mjs';

const { values: opt, positionals: [file] } = parseArgs({
  allowPositionals: true,
  options: { timeline: { type: 'string' }, srt: { type: 'string' }, out: { type: 'string' }, lufs: { type: 'string', default: '-16' } },
});
if (!file) {
  console.error('usage: node qa.mjs <video.mp4> [--timeline f] [--srt f] [--out dir] [--lufs=-16]');
  process.exit(2);
}
const out = opt.out ?? path.join(path.dirname(file), 'qa');
mkdirSync(out, { recursive: true });

const checks = [];
const check = (name, ok, value, expect, soft = false) =>
  checks.push({ name, status: ok ? 'PASS' : soft ? 'WARN' : 'FAIL', value, expect });

const info = probe(file);
const v = info.streams.find(s => s.codec_type === 'video');
const a = info.streams.find(s => s.codec_type === 'audio');
const dur = Number(info.format.duration);

check('影像編碼', v?.codec_name === 'h264' && v?.pix_fmt === 'yuv420p', `${v?.codec_name}/${v?.pix_fmt}`, 'h264/yuv420p');
check('影像規格', !!v, `${v?.width}x${v?.height} @ ${v?.r_frame_rate}`, '記錄用');
const colors = [v?.color_space, v?.color_primaries, v?.color_transfer];
check('色彩標記', colors.every(c => c === 'bt709'), colors.join('/'), 'bt709/bt709/bt709');
check('聲音編碼', a?.codec_name === 'aac' && Number(a?.sample_rate) === 48000 && a?.channels === 2,
  a ? `${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch` : '沒有聲音', 'aac 48000Hz 2ch');
if (v && a) {
  const gap = Math.abs(Number(v.duration) - Number(a.duration));
  check('音畫長度差', gap < 0.1, `${gap.toFixed(3)} 秒`, '< 0.1 秒');
}
if (opt.timeline) {
  const tl = JSON.parse(readFileSync(opt.timeline, 'utf8'));
  check('總長對時間軸', Math.abs(dur - tl.duration) <= 0.15, `${dur.toFixed(2)} vs ${tl.duration.toFixed(2)}`, '±0.15 秒');
}

const vf = 'blackdetect=d=0.4:pix_th=0.06,freezedetect=n=-60dB:d=3';
const af = 'ebur128=peak=true:framelog=verbose,silencedetect=n=-50dB:d=2';
const log = a
  ? ffmpeg(['-nostats', '-v', 'info', '-i', file, '-filter_complex', `[0:v]${vf}[v];[0:a]${af}[a]`, '-map', '[v]', '-map', '[a]', '-f', 'null', '-'])
  : ffmpeg(['-nostats', '-v', 'info', '-i', file, '-vf', vf, '-f', 'null', '-']);

const inside = (s, e, head, tail) => s > head && e < dur - tail;
for (const m of log.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)) {
  const [s, e, d] = m.slice(1).map(Number);
  if (inside(s, e, 0.6, 1.2)) check('黑畫面', d <= 1.5, `${s.toFixed(1)}–${e.toFixed(1)} 秒`, '片中不該有黑畫面', d <= 1.5);
}
const freezeStarts = [...log.matchAll(/freeze_start: ([\d.]+)/g)].map(m => Number(m[1]));
const freezeDurs = [...log.matchAll(/freeze_duration: ([\d.]+)/g)].map(m => Number(m[1]));
freezeStarts.forEach((s, i) => {
  const d = freezeDurs[i] ?? dur - s;
  check('畫面靜止', false, `${s.toFixed(1)} 秒起 ${d.toFixed(1)} 秒`, '每個畫面都要有細微動態', true);
});
const silStarts = [...log.matchAll(/silence_start: (-?[\d.]+)/g)].map(m => Number(m[1]));
const silEnds = [...log.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
silStarts.forEach((s, i) => {
  const [e, d] = silEnds[i] ?? [dur, dur - s];
  if (inside(s, e, 1.0, 2.0)) check('片中無聲', false, `${s.toFixed(1)}–${e.toFixed(1)} 秒（${d.toFixed(1)} 秒）`, '音樂或旁白不中斷', true);
});
if (a) {
  const summary = log.slice(log.lastIndexOf('Summary:'));
  const I = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
  const peak = summary.match(/Peak:\s+(-?[\d.]+|-inf) dBFS/)?.[1];
  const target = Number(opt.lufs);
  check('整體響度', Math.abs(I - target) <= 1, `${I} LUFS`, `${target} ±1 LUFS`);
  check('真峰值', Number(peak) <= -1, `${peak} dBTP`, '≤ -1 dBTP');
}

if (opt.srt) {
  const toSec = t => { const [h, m, s] = t.replace(',', '.').split(':').map(Number); return h * 3600 + m * 60 + s; };
  const cues = readFileSync(opt.srt, 'utf8').replace(/\r/g, '').trim().split(/\n\n+/).map(b => {
    const lines = b.split('\n');
    const [s, e] = lines[1].split(' --> ').map(toSec);
    return { s, e, lines: lines.slice(2) };
  });
  cues.forEach((c, i) => {
    const text = c.lines.join('');
    const where = `${c.s.toFixed(1)} 秒「${text.slice(0, 12)}」`;
    if (i && c.s < cues[i - 1].e - 0.001) check('字幕重疊', false, where, '前一句結束後才出現');
    if (c.e - c.s < 0.8) check('字幕太短', false, where, '≥ 0.8 秒', true);
    if (text.length / (c.e - c.s) > 8) check('字幕太快', false, where, '≤ 8 字／秒', true);
    if (c.lines.some(l => l.length > 24)) check('字幕太長', false, where, '每行 ≤ 24 字', true);
  });
  check('字幕結尾', cues.at(-1).e <= dur + 0.1, `${cues.at(-1).e.toFixed(2)} 秒`, `≤ 影片長度 ${dur.toFixed(2)}`);
}

const sheet = path.join(out, 'contact.jpg');
ffmpeg(['-y', '-v', 'error', '-i', file, '-vf', `fps=20/${dur.toFixed(3)},scale=384:-2,tile=5x4:padding=4:color=0x111111`,
  '-frames:v', '1', '-q:v', '3', sheet]);

const count = s => checks.filter(c => c.status === s).length;
const report = { file: path.resolve(file), duration: dur, contactSheet: sheet, tileSeconds: dur / 20, checks };
writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(`品管：PASS ${count('PASS')}、WARN ${count('WARN')}、FAIL ${count('FAIL')}（${dur.toFixed(2)} 秒）`);
for (const c of checks) if (c.status !== 'PASS') console.log(`${c.status} ${c.name}：${c.value}（標準 ${c.expect}）`);
console.log(`縮圖總表：${sheet}（每格間隔 ${(dur / 20).toFixed(2)} 秒）`);
process.exit(count('FAIL') ? 1 : 0);
