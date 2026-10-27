// OT-RFC-27 buyer gateway key store: the daemon's durable home for the
// scoped gateway keys (`dkg_gw_…`) over the domain `GatewayKeyLedger`.
//
//   - File `<dkgDir>/marketplace/gateway-keys.json`, mode 0600 (dir 0700 when
//     created). Keys are HASHED at rest; the plaintext exists only in the one
//     mint response and is never stored or logged.
//   - Writes are atomic (tmp + rename via `writeFileAtomicWith`) and
//     SERIALIZED: at most one write in flight and at most one pending write,
//     which serializes the LATEST ledger state when it starts. The helper's
//     tmp name is per-millisecond, so unserialized writes could collide, and
//     unordered async writes could land an older snapshot last.
//   - Mint is durable before it returns: a failed write rolls the key back
//     (`ledger.remove`) and no plaintext is handed out.
//   - A malformed file FAILS CLOSED without failing the boot: the store holds
//     no ledger, the gateway answers 503, the admin routes 500 naming the
//     file, mint refuses, and the file is never overwritten.
//   - One store per path (`openGatewayKeyStore`), so the gateway dispatch and
//     the node-admin key routes share in-memory state: a revocation takes
//     effect on the next call.
//
// Imports only the pure `gateway-domain` module of the agent package — never
// the agent runtime root.

import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  GatewayKeyLedger,
  type GatewayKeyLedgerJson,
  type GatewayKeyRecord,
  type GatewayKeyScopes,
} from '@origintrail-official/dkg-agent/dist/marketplace/gateway-domain.js';
import { writeFileAtomicWith } from './daemon/atomic-write.js';

/** Filesystem calls the store needs (injectable for tests). */
export interface GatewayKeyStoreIo {
  readFileSync(path: string): string;
  writeFile(path: string, data: string, opts: { mode: number }): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
  chmod(path: string, mode: number): Promise<unknown>;
  mkdir(path: string, opts: { recursive: true; mode: number }): Promise<unknown>;
}

const NODE_IO: GatewayKeyStoreIo = {
  readFileSync: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, data, opts) => writeFile(path, data, opts),
  rename,
  unlink,
  chmod,
  mkdir,
};

export const GATEWAY_KEY_FILE_MODE = 0o600;
export const GATEWAY_KEY_DIR_MODE = 0o700;

/** `<dkgDir>/marketplace/gateway-keys.json`. */
export function gatewayKeyStorePath(dkgDir: string): string {
  return join(dkgDir, 'marketplace', 'gateway-keys.json');
}

/** The store failed closed at load (malformed file): every operation refuses. */
export class GatewayKeyStoreUnavailableError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`gateway key store ${path} is unusable (${detail}); fix or remove the file, then restart the node`);
    this.name = 'GatewayKeyStoreUnavailableError';
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolveFn!: () => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  // A persist nobody awaits (settle) must not become an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, resolve: resolveFn, reject: rejectFn };
}

export interface GatewayKeyStoreOptions {
  io?: GatewayKeyStoreIo;
  log?: (line: string) => void;
}

export class MarketplaceGatewayKeyStore {
  readonly path: string;
  /** Set when the file on disk is malformed (fail closed). */
  readonly loadError: string | undefined;
  readonly #ledger: GatewayKeyLedger | undefined;
  readonly #io: GatewayKeyStoreIo;
  readonly #log: (line: string) => void;
  #inFlight: Promise<void> | null = null;
  #pending: Deferred | null = null;

