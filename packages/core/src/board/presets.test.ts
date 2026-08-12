import { describe, expect, it } from 'vitest';

import { hexId, neighbors, parseHexId, spiral } from '../coords/axial.js';
import type { EdgeId, HexId, TerrainId, VertexId } from '../ids.js';
import { seedRng } from '../rng.js';
import {
  coastlineEdges,
  dealHarbors,
  dealNumbers,
  dealTerrain,
  isRed,
  numberBagOfSize,
  spaceHarborsAroundCoast,
  spiralOrder,
  terrainBagOfSize,
} from './generate.js';
import {
  bankForPlayers,
  baseScenario34,
  baseScenario56,
  desertCountForLand,
  HARBOR_BAG_34,
  HARBOR_BAG_56,
  harborCountForCoast,
  island34,
  island56,
  landCountForPlayers,
  NUMBER_BAG_34,
  NUMBER_BAG_56,
  scenarioForPlayers,
  TERRAIN_BAG_34,
  TERRAIN_BAG_56,
} from './presets.js';
import { buildTopology } from './topology.js';

function tally<T>(items: readonly T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}

describe('official island shapes', () => {
  it('3-4 players is 19 hexes in rows of 3/4/5/4/3', () => {
    const island = island34();
    expect(island).toHaveLength(19);
    const rows = tally(island.map((h) => h.r));
    expect([...rows.keys()].sort((a, b) => a - b).map((r) => rows.get(r))).toEqual([3, 4, 5, 4, 3]);
  });

  /**
   * 30 hexes in rows of 3/4/5/6/5/4/3, confirmed from the extension's token-placement diagram:
   * 28 letters (A-Y plus ZA/ZB/ZC) over 30 hexes with 2 deserts.
   */
  it('5-6 players is 30 hexes in rows of 3/4/5/6/5/4/3', () => {
    const island = island56();
    expect(island).toHaveLength(30);
    const rows = tally(island.map((h) => h.r));
    expect([...rows.keys()].sort((a, b) => a - b).map((r) => rows.get(r))).toEqual([
      3, 4, 5, 6, 5, 4, 3,
    ]);
  });

  /** Every row centred on the same x is the geometric check that the bounds are right. */
  it('5-6 players is horizontally centred on every row', () => {
    const byRow = new Map<number, number[]>();
    for (const { q, r } of island56()) {
      byRow.set(r, [...(byRow.get(r) ?? []), q]);
    }
    for (const [r, qs] of byRow) {
      // Pointy-top x is proportional to q + r/2.
      const centre = (Math.min(...qs) + Math.max(...qs)) / 2 + r / 2;
      expect(centre).toBeCloseTo(-0.5, 10);
    }
  });

  it('both islands are contiguous', () => {
    for (const island of [island34(), island56()]) {
      const ids = new Set(island.map(hexId));
      for (const h of island) {
        expect(neighbors(h).some((n) => ids.has(hexId(n)))).toBe(true);
      }
    }
  });
});

