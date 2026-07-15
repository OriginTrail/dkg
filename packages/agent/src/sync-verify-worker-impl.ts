import { parentPort } from 'node:worker_threads';
import { validateSubGraphName } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncVerifyResult, SyncVerifyLogEntry, SyncParseResult, SharedMemoryProcessResult, DurableBatchProcessResult, DurableBatchProcessWireResult, DurableBatchVerificationMode, SharedMemoryBatchProcessResult } from './sync-verify-worker.js';
import { isSharedMemoryBucketDescendantDataGraph } from './sync/shared-memory-graphs.js';
import {
  selectVerifiedDurableSyncQuads,
  type DurableIntegrityVerificationMode,
} from './sync/durable-integrity.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

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

type VerifiedSelectionDetails = {
  data: number[];
  meta: number[];
  verifiedZeroPublicAssets: number;
  verifiedGraphScopedDataGraphs: string[];
};

function verifySyncedDataImpl(
  dataQuads: Quad[],
  metaQuads: Quad[],
  acceptUnverified = false,
  recordSelection?: (selection: VerifiedSelectionDetails) => void,
  mode: DurableIntegrityVerificationMode = { kind: 'fullSnapshot' },
): SyncVerifyResult {
  const selection = selectVerifiedDurableSyncQuads(
    dataQuads,
    metaQuads,
    acceptUnverified,
    mode,
  );
  recordSelection?.({
    data: selection.dataIndexes,
    meta: selection.metaIndexes,
    verifiedZeroPublicAssets: selection.verifiedZeroPublicAssets,
    verifiedGraphScopedDataGraphs: selection.verifiedGraphScopedDataGraphs,
  });
  return {
    data: selection.dataIndexes.map((index) => dataQuads[index]!),
    meta: selection.metaIndexes.map((index) => metaQuads[index]!),
    rejected: selection.rejected,
    logs: selection.logs,
  };
}

function parseAndFilterNQuads(text: string, graphUri: string, contextGraphId: string): SyncParseResult {
  const quads = parseNQuads(text);
  const cgUriPrefix = `did:dkg:context-graph:${contextGraphId}/`;
  return {
    quads: quads.filter((q) => q.graph === graphUri || q.graph.startsWith(cgUriPrefix)),
    totalQuads: quads.length,
  };
}

