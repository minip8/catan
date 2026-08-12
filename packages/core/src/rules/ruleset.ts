/**
 * The `RuleSet`: everything that varies between the base game and its expansions, as data.
 *
 * Core contains no Catan-specific behaviour. It clones the state, finds the top of the
 * continuation stack, hands the action to the step handler the ruleset registered for that step's
 * kind, and checks the invariants. *Which* resources exist, what a settlement costs, how many
 * cards trigger a discard, what a knight does — all of it lives in tables here, supplied by a
 * ruleset module.
 *
 * That is what makes the README's rule enforceable: no literal list of the five resources outside
 * the base ruleset. Discarding reads `cardKinds[k].countsTowardHandLimit`; a steal reads
 * `stealable`; monopoly reads `monopolisable`. When Cities & Knights adds commodities — which
 * count toward the hand limit but cannot be stolen by the robber — none of that code changes.
 *
 * The behavioural hooks (`steps`, `cardDefs[].play`, `awards[].metric`) are functions rather than
 * more data because they *are* the game's logic; the point is that they are registered in a table
 * the ruleset owns rather than reached by a `switch` inside core.
 */

import type { Scenario } from '../board/scenario.js';
import type { Topology } from '../board/topology.js';
import type {
  AwardId,
  CardDefId,
  CardKind,
  DeckId,
  PieceKind,
  PlayerId,
  TerrainId,
} from '../ids.js';
import type { Result } from '../result.js';
import type { Cost, GameState, Step } from '../state/gameState.js';
import type { Tx } from '../state/tx.js';
import type { Action, ActionSpec } from './action.js';
import type { RuleViolation } from './violation.js';

/** Everything a rule needs that is not `GameState`: the graph, the map, and the rules themselves. */
export interface RuleContext {
  readonly topology: Topology;
  readonly scenario: Scenario;
  readonly rules: RuleSet;
}

// ── Metadata tables ─────────────────────────────────────────────────────────────────────────

/**
 * How a fungible card kind behaves.
 *
 * Every flag here exists because some expansion answers it differently from the base game's
 * resources. Splitting them out means the base game's five resources are simply the case where
 * they are all true.
 */
export interface CardKindMeta {
  readonly id: CardKind;
  /** Counted against the hand limit that forces a discard on a 7. */
  readonly countsTowardHandLimit: boolean;
  /** Can be taken by the robber. (Cities & Knights commodities cannot.) */
  readonly stealable: boolean;
  /** Can be demanded by a Monopoly. */
  readonly monopolisable: boolean;
  /** Can be offered in a player-to-player trade. */
  readonly tradeable: boolean;
  /** Can be exchanged at a harbour or at the default maritime rate. */
  readonly maritime: boolean;
  /** Comes out of the bank's fixed pool, so it is conserved (`checkCardConservation`). */
  readonly banked: boolean;
}

/** Which kind of locus a piece occupies. Core uses this instead of assuming, e.g., vertices. */
export type LocusKind = 'hex' | 'vertex' | 'edge' | 'track' | 'offboard';

export interface PieceKindMeta {
  readonly id: PieceKind;
  readonly locus: LocusKind;
  /** Per-player allowance: 15 roads, 5 settlements, 4 cities. `null` for unowned pieces. */
  readonly limit: number | null;
  /** Build cost, if it can be built. Absent for the robber. */
  readonly cost?: Cost;
  /** Victory points while on the board. */
  readonly victoryPoints: number;
  /**
   * How many cards its owner collects when the piece's hex produces: 1 for a settlement, 2 for a
   * city. `0` for pieces that do not produce.
   */
  readonly production: number;
  /** Occupies its locus exclusively, so nothing else may be built there. */
  readonly exclusive: boolean;
  /** Counts as a segment of its owner's route for the Longest Road metric. */
  readonly routeSegment: boolean;
  /** Stops an *opponent's* route from passing through its intersection. */
  readonly blocksRoute: boolean;
  /** Blocks production on the hex it stands on. The robber (and later the pirate). */
  readonly blocksProduction: boolean;
  /**
   * A hex class the piece's locus must touch at least one of.
   *
   * `'land'` for every base-game piece: a settlement needs land under one of its three corners,
   * and a road may run along a coast but not between two sea hexes. Seafarers' ship is the mirror
   * image, `'water'`. `null` for pieces with no such requirement.
   */
  readonly needsAdjacent: 'land' | 'water' | null;
  /** Built by replacing this kind, which returns to its owner's supply. City ← settlement. */
  readonly upgradesFrom?: PieceKind;
  /** False for neutral pieces (the robber), which belong to no player. */
  readonly owned: boolean;
}

