// SPDX-License-Identifier: Apache-2.0
import { isExternalBackend } from '@origintrail-official/dkg-storage';
import { exitOnStoreConfigErrors, type DkgConfig } from '../config.js';
import type { OxigraphServerHandle } from './oxigraph-server.js';
import {
  chainResetWipe, formatChainResetWipeOutcome, skipChainResetWipe,
} from './chain-reset-wipe.js';
import {
  checkExternalStoreReachable, checkOrSetStoreIdentity,
  formatHealthCheckFailure, formatIdentityTagMismatch,
} from './store-health-check.js';

interface PreAgentStoreBootOptions {
  managedOxigraph: Pick<OxigraphServerHandle, 'registerStoreActivity'> | null;
  runtimeStore: Parameters<typeof checkExternalStoreReachable>[0]['storeConfig'];
  runtimeStoreConfig: DkgConfig;
  dataDir: string;
  chainResetMarker?: string;
  randomSamplingWalPath?: string;
  nodeName: string;
  log: (message: string) => void;
}

/** Fence direct requests before the adapter exists; preserve validate/probe/tag/wipe/re-tag order. */
export async function runPreAgentStoreBootSteps(options: PreAgentStoreBootOptions): Promise<void> {
  const { log } = options;
  const activity = options.managedOxigraph?.registerStoreActivity();
  try {
    activity?.report(true);
    // Refuse to start on invalid external-backend config (missing URL,
    // missing blob/snapshot directory). This fires before the health
    // check so operators see a single-line config error, not a confusing
    // probe failure when the URL is just plain absent.
    exitOnStoreConfigErrors(options.runtimeStoreConfig, log);

    // External triple-store backends (Blazegraph, sparql-http) get a
    // boot-time reachability probe before anything that depends on them
    // runs. We want operators who misconfigure the URL to see an
    // actionable error within seconds — not a confusing failure deep in
    // agent boot after we've already partially wiped local state.
    //
    // Sequencing: this fires BEFORE chainResetWipe so a marker bump
    // against an unreachable endpoint doesn't strand the operator with
    // wiped local files but stale remote data; we'd rather not start at
    // all and let them fix the URL.
    if (isExternalBackend(options.runtimeStore?.backend)) {
      const health = await checkExternalStoreReachable({
        storeConfig: options.runtimeStore,
      });
      if (!health.ok) {
        log(formatHealthCheckFailure(health));
        process.exit(1);
      }
      log(
        `External triple-store reachable: ${health.backend} ${health.endpoint}`,
      );

      // Namespace identity check (RFC 120, plan PR 3 item 3). Refuses to
      // start if another DKG node has already booted against this same
      // namespace — without this, two daemons sharing one Blazegraph
      // namespace silently corrupt each other. Fires BEFORE
      // chainResetWipe so a mismatched tag never triggers a wipe of
      // someone else's data.
      await ensureStoreIdentityOrExit(options.runtimeStore, options.nodeName, log, 'startup');
    }

    const wipeResult = await chainResetWipe({
      dataDir: options.dataDir,
      currentMarker: options.chainResetMarker,
      // Dev-loop opt-out: when set, bypass the wipe entirely and don't persist
      // the marker (unsetting it re-triggers the wipe). Operator nodes leave it
      // unset and keep wiping by default on a marker change. See issue #679.
      skip: skipChainResetWipe(),
      // Honour operator's `randomSampling.walPath` override; the prover
      // writes its WAL there, so a fresh chain reset must wipe that file
      // (not the default ~/.dkg/random-sampling.wal which would be empty).
      randomSamplingWalPath: options.randomSamplingWalPath,
      // For external triple-store backends, the wipe extends from local
      // files to a SPARQL DROP/DELETE on the remote endpoint; otherwise
      // operators with a chain-reset marker bump would keep stale V10 data
      // in Blazegraph / sparql-http even after the local store.nq is gone.
      storeConfig: options.runtimeStore,
      log,
    });
    for (const message of formatChainResetWipeOutcome(wipeResult, options.chainResetMarker)) {
      log(message);
    }
    if (wipeResult.requiresStoreRetag) {
      // A DKG-managed DROP ALL may have removed the namespace ownership tag.
      // Re-tag even when cleanup or marker persistence failed: the remote
      // request can take effect independently of those local outcomes.
      if (isExternalBackend(options.runtimeStore?.backend)) {
        await ensureStoreIdentityOrExit(options.runtimeStore, options.nodeName, log, 'post-wipe');
      }
    }
  } finally {
    activity?.dispose();
  }
}

type StoreIdentityPhase = 'startup' | 'post-wipe';

async function ensureStoreIdentityOrExit(
  storeConfig: Parameters<typeof checkOrSetStoreIdentity>[0]['storeConfig'],
  nodeName: string,
  log: (message: string) => void,
  phase: StoreIdentityPhase,
): Promise<void> {
  const identity = await checkOrSetStoreIdentity({ storeConfig, nodeName });
  if (!identity.ok) {
    if (identity.action === 'mismatch') {
      log(formatIdentityTagMismatch(identity));
    } else {
      const action = phase === 'post-wipe' ? 're-tag' : 'verify namespace ownership';
      log(`[STORE-IDENTITY] failed to ${action}: ${identity.error}`);
    }
    process.exit(1);
  }
  if (identity.action === 'tagged') {
    log(phase === 'post-wipe'
      ? `Re-tagged triple-store namespace for node "${identity.nodeName}" after chain-state wipe.`
      : `Tagged triple-store namespace for node "${identity.nodeName}".`);
  }
}
