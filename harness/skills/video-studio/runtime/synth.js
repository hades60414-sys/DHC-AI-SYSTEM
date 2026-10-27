// Offline sound design in Web Audio (runs in headless Chrome; no samples, so no licensing questions).
// window.SYNTH.render(name, opts) -> base64 WAV (48 kHz, stereo, 16-bit). Deterministic: all noise comes from a seeded PRNG.
(() => {
  const SR = 48000;
  const mtof = m => 440 * 2 ** ((m - 69) / 12);

  function rng(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function noiseBuffer(ctx, seconds, seed = 1, color = 'white') {
    const r = rng(seed);
    const buf = ctx.createBuffer(2, Math.ceil(seconds * SR), SR);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < d.length; i++) {
        const w = r() * 2 - 1;
        if (color === 'pink') {
          b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
          d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
        } else d[i] = w;
      }
    }
    return buf;
  }

  function noise(ctx, seconds, seed, color) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuffer(ctx, seconds, seed, color);
    return s;
  }

  // Synthetic hall reverb: decaying stereo noise impulse.
  function reverb(ctx, seconds = 2.6, decay = 3, seed = 9) {
    const r = rng(seed);
    const len = Math.ceil(seconds * SR);
    const ir = ctx.createBuffer(2, len, SR);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (r() * 2 - 1) * (1 - i / len) ** decay;
    }
    const c = ctx.createConvolver();
    c.buffer = ir;
    return c;
  }

  function env(param, t, { a = 0.01, d = 0.2, s = 0, r = 0.1, peak = 1, hold = 0 }) {
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(peak, t + a);
    param.exponentialRampToValueAtTime(Math.max(0.0001, peak * s), t + a + d);
    if (hold) param.setValueAtTime(Math.max(0.0001, peak * s), t + a + d + hold);
    param.exponentialRampToValueAtTime(0.0001, t + a + d + hold + r);
  }

  const SFX = {
    whoosh(ctx, out, { dur = 0.9, seed = 3 } = {}) {
      const n = noise(ctx, dur, seed, 'pink');
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(260, 0);
      bp.frequency.exponentialRampToValueAtTime(3200, dur * 0.6);
      bp.frequency.exponentialRampToValueAtTime(700, dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(1.6, dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, dur);
      const pan = ctx.createStereoPanner();
      pan.pan.setValueAtTime(-0.7, 0);
      pan.pan.linearRampToValueAtTime(0.7, dur);
      n.connect(bp).connect(g).connect(pan).connect(out);
      n.start(0);
      return dur;
    },
    riser(ctx, out, { dur = 2, seed = 5 } = {}) {
      const n = noise(ctx, dur, seed, 'white');
      const hp = ctx.createBiquadFilter();
      hp.type = 'bandpass'; hp.Q.value = 2;
      hp.frequency.setValueAtTime(400, 0);
      hp.frequency.exponentialRampToValueAtTime(6000, dur);
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(110, 0);
      o.frequency.exponentialRampToValueAtTime(880, dur);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.setValueAtTime(600, 0); lp.frequency.exponentialRampToValueAtTime(5000, dur);
      const og = ctx.createGain(); og.gain.value = 0.12;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(0.9, dur * 0.97);
      g.gain.linearRampToValueAtTime(0, dur);
      n.connect(hp).connect(g);
      o.connect(lp).connect(og).connect(g);
      g.connect(out);
      n.start(0); o.start(0); o.stop(dur);
      return dur;
    },
    impact(ctx, out, { dur = 1.6, seed = 7 } = {}) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(95, 0);
      o.frequency.exponentialRampToValueAtTime(38, 0.5);
      const g = ctx.createGain();
      env(g.gain, 0, { a: 0.004, d: 1.1, s: 0.0001, r: 0.05, peak: 1.2 });
      const n = noise(ctx, 0.2, seed, 'pink');
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
      const ng = ctx.createGain();
      env(ng.gain, 0, { a: 0.002, d: 0.12, s: 0.0001, r: 0.02, peak: 0.9 });
      const verb = reverb(ctx, 1.4, 4);
      const wet = ctx.createGain(); wet.gain.value = 0.25;
      o.connect(g).connect(out);
      n.connect(lp).connect(ng).connect(out);
      ng.connect(verb).connect(wet).connect(out);
      o.start(0); o.stop(dur); n.start(0);
      return dur;
    },
    pop(ctx, out, { dur = 0.3 } = {}) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(520, 0);
      o.frequency.exponentialRampToValueAtTime(1180, 0.05);
      const g = ctx.createGain();
      env(g.gain, 0, { a: 0.003, d: 0.16, s: 0.0001, r: 0.03, peak: 0.8 });
      o.connect(g).connect(out);
      o.start(0); o.stop(dur);
      return dur;
    },
    tick(ctx, out, { dur = 0.08, seed = 11 } = {}) {
      const n = noise(ctx, dur, seed);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 3;
      const g = ctx.createGain();
      env(g.gain, 0, { a: 0.001, d: 0.03, s: 0.0001, r: 0.01, peak: 7 });
      n.connect(bp).connect(g).connect(out);
      n.start(0);
      return dur;
    },
    shimmer(ctx, out, { dur = 2.2 } = {}) {
      const verb = reverb(ctx, 2.2, 2.5);
      const wet = ctx.createGain(); wet.gain.value = 0.5;
      verb.connect(wet).connect(out);
      [84, 88, 91, 95].forEach((m, i) => {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = mtof(m);
        const g = ctx.createGain();
        env(g.gain, i * 0.06, { a: 0.01, d: 1.3, s: 0.0001, r: 0.1, peak: 0.18 });
        o.connect(g); g.connect(out); g.connect(verb);
        o.start(i * 0.06); o.stop(dur);
      });
      return dur;
    },
    swell(ctx, out, { dur = 1.4, seed = 13 } = {}) {
      const n = noise(ctx, dur, seed, 'pink');
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(300, 0); lp.frequency.exponentialRampToValueAtTime(9000, dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(0.55, dur * 0.98);
      g.gain.linearRampToValueAtTime(0, dur);
      n.connect(lp).connect(g).connect(out);
      n.start(0);
      return dur;
    },
    deny(ctx, out, { dur = 0.6 } = {}) {
      [0, 0.16].forEach(t0 => {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = 196;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
        const g = ctx.createGain();
        env(g.gain, t0, { a: 0.005, d: 0.1, s: 0.3, r: 0.06, peak: 0.35 });
        o.connect(lp).connect(g).connect(out);
        o.start(t0); o.stop(t0 + 0.3);
      });
      return dur;
    },
  };

  // Calm tech music bed: IV-vi-ii-V in D major, pads + sub + plucked arpeggio with echo + soft pulse.
  function bed(ctx, out, { bars = 36, bpm = 92, seed = 21 } = {}) {
    const beat = 60 / bpm, bar = beat * 4;
    const prog = [
      { bass: 43, pad: [59, 62, 66, 69] },
      { bass: 47, pad: [57, 62, 66, 69] },
      { bass: 40, pad: [55, 59, 62, 66] },
      { bass: 45, pad: [55, 59, 62, 64] },
    ];
    const verb = reverb(ctx, 3.2, 2.6, seed);
    const wet = ctx.createGain(); wet.gain.value = 0.32;
    verb.connect(wet).connect(out);
    const delay = ctx.createDelay(2); delay.delayTime.value = beat * 0.75;
    const fb = ctx.createGain(); fb.gain.value = 0.32;
    const dlp = ctx.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 2600;
    delay.connect(dlp).connect(fb).connect(delay);
    const dgain = ctx.createGain(); dgain.gain.value = 0.45;
    dlp.connect(dgain).connect(out);
    const r = rng(seed);
    // One legato sub oscillator for the whole bed: separate notes per chord left audible dips at every change.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = mtof(prog[0].bass);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, 0);
    sg.gain.exponentialRampToValueAtTime(0.085, 1.5);
    sg.gain.setTargetAtTime(0.0001, bars * bar - 0.6, 0.4);
    sub.connect(sg).connect(out);
    sub.start(0);
    sub.stop(bars * bar + 1.5);

    for (let b = 0; b < bars; b += 2) {
      const chord = prog[(b / 2) % prog.length];
      const t = b * bar, len = bar * 2;
      for (const m of chord.pad) {
        for (const det of [-7, 7]) {
          const o = ctx.createOscillator();
          o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.6;
          lp.frequency.setValueAtTime(700, t);
          lp.frequency.linearRampToValueAtTime(1500, t + len * 0.5);
          lp.frequency.linearRampToValueAtTime(800, t + len);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.022, t + 1.2);
          g.gain.setValueAtTime(0.022, t + len - 0.4);
          g.gain.exponentialRampToValueAtTime(0.0001, t + len + 1.2);
          const pan = ctx.createStereoPanner(); pan.pan.value = det < 0 ? -0.35 : 0.35;
          o.connect(lp).connect(g).connect(pan);
          pan.connect(out); pan.connect(verb);
          o.start(t); o.stop(t + len + 1.3);
        }
      }
      sub.frequency.setTargetAtTime(mtof(chord.bass), t, 0.04);

      if (b >= 4) {
        const tones = [...chord.pad, chord.pad[1] + 12];
        for (let s = 0; s < 16; s++) {
          const tt = t + s * beat / 2;
          const o = ctx.createOscillator();
          o.type = 'triangle';
          o.frequency.value = mtof(tones[(s * 3 + (r() < 0.2 ? 1 : 0)) % tones.length] + 12);
          const g = ctx.createGain();
          env(g.gain, tt, { a: 0.004, d: 0.28, s: 0.0001, r: 0.05, peak: s % 4 === 0 ? 0.075 : 0.05 });
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
          o.connect(lp).connect(g);
          g.connect(out); g.connect(delay); g.connect(verb);
          o.start(tt); o.stop(tt + 0.4);
        }
      }
      if (b >= 8) {
        for (let s = 0; s < 8; s++) {
          const tt = t + s * beat;
          if (s % 2 === 0) {
            const k = ctx.createOscillator();
            k.type = 'sine';
            k.frequency.setValueAtTime(110, tt);
            k.frequency.exponentialRampToValueAtTime(45, tt + 0.14);
            const kg = ctx.createGain();
            env(kg.gain, tt, { a: 0.003, d: 0.22, s: 0.0001, r: 0.03, peak: 0.3 });
            k.connect(kg).connect(out);
            k.start(tt); k.stop(tt + 0.3);
          }
          const h = noise(ctx, 0.06, seed + b * 16 + s);
          const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7500;
          const hg = ctx.createGain();
          env(hg.gain, tt + beat / 2, { a: 0.001, d: 0.035, s: 0.0001, r: 0.01, peak: 0.07 });
          const pan = ctx.createStereoPanner(); pan.pan.value = 0.25;
          h.connect(hp).connect(hg).connect(pan).connect(out);
          h.start(tt + beat / 2);
        }
      }
    }
    return bars * bar + 2;
  }

  function wav(buffer) {
    const n = buffer.length, chs = buffer.numberOfChannels;
    const data = new DataView(new ArrayBuffer(44 + n * chs * 2));
    const str = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); data.setUint32(4, 36 + n * chs * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, chs, true);
    data.setUint32(24, SR, true); data.setUint32(28, SR * chs * 2, true); data.setUint16(32, chs * 2, true); data.setUint16(34, 16, true);
    str(36, 'data'); data.setUint32(40, n * chs * 2, true);
    const cd = [...Array(chs)].map((_, c) => buffer.getChannelData(c));
    for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < chs; c++, o += 2) {
      const v = Math.max(-1, Math.min(1, cd[c][i]));
      data.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    let s = '';
    const bytes = new Uint8Array(data.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function render(name, opts = {}) {
    const isBed = name === 'bed';
    const seconds = isBed ? (opts.bars ?? 36) * 4 * 60 / (opts.bpm ?? 92) + 4 : (opts.dur ?? 3) + 1.5;
    const ctx = new OfflineAudioContext(2, Math.ceil(seconds * SR), SR);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.25;
    const master = ctx.createGain(); master.gain.value = isBed ? 0.9 : 0.85;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 28;
    master.connect(hp).connect(comp).connect(ctx.destination);
    const used = isBed ? bed(ctx, master, opts) : SFX[name](ctx, master, opts);
    const buf = await ctx.startRendering();
    const keep = Math.min(buf.length, Math.ceil((used + (isBed ? 0 : 0.6)) * SR));
    const out = new AudioBuffer({ length: keep, numberOfChannels: 2, sampleRate: SR });
    for (let c = 0; c < 2; c++) out.copyToChannel(buf.getChannelData(c).subarray(0, keep), c);
    return wav(out);
  }

  window.SYNTH = { render, names: ['bed', ...Object.keys(SFX)] };
})();