describe('official component counts', () => {
  it('3-4 terrain: 19 tiles as 4 forest, 4 pasture, 4 fields, 3 hills, 3 mountains, 1 desert', () => {
    expect(TERRAIN_BAG_34).toHaveLength(19);
    expect(Object.fromEntries(tally(TERRAIN_BAG_34))).toEqual({
      forest: 4,
      pasture: 4,
      fields: 4,
      hills: 3,
      mountains: 3,
      desert: 1,
    });
  });

  it('5-6 terrain: 30 tiles as 6/6/6/5/5/2', () => {
    expect(TERRAIN_BAG_56).toHaveLength(30);
    expect(Object.fromEntries(tally(TERRAIN_BAG_56))).toEqual({
      forest: 6,
      pasture: 6,
      fields: 6,
      hills: 5,
      mountains: 5,
      desert: 2,
    });
  });

  it('5-6 terrain is exactly the 3-4 bag plus the extension 11 (1 desert, 2 of each other)', () => {
    const base = tally(TERRAIN_BAG_34);
    const ext = tally(TERRAIN_BAG_56);
    const added = [...ext].map(([t, n]) => [t, n - (base.get(t) ?? 0)] as const);
    expect(Object.fromEntries(added)).toEqual({
      forest: 2,
      pasture: 2,
      fields: 2,
      hills: 2,
      mountains: 2,
      desert: 1,
    });
    expect(TERRAIN_BAG_56.length - TERRAIN_BAG_34.length).toBe(11);
  });

  it('3-4 numbers: 18 tokens, one 2, one 12, two of everything else, and no 7', () => {
    expect(NUMBER_BAG_34).toHaveLength(18);
    expect(Object.fromEntries(tally(NUMBER_BAG_34))).toEqual({
      2: 1,
      3: 2,
      4: 2,
      5: 2,
      6: 2,
      8: 2,
      9: 2,
      10: 2,
      11: 2,
      12: 1,
    });
    expect(NUMBER_BAG_34).not.toContain(7);
  });

  it('5-6 numbers: 28 tokens, two 2s, two 12s, three of everything else', () => {
    expect(NUMBER_BAG_56).toHaveLength(28);
    expect(Object.fromEntries(tally(NUMBER_BAG_56))).toEqual({
      2: 2,
      3: 3,
      4: 3,
      5: 3,
      6: 3,
      8: 3,
      9: 3,
      10: 3,
      11: 3,
      12: 2,
    });
    expect(NUMBER_BAG_56).not.toContain(7);
  });

  it('token bags cover every producing hex exactly', () => {
    expect(NUMBER_BAG_34).toHaveLength(19 - 1);
    expect(NUMBER_BAG_56).toHaveLength(30 - 2);
  });

  it('3-4 harbours: 9 as 4 generic 3:1 and one 2:1 per resource', () => {
    expect(HARBOR_BAG_34).toHaveLength(9);
    expect(HARBOR_BAG_34.filter((h) => h.kind === null)).toHaveLength(4);
    const specific = HARBOR_BAG_34.filter((h) => h.kind !== null);
    expect(specific).toHaveLength(5);
    expect(specific.every((h) => h.ratio === 2)).toBe(true);
    expect(new Set(specific.map((h) => h.kind))).toEqual(
      new Set(['brick', 'lumber', 'ore', 'grain', 'wool']),
    );
  });

  /** The extension adds a 3:1 generic and a 2:1 **wool** harbour, named in its frame instructions. */
  it('5-6 harbours: 11 as 5 generic and 6 specific, wool twice', () => {
    expect(HARBOR_BAG_56).toHaveLength(11);
    expect(HARBOR_BAG_56.filter((h) => h.kind === null)).toHaveLength(5);
    const specific = HARBOR_BAG_56.filter((h) => h.kind !== null);
    expect(specific).toHaveLength(6);
    expect(Object.fromEntries(tally(specific.map((h) => h.kind)))).toEqual({
      brick: 1,
      lumber: 1,
      ore: 1,
      grain: 1,
      wool: 2,
    });
  });

  it('banks hold 19 per resource for 3-4 and 24 for 5-6', () => {
    expect(baseScenario34().bankPerKind).toBe(19);
    expect(baseScenario56().bankPerKind).toBe(24);
  });

  it('both official scenarios need 10 victory points', () => {
    expect(baseScenario34().victoryTarget).toBe(10);
    expect(baseScenario56().victoryTarget).toBe(10);
  });

  /** Round one forward, round two reversed, resources from the second settlement only. */
  it('sets up in two rounds, the second reversed and granting production', () => {
    for (const s of [baseScenario34(), baseScenario56()]) {
      expect(s.setup).toHaveLength(2);
      expect(s.setup[0]).toEqual({
        order: 'forward',
        place: ['settlement', 'road'],
        grantProduction: false,
      });
      expect(s.setup[1]).toEqual({
        order: 'reverse',
        place: ['settlement', 'road'],
        grantProduction: true,
      });
    }
  });
});

