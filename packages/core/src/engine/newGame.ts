/**
 * Dealing a new game.
 *
 * This is the one place that turns a `Scenario` plus a `RuleSet` plus a seed into a playable
 * `GameState`. Everything it does is deterministic given `(seed, scenarioId, ruleSetId, players)`,
 * which is half of the replay contract — the action log is the other half.
 *
 * **The order in which entropy is consumed is part of that contract.** Terrain, then number
 * tokens, then harbours, then the development deck. Reordering these silently changes every board
 * every seed has ever produced, so a saved replay would deal a different island. Add new draws at
 * the end.
 *
 * Bags follow a supply-or-derive rule: a scenario that names a terrain stack, a number bag or a
 * harbour bag gets exactly that (which is how the official 19- and 30-hex boards stay faithful to
 * the printed components); one that leaves them empty gets a proportional bag generated from the
 * board's own size, which is how the unofficial 7-10 player boards work without hand-written
 * tables.
 */

import {
  coastlineEdges,
  dealHarbors,
  dealNumbers,
  dealTerrain,
  harborBagOfSize,
  type NumberOrder,
  numberBagOfSize,
  spaceHarborsAroundCoast,
  spiralOrder,
  terrainBagOfSize,
} from '../board/generate.js';
import { desertCountForLand, harborCountForCoast } from '../board/presets.js';
import type { Cell, HarborSpec, Scenario } from '../board/scenario.js';
import { buildTopology, type Topology } from '../board/topology.js';
import { hexId } from '../coords/axial.js';
import {
  type CardKind,
  type DeckId,
  type HexId,
  OFFBOARD,
  type PlayerId,
  playerId,
  type TerrainId,
  type VertexId,
} from '../ids.js';
import { seedRng, shuffle } from '../rng.js';
import type { GameEvent } from '../rules/event.js';
import { bankedKinds, type RuleContext, type RuleSet } from '../rules/ruleset.js';
import type { Board, GameState, HexState, PlayerState } from '../state/gameState.js';
import type { InvariantContext } from '../state/invariants.js';
import { Tx } from '../state/tx.js';

/** The stack a scenario keeps its terrain bag in, and the number bag beside it. */
export const MAIN_STACK = 'main';

export interface NewGameOptions {
  readonly scenario: Scenario;
  readonly rules: RuleSet;
  readonly seed: number;
  /** A player count, or explicit ids when a caller wants to control seating. */
  readonly players: number | readonly PlayerId[];
  /** `random` (the almanac's variant, and the default) or `spiral` (the lettered tokens). */
  readonly numberOrder?: NumberOrder;
}

