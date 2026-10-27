#!/usr/bin/env node
// video-studio CLI: node studio.mjs <command> <projectDir> [--flags]
// Commands: setup | init | voice | timeline | preview | render | mix | mux | qa | all
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ffmpeg, durationOf } from './ff.mjs';
import { SCRIPTS, SKILL, HOME } from './env.mjs';

const DEFAULTS = { lead: 0.35, pad: 0.45, overlap: 0.5, gap: 0.25, minSec: 3 };
const PUNCT = /[，。！？；：、,.!?;:]/;

export function loadProject(dir) {
  const sb = JSON.parse(readFileSync(path.join(dir, 'storyboard.json'), 'utf8'));
  const build = path.join(dir, 'build');
  mkdirSync(build, { recursive: true });
  return { dir: path.resolve(dir), sb, build };
}

export function asset(p, dir) {
  for (const base of [dir, path.join(HOME, 'assets')]) {
    const f = path.resolve(base, p);
    if (existsSync(f)) return f;
  }
  throw new Error(`asset not found: ${p} (looked in ${dir} and ${path.join(HOME, 'assets')})`);
}

// {cue:name} markers are stripped; lexicon swaps spoken forms (e.g. "RAG" -> "R A G") while subtitles keep the display text.
export function parseSay(raw, lexicon = {}) {
  let display = '';
  const cues = {};
  for (const part of raw.split(/(\{cue:[\w-]+\})/)) {
    const m = part.match(/^\{cue:([\w-]+)\}$/);
    if (m) cues[m[1]] = display.length;
    else display += part;
  }
  const keys = Object.keys(lexicon).sort((a, b) => b.length - a.length);
  let spoken = '';
  const toDisplay = [];
  for (let i = 0; i < display.length;) {
    const k = keys.find(key => display.startsWith(key, i));
    const piece = k ? lexicon[k] : display[i];
    for (let j = 0; j < piece.length; j++) toDisplay.push(i);
    spoken += piece;
    i += k ? k.length : 1;
  }
  toDisplay.push(display.length);
  return { display, spoken, cues, toDisplay };
}

const timeAt = (words, offset, dur) => words.find(w => w.offset >= offset)?.t ?? dur;

function subtitleCues(v, maxChars = 16, hardMax = 22) {
  const text = v.display;
  const tidy = (a, b) => text.slice(a, b).replace(/[，。、；：,.;:\s]+$/, '').replace(/[，、；：,;:]/g, ' ').trim();
  const chunks = [];
  let s = 0;
  for (let i = 0; i < text.length; i++) if (PUNCT.test(text[i])) { chunks.push([s, i + 1]); s = i + 1; }
  if (s < text.length) chunks.push([s, text.length]);
  const merged = [];
  for (const [a, b] of chunks) {
    if (!tidy(a, b)) continue;
    const last = merged.at(-1);
    if (last && !/[。！？!?]/.test(text[last[1] - 1]) && tidy(last[0], b).length <= maxChars) last[1] = b;
    else merged.push([a, b]);
  }
  const cues = merged.flatMap(([a, b]) => {
    if (tidy(a, b).length <= hardMax) return [[a, b]];
    const mid = (a + b) / 2;
    const cut = v.words.map(w => w.offset).filter(o => o > a + 2 && o < b - 2)
      .sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid))[0] ?? Math.round(mid);
    return [[a, cut], [cut, b]];
  });
  return cues.map(([a, b], i) => ({
    start: timeAt(v.words, a, v.duration),
    end: i < cues.length - 1 ? timeAt(v.words, cues[i + 1][0], v.duration) - 0.04 : v.duration + 0.25,
    text: tidy(a, b),
  }));
}

// ---------- voice ----------
const ENGINES = {
  winrt: async ({ spoken, voice, rate }, base) => {
    const txt = `${base}.txt`, wav = `${base}.wav`, meta = `${base}.words.json`;
    writeFileSync(txt, spoken, 'utf8');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'tts-winrt.ps1'),
      '-TextFile', txt, '-Voice', voice ?? 'Microsoft Yating', '-Out', wav, '-Meta', meta, '-Rate', String(rate ?? 1)], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`winrt tts failed: ${r.stderr || r.stdout}`);
    return { file: wav, words: JSON.parse(readFileSync(meta, 'utf8')) };
  },
};

