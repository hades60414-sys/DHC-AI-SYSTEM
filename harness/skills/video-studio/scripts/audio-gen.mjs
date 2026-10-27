// Renders the generated sound library (runtime/synth.js) to WAV files under <HOME>/assets/gen/. Skips files that exist.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { SKILL, HOME } from './env.mjs';

export const LIBRARY = [
  ['music/bed-calm-92.wav', 'bed', { bars: 36, bpm: 92 }],
  ['sfx/whoosh.wav', 'whoosh', { dur: 0.9 }],
  ['sfx/whoosh-long.wav', 'whoosh', { dur: 1.5, seed: 4 }],
  ['sfx/riser.wav', 'riser', { dur: 2 }],
  ['sfx/impact.wav', 'impact', {}],
  ['sfx/pop.wav', 'pop', {}],
  ['sfx/tick.wav', 'tick', {}],
  ['sfx/shimmer.wav', 'shimmer', {}],
  ['sfx/swell.wav', 'swell', {}],
  ['sfx/deny.wav', 'deny', {}],
];

export async function generateSounds({ force = false } = {}) {
  const dir = path.join(HOME, 'assets', 'gen');
  const todo = LIBRARY.filter(([f]) => force || !existsSync(path.join(dir, f)));
  if (!todo.length) return 0;
  const { chromium } = createRequire(path.join(HOME, 'package.json'))('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ path: path.join(SKILL, 'runtime', 'synth.js') });
    for (const [file, name, opts] of todo) {
      const b64 = await page.evaluate(([n, o]) => window.SYNTH.render(n, o), [name, opts]);
      const out = path.join(dir, file);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from(b64, 'base64'));
    }
  } finally {
    await browser.close();
  }
  return todo.length;
}
