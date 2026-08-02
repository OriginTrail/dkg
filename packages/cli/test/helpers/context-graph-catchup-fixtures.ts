import type { CatchupJobResult } from '../../src/catchup-runner.js';

type CleanPlaneCompletions = NonNullable<
  CatchupJobResult['cleanPlaneCompletions']
>;
type CatchupDiagnostics = NonNullable<CatchupJobResult['diagnostics']>;

export type CatchupJobResultOverrides = Omit<
  Partial<CatchupJobResult>,
  'cleanPlaneCompletions' | 'diagnostics'
> & {
  cleanPlaneCompletions?: {
    durable?: Partial<CleanPlaneCompletions['durable']>;
    sharedMemory?: Partial<CleanPlaneCompletions['sharedMemory']>;
  };
  diagnostics?: {
    noProtocolPeers?: number;
    durable?: Partial<CatchupDiagnostics['durable']>;
    sharedMemory?: Partial<CatchupDiagnostics['sharedMemory']>;
  };
};

/** Complete canonical result factory; scenario helpers override only their signal. */
export function makeCatchupJobResult(
  overrides: CatchupJobResultOverrides = {},
): CatchupJobResult {
  const defaults = {
    connectedPeers: 1,
    totalPeers: 1,
    selectedPeers: 1,
    syncCapablePeers: 1,
    peersTried: 1,
    peersResponded: 1,
    peersSucceeded: 1,
    deferredBackpressure: 0,
    dataSynced: 0,
    sharedMemorySynced: 0,
    denied: false,
    deniedPeers: 0,
    cleanPlaneCompletions: {
      durable: {
        verifiedDataPeers: 0,
        verifiedPrivateOnlyPeers: 0,
        emptyPeers: 1,
      },
      sharedMemory: {
        verifiedDataPeers: 0,
        emptyPeers: 1,
      },
    },
    diagnostics: {
      noProtocolPeers: 0,
      durable: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        timedOutPhases: 0,
        completedPhases: 2,
        checkpointAdvances: 0,
        emptyResponses: 1,
        metaOnlyResponses: 0,
        verifiedPrivateOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
        failedPhases: 0,
        deferredBackpressure: 0,
      },
      sharedMemory: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 0,
        insertedMetaTriples: 0,
        insertedDataTriples: 0,
        bytesReceived: 0,
        resumedPhases: 0,
        timedOutPhases: 0,
        completedPhases: 2,
        checkpointAdvances: 0,
        emptyResponses: 1,
        droppedDataTriples: 0,
        failedPeers: 0,
        failedPhases: 0,
        deferredBackpressure: 0,
      },
    },
  } satisfies CatchupJobResult;

  return {
    ...defaults,
    ...overrides,
    cleanPlaneCompletions: {
      durable: {
        ...defaults.cleanPlaneCompletions.durable,
        ...overrides.cleanPlaneCompletions?.durable,
      },
      sharedMemory: {
        ...defaults.cleanPlaneCompletions.sharedMemory,
        ...overrides.cleanPlaneCompletions?.sharedMemory,
      },
    },
    diagnostics: {
      noProtocolPeers:
        overrides.diagnostics?.noProtocolPeers ?? defaults.diagnostics.noProtocolPeers,
      durable: {
        ...defaults.diagnostics.durable,
        ...overrides.diagnostics?.durable,
      },
      sharedMemory: {
        ...defaults.diagnostics.sharedMemory,
        ...overrides.diagnostics?.sharedMemory,
      },
    },
  };
}

export function cleanEmptyResult(): CatchupJobResult {
  return makeCatchupJobResult();
}

export function privateMetaOnlyResult(): CatchupJobResult {
  return makeCatchupJobResult({
    cleanPlaneCompletions: {
      durable: { emptyPeers: 0 },
    },
    diagnostics: {
      durable: {
        emptyResponses: 0,
        fetchedMetaTriples: 7,
        insertedMetaTriples: 1,
        metaOnlyResponses: 1,
      },
    },
  });
}

export function privateDataOnlyResult(): CatchupJobResult {
  return makeCatchupJobResult({
    dataSynced: 3,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers: 1, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0 },
    },
    diagnostics: {
      durable: {
        emptyResponses: 0,
        fetchedDataTriples: 3,
        insertedDataTriples: 3,
      },
      sharedMemory: {
        emptyResponses: 0,
        completedPhases: 0,
        timedOutPhases: 1,
      },
    },
  });
}

export function privateSharedMemoryOnlyResult(): CatchupJobResult {
  return makeCatchupJobResult({
    sharedMemorySynced: 4,
    cleanPlaneCompletions: {
      sharedMemory: { verifiedDataPeers: 1, emptyPeers: 0 },
    },
    diagnostics: {
      sharedMemory: {
        emptyResponses: 0,
        fetchedDataTriples: 4,
        insertedDataTriples: 4,
      },
    },
  });
}

export function publicDurableAndSharedMemoryResult(): CatchupJobResult {
  return makeCatchupJobResult({
    dataSynced: 3,
    sharedMemorySynced: 4,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers: 1, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 1, emptyPeers: 0 },
    },
    diagnostics: {
      durable: {
        emptyResponses: 0,
        fetchedDataTriples: 3,
        insertedDataTriples: 3,
      },
      sharedMemory: {
        emptyResponses: 0,
        fetchedDataTriples: 4,
        insertedDataTriples: 4,
      },
    },
  });
}

/** Durable VM completed, but the shared-memory scheduler deferred its plane. */
export function publicDurableWithSharedMemoryBackpressureResult(): CatchupJobResult {
  return makeCatchupJobResult({
    deferredBackpressure: 1,
    dataSynced: 3,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers: 1, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0 },
    },
    diagnostics: {
      durable: {
        emptyResponses: 0,
        fetchedDataTriples: 3,
        insertedDataTriples: 3,
      },
      sharedMemory: {
        emptyResponses: 0,
        completedPhases: 0,
        deferredBackpressure: 1,
      },
    },
  });
}

/** One public host proves empty while another selected peer transport-fails. */
export function lossyPublicEmptyResult(): CatchupJobResult {
  return makeCatchupJobResult({
    connectedPeers: 2,
    totalPeers: 2,
    selectedPeers: 2,
    syncCapablePeers: 2,
    peersTried: 2,
    peersResponded: 1,
    peersSucceeded: 1,
    cleanPlaneCompletions: {
      durable: { emptyPeers: 1 },
    },
    diagnostics: {
      durable: { failedPeers: 1 },
    },
  });
}
