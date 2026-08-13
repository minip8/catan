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
import { type GameRecord, newRecord, type ReplayOptions, record, replay } from './replay.js';
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
  /**
   * Continue an existing record rather than starting an empty one.
   *
   * Needed by anything that rebuilds a game from its log — a server restarting, a room recovering
   * after a crash. Without it a restored session would hold a state produced by ninety actions and
   * a record claiming none, and the next save would truncate the game's history to one move.
   */
  readonly record?: GameRecord;
}

export class Session {
  readonly ctx: RuleContext;

  private current: GameState;
  private log: GameRecord;
  private readonly invariants: InvariantContext | undefined;

  constructor(game: NewGame, options: SessionOptions = {}) {
    this.ctx = game.ctx;
    this.current = game.state;
    this.log =
      options.record === undefined ? newRecord(game.state) : adopt(game.state, options.record);
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

export interface RestoreOptions extends SessionOptions, ReplayOptions {}

/**
 * Rebuild a session from its record.
 *
 * This is the whole of a server's crash recovery, and the reason `replay` was worth building: a
 * room is restored by replaying the decisions its players made, not by deserialising a state whose
 * shape will change as expansions land. The session it returns continues the same record, so the
 * next action appends rather than starting a second history.
 */
export function restoreSession(saved: GameRecord, options: RestoreOptions = {}): Session {
  const rebuilt = replay(saved, options);
  // With `upTo`, the record must be cut to what was actually applied — otherwise the session would
  // claim actions its state has never seen.
  const record: GameRecord =
    rebuilt.applied === saved.actions.length
      ? saved
      : { ...saved, actions: saved.actions.slice(0, rebuilt.applied) };
  return new Session(
    rebuilt,
    options.checkInvariants === true ? { checkInvariants: true, record } : { record },
  );
}

/**
 * Take on a record, refusing one that belongs to a different game.
 *
 * Cheap to check and expensive to get wrong: a session holding someone else's log would save that
 * log over its own, and the mistake would only surface when the replay dealt a different island.
 */
function adopt(state: GameState, saved: GameRecord): GameRecord {
  const mine = newRecord(state);
  const mismatched =
    saved.seed !== mine.seed ||
    saved.scenarioId !== mine.scenarioId ||
    saved.ruleSetId !== mine.ruleSetId ||
    saved.seatOrder.length !== mine.seatOrder.length ||
    saved.seatOrder.some((id, i) => id !== mine.seatOrder[i]);
  if (mismatched) {
    throw new Error(
      `Session: the supplied record (${saved.scenarioId} seed ${saved.seed}) does not belong to ` +
        `this game (${mine.scenarioId} seed ${mine.seed})`,
    );
  }
  return saved;
}
