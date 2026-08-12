/**
 * Redaction — what one player is allowed to see.
 *
 * The server holds the whole truth; every client gets a `PlayerView` of it. Three things are
 * hidden, and each of them would break the game if it leaked:
 *
 * - **`rng`.** A client holding the generator state can compute every future dice roll and the
 *   entire remaining deck order. This is the single most important field to strip.
 * - **Draw-pile order.** Replaced by a count. Which card is next is exactly what buying a
 *   development card is a bet on.
 * - **Card identities.** A card's *definition* is visible only if the viewer holds it, if it has
 *   been played face up, or if it is on a discard pile. The card *ids* stay visible everywhere, so
 *   a UI can still show that an opponent holds three development cards and animate the right one
 *   when it is played — it just cannot see what they are.
 *
 * Note what is deliberately *not* hidden: resource hands. The physical game hides them, but the
 * count is public and every serious digital implementation shows the composition, because tracking
 * it from the public log is mechanical and doing so by hand is just tedium. If a variant wants
 * them hidden, that belongs here, as one more field to fold.
 */

import type { CardDefId, CardId, DeckId, PlayerId } from '../ids.js';
import type { GameState } from '../state/gameState.js';

/** A card whose identity may or may not be visible to the viewer. */
export interface CardFacts {
  /** `null` when the viewer is not entitled to know what this card is. */
  readonly def: CardDefId | null;
  readonly deck: DeckId;
  readonly acquiredTurn: number | null;
}

/** A deck with its draw order stripped down to a count. */
export interface DeckFacts {
  readonly remaining: number;
  readonly discard: readonly CardId[];
}

export interface PlayerView extends Omit<GameState, 'rng' | 'decks' | 'cardInstances'> {
  /** Who this view was built for. `null` for a spectator or a public feed. */
  readonly viewer: PlayerId | null;
  /** Always `null`: proof, in the type, that the generator did not travel. */
  readonly rng: null;
  readonly decks: Readonly<Record<DeckId, DeckFacts>>;
  readonly cardInstances: Readonly<Record<CardId, CardFacts>>;
}

/**
 * Build `viewer`'s view of the game.
 *
 * `viewer` is `null` for spectators, which is the same view as a player with no cards: nothing
 * secret is visible. There is no "trusted spectator" mode — a spectator who could see hands would
 * be one open browser tab away from being a cheat.
 */
export function redactFor(state: GameState, viewer: PlayerId | null): PlayerView {
  const visible = visibleCards(state, viewer);

  // `Record<DeckId, …>` and friends demand the base game's literal members; the state being
  // redacted is the authority on which decks exist, so these start empty and are filled from it.
  const cardInstances = {} as Record<CardId, CardFacts>;
  for (const [id, instance] of Object.entries(state.cardInstances)) {
    cardInstances[id as CardId] = {
      def: visible.has(id as CardId) ? instance.def : null,
      deck: instance.deck,
      acquiredTurn: instance.acquiredTurn,
    };
  }

  const decks = {} as Record<DeckId, DeckFacts>;
  for (const [id, deck] of Object.entries(state.decks)) {
    decks[id as DeckId] = { remaining: deck.draw.length, discard: deck.discard };
  }

  const { rng: _rng, decks: _decks, cardInstances: _instances, ...rest } = state;
  return { ...rest, viewer, rng: null, decks, cardInstances };
}

/** The cards whose identity `viewer` is entitled to know. */
function visibleCards(state: GameState, viewer: PlayerId | null): ReadonlySet<CardId> {
  const out = new Set<CardId>();

  for (const deck of Object.values(state.decks)) {
    for (const card of deck.discard) out.add(card);
  }
  for (const player of Object.values(state.players)) {
    // Face-up cards are public: a played knight has to be, or nobody could count Largest Army.
    for (const card of player.revealed) out.add(card);
    if (player.id !== viewer) continue;
    for (const hand of Object.values(player.hands)) {
      for (const card of hand) out.add(card);
    }
  }
  return out;
}
