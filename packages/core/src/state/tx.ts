/**
 * `Tx` — the only sanctioned way to mutate `GameState`.
 *
 * The reducer clones the state, hands the clone to a step handler wrapped in a `Tx`, and keeps the
 * result only if the handler returns `Ok`. So handlers mutate freely and a refused action is
 * simply a discarded draft; there is no rollback to get wrong.
 *
 * What `Tx` buys over raw mutation:
 *
 * - **Derived data cannot drift.** Moving a piece updates `pieces[].at` *and* `occupancy` in one
 *   call; taking a piece off the board returns it to its owner's supply. These are exactly the
 *   pairings `assertInvariants` checks, so the class that maintains them is the class that makes
 *   the invariants pass by construction rather than by vigilance.
 * - **Card movement is conserved.** Every transfer takes from one holder and gives to another;
 *   there is no `give` without a source. That is what keeps `checkCardConservation` green.
 * - **Entropy is accounted for.** `random` threads `state.rng` through, so no handler can forget
 *   to store the advanced state — the single easiest way to break replay determinism.
 * - **Events are collected as they happen**, next to the mutation that caused them, rather than
 *   reconstructed from a diff afterwards.
 *
 * Methods here throw on impossible input (moving a piece that does not exist, paying from an empty
 * hand). That is deliberate: those are engine bugs, not rule violations, and legality is the step
 * handler's job to establish *before* it calls in here.
 */

import type { LocusId, PieceId, PieceKind, PlayerId } from '../ids.js';
import { type CardId, type CardKind, cardId, type DeckId, pieceId } from '../ids.js';
import type { RngDraw, RngState } from '../rng.js';
import type { GameEvent } from '../rules/event.js';
import type { RuleContext } from '../rules/ruleset.js';
import type { CardInstance, Cost, GameState, Outcome, Piece, Step } from './gameState.js';
import { piecesAt } from './gameState.js';

/**
 * A source or sink for cards. `'bank'` is not a `PlayerId` — player ids are `p0`, `p1`, … — so the
 * union is unambiguous, and every transfer names both ends.
 */
export const BANK = 'bank';
export type CardHolder = PlayerId | typeof BANK;

export class Tx {
  readonly ctx: RuleContext;
  readonly state: GameState;

  private readonly out: GameEvent[] = [];

  constructor(ctx: RuleContext, state: GameState) {
    this.ctx = ctx;
    this.state = state;
  }

  get events(): readonly GameEvent[] {
    return this.out;
  }

  emit(event: GameEvent): void {
    this.out.push(event);
  }

  // ── Entropy ───────────────────────────────────────────────────────────────────────────────

  /**
   * Draw from the game's RNG, storing the advanced state.
   *
   * Written as a higher-order call — `tx.random((rng) => rollDie(rng, 6))` — so that "draw" and
   * "store the new state" cannot be separated. Any other way of reading `state.rng` is a bug.
   */
  random<T>(draw: (rng: RngState) => RngDraw<T>): T {
    const result = draw(this.state.rng);
    this.state.rng = result.state;
    return result.value;
  }

  // ── Pieces ────────────────────────────────────────────────────────────────────────────────

  /**
   * The next id number. Pieces and cards share one counter, so an id is unique across *both*
   * — which makes a mixed-up `PieceId`/`CardId` in a log resolve to nothing rather than to the
   * wrong object of the other kind.
   */
  private nextSeq(): number {
    const n = this.state.seq;
    this.state.seq = n + 1;
    return n;
  }

  /**
   * Put a new piece on the board, drawing it from its owner's supply.
   *
   * Throws if the supply is empty — `isLegal` must have checked, and building a 16th road would
   * otherwise silently produce a state that fails `checkPieceSupply` two actions later.
   */
  createPiece(kind: PieceKind, owner: PlayerId | null, at: LocusId | null): Piece {
    const piece: Piece = { id: pieceId(this.nextSeq()), kind, owner, at: null, st: {} };
    this.state.board.pieces[piece.id] = piece;
    if (owner !== null) {
      const p = this.player(owner);
      const held = p.supply[kind] ?? 0;
      if (held <= 0) {
        throw new Error(`Tx.createPiece: ${owner} has no ${kind} left in supply`);
      }
      p.supply[kind] = held - 1;
    }
    if (at !== null) this.movePiece(piece.id, at);
    return piece;
  }

