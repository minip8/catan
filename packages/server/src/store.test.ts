import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newRecord } from '@catan/core';
import { afterEach, describe, expect, it } from 'vitest';

import { makeRoom } from './fixture.testkit.js';
import { FileStore, MemoryStore, type RecordStore, StoreError } from './store.js';

const temporary: string[] = [];

afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'catan-store-'));
  temporary.push(dir);
  return dir;
}

function sampleRecord() {
  return newRecord(makeRoom().session.state, [{ actor: 'p0' as never, action: { type: 'roll' } }]);
}

describe.each<[string, () => Promise<RecordStore>]>([
  ['MemoryStore', async () => new MemoryStore()],
  ['FileStore', async () => new FileStore(await tempDir())],
])('%s', (_name, make) => {
  it('round-trips a record', async () => {
    const store = await make();
    const record = sampleRecord();

    expect(await store.load('r1')).toBeUndefined();
    await store.save('r1', record);
    expect(await store.load('r1')).toEqual(record);
    expect(await store.list()).toEqual(['r1']);
  });

  it('overwrites in place, because every save is the whole log', async () => {
    const store = await make();
    await store.save('r1', sampleRecord());
    const longer = { ...sampleRecord(), actions: [] };
    await store.save('r1', longer);

    expect(await store.load('r1')).toEqual(longer);
    expect(await store.list()).toEqual(['r1']);
  });

  it('refuses an id that would escape the store', async () => {
    const store = await make();
    for (const id of ['../escape', 'a/b', '', '.', 'x'.repeat(100), 'has space']) {
      await expect(store.save(id, sampleRecord())).rejects.toBeInstanceOf(StoreError);
      await expect(store.load(id)).rejects.toBeInstanceOf(StoreError);
    }
  });
});

describe('FileStore', () => {
  it('leaves no temporary files behind', async () => {
    const dir = await tempDir();
    const store = new FileStore(dir);
    await store.save('r1', sampleRecord());
    await store.save('r1', sampleRecord());

    // The write goes to a temporary name and is renamed into place, so a server killed mid-write
    // leaves the previous complete record rather than a truncated one.
    expect(await readdir(dir)).toEqual(['r1.json']);
  });

  it('reports a corrupt file rather than returning nonsense', async () => {
    const dir = await tempDir();
    const store = new FileStore(dir);
    await store.save('r1', sampleRecord());
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'r1.json'), 'not json', 'utf8');

    await expect(store.load('r1')).rejects.toBeInstanceOf(StoreError);
  });
});
