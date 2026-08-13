/**
 * The seam between the screen and the game.
 *
 * The app renders from a `Snapshot` — a redacted view, the options that go with it, and the log —
 * and sends moves back through `act`. Whether that snapshot came from a `Session` in this tab or
 * from a websocket is the *only* difference between hot seat and multiplayer, and it is confined to
 * the two implementations of this interface.
 *
 * The shape was not invented for this: `update` messages from `@catan/server` already carry exactly
 * a view, its options and the events that produced it, because `Session.act` produces exactly that
 * per viewer. The seam is narrow because the engine's redaction boundary was drawn in the right
 * place to begin with.
 *
 * One asymmetry is real and is reflected in `viewpoints`. A local table can show any seat's eyes,
 * because it holds the whole game. A remote client holds **one** view — the one the server sent it —
 * and cannot construct another, which is the entire point. So the seat switcher offers what the
 * table can actually see rather than a list of players.
 */

import type {
  Action,
  ActionSpec,
  GameEvent,
  NewGame,
  PlayerId,
  PlayerView,
  RuleContext,
} from '@catan/core';
import {
  baseRules,
  buildTopology,
  type Delivery,
  newGame,
  redactEvents,
  Session,
  scenarioById,
  scenarioForPlayers,
} from '@catan/core';

/** Everything the screen needs, for one viewer. */
export interface Snapshot {
  readonly viewer: PlayerId | null;
  readonly view: PlayerView;
  /** What this viewer may do. Empty for a spectator, and for anyone not being waited on. */
  readonly options: readonly ActionSpec[];
  /** The whole log so far, already redacted for this viewer. */
  readonly events: readonly GameEvent[];
  /** Actions applied. Two clients showing different numbers are out of step. */
  readonly at: number;
}

export interface Table {
  readonly ctx: RuleContext;
  /** The viewpoints this table can offer. Local: every seat plus a spectator's. Remote: yours. */
  readonly viewpoints: readonly (PlayerId | null)[];
  /** For the header: "Hot seat · seed 11", "Room 9jyb9g · live". */
  readonly label: string;
  /** False while a remote table is connecting. The UI stops offering moves it cannot deliver. */
  readonly ready: boolean;
  /** A refusal, or a word about the connection. */
  readonly notice: string | null;
  snapshot(viewer: PlayerId | null): Snapshot;
  act(viewer: PlayerId, action: Action): void;
  dismiss(): void;
  onChange(listener: () => void): void;
  close(): void;
}

/**
 * Rebuild the rule context from a view.
 *
 * The server sends no board graph and no scenario — only ids. Everything the renderer needs about
 * the *shape* of the board is derived here from `scenarioId`, which is the same trick `replay` uses
 * and the reason a game record is a few kilobytes rather than a few hundred.
 */
export function contextFor(view: PlayerView): RuleContext {
  const scenario = scenarioById(view.scenarioId);
  if (scenario === undefined) {
    throw new Error(`this client does not know the scenario ${view.scenarioId}`);
  }
  const rules = baseRules();
  if (view.ruleSetId !== rules.id) {
    throw new Error(`this client does not know the ruleset ${view.ruleSetId}`);
  }
  return { topology: buildTopology(scenario.cells), scenario, rules };
}

/** Shared listener plumbing. Both tables are event sources with exactly one event: "redraw". */
export class Observable {
  private readonly listeners: (() => void)[] = [];

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  protected changed(): void {
    for (const listener of this.listeners) listener();
  }
}

export interface LocalOptions {
  readonly seed: number;
  readonly players: number;
}

/**
 * Everyone at one keyboard.
 *
 * Holds the whole game, so it can hand the screen to whichever seat is being waited on — and
 * switching seats really does switch eyes, because each snapshot is redacted afresh. That makes
 * the hot-seat game a live test of the redaction the server depends on.
 */
export class LocalTable extends Observable implements Table {
  readonly ctx: RuleContext;
  readonly ready = true;

  private readonly game: NewGame;
  private readonly session: Session;
  /** One entry per accepted action, holding every seat's delivery. The log is rebuilt from it. */
  private readonly batches: (readonly Delivery[])[] = [];
  private message: string | null = null;

  constructor(options: LocalOptions) {
    super();
    this.game = newGame({
      scenario: scenarioForPlayers(options.players),
      rules: baseRules(),
      seed: options.seed,
      players: options.players,
    });
    this.session = new Session(this.game, { checkInvariants: true });
    this.ctx = this.game.ctx;
  }

  get viewpoints(): readonly (PlayerId | null)[] {
    return [...this.session.state.seatOrder, null];
  }

  get label(): string {
    return `Hot seat · seed ${this.session.state.seed}`;
  }

  get notice(): string | null {
    return this.message;
  }

  snapshot(viewer: PlayerId | null): Snapshot {
    const view = this.session.view(viewer);
    return {
      viewer,
      view,
      options: viewer === null ? [] : this.session.options(viewer),
      events: this.log(viewer),
      at: this.session.record.actions.length,
    };
  }

  act(viewer: PlayerId, action: Action): void {
    const result = this.session.act(viewer, action);
    if (!result.ok) {
      this.message = result.error.message;
    } else {
      this.batches.push(result.value);
      this.message = null;
    }
    this.changed();
  }

  dismiss(): void {
    this.message = null;
  }

  close(): void {
    // Nothing to close: the game lives and dies with the tab.
  }

  private log(viewer: PlayerId | null): readonly GameEvent[] {
    const out: GameEvent[] = [...redactEvents(this.game.events, viewer)];
    for (const batch of this.batches) {
      const delivery = batch.find((d) => d.viewer === viewer);
      if (delivery !== undefined) out.push(...delivery.events);
    }
    return out;
  }
}
