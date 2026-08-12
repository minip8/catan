/**
 * Board generation: coastlines, harbour placement, terrain and number tokens.
 *
 * Everything here works on an arbitrary set of land hexes, which is the point. The official 19-hex
 * and 30-hex islands, our generated 7-10 player boards, and (later) Seafarers' multi-island maps
 * all run through the same functions.
 *
 * Two number-token orders are supported, both official:
 *
 * - `spiral` — alphabetical order along an outside-in counter-clockwise spiral, skipping deserts.
 *   This is the rulebook's lettered-token procedure.
 * - `random` — the almanac's explicitly sanctioned alternative: "place 1 token on each land hex ...
 *   in random order. In such case, the tokens with the red numbers must not be next to each other."
 *   This is the better default for a digital game, since it gives real variety every game.
 */

import { type HexCoord, hexId, neighbors, parseHexId } from '../coords/axial.js';
import { hexToPixel, makeLayout } from '../coords/layout.js';
import type { EdgeId, HexId, TerrainId } from '../ids.js';
import { type RngState, shuffle } from '../rng.js';
import type { HarborSlot, HarborSpec } from './scenario.js';
import type { Topology } from './topology.js';

/** Numbers drawn in red on the tokens — the two most productive rolls. */
export const RED_NUMBERS: readonly number[] = [6, 8];

export function isRed(n: number): boolean {
  return RED_NUMBERS.includes(n);
}

export class GenerationError extends Error {}

// ── Coastline ───────────────────────────────────────────────────────────────────────────────

/**
 * The island's coastal edges, in order around the shore.
 *
 * A coastal edge separates land from water. The ordering matters because harbours are spaced
 * around the shore, and it exists because the coast is always a single cycle: every coastal vertex
 * has exactly two coastal edges, whether it touches one land hex or two.
 */
export function coastlineEdges(
  topology: Topology,
  isLand: (hex: HexId) => boolean,
): readonly EdgeId[] {
  const coastal = topology.edges.filter((e) => {
    const hexes = topology.edgeHexes.get(e) ?? [];
    return hexes.length === 2 && hexes.filter(isLand).length === 1;
  });
  if (coastal.length === 0) return [];

  // Index coastal edges by the vertices they meet at, then walk the cycle.
  const byVertex = new Map<string, EdgeId[]>();
  for (const e of coastal) {
    for (const v of topology.edgeVertices.get(e) ?? []) {
      const list = byVertex.get(v) ?? [];
      list.push(e);
      byVertex.set(v, list);
    }
  }

  const ordered: EdgeId[] = [];
  const visited = new Set<EdgeId>();
  let current = coastal[0] as EdgeId;
  let entryVertex: string | undefined;

  for (;;) {
    ordered.push(current);
    visited.add(current);

    const ends = topology.edgeVertices.get(current) ?? [];
    // Leave by the end we did not arrive through, so the walk keeps going the same way round.
    const exit = ends.find((v) => v !== entryVertex) ?? ends[0];
    if (exit === undefined) break;

    const next = (byVertex.get(exit) ?? []).find((e) => e !== current && !visited.has(e));
    if (next === undefined) break;
    entryVertex = exit;
    current = next;
  }

  if (ordered.length !== coastal.length) {
    throw new GenerationError(
      `coastlineEdges: walked ${ordered.length} of ${coastal.length} coastal edges — ` +
        'the landmass is probably not simply connected (multiple islands need one walk each)',
    );
  }
  return ordered;
}

/**
 * Space `count` harbours evenly around the shore.
 *
 * The physical game fixes harbour positions on its sea frame pieces, but the rulebook explicitly
 * allows varying them ("if you want to vary relative harbor locations slightly, just shuffle the
 * order of the frame pieces"), so even spacing is a legitimate arrangement rather than an
 * approximation of one. Harbour *types* still come from the official bag.
 */
