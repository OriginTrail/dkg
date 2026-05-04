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
 * hand — see docs/TESTNET_RESET.md Phase C for the manual drill.
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
 *
 * Files wiped: `store.nq`, `store.nq.tmp`, `random-sampling.wal`,
 *              `publish-journal.*` (all variants from publisher-runner).
 *
 * Files preserved: `wallets.json` (operator identity), `auth.token`,
 *              `config.json`, `node-ui.db` (dashboard state),
 *              `files/` (uploaded files), auto-update markers.
 *
 * Per the runbook contract: keystore stays so the wallet identity is
 * constant across resets, and `ensureProfile` re-derives the on-chain
 * identityId on the new chain cleanly.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const STATE_FILE = '.network-state.json';

interface PersistedNetworkState {
  /** Last chainResetMarker value the daemon booted on. */
  chainResetMarker: string | null;
  savedAt: number;
}

export interface ChainResetWipeResult {
  /** True when a wipe was performed. */
  wiped: boolean;
  /** The marker we had persisted before this boot, or null on first boot / no persisted state. */
  prevMarker: string | null;
  /** Files removed during the wipe (relative to dataDir). Empty when `wiped=false`. */
  removedFiles: string[];
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
  /** Optional logger. Defaults to no-op so the function is silent in tests by default. */
  log?: (msg: string) => void;
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
  writeFileSync(
    join(dataDir, STATE_FILE),
    JSON.stringify(
      { chainResetMarker: marker, savedAt: Date.now() } satisfies PersistedNetworkState,
      null,
      2,
    ),
  );
}

function performWipe(
  dataDir: string,
  walPath: string | undefined,
  log: (msg: string) => void,
): { removedFiles: string[]; failedFiles: Array<{ file: string; error: string }> } {
  const removedFiles: string[] = [];
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

  wipeAbs(join(dataDir, 'store.nq'), 'store.nq');
  wipeAbs(join(dataDir, 'store.nq.tmp'), 'store.nq.tmp');

  // Random sampling WAL: wipe the resolved runtime path (which the
  // operator may have moved out of dataDir via `randomSampling.walPath`).
  // Defaulting to dataDir/random-sampling.wal keeps the historical
  // behaviour for operators who never set the config knob.
  const walAbs = walPath && walPath.length > 0
    ? walPath
    : join(dataDir, 'random-sampling.wal');
  const walLabel = walAbs.startsWith(dataDir)
    ? walAbs.slice(dataDir.length).replace(/^\/+/, '')
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
  return { removedFiles, failedFiles };
}

export function chainResetWipe(opts: ChainResetWipeOptions): ChainResetWipeResult {
  const log = opts.log ?? (() => {});

  // Networks that haven't opted in: hook is a no-op. No state file is
  // touched so we don't accidentally turn on the protocol later just
  // because some leftover state file made the comparison non-trivial.
  if (opts.currentMarker === undefined) {
    return { wiped: false, prevMarker: null, removedFiles: [], failedFiles: [] };
  }

  const prev = loadState(opts.dataDir);
  const prevMarker = prev?.chainResetMarker ?? null;

  if (prevMarker === opts.currentMarker) {
    return { wiped: false, prevMarker, removedFiles: [], failedFiles: [] };
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
  let failedFiles: Array<{ file: string; error: string }> = [];
  let markerPersisted = false;
  try {
    ({ removedFiles, failedFiles } = performWipe(opts.dataDir, opts.randomSamplingWalPath, log));
  } catch (err) {
    const message = (err as Error).message;
    failedFiles.push({ file: '<chain-state-wipe>', error: message });
    log(
      `WARN: chain-state wipe encountered unexpected error: ${message}. Continuing boot on stale state.`,
    );
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

  return { wiped: true, prevMarker, removedFiles, failedFiles };
}
