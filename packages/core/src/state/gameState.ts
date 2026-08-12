/**
 * The mutable game state.
 *
 * Three rules govern everything in this file:
 *
 * 1. **It must be JSON-serialisable.** State crosses the wire to clients, gets cloned per reduce,
 *    and gets written into replay fixtures. So collections are plain `Record`s, never `Map`s —
 *    which is the opposite of `Topology`, whose `Map`s never leave the process because the graph is
 *    rebuilt from the scenario id.
 *
 * 2. **Topology is not in here.** The graph is immutable and derivable, so it is passed alongside
 *    rather than stored. What *is* here is anything a rule can change: terrain, number tokens,
 *    pieces, hands, the deck order.
 *
 * 3. **No typed slots for board contents.** There is no `robberHex` field and no
 *    `vertices: Record<VertexId, {building, owner}>`. There are pieces at loci, plus an occupancy
 *    index. That is what lets a city and a wall share a vertex, a road and a camel share an edge,
 *    and a piece sit off the board entirely — none of which the base game needs, but all of which
 *    would otherwise mean reshaping this type later.
 */

import type { HarborSpec } from '../board/scenario.js';
import type { GameExtensions, PlayerExtensions } from '../ext.js';
import type {
  AwardId,
  CardDefId,
  CardId,
  CardKind,
  DeckId,
  HexId,
  LocusId,
  PieceId,
  PieceKind,
  PlayerId,
  TerrainId,
  VertexId,
} from '../ids.js';
import type { RngState } from '../rng.js';

/** A bundle of card kinds and counts: a building cost, a trade side, a production payout. */
export type Cost = Readonly<Partial<Record<CardKind, number>>>;

// ── Board ───────────────────────────────────────────────────────────────────────────────────

/**
 * What is on a hex, as opposed to where the hex is.
 *
 * Mutable, and separate from `Topology`, because the base game deals terrain randomly at setup and
 * expansions relocate number tokens (Cities & Knights' Inventor), hide them (a conquered hex in
 * Traders & Barbarians) and reveal terrain mid-game (Seafarers' fog).
 */
export interface HexState {
  /** `unexplored` becomes `land` or `sea` when revealed. */
  class: 'land' | 'sea' | 'unexplored';
  terrain: TerrainId | null;
  /**
   * Production numbers. At most one in the base game, but an array because a single hex can carry
   * several — the Traders & Barbarians lake produces on 2, 3, 11 and 12.
   */
  numbers: readonly number[];
  /** A hex whose token is face down produces nothing until it is turned back up. */
  numbersHidden: boolean;
  /** Which stack an `unexplored` hex draws from on reveal. */
  stack?: string;
}

/**
 * One physical piece. Identity persists as it moves, which is what makes "the robber went from
 * here to there" expressible as an event rather than a delete plus a create.
 */
export interface Piece {
  readonly id: PieceId;
  readonly kind: PieceKind;
  /** `null` for neutral pieces: the robber, and later the pirate and the merchant. */
  owner: PlayerId | null;
  /** `null` while in a player's supply or off the board. */
  at: LocusId | null;
  /**
   * Per-piece flags an expansion needs: a knight's `active` and `level`, a road's `damaged`.
   * Empty for every base-game piece.
   */
  st: Readonly<Record<string, string | number | boolean>>;
}

export interface Board {
  hexes: Record<HexId, HexState>;
  /**
   * Which vertices grant which trade rate. Mutable because harbours are dealt at setup, and in
   * some Seafarers scenarios players place them during play.
   */
  harbors: Record<VertexId, HarborSpec>;
  pieces: Record<PieceId, Piece>;
  /**
   * Index from locus to the pieces on it — **derived** from `pieces[].at`.
   *
   * Stored rather than recomputed because production, legality checks and route search all query
   * it constantly. `assertInvariants` verifies it agrees with `pieces`, and only `Tx` mutates
   * either, so the two cannot drift apart in practice.
   */
  occupancy: Record<LocusId, readonly PieceId[]>;
}

// ── Players ─────────────────────────────────────────────────────────────────────────────────

