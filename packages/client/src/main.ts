/**
 * Entry point: read the board out of the URL, mount the app.
 *
 * `#seed=1234&players=4` is the whole of the client's persistence. It is worth having because the
 * engine earns it — a seed and a player count determine the island exactly — so a board is a link,
 * and "the desert was in the middle again" is a reproducible complaint.
 */

import { App, type GameOptions } from './app.js';

/** Core deals official boards for 3-6 players and generated ones up to 10. */
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const DEFAULT_PLAYERS = 4;

function optionsFromUrl(): GameOptions {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const seed = Number.parseInt(params.get('seed') ?? '', 10);
  const players = Number.parseInt(params.get('players') ?? '', 10);
  return {
    seed: Number.isSafeInteger(seed) ? seed : Math.floor(Math.random() * 2 ** 31),
    players:
      Number.isSafeInteger(players) && players >= MIN_PLAYERS && players <= MAX_PLAYERS
        ? players
        : DEFAULT_PLAYERS,
  };
}

const root = document.getElementById('app');
if (root === null) throw new Error('main: the page has no #app element to mount into');

const options = optionsFromUrl();
if (window.location.hash === '') {
  window.location.hash = `seed=${options.seed}&players=${options.players}`;
}

const app = new App(root, options);
app.render();
