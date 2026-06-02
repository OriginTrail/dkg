/**
 * Oxigraph server binary resolver — fetch-on-install of the prebuilt
 * `oxigraph` executable for the host platform (Release 2, phase 2b
 * packaging; used by the opt-in supervisor in 2a).
 *
 * # Why fetch-on-install instead of bundling
 *
 * Oxigraph ships a single, self-contained executable per platform on its
 * GitHub releases (RocksDB is statically linked) — each is ~12–21 MB and
 * the six platform variants together are ~100 MB. Bundling all six into
 * the npm package would bloat every install for five binaries the host
 * will never run. Instead we resolve the one matching
 * `process.platform`/`process.arch` at first boot, verify it against a
 * pinned SHA-256, cache it under DKG_HOME, and reuse it forever after.
 *
 * # Integrity
 *
 * The SHA-256 of every pinned asset is baked in below
 * (`OXIGRAPH_ASSETS`), taken from the GitHub release API `digest` field
 * for v0.5.8. The downloaded bytes are hashed and compared before the
 * binary is ever marked executable or moved into place — a corrupted or
 * tampered download never becomes runnable. This is the same trust model
 * as a lockfile integrity hash: we trust the value we pinned at authoring
 * time, not whatever the host happens to download later.
 *
 * # Caveats
 *
 * - Linux release artifacts are glibc-only (`*_linux_gnu`); there is no
 *   musl build, so Alpine / distroless containers must fall back to the
 *   Docker image or a system-provided `oxigraph`. `resolveOxigraphAsset`
 *   cannot detect the libc at runtime, so the glibc binary is returned for
 *   every Linux host and the supervisor surfaces the load failure if the
 *   host is musl.
 * - macOS Gatekeeper quarantines files downloaded by a quarantine-aware
 *   downloader. We clear the `com.apple.quarantine` xattr best-effort
 *   after download so the spawned child isn't killed on first exec.
 *
 * Every external boundary (fetch, fs, platform/arch, xattr) is injectable
 * so the unit tests run without network or real downloads.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

/** Pinned Oxigraph release. Bump deliberately (re-pin checksums below). */
export const OXIGRAPH_VERSION = '0.5.8';

interface OxigraphAsset {
  /** GitHub release asset filename. */
  asset: string;
  /** SHA-256 of the asset bytes (GitHub release API `digest`, sans prefix). */
  sha256: string;
}

/**
 * Host (`${platform}-${arch}`) → release asset + integrity hash, pinned to
 * v0.5.8. Checksums are the GitHub release API `digest` values; re-fetch
 * and re-pin when bumping `OXIGRAPH_VERSION`.
 */
export const OXIGRAPH_ASSETS: Readonly<Record<string, OxigraphAsset>> = {
  'darwin-arm64': {
    asset: `oxigraph_v${OXIGRAPH_VERSION}_aarch64_apple`,
    sha256: '8ea2c129395b6ff5e98b754f868eefef2eb6bf0d93c64d3f281c0aa1e7fe7dbf',
  },
  'darwin-x64': {
    asset: `oxigraph_v${OXIGRAPH_VERSION}_x86_64_apple`,
    sha256: '7d23bc08eeb3f30b2d9f880a173ff2686999091c52ca9ea15e00bf92433e4f59',
  },
  'linux-arm64': {
    asset: `oxigraph_v${OXIGRAPH_VERSION}_aarch64_linux_gnu`,
    sha256: 'f4970b1b145ef280410f2334690017004983dd57a1fa449b188415730b3a6147',
  },
  'linux-x64': {
    asset: `oxigraph_v${OXIGRAPH_VERSION}_x86_64_linux_gnu`,
    sha256: 'c0cb0a3e747cfbc4a5b72ffc20b3eb9ebebf7f21f7b3deb447af3fd7abdcb112',
  },
  'win32-arm64': {
    asset: `oxigraph_v${OXIGRAPH_VERSION}_aarch64_windows_msvc.exe`,
    sha256: 'e549d8705200c0cd6466cf822f7bbae4da07ede8fedad2351390141a58fdb1e3',
  },
  'win32-x64': {
    asset: `oxigraph_v${OXIGRAPH_VERSION}_x86_64_windows_msvc.exe`,
    sha256: '9c847300f440e4571a41957d9f9d54272a52baa703b27267a1ab0ede2ca513f6',
  },
};

const RELEASE_BASE = `https://github.com/oxigraph/oxigraph/releases/download/v${OXIGRAPH_VERSION}`;

export interface ResolvedOxigraphAsset {
  asset: string;
  sha256: string;
  url: string;
  /** Cache filename (stable across boots, version-stamped). */
  fileName: string;
}

/**
 * Map a host to its release asset, or throw an actionable error for
 * platforms Oxigraph doesn't publish a self-contained binary for.
 */
