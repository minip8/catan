/**
 * Structural invariants of `GameState`.
 *
 * These catch engine *bugs*, not rule violations — a broken invariant means the reducer corrupted
 * the state, so it throws rather than returning a `Result`. Run after every reduce in tests and dev
 * builds: the card-conservation check alone catches a whole class of "resources appeared from
 * nowhere" bugs at the exact action that caused them, rather than several turns later when the bank
 * mysteriously runs dry.
 *
 * `checkInvariants` collects every violation rather than stopping at the first, because when
 * something has gone wrong the second symptom is usually what identifies the cause.
 */

import type { Topology } from '../board/topology.js';
import { type CardKind, type LocusId, OFFBOARD, type PieceKind } from '../ids.js';
import type { GameState } from './gameState.js';

export class InvariantError extends Error {}

export interface InvariantContext {
  readonly topology: Topology;
  /**
   * Expected `bank + every hand` total for each bank-backed card kind — 19 or 24 per resource in
   * the base game. Kinds absent from this map are not conserved (nothing mints resources, but
   * expansion pools like fish tokens come from outside the bank).
   */
  readonly cardTotals: Readonly<Record<CardKind, number>>;
  /** Per-player allowance for each piece kind: 15 roads, 5 settlements, 4 cities. */
  readonly pieceLimits: Readonly<Partial<Record<PieceKind, number | null>>>;
}

export function assertInvariants(state: GameState, ctx: InvariantContext): void {
  const problems = checkInvariants(state, ctx);
  if (problems.length > 0) {
    throw new InvariantError(
      `game state violates ${problems.length} invariant(s):\n  - ${problems.join('\n  - ')}`,
    );
  }
}

export function checkInvariants(state: GameState, ctx: InvariantContext): readonly string[] {
  return [
    ...checkSeating(state),
    ...checkOccupancyIndex(state, ctx),
    ...checkPieceSupply(state, ctx),
    ...checkCardConservation(state, ctx),
    ...checkDecks(state),
    ...checkStack(state),
    ...checkAwards(state),
  ];
}

function checkSeating(state: GameState): readonly string[] {
  const out: string[] = [];
  const seated = new Set(state.seatOrder);

  if (seated.size !== state.seatOrder.length) out.push('seatOrder contains a duplicate');
  for (const id of Object.keys(state.players)) {
    if (!seated.has(id as never)) out.push(`player ${id} is not in seatOrder`);
  }
  for (const [i, id] of state.seatOrder.entries()) {
    const p = state.players[id];
    if (p === undefined) {
      out.push(`seatOrder names ${id}, which has no PlayerState`);
    } else if (p.seat !== i) {
      out.push(`player ${id} has seat ${p.seat} but sits at index ${i} of seatOrder`);
    }
  }
  if (state.players[state.turn.active] === undefined) {
    out.push(`turn.active is ${state.turn.active}, which has no PlayerState`);
  }
  return out;
}

/**
 * `occupancy` is a derived index, so it must agree with `pieces[].at` in both directions. A
 * one-way check would miss a stale entry pointing at a piece that has since moved.
 */
function checkOccupancyIndex(state: GameState, ctx: InvariantContext): readonly string[] {
  const out: string[] = [];
  const { board } = state;

  for (const [locus, ids] of Object.entries(board.occupancy)) {
    if (new Set(ids).size !== ids.length) out.push(`occupancy[${locus}] lists a piece twice`);
    if (ids.length > 0 && !locusExists(ctx.topology, locus as LocusId)) {
      out.push(`occupancy[${locus}] is not a locus in this topology`);
    }
    for (const id of ids) {
      const piece = board.pieces[id];
      if (piece === undefined) {
        out.push(`occupancy[${locus}] names unknown piece ${id}`);
      } else if (piece.at !== locus) {
        out.push(`occupancy[${locus}] lists piece ${id}, but that piece is at ${piece.at}`);
      }
    }
  }

  for (const piece of Object.values(board.pieces)) {
    if (piece.at === null) continue;
    if (!locusExists(ctx.topology, piece.at)) {
      out.push(`piece ${piece.id} is at ${piece.at}, which is not a locus in this topology`);
    }
    if (!(board.occupancy[piece.at] ?? []).includes(piece.id)) {
      out.push(`piece ${piece.id} is at ${piece.at} but occupancy does not list it there`);
    }
  }
  return out;
}

/**
 * Membership test against a keyed map, ignoring the key's brand.
 *
 * `LocusId` is a union of four differently-branded string types, and the whole point of the brands
 * is that you cannot pass one where another is expected. Asking "is this locus a key of *any* of
 * these maps?" is the one legitimate place to look past that, so the widening is confined here
 * rather than spread over the callers.
 */
function hasKey(map: ReadonlyMap<string, unknown>, key: string): boolean {
  return map.has(key);
}

function locusExists(topology: Topology, locus: LocusId): boolean {
  if (locus === OFFBOARD) return true;
  if (hasKey(topology.hexAxial, locus)) return true;
  if (hasKey(topology.vertexHexes, locus)) return true;
  if (hasKey(topology.edgeHexes, locus)) return true;
  // Track loci are encoded `name:index` and are not part of the board graph.
  return locus.includes(':');
}

