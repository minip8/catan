/**
 * Persistence: the decisions, not the state.
 *
 * A room is saved as its `GameRecord` — seed, scenario id, ruleset id, seating, and every action
 * played. That is a few kilobytes of JSON for a whole game, and it survives changes to the shape of
 * `GameState` in a way a serialised snapshot would not. It is also the only representation that
 * cannot disagree with itself: a stored state and a stored log would eventually diverge, and then
 * the server would have two truths about the same game.
 *
 * Every save writes the record in full, which makes saving idempotent: a failed write costs
 * nothing but the moment, because the next successful one carries everything the failed one held.
 *
 * The interface is async because disks are. `MemoryStore` satisfies it synchronously and exists so
 * tests — and a server started with no data directory — never touch the filesystem at all.
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { GameRecord } from '@catan/core';

export interface RecordStore {
  save(id: string, record: GameRecord): Promise<void>;
  load(id: string): Promise<GameRecord | undefined>;
  list(): Promise<readonly string[]>;
}

/**
 * Room ids that are safe as filenames.
 *
 * Enforced in the store rather than only where ids are minted, because the store is what turns a
 * string into a path. An id arriving from an HTTP route is attacker-controlled, and `../../etc` is
 * the oldest trick there is.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class StoreError extends Error {}

export function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new StoreError(`unsafe room id ${JSON.stringify(id)}`);
}

export class MemoryStore implements RecordStore {
  private readonly records = new Map<string, GameRecord>();

  async save(id: string, record: GameRecord): Promise<void> {
    assertSafeId(id);
    this.records.set(id, record);
  }

  async load(id: string): Promise<GameRecord | undefined> {
    assertSafeId(id);
    return this.records.get(id);
  }

  async list(): Promise<readonly string[]> {
    return [...this.records.keys()].sort();
  }
}

/**
 * One JSON file per room.
 *
 * Written to a temporary name and renamed into place, because `rename` is atomic on every
 * filesystem this will run on: a server killed mid-write leaves the previous complete record
 * rather than a truncated one that no longer replays.
 */
export class FileStore implements RecordStore {
  private readonly dir: string;
  private ready: Promise<void> | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  async save(id: string, record: GameRecord): Promise<void> {
    assertSafeId(id);
    await this.ensure();
    const target = join(this.dir, `${id}.json`);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, JSON.stringify(record), 'utf8');
    await rename(temporary, target);
  }

  async load(id: string): Promise<GameRecord | undefined> {
    assertSafeId(id);
    let text: string;
    try {
      text = await readFile(join(this.dir, `${id}.json`), 'utf8');
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(text) as GameRecord;
    } catch (cause) {
      throw new StoreError(`room ${id} is on disk but is not JSON: ${String(cause)}`);
    }
  }

  async list(): Promise<readonly string[]> {
    await this.ensure();
    const entries = await readdir(this.dir);
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  }

  private ensure(): Promise<void> {
    // Created once, lazily, and remembered — so a busy server does not `mkdir` on every save.
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    return this.ready;
  }
}
