#!/usr/bin/env node

/**
 * The executable.
 *
 * Configuration is environment variables and nothing else — no config file, no flags — because the
 * server has four knobs and three of them have sensible defaults.
 *
 * | | |
 * |---|---|
 * | `PORT` | 3000 |
 * | `HOST` | 127.0.0.1 — bind explicitly to expose it |
 * | `DATA_DIR` | where game records are written. Unset means memory only |
 * | `SECRET` | signs seat tokens. Unset means a new one per boot, so seats do not survive restarts |
 * | `STATIC_DIR` | a built client to serve. Defaults to `packages/client/dist` when it is there |
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from './server.js';
import { FileStore, MemoryStore } from './store.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const dataDir = process.env.DATA_DIR;
const secret = process.env.SECRET;

if (secret === undefined) {
  console.warn(
    'SECRET is not set: seat tokens are signed with a key that dies with this process, ' +
      'so players will not be able to reclaim their seats after a restart.',
  );
}
if (dataDir === undefined) {
  console.warn('DATA_DIR is not set: games are held in memory and lost on exit.');
}

// The built client, if there is one. Serving it makes the deployment a single process, and makes
// the client's origin and the server's the same — which is the whole of its configuration.
const staticDir = process.env.STATIC_DIR ?? (await builtClient());

const server = await startServer({
  port,
  host,
  store: dataDir === undefined ? new MemoryStore() : new FileStore(dataDir),
  ...(secret === undefined ? {} : { secret }),
  ...(staticDir === undefined ? {} : { staticDir }),
});

if (staticDir === undefined) {
  console.warn('No client build found: serving the API only. Run `npm run build` for the UI.');
} else {
  console.log(`serving the client from ${staticDir}`);
}

/** `packages/client/dist`, relative to this file in `packages/server/dist`. */
async function builtClient(): Promise<string | undefined> {
  const guess = fileURLToPath(new URL('../../client/dist', import.meta.url));
  try {
    return (await stat(join(guess, 'index.html'))).isFile() ? guess : undefined;
  } catch {
    return undefined;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal}: closing`);
    // Records are written after every move, so there is nothing to flush — the game on disk is
    // already the game that was being played.
    void server.close().then(() => process.exit(0));
  });
}