/**
 * On-board pieces plus supply must equal the allowance, for every player and kind.
 *
 * This is what enforces the 15/5/4 limits, and it survives the settlement-to-city upgrade because
 * upgrading returns the settlement to its owner's supply.
 */
function checkPieceSupply(state: GameState, ctx: InvariantContext): readonly string[] {
  const out: string[] = [];

  const onBoard = new Map<string, number>();
  for (const piece of Object.values(state.board.pieces)) {
    if (piece.owner === null || piece.at === null) continue;
    const key = `${piece.owner}/${piece.kind}`;
    onBoard.set(key, (onBoard.get(key) ?? 0) + 1);
  }

  for (const p of Object.values(state.players)) {
    for (const [kind, limit] of Object.entries(ctx.pieceLimits)) {
      if (limit === null || limit === undefined) continue;
      const held = p.supply[kind] ?? 0;
      const placed = onBoard.get(`${p.id}/${kind}`) ?? 0;
      if (held < 0) out.push(`player ${p.id} has negative ${kind} supply (${held})`);
      if (held + placed !== limit) {
        out.push(
          `player ${p.id} accounts for ${held + placed} ${kind} (${placed} placed + ${held} in supply), expected ${limit}`,
        );
      }
    }
  }
  return out;
}

/**
 * Cards are conserved: the bank plus every hand equals the fixed total, per kind.
 *
 * The single highest-value invariant in the engine. Any payment, payout, steal, discard or monopoly
 * that loses or duplicates a card trips this immediately.
 */
function checkCardConservation(state: GameState, ctx: InvariantContext): readonly string[] {
  const out: string[] = [];

  for (const p of Object.values(state.players)) {
    for (const [kind, n] of Object.entries(p.cards)) {
      if (n < 0) out.push(`player ${p.id} holds ${n} ${kind}`);
    }
  }
  for (const [kind, n] of Object.entries(state.bank)) {
    if (n < 0) out.push(`bank holds ${n} ${kind}`);
  }

  for (const [kind, expected] of Object.entries(ctx.cardTotals)) {
    let total = state.bank[kind] ?? 0;
    for (const p of Object.values(state.players)) total += p.cards[kind] ?? 0;
    if (total !== expected) {
      out.push(`${kind} is not conserved: bank + hands = ${total}, expected ${expected}`);
    }
  }
  return out;
}

/** Every card instance is in exactly one place: a draw pile, a discard pile, a hand, or face up. */
function checkDecks(state: GameState): readonly string[] {
  const out: string[] = [];
  const seen = new Map<string, string>();

  const claim = (card: string, where: string): void => {
    const prior = seen.get(card);
    if (prior !== undefined) out.push(`card ${card} is in both ${prior} and ${where}`);
    else seen.set(card, where);
  };

  for (const [deckId, deck] of Object.entries(state.decks)) {
    for (const c of deck.draw) claim(c, `${deckId} draw pile`);
    for (const c of deck.discard) claim(c, `${deckId} discard pile`);
  }
  for (const p of Object.values(state.players)) {
    for (const [deckId, hand] of Object.entries(p.hands)) {
      for (const c of hand) claim(c, `${p.id}'s ${deckId} hand`);
    }
    for (const c of p.revealed) claim(c, `${p.id}'s revealed cards`);
  }

  for (const card of Object.keys(state.cardInstances)) {
    if (!seen.has(card)) out.push(`card ${card} exists but is nowhere`);
  }
  for (const [card, where] of seen) {
    if (state.cardInstances[card as never] === undefined) {
      out.push(`card ${card} is in ${where} but has no instance record`);
    }
  }
  return out;
}

function checkStack(state: GameState): readonly string[] {
  const out: string[] = [];

  if (state.outcome === null && state.stack.length === 0) {
    out.push('stack is empty but the game has no outcome — nothing can happen next');
  }
  if (state.outcome !== null && state.players[state.outcome.winner] === undefined) {
    out.push(`outcome names winner ${state.outcome.winner}, who has no PlayerState`);
  }

  for (const [i, step] of state.stack.entries()) {
    if (step.actor === 'system') continue;
    const actors = Array.isArray(step.actor) ? step.actor : [step.actor];
    if (actors.length === 0) out.push(`stack[${i}] (${step.kind}) has an empty actor list`);
    for (const a of actors) {
      if (state.players[a] === undefined) {
        out.push(`stack[${i}] (${step.kind}) names actor ${a}, who has no PlayerState`);
      }
    }
  }
  return out;
}

function checkAwards(state: GameState): readonly string[] {
  const out: string[] = [];
  for (const [id, award] of Object.entries(state.awards)) {
    if (award.holder !== null && state.players[award.holder] === undefined) {
      out.push(`award ${id} is held by ${award.holder}, who has no PlayerState`);
    }
    if (award.holder === null && award.best !== 0) {
      // Legitimate while a tie keeps the award out of play, so only flag a negative best.
      if (award.best < 0) out.push(`award ${id} has a negative best (${award.best})`);
    }
  }
  return out;
}
