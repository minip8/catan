import { describe, expect, it } from 'vitest';

import { baseScenario34, island34 } from '../board/presets.js';
import { buildTopology } from '../board/topology.js';
import { hexId } from '../coords/axial.js';
import { vertexEdges } from '../coords/edge.js';
import { hexCorners } from '../coords/vertex.js';
import {
  BASE_RESOURCES,
  type CardId,
  type CardKind,
  cardId,
  type EdgeId,
  type PlayerId,
  pieceId,
  playerId,
  type VertexId,
} from '../ids.js';
import { seedRng } from '../rng.js';
import type { GameState, PlayerState } from './gameState.js';
import { assertInvariants, checkInvariants, type InvariantContext } from './invariants.js';

const topology = buildTopology(baseScenario34().cells);
const P0 = playerId(0);
const P1 = playerId(1);

/** A vertex and one of its edges, on land, for placing test pieces. */
const CENTRE_VERTEX = hexCorners({ q: 0, r: 0 })[0] as VertexId;
const CENTRE_EDGE = vertexEdges(CENTRE_VERTEX)[0];
const OTHER_VERTEX = hexCorners({ q: 0, r: 0 })[3] as VertexId;

const BANK_PER_KIND = 19;
const PIECE_LIMITS = { road: 15, settlement: 5, city: 4, robber: null } as const;

const ctx: InvariantContext = {
  topology,
  cardTotals: Object.fromEntries(BASE_RESOURCES.map((r) => [r, BANK_PER_KIND])) as Record<
    CardKind,
    number
  >,
  pieceLimits: PIECE_LIMITS,
};

function emptyCards(): Record<CardKind, number> {
  return Object.fromEntries(BASE_RESOURCES.map((r) => [r, 0])) as Record<CardKind, number>;
}

function makePlayer(id: PlayerId, seat: number): PlayerState {
  return {
    id,
    seat,
    cards: emptyCards(),
    hands: { dev: [] },
    revealed: [],
    supply: { road: 15, settlement: 5, city: 4 },
    ext: {},
  };
}

/**
 * A valid two-player state: one settlement and one road for P0, the robber in place, and a
 * two-card development deck. Small enough to reason about, complete enough that every check has
 * something to inspect.
 */
function validState(): GameState {
  const settlement = pieceId(1);
  const road = pieceId(2);
  const robber = pieceId(3);
  const desert = hexId({ q: 0, r: 0 });

  const state: GameState = {
    scenarioId: baseScenario34().id,
    ruleSetId: 'test',
    seed: 1,
    seq: 4,
    board: {
      hexes: Object.fromEntries(
        island34().map((h) => [
          hexId(h),
          { class: 'land' as const, terrain: 'forest', numbers: [8], numbersHidden: false },
        ]),
      ),
      harbors: {},
      pieces: {
        [settlement]: { id: settlement, kind: 'settlement', owner: P0, at: CENTRE_VERTEX, st: {} },
        [road]: { id: road, kind: 'road', owner: P0, at: CENTRE_EDGE, st: {} },
        [robber]: { id: robber, kind: 'robber', owner: null, at: desert, st: {} },
      },
      occupancy: {
        [CENTRE_VERTEX]: [settlement],
        [CENTRE_EDGE]: [road],
        [desert]: [robber],
      },
    },
    players: {
      [P0]: { ...makePlayer(P0, 0), supply: { road: 14, settlement: 4, city: 4 } },
      [P1]: makePlayer(P1, 1),
    },
    seatOrder: [P0, P1],
    bank: Object.fromEntries(BASE_RESOURCES.map((r) => [r, BANK_PER_KIND])) as Record<
      CardKind,
      number
    >,
    decks: { dev: { draw: [cardId(1)], discard: [cardId(2)] } },
    cardInstances: {
      [cardId(1)]: { def: 'knight', deck: 'dev', acquiredTurn: null },
      [cardId(2)]: { def: 'monopoly', deck: 'dev', acquiredTurn: null },
    },
    awards: {
      longestRoad: { holder: null, value: 2, best: 0 },
      largestArmy: { holder: null, value: 2, best: 0 },
    },
    stack: [{ kind: 'main', actor: P0 }],
    turn: { n: 1, active: P0, flags: {} },
    rng: seedRng(1),
    ext: {},
    outcome: null,
  };
  return state;
}

