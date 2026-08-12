/**
 * A `Scenario` is the **only** hardcoded description of a board in the engine.
 *
 * It is pure data: which cells exist, what is on them, where harbours dock, how setup runs, and
 * what it takes to win. The base 3-4 player board, the 5-6 player board, a generated 9-player
 * board and (later) a Seafarers multi-island map are all *the same code* driven by different
 * values of this type.
 *
 * Note what is deliberately **not** here: terrain and number tokens are copied into mutable
 * `HexState` when the game starts, not read from the scenario during play. The base game needs
 * that for randomised setup, and expansions relocate, hide and reveal tokens mid-game.
 */

import { type HexCoord, hexId, neighbors } from '../coords/axial.js';
import type { CardKind, EdgeId, TerrainId } from '../ids.js';

/**
 * What a scenario declares at one lattice position.
 *
 * `sea` being a real cell rather than "no cell" is what makes vertex ids total. The base rulebook
 * defines an intersection as a point where "3 hexes meet **or 1 or 2 hexes meet the frame**" — so
 * without sea in the lattice, every coastal intersection would be a special case.
 */
export type Cell =
  | { readonly kind: 'land'; readonly terrain: TerrainId; readonly numbers?: readonly number[] }
  | { readonly kind: 'sea' }
  /**
   * An explicit hole. Functionally the same as omitting the position, but it documents intent in
   * the scenario data and lets validation tell "deliberately absent" from "forgotten".
   */
  | { readonly kind: 'void' }
  /**
   * A slot whose terrain is drawn from `stacks` when it is discovered (Seafarers' Fog Island).
   *
   * The *position* is known from the start, so topology is fully static and vertex ids never
   * change on reveal. Only the contents are hidden.
   */
  | { readonly kind: 'unexplored'; readonly stack: string };

export interface CellPlacement {
  readonly q: number;
  readonly r: number;
  readonly cell: Cell;
}

/**
 * A maritime trade rate.
 *
 * `kind: null` is a generic harbour — any one resource type, three for one. A non-null `kind` is a
 * specific harbour, and per the almanac it grants its rate for *that resource only*: an ore 2:1
 * harbour gives you no better than 4:1 on wool, not even 3:1.
 */
export interface HarborSpec {
  readonly ratio: number;
  readonly kind: CardKind | null;
}

/**
 * A harbour docks against one **coastal edge**; a settlement or city on *either* of that edge's two
 * endpoints controls it. That is why the slot is an edge rather than a pair of vertices — the pair
 * is derivable, and storing it twice invites the two copies to disagree.
 *
 * `harbor: null` means "draw from `harborBag` during setup", which is the randomised-harbour option.
 */
export interface HarborSlot {
  readonly edge: EdgeId;
  readonly harbor: HarborSpec | null;
}

/**
 * One round of the opening placement.
 *
 * Modelled as data because the rounds differ between rulesets: the base game is
 * settlement+road forward, then settlement+road in reverse with production granted from the second
 * settlement. Cities & Knights places a city in round two; some Seafarers scenarios add a third
 * round.
 */
export interface SetupRound {
  /** `forward` follows seat order; `reverse` runs it backwards, so the last player places twice. */
  readonly order: 'forward' | 'reverse';
  /** Placed in this order, each connected to the one before, e.g. `['settlement', 'road']`. */
  readonly place: readonly string[];
  /** Whether players collect starting resources from what they placed this round. */
  readonly grantProduction: boolean;
}

export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly cells: readonly CellPlacement[];
  readonly harborSlots: readonly HarborSlot[];
  /** Harbour specs to shuffle into the slots that declared `harbor: null`. */
  readonly harborBag: readonly HarborSpec[];
  /**
   * Terrain and number-token bags to shuffle at setup, keyed by name.
   *
   * A preset with a fixed layout leaves these empty and puts terrain directly on its cells; the
   * randomised variant supplies bags instead. `unexplored` cells draw from here on reveal.
   */
  readonly stacks: Readonly<Record<string, readonly Cell[]>>;
  readonly numberBags: Readonly<Record<string, readonly number[]>>;
  /** Victory points needed to win. 10 for the base game; 12-14 in various expansion scenarios. */
  readonly victoryTarget: number;
  readonly setup: readonly SetupRound[];
  readonly minPlayers: number;
  readonly maxPlayers: number;
  /** Bank size per resource kind: 19 for 3-4 players, 24 for 5-6. */
  readonly bankPerKind: number;
  /**
   * True when this layout is not an official one (our generated 7-10 player boards).
   * The UI must say so — there are no published rules above 6 players.
   */
  readonly unofficial?: boolean;
}

// ── Authoring helpers ───────────────────────────────────────────────────────────────────────

export function landCoords(scenario: Scenario): readonly HexCoord[] {
  return scenario.cells.filter((c) => c.cell.kind === 'land').map(({ q, r }) => ({ q, r }));
}

/**
 * The ring of sea cells needed to give every supplied hex all six of its corners.
 *
 * One ring is exactly enough: a corner of a land hex needs its two flanking neighbours declared,
 * and every neighbour of a land hex is either land or in this ring.
 */
export function seaRingAround(coords: readonly HexCoord[]): readonly HexCoord[] {
  const occupied = new Set(coords.map(hexId));
  const out = new Map<string, HexCoord>();
  for (const c of coords) {
    for (const n of neighbors(c)) {
      const id = hexId(n);
      if (!occupied.has(id)) out.set(id, n);
    }
  }
  return [...out.values()];
}

/** Land placements plus the surrounding sea ring — the usual body of a single-island scenario. */
export function withSeaRing(land: readonly CellPlacement[]): readonly CellPlacement[] {
  const coords = land.map(({ q, r }) => ({ q, r }));
  const sea: CellPlacement[] = seaRingAround(coords).map(({ q, r }) => ({
    q,
    r,
    cell: { kind: 'sea' } as const,
  }));
  return [...land, ...sea];
}
