/**
 * What the table sounds like.
 *
 * Two halves, split the way `narrate` and `panels` are. `cuesFor` is pure: it reads a batch of
 * (redacted) events and decides what this viewer should hear — a roll that paid *you* chimes, one
 * that paid only others just rattles; a steal sounds different to the thief and to the victim.
 * `Sounds` is mechanical: it synthesises each cue with the Web Audio API, so there are no files to
 * ship and nothing to load.
 *
 * Browsers refuse to start audio before the page has been touched, so the context is created on
 * the first pointer or key press, and anything that happens before then is simply not heard.
 * Where there is no Web Audio at all (jsdom, an old browser) every call is a no-op.
 */

import type { GameEvent, PlayerId } from '@catan/core';

export type Cue =
  | 'dice'
  | 'collect'
  | 'road'
  | 'settlement'
  | 'city'
  | 'card'
  | 'play'
  | 'discard'
  | 'robber'
  | 'steal'
  | 'stolen'
  | 'trade'
  | 'offer'
  | 'accept'
  | 'decline'
  | 'tick'
  | 'yourTurn'
  | 'award'
  | 'victory'
  | 'defeat';

/** More than this in one batch is a pile-up, not a sequence; the first few carry the meaning. */
const MOST = 4;

/** The cues for one batch of new events, in order, without a cue repeating back to back. */
export function cuesFor(events: readonly GameEvent[], viewer: PlayerId | null): readonly Cue[] {
  const out: Cue[] = [];
  for (const event of events) {
    const cue = cueFor(event, viewer);
    if (cue !== null && out.at(-1) !== cue) out.push(cue);
  }
  return out.slice(0, MOST);
}

