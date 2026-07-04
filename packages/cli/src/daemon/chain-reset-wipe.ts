/**
 * Auto-wipe per-node chain-state derived files when the maintainer-set
 * `network/<env>.json#chainResetMarker` differs from the one persisted on
 * the previous boot.
 *
 * Why this exists
 * ---------------
 * Testnet resets (e.g. PR #357 V10 staking consolidation) require every
 * operator to wipe their oxigraph store, publish journal, and random
 * sampling WAL because those files reference chain entities (KC ids,
 * merkle roots, challenge periods) that no longer exist after the chain
 * is redeployed. Without this auto-wipe, every operator has to do it by
 * hand — see docs/archive/internal/TESTNET_RESET.md Phase C for the manual drill.
 *
 * With this hook, the maintainer simply bumps
 * `network/testnet.json#chainResetMarker` to a fresh value as part of the
 * reset commit. Each operator's daemon picks up the new commit via
 * auto-update (5 min on testnet), sees the marker change on next boot,
 * wipes the affected files, and continues. Operator does nothing.
 *
 * Why not reuse `networkId`?
 * --------------------------
 * `networkId` is a SHA256 of the bundled genesis TriG (see
 * `core/src/genesis.ts:computeNetworkId`). It only changes when the
 * genesis document itself is edited — that's a much rarer event than a
 * chain redeploy. Using it as the chain-reset signal would either never
 * trigger (genesis not bumped) or trip the FATAL genesis-mismatch guard
 * (genesis bumped but state out of sync). Hence a dedicated marker.
 *
 * Safety properties
 * -----------------
 * - No marker in network config → hook is a no-op (back-compat for
 *   networks that haven't opted in).
 * - First boot with marker present, no persisted state → wipe, save.
 *   Rationale: the only way to reach this branch on an existing install
 *   is "operator was running before this hook landed, now upgraded into
 *   a release with a marker present". That release necessarily ships in
 *   the chain-reset window, so wiping is the correct behaviour. Fresh
 *   installs hit this branch too but have nothing to wipe → no harm.
 * - Persisted == current → no wipe, idempotent.
 * - Persisted != current → wipe + save new marker.
 * - `DKG_SKIP_CHAIN_RESET_WIPE=1` (dev-loop opt-out) → bypass the wipe
 *   entirely and DON'T persist the marker, so unsetting it re-triggers the
 *   wipe next boot. The operator guarantee is untouched: a real operator
 *   node with the env var unset still wipes by default on a marker change.
 * - `store.nq` is ALWAYS backed up, not deleted: it is RENAMED to
 *   `store.nq.pre-wipe-<marker>-<ts>` (marker bounded to 120 chars) so a
 *   wrongly-triggered wipe is recoverable by moving the file back. The active
 *   store is still cleared from its live path, so the wipe invariant holds.
 *   Rotation retains the newest `MAX_STORE_BACKUPS` (3) snapshots, ranked by
 *   filesystem mtime; the snapshot made this run is always retained.
 *
 * Files wiped: `store.nq` (always backed up, see above), `store.nq.tmp`,
 *              `random-sampling.wal`, `publish-journal.*` (all variants from
 *              publisher-runner).
 *
 * Files preserved: `wallets.json` (operator identity), `auth.token`,
 *              `config.json`, `node-ui.db` (dashboard state),
 *              `files/` (uploaded files), auto-update markers.
 *
 * Per the runbook contract: keystore stays so the wallet identity is
 * constant across resets, and `ensureProfile` re-derives the on-chain
 * identityId on the new chain cleanly.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { isExternalBackend, getSparqlEndpoint } from '@origintrail-official/dkg-storage';

const STATE_FILE = '.network-state.json';

interface PersistedNetworkState {
  /** Last chainResetMarker value the daemon booted on. */
  chainResetMarker: string | null;
  /**
   * Last triple-store backend the daemon booted on. Used by
   * `detectBackendSwitch` to warn loudly when an operator hand-edits
   * `config.store.backend` between boots — the new backend is fresh
   * and empty, so silently booting would mean stale SWM/VM data is
   * inaccessible. `null` on legacy state files (pre-RFC 120) and on
   * first boot. (RFC 120 review point #6.)
   */
  lastBackend?: string | null;
  /**
   * Last resolved network the daemon booted on (the `networkConfig` overlay
   * name, e.g. `mainnet-gnosis`/`testnet`). Used by `detectNetworkSwitch` to
   * abort boot when an operator repoints `config.networkConfig` at a different
   * network on an existing data dir — the store holds the old network's
   * chain-derived state (KC ids, merkle roots), which is meaningless on the
   * new chain. `null`/absent on legacy state files and on first boot.
   */
  lastNetworkConfig?: string | null;
  savedAt: number;
}

