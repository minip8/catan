/**
 * The application: one table, one screen, one seat at a time.
 *
 * The app does not know whether it is playing a game in this tab or a game on a server. It reads a
 * `Snapshot` — a redacted view, the options that go with it, the log — and sends moves back through
 * `Table.act`. Both implementations of that interface produce the same three things, because the
 * engine's `Session` produces them per viewer and the server forwards them unchanged.
 *
 * What the app never does is decide anything about the rules. Every clickable thing on screen is an
 * `Action` the engine offered, sent back unchanged; a refusal is displayed rather than pre-empted.
 * That is what makes the same screen correct in both modes: there is no local rule to disagree with
 * the server about.
 *
 * Dialog lifetime follows the offer rather than the click. A composer stays open while the engine
 * is still offering that composition and closes when it stops — which is right whether it closed
 * because you finished, or because someone else's move made it moot.
 */

import type { Action, PlayerId, PlayerView } from '@catan/core';

import { boardSvg } from './board.js';
import { h, render } from './dom.js';
import { narrate } from './narrate.js';
import {
  actionsPanel,
  bankPanel,
  type Draft,
  gameMenu,
  type Handlers,
  handPanel,
  logPanel,
  type NewGameRequest,
  playersPanel,
  statusPill,
  turnBox,
  type Ui,
  type Watching,
  youPanel,
} from './panels.js';
import { boardScene } from './scene.js';
import type { Table } from './table.js';
import { affordances, type Placement, visibleTargets } from './targets.js';
import {
  attachZoom,
  boxString,
  MAX_SCALE,
  MIN_SCALE,
  parseBox,
  viewOf,
  WHOLE,
  type Zoom,
  zoomAt,
} from './zoom.js';

export interface AppHandlers {
  readonly newGame: (request: NewGameRequest) => void;
}

export class App {
  private readonly root: HTMLElement;
  private readonly table: Table;
  private readonly on: AppHandlers;

  private watching: Watching = { mode: 'auto' };
  private group: string | null = null;
  private draft: Draft | null = null;
  /** A locus offering more than one action — the robber's choice of victim. */
  private choice: readonly Placement[] | null = null;
  /** The last action count rendered, so a move that lands can close what it was aimed at. */
  private at = -1;
  /** How far into the board we are looking. Kept here because the board is rebuilt every render. */
  private zoom: Zoom = WHOLE;
  /** Whether the ⚙ game menu is open. */
  private settings = false;
  /** A kind of spot the pointer is resting on the tile for: shown until it moves off. */
  private preview: string | null = null;
  /** A development card in hand whose ways of being played are on show. */
  private dev: string | null = null;