  /** Move a piece to a locus, or off the board with `null`. Keeps `occupancy` in step. */
  movePiece(id: PieceId, to: LocusId | null): void {
    const piece = this.piece(id);
    const from = piece.at;
    if (from === to) return;
    if (from !== null) {
      const remaining = piecesAt(this.state.board, from).filter((p) => p !== id);
      if (remaining.length === 0) delete this.state.board.occupancy[from];
      else this.state.board.occupancy[from] = remaining;
    }
    piece.at = to;
    if (to !== null) {
      this.state.board.occupancy[to] = [...piecesAt(this.state.board, to), id];
    }
  }

  /**
   * Take a piece off the board for good, returning it to its owner's supply.
   *
   * The record is deleted rather than parked with `at: null`, because a piece owned by a player
   * but nowhere on the board is precisely what `checkPieceSupply` counts as missing. Ids are never
   * reused, so a client still referring to the old settlement resolves to nothing.
   */
  destroyPiece(id: PieceId): void {
    const piece = this.piece(id);
    this.movePiece(id, null);
    if (piece.owner !== null) {
      const p = this.player(piece.owner);
      p.supply[piece.kind] = (p.supply[piece.kind] ?? 0) + 1;
    }
    delete this.state.board.pieces[id];
  }

  // ── Cards ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Move a bundle of fungible cards between two holders.
   *
   * The only card-moving primitive, so every payment, payout, steal, discard and monopoly is a
   * conserved transfer by construction. Throws if the source is short — clamping is a *rule*
   * (the bank running dry on a production roll), and rules belong in handlers, not here.
   */
  transfer(from: CardHolder, to: CardHolder, bundle: Cost): void {
    for (const [kind, n] of Object.entries(bundle)) {
      if (n === undefined || n === 0) continue;
      if (n < 0) throw new Error(`Tx.transfer: negative amount ${n} of ${kind}`);
      const held = this.cards(from)[kind] ?? 0;
      if (held < n) {
        throw new Error(`Tx.transfer: ${from} holds ${held} ${kind}, cannot pay ${n}`);
      }
      this.cards(from)[kind] = held - n;
      this.cards(to)[kind] = (this.cards(to)[kind] ?? 0) + n;
    }
  }

  /** A holder's card piles, as a mutable reference. */
  private cards(holder: CardHolder): Record<CardKind, number> {
    return holder === BANK ? this.state.bank : this.player(holder).cards;
  }

  /** How many of `kind` a holder has. */
  held(holder: CardHolder, kind: CardKind): number {
    return this.cards(holder)[kind] ?? 0;
  }

  /**
   * Mint a card instance into a deck's draw pile. Setup only — during play cards move, never
   * appear.
   */
  createCard(deck: DeckId, def: string, acquiredTurn: number | null = null): CardId {
    const id = cardId(this.nextSeq());
    const instance: CardInstance = { def, deck, acquiredTurn };
    this.state.cardInstances[id] = instance;
    this.deck(deck).draw = [...this.deck(deck).draw, id];
    return id;
  }

  /**
   * Draw the top card of a deck into a player's hand, stamping the turn it was acquired.
   *
   * Returns `undefined` when the deck is empty. That is a legal state of the world — the base game
   * has 25 development cards and simply runs out — so the caller decides whether it is a violation.
   */
  drawCard(deckId: DeckId, to: PlayerId): CardId | undefined {
    const deck = this.deck(deckId);
    const [next, ...rest] = deck.draw;
    if (next === undefined) return undefined;
    deck.draw = rest;
    const instance = this.state.cardInstances[next];
    if (instance === undefined) throw new Error(`Tx.drawCard: no instance record for ${next}`);
    instance.acquiredTurn = this.state.turn.n;
    const player = this.player(to);
    player.hands[deckId] = [...(player.hands[deckId] ?? []), next];
    return next;
  }

