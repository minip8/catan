/**
 * A game session: the engine with its bookkeeping attached.
 *
 * `reduce` is deliberately a bare function over immutable values, which is right for the rules but
 * leaves every caller doing the same four things — hold the current state, append to the action
 * log, redact per viewer, and hand each player their own events. A server does it once per room; a
 * local UI does it once per tab; a bot harness does it once per match. So it is done here, once.
 *
 * The session owns no I/O and no clock. It is a value with a mutable current state, not a service:
 * whatever transport a caller uses, it calls `act` and fans `deliveries` out to its sockets.
 *
 * **`view` and `deliver` are the only things a client should ever be given.** Handing a client the
 * raw `state` leaks the RNG and the deck, which is why `state` is exposed as a getter for the
 * *server's* use and everything player-facing goes through redaction.
 */

import type { PlayerId } from '../ids.js';
import type { Result } from '../result.js';
import type { Action, ActionSpec } from '../rules/action.js';
import { type GameEvent, redactEvents } from '../rules/event.js';
import type { RuleContext } from '../rules/ruleset.js';
import type { RuleViolation } from '../rules/violation.js';
import type { GameState } from '../state/gameState.js';
import type { InvariantContext } from '../state/invariants.js';
import { invariantsFor, type NewGame } from './newGame.js';
import { legalActions, reduce } from './reduce.js';
import { type GameRecord, newRecord, record } from './replay.js';
import { type PlayerView, redactFor } from './view.js';

/** What one viewer is told about an accepted action. */
export interface Delivery {
  /** `null` addresses spectators and the public log. */
  readonly viewer: PlayerId | null;
  readonly view: PlayerView;
  readonly events: readonly GameEvent[];
}

export interface SessionOptions {
  /**
   * Check the structural invariants after every action.
   *
   * Worth the cost anywhere a bug is cheaper to find than to explain — development, staging, and
   * arguably production too: the check is linear in the board and hands, and it turns a corrupt
   * game into a loud failure at the action that caused it.
   */
  readonly checkInvariants?: boolean;
}

export class Session {
  readonly ctx: RuleContext;

  private current: GameState;
  private log: GameRecord;
  private readonly invariants: InvariantContext | undefined;

  constructor(game: NewGame, options: SessionOptions = {}) {
    this.ctx = game.ctx;
    this.current = game.state;
    this.log = newRecord(game.state);
    this.invariants =
      options.checkInvariants === true ? invariantsFor(game.ctx, game.state) : undefined;
  }

  /** The unredacted state. For the authority that owns this session — never for a client. */
  get state(): GameState {
    return this.current;
  }

  /** The replay record so far: seed, ids, seating, and every action accepted. */
  get record(): GameRecord {
    return this.log;
  }

  get over(): boolean {
    return this.current.outcome !== null;
  }

  /** What `viewer` may see. `null` for a spectator. */
  view(viewer: PlayerId | null): PlayerView {
    return redactFor(this.current, viewer);
  }

  /** What `actor` may do. Descriptors only — `act` is still the authority. */
  options(actor: PlayerId): readonly ActionSpec[] {
    return legalActions(this.ctx, this.current, actor);
  }

  /**
   * Apply an action.
   *
   * On success the session advances and the log grows; on a violation nothing changes at all, and
   * the caller gets the violation to send back to the client that asked.
   */
  act(actor: PlayerId, action: Action): Result<readonly Delivery[], RuleViolation> {
    const result = reduce(
      this.ctx,
      this.current,
      actor,
      action,
      this.invariants ? { invariants: this.invariants } : {},
    );
    if (!result.ok) return result;

    this.current = result.value.state;
    this.log = record(this.log, actor, action);
    return { ok: true, value: this.deliveries(result.value.events) };
  }

  /** One delivery per seat, plus one for spectators. */
  private deliveries(events: readonly GameEvent[]): readonly Delivery[] {
    const viewers: (PlayerId | null)[] = [...this.current.seatOrder, null];
    return viewers.map((viewer) => ({
      viewer,
      view: this.view(viewer),
      events: redactEvents(events, viewer),
    }));
  }
}