  constructor(root: HTMLElement, table: Table, on: AppHandlers) {
    this.root = root;
    this.table = table;
    this.on = on;

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      this.choice = null;
      this.draft = null;
      this.group = null;
      this.settings = false;
      this.dev = null;
      this.table.dismiss();
      this.render();
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────────────────────────────

  render(): void {
    const seat = this.resolveSeat();
    const snap = this.table.snapshot(seat);
    const actors = actorsOf(snap.view);
    const affs = affordances(this.table.ctx, snap.options);

    if (snap.at !== this.at) {
      this.at = snap.at;
      // A spot's menu is about a moment. Once the game has moved on, so has the moment.
      this.choice = null;
      this.dev = null;
    }
    // A selected group and an open composer are UI state about an *offer*. Keep them only while
    // the engine is still making it.
    if (this.group !== null && !affs.groups.some((g) => g.key === this.group)) this.group = null;
    if (this.draft !== null && !affs.groups.some((g) => g.key === this.draft?.group)) {
      this.draft = null;
    }

    const ui: Ui = {
      ctx: this.table.ctx,
      view: snap.view,
      seat: snap.viewer,
      actors,
      affordances: affs,
      group: this.group,
      draft: this.draft,
      choice: this.choice,
      settings: this.settings,
      preview: this.preview,
      dev: this.dev,
      lines: snap.events.map((event) => narrate(snap.view, event)),
      notice: this.table.notice,
      watching: this.watching,
      viewpoints: this.table.viewpoints,
      label: this.table.label,
      ready: this.table.ready,
    };
    const on = this.handlers();
    // A tile being hovered previews its spots; a clicked one keeps them.
    if (this.preview !== null && !affs.groups.some((g) => g.key === this.preview)) {
      this.preview = null;
    }
    const scene = boardScene(
      this.table.ctx,
      snap.view,
      visibleTargets(affs, this.group ?? this.preview),
    );
    const svg = this.board(scene, (locus) => this.onTarget(ui, locus));

    // One screen, laid out like an online table: the board fills the play area, with the
    // controls floating over it — the ⚙ rail top left, the hand along the bottom, the action bar
    // bottom right — and the log, bank and scoreboard in a column down the right.
    render(
      this.root,
      h('main', {
        attrs: { class: 'table' },
        children: [
          this.surface(svg, scene.viewBox, [
            h('div', { attrs: { class: 'board-wrap' }, children: [svg] }),
            this.rail(scene.viewBox, ui, on),
            // The dock comes first in the DOM, so the action bar is the first panel; CSS puts
            // the hand on its left.
            h('div', {
              attrs: { class: 'hud' },
              children: [
                h('div', {
                  attrs: { class: 'turn-dock' },
                  children: [turnBox(ui, on), statusPill(ui), actionsPanel(ui, on)],
                }),
                handPanel(ui, on),
              ],
            }),
          ]),
          h('aside', {
            attrs: { class: 'side' },
            children: [logPanel(ui), bankPanel(ui), playersPanel(ui), youPanel(ui)],
          }),
        ],
      }),
    );
  }

  // ── Board and zoom ────────────────────────────────────────────────────────────────────────

  private board(
    scene: ReturnType<typeof boardScene>,
    onTarget: (locus: string) => void,
  ): SVGSVGElement {
    const svg = boardSvg(scene, { onTarget }) as SVGSVGElement;
    svg.setAttribute('viewBox', boxString(viewOf(parseBox(scene.viewBox), this.zoom)));
    return svg;
  }

  /**
   * The play area, which is also what the zoom gestures listen on: the board draws past its own
   * box once dragged, and a pinch over open water must zoom the board, not the page.
   */
  private surface(svg: SVGSVGElement, viewBox: string, children: readonly Node[]): HTMLElement {
    const play = h('div', { attrs: { class: 'play' }, children });
    // Gestures only remember the zoom: they move the live SVG themselves, and re-rendering on
    // every wheel tick would rebuild the board for nothing.
    attachZoom(svg, play, parseBox(viewBox), this.zoom, (zoom) => {
      this.zoom = zoom;
    });
    return play;
  }

  /** The round buttons top left: the game menu and zoom. */
  private rail(viewBox: string, ui: Ui, on: Handlers): HTMLElement {
    const base = parseBox(viewBox);
    const step = (factor: number): void => {
      const view = viewOf(base, this.zoom);
      this.zoom = zoomAt(
        base,
        this.zoom,
        factor,
        view.x + view.width / 2,
        view.y + view.height / 2,
      );
      this.render();
    };
    const control = (label: string, title: string, disabled: boolean, click: () => void) =>
      h('button', {
        attrs: { class: 'zoom-btn', type: 'button', title, 'aria-label': title, disabled },
        on: { click },
        children: [label],
      });
    return h('div', {
      attrs: { class: 'rail' },
      children: [
        h('button', {
          attrs: {
            class: `zoom-btn rail-settings${ui.settings ? ' zoom-on' : ''}`,
            type: 'button',
            title: 'Game',
            'aria-label': 'Game',
            'aria-expanded': ui.settings ? 'true' : 'false',
            'aria-controls': 'game-menu',
          },
          on: { click: () => on.toggleSettings() },
          children: ['⚙'],
        }),
        gameMenu(ui, on),
        control('+', 'Zoom in', this.zoom.scale >= MAX_SCALE, () => step(1.5)),
        control('−', 'Zoom out', this.zoom.scale <= MIN_SCALE, () => step(1 / 1.5)),
        control('⤢', 'Show the whole board', this.zoom === WHOLE, () => {
          this.zoom = WHOLE;
          this.render();
        }),
      ],
    });
  }

  private handlers(): Handlers {
    return {
      act: (action) => {
        // Any other move — a bank trade picked in the tray, a build from the menu — ends the
        // composition. Only submitting it keeps it, so a refused offer can be fixed and resent.
        this.draft = null;
        this.send(action);
      },
      selectGroup: (group) => {
        this.group = group;
        this.preview = null;
        this.choice = null;
        this.render();
      },
      pickDev: (card) => {
        this.dev = card;
        this.draft = null;
        this.render();
      },
      preview: (group) => {
        // Hovering re-renders the tile under the pointer, which enters it again; only a change
        // is worth a render.
        if (this.preview === group) return;
        this.preview = group;
        this.render();
      },
      toggleSettings: () => {
        this.settings = !this.settings;
        this.render();
      },
      watch: (watching) => {
        this.watching = watching;
        this.group = null;
        this.choice = null;
        this.draft = null;
        this.render();
      },
      compose: (group, seed) => {
        this.draft = draftFor(group, seed);
        this.dev = null;
        this.table.dismiss();
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
        this.table.dismiss();
        this.render();
      },
      chooseNothing: () => {
        this.choice = null;
        this.render();
      },
      newGame: (request) => this.on.newGame(request),
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
   * Play an action.
   *
   * `act` returns nothing: locally the table has already applied the move by the time it fires its
   * change, and remotely the answer is a frame that has not arrived yet. Either way the screen is
   * redrawn from whatever the table says next, which is the only version of the game that matters.
   */
  private send(action: Action): void {
    const seat = this.resolveSeat();
    if (seat === null) {
      this.render();
      return;
    }
    this.table.act(seat, action);
    this.render();
  }

  // ── Seat ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Whose eyes to use.
   *
   * Constrained to what the table can actually show. A remote client has one viewpoint — its own
   * seat — so every mode collapses onto it, and the seat switcher in the header disappears.
   */
  private resolveSeat(): PlayerId | null {
    const viewpoints = this.table.viewpoints;
    const fallback = viewpoints[0] ?? null;
    const offers = (seat: PlayerId | null): boolean => viewpoints.includes(seat);

    switch (this.watching.mode) {
      case 'seat':
        return offers(this.watching.seat) ? this.watching.seat : fallback;
      case 'spectate':
        return offers(null) ? null : fallback;
      default: {
        if (viewpoints.length <= 1) return fallback;
        // Hot seat: hand the screen to whoever the game is waiting on. With a discard step that is
        // a list, so the first player who owes cards goes first and the rest follow as each
        // finishes — the step shrinks its own actor list.
        const actors = actorsOf(this.table.snapshot(fallback).view);
        return actors.find(offers) ?? fallback;
      }
    }
  }
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
function draftFor(
  group: { key: string; type: string; choices: readonly Action[] },
  seed?: string,
): Draft {
  const suggestion = group.choices[0];
  const cards = asBundle(suggestion?.cards);
  const required = suggestion === undefined ? null : sum(cards);
  const discarding = group.type === 'discard';
  // A card clicked in hand is the start of the draft. Without one, a discard starts from the
  // engine's suggestion, so the common case is still one click.
  const give = seed !== undefined ? { [seed]: 1 } : discarding ? cards : {};
  return {
    group: group.key,
    type: group.type,
    give,
    want: {},
    required: discarding ? required : null,
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
