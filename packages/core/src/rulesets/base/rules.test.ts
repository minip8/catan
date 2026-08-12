/**
 * The base game's rules, exercised through the public reducer.
 *
 * Every test here drives the engine the way a client does — `legalActions`, then `reduce` — and
 * the invariants are checked after every accepted action by `act`. A test that manipulated the
 * state directly and then asserted on it would be testing its own fixture.
 */

import { describe, expect, it } from 'vitest';

import { edgeEndpoints, vertexEdges } from '../../coords/edge.js';
import { legalActions } from '../../engine/reduce.js';
import {
  act,
  advanceToMain,
  grant,
  handCards,
  laterTurn,
  lociOf,
  newBaseGame,
  offered,
  P,
  playSetup,
  refuse,
  rollUntilRobber,
  stackDeck,
  tick,
  vertexOf,
} from '../../game.testkit.js';
import type { EdgeId, VertexId } from '../../ids.js';
import { violatesDistanceRule } from '../../rules/placement.js';
import { currentStep, type GameState } from '../../state/gameState.js';
import { CITY_COST, DEV_CARD_COST, ROAD_COST, SETTLEMENT_COST } from './tables.js';

const [p0, p1] = P as [(typeof P)[0], (typeof P)[1]];

describe('the opening', () => {
  const game = newBaseGame(11);

  it('places in seat order, then backwards', () => {
    let state = game.state;
    const order: string[] = [];
    for (let i = 0; i < 8; i++) {
      const step = currentStep(state);
      order.push(String(step?.actor));
      // Each setup step wants a settlement first, then a road touching it.
      for (const kind of ['settlement', 'road']) {
        const options = offered(game.ctx, state, step?.actor as never, 'place');
        expect(options[0]?.kind).toBe(kind);
        state = act(game.ctx, state, step?.actor as never, options[0] as never);
      }
    }
    expect(order).toEqual(['p0', 'p1', 'p2', 'p3', 'p3', 'p2', 'p1', 'p0']);
  });

  it('pays out only for the second settlement', () => {
    const after = playSetup(game);
    for (const id of after.seatOrder) {
      const player = after.players[id];
      const held = Object.values(player?.cards ?? {}).reduce((a, b) => a + b, 0);
      // One card per producing hex around one settlement: at most three, and never nothing at all
      // on this board (the opening options are all inland).
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThanOrEqual(3);
      expect(player?.supply).toEqual({ road: 13, settlement: 3, city: 4 });
    }
  });

  it('refuses an opening road that does not touch the settlement just placed', () => {
    const settlement = offered(game.ctx, game.state, p0, 'place')[0];
    const state = act(game.ctx, game.state, p0, settlement as never);

    const touching = new Set(vertexEdges(settlement?.at as VertexId));
    const far = game.ctx.topology.edges.find((e) => !touching.has(e)) as EdgeId;
    refuse(game.ctx, state, p0, { type: 'place', kind: 'road', at: far }, 'notConnected');
  });

  it('refuses a settlement on an intersection next to one already built', () => {
    const settlement = offered(game.ctx, game.state, p0, 'place')[0];
    let state = act(game.ctx, game.state, p0, settlement as never);
    state = act(game.ctx, state, p0, offered(game.ctx, state, p0, 'place')[0] as never);

    const neighbour = game.ctx.topology.vertexNeighbors.get(settlement?.at as VertexId)?.[0];
    refuse(
      game.ctx,
      state,
      p1,
      { type: 'place', kind: 'settlement', at: neighbour as string },
      'tooClose',
    );
  });

  it('refuses a player who does not own the step', () => {
    refuse(
      game.ctx,
      game.state,
      p1,
      offered(game.ctx, game.state, p0, 'place')[0] as never,
      'notYourStep',
    );
  });
});