export function spaceHarborsAroundCoast(
  coast: readonly EdgeId[],
  count: number,
): readonly EdgeId[] {
  if (count <= 0) return [];
  if (count > coast.length) {
    throw new GenerationError(
      `spaceHarborsAroundCoast: asked for ${count} harbours but the coast is only ${coast.length} edges`,
    );
  }
  const out: EdgeId[] = [];
  for (let i = 0; i < count; i++) {
    out.push(coast[Math.round((i * coast.length) / count) % coast.length] as EdgeId);
  }
  return out;
}

/** Assign harbour specs to slots, shuffling the bag. */
export function dealHarbors(
  slots: readonly EdgeId[],
  bag: readonly HarborSpec[],
  rng: RngState,
): { readonly slots: readonly HarborSlot[]; readonly state: RngState } {
  if (bag.length !== slots.length) {
    throw new GenerationError(
      `dealHarbors: ${slots.length} slots but ${bag.length} harbours in the bag`,
    );
  }
  const { value: dealt, state } = shuffle(rng, bag);
  return {
    slots: slots.map((edge, i) => ({ edge, harbor: dealt[i] as HarborSpec })),
    state,
  };
}

// ── Token placement order ───────────────────────────────────────────────────────────────────

/**
 * Land hexes in outside-in counter-clockwise spiral order — the rulebook's lettered-token order.
 *
 * Implemented by peeling boundary rings and sorting each by angle about the board's centre. The
 * angle sort is exact for the convex boards we generate; a concave landmass would need a boundary
 * walk instead, which is why `spiral` is not the default token order.
 */
export function spiralOrder(land: readonly HexId[]): readonly HexId[] {
  const layout = makeLayout(1);
  const remaining = new Set<HexId>(land);
  const centre = centroidOf(land, layout);
  const out: HexId[] = [];

  while (remaining.size > 0) {
    const ring = [...remaining].filter((h) =>
      neighbors(parseHexId(h)).some((n) => !remaining.has(hexId(n))),
    );
    // A fully enclosed remainder cannot happen — a finite set always has a boundary — but guard
    // rather than spin forever if that ever stops being true.
    if (ring.length === 0) {
      out.push(...remaining);
      break;
    }
    // Negated angle so the walk runs counter-clockwise in screen space, where y grows downward.
    ring.sort((a, b) => angleOf(b, centre, layout) - angleOf(a, centre, layout));
    out.push(...ring);
    for (const h of ring) remaining.delete(h);
  }
  return out;
}

function centroidOf(hexes: readonly HexId[], layout: ReturnType<typeof makeLayout>) {
  let x = 0;
  let y = 0;
  for (const h of hexes) {
    const p = hexToPixel(layout, parseHexId(h));
    x += p.x;
    y += p.y;
  }
  return { x: x / hexes.length, y: y / hexes.length };
}

function angleOf(
  hex: HexId,
  centre: { x: number; y: number },
  layout: ReturnType<typeof makeLayout>,
): number {
  const p = hexToPixel(layout, parseHexId(hex));
  return Math.atan2(p.y - centre.y, p.x - centre.x);
}

// ── Terrain ─────────────────────────────────────────────────────────────────────────────────

/** Shuffle a terrain bag onto the land hexes. The official variable setup, verbatim. */
export function dealTerrain(
  land: readonly HexId[],
  bag: readonly TerrainId[],
  rng: RngState,
): { readonly terrain: ReadonlyMap<HexId, TerrainId>; readonly state: RngState } {
  if (bag.length !== land.length) {
    throw new GenerationError(
      `dealTerrain: ${land.length} land hexes but ${bag.length} terrain tiles in the bag`,
    );
  }
  const { value: dealt, state } = shuffle(rng, bag);
  const terrain = new Map<HexId, TerrainId>();
  for (const [i, h] of land.entries()) terrain.set(h, dealt[i] as TerrainId);
  return { terrain, state };
}

// ── Number tokens ───────────────────────────────────────────────────────────────────────────

