/**
 * Entry point: read the game out of the URL, mount it, and swap it when asked.
 *
 * The fragment is the whole of this client's routing and persistence:
 *
 * | | |
 * |---|---|
 * | `#seed=1234&players=4` | a hot-seat game, dealt in this tab |
 * | `#room=9jyb9g` | a room on the server |
 * | `#room=…&server=http://host:3000` | …on a server somewhere else |
 *
 * Both forms are worth having for the same reason: they are complete. A seed determines the island
 * exactly, so a hot-seat link is a board; a room id plus the seat token in `localStorage` is a
 * place at a table, so an online link is an invitation and a reload is a reconnect.
 */

import { App } from './app.js';
import { h, render, text } from './dom.js';
import type { NewGameRequest } from './panels.js';
import { createRoom, RemoteTable } from './remote.js';
import { LocalTable, type Table } from './table.js';

/** Core deals official boards for 3-6 players and generated ones up to 10. */
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const DEFAULT_PLAYERS = 4;

const root = document.getElementById('app');
if (root === null) throw new Error('main: the page has no #app element to mount into');

/** The table currently on screen, so a swap can close the old one and ignore its late events. */
let current: { table: Table; app: App } | null = null;

function params(): URLSearchParams {
  return new URLSearchParams(window.location.hash.replace(/^#/, ''));
}

function integer(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function mount(table: Table): void {
  current?.table.close();
  const app = new App(root as HTMLElement, table, { newGame: start });
  current = { table, app };
  // Guarded by identity: a table that has been swapped out must not redraw over its replacement.
  table.onChange(() => {
    if (current?.table === table) app.render();
  });
  app.render();
}

function splash(message: string, detail?: string): void {
  render(
    root as HTMLElement,
    h('div', {
      attrs: { class: 'splash' },
      children: [
        text('h1', 'title-name', 'Catan'),
        text('p', 'splash-message', message),
        ...(detail === undefined ? [] : [text('p', 'muted', detail)]),
      ],
    }),
  );
}

/** Open whatever the fragment describes. */
async function open(): Promise<void> {
  const query = params();
  const room = query.get('room');
  const origin = query.get('server') ?? undefined;

  if (room === null) {
    const seed = integer(query.get('seed'), Math.floor(Math.random() * 2 ** 31), 0, 2 ** 31);
    const players = integer(query.get('players'), DEFAULT_PLAYERS, MIN_PLAYERS, MAX_PLAYERS);
    if (window.location.hash === '') {
      // Writing the fragment re-enters through `hashchange`, so the game is dealt exactly once.
      window.location.hash = `seed=${seed}&players=${players}`;
      return;
    }
    mount(new LocalTable({ seed, players }));
    return;
  }

  splash(`Joining room ${room}…`);
  try {
    mount(await RemoteTable.connect({ room, ...(origin === undefined ? {} : { origin }) }));
  } catch (cause) {
    splash(
      `Could not join room ${room}.`,
      `${String(cause)} — check the server is running, then reload. ` +
        'Remove #room= from the address to play a hot-seat game instead.',
    );
  }
}

/**
 * Start a fresh game of the requested kind.
 *
 * Writes the fragment and lets `hashchange` do the mounting, so there is exactly one path from a
 * URL to a game on screen — and so the address bar is never describing something other than what
 * is being played.
 */
function start(request: NewGameRequest): void {
  const origin = params().get('server') ?? undefined;

  if (!request.online) {
    const seed = Math.floor(Math.random() * 2 ** 31);
    goTo(`seed=${seed}&players=${request.players}`);
    return;
  }

  splash('Asking the server for a room…');
  void createRoom({ players: request.players, ...(origin === undefined ? {} : { origin }) })
    .then((created) => {
      const suffix = origin === undefined ? '' : `&server=${encodeURIComponent(origin)}`;
      goTo(`room=${created.id}${suffix}`);
    })
    .catch((cause: unknown) => {
      splash('Could not create a room.', `${String(cause)} — is the server running?`);
    });
}

/** Navigate, reopening even when the fragment happens to be the one already showing. */
function goTo(fragment: string): void {
  if (window.location.hash === `#${fragment}`) {
    void open();
    return;
  }
  window.location.hash = fragment;
}

// A fragment typed by hand, or a link followed within the page, reopens whatever it names.
window.addEventListener('hashchange', () => {
  void open();
});

void open();
