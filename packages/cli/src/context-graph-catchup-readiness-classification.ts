import type { ContextGraphReadinessProvenance } from '@origintrail-official/dkg-node-ui';
import {
  catchupPlaneCompletedWithoutFailure,
  catchupPlaneProvenByAuthorityHostedEmpty,
  catchupPlaneProvenByData,
  catchupPlaneProvenBySelectedScope,
  catchupPlaneProvenByUnanimousEmpty,
  catchupPlaneReady,
} from './catchup-proof.js';
import type { CatchupJobResult } from './catchup-runner.js';
import {
  composeContextGraphPlaneEvidence,
  reduceContextGraphPlaneEvidence,
  type ContextGraphPlaneEvidence,
  type ContextGraphReadinessPatch,
} from './context-graph-readiness-policy.js';

export interface ContextGraphPlaneReadinessVerdict {
  /** Compatibility/write-readiness: either persisted usable plane opens the graph. */
  readonly writeReady: boolean;
  /** Catch-up completion: applicable VM plus SWM when the caller requested it. */
  readonly requestedPlanesVerified: boolean;
  readonly missingRequestedDurable: boolean;
  readonly missingRequestedSharedMemory: boolean;
}

export function contextGraphPlaneReadinessVerdict(input: {
  durableVerified: boolean;
  sharedMemoryVerified: boolean;
  includeSharedMemory: boolean;
  registration?: 'unregistered';
}): ContextGraphPlaneReadinessVerdict {
  const missingRequestedDurable = input.registration !== 'unregistered' && !input.durableVerified;
  const missingRequestedSharedMemory =
    input.includeSharedMemory && !input.sharedMemoryVerified;
  return {
    writeReady: input.durableVerified || input.sharedMemoryVerified,
    requestedPlanesVerified:
      !missingRequestedDurable && !missingRequestedSharedMemory,
    missingRequestedDurable,
    missingRequestedSharedMemory,
  };
}

interface CatchupPlaneReadinessThisRun {
  /** Whether this plane counts as ready for THIS run's reported job status. */
  ready: boolean;
  /**
   * Whether the evidence is strong enough to PERSIST as sticky readiness
   * provenance. Verified content earns it outright. Unanimous-empty evidence
   * is persistable only when every attempted peer answered.
   */
  persistable: boolean;
}

function catchupPlaneReadinessThisRun(input: {
  result: CatchupJobResult;
  plane: 'durable' | 'sharedMemory';
  isPrivate: boolean;
}): CatchupPlaneReadinessThisRun {
  const diagnostics = input.result.diagnostics?.[input.plane];
  const completion = input.result.cleanPlaneCompletions?.[input.plane];
  const options = { isPrivate: input.isPrivate };
  const fullyAccounted = (diagnostics?.failedPeers ?? 0) === 0;
  if (completion) {
    const provenPositively = catchupPlaneProvenByData(completion)
      || catchupPlaneProvenBySelectedScope(completion)
      || catchupPlaneProvenByAuthorityHostedEmpty(completion, diagnostics, options);
    const unanimousEmpty = catchupPlaneProvenByUnanimousEmpty(completion, diagnostics, options);
    return {
      ready: provenPositively || unanimousEmpty,
      persistable: provenPositively || (unanimousEmpty && fullyAccounted),
    };
  }

  // Backward compatibility for callers that construct a legacy result. New
  // worker results always carry cleanPlaneCompletions, so aggregate failures
  // are not used as readiness evidence on the production path.
  const dataProgress = input.plane === 'durable'
    ? input.result.dataSynced > 0 ||
      (input.result.diagnostics?.durable.verifiedPrivateOnlyResponses ?? 0) > 0
    : input.result.sharedMemorySynced > 0;
  if (catchupPlaneCompletedWithoutFailure(diagnostics) && dataProgress) {
    return { ready: true, persistable: true };
  }
  const ready = catchupPlaneReady(undefined, diagnostics, options);
  return {
    ready,
    persistable: ready && fullyAccounted,
  };
}

export interface DerivedCatchupReadiness {
  readonly statePatch: {
    readonly synced: boolean;
    readonly sharedMemorySynced: boolean;
    readonly metaSynced: true;
    readonly pendingMeta: false;
  };
  readonly readinessPatch: ContextGraphReadinessPatch;
  readonly eventPayload?: {
    readonly dataSynced: number;
    readonly sharedMemorySynced: number;
    readonly verifiedPrivateOnlyResponses: number;
  };
  readonly planeReadiness: ContextGraphPlaneReadinessVerdict;
  readonly madeIncompleteProgress: boolean;
  readonly sharedMemoryVerified: boolean;
}

/** Derive sticky readiness independently from the foreground job's terminal status. */
export function deriveCatchupReadiness(input: {
  result: CatchupJobResult;
  includeSharedMemory: boolean;
  isPrivate: boolean;
  registration?: 'unregistered';
  readinessBeforeCatchup: ContextGraphReadinessProvenance;
  cleanPeerEvidence: boolean;
  independentDurable: ContextGraphPlaneEvidence;
  independentSharedMemory: ContextGraphPlaneEvidence;
}): DerivedCatchupReadiness {
  const {
    result, includeSharedMemory, isPrivate, registration, readinessBeforeCatchup,
    cleanPeerEvidence, independentDurable, independentSharedMemory,
  } = input;
  const noEvidence = { ready: false, persistable: false } as const;
  const peerDurable = cleanPeerEvidence
    ? catchupPlaneReadinessThisRun({ result, plane: 'durable', isPrivate })
    : noEvidence;
  const peerSharedMemory = cleanPeerEvidence && includeSharedMemory
    ? catchupPlaneReadinessThisRun({ result, plane: 'sharedMemory', isPrivate })
    : noEvidence;
  const durableThisRun = composeContextGraphPlaneEvidence(peerDurable, independentDurable);
  const sharedMemoryThisRun = composeContextGraphPlaneEvidence(
    peerSharedMemory, independentSharedMemory,
  );
  const reduced = reduceContextGraphPlaneEvidence(readinessBeforeCatchup, {
    durable: durableThisRun,
    sharedMemory: sharedMemoryThisRun,
  });
  const { durableVerified, sharedMemoryVerified } = reduced.observed;
  const planeReadiness = contextGraphPlaneReadinessVerdict({
    durableVerified,
    sharedMemoryVerified,
    includeSharedMemory,
    registration,
  });
  const durableReadyThisRun = durableThisRun.ready;
  const sharedMemoryReadyThisRun = sharedMemoryThisRun.ready;
  return {
    planeReadiness,
    madeIncompleteProgress:
      (result.dataSynced > 0 && !durableReadyThisRun)
      || (result.sharedMemorySynced > 0 && !sharedMemoryReadyThisRun),
    sharedMemoryVerified,
    statePatch: {
      synced: reduced.writeReady,
      sharedMemorySynced: reduced.persisted.sharedMemoryVerified,
      metaSynced: true,
      pendingMeta: false,
    },
    readinessPatch: reduced.persisted,
    eventPayload: durableReadyThisRun || sharedMemoryReadyThisRun
      ? {
          dataSynced: durableReadyThisRun ? result.dataSynced : 0,
          sharedMemorySynced: sharedMemoryReadyThisRun ? result.sharedMemorySynced : 0,
          verifiedPrivateOnlyResponses: durableReadyThisRun
            ? result.cleanPlaneCompletions?.durable.verifiedPrivateOnlyPeers
              ?? result.diagnostics?.durable.verifiedPrivateOnlyResponses
              ?? 0
            : 0,
        }
      : undefined,
  };
}
