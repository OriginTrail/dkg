import { parentPort } from 'node:worker_threads';
import { validateSubGraphName } from '@origintrail-official/dkg-core';
import { computeFlatKCRootV10 as computeFlatKCRoot, skolemizeByEntity } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncVerifyResult, SyncVerifyLogEntry, SyncParseResult, SharedMemoryProcessResult, DurableBatchProcessResult, SharedMemoryBatchProcessResult } from './sync-verify-worker.js';
import { isSharedMemoryBucketDescendantDataGraph } from './sync/shared-memory-graphs.js';

const DKG_NS = 'http://dkg.io/ontology/';
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
      const [dataQuads, metaQuads, acceptUnverified] = message.args as [Quad[], Quad[], boolean];
      const result = processDurableBatch(dataQuads, metaQuads, acceptUnverified);
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
  const logs: SyncVerifyLogEntry[] = [];
  if (metaQuads.length === 0) {
    return { data: dataQuads, meta: metaQuads, rejected: 0, logs };
  }

  const kcMerkleRoots = new Map<string, string>();
  const kcRootEntities = new Map<string, string[]>();
  for (const q of metaQuads) {
    if (q.predicate === `${DKG_NS}merkleRoot`) kcMerkleRoots.set(q.subject, stripLiteral(q.object));
  }

  // Read-both (RFC ka-metadata-trim P3.1): legacy rows tie a token subject
  // `<ual>/<n>` to its KC via `dkg:partOf`; collapsed-shape rows carry ALL
  // member `dkg:rootEntity` rows directly on the merkleRoot-bearing UAL
  // subject with NO partOf edge. kaRootEntity is a multi-map because the
  // collapsed UAL subject holds every member root; legacy token subjects
  // carry one row each, so legacy behaviour is unchanged. Keep this in sync
  // with the identical logic in dkg-agent-utils.ts verifySyncedData.
  const kaToKc = new Map<string, string>();
  const kaRootEntity = new Map<string, string[]>();
  for (const q of metaQuads) {
    if (q.predicate === `${DKG_NS}partOf`) kaToKc.set(q.subject, stripLiteral(q.object));
    if (q.predicate === `${DKG_NS}rootEntity`) {
      const entity = stripLiteral(q.object);
      const list = kaRootEntity.get(q.subject);
      if (list) list.push(entity);
      else kaRootEntity.set(q.subject, [entity]);
    }
  }

  // Self-map collapsed rows: a merkleRoot-bearing subject that carries its
  // own rootEntity rows IS the KA (P3.1 — no token edge to join through).
  // Keying on kcMerkleRoots guards against non-KA rootEntity carriers
  // (lifecycle URNs, SWM op rows, …) minting bogus KCs. Without this,
  // collapsed-shape KCs built no kaToKc entry and fell into the
  // "no KA info — accept on trust" branch, skipping Merkle verification.
  for (const kcUal of kcMerkleRoots.keys()) {
    if (kaRootEntity.has(kcUal) && !kaToKc.has(kcUal)) kaToKc.set(kcUal, kcUal);
  }

  for (const [kaUri, kcUri] of kaToKc) {
    const rootsForKa = kaRootEntity.get(kaUri);
    if (!rootsForKa || !kcMerkleRoots.has(kcUri)) continue;
    let list = kcRootEntities.get(kcUri);
    if (!list) { list = []; kcRootEntities.set(kcUri, list); }
    for (const rootEntity of rootsForKa) {
      // Dedupe: pre-trim stores (and multi-root dual-shape writes) carry the
      // same root on BOTH the aggregate UAL row and its `<ual>/<n>` token
      // row — double-counting a partition would corrupt the recomputed root.
      if (!list.includes(rootEntity)) list.push(rootEntity);
    }
  }

  if (kcMerkleRoots.size === 0) {
    return { data: dataQuads, meta: metaQuads, rejected: 0, logs };
  }

  const rootEntityToKCs = new Map<string, string[]>();
  for (const [kcUal, entities] of kcRootEntities) {
    for (const rootEntity of entities) {
      if (!rootEntityToKCs.has(rootEntity)) rootEntityToKCs.set(rootEntity, []);
      rootEntityToKCs.get(rootEntity)!.push(kcUal);
    }
  }

  const overlappingKCs = new Set<string>();
  for (const [, kcUals] of rootEntityToKCs) {
    if (kcUals.length <= 1) continue;
    for (const kcUal of kcUals) overlappingKCs.add(kcUal);
  }

  const partitioned = skolemizeByEntity(dataQuads);
  const verifiedKcUals = new Set<string>();
  let rejected = 0;

  for (const [kcUal, claimedHex] of kcMerkleRoots) {
    const rootEntities = kcRootEntities.get(kcUal) ?? [];
    if (rootEntities.length === 0) {
      verifiedKcUals.add(kcUal);
      continue;
    }

    if (overlappingKCs.has(kcUal)) {
      logs.push({ level: 'debug', message: `Skipping Merkle check for ${kcUal}: root entity shared across ${rootEntityToKCs.get(rootEntities[0])!.length} KCs` });
      verifiedKcUals.add(kcUal);
      continue;
    }

    try {
      const allQuadsForKC: Quad[] = [];
      for (const rootEntity of rootEntities) {
        const quads = partitioned.get(rootEntity) ?? [];
        allQuadsForKC.push(...quads);
      }

      const privateRoots: Uint8Array[] = [];
      for (const [kaUri, kcUri] of kaToKc) {
        if (kcUri !== kcUal) continue;
        for (const mq of metaQuads) {
          if (mq.subject === kaUri && mq.predicate === `${DKG_NS}privateMerkleRoot`) {
            const hex = stripLiteral(mq.object).replace(/^0x/, '');
            if (hex.length !== 64) continue;
            const bytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
            privateRoots.push(bytes);
          }
        }
      }

      const flatHex = toHex(computeFlatKCRoot(allQuadsForKC, privateRoots));
      if (flatHex === claimedHex) {
        verifiedKcUals.add(kcUal);
        continue;
      }

      if (privateRoots.length > 0) {
        const legacyHex = toHex(computeFlatKCRoot(allQuadsForKC, []));
        if (legacyHex === claimedHex) {
          logs.push({ level: 'debug', message: `KC ${kcUal} verified via legacy flat root (without private root anchoring)` });
          verifiedKcUals.add(kcUal);
          continue;
        }
      }

      logs.push({
        level: acceptUnverified ? 'debug' : 'warn',
        message: `Merkle mismatch for ${kcUal}${acceptUnverified ? ' (system context graph, accepted)' : ''}: claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…`,
      });
      rejected++;
    } catch {
      logs.push({ level: 'warn', message: `Merkle verification error for ${kcUal}, rejecting` });
      rejected++;
    }
  }

  if (acceptUnverified && rejected > 0 && verifiedKcUals.size < kcMerkleRoots.size) {
    logs.push({ level: 'debug', message: `Accepting ${rejected} unverified KC(s) (system context graph)` });
    return { data: dataQuads, meta: metaQuads, rejected: 0, logs };
  }

  const verifiedRootEntities = new Set<string>();
  for (const kcUal of verifiedKcUals) {
    for (const rootEntity of kcRootEntities.get(kcUal) ?? []) {
      verifiedRootEntities.add(rootEntity);
    }
  }

  const allKnownRootEntities = new Set<string>();
  for (const entities of kcRootEntities.values()) {
    for (const rootEntity of entities) allKnownRootEntities.add(rootEntity);
  }

  const verifiedData = dataQuads.filter((q) => {
    if (allKnownRootEntities.has(q.subject)) return verifiedRootEntities.has(q.subject);
    for (const rootEntity of verifiedRootEntities) {
      if (q.subject.startsWith(rootEntity)) return true;
    }
    return true;
  });

  const verifiedMeta = metaQuads.filter((q) => {
    if (kcMerkleRoots.has(q.subject)) return verifiedKcUals.has(q.subject);
    const kcUri = kaToKc.get(q.subject);
    if (kcUri) return verifiedKcUals.has(kcUri);
    return true;
  });

  return { data: verifiedData, meta: verifiedMeta, rejected, logs };
}