export interface PlayerState {
  readonly id: PlayerId;
  /** Position in `seatOrder`. Turn order and the setup rounds both read this. */
  readonly seat: number;
  /**
   * Fungible piles: resources in the base game, plus commodities, fish and coins later.
   *
   * The five base resources are always present (as 0 if empty); other kinds appear as needed.
   * How each behaves under the hand limit, stealing, trading and monopoly comes from
   * `RuleSet.cardKinds`, never from testing membership of a hardcoded list.
   */
  cards: Record<CardKind, number>;
  /** Cards held in hand, per deck. Hidden from other players. */
  hands: Record<DeckId, readonly CardId[]>;
  /** Face-up cards: played knights, and victory point cards revealed to win. */
  revealed: readonly CardId[];
  /** Pieces not yet on the board. Depleting this is the 15-road / 5-settlement / 4-city limit. */
  supply: Partial<Record<PieceKind, number>>;
  /** Expansion state. Core never reads this. */
  ext: Partial<PlayerExtensions>;
}

// ── Cards and decks ─────────────────────────────────────────────────────────────────────────

export interface CardInstance {
  readonly def: CardDefId;
  readonly deck: DeckId;
  /**
   * The turn this card was acquired, or `null` if it started face up.
   *
   * Needed for "you may not play a development card you bought this turn" — which cannot be a
   * single per-turn flag, because a player may buy several cards in one turn and still play an
   * older one.
   */
  acquiredTurn: number | null;
}

export interface DeckState {
  /** Draw pile, next card first. **Hidden information** — order must be redacted. */
  draw: readonly CardId[];
  discard: readonly CardId[];
}

// ── Awards ──────────────────────────────────────────────────────────────────────────────────

/**
 * Longest Road, Largest Army, and later Harbormaster and the metropolises.
 *
 * `holder` is nullable because **the base game requires it**: per the almanac, if the incumbent's
 * road is broken and two or more players tie for the new longest, the card is set aside and comes
 * back only when a single player leads again.
 */
export interface AwardState {
  holder: PlayerId | null;
  /** Victory points the award is worth. 2 for both base-game awards; 0 in some scenarios. */
  readonly value: number;
  /** The leading metric value, kept for display and for deciding ties. */
  best: number;
}

// ── Turn structure ──────────────────────────────────────────────────────────────────────────

/**
 * One frame of the continuation stack: what happens next, and who it belongs to.
 *
 * The stack replaces a flat phase enum. Even in the base game this is the simpler shape — Road
 * Building pushes two placement frames instead of needing a counter, and discard-on-7 is a single
 * frame whose `actor` is the list of players who owe cards. A flat enum needs a `returnTo` field,
 * then a stack of them.
 */
export interface Step {
  /** Ruleset-defined. Core dispatches on it via `RuleSet.steps` and never interprets it. */
  readonly kind: string;
  /**
   * Who may act. An array means several players act independently before the step resolves;
   * `'system'` means the engine resolves it with no input.
   *
   * **Authority comes from owning the top step, never from `turn.active`** — the base game already
   * has steps belonging to non-active players.
   */
  readonly actor: PlayerId | readonly PlayerId[] | 'system';
  readonly data?: Readonly<Record<string, unknown>>;
  /** A step the actor may decline, e.g. playing a development card before rolling. */
  readonly optional?: boolean;
}

export interface TurnState {
  /** Turn counter, starting at 0 during setup. Compared against `CardInstance.acquiredTurn`. */
  n: number;
  active: PlayerId;
  /**
   * Per-turn counters, cleared at end of turn — development cards played, roads placed free.
   *
   * A bag of counters rather than named booleans because the limits are ruleset-specific: the base
   * game allows one development card per turn, Cities & Knights allows any number of progress
   * cards, and Traders & Barbarians resolves some cards immediately on purchase.
   */
  flags: Record<string, number>;
}

export interface Outcome {
  readonly winner: PlayerId;
  readonly reason: string;
}

// ── The whole thing ─────────────────────────────────────────────────────────────────────────

export interface GameState {
  /** Identifies the scenario whose `Topology` this state is paired with. */
  readonly scenarioId: string;
  readonly ruleSetId: string;
  /** The seed this game started from. Together with the action log, it is the whole replay. */
  readonly seed: number;