/**
 * Subset of `DkgConfig['store']` used by the wipe step to talk to an
 * external SPARQL endpoint. Decoupled from the CLI's config types so
 * this module stays free of upward dependencies.
 */
export interface ChainResetWipeStoreConfig {
  backend: string;
  options?: {
    url?: string;
    queryEndpoint?: string;
    updateEndpoint?: string;
    auth?: string;
    /**
     * True when the namespace was provisioned by the CLI (PR 3 Docker
     * convenience path). Operator-provided URLs default to false; the
     * wipe then scopes deletes to the V10 named-graph prefix to avoid
     * clobbering V6/V8 data sharing the same Blazegraph instance.
     */
    managedByDkg?: boolean;
  };
}

/**
 * V10 named-graph prefix. Every context-graph the agent writes — meta,
 * shared-memory, finalisation — is rooted at `did:dkg:context-graph:`
 * (confirmed in core/genesis.ts + finalization-handler.ts + dkg-agent.ts).
 * Scoped DELETE for operator-provided external endpoints filters on this
 * prefix to leave non-V10 data (V6/V8 assertions, operator side
 * projects) alone.
 */
const V10_GRAPH_PREFIX = 'did:dkg:context-graph:';

const SPARQL_DROP_ALL = 'DROP ALL';
const SPARQL_SCOPED_DELETE =
  'DELETE { GRAPH ?g { ?s ?p ?o } } ' +
  'WHERE { GRAPH ?g { ?s ?p ?o } ' +
  `FILTER(strstarts(str(?g), "${V10_GRAPH_PREFIX}")) }`;

export interface ChainResetWipeResult {
  /** True when a wipe was performed. */
  wiped: boolean;
  /**
   * True when a wipe WOULD have run (marker mismatch) but was bypassed
   * because `skip` was set (`DKG_SKIP_CHAIN_RESET_WIPE=1`). Mutually
   * exclusive with `wiped`. The marker is deliberately NOT persisted on a
   * skip, so the wipe re-triggers once the env var is unset.
   */
  skipped: boolean;
  /** The marker we had persisted before this boot, or null on first boot / no persisted state. */
  prevMarker: string | null;
  /** Files removed during the wipe (relative to dataDir). Empty when `wiped=false`. */
  removedFiles: string[];
  /**
   * `store.nq` backup filenames created by renaming it instead of deleting it
   * (relative to dataDir, `store.nq.pre-wipe-<marker>-<ts>`). Backup is
   * always-on; this is empty only when the wipe ran with no `store.nq`
   * present (or the rename failed — then the failure is in `failedFiles`).
   */
  backedUpFiles: string[];
  /**
   * Files we attempted to wipe but could not remove. When non-empty, the
   * marker is intentionally not persisted so the wipe retries on next boot.
   */
  failedFiles: Array<{ file: string; error: string }>;
}

export interface ChainResetWipeOptions {
  /** Node data directory (e.g. `~/.dkg`). */
  dataDir: string;
  /**
   * Bundled network config's `chainResetMarker`. `undefined` means the
   * network has not opted into the auto-wipe protocol — the hook is then
   * a no-op (no state file written, no wipe).
   */
  currentMarker: string | undefined;
  /**
   * Resolved runtime path of the random-sampling WAL. When the operator
   * sets `randomSampling.walPath` in their config, the prover writes to
   * that path instead of the default `dataDir/random-sampling.wal`. We
   * have to wipe whichever path is actually in use; the default-path
   * wipe alone would leave a stale WAL under operator-supplied paths.
   * Falsy → fall back to `dataDir/random-sampling.wal` (the default).
   */
  randomSamplingWalPath?: string;
  /**
   * Operator's `config.store` block. Required to wipe an external SPARQL
   * endpoint when the backend is `blazegraph` / `sparql-http`. Local
   * backends ignore this field.
   */
  storeConfig?: ChainResetWipeStoreConfig;
  /**
   * Override for the SPARQL HTTP transport. Tests inject a mock to
   * assert the issued UPDATE body; defaults to `globalThis.fetch`.
   * Kept on the options surface (rather than module-scope monkey-patch)
   * so parallel test cases don't race.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Dev-loop opt-out. Sourced from `process.env.DKG_SKIP_CHAIN_RESET_WIPE === '1'`
   * in production (tests pass it explicitly). When `true` and a wipe WOULD run
   * (marker mismatch, including first-boot-with-marker), the wipe is bypassed
   * entirely AND the marker is NOT persisted — so unsetting the env var later
   * re-triggers the wipe on the next boot. This keeps the operator guarantee
   * intact (a real operator node with the flag unset still wipes by default)
   * while letting monorepo developers switch between marker-pinned worktrees
   * without losing their local `store.nq`. Mirrors the `acceptStoreReset` /
   * `acceptNetworkSwitch` env-opt-out pattern used by the sibling detectors.
   */
  skip?: boolean;
  /** Optional logger. Defaults to no-op so the function is silent in tests by default. */
  log?: (msg: string) => void;
}

