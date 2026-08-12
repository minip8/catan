import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { nextBelow, nextUint32, pick, type RngState, rollDie, seedRng, shuffle } from './rng.js';

/** Draw `n` values, threading state. */
function draws(seed: number, n: number, bound: number): number[] {
  let s = seedRng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = nextBelow(s, bound);
    s = d.state;
    out.push(d.value);
  }
  return out;
}

describe('rng', () => {
  it('is deterministic for a given seed', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        expect(draws(seed, 50, 1000)).toEqual(draws(seed, 50, 1000));
      }),
    );
  });

  /**
   * Purity is what makes `(seed, actionLog)` a complete replay. If drawing mutated the state
   * passed in, replays would diverge from live play in ways that only show up under branching.
   */
  it('is pure — drawing from the same state twice gives the same result', () => {
    const s = seedRng(1234);
    const a = nextUint32(s);
    const b = nextUint32(s);
    expect(a.value).toBe(b.value);
    expect(a.state).toEqual(b.state);
  });

  it('advances the state on every draw', () => {
    let s = seedRng(7);
    const seen = new Set<string>([JSON.stringify(s)]);
    for (let i = 0; i < 500; i++) {
      s = nextUint32(s).state;
      const key = JSON.stringify(s);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  /** Nearby seeds must not produce similar opening boards. */
  it('decorrelates adjacent seeds', () => {
    const a = draws(1, 20, 1_000_000);
    const b = draws(2, 20, 1_000_000);
    expect(a).not.toEqual(b);
    // No shared prefix at all.
    expect(a[0]).not.toBe(b[0]);
  });

  it('never produces the degenerate all-zero state', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const s = seedRng(seed);
        expect(s[0] | s[1] | s[2] | s[3]).not.toBe(0);
      }),
    );
  });

  it('stays within bounds', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 100 }), (seed, bound) => {
        for (const v of draws(seed, 30, bound)) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(bound);
        }
      }),
    );
  });

  it('rejects a non-positive or non-integer bound', () => {
    const s = seedRng(1);
    expect(() => nextBelow(s, 0)).toThrow();
    expect(() => nextBelow(s, -3)).toThrow();
    expect(() => nextBelow(s, 2.5)).toThrow();
  });

  it('returns 0 without consuming entropy for bound 1', () => {
    const s = seedRng(99);
    const d = nextBelow(s, 1);
    expect(d.value).toBe(0);
    expect(d.state).toEqual(s);
  });

  /**
   * The whole Catan economy is the 2d6 distribution, so bias in the die would be a balance bug,
   * not a cosmetic one. 60k rolls of a fair d6 land each face within ~1% of 1/6.
   */
  it('rolls a fair die', () => {
    const counts = new Array<number>(6).fill(0);
    let s = seedRng(20260812);
    const n = 60_000;
    for (let i = 0; i < n; i++) {
      const d = rollDie(s, 6);
      s = d.state;
      expect(d.value).toBeGreaterThanOrEqual(1);
      expect(d.value).toBeLessThanOrEqual(6);
      counts[d.value - 1] = (counts[d.value - 1] as number) + 1;
    }
    for (const c of counts) {
      expect(Math.abs(c / n - 1 / 6)).toBeLessThan(0.01);
    }
  });

  it('reproduces the 2d6 distribution, with 7 the most common sum', () => {
    const counts = new Map<number, number>();
    let s = seedRng(5);
    const n = 120_000;
    for (let i = 0; i < n; i++) {
      const a = rollDie(s, 6);
      const b = rollDie(a.state, 6);
      s = b.state;
      const sum = a.value + b.value;
      counts.set(sum, (counts.get(sum) ?? 0) + 1);
    }
    // Expected frequencies out of 36: 2→1, 7→6, 12→1.
    for (const [sum, ways] of [
      [2, 1],
      [6, 5],
      [7, 6],
      [8, 5],
      [12, 1],
    ] as const) {
      expect(Math.abs((counts.get(sum) ?? 0) / n - ways / 36)).toBeLessThan(0.005);
    }
    const max = Math.max(...counts.values());
    expect(counts.get(7)).toBe(max);
  });

  it('shuffles into a permutation without mutating the input', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.integer(), { minLength: 0, maxLength: 40 }),
        (seed, xs) => {
          const before = [...xs];
          const { value: out } = shuffle(seedRng(seed), xs);
          expect(xs).toEqual(before);
          expect([...out].sort((a, b) => a - b)).toEqual([...xs].sort((a, b) => a - b));
        },
      ),
    );
  });

  /**
   * A biased shuffle would quietly skew every board, so check that each element reaches each
   * position at roughly the uniform rate rather than merely that the result is a permutation.
   */
  it('shuffles uniformly', () => {
    const deck = [0, 1, 2, 3, 4];
    const positions = deck.map(() => new Array<number>(5).fill(0));
    let s: RngState = seedRng(42);
    const n = 30_000;
    for (let i = 0; i < n; i++) {
      const res = shuffle(s, deck);
      s = res.state;
      res.value.forEach((item, idx) => {
        const row = positions[item] as number[];
        row[idx] = (row[idx] as number) + 1;
      });
    }
    for (const row of positions) {
      for (const c of row) expect(Math.abs(c / n - 1 / 5)).toBeLessThan(0.015);
    }
  });

  it('picks within the array, and undefined only when empty', () => {
    expect(pick(seedRng(1), []).value).toBeUndefined();
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.integer(), { minLength: 1, maxLength: 20 }),
        (seed, xs) => {
          expect(xs).toContain(pick(seedRng(seed), xs).value);
        },
      ),
    );
  });
});