describe('coastline and harbours', () => {
  function coastOf(island: readonly { q: number; r: number }[]) {
    const scenario = island.length === 19 ? baseScenario34() : baseScenario56();
    const topology = buildTopology(scenario.cells);
    const land = new Set<HexId>(island.map(hexId));
    return { topology, coast: coastlineEdges(topology, (h) => land.has(h)), land };
  }

  /**
   * The 19-hex island has a 30-edge shore: its 12 outer hexes contribute 3 edges each at the six
   * corners and 2 each along the six sides.
   */
  it('walks a 30-edge coast around the 3-4 island', () => {
    const { coast } = coastOf(island34());
    expect(coast).toHaveLength(30);
    expect(new Set(coast).size).toBe(30);
  });

  it('walks a closed loop, each edge sharing a vertex with the next', () => {
    const { topology, coast } = coastOf(island34());
    // Every coastal edge came out of the topology, so its endpoints must be present.
    const endsOf = (e: EdgeId): readonly VertexId[] => {
      const ends = topology.edgeVertices.get(e);
      if (ends === undefined) throw new Error(`coastal edge ${e} has no endpoints`);
      return ends;
    };
    for (const [i, edge] of coast.entries()) {
      const next = coast[(i + 1) % coast.length] as EdgeId;
      const a = endsOf(edge);
      const b = endsOf(next);
      expect(a.some((v) => b.includes(v))).toBe(true);
    }
  });

  it('every coastal edge separates exactly one land hex from water', () => {
    const { topology, coast, land } = coastOf(island34());
    for (const e of coast) {
      const hexes = topology.edgeHexes.get(e) ?? [];
      expect(hexes.filter((h) => land.has(h))).toHaveLength(1);
    }
  });

  /** The coast-length heuristic must reproduce both published harbour counts from geometry alone. */
  it('derives 9 harbours for the 3-4 island and 11 for the 5-6 island', () => {
    expect(harborCountForCoast(coastOf(island34()).coast.length)).toBe(9);
    expect(harborCountForCoast(coastOf(island56()).coast.length)).toBe(11);
  });

  it('spaces harbours around the coast without repeating a slot', () => {
    const { coast } = coastOf(island34());
    const slots = spaceHarborsAroundCoast(coast, 9);
    expect(slots).toHaveLength(9);
    expect(new Set(slots).size).toBe(9);
    for (const s of slots) expect(coast).toContain(s);
  });

  it('deals the whole harbour bag into the slots', () => {
    const { coast } = coastOf(island34());
    const slots = spaceHarborsAroundCoast(coast, 9);
    const { slots: dealt } = dealHarbors(slots, HARBOR_BAG_34, seedRng(7));
    expect(dealt).toHaveLength(9);
    expect(tally(dealt.map((d) => JSON.stringify(d.harbor)))).toEqual(
      tally(HARBOR_BAG_34.map((h) => JSON.stringify(h))),
    );
  });

  it('rejects a mismatched harbour bag', () => {
    const { coast } = coastOf(island34());
    expect(() => dealHarbors(spaceHarborsAroundCoast(coast, 9), HARBOR_BAG_56, seedRng(1))).toThrow(
      /9 slots but 11 harbours/,
    );
  });
});

