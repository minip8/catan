/**
 * Identity types for everything the engine addresses.
 *
 * Two deliberate choices here that the rest of the engine inherits:
 *
 * 1. **Ids are branded strings.** They are strings at runtime (so they are JSON-safe and usable
 *    as object keys) but are not interchangeable at compile time. Passing a `VertexId` where an
 *    `EdgeId` is expected is the single easiest mistake to make in a hex-grid codebase, and this
 *    makes it a type error.
 *
 * 2. **Taxonomy unions are *open*.** `CardKind`, `PieceKind`, `TerrainId`, `DeckId` and `AwardId`
 *    list the base game's members for autocomplete, but accept any string. Expansions introduce
 *    new members (commodities, ships, knights, three progress decks) without editing core, and —
 *    more importantly — **core code cannot `switch` exhaustively over them**, which is exactly the
 *    pressure we want. Behaviour comes from the `RuleSet`'s metadata tables, not from a `switch`.
 */

// `Widen` keeps a string-literal union open without using the banned `{}` type. Intersecting
// with an empty record is a no-op for assignability but defeats literal-union narrowing, which
// is what preserves editor autocomplete for the listed members.
type Widen = string & Record<never, never>;

declare const brand: unique symbol;

/** A string tagged with a phantom type, so distinct id kinds cannot be mixed up. */
export type Id<Tag extends string> = string & { readonly [brand]: Tag };

// ── Board addresses ─────────────────────────────────────────────────────────────────────────
//
// Encodings are canonical and total, so equality is string equality and ids are stable across
// processes and replays. See `coords/` for the constructors — never build these by hand.

/** A hex cell. Encoded from axial coordinates as `"q,r"`, e.g. `"0,0"`, `"-1,2"`. */
export type HexId = Id<'hex'>;

/**
 * An intersection. Encoded as its three touching hexes, sorted, joined by `|`.
 *
 * Keyed on the *infinite lattice*, so the id is independent of which cells the scenario declares.
 * This is why the encoding survives coastlines, multi-island maps, and hexes revealed mid-game.
 */
export type VertexId = Id<'vertex'>;

/**
 * A path between two hexes. Encoded as its two hexes, sorted, joined by `|`.
 *
 * Keyed by *hexes* rather than by its two vertices because placement legality is a function of
 * the flanking terrain (land/land takes a road, sea/sea takes a ship), and because "the pirate
 * blocks this hex's six edges" then becomes one lookup.
 */
export type EdgeId = Id<'edge'>;

/** A position on an off-board track, e.g. a barbarian ship's progress. Unused by the base game. */
export type TrackId = Id<'track'>;

/** The pseudo-locus for pieces that are off the board (a robber with no desert to start in). */
export type OffboardId = Id<'offboard'>;
export const OFFBOARD = 'offboard' as OffboardId;

/**
 * Anywhere a piece can be.
 *
 * Which member a given piece kind uses is declared by `PieceKindMeta.locus`, so core never
 * assumes that (say) a settlement is on a vertex.
 */
export type LocusId = HexId | VertexId | EdgeId | TrackId | OffboardId;

// ── Participants and objects ────────────────────────────────────────────────────────────────

export type PlayerId = Id<'player'>;

/** A physical piece: one road, one settlement, the robber. Identity persists across moves. */
export type PieceId = Id<'piece'>;

/**
 * One *instance* of a card. Distinct from its definition id, because "the knight you bought
 * this turn" must be distinguishable from "the knight you bought last turn".
 */
export type CardId = Id<'cardInstance'>;

// ── Open taxonomies ─────────────────────────────────────────────────────────────────────────

/**
 * Anything counted as a fungible pile in a player's hand or the bank.
 *
 * The base game has only the five resources. Expansions add piles that behave differently under
 * the hand limit, stealing, trading and monopoly — so every such behaviour reads
 * `RuleSet.cardKinds` metadata rather than testing membership of a hardcoded list.
 */
export type CardKind = 'brick' | 'lumber' | 'ore' | 'grain' | 'wool' | Widen;

/** The five base-game resources. The *only* place this list is enumerated in core. */
export const BASE_RESOURCES = ['brick', 'lumber', 'ore', 'grain', 'wool'] as const;

export type PieceKind = 'road' | 'settlement' | 'city' | 'robber' | Widen;

export type TerrainId = 'hills' | 'forest' | 'mountains' | 'fields' | 'pasture' | 'desert' | Widen;

/** A draw pile. The base game has exactly one, `'dev'`; Cities & Knights has three. */
export type DeckId = 'dev' | Widen;

/** A card *definition* (`'knight'`, `'monopoly'`), as opposed to a `CardId` instance. */
export type CardDefId = string;

export type AwardId = 'longestRoad' | 'largestArmy' | Widen;

// ── Constructors ────────────────────────────────────────────────────────────────────────────
//
// Casts are confined to this file. Everything downstream is type-safe by construction.

export function playerId(n: number): PlayerId {
  return `p${n}` as PlayerId;
}

export function pieceId(n: number): PieceId {
  return `pc${n}` as PieceId;
}

export function cardId(n: number): CardId {
  return `c${n}` as CardId;
}

export function trackId(track: string, index: number): TrackId {
  return `${track}:${index}` as TrackId;
}