export async function voice(p) {
  const vdir = path.join(p.build, 'voice');
  mkdirSync(vdir, { recursive: true });
  const cfg = p.sb.voice ?? { engine: 'winrt' };
  const out = {};
  for (const s of p.sb.scenes) {
    if (!s.say) continue;
    const parsed = parseSay(s.say, p.sb.lexicon);
    const opts = { ...cfg, ...s.voice, spoken: parsed.spoken };
    const key = createHash('sha1').update(JSON.stringify(opts)).digest('hex').slice(0, 16);
    const metaFile = path.join(vdir, `${key}.json`);
    if (!existsSync(metaFile)) {
      const r = await ENGINES[opts.engine](opts, path.join(vdir, key));
      writeFileSync(metaFile, JSON.stringify({ ...opts, file: r.file, words: r.words, duration: durationOf(r.file) }, null, 1));
    }
    const m = JSON.parse(readFileSync(metaFile, 'utf8'));
    const words = m.words.map(w => ({ ...w, offset: parsed.toDisplay[w.offset] ?? parsed.display.length }));
    out[s.id] = { file: m.file, duration: m.duration, display: parsed.display, cues: parsed.cues, words };
    console.log(`voice ${s.id}: ${m.duration.toFixed(2)}s ${opts.engine}/${opts.name ?? opts.voice ?? ''}`);
  }
  writeFileSync(path.join(p.build, 'voices.json'), JSON.stringify(out, null, 1));
  return out;
}

// ---------- timeline ----------
const srtTime = t => {
  const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};