/**
 * A development-card definition.
 *
 * `play` is the card's entire behaviour, which is why there is no `switch (card.def)` anywhere in
 * the engine. It runs *after* core has verified ownership, timing and the one-per-turn limit, and
 * may push steps (Road Building pushes two free placements) or resolve immediately (Monopoly).
 */
export interface CardDefMeta {
  readonly id: CardDefId;
  readonly deck: DeckId;
  /** Victory points while held. 1 for the five VP cards, 0 for the rest. */
  readonly victoryPoints: number;
  /** Whether it can be played at all. The VP cards cannot; they are revealed on winning. */
  readonly playable: boolean;
  /** Contribution to the Largest Army metric when played. 1 for a knight. */
  readonly army: number;
  readonly play?: (
    ctx: RuleContext,
    tx: Tx,
    actor: PlayerId,
    action: Action,
  ) => Result<void, RuleViolation>;
  /** Concrete play actions to offer a UI, given the current state. */
  readonly options?: (ctx: RuleContext, state: GameState, actor: PlayerId) => readonly Action[];
}

export interface DeckSpec {
  readonly id: DeckId;
  readonly cost: Cost;
  /** Definition id to copies in the deck: 14 knights, 5 victory points, 2 of each progress card. */
  readonly composition: Readonly<Record<CardDefId, number>>;
  /** Whether the discard pile is reshuffled when the draw pile empties. The base deck is not. */
  readonly recycle: boolean;
}

/**
 * An award — Longest Road, Largest Army.
 *
 * `metric` is recomputed for every player after any action that could change it, rather than
 * maintained incrementally. Recomputation is cheap (a player has at most 15 roads) and it is the
 * only way to catch the case that trips up incremental implementations: **an opponent's new
 * settlement can shorten your road without you doing anything at all.**
 */
export interface AwardSpec {
  readonly id: AwardId;
  readonly value: number;
  /** The metric value at which the award first becomes available: 5 roads, 3 knights. */
  readonly threshold: number;
  readonly metric: (ctx: RuleContext, state: GameState, player: PlayerId) => number;
}

// ── Step handlers ───────────────────────────────────────────────────────────────────────────

/**
 * The behaviour of one kind of step on the continuation stack.
 *
 * A handler owns the top of the stack while it is there, including popping itself and pushing
 * what comes next — the engine never advances the stack on a handler's behalf, because only the
 * handler knows whether the step is finished (a discard step with four players owing cards is not
 * done after the first discard).
 *
 * Handlers mutate through `Tx` and may mutate freely *before* returning an `Err`: the reducer
 * works on a clone and throws the whole draft away when an action is refused, so a half-applied
 * action can never be observed.
 */
export interface StepHandler {
  /**
   * Resolve a step whose actor is `'system'`, with no player input. The engine runs these to
   * completion after every action, so control always comes to rest on a step someone owns.
   */
  readonly run?: (ctx: RuleContext, tx: Tx, step: Step) => void;
  /** Descriptors of what `actor` may do. Never consulted by the reducer — UIs and bots only. */
  readonly actions?: (
    ctx: RuleContext,
    state: GameState,
    step: Step,
    actor: PlayerId,
  ) => readonly ActionSpec[];
  /** Validate and apply. The authority: if this returns `Ok`, the action was legal. */
  readonly apply?: (
    ctx: RuleContext,
    tx: Tx,
    step: Step,
    actor: PlayerId,
    action: Action,
  ) => Result<void, RuleViolation>;
}