export function parseAndFilterNQuads(text: string, graphUri: string, contextGraphId: string): SyncParseResult {
  const quads = parseNQuads(text);
  const cgUriPrefix = `did:dkg:context-graph:${contextGraphId}/`;
  // A request is a shared-memory/workspace request iff its OWN graphUri names a
  // `_shared_memory` graph (base bucket, per-KA descendant, or `_shared_memory_meta`).
  // When it is NOT (a durable data/meta sync), reject any quad whose graph names a
  // `_shared_memory` graph: the responder over-serves the whole `_shared_memory`
  // subtree under the CG prefix, and a blind `storeInsert` of those quads on the
  // streaming durable-sync apply UNIONS a reconnecting private-CG member into
  // {old,new} for single-valued roots. SWM must flow ONLY through the dedicated
  // SWM-sync / all-or-nothing recovery path (which passes an SWM graphUri here, so
  // `swmRequest` is true and the base bucket + per-KA subgraphs are kept exactly as
  // before). This is an EXCLUDE (drops quads), never a per-page REPLACE, so it
  // cannot truncate a root spanning a page boundary. The literal "/_shared_memory"
  // matches every SWM URI form and only those (validateSubGraphName forbids a
  // leading "_" on subgraph names, so no data/meta/context graph can collide).
  const swmRequest = graphUri.includes('/_shared_memory');
  return {
    quads: quads.filter(
      (q) =>
        q.graph === graphUri ||
        (q.graph.startsWith(cgUriPrefix) && (swmRequest || !q.graph.includes('/_shared_memory'))),
    ),
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

function processDurableBatch(
  dataQuads: Quad[],
  metaQuads: Quad[],
  acceptUnverified: boolean,
): DurableBatchProcessResult {
  const logs: SyncVerifyLogEntry[] = [];
  const totalFetchedDataQuads = dataQuads.length;
  const totalFetchedMetaQuads = metaQuads.length;

  if (totalFetchedDataQuads === 0 && totalFetchedMetaQuads === 0) {
    return {
      verifiedData: [],
      verifiedMeta: [],
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
      totalFetchedDataQuads,
      totalFetchedMetaQuads,
      rejectedKcs: 0,
      emptyResponses: 0,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 1,
      logs,
    };
  }

  const metaOnlyResponses = !acceptUnverified && totalFetchedMetaQuads > 0 && totalFetchedDataQuads === 0 ? 1 : 0;
  if (metaOnlyResponses > 0) {
    logs.push({
      level: 'warn',
      message: `Sync batch received ${totalFetchedMetaQuads} meta triples but no data — peer may have empty or pruned data graph`,
    });
  }

  const verified = verifySyncedData(dataQuads, metaQuads, acceptUnverified);
  return {
    verifiedData: verified.data,
    verifiedMeta: verified.meta,
    totalFetchedDataQuads,
    totalFetchedMetaQuads,
    rejectedKcs: verified.rejected,
    emptyResponses: 0,
    metaOnlyResponses,
    dataRejectedMissingMeta: 0,
    logs: [...logs, ...verified.logs],
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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