export interface NewGame {
  readonly ctx: RuleContext;
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

export function newGame(options: NewGameOptions): NewGame {
  const { scenario, rules, seed } = options;
  const seats = seatsFor(options.players);
  if (seats.length < scenario.minPlayers || seats.length > scenario.maxPlayers) {
    throw new Error(
      `newGame: ${scenario.id} seats ${scenario.minPlayers}-${scenario.maxPlayers} players, got ${seats.length}`,
    );
  }

  const topology = buildTopology(scenario.cells);
  const cells = cellsById(scenario);
  const ctx: RuleContext = { topology, scenario, rules };

  const state = emptyState(scenario, rules, seats, topology, cells, seed);
  const tx = new Tx(ctx, state);

  dealBoard(ctx, tx, cells);
  dealDecks(ctx, tx);
  rules.begin(ctx, tx);

  return { ctx, state: tx.state, events: tx.events };
}

/**
 * The `InvariantContext` for a game — what `assertInvariants` needs to know about its ruleset.
 *
 * Derived from the same tables the game was dealt from, so the check cannot drift from the deal.
 */
export function invariantsFor(ctx: RuleContext, state: GameState): InvariantContext {
  const cardTotals: Record<CardKind, number> = {} as Record<CardKind, number>;
  for (const kind of bankedKinds(ctx.rules)) {
    let total = state.bank[kind] ?? 0;
    for (const p of Object.values(state.players)) total += p.cards[kind] ?? 0;
    cardTotals[kind] = total;
  }
  const pieceLimits: Record<string, number | null> = {};
  for (const meta of Object.values(ctx.rules.pieceKinds)) {
    if (meta.owned) pieceLimits[meta.id] = meta.limit;
  }
  return { topology: ctx.topology, cardTotals, pieceLimits };
}

// ── Assembly ────────────────────────────────────────────────────────────────────────────────

function seatsFor(players: number | readonly PlayerId[]): readonly PlayerId[] {
  if (Array.isArray(players)) return players;
  const n = players as number;
  if (!Number.isInteger(n) || n < 1) throw new Error(`newGame: bad player count ${n}`);
  return Array.from({ length: n }, (_, i) => playerId(i));
}

function cellsById(scenario: Scenario): ReadonlyMap<HexId, Cell> {
  const out = new Map<HexId, Cell>();
  for (const { q, r, cell } of scenario.cells) out.set(hexId({ q, r }), cell);
  return out;
}

function emptyState(
  scenario: Scenario,
  rules: RuleSet,
  seats: readonly PlayerId[],
  topology: Topology,
  cells: ReadonlyMap<HexId, Cell>,
  seed: number,
): GameState {
  const hexes: Record<HexId, HexState> = {};
  for (const id of topology.hexes) {
    const cell = cells.get(id);
    hexes[id] =
      cell?.kind === 'land'
        ? { class: 'land', terrain: cell.terrain, numbers: [], numbersHidden: false }
        : cell?.kind === 'unexplored'
          ? {
              class: 'unexplored',
              terrain: null,
              numbers: [],
              numbersHidden: false,
              stack: cell.stack,
            }
          : { class: 'sea', terrain: null, numbers: [], numbersHidden: false };
  }

  const board: Board = { hexes, harbors: {}, pieces: {}, occupancy: {} };

  const bank: Record<CardKind, number> = {} as Record<CardKind, number>;
  for (const kind of bankedKinds(rules)) bank[kind] = scenario.bankPerKind;

  const players: Record<PlayerId, PlayerState> = {};
  for (const [seat, id] of seats.entries()) players[id] = newPlayer(rules, id, seat);

  const first = seats[0];
  if (first === undefined) throw new Error('newGame: no players');

  return {
    scenarioId: scenario.id,
    ruleSetId: rules.id,
    seed,
    seq: 0,
    board,
    players,
    seatOrder: seats,
    bank,
    // The `as` casts here and below are the price of open taxonomies: `Record<DeckId, …>` demands
    // the base game's literal members, but the table these are built from is the authority on
    // which decks and awards actually exist.
    decks: Object.fromEntries(
      Object.keys(rules.decks).map((id) => [id, { draw: [], discard: [] }]),
    ) as unknown as GameState['decks'],
    cardInstances: {},
    awards: Object.fromEntries(
      Object.values(rules.awards).map((spec) => [
        spec.id,
        { holder: null, value: spec.value, best: 0 },
      ]),
    ) as GameState['awards'],
    stack: [],
    // Turn 0 is setup. The first `beginTurn` makes it 1, which is what `acquiredTurn` compares
    // against — so a card bought on turn 1 is unplayable on turn 1 and playable on turn 2.
    turn: { n: 0, active: first, flags: {} },
    rng: seedRng(seed),
    ext: {},
    outcome: null,
  };
}

function newPlayer(rules: RuleSet, id: PlayerId, seat: number): PlayerState {
  const cards: Record<CardKind, number> = {} as Record<CardKind, number>;
  for (const kind of bankedKinds(rules)) cards[kind] = 0;

  const supply: Record<string, number> = {};
  for (const meta of Object.values(rules.pieceKinds)) {
    if (meta.owned && meta.limit !== null) supply[meta.id] = meta.limit;
  }

  return {
    id,
    seat,
    cards,
    hands: Object.fromEntries(
      Object.keys(rules.decks).map((deck) => [deck, []]),
    ) as unknown as PlayerState['hands'],
    revealed: [],
    supply,
    ext: {},
  };
}

// ── The board ───────────────────────────────────────────────────────────────────────────────

function dealBoard(ctx: RuleContext, tx: Tx, cells: ReadonlyMap<HexId, Cell>): void {
  const { topology, scenario, rules } = ctx;
  const land = topology.hexes.filter((h) => cells.get(h)?.kind === 'land');
  if (land.length === 0) throw new Error('newGame: the scenario has no land');

  // ── Terrain ──
  const bag = terrainBagFor(scenario, land.length);
  const terrain = tx.random((rng) => {
    const dealt = dealTerrain(land, bag, rng);
    return { value: dealt.terrain, state: dealt.state };
  });
  for (const [hex, t] of terrain) {
    const state = tx.state.board.hexes[hex];
    if (state !== undefined) state.terrain = t;
  }

  // ── Number tokens ──
  const producing = new Set(
    land.filter((h) => {
      const t = tx.state.board.hexes[h]?.terrain;
      return t != null && rules.terrainYield[t] != null;
    }),
  );
  const numbers = tx.random((rng) => {
    const dealt = dealNumbers(
      'random',
      spiralOrder(land),
      producing,
      numberBagFor(scenario, producing.size),
      rng,
    );
    return { value: dealt.numbers, state: dealt.state };
  });
  for (const [hex, n] of numbers) {
    const state = tx.state.board.hexes[hex];
    if (state !== undefined) state.numbers = [n];
  }

  // ── Harbours ──
  const isLand = (h: HexId): boolean => cells.get(h)?.kind === 'land';
  const coast = coastlineEdges(topology, isLand);
  const slots = spaceHarborsAroundCoast(coast, harborCountForCoast(coast.length));
  const harbors = tx.random((rng) => {
    const dealt = dealHarbors(slots, harborBagFor(ctx, slots.length), rng);
    return { value: dealt.slots, state: dealt.state };
  });
  for (const slot of harbors) {
    if (slot.harbor === null) continue;
    // A harbour is controlled from *either* end of the edge it docks against, so both vertices
    // carry it. Storing it per-vertex is what makes "does this player have a 2:1 ore?" a lookup.
    for (const vertex of topology.edgeVertices.get(slot.edge) ?? []) {
      tx.state.board.harbors[vertex as VertexId] = slot.harbor;
    }
  }

  // ── The robber ──
  const desert = land.find((h) => {
    const t = tx.state.board.hexes[h]?.terrain;
    return t == null || rules.terrainYield[t] == null;
  });
  for (const meta of Object.values(rules.pieceKinds)) {
    if (!meta.blocksProduction || meta.owned) continue;
    tx.createPiece(meta.id, null, desert ?? OFFBOARD);
  }
}

function terrainBagFor(scenario: Scenario, landCount: number): readonly TerrainId[] {
  const stack = scenario.stacks[MAIN_STACK];
  if (stack !== undefined && stack.length > 0) {
    const bag = stack.flatMap((cell) => (cell.kind === 'land' ? [cell.terrain] : []));
    if (bag.length !== landCount) {
      throw new Error(
        `newGame: ${scenario.id} declares ${bag.length} terrain tiles for ${landCount} land hexes`,
      );
    }
    return bag;
  }
  return terrainBagOfSize(landCount, desertCountForLand(landCount));
}

function numberBagFor(scenario: Scenario, producing: number): readonly number[] {
  const bag = scenario.numberBags[MAIN_STACK];
  if (bag !== undefined && bag.length > 0) {
    if (bag.length !== producing) {
      throw new Error(
        `newGame: ${scenario.id} declares ${bag.length} number tokens for ${producing} producing hexes`,
      );
    }
    return bag;
  }
  return numberBagOfSize(producing);
}

function harborBagFor(ctx: RuleContext, slots: number): readonly HarborSpec[] {
  const bag = ctx.scenario.harborBag;
  if (bag.length === slots) return bag;
  if (bag.length > 0) {
    throw new Error(
      `newGame: ${ctx.scenario.id} declares ${bag.length} harbours but its coast takes ${slots}`,
    );
  }
  return harborBagOfSize(
    slots,
    Object.values(ctx.rules.cardKinds)
      .filter((m) => m.maritime)
      .map((m) => m.id),
  );
}

// ── Decks ───────────────────────────────────────────────────────────────────────────────────

function dealDecks(ctx: RuleContext, tx: Tx): void {
  for (const spec of Object.values(ctx.rules.decks)) {
    for (const [def, count] of Object.entries(spec.composition)) {
      for (let i = 0; i < count; i++) tx.createCard(spec.id as DeckId, def);
    }
    const order = tx.state.decks[spec.id]?.draw ?? [];
    tx.setDraw(
      spec.id as DeckId,
      tx.random((rng) => shuffle(rng, order)),
    );
  }
}
