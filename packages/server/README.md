# @catan/server

Rooms, websockets, and the action log on disk. One runtime dependency: `ws`.

```
npm run build && npm run serve                  # from the repo root: the UI and the API on :3000
DATA_DIR=./games SECRET=$(openssl rand -hex 32) npm run serve
```

```
POST /rooms            {players, seed?}  → {id, players, seed, scenarioId}
GET  /rooms                              → live rooms, and every room on disk
GET  /rooms/:id/record                   → the whole game, as decisions
GET  /health
ws://…/ws?room=ID                        → play
GET  /*                                  → the built client, if there is one
```

The last route is why the deployment is one process. `STATIC_DIR` points at a built client, and
defaults to `packages/client/dist` when that exists, so the browser talks to its own origin and
there is no CORS story to get wrong. The API is matched first: a bundle cannot shadow a route the
game needs.

## What is stored

**The decisions, not the state.** A saved game is its `GameRecord` — seed, scenario id, ruleset id,
seating, and every action played. A three-player game two moves in is 258 bytes:

```json
{"seed":11,"scenarioId":"catan/base/3-4","ruleSetId":"catan/base","seatOrder":["p0","p1","p2"],
 "actions":[{"actor":"p0","action":{"type":"place","kind":"settlement","at":"0,0|1,-1|1,0"}}, …]}
```

No board, no dice, no shuffles — those all come back out of the seed. A restarting server replays
the log into a fresh `Session`, which is also why `GET /rooms/:id/record` is worth having: a bug
report is a few kilobytes, and it rebuilds exactly the game the player was looking at.

Every save writes the record in full, so saving is idempotent and a failed write costs nothing but
the moment. If a save does fail the move still stands — the engine applied it and everyone has been
told — and the client is told the record is behind rather than being lied to or rolled back.

## Who you are

A seat token is `HMAC(secret, "room:seat")`. That buys one specific thing: **a token survives a
restart without being stored anywhere.** The room comes back by replaying its log, the players'
credentials come back by recomputation, and the file on disk stays pure game data with no secrets
in it. Set `SECRET` in production or every restart invalidates every seat.

No client message names a seat. There is no `seat` field to forge — a connection is whoever its
token says it is, and the token was minted here. Spectator tokens are random instead of derived,
because a spectator has nothing to prove.

## What goes out

`session.act` already returns one `Delivery` per seat plus one for spectators, each redacted for its
viewer. The room turns those into messages and the transport matches each socket's viewer to one of
them. **There is no path through `server.ts` that can build a message for one viewer and send it to
another, because it never builds one** — it only routes. The `rng` is `null` in every frame that
leaves the process, and that is asserted in the tests rather than assumed.

A socket that has not joined is sent nothing at all, not even the public view.

## Layout

| | |
|---|---|
| `protocol.ts` | the three client messages and three server messages, and a parser that never throws |
| `room.ts` | one game, its seats, and who holds them. No sockets, no I/O |
| `rooms.ts` | the registry: create, find, and rebuild from the log |
| `store.ts` | `RecordStore`, in memory or one atomic JSON file per room |
| `tokens.ts` | derived seat credentials, compared in constant time |
| `server.ts` | HTTP and websockets — the only file that knows a socket exists |
| `static.ts` | the built client, served from one directory and never from outside it |

The split is the same one that makes the engine testable: every decision worth arguing about lives
in `room.ts`, which is a function from tokens and actions to messages, and the transport is a shell
around it.

## Testing

```
npm test
```

`room`, `rooms`, `store` and `protocol` are tested without a port. `server.test.ts` starts a real
server on an ephemeral one and talks to it over real websockets: two clients play the opening, a
dropped client reclaims its seat with its token, a forged token is refused, a malformed frame gets
an error without dropping the connection, and the record served over HTTP is replayed and compared
against the game the server is holding.

The recovery path is exercised, not merely available — `rooms.test.ts` plays a game, throws away
every object involved, rebuilds from the store alone, and carries on playing with the same token.
