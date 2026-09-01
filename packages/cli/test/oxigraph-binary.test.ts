/**
 * Oxigraph binary download / cache / PATH-fallback — REAL I/O, NO mocks.
 *
 * The retired version faked BOTH the download (a fetch stub returning byte
 * fixtures) and the filesystem (an in-memory files map with chmod/rename
 * recorders). This version runs `resolveOxigraphBinary` against:
 *   - a REAL local `node:http` server that serves the asset bytes (its
 *     request counter is real observation — a cache hit means the real
 *     server saw zero requests), returns tampered bytes for the checksum
 *     case, and a real 404 for the HTTP-error case;
 *   - a REAL tmpdir cache: writes, the 0o755 chmod, and the atomic
 *     temp-then-rename are all real fs operations asserted via real stat;
 *   - REAL PATH directories containing real (non-)executable files for the
 *     fallback scan, with `process.env.PATH` save/restored.
 *
 * The two musl cases parameterize the HOST ENVIRONMENT: musl detection
 * probes `/lib/ld-musl-*.so.1`, which cannot exist on a macOS/glibc CI
 * host, so a plain hand-written `stat` delegates to the REAL fs.stat
 * for every path except the musl loader marker. That is input
 * parameterization (like passing `platform: 'linux'`), not a behaviour
 * double — everything downstream of detection runs for real.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveOxigraphBinary,
  resolveOxigraphAsset,
  OXIGRAPH_ASSETS,
  OXIGRAPH_VERSION,
  type ResolvedOxigraphAsset,
} from '../src/daemon/oxigraph-binary.js';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('resolveOxigraphAsset', () => {
  it('maps platform/arch to the pinned release asset', () => {
    expect(resolveOxigraphAsset('darwin', 'arm64')).toMatchObject({
      fileName: `oxigraph-v${OXIGRAPH_VERSION}`,
    });
    expect(resolveOxigraphAsset('linux', 'x64').asset).toBe(
      `oxigraph_v${OXIGRAPH_VERSION}_x86_64_linux_gnu`,
    );
    const win = resolveOxigraphAsset('win32', 'x64');
    expect(win.asset.endsWith('.exe')).toBe(true);
    expect(win.fileName).toBe(`oxigraph-v${OXIGRAPH_VERSION}.exe`);
    expect(win.url).toContain(`/v${OXIGRAPH_VERSION}/`);
  });

  it('carries the pinned checksum from the asset table', () => {
    const r = resolveOxigraphAsset('linux', 'arm64');
    expect(r.sha256).toBe(OXIGRAPH_ASSETS['linux-arm64'].sha256);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws an actionable error for unsupported hosts', () => {
    expect(() => resolveOxigraphAsset('freebsd' as NodeJS.Platform, 'x64')).toThrow(
      /No prebuilt Oxigraph .* for freebsd-x64/,
    );
  });
});

// ── Real download server ─────────────────────────────────────────────
const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const tampered = new Uint8Array([42, 42, 42]);
let server: Server;
let baseUrl = '';
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits += 1;
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from(bytes));
    } else if (req.url === '/tampered') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from(tampered));
    } else {
      res.writeHead(404, 'Not Found');
      res.end('nope');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no addr');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function assetFor(path: string, fileName: string): ResolvedOxigraphAsset {
  return { asset: 'oxigraph_test', sha256: sha256(bytes), url: `${baseUrl}${path}`, fileName };
}

async function freshCache(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'oxi-bin-cache-'));
}

describe('resolveOxigraphBinary (real server + real filesystem)', () => {
  it('downloads, sha256-verifies, chmods 0o755, and lands the file atomically', async () => {
    const cacheDir = await freshCache();
    const before = hits;
    try {
      const binary = await resolveOxigraphBinary({ cacheDir, asset: assetFor('/ok', 'oxi-real-bin'), log: () => {} });
      expect(binary).toEqual({
        path: join(cacheDir, 'oxi-real-bin'),
        source: 'bundled',
        version: OXIGRAPH_VERSION,
      });
      expect(hits - before).toBe(1); // the real server saw exactly one download
      expect(new Uint8Array(await readFile(binary.path))).toEqual(bytes);
      const mode = (await stat(binary.path)).mode & 0o777;
      expect(mode & 0o111, 'binary must be executable').toBeTruthy();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('reuses a cached binary that matches the checksum — the real server sees NO request', async () => {
    const cacheDir = await freshCache();
    try {
      await writeFile(join(cacheDir, 'oxi-real-bin'), bytes);
      const before = hits;
      const binary = await resolveOxigraphBinary({ cacheDir, asset: assetFor('/ok', 'oxi-real-bin'), log: () => {} });
      expect(binary).toEqual({
        path: join(cacheDir, 'oxi-real-bin'),
        source: 'bundled',
        version: OXIGRAPH_VERSION,
      });
      expect(hits - before).toBe(0);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('re-downloads when the cached file REALLY fails the checksum', async () => {
    const cacheDir = await freshCache();
    try {
      await writeFile(join(cacheDir, 'oxi-real-bin'), new Uint8Array([9, 9, 9]));
      const before = hits;
      await resolveOxigraphBinary({ cacheDir, asset: assetFor('/ok', 'oxi-real-bin'), log: () => {} });
      expect(hits - before).toBe(1);
      expect(new Uint8Array(await readFile(join(cacheDir, 'oxi-real-bin')))).toEqual(bytes);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('throws on a REAL checksum mismatch and leaves no runnable binary behind', async () => {
    const cacheDir = await freshCache();
    try {
      await expect(
        resolveOxigraphBinary({ cacheDir, asset: assetFor('/tampered', 'oxi-real-bin'), log: () => {} }),
      ).rejects.toThrow(/checksum mismatch/i);
      // The final path must not exist — the tampered download was discarded.
      await expect(access(join(cacheDir, 'oxi-real-bin'))).rejects.toThrow();
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('throws on a REAL HTTP 404', async () => {
    const cacheDir = await freshCache();
    try {
      await expect(
        resolveOxigraphBinary({ cacheDir, asset: assetFor('/missing', 'oxi-real-bin'), log: () => {} }),
      ).rejects.toThrow(/HTTP 404/);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('PATH fallback (real directories, real executables)', () => {
  let pathDirA: string; // holds a NON-executable decoy
  let pathDirB: string; // holds the real executable
  const prevPath = process.env.PATH;

  beforeAll(async () => {
    pathDirA = await mkdtemp(join(tmpdir(), 'oxi-path-a-'));
    pathDirB = await mkdtemp(join(tmpdir(), 'oxi-path-b-'));
    await writeFile(join(pathDirA, 'oxigraph'), '#!/bin/sh\n'); // not executable
    await writeFile(
      join(pathDirB, 'oxigraph'),
      '#!/bin/sh\n[ "$1" = "--version" ] && echo "Oxigraph 0.6.0"\nexit 0\n',
    );
    await chmod(join(pathDirB, 'oxigraph'), 0o755);
  });

  afterAll(async () => {
    process.env.PATH = prevPath;
    await rm(pathDirA, { recursive: true, force: true });
    await rm(pathDirB, { recursive: true, force: true });
  });

  // Plain hand-written stat that reports the musl loader present (musl
  // detection probes io.stat on /lib/ld-musl-*.so.1) and delegates EVERYTHING
  // else to the real fs — environment parameterization for a host this CI
  // cannot be (Alpine/musl). The returned Stats for the marker is a REAL
  // Stats of a real file. No vitest mock API.
  const statOnMuslHost: typeof stat = (async (p: Parameters<typeof stat>[0], o?: Parameters<typeof stat>[1]) => {
    if (String(p).startsWith('/lib/ld-musl-')) return stat(pathDirB, o as never);
    return stat(p, o as never);
  }) as typeof stat;

  it('on musl Linux, prefers a REAL executable oxigraph on PATH and skips the non-executable decoy', async () => {
    const cacheDir = await freshCache();
    process.env.PATH = `${pathDirA}:${pathDirB}`;
    try {
      const before = hits;
      const binary = await resolveOxigraphBinary({
        cacheDir,
        platform: 'linux',
        arch: 'x64',
        io: { stat: statOnMuslHost },
        log: () => {},
      });
      // The decoy in pathDirA is not executable (real X_OK check fails);
      // the real executable in pathDirB wins. No download happened.
      expect(binary).toEqual({
        path: join(pathDirB, 'oxigraph'),
        source: 'system',
        version: '0.6.0',
      });
      expect(hits - before).toBe(0);
    } finally {
      process.env.PATH = prevPath;
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('returns the selected system executable version as capability metadata', async () => {
    const cacheDir = await freshCache();
    process.env.PATH = `${pathDirA}:${pathDirB}`;
    try {
      await expect(resolveOxigraphBinary({
        cacheDir,
        platform: 'linux',
        arch: 'x64',
        io: { stat: statOnMuslHost },
        log: () => {},
      })).resolves.toEqual({
        path: join(pathDirB, 'oxigraph'),
        source: 'system',
        version: '0.6.0',
      });
    } finally {
      process.env.PATH = prevPath;
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('on musl Linux with NO oxigraph on PATH, throws the musl-specific actionable error', async () => {
    const cacheDir = await freshCache();
    const emptyDir = await mkdtemp(join(tmpdir(), 'oxi-path-empty-'));
    process.env.PATH = emptyDir;
    try {
      await expect(
        resolveOxigraphBinary({
          cacheDir,
          platform: 'linux',
          arch: 'x64',
          io: { stat: statOnMuslHost },
          log: () => {},
        }),
      ).rejects.toThrow(/musl/i);
    } finally {
      process.env.PATH = prevPath;
      await rm(emptyDir, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('system binary version probing', () => {
  async function withSystemBinary<T>(
    script: string,
    run: (cacheDir: string) => Promise<T>,
  ): Promise<T> {
    const pathDir = await mkdtemp(join(tmpdir(), 'oxi-probe-path-'));
    const cacheDir = await freshCache();
    const previousPath = process.env.PATH;
    try {
      await writeFile(join(pathDir, 'oxigraph'), script);
      await chmod(join(pathDir, 'oxigraph'), 0o755);
      process.env.PATH = pathDir;
      return await run(cacheDir);
    } finally {
      process.env.PATH = previousPath;
      await rm(pathDir, { recursive: true, force: true });
      await rm(cacheDir, { recursive: true, force: true });
    }
  }

  it('accepts parseable version output from stderr', async () => {
    await expect(withSystemBinary(
      '#!/bin/sh\necho "Oxigraph v0.6.1" >&2\n',
      (cacheDir) => resolveOxigraphBinary({
        cacheDir,
        platform: 'freebsd' as NodeJS.Platform,
        log: () => {},
      }),
    )).resolves.toMatchObject({ source: 'system', version: '0.6.1' });
  });

  it('ignores unrelated versions before an Oxigraph-labelled version', async () => {
    await expect(withSystemBinary(
      '#!/bin/sh\necho "launcher 0.6.0"\necho "Oxigraph 0.5.8" >&2\n',
      (cacheDir) => resolveOxigraphBinary({
        cacheDir,
        platform: 'freebsd' as NodeJS.Platform,
        log: () => {},
      }),
    )).resolves.toMatchObject({ source: 'system', version: '0.5.8' });
  });

  it('rejects conflicting Oxigraph-labelled version lines', async () => {
    await expect(withSystemBinary(
      '#!/bin/sh\necho "Oxigraph 0.5.8"\necho "Oxigraph v0.6.0" >&2\n',
      (cacheDir) => resolveOxigraphBinary({
        cacheDir,
        platform: 'freebsd' as NodeJS.Platform,
        log: () => {},
      }),
    )).rejects.toThrow(/Unable to determine Oxigraph version/u);
  });

  it('rejects a non-zero version probe even when its output contains a version', async () => {
    await expect(withSystemBinary(
      '#!/bin/sh\necho "Oxigraph 0.6.1"\nexit 7\n',
      (cacheDir) => resolveOxigraphBinary({
        cacheDir,
        platform: 'freebsd' as NodeJS.Platform,
        log: () => {},
      }),
    )).rejects.toThrow(/Unable to determine Oxigraph version/u);
  });

  it('rejects unparsable and over-limit version output', async () => {
    await expect(withSystemBinary(
      '#!/bin/sh\necho "Oxigraph development build"\n',
      (cacheDir) => resolveOxigraphBinary({
        cacheDir,
        platform: 'freebsd' as NodeJS.Platform,
        log: () => {},
      }),
    )).rejects.toThrow(/Unable to determine Oxigraph version/u);

    await expect(withSystemBinary(
      '#!/bin/sh\ni=0; while [ "$i" -lt 5000 ]; do printf x; i=$((i + 1)); done\n',
      (cacheDir) => resolveOxigraphBinary({
        cacheDir,
        platform: 'freebsd' as NodeJS.Platform,
        log: () => {},
      }),
    )).rejects.toThrow(/exceeded 4096 bytes/u);
  });

  it.skipIf(process.platform === 'win32')('times out and reaps a version probe that ignores SIGTERM', async () => {
    const probeStateDir = await mkdtemp(join(tmpdir(), 'oxi-probe-state-'));
    const pidPath = join(probeStateDir, 'pid');
    const startedAt = Date.now();
    let watchdog: NodeJS.Timeout | undefined;
    try {
      const probe = withSystemBinary(
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on('SIGTERM', () => {});\nsetInterval(() => {}, 1_000);\n`,
        (cacheDir) => resolveOxigraphBinary({
          cacheDir,
          platform: 'freebsd' as NodeJS.Platform,
          log: () => {},
          versionProbeTimeoutMs: 500,
        }),
      );
      const outerWatchdog = new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error('test watchdog: version probe remained pending')),
          2_500,
        );
      });
      await expect(Promise.race([probe, outerWatchdog]))
        .rejects.toThrow(/timed out after 500ms/u);

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      const childPid = Number(await readFile(pidPath, 'utf8'));
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      if (watchdog) clearTimeout(watchdog);
      await rm(probeStateDir, { recursive: true, force: true });
    }
  });
});