describe('dealing terrain and number tokens', () => {
  const scenario = baseScenario34();
  const topology = buildTopology(scenario.cells);
  const land = island34().map(hexId);

  it('deals the exact terrain bag onto the land hexes', () => {
    const { terrain } = dealTerrain(land, TERRAIN_BAG_34, seedRng(11));
    expect(terrain.size).toBe(19);
    expect(tally([...terrain.values()])).toEqual(tally(TERRAIN_BAG_34));
  });

  it('rejects a terrain bag that does not fit the island', () => {
    expect(() => dealTerrain(land, TERRAIN_BAG_56, seedRng(1))).toThrow(/19 land hexes but 30/);
  });

  it('visits every land hex exactly once in spiral order, outermost first', () => {
    const order = spiralOrder(land);
    expect(new Set(order)).toEqual(new Set(land));
    expect(order).toHaveLength(19);
    // The 12 outer hexes come before the 6 middle ring, which come before the centre.
    expect(order[order.length - 1]).toBe(hexId({ q: 0, r: 0 }));
    const outerRadius = order.slice(0, 12).map((h) => {
      const { q, r } = parseHexId(h);
      return Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r));
    });
    expect(outerRadius.every((d) => d === 2)).toBe(true);
  });

  /**
   * The almanac's constraint on the fully-random setup: "the tokens with the red numbers must not
   * be next to each other." Checked across many seeds because a single lucky deal proves nothing.
   */
  it('never leaves two red numbers adjacent, over many seeds', () => {
    const order = spiralOrder(land);
    for (let seed = 0; seed < 200; seed++) {
      const { terrain } = dealTerrain(land, TERRAIN_BAG_34, seedRng(seed));
      const producing = new Set([...terrain].filter(([, t]) => t !== 'desert').map(([h]) => h));
      const { numbers } = dealNumbers('random', order, producing, NUMBER_BAG_34, seedRng(seed));

      expect(numbers.size).toBe(18);
      expect(tally([...numbers.values()])).toEqual(tally(NUMBER_BAG_34));

      for (const [hex, n] of numbers) {
        if (!isRed(n)) continue;
        for (const nb of neighbors(parseHexId(hex))) {
          const other = numbers.get(hexId(nb));
          if (other !== undefined) expect(isRed(other)).toBe(false);
        }
      }
    }
  });

  it('never gives a desert a number token', () => {
    const order = spiralOrder(land);
    const { terrain } = dealTerrain(land, TERRAIN_BAG_34, seedRng(3));
    const deserts = [...terrain].filter(([, t]) => t === 'desert').map(([h]) => h);
    const producing = new Set([...terrain].filter(([, t]) => t !== 'desert').map(([h]) => h));
    const { numbers } = dealNumbers('random', order, producing, NUMBER_BAG_34, seedRng(3));
    for (const d of deserts) expect(numbers.has(d)).toBe(false);
  });

  it('lays tokens along the spiral in bag order when asked', () => {
    const order = spiralOrder(land);
    const producing = new Set(land.filter((h) => h !== hexId({ q: 0, r: 0 })));
    const { numbers } = dealNumbers('spiral', order, producing, NUMBER_BAG_34, seedRng(1));
    const producingInOrder = order.filter((h) => producing.has(h));
    for (const [i, h] of producingInOrder.entries()) {
      expect(numbers.get(h)).toBe(NUMBER_BAG_34[i]);
    }
  });

  it('rejects a token bag that does not match the producing hex count', () => {
    const order = spiralOrder(land);
    const producing = new Set(land);
    expect(() => dealNumbers('random', order, producing, NUMBER_BAG_34, seedRng(1))).toThrow(
      /19 producing hexes but 18 tokens/,
    );
  });

  it('is reproducible from the seed', () => {
    const order = spiralOrder(land);
    const deal = (seed: number) => {
      const { terrain } = dealTerrain(land, TERRAIN_BAG_34, seedRng(seed));
      const producing = new Set([...terrain].filter(([, t]) => t !== 'desert').map(([h]) => h));
      const { numbers } = dealNumbers('random', order, producing, NUMBER_BAG_34, seedRng(seed));
      return JSON.stringify([[...terrain].sort(), [...numbers].sort()]);
    };
    expect(deal(42)).toBe(deal(42));
    expect(deal(42)).not.toBe(deal(43));
  });

  it('produces a topology consistent with the dealt board', () => {
    const { terrain } = dealTerrain(land, TERRAIN_BAG_34, seedRng(5));
    for (const h of terrain.keys()) expect(topology.hexAxial.has(h)).toBe(true);
  });
});

