import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface OxigraphStandinFixture {
  directory: string;
  binaryPath: string;
  cleanup(): Promise<void>;
}

/** Real HTTP child with the small CLI surface the supervisor needs. */
export async function createOxigraphStandinFixture(): Promise<OxigraphStandinFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'oxi-server-real-'));
  const binaryPath = join(directory, 'oxigraph-standin.cjs');
  await writeFile(
    binaryPath,
    `#!/usr/bin/env node
const http = require('node:http');
const bindIdx = process.argv.indexOf('--bind');
const [host, port] = process.argv[bindIdx + 1].split(':');
const srv = http.createServer((req, res) => {
  if (req.url === '/pid') { res.statusCode = 200; res.end(String(process.pid)); return; }
  if (req.url === '/args') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(process.argv.slice(2)));
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/sparql-results+json');
  res.end(JSON.stringify({ head: {}, boolean: true }));
});
srv.on('error', (error) => {
  console.error('bind failed: ' + error.message);
  process.exit(1);
});
srv.listen(Number(port), host);
process.on('SIGTERM', () => {
  srv.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 100).unref();
});
`,
    'utf8',
  );
  await chmod(binaryPath, 0o755);
  return {
    directory,
    binaryPath,
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** A real port that is free at allocation time. */
export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      server.close(() => resolve(address.port));
    });
  });
}

export async function fetchPid(port: number): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/pid`);
  return Number(await response.text());
}

export async function portAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/query`, {
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(25);
  }
  return false;
}