describe('building', () => {
  const game = newBaseGame(11);
  const opened = playSetup(game);

  function inMain(): GameState {
    return advanceToMain(game, opened, p0);
  }

  /**
   * Extend p0's road until a settlement is legally placeable.
   *
   * Needed because both ends of an opening road are adjacent to the settlement it came from, so
   * the distance rule leaves a fresh player with nowhere to build until they lay more road. That
   * is the rule working, not the fixture fighting it.
   */
  function reachable(state: GameState): { state: GameState; at: string } {
    let next = state;
    for (let i = 0; i < 6; i++) {
      const spot = offered(game.ctx, grant(next, p0, SETTLEMENT_COST), p0, 'build').find(
        (a) => a.kind === 'settlement',
      );
      if (spot !== undefined) return { state: next, at: spot.at as string };
      // Extend outward, not around: prefer a road that reaches an intersection nothing is built
      // next to. Taking the first option instead just circles the settlement it started from.
      const roads = offered(game.ctx, grant(next, p0, ROAD_COST), p0, 'build').filter(
        (a) => a.kind === 'road',
      );
      const reaches = (a: (typeof roads)[number], free: boolean): boolean =>
        edgeEndpoints(a.at as EdgeId).some(
          (v) =>
            (next.board.occupancy[v] ?? []).length === 0 &&
            (!free || !violatesDistanceRule(game.ctx, next, v)),
        );
      const road = roads.find((a) => reaches(a, true)) ?? roads.find((a) => reaches(a, false));
      if (road === undefined) throw new Error('reachable: nowhere to extend');
      next = act(game.ctx, grant(next, p0, ROAD_COST), p0, road);
    }
    throw new Error('reachable: no settlement spot within six roads');
  }

  it('charges for a road and extends the network', () => {
    const state = grant(inMain(), p0, ROAD_COST);
    const before = state.players[p0]?.cards.brick ?? 0;

    const options = offered(game.ctx, state, p0, 'build').filter((a) => a.kind === 'road');
    expect(options.length).toBeGreaterThan(0);
    const after = act(game.ctx, state, p0, options[0] as never);

    expect(after.players[p0]?.cards.brick).toBe(before - 1);
    expect(after.players[p0]?.supply.road).toBe(12);
    expect(lociOf(after, p0, 'road')).toHaveLength(3);
  });

  it('refuses a road with nothing to attach to', () => {
    const state = grant(inMain(), p0, ROAD_COST);
    const owned = new Set(lociOf(state, p0, 'road').flatMap((e) => edgeEndpoints(e as EdgeId)));
    const far = game.ctx.topology.edges.find(
      (e) =>
        !edgeEndpoints(e).some((v) => owned.has(v)) &&
        (state.board.occupancy[e] ?? []).length === 0,
    );
    refuse(game.ctx, state, p0, { type: 'build', kind: 'road', at: far }, 'notConnected');
  });

  it('refuses to build without the cost', () => {
    // The same placement, affordable and not: the spot's legality is settled first, so the only
    // difference between the two calls is the hand.
    const { state, at } = reachable(inMain());
    act(game.ctx, grant(state, p0, SETTLEMENT_COST), p0, { type: 'build', kind: 'settlement', at });
    refuse(game.ctx, state, p0, { type: 'build', kind: 'settlement', at }, 'cannotAfford');
  });

  it('upgrades a settlement to a city, returning the settlement to supply', () => {
    const state = grant(inMain(), p0, CITY_COST);
    const at = vertexOf(state, p0);
    const before = game.ctx.rules.victoryPoints(game.ctx, state, p0);

    const after = act(game.ctx, state, p0, { type: 'build', kind: 'city', at });

    expect(lociOf(after, p0, 'city')).toEqual([at]);
    expect(after.players[p0]?.supply).toMatchObject({ settlement: 4, city: 3 });
    expect(game.ctx.rules.victoryPoints(game.ctx, after, p0)).toBe(before + 1);
    expect(after.players[p0]?.cards.ore).toBe(0);
  });

  it('refuses a city where the player has no settlement', () => {
    const state = grant(inMain(), p0, CITY_COST);
    const at = vertexOf(state, p1);
    refuse(game.ctx, state, p0, { type: 'build', kind: 'city', at }, 'illegalTarget');
  });

  it('awards Longest Road at five connected segments, and scores it', () => {
    const metric = (state: GameState): number =>
      game.ctx.rules.awards.longestRoad?.metric(game.ctx, state, p0) ?? 0;

    let state = inMain();
    expect(state.awards.longestRoad?.holder).toBeNull();

    // Extend greedily: at each step take the road that lengthens the route the most.
    for (let i = 0; i < 12 && metric(state) < 5; i++) {
      const rich = grant(state, p0, ROAD_COST);
      const best = offered(game.ctx, rich, p0, 'build')
        .filter((a) => a.kind === 'road')
        .map((a) => ({ a, score: metric(act(game.ctx, rich, p0, a)) }))
        .sort((x, y) => y.score - x.score)[0];
      if (best === undefined) break;
      state = act(game.ctx, rich, p0, best.a);
    }

    expect(metric(state)).toBeGreaterThanOrEqual(5);
    expect(state.awards.longestRoad?.holder).toBe(p0);
    expect(state.awards.longestRoad?.best).toBe(metric(state));
    // Two settlements plus the award.
    expect(game.ctx.rules.victoryPoints(game.ctx, state, p0)).toBe(4);
  });

  it('offers settlements only where a road reaches and the distance rule allows', () => {
    const state = grant(reachable(inMain()).state, p0, SETTLEMENT_COST);
    const options = offered(game.ctx, state, p0, 'build').filter((a) => a.kind === 'settlement');
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      const at = option.at as VertexId;
      // Reachable along one of p0's own roads...
      expect(vertexEdges(at).some((e) => lociOf(state, p0, 'road').includes(e))).toBe(true);
      // ...and two clear intersections from anything already built.
      for (const n of game.ctx.topology.vertexNeighbors.get(at) ?? []) {
        expect(state.board.occupancy[n] ?? []).toEqual([]);
      }
    }
  });
});