  /** Turn a card in a player's hand face up, where it stays — a played knight, a revealed VP. */
  revealCard(owner: PlayerId, card: CardId): void {
    const player = this.player(owner);
    const instance = this.state.cardInstances[card];
    if (instance === undefined) throw new Error(`Tx.revealCard: unknown card ${card}`);
    const hand = player.hands[instance.deck] ?? [];
    if (!hand.includes(card)) {
      throw new Error(`Tx.revealCard: ${owner} does not hold ${card}`);
    }
    player.hands[instance.deck] = hand.filter((c) => c !== card);
    player.revealed = [...player.revealed, card];
  }

  /**
   * Move a card from a player's hand to its deck's discard pile — a played progress card.
   *
   * Distinct from `revealCard`, which leaves the card in front of its owner. The difference is
   * load-bearing: Largest Army counts revealed knights, so a progress card that stayed revealed
   * would be indistinguishable from one for any rule that reads the same pile.
   */
  discardCard(owner: PlayerId, card: CardId): void {
    const player = this.player(owner);
    const instance = this.state.cardInstances[card];
    if (instance === undefined) throw new Error(`Tx.discardCard: unknown card ${card}`);
    const hand = player.hands[instance.deck] ?? [];
    if (!hand.includes(card)) {
      throw new Error(`Tx.discardCard: ${owner} does not hold ${card}`);
    }
    player.hands[instance.deck] = hand.filter((c) => c !== card);
    const deck = this.deck(instance.deck);
    deck.discard = [...deck.discard, card];
  }

  /** Reorder a deck's draw pile — the setup shuffle. */
  setDraw(deckId: DeckId, order: readonly CardId[]): void {
    this.deck(deckId).draw = order;
  }

  // ── The continuation stack ────────────────────────────────────────────────────────────────

  /** Push a step. **It becomes the top**, so it happens next. */
  push(step: Step): void {
    this.state.stack = [...this.state.stack, step];
  }

  /** Push several steps to run in the given order — first argument first. */
  pushSequence(steps: readonly Step[]): void {
    this.state.stack = [...this.state.stack, ...[...steps].reverse()];
  }

  pop(): Step | undefined {
    const top = this.state.stack[this.state.stack.length - 1];
    this.state.stack = this.state.stack.slice(0, -1);
    return top;
  }

  /** Replace the top step — how a multi-part step records its own progress. */
  replaceTop(step: Step): void {
    if (this.state.stack.length === 0) throw new Error('Tx.replaceTop: the stack is empty');
    this.state.stack = [...this.state.stack.slice(0, -1), step];
  }

  /** Amend the top step's `data`, keeping its kind and actor. */
  amendTop(data: Readonly<Record<string, unknown>>): void {
    const top = this.state.stack[this.state.stack.length - 1];
    if (top === undefined) throw new Error('Tx.amendTop: the stack is empty');
    this.replaceTop({ ...top, data: { ...top.data, ...data } });
  }

  // ── Turn bookkeeping ──────────────────────────────────────────────────────────────────────

  flag(name: string): number {
    return this.state.turn.flags[name] ?? 0;
  }

  bumpFlag(name: string, by = 1): number {
    const next = this.flag(name) + by;
    this.state.turn.flags[name] = next;
    return next;
  }

  /** End the game. Clears the stack: with an outcome there is nothing left to do. */
  finish(outcome: Outcome): void {
    this.state.outcome = outcome;
    this.state.stack = [];
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────

  private piece(id: PieceId): Piece {
    const piece = this.state.board.pieces[id];
    if (piece === undefined) throw new Error(`Tx: unknown piece ${id}`);
    return piece;
  }

  private player(id: PlayerId) {
    const p = this.state.players[id];
    if (p === undefined) throw new Error(`Tx: unknown player ${id}`);
    return p;
  }

  private deck(id: DeckId) {
    const deck = this.state.decks[id];
    if (deck === undefined) throw new Error(`Tx: unknown deck ${id}`);
    return deck;
  }
}