/**
 * Read the dev-loop opt-out switch. Extracted (and exported) so the
 * documented user-facing env var `DKG_SKIP_CHAIN_RESET_WIPE=1` is unit
 * testable without mutating the real `process.env`. `'1'` (exactly) enables
 * the opt-out; anything else (unset, `'0'`, `'true'`) leaves the wipe on.
 */
export function skipChainResetWipe(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DKG_SKIP_CHAIN_RESET_WIPE === '1';
}

/**
 * Assemble the {@link ChainResetWipeOptions} the daemon passes to
 * {@link chainResetWipe} at boot. Extracted (and exported) so the env→`skip`
 * wiring is a single tested unit — a regression that drops `skip` from the
 * built options now fails a unit test rather than only surfacing at runtime.
 * Mirrors the `resolveMemoryAgentAddress` precedent. Pure: `env` defaults to
 * `process.env` but is injectable for tests.
 */
export function buildChainResetWipeOptions(args: {
  dataDir: string;
  // `null` as well as `undefined`: the daemon's resolved network is
  // `NetworkConfig | null`, and `?.` treats both as "no marker → no-op wipe".
  network: { chainResetMarker?: string } | null | undefined;
  randomSamplingWalPath?: string;
  storeConfig?: ChainResetWipeStoreConfig;
  log: (msg: string) => void;
  env?: NodeJS.ProcessEnv;
}): ChainResetWipeOptions {
  return {
    dataDir: args.dataDir,
    currentMarker: args.network?.chainResetMarker,
    skip: skipChainResetWipe(args.env),
    randomSamplingWalPath: args.randomSamplingWalPath,
    storeConfig: args.storeConfig,
    log: args.log,
  };
}

function loadState(dataDir: string): PersistedNetworkState | null {
  try {
    const raw = readFileSync(join(dataDir, STATE_FILE), 'utf8');
    const obj = JSON.parse(raw) as PersistedNetworkState;
    if (typeof obj?.chainResetMarker !== 'string' && obj?.chainResetMarker !== null) return null;
    return obj;
  } catch {
    return null;
  }
}

function saveState(dataDir: string, marker: string | null): void {
  // Preserve any sibling fields (lastBackend) that `detectBackendSwitch`
  // may have written. Otherwise a chain-reset wipe would clobber a
  // freshly-recorded backend tag and the next boot would re-warn.
  const existing = loadState(dataDir) ?? { chainResetMarker: null, savedAt: 0 };
  writeFileSync(
    join(dataDir, STATE_FILE),
    JSON.stringify(
      {
        ...existing,
        chainResetMarker: marker,
        savedAt: Date.now(),
      } satisfies PersistedNetworkState,
      null,
      2,
    ),
  );
}

function saveBackendTag(dataDir: string, backend: string): void {
  const existing = loadState(dataDir) ?? { chainResetMarker: null, savedAt: 0 };
  writeFileSync(
    join(dataDir, STATE_FILE),
    JSON.stringify(
      {
        ...existing,
        lastBackend: backend,
        savedAt: Date.now(),
      } satisfies PersistedNetworkState,
      null,
      2,
    ),
  );
}

function saveNetworkTag(dataDir: string, networkConfig: string): void {
  // Preserve sibling fields (chainResetMarker, lastBackend) like saveBackendTag.
  const existing = loadState(dataDir) ?? { chainResetMarker: null, savedAt: 0 };
  writeFileSync(
    join(dataDir, STATE_FILE),
    JSON.stringify(
      {
        ...existing,
        lastNetworkConfig: networkConfig,
        savedAt: Date.now(),
      } satisfies PersistedNetworkState,
      null,
      2,
    ),
  );
}

/**
 * Wipe the V10 data sitting in an external SPARQL endpoint. Runs after
 * the local file wipe so we don't strand the operator with a wiped FS
 * but a populated remote namespace (or vice versa).
 *
 * - `managedByDkg === true` → `DROP ALL`. Safe because the namespace
 *   was provisioned by the CLI and nobody else writes to it.
 * - otherwise → scoped DELETE filtered by `did:dkg:context-graph:`. The
 *   operator may be sharing the instance with V6/V8 nodes or unrelated
 *   data; the wipe must leave anything that isn't V10 alone.
 */