function processSharedMemory(
  wsDataQuads: Quad[],
  wsMetaQuads: Quad[],
  contextGraphId?: string,
  registeredSubGraphNames?: readonly string[],
  excludedSubGraphNames?: readonly string[],
): SharedMemoryProcessResult {
  const DKG_ROOT_ENTITY = 'http://dkg.io/ontology/rootEntity';
  const DKG_WORKSPACE_OP = 'http://dkg.io/ontology/WorkspaceOperation';
  const DKG_PUBLISHED_AT = 'http://dkg.io/ontology/publishedAt';
  const DKG_PUBLISHER_PEER_ID = 'http://dkg.io/ontology/publisherPeerId';
  const PROV_ATTRIBUTED_TO = 'http://www.w3.org/ns/prov#wasAttributedTo';
  const SKOLEM_PREFIX = '/.well-known/genid/';
  // SWM meta graphs are derived from data graphs by appending "_meta"
  // (see `contextGraphSharedMemoryMetaUri` in dkg-core/constants.ts:
  //   <cgPrefix>/_shared_memory      <-> <cgPrefix>/_shared_memory_meta
  //   <cgPrefix>/<sub>/_shared_memory <-> <cgPrefix>/<sub>/_shared_memory_meta
  // Stripping the suffix yields the matching data graph URI.
  const META_SUFFIX = '_meta';
  const effectiveRegisteredSubGraphNames = combineRegisteredSubGraphNames(
    registeredSubGraphNames,
    excludedSubGraphNames,
  );

  // Codex review on #885 — keep validity scoped per (meta graph, op
  // subject). Pre-fix the Sets were global, so an op subject that
  // appeared in two `_shared_memory_meta` graphs (sub-A + sub-B) had
  // its `rootEntity` admitted as universally valid even when only one
  // of the graphs actually contained the matching data quads. The
  // graph-keyed maps below preserve the responder's per-graph scoping
  // exactly, then the data filter consults the same scope.
  const opsWithTypeByMeta = new Map<string, Set<string>>();
  const opsWithPublishedAtByMeta = new Map<string, Set<string>>();
  for (const q of wsMetaQuads) {
    if (q.predicate === RDF_TYPE && q.object === DKG_WORKSPACE_OP) {
      let s = opsWithTypeByMeta.get(q.graph);
      if (!s) { s = new Set(); opsWithTypeByMeta.set(q.graph, s); }
      s.add(q.subject);
    } else if (q.predicate === DKG_PUBLISHED_AT) {
      let s = opsWithPublishedAtByMeta.get(q.graph);
      if (!s) { s = new Set(); opsWithPublishedAtByMeta.set(q.graph, s); }
      s.add(q.subject);
    }
  }
  // (metaGraph → set of op subjects valid in that graph). An op needs
  // BOTH `rdf:type WorkspaceOperation` AND `dkg:publishedAt` in the
  // SAME meta graph to count.
  const validOpsByMeta = new Map<string, Set<string>>();
  const validOps = new Set<string>();
  for (const [metaGraph, typedOps] of opsWithTypeByMeta) {
    const publishedOps = opsWithPublishedAtByMeta.get(metaGraph);
    if (!publishedOps) continue;
    const valid = new Set<string>();
    for (const op of typedOps) {
      if (publishedOps.has(op)) {
        valid.add(op);
        validOps.add(op);
      }
    }
    if (valid.size > 0) validOpsByMeta.set(metaGraph, valid);
  }

  // (dataGraph → set of allowed rootEntities). Derived from each meta
  // graph by stripping the `_meta` suffix to yield the partner data
  // graph URI. Op-meta quads from a graph that doesn't follow the
  // suffix convention are skipped — they cannot be paired with a
  // matching `_shared_memory` data graph and would only contribute
  // unsoundness.
  const allowedRootsByDataGraph = new Map<string, Set<string>>();
  for (const q of wsMetaQuads) {
    if (q.predicate !== DKG_ROOT_ENTITY) continue;
    const validForGraph = validOpsByMeta.get(q.graph);
    if (!validForGraph || !validForGraph.has(q.subject)) continue;
    const dataGraph = swmDataGraphFromMetaGraph(q.graph, contextGraphId, META_SUFFIX, effectiveRegisteredSubGraphNames);
    if (!dataGraph) continue;
    const entity = q.object.startsWith('"') ? stripLiteral(q.object) : q.object;
    let s = allowedRootsByDataGraph.get(dataGraph);
    if (!s) { s = new Set(); allowedRootsByDataGraph.set(dataGraph, s); }
    s.add(entity);
  }

  const validQuads = wsDataQuads.filter((q) => {
    const allowed = allowedRootsForSwmDataGraph(allowedRootsByDataGraph, q.graph);
    if (!allowed) return false;
    if (allowed.has(q.subject)) return true;
    for (const root of allowed) {
      if (q.subject.startsWith(root + SKOLEM_PREFIX)) return true;
    }
    return false;
  });

  // GH #748 Codex round 4: prefer the dedicated `dkg:publisherPeerId` literal
  // for ownership-cache hydration; only fall back to `prov:wasAttributedTo`
  // when it's a literal (the legacy shape). Post-fix `wasAttributedTo`
  // carries an agent DID URI, and caching that as the peer-ID owner here
  // would break first-writer/upsert recognition for follow-up writes from
  // the same peer (the check at `_shareImpl` compares against the live
  // `publisherPeerId` of the new write).
  const opPeerIdField = new Map<string, string>();
  const opAttrLiteralFallback = new Map<string, string>();
  for (const q of wsMetaQuads) {
    if (!validOps.has(q.subject)) continue;
    if (q.predicate === DKG_PUBLISHER_PEER_ID) {
      opPeerIdField.set(q.subject, q.object.startsWith('"') ? stripLiteral(q.object) : q.object);
    } else if (q.predicate === PROV_ATTRIBUTED_TO && q.object.startsWith('"')) {
      opAttrLiteralFallback.set(q.subject, stripLiteral(q.object));
    }
  }
  const opCreators = new Map<string, string>();
  for (const op of validOps) {
    const peer = opPeerIdField.get(op) ?? opAttrLiteralFallback.get(op);
    if (peer) opCreators.set(op, peer);
  }

  const entityCreators = new Map<string, { dataGraph: string; entity: string; creator: string }>();
  for (const q of wsMetaQuads) {
    const validForGraph = validOpsByMeta.get(q.graph);
    if (q.predicate === DKG_ROOT_ENTITY && validForGraph?.has(q.subject)) {
      const dataGraph = swmDataGraphFromMetaGraph(q.graph, contextGraphId, META_SUFFIX, effectiveRegisteredSubGraphNames);
      if (!dataGraph) continue;
      const entity = q.object.startsWith('"') ? stripLiteral(q.object) : q.object;
      const creator = opCreators.get(q.subject);
      const key = `${dataGraph}\0${entity}`;
      if (creator && !entityCreators.has(key)) {
        entityCreators.set(key, { dataGraph, entity, creator });
      }
    }
  }

  return {
    validQuads,
    dropped: wsDataQuads.length - validQuads.length,
    entityCreators: [...entityCreators.values()],
  };
}

