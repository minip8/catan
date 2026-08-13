/**
 * The application: one `Session`, one screen, one seat at a time.
 *
 * This is a hot-seat client — everyone plays in the same tab — but it is deliberately built the
 * way a networked client would be. It holds a `Session` and never reaches past it: the board, the
 * scoreboard and the log are all rendered from `session.view(seat)`, the buttons come from
 * `session.options(seat)`, and every move goes through `session.act`, whose refusal is displayed
 * rather than pre-empted. Swapping the local session for a websocket is then a matter of replacing
 * three method calls, not of unpicking rules from the UI.
 *
 * Switching seats really does switch eyes. The hand, the log and even the scoreboard are rebuilt
 * from that seat's redacted view, so a development card you cannot see is a card this client does
 * not have — which makes the hot-seat game a live test of the redaction the server will depend on.
 *
 * The seed is kept in the URL. A board is then a link, which is the cheapest possible use of the
 * engine's determinism: paste the fragment and you are looking at the same island.
 */

import {
  type Action,
  baseRules,
  type Delivery,
  type GameEvent,
  type NewGame,
  newGame,
  type PlayerId,
  type PlayerView,
  type RuleContext,
  redactEvents,
  Session,
  scenarioForPlayers,
} from '@catan/core';

import { boardSvg } from './board.js';
import { h, render } from './dom.js';
import { type Line, narrate } from './narrate.js';
import {
  actionsPanel,
  bankPanel,
  type Draft,
  type Handlers,
  handPanel,
  headerPanel,
  logPanel,
  playersPanel,
  type Ui,
  type Watching,
} from './panels.js';
import { boardScene } from './scene.js';
import { affordances, type Placement, visibleTargets } from './targets.js';

export interface GameOptions {
  readonly seed: number;
  readonly players: number;
}

export class App {
  private readonly root: HTMLElement;
  private options: GameOptions;
  private game: NewGame;
  private session: Session;

  private watching: Watching = { mode: 'auto' };
  private group: string | null = null;
  private draft: Draft | null = null;
  /** A locus offering more than one action — the robber's choice of victim. */
  private choice: readonly Placement[] | null = null;
  private notice: string | null = null;
  /** One entry per accepted action, holding every seat's delivery. The log is rebuilt from it. */
  private batches: (readonly Delivery[])[] = [];