async function performExternalWipe(
  storeConfig: ChainResetWipeStoreConfig,
  fetchImpl: typeof globalThis.fetch,
  log: (msg: string) => void,
): Promise<{ label: string; ok: boolean; error?: string }> {
  const { updateUrl, headers } = getSparqlEndpoint({
    backend: storeConfig.backend,
    options: storeConfig.options,
  });
  const managed = storeConfig.options?.managedByDkg === true;
  const update = managed ? SPARQL_DROP_ALL : SPARQL_SCOPED_DELETE;
  const label = managed
    ? `<sparql:drop-all ${updateUrl}>`
    : `<sparql:scoped-delete ${updateUrl}>`;

  log(
    managed
      ? `  external store (DKG-managed namespace): issuing DROP ALL against ${updateUrl}`
      : `  external store (operator-provided URL): issuing scoped DELETE for "${V10_GRAPH_PREFIX}…" graphs against ${updateUrl}`,
  );

  try {
    const res = await fetchImpl(updateUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `update=${encodeURIComponent(update)}`,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const error = `${res.status} ${res.statusText}: ${text.slice(0, 200)}`;
      log(`  WARN: external wipe failed: ${error}`);
      return { label, ok: false, error };
    }
    log(`  removed: ${label}`);
    return { label, ok: true };
  } catch (err) {
    const error = (err as Error).message;
    log(`  WARN: external wipe transport error: ${error}`);
    return { label, ok: false, error };
  }
}

const STORE_BACKUP_PREFIX = 'store.nq.pre-wipe-';

/** Number of `store.nq.pre-wipe-*` recovery snapshots retained after rotation. */
const MAX_STORE_BACKUPS = 3;

/**
 * Pure rotation policy: given every `store.nq.pre-wipe-*` entry (name + mtime),
 * return the names to EVICT so that only the newest `max` snapshots remain.
 *
 * `keepName` is the backup created THIS run: it is dropped from the candidate
 * set up front and can never be returned for eviction, so a non-monotonic wall
 * clock (NTP step-back, VM snapshot/restore) can never evict the fresh recovery
 * snapshot the wipe just made — that would silently defeat the recoverability
 * this backup exists for. It occupies one of the `max` slots, so we retain the
 * newest `max - 1` of the OTHER backups (ranked by mtime DESC; an unreadable
 * stat is passed in as mtimeMs 0 = oldest, so a broken file is evicted first)
 * and return the remainder. No filesystem, no logging — a plain-input seam
 * that is unit-testable in isolation.
 */
export function selectBackupsToRotate(
  entries: { name: string; mtimeMs: number }[],
  keepName: string,
  max: number,
): string[] {
  const keepOthers = Math.max(0, max - 1);
  return entries
    .filter((e) => e.name !== keepName)
    .sort((a, b) => b.mtimeMs - a.mtimeMs) // newest first
    .slice(keepOthers)
    .map((e) => e.name);
}

/**
 * Rotate `store.nq.pre-wipe-*` backups down to the newest `MAX_STORE_BACKUPS`
 * snapshots. Side-effectful shell around the pure {@link selectBackupsToRotate}
 * policy: read the dir, stat each backup (unreadable → mtimeMs 0 = oldest),
 * then `rmSync` the names the policy selects. Best-effort throughout: any
 * failure (listing, stat, unlink) is logged as a WARN and swallowed — rotation
 * must never fail a wipe or a boot, and never contributes to `failedFiles`.
 * `keepName` (the backup created this run) is always retained by the policy.
 */