describe('the 7', () => {
  const game = newBaseGame(3);
  const opened = playSetup(game);

  it('makes everyone over the hand limit discard half, rounded down', () => {
    // Eight cards: over the limit of seven, so four go back.
    let state = grant(advanceToMain(game, opened, p0), p0, {
      brick: 2,
      lumber: 2,
      ore: 2,
      grain: 2,
    });
    const held = Object.values(state.players[p0]?.cards ?? {}).reduce((a, b) => a + b, 0);
    expect(held).toBeGreaterThan(7);
    state = rollUntilRobber(game, state);

    const step = currentStep(state);
    expect(step?.kind).toBe('discard');
    expect(step?.actor).toContain(p0);
    expect((step?.data?.owed as Record<string, number>)[p0]).toBe(Math.floor(held / 2));

    refuse(game.ctx, state, p0, { type: 'discard', cards: { brick: 1 } }, 'malformed');

    const bank = state.bank.brick ?? 0;
    const due = Math.floor(held / 2);
    const cards = offered(game.ctx, state, p0, 'discard')[0]?.cards as Record<string, number>;
    expect(Object.values(cards).reduce((a, b) => a + b, 0)).toBe(due);
    const after = act(game.ctx, state, p0, { type: 'discard', cards });
    expect(after.bank.brick).toBe(bank + (cards.brick ?? 0));
    // With the discards settled, the roller moves the robber.
    expect(currentStep(after)?.kind).toBe('robber');
  });

  it('moves the robber, blocks production, and steals from a chosen victim', () => {
    let state = rollUntilRobber(game, advanceToMain(game, opened, p0));
    while (currentStep(state)?.kind === 'discard') {
      const actor = [currentStep(state)?.actor].flat()[0] as never;
      state = act(game.ctx, state, actor, offered(game.ctx, state, actor, 'discard')[0] as never);
    }

    const roller = currentStep(state)?.actor as never;
    const options = offered(game.ctx, state, roller, 'moveRobber');
    const withVictim = options.find((o) => o.victim !== null);
    expect(withVictim).toBeDefined();

    const victim = withVictim?.victim as never;
    const before = Object.values(state.players[victim]?.cards ?? {}).reduce((a, b) => a + b, 0);
    const result = tick(game.ctx, state, roller, withVictim as never);
    const after = Object.values(result.state.players[victim]?.cards ?? {}).reduce(
      (a, b) => a + b,
      0,
    );

    expect(after).toBe(before - 1);
    const robber = Object.values(result.state.board.pieces).find((p) => p.kind === 'robber');
    expect(robber?.at).toBe(withVictim?.hex);

    // What was taken is visible to the thief and the victim, and to nobody else.
    const steal = result.events.find((e) => e.type === 'steal');
    expect(steal?.secret).toBeDefined();
    expect(steal?.audience).toEqual([victim, roller]);
  });

  it('refuses to leave the robber where it is', () => {
    let state = rollUntilRobber(game, advanceToMain(game, opened, p0));
    while (currentStep(state)?.kind === 'discard') {
      const actor = [currentStep(state)?.actor].flat()[0] as never;
      state = act(game.ctx, state, actor, offered(game.ctx, state, actor, 'discard')[0] as never);
    }
    const robber = Object.values(state.board.pieces).find((p) => p.kind === 'robber');
    const roller = currentStep(state)?.actor as never;
    refuse(
      game.ctx,
      state,
      roller,
      { type: 'moveRobber', hex: robber?.at, victim: null },
      'illegalTarget',
    );
  });
});

