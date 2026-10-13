// sounds.js - the game's sound effects, all synthesised with Web Audio.
//
// Nothing here is a recording: every sound is built from oscillators and
// noise when it plays, so there is no audio file and no copyright or licence
// to worry about, and it works offline. Everything is silent while the
// Options screen's Sound switch is off (window.getGameSettings().soundEnabled).
//
//   window.GameSounds.play(name) - one of SOUNDS below
//   window.GameSounds.context()  - the shared AudioContext (canvas.js's
//                                  too-close tone plays through it as well)
//   window.GameSounds.unlock()   - resume audio after a user gesture
//
// Browsers only start audio after the page has been clicked or a key
// pressed; the first one unlocks it (see the listeners at the bottom).

(function () {
  let audio = null;
  let master = null;
  let noise = null;

  function context() {
    if (!audio) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      audio = new Ctor();
      // A gentle limiter, so a bomb on top of a level up never clips.
      const limiter = audio.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.ratio.value = 6;
      master = audio.createGain();
      master.gain.value = 1;
      master.connect(limiter);
      limiter.connect(audio.destination);
    }
    return audio;
  }

  function unlock() {
    const ctx = context();
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  }

  function enabled() {
    return !window.getGameSettings || window.getGameSettings().soundEnabled !== false;
  }

  // One second of white noise, made once and reused.
  function noiseBuffer(ctx) {
    if (!noise) {
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return noise;
  }

  // A gain that rises in attack seconds to peak, then decays to silence by
  // t + length.
  function envelope(ctx, t, peak, attack, length) {
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    gain.connect(master);
    return gain;
  }

  // A tone gliding from freq to toFreq over length seconds.
  function tone(ctx, t, { type = "sine", freq, toFreq = freq, length, peak = 0.3, attack = 0.005 }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (toFreq !== freq) osc.frequency.exponentialRampToValueAtTime(toFreq, t + length);
    osc.connect(envelope(ctx, t, peak, attack, length));
    osc.start(t);
    osc.stop(t + length + 0.02);
  }

  // Filtered noise; the filter's frequency glides from freq to toFreq.
  function hiss(ctx, t, { filter = "lowpass", freq, toFreq = freq, q = 1, length, peak = 0.3, attack = 0.005 }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true; // so a long rumble never runs off the end of the noise
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (toFreq !== freq) f.frequency.exponentialRampToValueAtTime(toFreq, t + length);
    src.connect(f);
    f.connect(envelope(ctx, t, peak, attack, length));
    src.start(t, Math.random() * 0.5);
    src.stop(t + length + 0.02);
  }

  // Notes one after another, step seconds apart.
  function arpeggio(ctx, t, freqs, { type = "triangle", step = 0.08, length = 0.18, peak = 0.22 } = {}) {
    freqs.forEach((freq, i) => tone(ctx, t + i * step, { type, freq, length, peak }));
  }

  const NOTE = { C4: 261.6, E4: 329.6, G4: 392, A4: 440, C5: 523.3, E5: 659.3, G5: 784, C6: 1046.5, E6: 1318.5, G6: 1568 };

  const SOUNDS = {
    // A mole pops up out of its hole.
    pop(ctx, t) {
      tone(ctx, t, { freq: 320, toFreq: 720, length: 0.09, peak: 0.6 });
    },
    // A hat mole pops up: the pop, and a little sparkle.
    popSuper(ctx, t) {
      tone(ctx, t, { freq: 320, toFreq: 720, length: 0.09, peak: 0.6 });
      tone(ctx, t + 0.07, { type: "triangle", freq: NOTE.E6, length: 0.12, peak: 0.3 });
    },
    // A bomb comes up: a short fizz of its fuse.
    fuse(ctx, t) {
      hiss(ctx, t, { filter: "bandpass", freq: 5000, toFreq: 3000, q: 2, length: 0.35, peak: 0.55, attack: 0.02 });
    },
    // The mallet lands on a mole: a thump and a squeak.
    whack(ctx, t) {
      hiss(ctx, t, { freq: 1200, toFreq: 200, length: 0.09, peak: 1 });
      tone(ctx, t, { freq: 190, toFreq: 55, length: 0.14, peak: 1 });
      tone(ctx, t + 0.03, { type: "square", freq: 900, toFreq: 1500, length: 0.06, peak: 0.14 });
    },
    // The first whack on a hat mole: it rings off the hard hat.
    clang(ctx, t) {
      tone(ctx, t, { freq: 160, toFreq: 70, length: 0.1, peak: 0.85 });
      tone(ctx, t, { type: "triangle", freq: 1240, length: 0.35, peak: 0.35 });
      tone(ctx, t, { type: "triangle", freq: 1867, length: 0.28, peak: 0.22 });
    },
    // A hat mole finished off: the whack, then a bright chime.
    superHit(ctx, t) {
      SOUNDS.whack(ctx, t);
      arpeggio(ctx, t + 0.06, [NOTE.C6, NOTE.E6, NOTE.G6], { step: 0.06, length: 0.16, peak: 0.3 });
    },
    // A bomb whacked: an explosion. A sharp crack, the blast roaring down
    // from bright to dull, a deep boom under it, a long rumble, and bits of
    // debris crackling as it settles.
    bomb(ctx, t) {
      hiss(ctx, t, { filter: "highpass", freq: 2500, length: 0.04, peak: 1, attack: 0.001 });
      hiss(ctx, t, { freq: 6000, toFreq: 120, length: 1.3, peak: 1, attack: 0.002 });
      tone(ctx, t, { freq: 90, toFreq: 24, length: 1.1, peak: 1, attack: 0.002 });
      tone(ctx, t, { type: "triangle", freq: 55, toFreq: 20, length: 0.8, peak: 0.6, attack: 0.002 });
      hiss(ctx, t + 0.08, { freq: 400, toFreq: 50, length: 2.2, peak: 0.7, attack: 0.08 });
      for (let i = 0; i < 9; i++) {
        const at = t + 0.12 + Math.random() * 0.9;
        hiss(ctx, at, { filter: "bandpass", freq: 1500 + Math.random() * 3000, q: 4, length: 0.03 + Math.random() * 0.04, peak: 0.35 * (1 - (at - t) / 1.2), attack: 0.001 });
      }
    },
    // A mole got away (a life lost): a sad slide down.
    miss(ctx, t) {
      tone(ctx, t, { type: "triangle", freq: 440, toFreq: 210, length: 0.32, peak: 0.7 });
    },
    // The mallet swung at nothing.
    swish(ctx, t) {
      hiss(ctx, t, { filter: "bandpass", freq: 600, toFreq: 2400, q: 1.5, length: 0.14, peak: 0.9, attack: 0.03 });
    },
    // A new level: a quick fanfare, a beat after the whack that earned it.
    levelUp(ctx, t) {
      arpeggio(ctx, t + 0.12, [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6], { type: "square", step: 0.085, length: 0.16, peak: 0.1 });
      arpeggio(ctx, t + 0.12, [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6], { step: 0.085, length: 0.22, peak: 0.2 });
    },
    // The countdown: a beep for each of 3, 2, 1, and a higher one for Go.
    count(ctx, t) {
      tone(ctx, t, { type: "triangle", freq: NOTE.A4, length: 0.18, peak: 0.45 });
    },
    go(ctx, t) {
      tone(ctx, t, { type: "triangle", freq: NOTE.A4 * 2, length: 0.4, peak: 0.5 });
      tone(ctx, t, { type: "square", freq: NOTE.A4 * 2, length: 0.25, peak: 0.08 });
    },
    // The round is over.
    gameOver(ctx, t) {
      arpeggio(ctx, t + 0.1, [NOTE.G4, NOTE.E4, NOTE.C4], { step: 0.18, length: 0.4, peak: 0.26 });
    },
    // A menu or on-screen button pressed.
    click(ctx, t) {
      tone(ctx, t, { freq: 1100, toFreq: 700, length: 0.05, peak: 0.5 });
      hiss(ctx, t, { filter: "highpass", freq: 3000, length: 0.02, peak: 0.15 });
    },
    // Back out of a screen: the click, a little lower.
    back(ctx, t) {
      tone(ctx, t, { freq: 700, toFreq: 450, length: 0.06, peak: 0.5 });
    },
  };

  function play(name) {
    const sound = SOUNDS[name];
    if (!sound || !enabled()) return;
    const ctx = context();
    if (!ctx) return;
    unlock();
    try {
      sound(ctx, ctx.currentTime + 0.005);
    } catch (err) {
      // A sound that fails to build must never stop the game.
    }
  }

  window.GameSounds = { play, context, unlock, names: Object.keys(SOUNDS) };

  ["pointerdown", "keydown", "touchstart"].forEach((type) => {
    document.addEventListener(type, unlock, { passive: true });
  });
})();