function swmDataGraphFromMetaGraph(
  metaGraph: string,
  contextGraphId: string | undefined,
  metaSuffix: string,
  registeredSubGraphNames?: readonly string[],
): string | undefined {
  if (!metaGraph.endsWith('/_shared_memory_meta')) return undefined;
  if (contextGraphId === undefined) return metaGraph.slice(0, -metaSuffix.length);
  const rootMetaGraph = `did:dkg:context-graph:${contextGraphId}/_shared_memory_meta`;
  if (metaGraph === rootMetaGraph) return metaGraph.slice(0, -metaSuffix.length);

  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  const suffix = '/_shared_memory_meta';
  if (!metaGraph.startsWith(prefix) || !metaGraph.endsWith(suffix)) return undefined;
  const subGraphName = metaGraph.slice(prefix.length, -suffix.length);
  if (!validateSubGraphName(subGraphName).valid) return undefined;
  if (!registeredSubGraphNames?.includes(subGraphName)) return undefined;
  return metaGraph.slice(0, -metaSuffix.length);
}

function allowedRootsForSwmDataGraph(
  allowedRootsByDataGraph: Map<string, Set<string>>,
  graph: string,
): Set<string> | undefined {
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

  let verifiedSelection: VerifiedSelectionDetails = {
    data: [],
    meta: [],
    verifiedZeroPublicAssets: 0,
    verifiedGraphScopedDataGraphs: [],
  };
  const verified = verifySyncedDataImpl(
    dataQuads,
    metaQuads,
    acceptUnverified,
    (selection) => { verifiedSelection = selection; },
    mode.kind === 'fullSnapshot'
      ? mode
      : { kind: 'changelogPage', changedDataGraphs: new Set(mode.changedDataGraphs) },
  );
  // A fully-private V2 KA legitimately has an empty public assertion graph.
  // Its metadata commits the private root and declares publicTripleCount=0,
  // so exact verification is enough to advance both durable cursors. Keep
  // treating every other meta-without-data response as potentially pruned.
  const verifiedFullyPrivateResponse = totalFetchedDataQuads === 0
    && verified.rejected === 0
    && verifiedSelection.verifiedZeroPublicAssets > 0;
  const metaOnlyResponses = !acceptUnverified
    && totalFetchedMetaQuads > 0
    && totalFetchedDataQuads === 0
    && !verifiedFullyPrivateResponse
    ? 1
    : 0;
  if (metaOnlyResponses > 0) {
    logs.push({
      level: 'warn',
      message: `Sync batch received ${totalFetchedMetaQuads} meta triples but no data — peer may have empty or pruned data graph`,
    });
  }
  return {
    verifiedData: verified.data,
    verifiedMeta: verified.meta,
    verifiedDataIndexes: verifiedSelection.data,
    verifiedMetaIndexes: verifiedSelection.meta,
    verifiedGraphScopedDataGraphs: verifiedSelection.verifiedGraphScopedDataGraphs,
    verifiedPrivateOnlyResponses: verifiedFullyPrivateResponse ? 1 : 0,
    totalFetchedDataQuads,
    totalFetchedMetaQuads,
    rejectedKcs: verified.rejected,
    emptyResponses: 0,
    metaOnlyResponses,
    dataRejectedMissingMeta: 0,
    logs: [...logs, ...verified.logs],
  };
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

  const processed = processSharedMemory(
    wsDataQuads,
    wsMetaQuads,
    contextGraphId,
    registeredSubGraphNames,
    excludedSubGraphNames,
  );
  const effectiveRegisteredSubGraphNames = combineRegisteredSubGraphNames(
    registeredSubGraphNames,
    excludedSubGraphNames,
  );
  return {
    verifiedData: processed.validQuads,
    verifiedMeta: filterSharedMemoryMetaQuads(wsMetaQuads, contextGraphId, effectiveRegisteredSubGraphNames),
    totalFetchedDataQuads,
    totalFetchedMetaQuads,
    droppedDataTriples: processed.dropped,
    emptyResponses: 0,
    entityCreators: processed.entityCreators,
  };
}

function filterSharedMemoryMetaQuads(
  wsMetaQuads: readonly Quad[],
  contextGraphId: string | undefined,
  registeredSubGraphNames: readonly string[],
): Quad[] {
  return wsMetaQuads.filter((q) =>
    swmDataGraphFromMetaGraph(q.graph, contextGraphId, '_meta', registeredSubGraphNames) !== undefined,
  );
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

function stripLiteral(value: string): string {
  return value.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '');
}