describe('invariants', () => {
  it('accepts a well-formed state', () => {
    expect(checkInvariants(validState(), ctx)).toEqual([]);
    expect(() => assertInvariants(validState(), ctx)).not.toThrow();
  });

  describe('occupancy index', () => {
    it('catches a piece that occupancy does not list', () => {
      const s = validState();
      s.board.occupancy = { ...s.board.occupancy, [CENTRE_EDGE]: [] };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/occupancy does not list it/);
    });

    it('catches an occupancy entry pointing at a piece that moved', () => {
      const s = validState();
      const p = s.board.pieces[pieceId(1)];
      if (p !== undefined) p.at = OTHER_VERTEX;
      s.board.occupancy = { ...s.board.occupancy, [OTHER_VERTEX]: [pieceId(1)] };
      // Now both the stale entry and the new one exist.
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/but that piece is at/);
    });

    it('catches an unknown piece id in the index', () => {
      const s = validState();
      s.board.occupancy = { ...s.board.occupancy, [OTHER_VERTEX]: [pieceId(99)] };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/names unknown piece/);
    });

    it('catches the same piece listed twice at one locus', () => {
      const s = validState();
      s.board.occupancy = {
        ...s.board.occupancy,
        [CENTRE_VERTEX]: [pieceId(1), pieceId(1)],
      };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/lists a piece twice/);
    });

    it('catches a piece placed somewhere the topology has no such locus', () => {
      const s = validState();
      const bogus = 'not-a-real-locus' as EdgeId;
      const p = s.board.pieces[pieceId(2)];
      if (p !== undefined) p.at = bogus;
      s.board.occupancy = { ...s.board.occupancy, [CENTRE_EDGE]: [], [bogus]: [pieceId(2)] };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/not a locus in this topology/);
    });

    /** Neutral pieces have no owner, and off-board is a legal place to be. */
    it('accepts a piece that is off the board', () => {
      const s = validState();
      const robber = s.board.pieces[pieceId(3)];
      if (robber !== undefined) robber.at = null;
      s.board.occupancy = { ...s.board.occupancy, [hexId({ q: 0, r: 0 })]: [] };
      expect(checkInvariants(s, ctx)).toEqual([]);
    });
  });

  describe('piece supply', () => {
    /** This is what enforces the 15 road / 5 settlement / 4 city limits. */
    it('catches a supply that does not account for every piece', () => {
      const s = validState();
      const p = s.players[P0];
      if (p !== undefined) p.supply = { ...p.supply, road: 15 };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/accounts for 16 road.*expected 15/);
    });

    it('catches a negative supply', () => {
      const s = validState();
      const p = s.players[P0];
      if (p !== undefined) p.supply = { ...p.supply, city: -1 };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/negative city supply/);
    });

    /**
     * Upgrading a settlement to a city returns the settlement to its owner's supply, so the
     * accounting still balances for both kinds. If it did not, the limits would drift.
     */
    it('accepts a settlement upgraded to a city', () => {
      const s = validState();
      const settlement = s.board.pieces[pieceId(1)];
      if (settlement !== undefined) settlement.at = null;
      const city = pieceId(4);
      s.board.pieces[city] = { id: city, kind: 'city', owner: P0, at: CENTRE_VERTEX, st: {} };
      s.board.occupancy = { ...s.board.occupancy, [CENTRE_VERTEX]: [city] };
      const p = s.players[P0];
      if (p !== undefined) p.supply = { road: 14, settlement: 5, city: 3 };
      expect(checkInvariants(s, ctx)).toEqual([]);
    });
  });

  describe('card conservation', () => {
    /** The highest-value invariant: any payment or payout that loses a card trips it immediately. */
    it('catches a resource that vanished', () => {
      const s = validState();
      s.bank = { ...s.bank, brick: BANK_PER_KIND - 1 };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(
        /brick is not conserved: bank \+ hands = 18, expected 19/,
      );
    });

    it('catches a resource conjured from nowhere', () => {
      const s = validState();
      const p = s.players[P0];
      if (p !== undefined) p.cards = { ...p.cards, ore: 3 };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/ore is not conserved.*= 22, expected 19/);
    });

    it('accepts resources moved from the bank into a hand', () => {
      const s = validState();
      const p = s.players[P0];
      if (p !== undefined) p.cards = { ...p.cards, wool: 4 };
      s.bank = { ...s.bank, wool: BANK_PER_KIND - 4 };
      expect(checkInvariants(s, ctx)).toEqual([]);
    });

    it('catches a negative holding', () => {
      const s = validState();
      const p = s.players[P0];
      if (p !== undefined) p.cards = { ...p.cards, grain: -1 };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/holds -1 grain/);
    });
  });

  describe('decks', () => {
    it('catches a card in two places at once', () => {
      const s = validState();
      const p = s.players[P0];
      if (p !== undefined) p.hands = { dev: [cardId(1)] };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/is in both .* and .*hand/);
    });

    it('catches a card instance that is nowhere', () => {
      const s = validState();
      s.cardInstances[cardId(3)] = { def: 'vp', deck: 'dev', acquiredTurn: null };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/exists but is nowhere/);
    });

    it('catches a card in play with no instance record', () => {
      const s = validState();
      s.decks = { dev: { draw: [cardId(1), cardId(9) as CardId], discard: [cardId(2)] } };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/has no instance record/);
    });

    it('accepts a card drawn into a hand', () => {
      const s = validState();
      s.decks = { dev: { draw: [], discard: [cardId(2)] } };
      const p = s.players[P0];
      if (p !== undefined) p.hands = { dev: [cardId(1)] };
      expect(checkInvariants(s, ctx)).toEqual([]);
    });

    it('accepts a played knight held face up', () => {
      const s = validState();
      s.decks = { dev: { draw: [], discard: [cardId(2)] } };
      const p = s.players[P0];
      if (p !== undefined) p.revealed = [cardId(1)];
      expect(checkInvariants(s, ctx)).toEqual([]);
    });
  });

  describe('seating', () => {
    it('catches a player missing from seatOrder', () => {
      const s: GameState = { ...validState(), seatOrder: [P0] };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/is not in seatOrder/);
    });

    it('catches a seat index that disagrees with seatOrder', () => {
      const s: GameState = { ...validState(), seatOrder: [P1, P0] };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/has seat 0 but sits at index 1/);
    });

    it('catches a duplicate in seatOrder', () => {
      const s: GameState = { ...validState(), seatOrder: [P0, P0] };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/duplicate/);
    });
  });

  describe('stack and outcome', () => {
    /** An empty stack with no winner means nothing can ever happen again. */
    it('catches a stalled game', () => {
      const s = validState();
      s.stack = [];
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/nothing can happen next/);
    });

    it('accepts an empty stack once the game is over', () => {
      const s = validState();
      s.stack = [];
      s.outcome = { winner: P0, reason: '10 victory points' };
      expect(checkInvariants(s, ctx)).toEqual([]);
    });

    it('catches a step whose actor is not a player', () => {
      const s = validState();
      s.stack = [{ kind: 'main', actor: playerId(7) }];
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/names actor p7/);
    });

    it('catches an empty actor list', () => {
      const s = validState();
      s.stack = [{ kind: 'discard', actor: [] }];
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/empty actor list/);
    });

    /** Multi-actor steps are normal: discard-on-7 belongs to everyone who is over the limit. */
    it('accepts a step shared by several players', () => {
      const s = validState();
      s.stack = [{ kind: 'discard', actor: [P0, P1] }];
      expect(checkInvariants(s, ctx)).toEqual([]);
    });

    it('accepts a system step', () => {
      const s = validState();
      s.stack = [{ kind: 'production', actor: 'system' }];
      expect(checkInvariants(s, ctx)).toEqual([]);
    });

    it('catches a winner who is not a player', () => {
      const s = validState();
      s.outcome = { winner: playerId(9), reason: 'test' };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/names winner p9/);
    });
  });

  describe('awards', () => {
    it('catches an award held by a non-player', () => {
      const s = validState();
      s.awards = { ...s.awards, longestRoad: { holder: playerId(5), value: 2, best: 6 } };
      expect(checkInvariants(s, ctx).join('\n')).toMatch(/held by p5/);
    });

    /**
     * A vacant award is a legal base-game state: if the incumbent's road is broken and two players
     * tie for the new longest, the card is set aside until someone leads outright.
     */
    it('accepts a vacant award', () => {
      const s = validState();
      s.awards = { ...s.awards, longestRoad: { holder: null, value: 2, best: 5 } };
      expect(checkInvariants(s, ctx)).toEqual([]);
    });
  });

  it('reports every problem at once, not just the first', () => {
    const s: GameState = { ...validState(), seatOrder: [P0] };
    s.bank = { ...s.bank, brick: 0 };
    s.stack = [];
    expect(checkInvariants(s, ctx).length).toBeGreaterThanOrEqual(3);
  });

  it('assertInvariants names the count and lists the problems', () => {
    const s = validState();
    s.bank = { ...s.bank, brick: 0 };
    expect(() => assertInvariants(s, ctx)).toThrow(/violates 1 invariant/);
    expect(() => assertInvariants(s, ctx)).toThrow(/brick is not conserved/);
  });
});