describe('proportional bags for generated boards', () => {
  it('reproduces the official token bags from the scaling rule', () => {
    expect(tally(numberBagOfSize(18))).toEqual(tally(NUMBER_BAG_34));
    expect(tally(numberBagOfSize(28))).toEqual(tally(NUMBER_BAG_56));
  });

  it('reproduces the official terrain bags from the scaling rule', () => {
    expect(tally(terrainBagOfSize(19, 1))).toEqual(tally(TERRAIN_BAG_34));
    expect(tally(terrainBagOfSize(30, 2))).toEqual(tally(TERRAIN_BAG_56));
  });

  it('always produces a bag of exactly the requested size', () => {
    for (let n = 10; n <= 60; n++) {
      expect(numberBagOfSize(n)).toHaveLength(n);
      expect(terrainBagOfSize(n, 2)).toHaveLength(n);
    }
  });

  /**
   * 2 and 12 are the least likely rolls, so a board must never make them *more* common than an
   * ordinary number. Allocating the two groups separately guarantees this at every size; the
   * proportional-rounding version this replaced violated it for some totals.
   */
  it('never puts a 7 in a token bag, and never makes 2 or 12 more common than any other number', () => {
    for (let n = 10; n <= 60; n++) {
      const counts = tally(numberBagOfSize(n));
      expect(counts.get(7)).toBeUndefined();

      const rareCounts = [2, 12].map((v) => counts.get(v) ?? 0);
      const commonCounts = [3, 4, 5, 6, 8, 9, 10, 11].map((v) => counts.get(v) ?? 0);
      for (const r of rareCounts) {
        expect(r).toBeLessThanOrEqual(Math.min(...commonCounts));
      }
      // And no common number runs away from the others.
      expect(Math.max(...commonCounts) - Math.min(...commonCounts)).toBeLessThanOrEqual(1);
    }
  });

  it('always includes at least one desert', () => {
    for (let n = 10; n <= 60; n++) {
      expect(
        terrainBagOfSize(n, desertCountForLand(n)).filter((t) => t === 'desert').length,
      ).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('generated boards for 7-10 players', () => {
  it('routes 3-6 players to the official presets and 7-10 to generated ones', () => {
    expect(scenarioForPlayers(3).id).toBe('catan/base/3-4');
    expect(scenarioForPlayers(4).id).toBe('catan/base/3-4');
    expect(scenarioForPlayers(5).id).toBe('catan/base/5-6');
    expect(scenarioForPlayers(6).id).toBe('catan/base/5-6');
    for (const n of [7, 8, 9, 10]) {
      expect(scenarioForPlayers(n).id).toBe(`catan/generated/${n}`);
    }
    expect(() => scenarioForPlayers(2)).toThrow(/out of range/);
    expect(() => scenarioForPlayers(11)).toThrow(/out of range/);
  });

  /** Nothing above 6 players is official, and the UI has to be able to say so. */
  it('marks only the generated boards unofficial', () => {
    expect(baseScenario34().unofficial).toBeUndefined();
    expect(baseScenario56().unofficial).toBeUndefined();
    for (const n of [7, 8, 9, 10]) {
      expect(scenarioForPlayers(n).unofficial).toBe(true);
    }
  });

  it('scales land, deserts and the bank with the player count', () => {
    expect(landCountForPlayers(7)).toBe(36);
    expect(landCountForPlayers(10)).toBe(52);
    expect(bankForPlayers(4)).toBe(19);
    expect(bankForPlayers(6)).toBe(24);
    expect(bankForPlayers(8)).toBe(29);
    expect(bankForPlayers(10)).toBe(34);
  });

  it('builds a valid, contiguous, fully-coasted board for every generated size', () => {
    for (const players of [7, 8, 9, 10]) {
      const scenario = scenarioForPlayers(players);
      const topology = buildTopology(scenario.cells);
      const land = new Set<HexId>(
        scenario.cells.filter((c) => c.cell.kind === 'land').map(({ q, r }) => hexId({ q, r })),
      );

      expect(land.size).toBe(landCountForPlayers(players));

      // Contiguous: every land hex touches another.
      for (const h of land) {
        expect(neighbors(parseHexId(h)).some((n) => land.has(hexId(n)))).toBe(true);
      }
      // Every land hex has all six corners and borders, so nothing is unplaceable.
      for (const h of land) {
        expect(topology.hexVertices.get(h)).toHaveLength(6);
        expect(topology.hexEdges.get(h)).toHaveLength(6);
      }
      // And the shore is a single closed loop, so harbours can be spaced round it.
      const coast = coastlineEdges(topology, (h) => land.has(h));
      expect(coast.length).toBeGreaterThan(0);
      expect(harborCountForCoast(coast.length)).toBeGreaterThanOrEqual(9);
    }
  });

  it('deals a legal board at every generated size, with red numbers kept apart', () => {
    for (const players of [7, 8, 9, 10]) {
      const scenario = scenarioForPlayers(players);
      const land = scenario.cells
        .filter((c) => c.cell.kind === 'land')
        .map(({ q, r }) => hexId({ q, r }));
      const deserts = desertCountForLand(land.length);
      const terrainBag: readonly TerrainId[] = terrainBagOfSize(land.length, deserts);

      const { terrain } = dealTerrain(land, terrainBag, seedRng(players));
      const producing = new Set([...terrain].filter(([, t]) => t !== 'desert').map(([h]) => h));
      const { numbers } = dealNumbers(
        'random',
        spiralOrder(land),
        producing,
        numberBagOfSize(producing.size),
        seedRng(players),
      );

      expect(numbers.size).toBe(producing.size);
      for (const [hex, n] of numbers) {
        if (!isRed(n)) continue;
        for (const nb of neighbors(parseHexId(hex))) {
          const other = numbers.get(hexId(nb));
          if (other !== undefined) expect(isRed(other)).toBe(false);
        }
      }
    }
  });

  it('has room in the spiral for the biggest generated board', () => {
    expect(spiral(5).length).toBeGreaterThanOrEqual(landCountForPlayers(10));
  });
});