describe('development cards', () => {
  const game = newBaseGame(11);
  const opened = playSetup(game);

  /** Buy a named development card: stack it on top of the deck, then buy. */
  function withCard(def: string): GameState {
    const state = stackDeck(grant(advanceToMain(game, opened, p0), p0, DEV_CARD_COST), 'dev', [
      def,
    ]);
    return act(game.ctx, state, p0, { type: 'buyDev' });
  }

  it('buys face down, and refuses to play the card the same turn', () => {
    const state = withCard('knight');
    expect(handCards(state, p0, 'knight')).toHaveLength(1);
    expect(state.decks.dev?.draw).toHaveLength(24);
    expect(state.players[p0]?.cards.ore).toBe(0);

    const card = handCards(state, p0, 'knight')[0];
    refuse(game.ctx, state, p0, { type: 'playDev', card }, 'notNow');
  });

  it('plays a knight next turn, which moves the robber and counts toward Largest Army', () => {
    const bought = withCard('knight');
    const state = laterTurn(game, bought, p0);
    const card = handCards(state, p0, 'knight')[0];

    const after = act(game.ctx, state, p0, { type: 'playDev', card });
    expect(currentStep(after)?.kind).toBe('robber');
    expect(after.players[p0]?.revealed).toContain(card);
    expect(game.ctx.rules.awards.largestArmy?.metric(game.ctx, after, p0)).toBe(1);
  });

  it('allows only one development card per turn', () => {
    let state = stackDeck(grant(withCard('knight'), p0, DEV_CARD_COST), 'dev', ['knight']);
    state = act(game.ctx, state, p0, { type: 'buyDev' });
    state = laterTurn(game, state, p0);

    const [first, second] = handCards(state, p0, 'knight');
    state = act(game.ctx, state, p0, { type: 'playDev', card: first });
    // Resolve the robber the knight pushed before trying the second card.
    const robber = offered(game.ctx, state, p0, 'moveRobber')[0];
    state = act(game.ctx, state, p0, robber as never);
    refuse(game.ctx, state, p0, { type: 'playDev', card: second }, 'notNow');
  });

  it('takes every card of one kind with a monopoly', () => {
    const bought = withCard('monopoly');
    let state = laterTurn(game, bought, p0);
    state = grant(state, p1, { wool: 3 });
    const mine = state.players[p0]?.cards.wool ?? 0;
    const theirs = state.seatOrder
      .filter((id) => id !== p0)
      .reduce((n, id) => n + (state.players[id]?.cards.wool ?? 0), 0);

    const card = handCards(state, p0, 'monopoly')[0];
    const after = act(game.ctx, state, p0, { type: 'playDev', card, kind: 'wool' });

    expect(after.players[p0]?.cards.wool).toBe(mine + theirs);
    for (const other of state.seatOrder.filter((id) => id !== p0)) {
      expect(after.players[other]?.cards.wool).toBe(0);
    }
    // Played progress cards go to the discard pile, not face up: only knights are counted.
    expect(after.decks.dev?.discard).toContain(card);
  });

  it('takes two resources of choice with year of plenty', () => {
    const bought = withCard('yearOfPlenty');
    const state = laterTurn(game, bought, p0);
    const before = state.players[p0]?.cards.ore ?? 0;
    const bank = state.bank.ore ?? 0;

    const card = handCards(state, p0, 'yearOfPlenty')[0];
    const after = act(game.ctx, state, p0, { type: 'playDev', card, kinds: ['ore', 'ore'] });

    expect(after.players[p0]?.cards.ore).toBe(before + 2);
    expect(after.bank.ore).toBe(bank - 2);
  });

  it('places two free roads with road building', () => {
    const bought = withCard('roadBuilding');
    let state = laterTurn(game, bought, p0);
    const roads = lociOf(state, p0, 'road').length;
    const cards = Object.values(state.players[p0]?.cards ?? {}).reduce((a, b) => a + b, 0);

    const card = handCards(state, p0, 'roadBuilding')[0];
    state = act(game.ctx, state, p0, { type: 'playDev', card });
    expect(currentStep(state)?.kind).toBe('freeBuild');

    for (let i = 0; i < 2; i++) {
      state = act(game.ctx, state, p0, offered(game.ctx, state, p0, 'place')[0] as never);
    }

    expect(lociOf(state, p0, 'road')).toHaveLength(roads + 2);
    // Free means free: the hand is untouched.
    expect(Object.values(state.players[p0]?.cards ?? {}).reduce((a, b) => a + b, 0)).toBe(cards);
    expect(currentStep(state)?.kind).toBe('main');
  });
});