export function timeline(p) {
  const voices = JSON.parse(readFileSync(path.join(p.build, 'voices.json'), 'utf8'));
  const D = { ...DEFAULTS, ...p.sb.defaults };
  const { fps } = p.sb.canvas;
  const scenes = [], sfx = [];
  let prevEnd = 0, prevVoiceEnd = -Infinity;
  p.sb.scenes.forEach((s, i) => {
    const o = { ...D, ...s };
    const start = i ? Math.max(0, prevEnd - o.overlap) : 0;
    const v = voices[s.id];
    const cues = { start: 0 };
    let vo = null;
    if (v) {
      const vs = Math.max(start + o.lead, prevVoiceEnd + o.gap);
      prevVoiceEnd = vs + v.duration;
      vo = { file: v.file, start: vs, dur: v.duration };
      cues.voiceStart = vs - start;
      cues.voiceEnd = prevVoiceEnd - start;
      for (const [name, off] of Object.entries(v.cues)) cues[name] = vs - start + timeAt(v.words, off, v.duration);
    }
    const end = Math.max(start + o.minSec, vo ? vo.start + vo.dur + o.pad : 0);
    cues.end = end - start;
    for (const fx of s.sfx ?? []) {
      const at = typeof fx.at === 'number' ? fx.at : cues[String(fx.at).replace(/^cue:/, '')];
      if (at == null) throw new Error(`scene ${s.id}: unknown sfx cue ${fx.at}`);
      sfx.push({ t: Math.max(0, start + at + (fx.offset ?? 0)), file: asset(fx.file, p.dir), gainDb: fx.gainDb ?? -12 });
    }
    const subtitles = v ? subtitleCues(v).map(c => ({ start: vo.start + c.start, end: vo.start + c.end, text: c.text })) : [];
    scenes.push({ id: s.id, start, end, cues, voice: vo, subtitles, data: s.data ?? {} });
    prevEnd = end;
  });
  const duration = Math.ceil(prevEnd * fps) / fps;
  const tl = { title: p.sb.title, canvas: p.sb.canvas, duration, scenes, sfx };
  writeFileSync(path.join(p.build, 'timeline.json'), JSON.stringify(tl, null, 1));
  const subs = scenes.flatMap(s => s.subtitles);
  writeFileSync(path.join(p.build, 'final.srt'), subs.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n'));
  console.log(`timeline: ${scenes.length} scenes, ${duration.toFixed(2)}s, ${subs.length} subtitles, ${sfx.length} sfx`);
  return tl;
}

// ---------- audio ----------
export function mix(p) {
  const tl = JSON.parse(readFileSync(path.join(p.build, 'timeline.json'), 'utf8'));
  const D = tl.duration;
  const inputs = [], graph = [];
  let n = 0;
  const add = (f, pre = []) => (inputs.push(...pre, '-i', f), n++);
  if (!tl.scenes.some(s => s.voice)) throw new Error('mix needs at least one scene with narration (say)');
  const voices = tl.scenes.filter(s => s.voice).map(s => {
    const i = add(s.voice.file);
    graph.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${Math.round(s.voice.start * 1000)}:all=1[v${i}]`);
    return `[v${i}]`;
  });
  graph.push(`${voices.join('')}amix=inputs=${voices.length}:normalize=0,highpass=f=70,` +
    `acompressor=threshold=-20dB:ratio=2.5:attack=8:release=150:makeup=1.5,apad,atrim=0:${D},asplit=2[voice][sc]`);
  const bus = ['[voice]'];
  const m = p.sb.music;
  if (m?.file) {
    const i = add(asset(m.file, p.dir), ['-stream_loop', '-1']);
    graph.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${D},volume=${m.gainDb ?? -8}dB,` +
      `afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, D - 2.5)}:d=2.5[mus]`);
    graph.push(`[mus][sc]sidechaincompress=threshold=0.02:ratio=6:attack=40:release=500:makeup=1[duck]`);
    bus.push('[duck]');
  } else graph.push('[sc]anullsink');
  tl.sfx.forEach((fx, k) => {
    const i = add(fx.file);
    graph.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${fx.gainDb}dB,adelay=${Math.round(fx.t * 1000)}:all=1[fx${k}]`);
    bus.push(`[fx${k}]`);
  });
  graph.push(`${bus.join('')}amix=inputs=${bus.length}:normalize=0,aformat=channel_layouts=stereo,apad,atrim=0:${D}[pre]`);
  const premix = path.join(p.build, 'premix.wav');
  ffmpeg(['-y', '-v', 'error', ...inputs, '-filter_complex', graph.join(';'), '-map', '[pre]', '-c:a', 'pcm_s24le', premix]);

  const target = p.sb.loudness ?? -16;
  const ln = `loudnorm=I=${target}:TP=-1.5:LRA=11`;
  const log = ffmpeg(['-v', 'info', '-i', premix, '-af', `${ln}:print_format=json`, '-f', 'null', '-']);
  const meas = JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1));
  const out = path.join(p.build, 'mix.wav');
  ffmpeg(['-y', '-v', 'error', '-i', premix, '-af',
    `${ln}:measured_I=${meas.input_i}:measured_TP=${meas.input_tp}:measured_LRA=${meas.input_lra}:measured_thresh=${meas.input_thresh}:offset=${meas.target_offset}:linear=true,aresample=48000`,
    '-c:a', 'pcm_s16le', out]);
  console.log(`mix: ${voices.length} voice clips, music=${!!m?.file}, ${tl.sfx.length} sfx, premix ${meas.input_i} LUFS -> ${target}`);
  if (m?.file) {
    // Un-ducked bed level in the final mix; outside -30..-22 LUFS it is either inaudible or competes with the voice.
    const bedLog = ffmpeg(['-nostats', '-v', 'info', '-i', asset(m.file, p.dir), '-af', 'ebur128=framelog=verbose', '-f', 'null', '-']);
    const bedI = Number(bedLog.slice(bedLog.lastIndexOf('Summary:')).match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
    const bed = bedI + (m.gainDb ?? -8) + (target - Number(meas.input_i));
    const verdict = bed < -30 ? 'too quiet: raise music.gainDb' : bed > -22 ? 'too loud: lower music.gainDb' : 'ok';
    console.log(`mix: music bed ≈ ${bed.toFixed(1)} LUFS un-ducked vs voice ${target} (${verdict})`);
  }
  return out;
}

export function mux(p) {
  const tl = JSON.parse(readFileSync(path.join(p.build, 'timeline.json'), 'utf8'));
  const out = path.join(p.dir, `${p.sb.output ?? 'final'}.mp4`);
  ffmpeg(['-y', '-v', 'error', '-i', path.join(p.build, 'video.mp4'), '-i', path.join(p.build, 'mix.wav'),
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(tl.duration), '-movflags', '+faststart', out]);
  console.log(`mux: ${out}`);
  return out;
}

export function qa(p, file) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'qa.mjs'), file ?? path.join(p.dir, `${p.sb.output ?? 'final'}.mp4`),
    '--timeline', path.join(p.build, 'timeline.json'), '--srt', path.join(p.build, 'final.srt'),
    '--out', path.join(p.build, 'qa'), `--lufs=${p.sb.loudness ?? -16}`], { stdio: 'inherit' });
  return r.status;
}

// ---------- CLI ----------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { positionals: [cmd, dir], values: flags } = parseArgs({
    allowPositionals: true, strict: false,
    options: {
      workers: { type: 'string' }, blur: { type: 'string' }, scale: { type: 'string' }, draft: { type: 'boolean' },
      at: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
    },
  });
  const need = () => { if (!dir) { console.error(`usage: node studio.mjs ${cmd} <projectDir>`); process.exit(2); } return loadProject(dir); };
  const steps = {
    setup: async () => (await import('./setup.mjs')).setup(),
    init: async () => {
      if (!dir) { console.error('usage: node studio.mjs init <newProjectDir>'); process.exit(2); }
      if (existsSync(path.join(dir, 'storyboard.json'))) throw new Error(`${dir} already has a storyboard.json`);
      cpSync(path.join(SKILL, 'template'), dir, { recursive: true });
      console.log(`init: ${path.resolve(dir)}`);
    },
    voice: async () => voice(need()),
    timeline: async () => timeline(need()),
    preview: async () => (await import('./render.mjs')).preview(need(), flags),
    render: async () => (await import('./render.mjs')).render(need(), flags),
    mix: async () => mix(need()),
    mux: async () => mux(need()),
    qa: async () => process.exit(qa(need())),
    all: async () => {
      const p = need();
      await voice(p); timeline(p);
      await (await import('./render.mjs')).render(p, flags);
      mix(p); mux(p);
      process.exit(qa(p));
    },
  };
  if (!steps[cmd]) { console.error(`commands: ${Object.keys(steps).join(' | ')}`); process.exit(2); }
  await steps[cmd]();
}