export function resolveOxigraphAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ResolvedOxigraphAsset {
  const key = `${platform}-${arch}`;
  const entry = OXIGRAPH_ASSETS[key];
  if (!entry) {
    throw new Error(
      `No prebuilt Oxigraph ${OXIGRAPH_VERSION} binary for ${key}. ` +
        `Supported: ${Object.keys(OXIGRAPH_ASSETS).join(', ')}. ` +
        `Install \`oxigraph\` on PATH yourself, or use an external SPARQL endpoint ` +
        `(store.backend: 'sparql-http').`,
    );
  }
  const isWindows = platform === 'win32';
  return {
    asset: entry.asset,
    sha256: entry.sha256,
    url: `${RELEASE_BASE}/${entry.asset}`,
    fileName: `oxigraph-v${OXIGRAPH_VERSION}${isWindows ? '.exe' : ''}`,
  };
}

// --------------------------------------------------------------------
// Injectable IO — tests pass mocks; production wires real fs/fetch/spawn.
// --------------------------------------------------------------------

export interface OxigraphBinaryIo {
  fetch: typeof globalThis.fetch;
  mkdir: typeof mkdir;
  writeFile: typeof writeFile;
  readFile: typeof readFile;
  chmod: typeof chmod;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
  /** Clear the macOS quarantine xattr; best-effort, never throws. */
  clearQuarantine: (path: string) => Promise<void>;
}

function defaultClearQuarantine(path: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve();
  return new Promise<void>((resolve) => {
    // `-d` removes the attribute; exit is ignored — a missing xattr (the
    // common case for non-quarantined files) exits non-zero and is fine.
    const child = spawn('xattr', ['-d', 'com.apple.quarantine', path], {
      stdio: 'ignore',
    });
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}

function defaultIo(): OxigraphBinaryIo {
  return {
    fetch: globalThis.fetch,
    mkdir,
    writeFile,
    readFile,
    chmod,
    rename,
    rm,
    stat,
    clearQuarantine: defaultClearQuarantine,
  };
}

export interface EnsureOxigraphBinaryOptions {
  /** Directory to cache the binary under (e.g. `<DKG_HOME>/oxigraph`). */
  cacheDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  log?: (msg: string) => void;
  /** Download timeout in ms. Default 120_000 (binaries are ~20 MB). */
  timeoutMs?: number;
  io?: Partial<OxigraphBinaryIo>;
  /**
   * Override the resolved asset (url + integrity hash + cache filename).
   * Production omits this and resolves from `platform`/`arch`; tests use
   * it to supply a checksum matching their mocked bytes.
   */
  asset?: ResolvedOxigraphAsset;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Ensure the pinned Oxigraph binary exists in `cacheDir` and return its
 * absolute path. Reuses a cached binary whose checksum matches; otherwise
 * downloads, verifies the SHA-256, marks it executable, clears macOS
 * quarantine, and atomically moves it into place.
 */
export async function ensureOxigraphBinary(
  opts: EnsureOxigraphBinaryOptions,
): Promise<string> {
  const io = { ...defaultIo(), ...opts.io };
  const log = opts.log ?? (() => {});
  const resolved = opts.asset ?? resolveOxigraphAsset(opts.platform, opts.arch);
  const target = join(opts.cacheDir, resolved.fileName);

  // Cache hit: a previously-verified binary is present and still matches
  // the pinned checksum (guards against partial writes / on-disk drift).
  try {
    await io.stat(target);
    const existing = await io.readFile(target);
    if (sha256Hex(existing as Uint8Array) === resolved.sha256) {
      log(`Oxigraph ${OXIGRAPH_VERSION} binary cached at ${target}`);
      return target;
    }
    log(`Cached Oxigraph binary at ${target} failed checksum — re-downloading.`);
  } catch {
    // Not present — fall through to download.
  }

  await io.mkdir(opts.cacheDir, { recursive: true });
  log(`Downloading Oxigraph ${OXIGRAPH_VERSION} (${resolved.asset})…`);
  const res = await io.fetch(resolved.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to download Oxigraph binary from ${resolved.url}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = sha256Hex(bytes);
  if (digest !== resolved.sha256) {
    throw new Error(
      `Oxigraph binary checksum mismatch for ${resolved.asset}: ` +
        `expected ${resolved.sha256}, got ${digest}. Refusing to run an unverified binary.`,
    );
  }

  // Write to a temp sibling then atomically rename so a crash mid-write
  // never leaves a truncated binary that the cache-hit path would trust.
  const tmp = `${target}.${process.pid}.tmp`;
  await io.writeFile(tmp, bytes);
  await io.chmod(tmp, 0o755);
  await io.clearQuarantine(tmp);
  await io.rename(tmp, target);
  log(`Oxigraph ${OXIGRAPH_VERSION} binary verified and installed at ${target}`);
  return target;
}