describe('trade', () => {
  const game = newBaseGame(11);
  const opened = playSetup(game);

  it('exchanges with the bank at four to one', () => {
    const state = grant(advanceToMain(game, opened, p0), p0, { brick: 4 });
    const brick = state.players[p0]?.cards.brick ?? 0;
    const after = act(game.ctx, state, p0, {
      type: 'tradeBank',
      give: { brick: 4 },
      want: { ore: 1 },
    });
    expect(after.players[p0]?.cards.brick).toBe(brick - 4);
    expect(after.players[p0]?.cards.ore).toBe((state.players[p0]?.cards.ore ?? 0) + 1);
  });

  it('refuses an exchange that does not add up', () => {
    const state = grant(advanceToMain(game, opened, p0), p0, { brick: 4 });
    refuse(
      game.ctx,
      state,
      p0,
      { type: 'tradeBank', give: { brick: 3 }, want: { ore: 1 } },
      'illegalTarget',
    );
    refuse(
      game.ctx,
      state,
      p0,
      { type: 'tradeBank', give: { brick: 4 }, want: { ore: 2 } },
      'illegalTarget',
    );
  });

  it('offers a trade, collects a response, and completes it', () => {
    let state = grant(advanceToMain(game, opened, p0), p0, { brick: 2 });
    state = grant(state, p1, { ore: 1 });
    const brick0 = state.players[p0]?.cards.brick ?? 0;
    const brick1 = state.players[p1]?.cards.brick ?? 0;

    state = act(game.ctx, state, p0, {
      type: 'offerTrade',
      give: { brick: 2 },
      want: { ore: 1 },
    });
    expect(currentStep(state)?.kind).toBe('trade');

    // An offeree who cannot pay may not accept.
    refuse(game.ctx, state, P[2] as never, { type: 'respondTrade', accept: true }, 'cannotAfford');
    // Nor may the offerer close with someone who has not accepted.
    refuse(game.ctx, state, p0, { type: 'completeTrade', with: p1 }, 'illegalTarget');

    state = act(game.ctx, state, p1, { type: 'respondTrade', accept: true });
    const before = state.players[p0]?.cards.ore ?? 0;
    state = act(game.ctx, state, p0, { type: 'completeTrade', with: p1 });

    expect(state.players[p0]?.cards.ore).toBe(before + 1);
    expect(state.players[p0]?.cards.brick).toBe(brick0 - 2);
    expect(state.players[p1]?.cards.brick).toBe(brick1 + 2);
    expect(currentStep(state)?.kind).toBe('main');
  });

  it('closes the offer by itself when everyone declines', () => {
    let state = grant(advanceToMain(game, opened, p0), p0, { brick: 2 });
    state = act(game.ctx, state, p0, {
      type: 'offerTrade',
      give: { brick: 2 },
      want: { ore: 1 },
    });
    for (const other of [p1, P[2] as never, P[3] as never]) {
      if (currentStep(state)?.kind !== 'trade') break;
      state = act(game.ctx, state, other, { type: 'respondTrade', accept: false });
    }
    expect(currentStep(state)?.kind).toBe('main');
  });

  it('refuses a gift', () => {
    const state = grant(advanceToMain(game, opened, p0), p0, { brick: 2 });
    refuse(
      game.ctx,
      state,
      p0,
      { type: 'offerTrade', give: { brick: 2 }, want: {} },
      'illegalTarget',
    );
  });
});