export function cueFor(event: GameEvent, viewer: PlayerId | null): Cue | null {
  const d = event.data;
  switch (event.type) {
    case 'dice':
      return 'dice';
    case 'production': {
      // The opening grant names one player; a roll names everyone who was paid.
      if (typeof d.player === 'string') return d.player === viewer ? 'collect' : null;
      const grants = record(d.grants);
      const paid = viewer === null ? Object.keys(grants).length > 0 : viewer in grants;
      return paid ? 'collect' : null;
    }
    case 'yearOfPlenty':
      return 'collect';
    case 'build':
      return d.kind === 'road' || d.kind === 'city' ? d.kind : 'settlement';
    case 'buyDev':
      return 'card';
    case 'playDev':
    case 'monopoly':
      return 'play';
    case 'discard':
      return 'discard';
    case 'robber':
      return 'robber';
    case 'steal':
      return viewer !== null && d.from === viewer ? 'stolen' : 'steal';
    case 'trade':
      return 'trade';
    case 'tradeOffered':
      return 'offer';
    case 'tradeResponse':
      return d.accept === true ? 'accept' : 'decline';
    case 'turn':
      // Everyone hears the turn end; only the player whose turn it now is hears it begin.
      return viewer !== null && d.player === viewer ? 'yourTurn' : null;
    case 'endTurn':
    case 'skip':
    case 'tradeClosed':
      return 'tick';
    case 'award':
      return typeof d.to === 'string' ? 'award' : null;
    case 'victory':
      return viewer === null || d.player === viewer ? 'victory' : 'defeat';
    default:
      return null;
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ── Synthesis ───────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'catan.muted';
/** Seconds between the cues of one batch, so a roll and its payout read as two things. */
const GAP = 0.16;

type Wave = OscillatorType;

export class Sounds {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private quiet: boolean;

  constructor() {
    this.quiet = readMuted();
    if (typeof document === 'undefined' || !audioAvailable()) return;
    const unlock = (): void => {
      this.wake();
      if (this.ctx?.state === 'running') {
        document.removeEventListener('pointerdown', unlock, true);
        document.removeEventListener('keydown', unlock, true);
      }
    };
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
  }

  get muted(): boolean {
    return this.quiet;
  }

  set muted(value: boolean) {
    this.quiet = value;
    try {
      localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch {
      // A private window may refuse storage; the setting just will not outlive the tab.
    }
  }

  /** Play a batch of cues one after another. */
  playAll(cues: readonly Cue[]): void {
    cues.forEach((cue, i) => {
      this.play(cue, i * GAP);
    });
  }

  play(cue: Cue, delay = 0): void {
    if (this.quiet || this.ctx === null || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime + 0.01 + delay;
    VOICES[cue](this, t);
  }

  private wake(): void {
    if (this.ctx === null) {
      const Ctor = audioAvailable();
      if (Ctor === null) return;
      this.ctx = new Ctor();
      this.out = this.ctx.createGain();
      this.out.gain.value = 0.35;
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  // ── Primitives the voices are made of ──

  /** A pitched note with a quick attack and an exponential tail. */
  tone(
    at: number,
    freq: number,
    dur: number,
    { wave = 'sine' as Wave, gain = 0.5, to = freq }: { wave?: Wave; gain?: number; to?: number },
  ): void {
    const { ctx, out } = this;
    if (ctx === null || out === null) return;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(freq, at);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, at + dur);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  /** A burst of filtered noise: clacks, knocks and swishes. */
  noise(
    at: number,
    dur: number,
    {
      freq = 2000,
      to = freq,
      q = 1,
      gain = 0.5,
      filter = 'bandpass' as BiquadFilterType,
    }: { freq?: number; to?: number; q?: number; gain?: number; filter?: BiquadFilterType },
  ): void {
    const { ctx, out } = this;
    if (ctx === null || out === null) return;
    const src = ctx.createBufferSource();
    src.buffer = this.whiteNoise(ctx);
    const band = ctx.createBiquadFilter();
    band.type = filter;
    band.Q.value = q;
    band.frequency.setValueAtTime(freq, at);
    if (to !== freq) band.frequency.exponentialRampToValueAtTime(to, at + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(band).connect(env).connect(out);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  private whiteNoise(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer === null) {
      const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buffer;
    }
    return this.noiseBuffer;
  }
}

/** A hollow wooden knock — a piece set down on the board. */
function knock(s: Sounds, at: number, pitch = 1): void {
  s.tone(at, 190 * pitch, 0.12, { wave: 'triangle', gain: 0.7, to: 120 * pitch });
  s.noise(at, 0.03, { freq: 1800 * pitch, q: 2, gain: 0.35 });
}

function notes(s: Sounds, at: number, freqs: readonly number[], step: number, wave: Wave): void {
  freqs.forEach((f, i) => {
    s.tone(at + i * step, f, 0.5, { wave, gain: 0.3 });
  });
}

// Pitches, in hertz.
const C5 = 523.25;
const E5 = 659.25;
const G5 = 783.99;
const A5 = 880;
const C6 = 1046.5;

const VOICES: Readonly<Record<Cue, (s: Sounds, at: number) => void>> = {
  dice: (s, at) => {
    // Two dice rattling in a cup, then landing.
    for (let i = 0; i < 7; i++) {
      s.noise(at + i * 0.045 + Math.random() * 0.02, 0.035, {
        freq: 2500 + Math.random() * 2500,
        q: 4,
        gain: 0.3,
      });
    }
    s.noise(at + 0.36, 0.06, { freq: 1400, q: 3, gain: 0.55 });
    s.noise(at + 0.42, 0.05, { freq: 1700, q: 3, gain: 0.45 });
  },
  collect: (s, at) => notes(s, at, [E5, A5], 0.08, 'triangle'),
  road: (s, at) => knock(s, at, 1.2),
  settlement: (s, at) => {
    knock(s, at);
    knock(s, at + 0.09, 1.1);
  },
  city: (s, at) => {
    knock(s, at, 0.85);
    knock(s, at + 0.09, 0.95);
    knock(s, at + 0.18, 1.05);
    notes(s, at + 0.26, [C5, E5, G5], 0, 'triangle');
  },
  card: (s, at) => s.noise(at, 0.18, { freq: 1500, to: 6000, q: 0.8, gain: 0.35 }),
  play: (s, at) => {
    s.noise(at, 0.15, { freq: 5000, to: 1500, q: 0.8, gain: 0.3 });
    s.tone(at + 0.1, G5, 0.45, { wave: 'sine', gain: 0.25 });
    s.tone(at + 0.1, C6, 0.45, { wave: 'sine', gain: 0.15 });
  },
  discard: (s, at) => {
    s.noise(at, 0.14, { freq: 4000, to: 1200, q: 0.8, gain: 0.3 });
    s.noise(at + 0.1, 0.14, { freq: 3500, to: 1000, q: 0.8, gain: 0.25 });
  },
  robber: (s, at) => {
    s.tone(at, 110, 0.35, { wave: 'sawtooth', gain: 0.18 });
    s.tone(at + 0.18, 103.8, 0.5, { wave: 'sawtooth', gain: 0.18, to: 92 });
    knock(s, at + 0.05, 0.6);
  },
  steal: (s, at) => {
    s.noise(at, 0.1, { freq: 3000, to: 7000, q: 1, gain: 0.25 });
    s.tone(at + 0.06, 1200, 0.12, { wave: 'triangle', gain: 0.25, to: 1600 });
  },
  stolen: (s, at) => s.tone(at, 440, 0.4, { wave: 'triangle', gain: 0.35, to: 220 }),
  trade: (s, at) => {
    s.tone(at, A5, 0.18, { wave: 'triangle', gain: 0.3 });
    s.tone(at + 0.1, E5, 0.18, { wave: 'triangle', gain: 0.3 });
    s.tone(at + 0.2, A5, 0.25, { wave: 'triangle', gain: 0.3 });
  },
  offer: (s, at) => s.tone(at, G5, 0.3, { wave: 'sine', gain: 0.3 }),
  accept: (s, at) => notes(s, at, [C5, G5], 0.09, 'sine'),
  decline: (s, at) => {
    s.tone(at, 330, 0.18, { wave: 'triangle', gain: 0.3 });
    s.tone(at + 0.1, 311, 0.25, { wave: 'triangle', gain: 0.3 });
  },
  tick: (s, at) => s.noise(at, 0.03, { freq: 3000, q: 3, gain: 0.25 }),
  yourTurn: (s, at) => {
    s.tone(at, G5, 0.6, { wave: 'sine', gain: 0.3 });
    s.tone(at + 0.12, C6, 0.8, { wave: 'sine', gain: 0.3 });
  },
  award: (s, at) => notes(s, at, [C5, E5, G5, C6], 0.07, 'triangle'),
  victory: (s, at) => {
    notes(s, at, [C5, E5, G5], 0.12, 'square');
    s.tone(at + 0.36, C6, 0.9, { wave: 'square', gain: 0.22 });
    s.tone(at + 0.36, G5, 0.9, { wave: 'triangle', gain: 0.22 });
  },
  defeat: (s, at) => notes(s, at, [G5, 622.25, C5], 0.18, 'triangle'),
};

function audioAvailable(): (new () => AudioContext) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** One per page, so the mute switch and the unlocked context outlive a new game. */
export const sounds = new Sounds();