export type NumberOrder = 'random' | 'spiral';

/**
 * Deal number tokens to the producing hexes.
 *
 * Deserts are skipped — they never receive a token — so `bag` must have exactly as many tokens as
 * there are non-desert land hexes.
 *
 * In `random` mode the result satisfies the almanac's constraint that **no two red numbers (6 and
 * 8) are adjacent**. Rejection sampling alone is unreliable on dense boards, so a rejected layout
 * is repaired by swapping an offending token with one whose neighbourhood is clear.
 */
export function dealNumbers(
  order: NumberOrder,
  landInSpiralOrder: readonly HexId[],
  producing: ReadonlySet<HexId>,
  bag: readonly number[],
  rng: RngState,
): { readonly numbers: ReadonlyMap<HexId, number>; readonly state: RngState } {
  const targets = landInSpiralOrder.filter((h) => producing.has(h));
  if (bag.length !== targets.length) {
    throw new GenerationError(
      `dealNumbers: ${targets.length} producing hexes but ${bag.length} tokens in the bag`,
    );
  }

  if (order === 'spiral') {
    // Alphabetical tokens along the spiral: the bag is already in ascending letter order.
    const numbers = new Map<HexId, number>();
    for (const [i, h] of targets.entries()) numbers.set(h, bag[i] as number);
    return { numbers, state: rng };
  }

  const { value: dealt, state } = shuffle(rng, bag);
  const assignment = [...dealt] as number[];
  const repaired = separateRedNumbers(targets, assignment);
  const numbers = new Map<HexId, number>();
  for (const [i, h] of targets.entries()) numbers.set(h, repaired[i] as number);
  return { numbers, state };
}

/**
 * Swap tokens until no two red numbers sit on adjacent hexes.
 *
 * Deterministic given the input order, so it does not consume entropy — which keeps the caller's
 * RNG accounting simple and the whole deal reproducible from the shuffle alone.
 */
function separateRedNumbers(hexes: readonly HexId[], numbers: number[]): readonly number[] {
  const index = new Map<HexId, number>();
  for (const [i, h] of hexes.entries()) index.set(h, i);

  const adjacentIndices = hexes.map((h) =>
    neighbors(parseHexId(h))
      .map((n) => index.get(hexId(n)))
      .filter((i): i is number => i !== undefined),
  );

  const conflicts = (): number => {
    for (let i = 0; i < numbers.length; i++) {
      if (!isRed(numbers[i] as number)) continue;
      for (const j of adjacentIndices[i] ?? []) {
        if (isRed(numbers[j] as number)) return i;
      }
    }
    return -1;
  };

  // Each swap strictly reduces the number of red-red adjacencies or moves a red to a clear spot;
  // the bound is generous insurance against a pathological board rather than an expected path.
  const limit = numbers.length * numbers.length + 64;
  for (let step = 0; step < limit; step++) {
    const bad = conflicts();
    if (bad < 0) return numbers;

    // Find a non-red position whose neighbourhood holds no red, and swap into it.
    const target = numbers.findIndex(
      (n, i) =>
        !isRed(n) &&
        i !== bad &&
        !(adjacentIndices[i] ?? []).some((j) => j !== bad && isRed(numbers[j] as number)),
    );
    if (target < 0) {
      throw new GenerationError(
        'separateRedNumbers: no placement keeps the red numbers apart on this board',
      );
    }
    const tmp = numbers[bad] as number;
    numbers[bad] = numbers[target] as number;
    numbers[target] = tmp;
  }
  throw new GenerationError('separateRedNumbers: did not converge');
}

// ── Proportional bags for generated boards ──────────────────────────────────────────────────

/**
 * Distribute `total` items over `weights` using largest-remainder allocation.
 *
 * Largest-remainder rather than naive rounding because the parts must sum to exactly `total` —
 * a bag with one tile too many or too few would fail `dealTerrain`'s length check at setup.
 */
