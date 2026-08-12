/**
 * The engine's only source of randomness.
 *
 * `RngState` is carried inside `GameState` and advanced *purely* — every function here takes a
 * state and returns a new one. Nothing in the engine may call `Math.random`.
 *
 * Two things depend on this:
 *
 * - **Replay.** `(seed, scenarioId, ruleSetId, actionLog)` reconstructs a game exactly, so bug
 *   reports are reproducible and desync between server and client is detectable. If dice results
 *   arrived as action *inputs* instead, every effect that needs entropy mid-action (shuffling the
 *   deck, resolving a steal) would need its own plumbing.
 * - **Secrecy.** `RngState` is hidden information and **must be stripped by `redactFor`**. A client
 *   holding it can predict every future roll and the entire remaining deck order.
 *
 * The generator is xoshiro128**: four 32-bit words, so the state is JSON-safe with no BigInt, and
 * every operation stays in 32-bit integer space.
 */

/** Four 32-bit words. Treat as opaque. */
export type RngState = readonly [number, number, number, number];

/** A drawn value together with the advanced state. */
export interface RngDraw<T> {
  readonly value: T;
  readonly state: RngState;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * Expand a single seed into four well-mixed words via splitmix32.
 *
 * Seeding xoshiro directly from a small integer leaves the first outputs correlated with the
 * seed, which would make `seed: 1` and `seed: 2` produce visibly similar opening boards.
 */
export function seedRng(seed: number): RngState {
  let x = seed | 0;
  const word = (): number => {
    x = (x + 0x9e3779b9) | 0;
    let z = x;
    z ^= z >>> 16;
    z = Math.imul(z, 0x21f0aaad);
    z ^= z >>> 15;
    z = Math.imul(z, 0x735a2d97);
    z ^= z >>> 15;
    return z >>> 0;
  };
  const s: [number, number, number, number] = [word(), word(), word(), word()];
  // xoshiro has a fixed point at all-zero. splitmix32 makes this essentially impossible, but a
  // silent failure here would be a stuck generator, so it is worth one branch.
  if ((s[0] | s[1] | s[2] | s[3]) === 0) s[0] = 1;
  return s;
}

/** Draw a uniform 32-bit unsigned integer. */
export function nextUint32(state: RngState): RngDraw<number> {
  const [s0, s1, s2, s3] = state;

  const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
  const t = (s1 << 9) >>> 0;

  // Order is load-bearing: the updates to s1 and s0 read the *already updated* s2 and s3.
  const n2a = (s2 ^ s0) >>> 0;
  const n3a = (s3 ^ s1) >>> 0;
  const n1 = (s1 ^ n2a) >>> 0;
  const n0 = (s0 ^ n3a) >>> 0;
  const n2 = (n2a ^ t) >>> 0;
  const n3 = rotl(n3a, 11);

  return { value: result, state: [n0, n1, n2, n3] };
}

/**
 * Draw a uniform integer in `[0, bound)`.
 *
 * Uses rejection sampling rather than `% bound`. Modulo would bias the low values, which for a
 * game whose entire economy is a dice distribution is not an acceptable approximation.
 */
export function nextBelow(state: RngState, bound: number): RngDraw<number> {
  if (!Number.isInteger(bound) || bound <= 0) {
    throw new Error(`nextBelow: bound must be a positive integer, got ${bound}`);
  }
  if (bound === 1) return { value: 0, state };

  // Largest multiple of `bound` that fits in a uint32; draws at or above it are rejected.
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % bound);
  let s = state;
  for (;;) {
    const draw = nextUint32(s);
    s = draw.state;
    if (draw.value < limit) return { value: draw.value % bound, state: s };
  }
}

/** Roll one die with `sides` faces, returning a value in `[1, sides]`. */
export function rollDie(state: RngState, sides: number): RngDraw<number> {
  const draw = nextBelow(state, sides);
  return { value: draw.value + 1, state: draw.state };
}

/**
 * Fisher-Yates shuffle, returning a new array.
 *
 * Used for the terrain bag, the number-token bag, the harbour bag and the development deck, so
 * its uniformity is directly a fairness property of the game.
 */
export function shuffle<T>(state: RngState, items: readonly T[]): RngDraw<readonly T[]> {
  const out = [...items];
  let s = state;
  for (let i = out.length - 1; i > 0; i--) {
    const draw = nextBelow(s, i + 1);
    s = draw.state;
    const j = draw.value;
    // Non-null asserted: i and j are both in range by construction, but
    // noUncheckedIndexedAccess cannot see that.
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return { value: out, state: s };
}

/** Pick one element uniformly. Returns `undefined` only for an empty input. */
export function pick<T>(state: RngState, items: readonly T[]): RngDraw<T | undefined> {
  if (items.length === 0) return { value: undefined, state };
  const draw = nextBelow(state, items.length);
  return { value: items[draw.value] as T, state: draw.state };
}