  board: Board;
  players: Record<PlayerId, PlayerState>;
  /** Seat order, which fixes turn order and the direction of each setup round. */
  readonly seatOrder: readonly PlayerId[];

  /** The supply. Explicit state, because it cannot be derived once dev cards exist. */
  bank: Record<CardKind, number>;
  decks: Record<DeckId, DeckState>;
  cardInstances: Record<CardId, CardInstance>;
  awards: Record<AwardId, AwardState>;

  /** The continuation stack. **The last element is the top** — what happens next. */
  stack: readonly Step[];
  turn: TurnState;

  /** **Hidden information.** `redactFor` must strip this, or clients can predict every roll. */
  rng: RngState;

  ext: Partial<GameExtensions>;
  outcome: Outcome | null;
}

// ── Queries ─────────────────────────────────────────────────────────────────────────────────
//
// Pure reads used across the rules layer. Keeping them here rather than inlining `?? []` at every
// call site is what makes the rule modules read like the rulebook.

/** The top of the continuation stack — what happens next — or `undefined` if the game is over. */
export function currentStep(state: GameState): Step | undefined {
  return state.stack[state.stack.length - 1];
}

/** Whether `player` is entitled to act on `step`. */
export function stepBelongsTo(step: Step, player: PlayerId): boolean {
  if (step.actor === 'system') return false;
  return Array.isArray(step.actor) ? step.actor.includes(player) : step.actor === player;
}

/** Whether `player` may act right now. The only correct way to ask; never compare `turn.active`. */
export function canAct(state: GameState, player: PlayerId): boolean {
  const step = currentStep(state);
  return step !== undefined && stepBelongsTo(step, player);
}

export function piecesAt(board: Board, locus: LocusId): readonly PieceId[] {
  return board.occupancy[locus] ?? [];
}

export function piecesOn(board: Board, locus: LocusId): readonly Piece[] {
  return piecesAt(board, locus)
    .map((id) => board.pieces[id])
    .filter((p): p is Piece => p !== undefined);
}

/** All of a player's pieces currently on the board, optionally filtered by kind. */
export function piecesOf(board: Board, owner: PlayerId, kind?: PieceKind): readonly Piece[] {
  return Object.values(board.pieces).filter(
    (p) => p.owner === owner && p.at !== null && (kind === undefined || p.kind === kind),
  );
}

export function cardCount(player: PlayerState, kind: CardKind): number {
  return player.cards[kind] ?? 0;
}

/** Total cards a player holds, counting only kinds `include` accepts. */
export function totalCards(player: PlayerState, include: (kind: CardKind) => boolean): number {
  let total = 0;
  for (const [kind, n] of Object.entries(player.cards)) {
    if (include(kind)) total += n;
  }
  return total;
}

/** Whether a player can pay `cost` from hand. */
export function canAfford(player: PlayerState, cost: Cost): boolean {
  for (const [kind, n] of Object.entries(cost)) {
    if (n !== undefined && cardCount(player, kind) < n) return false;
  }
  return true;
}

export function hexState(board: Board, hex: HexId): HexState | undefined {
  return board.hexes[hex];
}

/** Whether a hex is currently producing: revealed land, with a visible number token. */
export function isProducing(board: Board, hex: HexId): boolean {
  const h = board.hexes[hex];
  return h !== undefined && h.class === 'land' && !h.numbersHidden && h.numbers.length > 0;
}

export function player(state: GameState, id: PlayerId): PlayerState {
  const p = state.players[id];
  if (p === undefined) throw new Error(`player: unknown player ${id}`);
  return p;
}

/** Seat order rotated to start at `from` — the order a clockwise sub-round visits players in. */
export function playersFrom(state: GameState, from: PlayerId): readonly PlayerId[] {
  const i = state.seatOrder.indexOf(from);
  if (i < 0) throw new Error(`playersFrom: ${from} is not seated`);
  return [...state.seatOrder.slice(i), ...state.seatOrder.slice(0, i)];
}

export function nextPlayer(state: GameState, after: PlayerId): PlayerId {
  const i = state.seatOrder.indexOf(after);
  if (i < 0) throw new Error(`nextPlayer: ${after} is not seated`);
  return state.seatOrder[(i + 1) % state.seatOrder.length] as PlayerId;
}
