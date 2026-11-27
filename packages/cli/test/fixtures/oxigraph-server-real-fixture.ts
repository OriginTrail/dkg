import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface OxigraphStandinFixture {
  directory: string;
  binaryPath: string;
  cleanup(): Promise<void>;
}

/**
 * Real HTTP child with the small CLI surface the supervisor needs. With
 * `holdStoreLock`, it also keeps `<location>/LOCK` open for its lifetime, as
 * RocksDB does, so the daemon finds it as a lock holder. It does not take
 * RocksDB's advisory lock: a second stand-in on the same store fails on the
 * port, not on the lock, so tests assert the holder is gone and the port is
 * free rather than that a lock was acquired.
 */
export async function createOxigraphStandinFixture(
  opts: { holdStoreLock?: boolean } = {},
): Promise<OxigraphStandinFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'oxi-server-real-'));
  const binaryPath = join(directory, 'oxigraph-standin.cjs');
  const holdStoreLock = opts.holdStoreLock
    ? `const storeDir = process.argv[process.argv.indexOf('--location') + 1];\n`
      // Like RocksDB: create a missing store directory, then keep LOCK open.
      + `require('node:fs').mkdirSync(storeDir, { recursive: true });\n`
      + `require('node:fs').openSync(require('node:path').join(storeDir, 'LOCK'), 'a');\n`
    : '';
  await writeFile(
    binaryPath,
    `#!/usr/bin/env node
${holdStoreLock}const http = require('node:http');
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

/** Start `command args` whose parent exits at once, so init adopts it. */
export async function spawnOrphan(command: string, args: readonly string[]): Promise<number> {
  const launcher = spawn(process.execPath, [
    '-e',
    `const child = require('node:child_process').spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'ignore' });
     child.unref();
     console.log(child.pid);`,
    command,
    ...args,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  const launcherExited = once(launcher, 'exit');
  const [chunk] = await once(launcher.stdout!, 'data');
  await launcherExited;
  return Number(String(chunk).trim());
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
