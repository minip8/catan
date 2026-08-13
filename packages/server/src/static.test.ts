/**
 * Serving the client, and refusing to serve anything else.
 *
 * The traversal cases are the point. Everything else here is a content type.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from './server.js';

const temporary: string[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function siteWithServer(): Promise<RunningServer> {
  const dir = await mkdtemp(join(tmpdir(), 'catan-static-'));
  temporary.push(dir);
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>Catan</title>', 'utf8');
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'app.js'), 'export const x = 1;\n', 'utf8');

  const secrets = await mkdtemp(join(tmpdir(), 'catan-secrets-'));
  temporary.push(secrets);
  await writeFile(join(secrets, 'passwd'), 'root:x:0:0', 'utf8');

  const server = await startServer({ staticDir: dir, secret: 'test', log: () => {} });
  servers.push(server);
  return server;
}

describe('serving a built client', () => {
  it('serves the page and its assets with the right types', async () => {
    const server = await siteWithServer();

    const page = await fetch(`${server.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toContain('Catan');

    const script = await fetch(`${server.url}/assets/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('lets the API win, so a bundle cannot shadow the game', async () => {
    const server = await siteWithServer();
    const health = await fetch(`${server.url}/health`);
    expect(await health.json()).toEqual({ ok: true });
  });

  it('serves the page for a route the client owns, but not for a missing file', async () => {
    const server = await siteWithServer();
    expect((await fetch(`${server.url}/join/abc`)).status).toBe(200);
    expect((await fetch(`${server.url}/assets/missing.js`)).status).toBe(404);
  });

  it('refuses to climb out of the directory it was given', async () => {
    const server = await siteWithServer();
    for (const path of [
      '/../passwd',
      '/assets/../../passwd',
      '/%2e%2e/passwd',
      '/../../etc/hosts',
    ]) {
      const response = await fetch(`${server.url}${path}`);
      const body = await response.text();
      expect(body).not.toContain('root:x:0:0');
    }
  });
});
