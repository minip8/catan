import { describe, expect, it } from 'vitest';
import { isRed } from '../board/generate.js';
import {
  baseScenario34,
  baseScenario56,
  generatedScenario,
  HARBOR_BAG_34,
  NUMBER_BAG_34,
  TERRAIN_BAG_34,
  TERRAIN_BAG_56,
} from '../board/presets.js';
import { hexId, neighbors, parseHexId } from '../coords/axial.js';
import { type HexId, playerId } from '../ids.js';
import { baseRules, DEV_DECK_COMPOSITION } from '../rulesets/base/index.js';
import { assertInvariants } from '../state/invariants.js';
import { invariantsFor, newGame } from './newGame.js';

const rules = baseRules();

function counts(values: readonly (string | number)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

describe('newGame', () => {
  const game = newGame({ scenario: baseScenario34(), rules, seed: 42, players: 4 });
  const { state, ctx } = game;
  const land = ctx.topology.hexes.filter((h) => state.board.hexes[h]?.class === 'land');

  it('deals exactly the printed terrain bag', () => {
    expect(land).toHaveLength(19);
    expect(counts(land.map((h) => state.board.hexes[h]?.terrain ?? 'none'))).toEqual(
      counts(TERRAIN_BAG_34),
    );
  });

  it('deals exactly the printed number bag, and never onto the desert', () => {
    const tokens = land.flatMap((h) => state.board.hexes[h]?.numbers ?? []);
    expect(counts(tokens)).toEqual(counts(NUMBER_BAG_34));

    for (const h of land) {
      const hex = state.board.hexes[h];
      const produces = hex?.terrain !== undefined && rules.terrainYield[hex.terrain ?? ''] != null;
      expect(hex?.numbers.length).toBe(produces ? 1 : 0);
    }
  });

  // The almanac's constraint on the random token variant. It is checked here rather than only in
  // the generator's own tests because it is a property of a *dealt game*, which is what players see.
  it('never puts two red numbers side by side', () => {
    for (const h of land) {
      const mine = (state.board.hexes[h]?.numbers ?? []).filter(isRed);
      if (mine.length === 0) continue;
      for (const n of neighbors(parseHexId(h))) {
        const theirs = (state.board.hexes[hexId(n)]?.numbers ?? []).filter(isRed);
        expect(theirs).toHaveLength(0);
      }
    }
  });

  it('docks the printed harbours, one spec on each end of its edge', () => {
    const harbors = Object.values(state.board.harbors);
    // Nine harbours, each reachable from either end of the coastal edge it sits on.
    expect(harbors).toHaveLength(HARBOR_BAG_34.length * 2);
    const bag = counts(harbors.map((h) => `${h.ratio}:${h.kind ?? 'any'}`));
    const expected = counts(HARBOR_BAG_34.map((h) => `${h.ratio}:${h.kind ?? 'any'}`));
    for (const [key, n] of Object.entries(expected)) expect(bag[key]).toBe(n * 2);
  });

  it('starts the robber on the desert', () => {
    const robber = Object.values(state.board.pieces).find((p) => p.kind === 'robber');
    expect(robber).toBeDefined();
    const hex = robber?.at == null ? undefined : state.board.hexes[robber.at as HexId];
    expect(hex?.terrain).toBe('desert');
  });

  it('builds the whole development deck, face down', () => {
    const deck = state.decks.dev;
    const total = Object.values(DEV_DECK_COMPOSITION).reduce((a, b) => a + b, 0);
    expect(deck?.draw).toHaveLength(total);
    expect(deck?.discard).toHaveLength(0);
    expect(counts(deck?.draw.map((c) => state.cardInstances[c]?.def ?? '?') ?? [])).toEqual(
      counts(
        Object.entries(DEV_DECK_COMPOSITION).flatMap(([def, n]) =>
          Array.from({ length: n }, () => def),
        ),
      ),
    );
  });

  it('seats the players with full supplies and empty hands', () => {
    expect(state.seatOrder).toEqual([0, 1, 2, 3].map(playerId));
    for (const p of Object.values(state.players)) {
      expect(p.supply).toEqual({ road: 15, settlement: 5, city: 4 });
      expect(Object.values(p.cards).every((n) => n === 0)).toBe(true);
      expect(p.hands.dev).toEqual([]);
    }
    expect(state.bank).toEqual({ brick: 19, lumber: 19, ore: 19, grain: 19, wool: 19 });
  });

  it('opens with one setup step per player per round, then the first turn', () => {
    // Stack top is the first placement; the bottom is the turn that follows the opening.
    expect(state.stack).toHaveLength(4 * 2 + 1);
    expect(state.stack.at(-1)).toMatchObject({ kind: 'setup', actor: playerId(0) });
    expect(state.stack.at(0)).toMatchObject({ kind: 'beginTurn', actor: 'system' });
    // Round two runs backwards, so the last player places twice in a row: the two steps either
    // side of the round boundary both belong to p3.
    expect(state.stack.at(5)).toMatchObject({ actor: playerId(3) });
    expect(state.stack.at(4)).toMatchObject({ actor: playerId(3) });
  });

  it('passes its own invariants', () => {
    assertInvariants(state, invariantsFor(ctx, state));
  });

  it('is a pure function of its seed', () => {
    const again = newGame({ scenario: baseScenario34(), rules: baseRules(), seed: 42, players: 4 });
    expect(again.state).toEqual(state);

    const other = newGame({ scenario: baseScenario34(), rules: baseRules(), seed: 43, players: 4 });
    expect(other.state).not.toEqual(state);
  });
});

describe('newGame on the other boards', () => {
  it('deals the 5-6 player board', () => {
    const { state, ctx } = newGame({ scenario: baseScenario56(), rules, seed: 9, players: 6 });
    const land = ctx.topology.hexes.filter((h) => state.board.hexes[h]?.class === 'land');
    expect(land).toHaveLength(30);
    expect(counts(land.map((h) => state.board.hexes[h]?.terrain ?? 'none'))).toEqual(
      counts(TERRAIN_BAG_56),
    );
    expect(state.bank.brick).toBe(24);
    assertInvariants(state, invariantsFor(ctx, state));
  });

  // No published rules above six players, so these boards derive their bags from the coast and
  // the land count rather than from a printed table. That path has to work end to end.
  it('deals a generated 7-player board from derived bags', () => {
    const scenario = generatedScenario(7);
    const { state, ctx } = newGame({ scenario, rules, seed: 5, players: 7 });
    const land = ctx.topology.hexes.filter((h) => state.board.hexes[h]?.class === 'land');
    expect(land).toHaveLength(36);
    expect(Object.keys(state.board.harbors).length).toBeGreaterThan(0);
    assertInvariants(state, invariantsFor(ctx, state));
  });

  it('refuses a player count the scenario does not seat', () => {
    expect(() => newGame({ scenario: baseScenario34(), rules, seed: 1, players: 6 })).toThrow(
      /seats 3-4 players/,
    );
  });
});
