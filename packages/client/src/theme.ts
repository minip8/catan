/**
 * Names and colours.
 *
 * Core's taxonomies are deliberately *open*: `CardKind`, `TerrainId` and `PieceKind` accept any
 * string so an expansion can add members without editing the engine. A UI that switched on them
 * exhaustively would therefore be wrong the day paper and coin arrive — so every lookup here
 * falls back to something derived from the name itself. An unknown resource shows up as a
 * consistently-coloured chip with its own label rather than as a blank or a crash.
 *
 * Seat colours are the published six. Above six players the board is already unofficial (core
 * generates those layouts and marks them so), and the extra seats get evenly-spaced hues.
 */

import type { CardKind, PieceKind, PlayerId, TerrainId } from '@catan/core';

export interface Seat {
  readonly name: string;
  readonly color: string;
  /** Text drawn on top of `color`. */
  readonly ink: string;
}

/** The six published player colours, in the order core seats them. */
const SEATS: readonly Seat[] = [
  { name: 'Red', color: '#c1352c', ink: '#fff' },
  { name: 'Blue', color: '#2f6bb5', ink: '#fff' },
  { name: 'White', color: '#e8e4dc', ink: '#2a2724' },
  { name: 'Orange', color: '#d9822b', ink: '#2a2724' },
  { name: 'Green', color: '#3f8f5a', ink: '#fff' },
  { name: 'Brown', color: '#7a5236', ink: '#fff' },
];

export function seatStyle(seat: number): Seat {
  const known = SEATS[seat];
  if (known !== undefined) return known;
  // Seven or more players is an unofficial board; spread the extras around the wheel.
  const hue = ((seat - SEATS.length) * 47 + 200) % 360;
  return { name: `Seat ${seat + 1}`, color: `hsl(${hue} 55% 45%)`, ink: '#fff' };
}

export interface Named {
  readonly seat: number;
}

/** A player's display name. Takes the seat map rather than a view, so it is usable anywhere. */
export function playerName(seats: Readonly<Record<PlayerId, Named>>, id: PlayerId): string {
  const seat = seats[id]?.seat;
  return seat === undefined ? id : seatStyle(seat).name;
}

// ── Terrain ─────────────────────────────────────────────────────────────────────────────────

export interface TerrainStyle {
  readonly label: string;
  readonly fill: string;
}

/**
 * Terrain fills: bright and saturated, the way a table seen from above reads, because the shell
 * around the board is now open water rather than a dark frame. The board lays a bevel over these
 * (see `board.ts`) that darkens the lower edge, so the flat colour is the tile's lit face.
 */
const TERRAIN: Readonly<Record<string, TerrainStyle>> = {
  hills: { label: 'Hills', fill: '#d9703a' },
  forest: { label: 'Forest', fill: '#3f8a3c' },
  mountains: { label: 'Mountains', fill: '#aab0b6' },
  fields: { label: 'Fields', fill: '#f2c53d' },
  pasture: { label: 'Pasture', fill: '#9fd158' },
  desert: { label: 'Desert', fill: '#e3d49f' },
};

/** The water. The page itself is this sea; `board.ts` only brightens it under the island. */
export const SEA_FILL = '#2c61a3';

/** The beach round the island and the seams between tiles. */
export const SAND_FILL = '#ebd39a';

export function terrainStyle(terrain: TerrainId | null): TerrainStyle {
  if (terrain === null) return { label: 'Unknown', fill: '#4a4a4a' };
  return TERRAIN[terrain] ?? { label: humanize(terrain), fill: hueFor(terrain, 45, 40) };
}

// ── Cards ───────────────────────────────────────────────────────────────────────────────────

export interface CardStyle {
  readonly label: string;
  readonly color: string;
}

/** A card is the colour of the land that makes it, so a hand reads back onto the board. */
const CARDS: Readonly<Record<string, CardStyle>> = {
  brick: { label: 'Brick', color: '#d9703a' },
  lumber: { label: 'Lumber', color: '#3f8a3c' },
  ore: { label: 'Ore', color: '#9aa6b2' },
  grain: { label: 'Grain', color: '#f2c53d' },
  wool: { label: 'Wool', color: '#9fd158' },
};

export function cardStyle(kind: CardKind): CardStyle {
  return CARDS[kind] ?? { label: humanize(kind), color: hueFor(kind, 50, 45) };
}

/** Development cards are named, not typed — the deck is data, so this is a label table only. */
const CARD_DEFS: Readonly<Record<string, string>> = {
  knight: 'Knight',
  roadBuilding: 'Road Building',
  yearOfPlenty: 'Year of Plenty',
  monopoly: 'Monopoly',
  chapel: 'Chapel',
  library: 'Library',
  market: 'Market',
  greatHall: 'Great Hall',
  university: 'University',
};

export function cardDefName(def: string | null): string {
  if (def === null) return 'Hidden';
  return CARD_DEFS[def] ?? humanize(def);
}

// ── Pieces ──────────────────────────────────────────────────────────────────────────────────

const PIECES: Readonly<Record<string, string>> = {
  road: 'Road',
  settlement: 'Settlement',
  city: 'City',
  robber: 'Robber',
};

export function pieceName(kind: PieceKind): string {
  return PIECES[kind] ?? humanize(kind);
}

// ── Odds ────────────────────────────────────────────────────────────────────────────────────

/**
 * How many of the 36 rolls produce `n` — the pips printed under a number token.
 *
 * Derived rather than tabled, so it stays right for any dice a ruleset declares two of. Zero for
 * a number two dice cannot make, which is also the right answer for the robber's own roll.
 */
export function pipsFor(n: number, sides: number): number {
  return Math.max(0, sides - Math.abs(n - (sides + 1)));
}

// ── Fallbacks ───────────────────────────────────────────────────────────────────────────────

/** `longestRoad` → `Longest Road`. The fallback for every open taxonomy in this file. */
export function humanize(id: string): string {
  const spaced = id.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A stable colour for a name nobody has styled yet. Same string, same colour, every session. */
function hueFor(name: string, saturation: number, lightness: number): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${hash} ${saturation}% ${lightness}%)`;
}