  constructor(path: string, opts: GatewayKeyStoreOptions = {}) {
    this.path = path;
    this.#io = opts.io ?? NODE_IO;
    this.#log = opts.log ?? (() => undefined);
    let ledger: GatewayKeyLedger | undefined;
    let loadError: string | undefined;
    let text: string | undefined;
    try {
      text = this.#io.readFileSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        loadError = `unreadable: ${(err as Error)?.message ?? String(err)}`;
      }
    }
    if (loadError === undefined) {
      try {
        ledger = new GatewayKeyLedger(text === undefined ? undefined : (JSON.parse(text) as GatewayKeyLedgerJson));
      } catch (err) {
        loadError = `malformed: ${(err as Error)?.message ?? String(err)}`.slice(0, 300);
      }
    }
    this.#ledger = loadError === undefined ? ledger : undefined;
    this.loadError = loadError;
    if (loadError !== undefined) {
      this.#log(`[marketplace-gateway] key store ${path} failed closed (${loadError}); the gateway answers 503 until it is fixed or removed and the node restarts`);
    }
  }

  get available(): boolean {
    return this.#ledger !== undefined;
  }

  /** The live ledger; throws `GatewayKeyStoreUnavailableError` when the store failed closed. */
  ledger(): GatewayKeyLedger {
    if (!this.#ledger) throw new GatewayKeyStoreUnavailableError(this.path, this.loadError ?? 'not loaded');
    return this.#ledger;
  }

  /** Mint a key; resolves only after the record is on disk (rolled back on a failed write). */
  async mint(scopes: GatewayKeyScopes, nowSeconds: number): Promise<{ plaintext: string; record: GatewayKeyRecord }> {
    const ledger = this.ledger();
    const minted = ledger.mint(scopes, nowSeconds);
    try {
      await this.persist();
    } catch (err) {
      ledger.remove(minted.record.keyId);
      throw err;
    }
    return minted;
  }

  /** Revoke (idempotent; effective in memory at once) and persist. `undefined` for an unknown key. */
  async revoke(keyId: string, nowSeconds: number): Promise<GatewayKeyRecord | undefined> {
    const record = this.ledger().revoke(keyId, nowSeconds);
    if (record) await this.persist();
    return record;
  }

  /** Hold `worstCaseWei` against the key's budget (in memory; reservations are never persisted). */
  reserve(keyId: string, reservationId: string, worstCaseWei: bigint): ReturnType<GatewayKeyLedger['reserve']> {
    return this.ledger().reserve(keyId, reservationId, worstCaseWei);
  }

  /** Book a served/ambiguous call; the write is queued (errors are logged, never thrown). */
  settle(
    reservationId: string,
    outcome: { costWei: bigint; servedUnits: bigint; kind: 'inference' | 'query' },
    nowSeconds: number,
  ): Promise<void> {
    this.ledger().settle(reservationId, outcome, nowSeconds);
    return this.persist().catch((err) => {
      this.#log(`[marketplace-gateway] key usage write failed (kept in memory): ${(err as Error)?.message ?? String(err)}`);
    });
  }

  /** Release a not-served hold (no usage change, nothing to persist). */
  release(reservationId: string): void {
    this.ledger().release(reservationId);
  }

  /**
   * Queue a write of the current ledger. Coalescing: concurrent callers share
   * the one pending write, which snapshots the ledger when it STARTS, so the
   * last write to land always carries the latest state.
   */
  persist(): Promise<void> {
    this.ledger();
    if (this.#pending) return this.#pending.promise;
    const pending = deferred();
    this.#pending = pending;
    if (!this.#inFlight) {
      this.#inFlight = this.#drain().finally(() => {
        this.#inFlight = null;
      });
    }
    return pending.promise;
  }

  /** Wait for every queued write (tests, shutdown). */
  async flush(): Promise<void> {
    while (this.#inFlight) await this.#inFlight;
  }

  async #drain(): Promise<void> {
    while (this.#pending) {
      const current = this.#pending;
      this.#pending = null;
      try {
        await this.#writeNow();
        current.resolve();
      } catch (err) {
        current.reject(err);
      }
    }
  }

  async #writeNow(): Promise<void> {
    const data = `${JSON.stringify(this.ledger().toJSON(), null, 2)}\n`;
    await this.#io.mkdir(dirname(this.path), { recursive: true, mode: GATEWAY_KEY_DIR_MODE });
    const io = this.#io;
    await writeFileAtomicWith(
      {
        // The helper's io has no mode argument; a fresh tmp file is created 0600.
        writeFile: (path, text) => io.writeFile(path, text, { mode: GATEWAY_KEY_FILE_MODE }),
        rename: (from, to) => io.rename(from, to),
        unlink: (path) => io.unlink(path),
      },
      this.path,
      data,
    );
    // `mode` applies only on create: re-assert 0600 on the final file.
    await this.#io.chmod(this.path, GATEWAY_KEY_FILE_MODE);
  }
}

const stores = new Map<string, MarketplaceGatewayKeyStore>();

/**
 * The one key store for `<dkgDir>/marketplace/gateway-keys.json` in this
 * process (loaded on first open). The gateway dispatch and the admin routes
 * both open it, so they share one in-memory ledger.
 */
export function openGatewayKeyStore(dkgDir: string, opts: { log?: (line: string) => void } = {}): MarketplaceGatewayKeyStore {
  const path = resolve(gatewayKeyStorePath(dkgDir));
  let store = stores.get(path);
  if (!store) {
    store = new MarketplaceGatewayKeyStore(path, opts);
    stores.set(path, store);
  }
  return store;
}
