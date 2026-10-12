// The slot machine's sounds, synthesized with WebAudio: no audio files. `createSfx(enabled)` returns
// play(cue, ...args); the cues are the keys of CUES below. Everything goes through one compressor, so the
// machine can be loud without clipping when a jackpot piles a bell, a fanfare and a tray of coins on top of each other.
export function createSfx(enabled, AudioCtx = globalThis.AudioContext) {
  let ctx, out, noiseBuf;
  const ready = () => {
    if (!ctx) {
      ctx = new AudioCtx();
      // Big but never clipping: a compressor evens out pile-ups (a jackpot is a bell, a fanfare and a tray of
      // coins at once), then a soft limiter rounds off whatever still pokes out, with a ceiling just under full scale.
      const squash = ctx.createDynamicsCompressor(), limit = ctx.createWaveShaper();
      Object.entries({ threshold: -14, knee: 10, ratio: 8, attack: 0.002, release: 0.12 }).forEach(([k, v]) => { if (squash[k]) squash[k].value = v; });
      limit.curve = Float32Array.from({ length: 1025 }, (_, n) => (0.94 * Math.tanh(1.5 * (n / 512 - 1))) / Math.tanh(1.5));
      out = ctx.createGain();
      out.connect(squash).connect(limit).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume()?.catch?.(() => {}); // starts with the first click inside the board
    return ctx.currentTime + 0.01;
  };
  const env = (g, t, vol, len, attack = 0.004) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  };
  // One oscillator note. `to` glides the pitch, `lp` sweeps a low-pass (the "wah"), `wobble` is a vibrato that
  // dies away (a spring's "oing") or holds (a trombone's waver).
  function tone(t, { f, to, len = 0.2, type = 'sine', vol = 0.2, attack, lp, wobble }) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + len);
    if (wobble) {
      const l = ctx.createOscillator(), depth = ctx.createGain();
      l.frequency.value = wobble.rate;
      depth.gain.setValueAtTime(wobble.depth, t);
      depth.gain.exponentialRampToValueAtTime(wobble.end ?? 0.01, t + len);
      l.connect(depth).connect(o.frequency);
      l.start(t);
      l.stop(t + len + 0.05);
    }
    env(g, t, vol, len, attack);
    let node = o;
    if (lp) {
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.setValueAtTime(lp[0], t);
      flt.frequency.exponentialRampToValueAtTime(lp[1], t + len);
      node = o.connect(flt);
    }
    node.connect(g).connect(out);
    o.start(t);
    o.stop(t + len + 0.05);
  }
  // A burst of filtered noise: clicks, clacks, a cash drawer.
  function noise(t, { len = 0.05, vol = 0.2, hp = 1000 }) {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let n = 0; n < d.length; n++) d[n] = Math.random() * 2 - 1;
    }
    const s = ctx.createBufferSource(), g = ctx.createGain(), flt = ctx.createBiquadFilter();
    s.buffer = noiseBuf;
    flt.type = 'highpass';
    flt.frequency.value = hp;
    env(g, t, vol, len, 0.002);
    s.connect(flt).connect(g).connect(out);
    s.start(t, Math.random() * 0.5, len + 0.05);
  }
  // A struck bell: inharmonic partials, the high ones dying first.
  const bell = (t, f, vol = 0.22, len = 0.7) => [[1, 1], [2.76, 0.5], [5.4, 0.25], [8.93, 0.12]]
    .forEach(([m, v]) => tone(t, { f: f * m, len: len / Math.sqrt(m), vol: vol * v }));
  // One coin landing in the tray.
  const coin = (t, vol = 0.12) => {
    const f = 2600 + Math.random() * 2600;
    tone(t, { f, len: 0.09, vol });
    tone(t, { f: f * 1.5, len: 0.06, vol: vol * 0.6 });
    noise(t, { len: 0.012, vol: vol * 0.5, hp: 6000 });
  };
  const coins = (t, n, over) => { for (let k = 0; k < n; k++) coin(t + (k / n) * over + Math.random() * 0.04, 0.1 + Math.random() * 0.06); };
  // Ka-ching: the drawer slams out ("ka"), the bell rings ("ching").
  const kaching = (t, vol = 1) => {
    noise(t, { len: 0.05, vol: 0.32 * vol, hp: 1500 });
    tone(t, { f: 180, to: 90, len: 0.07, vol: 0.32 * vol });
    bell(t + 0.07, 2093, 0.32 * vol, 0.9);
    bell(t + 0.075, 3136, 0.17 * vol, 0.6);
  };
  const brass = (t, f, len, vol = 0.17) => {
    for (const [detune, v] of [[1, 1], [1.006, 0.7]]) tone(t, { f: f * detune, len, type: 'sawtooth', vol: vol * v, attack: 0.02, lp: [3200, 1200] }); // two voices, slightly apart
  };
  const fanfare = (t, notes, step = 0.11, last = 0.5) => notes.forEach((f, n) => brass(t + n * step, f, n === notes.length - 1 ? last : step * 1.1));
  // Poing: a spring boings and sags.
  const poing = (t, f) => tone(t, { f: f * 1.9, to: f, len: 0.34, vol: 0.5, wobble: { rate: 26, depth: f * 0.5 } });
  // Wah: one sad trombone note, drooping.
  const wah = (t, f, len) => tone(t, {
    f, to: f * 0.94, len, type: 'sawtooth', vol: 0.34, attack: 0.03, lp: [400, 1400], wobble: len > 0.6 ? { rate: 6, depth: f * 0.03, end: f * 0.03 } : undefined,
  });

  const CUES = {
    // the machine
    lever: (t) => { // the ratchet on the way down, the clunk at the bottom
      for (let k = 0; k < 6; k++) noise(t + k * 0.035, { len: 0.02, vol: 0.15, hp: 1900 - k * 150 });
      tone(t + 0.22, { f: 110, to: 55, len: 0.16, vol: 0.42 });
      noise(t + 0.22, { len: 0.05, vol: 0.22, hp: 400 });
    },
    tick: (t) => { noise(t, { len: 0.014, vol: 0.2, hp: 3200 }); tone(t, { f: 1900, len: 0.016, vol: 0.06, type: 'square' }); },
    stop: (t, n = 0) => { // each reel thunks into place, a step higher than the last
      tone(t, { f: 150, to: 60, len: 0.13, vol: 0.46 });
      noise(t, { len: 0.03, vol: 0.2, hp: 900 });
      bell(t + 0.01, 880 * [1, 1.25, 1.5][n] || 880, 0.11, 0.25);
    },
    roll: (t, len = 1.2) => tone(t, { f: 196, to: 784, len, type: 'triangle', vol: 0.16, attack: len * 0.6 }), // the last reel: suspense, swelling
    hold: (t) => { noise(t, { len: 0.02, vol: 0.3, hp: 2500 }); tone(t + 0.02, { f: 740, len: 0.09, vol: 0.2, type: 'square' }); },
    on: (t) => kaching(t, 0.8),
    // the payouts
    win: (t) => { kaching(t); coins(t + 0.25, 5, 0.4); },
    easy: (t) => { // a slide whistle, three light chimes, a small ka-ching: easy money
      tone(t, { f: 520, to: 1500, len: 0.22, vol: 0.2 });
      [1047, 1319, 1568].forEach((f, n) => bell(t + 0.26 + n * 0.09, f, 0.17, 0.35));
      kaching(t + 0.62, 0.7);
      coins(t + 0.7, 7, 0.5);
    },
    big: (t) => {
      fanfare(t, [523, 659, 784, 1047]);
      [0.55, 0.85, 1.15].forEach((d) => kaching(t + d));
      coins(t + 1.2, 18, 1.2);
    },
    jackpot: (t) => { // the bell that won't stop, a fanfare, ka-ching ka-ching ka-ching, and a tray full of coins
      for (let k = 0; k < 22; k++) bell(t + k * 0.075, k % 2 ? 1568 : 1319, 0.14, 0.18);
      fanfare(t + 0.2, [523, 523, 659, 784, 1047, 784, 1047], 0.13, 0.7);
      [1.7, 2.05, 2.4].forEach((d) => kaching(t + d, 1.1));
      coins(t + 1.6, 60, 2.8);
    },
    bug: (t) => { // poing, poing, poing... wah wah wah waaah
      [392, 330, 262].forEach((f, n) => poing(t + n * 0.3, f));
      [233, 220, 208].forEach((f, n) => wah(t + 1.0 + n * 0.34, f, 0.3));
      wah(t + 2.02, 196, 1.1);
    },
  };
  return (cue, ...args) => {
    if (!enabled() || !AudioCtx || !CUES[cue]) return;
    try { CUES[cue](ready(), ...args); } catch { /* no audio here: the machine stays quiet */ }
  };
}
export const SFX_CUES = ['lever', 'tick', 'stop', 'roll', 'hold', 'on', 'win', 'easy', 'big', 'jackpot', 'bug'];
