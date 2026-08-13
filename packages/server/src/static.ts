/**
 * Serving the built client.
 *
 * Optional, and off unless a directory is configured — but worth having, because without it a
 * deployment is two servers and a CORS story for what is really one application. With it,
 * `npm run build && DATA_DIR=… npm run serve` is the whole deployment, and the client talks to its
 * own origin.
 *
 * The only interesting part is refusing to serve anything outside the root. `resolve` collapses
 * `..` before the check, so a path is compared after normalisation rather than being scanned for
 * suspicious characters — the difference between checking what a path *is* and guessing what it
 * might mean.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve `pathname` from `root`.
 *
 * Returns false when there is nothing to serve, so the caller can fall through to its 404 — this
 * function never decides what a miss means.
 */
export async function serveStatic(
  root: string,
  pathname: string,
  response: ServerResponse,
): Promise<boolean> {
  const base = resolve(root);
  const wanted = resolve(join(base, decodeURIComponent(pathname)));
  // `resolve` has already collapsed any `..`, so this compares what the path *is*.
  if (wanted !== base && !wanted.startsWith(base + sep)) return false;

  const file = (await isFile(wanted)) ? wanted : await indexFor(wanted, base);
  if (file === undefined) return false;

  response.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    // The client is a hashed bundle behind an unhashed index.html; only the latter must not stick.
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
  });
  createReadStream(file).pipe(response);
  return true;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The page for a directory, or for a route the client owns.
 *
 * This client routes on the fragment, so the fallback is barely needed — but a link to
 * `/join/abc` should reach the app rather than a 404, and one line here is cheaper than a rule
 * about which paths are allowed to exist.
 */
async function indexFor(wanted: string, base: string): Promise<string | undefined> {
  const inDirectory = join(wanted, 'index.html');
  if (await isFile(inDirectory)) return inDirectory;
  if (extname(wanted) !== '') return undefined;
  const root = join(base, 'index.html');
  return (await isFile(root)) ? root : undefined;
}