export function allocateProportionally(
  total: number,
  weights: readonly number[],
): readonly number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new GenerationError('allocateProportionally: weights sum to zero');

  const exact = weights.map((w) => (w * total) / sum);
  const base = exact.map(Math.floor);
  let remaining = total - base.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = [...base];
  for (const { i } of order) {
    if (remaining <= 0) break;
    out[i] = (out[i] as number) + 1;
    remaining--;
  }
  return out;
}

/** The eight numbers that appear at full count on an official board. There is no 7. */
const COMMON_NUMBERS: readonly number[] = [3, 4, 5, 6, 8, 9, 10, 11];
/** 2 and 12 appear at half the count of the others, being the least likely rolls. */
const RARE_NUMBERS: readonly number[] = [2, 12];

/**
 * A number-token bag of exactly `total` tokens following the official pattern.
 *
 * The official bags give 2 and 12 half the count of every other number: base is
 * `{2:1, 12:1, rest:2}` = 18 and 5-6 is `{2:2, 12:2, rest:3}` = 28.
 *
 * Allocating the two groups separately — rather than by proportional rounding over all ten values
 * — is what makes "2 and 12 are never the *most* common" structurally true. Proportional rounding
 * distributes its remainder by fractional part, which at some sizes leaves a common number rarer
 * than 2 and quietly inverts the board's design intent. Here every leftover token goes to a common
 * number, so `rare <= common` holds by construction at every size.
 *
 * Below 10 tokens there is not room for all ten values; the rare ones drop out first.
 */
export function numberBagOfSize(total: number): readonly number[] {
  if (total < 0) throw new GenerationError(`numberBagOfSize: negative total ${total}`);

  // Largest `common` whose group total still fits, with `rare = ceil(common / 2)`.
  let common = 0;
  while (
    COMMON_NUMBERS.length * (common + 1) + RARE_NUMBERS.length * Math.ceil((common + 1) / 2) <=
    total
  ) {
    common++;
  }
  const rare = Math.ceil(common / 2);

  const bag: number[] = [];
  for (const v of RARE_NUMBERS) for (let k = 0; k < rare; k++) bag.push(v);
  for (const v of COMMON_NUMBERS) for (let k = 0; k < common; k++) bag.push(v);

  // Spread whatever is left over the common numbers, one each, so counts stay within 1 of level.
  for (let i = 0; bag.length < total; i++) {
    bag.push(COMMON_NUMBERS[i % COMMON_NUMBERS.length] as number);
  }
  return bag.sort((a, b) => a - b);
}

/**
 * A terrain bag of `total` tiles in the base game's proportions.
 *
 * Base is 4 forest / 4 pasture / 4 fields / 3 hills / 3 mountains / 1 desert out of 19, and 5-6 is
 * 6/6/6/5/5/2 out of 30 — the same shape scaled up.
 */
export function terrainBagOfSize(total: number, deserts: number): readonly TerrainId[] {
  if (deserts >= total) {
    throw new GenerationError(
      `terrainBagOfSize: ${deserts} deserts does not fit in ${total} tiles`,
    );
  }
  const producing: readonly TerrainId[] = ['forest', 'pasture', 'fields', 'hills', 'mountains'];
  const counts = allocateProportionally(total - deserts, [4, 4, 4, 3, 3]);
  const bag: TerrainId[] = [];
  producing.forEach((t, i) => {
    for (let k = 0; k < (counts[i] as number); k++) bag.push(t);
  });
  for (let k = 0; k < deserts; k++) bag.push('desert');
  return bag;
}

/** Land hexes as a compact, connected, roughly hexagonal region of `count` cells. */
export function compactRegion(
  count: number,
  spiralHexes: readonly HexCoord[],
): readonly HexCoord[] {
  if (count > spiralHexes.length) {
    throw new GenerationError(
      `compactRegion: need ${count} hexes but only ${spiralHexes.length} available — widen the spiral`,
    );
  }
  return spiralHexes.slice(0, count);
}