// ── The ruleset ─────────────────────────────────────────────────────────────────────────────

/**
 * The subset of `GameState` a victory-point count needs.
 *
 * Typed as a subset rather than as `GameState` so that the *redacted* view satisfies it too, and a
 * client can compute the scoreboard from what it can see. It naturally under-counts opponents'
 * hidden victory-point cards, which is exactly right: that is what the opponents can see.
 */
export interface VpSource {
  readonly board: GameState['board'];
  readonly players: GameState['players'];
  readonly awards: GameState['awards'];
  readonly cardInstances: Readonly<Record<string, { readonly def: CardDefId | null }>>;
}

export interface RuleSet {
  readonly id: string;
  readonly cardKinds: Readonly<Record<CardKind, CardKindMeta>>;
  readonly pieceKinds: Readonly<Record<PieceKind, PieceKindMeta>>;
  readonly cardDefs: Readonly<Record<CardDefId, CardDefMeta>>;
  readonly decks: Readonly<Record<DeckId, DeckSpec>>;
  readonly awards: Readonly<Record<AwardId, AwardSpec>>;
  /** What each terrain pays out. `null` for the desert. */
  readonly terrainYield: Readonly<Record<TerrainId, CardKind | null>>;

  /** Dice: two six-sided in every published ruleset, but the numbers live here regardless. */
  readonly dice: { readonly count: number; readonly sides: number };
  /** The roll that moves the robber. */
  readonly robberRoll: number;
  /** Cards above which a 7 forces a discard. */
  readonly handLimit: number;
  /** Fraction of the hand discarded, rounded down. Half in the base game. */
  readonly discardFraction: number;

  readonly steps: Readonly<Record<string, StepHandler>>;

  /** Push the opening continuation stack. Called once, after the board is dealt. */
  readonly begin: (ctx: RuleContext, tx: Tx) => void;
  readonly victoryPoints: (ctx: RuleContext, state: VpSource, player: PlayerId) => number;
}

// ── Lookups ─────────────────────────────────────────────────────────────────────────────────
//
// Every table is an open `Record`, so a missing key is a real possibility (a hostile client naming
// a piece kind that does not exist). These accessors keep that from becoming an `undefined` deref
// halfway down a rule.

export function cardKind(rules: RuleSet, kind: CardKind): CardKindMeta | undefined {
  return rules.cardKinds[kind];
}

export function pieceKind(rules: RuleSet, kind: PieceKind): PieceKindMeta | undefined {
  return rules.pieceKinds[kind];
}

/** Throws if the kind is unknown — for call sites naming a kind the ruleset itself declared. */
export function requirePieceKind(rules: RuleSet, kind: PieceKind): PieceKindMeta {
  const meta = rules.pieceKinds[kind];
  if (meta === undefined) throw new Error(`ruleset ${rules.id} has no piece kind ${kind}`);
  return meta;
}

export function cardDef(rules: RuleSet, def: CardDefId): CardDefMeta | undefined {
  return rules.cardDefs[def];
}

/** Card kinds satisfying a predicate, in table order. The replacement for hardcoded lists. */
export function kindsWhere(
  rules: RuleSet,
  predicate: (meta: CardKindMeta) => boolean,
): readonly CardKind[] {
  return Object.values(rules.cardKinds)
    .filter(predicate)
    .map((m) => m.id);
}

/** The kinds the bank stocks — what production, trades and monopolies can move. */
export function bankedKinds(rules: RuleSet): readonly CardKind[] {
  return kindsWhere(rules, (m) => m.banked);
}
