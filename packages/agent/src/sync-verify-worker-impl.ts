import { parentPort } from 'node:worker_threads';
import { validateSubGraphName } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncVerifyResult, SyncVerifyLogEntry, SyncParseResult, SharedMemoryProcessResult, DurableBatchProcessResult, DurableBatchProcessWireResult, DurableBatchVerificationMode, SharedMemoryBatchProcessResult } from './sync-verify-worker.js';
import { isSharedMemoryBucketDescendantDataGraph } from './sync/shared-memory-graphs.js';
import { admitSharedMemoryMetadata, type AdmittedSharedMemoryMetadata } from './sync/shared-memory-metadata-admission.js';
import {
  selectVerifiedDurableSyncQuads,
  type DurableIntegrityVerificationMode,
} from './sync/durable-integrity.js';


// Guarded so this module is importable on the main thread (unit tests import
// `verifySyncedData` directly); in a real worker `parentPort` is always set.
parentPort?.on('message', async (message: { id: number; method: string; args: unknown[] }) => {
  try {
    if (message.method === 'verify') {
      const [dataQuads, metaQuads, acceptUnverified] = message.args as [Quad[], Quad[], boolean];
      const result = verifySyncedData(dataQuads, metaQuads, acceptUnverified);
      parentPort!.postMessage({ id: message.id, result });
      return;
    }
    if (message.method === 'parseAndFilter') {
      const [nquadsText, graphUri, contextGraphId] = message.args as [string, string, string];
      const result = parseAndFilterNQuads(nquadsText, graphUri, contextGraphId);
      parentPort!.postMessage({ id: message.id, result });
      return;
    }
    if (message.method === 'processSharedMemory') {
      const [wsDataQuads, wsMetaQuads] = message.args as [Quad[], Quad[]];
      const result = processSharedMemory(wsDataQuads, wsMetaQuads);
      parentPort!.postMessage({ id: message.id, result });
      return;
    }
    if (message.method === 'processDurableBatch') {
      const [dataQuads, metaQuads, acceptUnverified, mode] = message.args as [
        Quad[],
        Quad[],
        boolean,
        DurableBatchVerificationMode | undefined,
      ];
      const result = processDurableBatchForWire(
        dataQuads,
        metaQuads,
        acceptUnverified,
        mode,
      );
      parentPort!.postMessage({ id: message.id, result });
      return;
    }
    if (message.method === 'processSharedMemoryBatch') {
      const [wsDataQuads, wsMetaQuads, contextGraphId, registeredSubGraphNames, excludedSubGraphNames] =
        message.args as [Quad[], Quad[], string, readonly string[] | undefined, readonly string[] | undefined];
      const result = processSharedMemoryBatch(
        wsDataQuads,
        wsMetaQuads,
        contextGraphId,
        registeredSubGraphNames,
        excludedSubGraphNames,
      );
      parentPort!.postMessage({ id: message.id, result });
      return;
    }
    parentPort!.postMessage({ id: message.id, error: `Unknown method: ${message.method}` });
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});

export function verifySyncedData(
  dataQuads: Quad[],
  metaQuads: Quad[],
  acceptUnverified = false,
): SyncVerifyResult {
  return verifySyncedDataImpl(dataQuads, metaQuads, acceptUnverified);
}

function verifySyncedDataImpl(
  dataQuads: Quad[],
  metaQuads: Quad[],
  acceptUnverified = false,
): SyncVerifyResult {
  const selection = selectVerifiedDurableSyncQuads(
    dataQuads,
    metaQuads,
    acceptUnverified,
  );
  return {
    data: selection.dataIndexes.map((index) => dataQuads[index]!),
    meta: selection.metaIndexes.map((index) => metaQuads[index]!),
    rejected: selection.rejected,
    logs: selection.logs,
  };
}

function parseAndFilterNQuads(text: string, graphUri: string, contextGraphId: string): SyncParseResult {
  const rawQuads = parseNQuads(text);
  const cgUriPrefix = `did:dkg:context-graph:${contextGraphId}/`;
  const quads: Quad[] = [];
  const sourceIndexes: number[] = [];
  for (const [index, quad] of rawQuads.entries()) {
    if (quad.graph !== graphUri && !quad.graph.startsWith(cgUriPrefix)) continue;
    quads.push(quad);
    sourceIndexes.push(index);
  }
  return {
    quads,
    totalQuads: rawQuads.length,
    sourceIndexes,
  };
}

function processSharedMemory(
  wsDataQuads: Quad[],
  wsMetaQuads: Quad[],
): SharedMemoryProcessResult {
  return processAdmittedSharedMemory(wsDataQuads, admitSharedMemoryMetadata(wsMetaQuads, { kind: 'allGraphs' }));
}

function processAdmittedSharedMemory(
  wsDataQuads: Quad[],
  admitted: AdmittedSharedMemoryMetadata,
): SharedMemoryProcessResult {
  const validQuads = wsDataQuads.filter((quad) => {
    const allowed = allowedRootsForSwmDataGraph(admitted.legacyRoots, quad.graph);
    if (!allowed) return false;
    if (allowed.has(quad.subject)) return true;
    for (const root of allowed) {
      if (quad.subject.startsWith(`${root}/.well-known/genid/`)) return true;
    }
    return false;
  });
  return { validQuads, dropped: wsDataQuads.length - validQuads.length, entityCreators: admitted.ownership };
}

function allowedRootsForSwmDataGraph(
  allowedRootsByDataGraph: ReadonlyMap<string, ReadonlySet<string>>,
  graph: string,
): ReadonlySet<string> | undefined {
  const exact = allowedRootsByDataGraph.get(graph);
  if (exact) return exact;
  for (const [bucketGraph, allowed] of allowedRootsByDataGraph) {
    if (isSharedMemoryBucketDescendantDataGraph(graph, bucketGraph)) {
      return allowed;
    }
  }
  return undefined;
}

function combineRegisteredSubGraphNames(
  localNames: readonly string[] | undefined,
  excludedNames: readonly string[] | undefined,
): string[] {
  const out = new Set<string>();
  const excluded = new Set((excludedNames ?? []).filter((name) => validateSubGraphName(name).valid));
  for (const name of localNames ?? []) {
    if (validateSubGraphName(name).valid && !excluded.has(name)) out.add(name);
  }
  return [...out];
}

type DurableBatchSelectionResult = DurableBatchProcessResult & {
  verifiedDataIndexes: number[];
  verifiedMetaIndexes: number[];
};

function processDurableBatch(
  dataQuads: Quad[],
  metaQuads: Quad[],
  acceptUnverified: boolean,
  mode: DurableBatchVerificationMode = { kind: 'fullSnapshot' },
): DurableBatchSelectionResult {
  const logs: SyncVerifyLogEntry[] = [];
  const totalFetchedDataQuads = dataQuads.length;
  const totalFetchedMetaQuads = metaQuads.length;

  if (totalFetchedDataQuads === 0 && totalFetchedMetaQuads === 0) {
    return {
      verifiedData: [],
      verifiedMeta: [],
      verifiedDataIndexes: [],
      verifiedMetaIndexes: [],
      verifiedGraphScopedDataGraphs: [],
      droppedSyncControlTriples: 0,
      droppedNonIriSubjectTriples: 0,
      consumedUnpersistedMetaTriples: 0,
      verifiedPrivateOnlyResponses: 0,
      totalFetchedDataQuads,
      totalFetchedMetaQuads,
      rejectedKcs: 0,
      emptyResponses: 1,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
      logs,
    };
  }

  if (!acceptUnverified && totalFetchedDataQuads > 0 && totalFetchedMetaQuads === 0) {
    logs.push({
      level: 'warn',
      message: `Rejecting sync batch: received ${totalFetchedDataQuads} data triples but no meta — cannot verify merkle roots`,
    });
    return {
      verifiedData: [],
      verifiedMeta: [],
      verifiedDataIndexes: [],
      verifiedMetaIndexes: [],
      verifiedGraphScopedDataGraphs: [],
      droppedSyncControlTriples: 0,
      droppedNonIriSubjectTriples: 0,
      consumedUnpersistedMetaTriples: 0,
      verifiedPrivateOnlyResponses: 0,
      totalFetchedDataQuads,
      totalFetchedMetaQuads,
      rejectedKcs: 0,
      emptyResponses: 0,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 1,
      logs,
    };
  }

  const integrityMode = durableIntegrityMode(mode);
  const verifiedSelection = selectVerifiedDurableSyncQuads(
    dataQuads,
    metaQuads,
    acceptUnverified,
    integrityMode,
  );
  // A fully-private V2 KA legitimately has an empty public assertion graph.
  // Its metadata commits the private root and declares publicTripleCount=0,
  // so exact verification is enough to advance both durable cursors. Keep
  // treating every other meta-without-data response as potentially pruned.
  const verifiedFullyPrivateResponse = totalFetchedDataQuads === 0
    && verifiedSelection.rejected === 0
    && verifiedSelection.verifiedZeroPublicAssets > 0;
  // A since-batch response legitimately carries the full metadata phase even
  // when no asset is newer than the watermark. Once every descriptor was
  // cleanly classified out of scope, an empty DATA phase is clean delta
  // completion—not evidence of a pruned graph that should pin the cursor.
  const cleanEmptySinceBatchDelta = mode.kind === 'sinceBatchId'
    && totalFetchedDataQuads === 0
    && verifiedSelection.rejected === 0
    && verifiedSelection.dataIndexes.length === 0
    && verifiedSelection.verifiedZeroPublicAssets === 0;
  const metaOnlyResponses = !acceptUnverified
    && totalFetchedMetaQuads > 0
    && totalFetchedDataQuads === 0
    && !verifiedFullyPrivateResponse
    && !cleanEmptySinceBatchDelta
    ? 1
    : 0;
  if (metaOnlyResponses > 0) {
    logs.push({
      level: 'warn',
      message: `Sync batch received ${totalFetchedMetaQuads} meta triples but no data — peer may have empty or pruned data graph`,
    });
  }
  return {
    verifiedData: verifiedSelection.dataIndexes.map((index) => dataQuads[index]!),
    verifiedMeta: verifiedSelection.metaIndexes.map((index) => metaQuads[index]!),
    verifiedDataIndexes: verifiedSelection.dataIndexes,
    verifiedMetaIndexes: verifiedSelection.metaIndexes,
    verifiedGraphScopedDataGraphs: verifiedSelection.verifiedGraphScopedDataGraphs,
    droppedSyncControlTriples: verifiedSelection.droppedSyncControlTriples,
    droppedNonIriSubjectTriples: verifiedSelection.droppedNonIriSubjectTriples,
    // Transport the verifier-owned aggregate (#1921) — do NOT recompute the sum
    // here. The early-return branches above (empty page / data-without-meta)
    // bypass selection and set consumedUnpersistedMetaTriples: 0 explicitly.
    consumedUnpersistedMetaTriples: verifiedSelection.consumedUnpersistedMetaTriples,
    verifiedPrivateOnlyResponses: verifiedFullyPrivateResponse ? 1 : 0,
    totalFetchedDataQuads,
    totalFetchedMetaQuads,
    rejectedKcs: verifiedSelection.rejected,
    emptyResponses: 0,
    metaOnlyResponses,
    dataRejectedMissingMeta: 0,
    logs: [...logs, ...verifiedSelection.logs],
  };
}

function durableIntegrityMode(mode: DurableBatchVerificationMode): DurableIntegrityVerificationMode {
  if (mode.kind === 'fullSnapshot') return mode;
  if (mode.kind === 'changelogPage') {
    return { kind: 'changelogPage', changedDataGraphs: new Set(mode.changedDataGraphs) };
  }
  if (!/^\d+$/.test(mode.sinceBatchId)) {
    throw new Error(`Invalid sinceBatchId verification scope: ${mode.sinceBatchId}`);
  }
  return { kind: 'sinceBatchId', sinceBatchId: BigInt(mode.sinceBatchId) };
}

export function processDurableBatchForWire(
  dataQuads: Quad[],
  metaQuads: Quad[],
  acceptUnverified: boolean,
  mode: DurableBatchVerificationMode = { kind: 'fullSnapshot' },
): DurableBatchProcessWireResult {
  const result = processDurableBatch(
    dataQuads,
    metaQuads,
    acceptUnverified,
    mode,
  );
  const {
    verifiedDataIndexes,
    verifiedMetaIndexes,
    verifiedGraphScopedDataGraphs,
    droppedSyncControlTriples,
    droppedNonIriSubjectTriples,
    consumedUnpersistedMetaTriples,
    verifiedPrivateOnlyResponses,
    totalFetchedDataQuads,
    totalFetchedMetaQuads,
    rejectedKcs,
    emptyResponses,
    metaOnlyResponses,
    dataRejectedMissingMeta,
    logs,
  } = result;
  // Selection indexes are produced by the exact verification/filter pass,
  // avoiding any hidden dependency on Quad object identity or source order.
  return {
    verifiedDataIndexes,
    verifiedMetaIndexes,
    verifiedGraphScopedDataGraphs,
    droppedSyncControlTriples,
    droppedNonIriSubjectTriples,
    consumedUnpersistedMetaTriples,
    verifiedPrivateOnlyResponses,
    totalFetchedDataQuads,
    totalFetchedMetaQuads,
    rejectedKcs,
    emptyResponses,
    metaOnlyResponses,
    dataRejectedMissingMeta,
    logs,
  };
}

function processSharedMemoryBatch(
  wsDataQuads: Quad[],
  wsMetaQuads: Quad[],
  contextGraphId?: string,
  registeredSubGraphNames?: readonly string[],
  excludedSubGraphNames?: readonly string[],
): SharedMemoryBatchProcessResult {
  const totalFetchedDataQuads = wsDataQuads.length;
  const totalFetchedMetaQuads = wsMetaQuads.length;
  if (totalFetchedDataQuads === 0 && totalFetchedMetaQuads === 0) {
    return {
      verifiedData: [],
      verifiedMeta: [],
      totalFetchedDataQuads,
      totalFetchedMetaQuads,
      droppedDataTriples: 0,
      emptyResponses: 1,
      entityCreators: [],
    };
  }

  const effectiveRegisteredSubGraphNames = combineRegisteredSubGraphNames(
    registeredSubGraphNames,
    excludedSubGraphNames,
  );
  const admitted = admitSharedMemoryMetadata(wsMetaQuads, contextGraphId === undefined
    ? { kind: 'allGraphs' }
    : { kind: 'context', contextGraphId, registeredSubGraphNames: new Set(effectiveRegisteredSubGraphNames) });
  const processed = processAdmittedSharedMemory(wsDataQuads, admitted);
  return {
    verifiedData: processed.validQuads,
    verifiedMeta: admitted.metadata,
    totalFetchedDataQuads,
    totalFetchedMetaQuads,
    droppedDataTriples: processed.dropped,
    emptyResponses: 0,
    entityCreators: processed.entityCreators,
  };
}

function parseNQuads(text: string): Quad[] {
  const quads: Quad[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.endsWith(' .') ? trimmed.slice(0, -2).trim() : trimmed;
    const parts = splitNQuadLine(body);
    if (parts.length < 3) continue;
    quads.push({
      subject: strip(parts[0]),
      predicate: strip(parts[1]),
      object: parts[2].startsWith('"') ? parts[2] : strip(parts[2]),
      graph: parts[3] ? strip(parts[3]) : '',
    });
  }
  return quads;
}

function splitNQuadLine(line: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === ' ') i++;
    if (i >= line.length) break;
    if (line[i] === '<') {
      const end = line.indexOf('>', i);
      if (end === -1) break;
      parts.push(line.slice(i, end + 1));
      i = end + 1;
    } else if (line[i] === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === '"') {
          j++;
          if (line[j] === '@') { while (j < line.length && line[j] !== ' ') j++; }
          else if (line[j] === '^' && line[j + 1] === '^') {
            j += 2;
            if (line[j] === '<') {
              const end = line.indexOf('>', j);
              if (end === -1) break;
              j = end + 1;
            }
          }
          break;
        }
        j++;
      }
      parts.push(line.slice(i, j));
      i = j;
    } else if (line[i] === '_') {
      let j = i;
      while (j < line.length && line[j] !== ' ') j++;
      parts.push(line.slice(i, j));
      i = j;
    } else {
      break;
    }
  }
  return parts;
}

function strip(value: string): string {
  if (value.startsWith('<') && value.endsWith('>')) return value.slice(1, -1);
  return value;
}