  constructor(root: HTMLElement, options: GameOptions) {
    this.root = root;
    this.options = options;
    this.game = deal(options);
    this.session = new Session(this.game, { checkInvariants: true });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      this.choice = null;
      this.draft = null;
      this.group = null;
      this.notice = null;
      this.render();
    });
  }

  get ctx(): RuleContext {
    return this.game.ctx;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────────────────────

  render(): void {
    const table = this.session.view(null);
    const actors = actorsOf(table);
    const seat = this.resolveSeat(actors);
    const view = this.session.view(seat);

    const offered = seat === null ? [] : this.session.options(seat);
    const affs = affordances(this.ctx, offered);
    // A selected group is a UI preference, and the specs are regenerated from scratch after every
    // action. Keep the selection only while the engine is still offering that group.
    if (this.group !== null && !affs.groups.some((g) => g.key === this.group)) this.group = null;

    const ui: Ui = {
      ctx: this.ctx,
      view,
      seat,
      actors,
      affordances: affs,
      group: this.group,
      draft: this.draft,
      choice: this.choice,
      lines: this.lines(seat, view),
      notice: this.notice,
      watching: this.watching,
    };
    const on = this.handlers();
    const scene = boardScene(this.ctx, view, visibleTargets(affs, this.group));

    render(
      this.root,
      headerPanel(ui, on),
      h('main', {
        attrs: { class: 'layout' },
        children: [
          h('div', {
            attrs: { class: 'board-wrap' },
            children: [
              boardSvg(scene, {
                onTarget: (locus) => this.onTarget(ui, locus),
              }),
            ],
          }),
          h('div', {
            attrs: { class: 'side' },
            children: [
              actionsPanel(ui, on),
              handPanel(ui),
              playersPanel(ui),
              bankPanel(ui),
              logPanel(ui),
            ],
          }),
        ],
      }),
    );
  }

  private handlers(): Handlers {
    return {
      act: (action) => this.send(action),
      selectGroup: (group) => {
        this.group = group;
        this.choice = null;
        this.render();
      },
      watch: (watching) => {
        this.watching = watching;
        this.group = null;
        this.choice = null;
        this.draft = null;
        this.render();
      },
      compose: (group) => {
        this.draft = draftFor(group);
        this.notice = null;
        this.render();
      },
      editDraft: (draft) => {
        this.draft = draft;
        this.render();
      },
      submitDraft: () => {
        if (this.draft !== null) this.send(actionFor(this.draft));
      },
      cancelDraft: () => {
        this.draft = null;
        this.notice = null;
        this.render();
      },
      chooseNothing: () => {
        this.choice = null;
        this.render();
      },
      newGame: (players) => this.restart(players),
    };
  }

  // ── Acting ────────────────────────────────────────────────────────────────────────────────

  private onTarget(ui: Ui, locus: string): void {
    const target = visibleTargets(ui.affordances, ui.group).find((t) => t.locus === locus);
    if (target === undefined) return;
    const only = target.options.length === 1 ? target.options[0] : undefined;
    if (only !== undefined) {
      this.send(only.action);
      return;
    }
    this.choice = target.options;
    this.render();
  }

  /**
   * Play an action, or show why not.
   *
   * The refusal path is not an afterthought. The client offers only what `legalActions` offered,
   * so a violation here means the two disagreed — a bug worth seeing rather than swallowing —
   * apart from the composed actions, where being told "you do not hold those cards" *is* the
   * interface.
   */
  private send(action: Action): void {
    const seat = this.resolveSeat(actorsOf(this.session.view(null)));
    if (seat === null) {
      this.notice = 'Pick a seat before acting.';
      this.render();
      return;
    }

    const result = this.session.act(seat, action);
    if (!result.ok) {
      this.notice = result.error.message;
      this.render();
      return;
    }

    this.batches.push(result.value);
    this.notice = null;
    this.choice = null;
    this.draft = null;
    this.render();
  }

  private restart(players: number): void {
    const seed = Math.floor(Math.random() * 2 ** 31);
    this.options = { seed, players };
    window.location.hash = `seed=${seed}&players=${players}`;
    this.game = deal(this.options);
    this.session = new Session(this.game, { checkInvariants: true });
    this.batches = [];
    this.watching = { mode: 'auto' };
    this.group = null;
    this.draft = null;
    this.choice = null;
    this.notice = null;
    this.render();
  }

  // ── Seat and log ──────────────────────────────────────────────────────────────────────────

  private resolveSeat(actors: readonly PlayerId[]): PlayerId | null {
    switch (this.watching.mode) {
      case 'seat':
        return this.watching.seat;
      case 'spectate':
        return null;
      default:
        // Hot seat: hand the screen to whoever the engine is waiting on. With a discard step that
        // is a list, so the first player who owes cards goes first and the rest follow as each
        // finishes — the step shrinks its own actor list.
        return actors[0] ?? null;
    }
  }

  /** The log as this seat saw it: the opening deal, then one delivery per accepted action. */
  private lines(seat: PlayerId | null, view: PlayerView): readonly Line[] {
    const out: Line[] = [];
    for (const event of redactEvents(this.game.events, seat)) out.push(narrate(view, event));
    for (const batch of this.batches) {
      const delivery = batch.find((d) => d.viewer === seat);
      for (const event of delivery?.events ?? emptyEvents) out.push(narrate(view, event));
    }
    return out;
  }
}

const emptyEvents: readonly GameEvent[] = [];

// ── Game setup ──────────────────────────────────────────────────────────────────────────────

function deal(options: GameOptions): NewGame {
  return newGame({
    scenario: scenarioForPlayers(options.players),
    rules: baseRules(),
    seed: options.seed,
    players: options.players,
  });
}

function actorsOf(view: PlayerView): readonly PlayerId[] {
  const step = view.stack.at(-1);
  if (step === undefined || step.actor === 'system') return [];
  const actor = step.actor;
  return Array.isArray(actor) ? (actor as readonly PlayerId[]) : [actor as PlayerId];
}

// ── Composed actions ────────────────────────────────────────────────────────────────────────

/**
 * Start a draft for a spec the engine could not enumerate.
 *
 * This is the one place the client must know an action's *fields* rather than just passing back
 * what it was given, because there is nothing to pass back: `offerTrade` arrives with no options
 * at all. The suggestion attached to a discard is used as the starting point, so the common case
 * is one click.
 */
function draftFor(group: { key: string; type: string; choices: readonly Action[] }): Draft {
  const suggestion = group.choices[0];
  const cards = asBundle(suggestion?.cards);
  const required = suggestion === undefined ? null : sum(cards);
  return {
    group: group.key,
    type: group.type,
    give: group.type === 'discard' ? cards : {},
    want: {},
    required: group.type === 'discard' ? required : null,
  };
}

function actionFor(draft: Draft): Action {
  if (draft.type === 'discard') return { type: 'discard', cards: draft.give };
  return { type: draft.type, give: draft.give, want: draft.want };
}

function asBundle(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [kind, n] of Object.entries(value as Record<string, unknown>)) {
    if (typeof n === 'number' && n > 0) out[kind] = n;
  }
  return out;
}

function sum(bundle: Readonly<Record<string, number>>): number {
  return Object.values(bundle).reduce((a, b) => a + b, 0);
}