function rotateStoreBackups(
  dataDir: string,
  keepName: string,
  log: (msg: string) => void,
): void {
  try {
    const entries = readdirSync(dataDir)
      .filter((f) => f.startsWith(STORE_BACKUP_PREFIX))
      .map((name) => {
        // Rank by filesystem mtime (robust to clock steps and to markers that
        // embed dates). An unreadable stat → mtimeMs 0 = treated oldest, so a
        // broken backup file is the first to be rotated out.
        let mtimeMs: number;
        try {
          mtimeMs = statSync(join(dataDir, name)).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return { name, mtimeMs };
      });

    for (const staleName of selectBackupsToRotate(entries, keepName, MAX_STORE_BACKUPS)) {
      try {
        rmSync(join(dataDir, staleName), { force: true });
        log(`  rotated out old store backup: ${staleName}`);
      } catch (err) {
        log(`  WARN: failed to rotate out old store backup ${staleName}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    log(`  WARN: failed to rotate store backups: ${(err as Error).message}`);
  }
}

function performWipe(
  dataDir: string,
  walPath: string | undefined,
  log: (msg: string) => void,
  backup: { currentMarker: string },
): {
  removedFiles: string[];
  backedUpFiles: string[];
  failedFiles: Array<{ file: string; error: string }>;
} {
  const removedFiles: string[] = [];
  const backedUpFiles: string[] = [];
  const failedFiles: Array<{ file: string; error: string }> = [];

  // wipeAbs: wipe an absolute path, log under a display label. We log the
  // display label (relative when inside dataDir, absolute when not) so
  // operator-readable runbook output stays consistent regardless of
  // whether the WAL lives inside or outside the data dir.
  const wipeAbs = (abs: string, displayLabel: string) => {
    try {
      if (existsSync(abs)) {
        rmSync(abs, { recursive: true, force: true });
        removedFiles.push(displayLabel);
      }
    } catch (err) {
      const message = (err as Error).message;
      failedFiles.push({ file: displayLabel, error: message });
      log(`  WARN: failed to wipe ${displayLabel}: ${message}`);
    }
  };

  // store.nq: ALWAYS backed up (rename, O(1) same-fs) rather than deleted, so
  // a wrongly-triggered wipe is recoverable by moving the file back; rotation
  // then bounds disk to MAX_STORE_BACKUPS snapshots. The active store is still
  // cleared from its live path, so the operator wipe invariant holds. A rename
  // failure is treated exactly like a wipe failure (pushed to failedFiles) so
  // the marker isn't persisted and the wipe retries next boot.
  const storeAbs = join(dataDir, 'store.nq');
  if (existsSync(storeAbs)) {
    // Bound the marker portion so the total filename stays well under the
    // 255-byte path-component limit (ENAMETOOLONG would otherwise make the
    // rename fail → failedFiles → re-wipe every boot for long markers).
    // Uniqueness comes from the trailing timestamp, not the marker, so
    // truncation is safe; the RAW marker still persists in .network-state.json.
    const sanitizedMarker = String(backup.currentMarker)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 120);
    const backupName = `${STORE_BACKUP_PREFIX}${sanitizedMarker}-${Date.now()}`;
    try {
      renameSync(storeAbs, join(dataDir, backupName));
      backedUpFiles.push(backupName);
      log(`  backed up: store.nq → ${backupName}`);
      rotateStoreBackups(dataDir, backupName, log);
    } catch (err) {
      const message = (err as Error).message;
      failedFiles.push({ file: 'store.nq', error: message });
      log(`  WARN: failed to back up store.nq → ${backupName}: ${message}`);
    }
  }
  wipeAbs(join(dataDir, 'store.nq.tmp'), 'store.nq.tmp');

  // Random sampling WAL: wipe the resolved runtime path (which the
  // operator may have moved out of dataDir via `randomSampling.walPath`).
  // Defaulting to dataDir/random-sampling.wal keeps the historical
  // behaviour for operators who never set the config knob.
  const walAbs = walPath && walPath.length > 0
    ? walPath
    : join(dataDir, 'random-sampling.wal');
  const walLabel = walAbs.startsWith(dataDir)
    ? walAbs.slice(dataDir.length).replace(/^[/\\]+/, '')
    : walAbs;
  wipeAbs(walAbs, walLabel || 'random-sampling.wal');

  try {
    for (const f of readdirSync(dataDir)) {
      if (f.startsWith('publish-journal.')) {
        try {
          rmSync(join(dataDir, f), { force: true });
          removedFiles.push(f);
        } catch (err) {
          const message = (err as Error).message;
          failedFiles.push({ file: f, error: message });
          log(`  WARN: failed to wipe ${f}: ${message}`);
        }
      }
    }
  } catch (err) {
    const message = (err as Error).message;
    failedFiles.push({ file: dataDir, error: message });
    log(`  WARN: failed to list publish journals in ${dataDir}: ${message}`);
  }

  for (const f of removedFiles) log(`  removed: ${f}`);
  return { removedFiles, backedUpFiles, failedFiles };
}

export async function chainResetWipe(
  opts: ChainResetWipeOptions,
): Promise<ChainResetWipeResult> {
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  // Networks that haven't opted in: hook is a no-op. No state file is
  // touched so we don't accidentally turn on the protocol later just
  // because some leftover state file made the comparison non-trivial.
  if (opts.currentMarker === undefined) {
    return { wiped: false, skipped: false, prevMarker: null, removedFiles: [], backedUpFiles: [], failedFiles: [] };
  }

  const prev = loadState(opts.dataDir);
  const prevMarker = prev?.chainResetMarker ?? null;

  if (prevMarker === opts.currentMarker) {
    return { wiped: false, skipped: false, prevMarker, removedFiles: [], backedUpFiles: [], failedFiles: [] };
  }

  // Dev-loop opt-out. A wipe WOULD run here (marker mismatch, including
  // first-boot-with-marker), but `DKG_SKIP_CHAIN_RESET_WIPE=1` bypasses it
  // entirely and — crucially — does NOT persist the marker, so unsetting the
  // env var re-triggers the wipe on the next boot. This keeps the operator
  // guarantee intact while letting developers hop between marker-pinned
  // worktrees without losing their local store. No file wipe, no external
  // SPARQL wipe, no marker write.
  if (opts.skip === true) {
    log(
      `Chain reset wipe skipped (DKG_SKIP_CHAIN_RESET_WIPE=1): marker ${prevMarker ?? '<none>'} → ${opts.currentMarker}. ` +
      `Local chain-state preserved; unset the env var to wipe.`,
    );
    return { wiped: false, skipped: true, prevMarker, removedFiles: [], backedUpFiles: [], failedFiles: [] };
  }

  // Mismatch (including "first boot with marker present"): wipe.
  // First-boot wipe is a deliberate choice: the only way an existing
  // install reaches this branch is by upgrading INTO a release that
  // carries a marker — which means the maintainer just bumped the
  // marker as part of a chain reset, and stale state must go.
  if (prevMarker === null) {
    log(
      `Chain reset marker first detected: ${opts.currentMarker}. Wiping per-node chain-state derived files (operator identity preserved)...`,
    );
  } else {
    log(
      `Chain reset detected: marker ${prevMarker} → ${opts.currentMarker}. Wiping per-node chain-state derived files (operator identity preserved)...`,
    );
  }

  // Wipe failures are logged but do not crash boot. Crucially, we only
  // persist the marker after every targeted file was removed cleanly; a
  // partial wipe must retry on next boot instead of being masked forever.
  let removedFiles: string[] = [];
  let backedUpFiles: string[] = [];
  let failedFiles: Array<{ file: string; error: string }> = [];
  let markerPersisted = false;
  try {
    ({ removedFiles, backedUpFiles, failedFiles } = performWipe(
      opts.dataDir,
      opts.randomSamplingWalPath,
      log,
      { currentMarker: opts.currentMarker },
    ));
  } catch (err) {
    const message = (err as Error).message;
    failedFiles.push({ file: '<chain-state-wipe>', error: message });
    log(
      `WARN: chain-state wipe encountered unexpected error: ${message}. Continuing boot on stale state.`,
    );
  }

  // External SPARQL wipe runs AFTER local file wipe. We don't gate one
  // on the other — both wipes attempt independently so an operator with
  // a flaky external endpoint still gets a clean local state and a
  // failedFiles entry that retries on next boot. Wrapped in try/catch
  // because helper construction (URL extraction) can throw on malformed
  // config; we want to surface that as a failedFile, not crash the boot.
  if (opts.storeConfig && isExternalBackend(opts.storeConfig.backend)) {
    try {
      const result = await performExternalWipe(opts.storeConfig, fetchImpl, log);
      if (result.ok) {
        removedFiles.push(result.label);
      } else {
        failedFiles.push({ file: result.label, error: result.error ?? 'unknown' });
      }
    } catch (err) {
      const message = (err as Error).message;
      failedFiles.push({ file: '<external-wipe>', error: message });
      log(`WARN: external SPARQL wipe failed to start: ${message}.`);
    }
  }

  if (failedFiles.length === 0) {
    try {
      saveState(opts.dataDir, opts.currentMarker);
      markerPersisted = true;
    } catch (err) {
      log(
        `WARN: failed to persist chain reset marker (${opts.currentMarker}): ${(err as Error).message}. Wipe will retry on next boot.`,
      );
    }
  } else {
    log(
      `WARN: chain-state wipe incomplete (${failedFiles.length} failure${failedFiles.length === 1 ? '' : 's'}). ` +
      'Chain reset marker was not persisted; wipe will retry on next boot.',
    );
  }
  if (failedFiles.length === 0 && markerPersisted) {
    log('Chain-state wipe complete. Continuing boot.');
  } else if (failedFiles.length === 0) {
    log('Chain-state wipe complete, but marker was not persisted. Continuing boot; wipe will retry on next boot.');
  } else {
    log('Chain-state wipe incomplete. Continuing boot so operator can repair filesystem state.');
  }

  return { wiped: true, skipped: false, prevMarker, removedFiles, backedUpFiles, failedFiles };
}

// =====================================================================
// Backend switch detection (RFC 120 review point #6)
// =====================================================================
//
// Switching from Oxigraph to Blazegraph (or vice versa) mid-flight means
// the new backend is fresh and empty — all SWM / VM data from the
// previous backend is unreachable. The chain-reset-wipe marker doesn't
// move when only the backend changes, so without a separate signal the
// daemon would silently boot on an empty store and the operator would
// see vanished context graphs with no explanation.
//
// This check runs at boot, BEFORE config validation / health probe /
// chain-reset wipe. Outcomes:
//   - First boot (no persisted lastBackend): silently record current.
//   - Match: silently re-record (handles legacy state files that lacked
//     the field).
//   - Mismatch + `acceptStoreReset === true`: log warning, record new.
//   - Mismatch + no override: log multi-line warning, return aborted.
//     Caller (lifecycle) exits the process.
//
// `acceptStoreReset` is controlled by the env var
// `DKG_ACCEPT_STORE_RESET=1`. A CLI flag on `dkg start` would also work
// but env keeps the boot entrypoint flat; operators set the env once,
// restart the daemon, then unset.

export interface BackendSwitchDetectOptions {
  dataDir: string;
  /**
   * Backend name from the current config. Pass the effective value
   * including the default — e.g. when `config.store?.backend` is
   * undefined, callers should pass `'oxigraph-worker'` so the check
   * is symmetric across "no store block" ↔ "explicit store block".
   */
  currentBackend: string;
  /**
   * Operator opt-in to proceed despite a backend change. Sourced from
   * `process.env.DKG_ACCEPT_STORE_RESET === '1'` in production; tests
   * inject explicitly.
   */
  acceptStoreReset: boolean;
  log?: (msg: string) => void;
}

export interface BackendSwitchDetectResult {
  /** True when `lastBackend` was recorded and differs from `currentBackend`. */
  changed: boolean;
  /** Previously-recorded backend, or null if none / legacy state file. */
  previous: string | null;
  /** Effective current backend (passed through for callers). */
  current: string;
  /**
   * True when the daemon should abort boot. Set on `changed && !acceptStoreReset`.
   * Caller exits the process so the operator can either flip the env
   * var or revert their config edit.
   */
  aborted: boolean;
}

export function detectBackendSwitch(
  opts: BackendSwitchDetectOptions,
): BackendSwitchDetectResult {
  const log = opts.log ?? (() => {});
  const prev = loadState(opts.dataDir);
  const previous =
    typeof prev?.lastBackend === 'string' && prev.lastBackend.length > 0
      ? prev.lastBackend
      : null;

  // First boot or legacy state file: silently record and move on. We
  // explicitly do NOT treat null-previous as a "switch from
  // oxigraph-worker"; that would re-warn every operator who upgrades
  // into this release without ever having touched their store
  // configuration. Only operator-visible config changes between two
  // recorded backends count as a switch.
  if (previous === null) {
    try {
      saveBackendTag(opts.dataDir, opts.currentBackend);
    } catch {
      // Non-fatal: if we can't write the tag now, we'll try again next
      // boot. The downside is one missed early-warning window.
    }
    return { changed: false, previous: null, current: opts.currentBackend, aborted: false };
  }

  if (previous === opts.currentBackend) {
    return { changed: false, previous, current: opts.currentBackend, aborted: false };
  }

  // Mismatch.
  const warningHeader = [
    `[STORE-SWITCH] triple-store backend changed since last boot:`,
    `  previous: ${previous}`,
    `  current:  ${opts.currentBackend}`,
    ``,
    `The new backend is a fresh store. Any context graphs, shared`,
    `memory, or finalised assertions held only in the previous backend`,
    `are NOT migrated and will be inaccessible until you either:`,
    `  - revert config.store.backend to "${previous}", or`,
    `  - accept the data loss by setting DKG_ACCEPT_STORE_RESET=1 in`,
    `    the environment and restarting.`,
  ].join('\n');

  if (!opts.acceptStoreReset) {
    log(warningHeader);
    log(``);
    log(`Refusing to start: set DKG_ACCEPT_STORE_RESET=1 to proceed.`);
    return { changed: true, previous, current: opts.currentBackend, aborted: true };
  }

  log(warningHeader);
  log(``);
  log(`DKG_ACCEPT_STORE_RESET=1 set — proceeding with the new backend.`);
  try {
    saveBackendTag(opts.dataDir, opts.currentBackend);
  } catch (err) {
    log(`WARN: failed to persist new backend tag: ${(err as Error).message}. Will re-warn on next boot.`);
  }
  return { changed: true, previous, current: opts.currentBackend, aborted: false };
}

export interface NetworkSwitchDetectOptions {
  dataDir: string;
  /**
   * The resolved network this boot is using — the `networkConfig` overlay
   * name including the fallback (pass `resolveNetworkConfigName(config)`, so
   * a legacy config with no `networkConfig` is compared as its fallback,
   * `testnet`). Symmetric across "no networkConfig" ↔ "explicit networkConfig".
   */
  currentNetworkConfig: string;
  /**
   * Operator opt-in to proceed despite a network change. Sourced from
   * `process.env.DKG_ACCEPT_NETWORK_SWITCH === '1'` in production; tests
   * inject explicitly.
   */
  acceptNetworkSwitch: boolean;
  log?: (msg: string) => void;
}

export interface NetworkSwitchDetectResult {
  /** True when `lastNetworkConfig` was recorded and differs from current. */
  changed: boolean;
  /** Previously-recorded network, or null if none / legacy state file. */
  previous: string | null;
  /** Effective current network (passed through for callers). */
  current: string;
  /** True when the daemon should abort boot (`changed && !acceptNetworkSwitch`). */
  aborted: boolean;
}

/**
 * Guard against an operator repointing `config.networkConfig` at a different
 * network on an existing data dir. Mirrors {@link detectBackendSwitch}: the
 * store still holds the previous network's chain-derived state (KC ids,
 * merkle roots, publish-journal, RS WAL), which is meaningless on the new
 * chain — and `chainResetWipe` won't save us (mainnet overlays ship no
 * `chainResetMarker`, so its hook is inert). So on a recorded mismatch we
 * abort boot unless `DKG_ACCEPT_NETWORK_SWITCH=1`. First boot / legacy state
 * silently records and proceeds.
 */
export function detectNetworkSwitch(
  opts: NetworkSwitchDetectOptions,
): NetworkSwitchDetectResult {
  const log = opts.log ?? (() => {});
  const prev = loadState(opts.dataDir);
  const previous =
    typeof prev?.lastNetworkConfig === 'string' && prev.lastNetworkConfig.length > 0
      ? prev.lastNetworkConfig
      : null;

  // First boot or legacy state file: silently record and move on. We do NOT
  // treat null-previous as a switch — that would abort every operator who
  // upgrades into this release without ever changing networks. (Parity with
  // detectBackendSwitch.) Limitation: a networkConfig edit made in the SAME
  // upgrade window — before any post-upgrade boot records the tag — is not
  // caught; this records the new network as the baseline. Subsequent edits
  // are caught normally.
  if (previous === null) {
    try {
      saveNetworkTag(opts.dataDir, opts.currentNetworkConfig);
    } catch {
      // Non-fatal: retry the tag write next boot.
    }
    return { changed: false, previous: null, current: opts.currentNetworkConfig, aborted: false };
  }

  if (previous === opts.currentNetworkConfig) {
    return { changed: false, previous, current: opts.currentNetworkConfig, aborted: false };
  }

  // Mismatch.
  const warningHeader = [
    `[NETWORK-SWITCH] node network changed since last boot:`,
    `  previous: ${previous}`,
    `  current:  ${opts.currentNetworkConfig}`,
    ``,
    `The local store holds "${previous}" chain-derived data (knowledge`,
    `collection ids, merkle roots, publish journal, random-sampling WAL)`,
    `that is meaningless on "${opts.currentNetworkConfig}". Booting over it`,
    `risks silent corruption and real-money chain operations against stale`,
    `state. Either:`,
    `  - revert config.networkConfig to "${previous}", or`,
    `  - start the new network from a clean home (recommended): set a fresh`,
    `    DKG_HOME, or`,
    `  - accept the stale store by setting DKG_ACCEPT_NETWORK_SWITCH=1 in`,
    `    the environment and restarting.`,
  ].join('\n');

  if (!opts.acceptNetworkSwitch) {
    log(warningHeader);
    log(``);
    log(`Refusing to start: set DKG_ACCEPT_NETWORK_SWITCH=1 to proceed.`);
    return { changed: true, previous, current: opts.currentNetworkConfig, aborted: true };
  }

  log(warningHeader);
  log(``);
  log(`DKG_ACCEPT_NETWORK_SWITCH=1 set — proceeding on the new network.`);
  try {
    saveNetworkTag(opts.dataDir, opts.currentNetworkConfig);
  } catch (err) {
    log(`WARN: failed to persist new network tag: ${(err as Error).message}. Will re-warn on next boot.`);
  }
  return { changed: true, previous, current: opts.currentNetworkConfig, aborted: false };
}
