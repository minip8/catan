/**
 * `@catan/server` — rooms, sockets, and the action log on disk.
 *
 * ```ts
 * const server = await startServer({ port: 3000, store: new FileStore('./games') });
 * ```
 *
 * Everything below `startServer` is exported too, because the interesting parts are usable without
 * a socket: `Room` plays a whole game from tokens and actions, and `Rooms.restore` rebuilds one
 * from its record. Tests, bots and maintenance scripts should reach for those directly.
 */

export * from './protocol.js';
export * from './room.js';
export * from './rooms.js';
export * from './server.js';
export * from './store.js';
export * from './tokens.js';
