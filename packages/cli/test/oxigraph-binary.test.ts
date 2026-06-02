/**
 * Oxigraph binary resolver — unit tests with full IO injection.
 *
 * Locks in:
 *   - platform/arch → release asset mapping for all six supported hosts;
 *   - actionable throw for unsupported hosts;
 *   - cache hit when an on-disk binary matches the pinned checksum
 *     (no re-download);
 *   - cache miss / corrupt cache → download, verify, chmod, clear macOS
 *     quarantine, atomic rename into place;
 *   - checksum mismatch on download → throw, never marks the binary
 *     runnable;
 *   - HTTP error → throw.
 *
 * No network, no real fs, no real downloads.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  resolveOxigraphAsset,
  ensureOxigraphBinary,
  OXIGRAPH_VERSION,
  OXIGRAPH_ASSETS,
  type OxigraphBinaryIo,
  type ResolvedOxigraphAsset,
} from '../src/daemon/oxigraph-binary.js';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('resolveOxigraphAsset', () => {
  it('maps every supported host to a versioned asset + url + filename', () => {
    expect(resolveOxigraphAsset('darwin', 'arm64')).toMatchObject({
      asset: `oxigraph_v${OXIGRAPH_VERSION}_aarch64_apple`,
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

function makeIo(overrides: Partial<OxigraphBinaryIo> = {}): {
  io: Partial<OxigraphBinaryIo>;
  files: Map<string, Uint8Array>;
  chmodCalls: Array<{ path: string; mode: number }>;
  quarantineCleared: string[];
  renames: Array<{ from: string; to: string }>;
} {
  const files = new Map<string, Uint8Array>();
  const chmodCalls: Array<{ path: string; mode: number }> = [];
  const quarantineCleared: string[] = [];
  const renames: Array<{ from: string; to: string }> = [];
  const io: Partial<OxigraphBinaryIo> = {
    mkdir: (async () => undefined) as any,
    stat: (async (p: string) => {
      if (!files.has(String(p))) throw new Error('ENOENT');
      return {} as any;
    }) as any,
    readFile: (async (p: string) => {
      const b = files.get(String(p));
      if (!b) throw new Error('ENOENT');
      return b as any;
    }) as any,
    writeFile: (async (p: string, data: any) => {
      files.set(String(p), data as Uint8Array);
    }) as any,
    chmod: (async (p: string, mode: number) => {
      chmodCalls.push({ path: String(p), mode });
    }) as any,
    rename: (async (from: string, to: string) => {
      const b = files.get(String(from));
      files.delete(String(from));
      if (b) files.set(String(to), b);
      renames.push({ from: String(from), to: String(to) });
    }) as any,
    rm: (async () => undefined) as any,
    clearQuarantine: async (p: string) => {
      quarantineCleared.push(p);
    },
    ...overrides,
  };
  return { io, files, chmodCalls, quarantineCleared, renames };
}

describe('ensureOxigraphBinary', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const asset: ResolvedOxigraphAsset = {
    asset: 'oxigraph_test',
    sha256: sha256(bytes),
    url: 'https://example.test/oxigraph_test',
    fileName: 'oxigraph-test-bin',
  };

  it('downloads, verifies, chmods, clears quarantine, and renames atomically', async () => {
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
    const { io, files, chmodCalls, quarantineCleared, renames } = makeIo({
      fetch: fetchMock as any,
    });

    const path = await ensureOxigraphBinary({ cacheDir: '/cache', asset, io });

    expect(path).toBe('/cache/oxigraph-test-bin');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(files.get('/cache/oxigraph-test-bin')).toEqual(bytes);
    expect(chmodCalls.some((c) => c.mode === 0o755)).toBe(true);
    expect(quarantineCleared.length).toBe(1);
    // Wrote to a temp sibling then renamed into the final path.
    expect(renames.some((r) => r.to === '/cache/oxigraph-test-bin')).toBe(true);
  });

  it('reuses a cached binary that matches the checksum (no download)', async () => {
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
    const { io, files } = makeIo({ fetch: fetchMock as any });
    files.set('/cache/oxigraph-test-bin', bytes);

    const path = await ensureOxigraphBinary({ cacheDir: '/cache', asset, io });

    expect(path).toBe('/cache/oxigraph-test-bin');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-downloads when the cached binary fails the checksum', async () => {
    const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
    const { io, files } = makeIo({ fetch: fetchMock as any });
    files.set('/cache/oxigraph-test-bin', new Uint8Array([9, 9, 9]));

    await ensureOxigraphBinary({ cacheDir: '/cache', asset, io });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(files.get('/cache/oxigraph-test-bin')).toEqual(bytes);
  });

  it('throws on checksum mismatch and never marks the binary runnable', async () => {
    const tampered = new Uint8Array([42, 42, 42]);
    const fetchMock = vi.fn(async () => new Response(tampered, { status: 200 }));
    const { io, chmodCalls, renames } = makeIo({ fetch: fetchMock as any });

    await expect(
      ensureOxigraphBinary({ cacheDir: '/cache', asset, io }),
    ).rejects.toThrow(/checksum mismatch/i);
    expect(chmodCalls.length).toBe(0);
    expect(renames.length).toBe(0);
  });

  it('throws on HTTP error', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' }));
    const { io } = makeIo({ fetch: fetchMock as any });
    await expect(
      ensureOxigraphBinary({ cacheDir: '/cache', asset, io }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it('falls back to a system oxigraph on PATH when no pinned binary exists', async () => {
    const prevPath = process.env.PATH;
    process.env.PATH = '/opt/custom/bin:/usr/local/bin';
    try {
      const statMock = vi.fn(async (p: string) =>
        String(p) === '/usr/local/bin/oxigraph'
          ? ({ isFile: () => true } as any)
          : Promise.reject(new Error('ENOENT')),
      );
      const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
      const path = await ensureOxigraphBinary({
        cacheDir: '/cache',
        platform: 'freebsd' as NodeJS.Platform,
        arch: 'x64',
        io: { stat: statMock as any, fetch: fetchMock as any },
      });
      expect(path).toBe('/usr/local/bin/oxigraph');
      // System binary: no download, no checksum (operator-provided).
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it('throws the actionable error when no pinned binary and none on PATH', async () => {
    const prevPath = process.env.PATH;
    process.env.PATH = '/empty/bin';
    try {
      const statMock = vi.fn(async () => {
        throw new Error('ENOENT');
      });
      await expect(
        ensureOxigraphBinary({
          cacheDir: '/cache',
          platform: 'freebsd' as NodeJS.Platform,
          arch: 'x64',
          io: { stat: statMock as any },
        }),
      ).rejects.toThrow(/No prebuilt Oxigraph/);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