describe('winning', () => {
  it('ends the game the moment the active player reaches the target', () => {
    const game = newBaseGame(11);
    let state = advanceToMain(game, playSetup(game), p0);
    expect(game.ctx.rules.victoryPoints(game.ctx, state, p0)).toBe(2);

    // Build whatever is available — settlements, then cities, then road to reach further — and
    // let the reducer decide when it is over. Nothing here checks for the win: the point is that
    // the engine stops the game by itself, on the action that crosses the target.
    for (let i = 0; i < 60 && state.outcome === null; i++) {
      const settlement = offered(game.ctx, grant(state, p0, SETTLEMENT_COST), p0, 'build').find(
        (a) => a.kind === 'settlement',
      );
      if (settlement !== undefined) {
        state = act(game.ctx, grant(state, p0, SETTLEMENT_COST), p0, settlement);
        continue;
      }
      const city = offered(game.ctx, grant(state, p0, CITY_COST), p0, 'build').find(
        (a) => a.kind === 'city',
      );
      if (city !== undefined) {
        state = act(game.ctx, grant(state, p0, CITY_COST), p0, city);
        continue;
      }
      const road = offered(game.ctx, grant(state, p0, ROAD_COST), p0, 'build').find(
        (a) => a.kind === 'road',
      );
      if (road === undefined) throw new Error('nothing left to build');
      state = act(game.ctx, grant(state, p0, ROAD_COST), p0, road);
    }

    expect(state.outcome?.winner).toBe(p0);
    expect(game.ctx.rules.victoryPoints(game.ctx, state, p0)).toBeGreaterThanOrEqual(10);
    // Nothing more can happen.
    expect(legalActions(game.ctx, state, p0)).toEqual([]);
    refuse(game.ctx, state, p0, { type: 'endTurn' }, 'gameOver');
  });
});
