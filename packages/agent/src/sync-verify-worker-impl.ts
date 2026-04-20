import { parentPort } from 'node:worker_threads';
import { computeFlatKCRootV10 as computeFlatKCRoot, autoPartition } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncVerifyResult, SyncVerifyLogEntry, SyncParseResult, SharedMemoryProcessResult, DurableBatchProcessResult, SharedMemoryBatchProcessResult } from './sync-verify-worker.js';

const DKG_NS = 'http://dkg.io/ontology/';

parentPort!.on('message', async (message: { id: number; method: string; args: unknown[] }) => {
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
      const [wsDataQuads, wsMetaQuads] = message.args as [Quad[], Quad[]];
      const result = processSharedMemoryBatch(wsDataQuads, wsMetaQuads);
      parentPort!.postMessage({ id: message.id, result });
      return;
    }
    parentPort!.postMessage({ id: message.id, error: `Unknown method: ${message.method}` });
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});

function verifySyncedData(
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

  const kaToKc = new Map<string, string>();
  const kaRootEntity = new Map<string, string>();
  for (const q of metaQuads) {
    if (q.predicate === `${DKG_NS}partOf`) kaToKc.set(q.subject, stripLiteral(q.object));
    if (q.predicate === `${DKG_NS}rootEntity`) kaRootEntity.set(q.subject, stripLiteral(q.object));
  }

  for (const [kaUri, kcUri] of kaToKc) {
    const rootEntity = kaRootEntity.get(kaUri);
    if (!rootEntity || !kcMerkleRoots.has(kcUri)) continue;
    if (!kcRootEntities.has(kcUri)) kcRootEntities.set(kcUri, []);
    kcRootEntities.get(kcUri)!.push(rootEntity);
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

  const partitioned = autoPartition(dataQuads);
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

function parseAndFilterNQuads(text: string, graphUri: string, contextGraphId: string): SyncParseResult {
  const quads = parseNQuads(text);
  const cgUriPrefix = `did:dkg:context-graph:${contextGraphId}/`;
  return {
    quads: quads.filter((q) => q.graph === graphUri || q.graph.startsWith(cgUriPrefix)),
    totalQuads: quads.length,
  };
}

function processSharedMemory(wsDataQuads: Quad[], wsMetaQuads: Quad[]): SharedMemoryProcessResult {
  const DKG_ROOT_ENTITY = 'http://dkg.io/ontology/rootEntity';
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const DKG_WORKSPACE_OP = 'http://dkg.io/ontology/WorkspaceOperation';
  const DKG_PUBLISHED_AT = 'http://dkg.io/ontology/publishedAt';
  const PROV_ATTRIBUTED_TO = 'http://www.w3.org/ns/prov#wasAttributedTo';
  const SKOLEM_PREFIX = '/.well-known/genid/';

  const opsWithType = new Set<string>();
  const opsWithPublishedAt = new Set<string>();
  for (const q of wsMetaQuads) {
    if (q.predicate === RDF_TYPE && q.object === DKG_WORKSPACE_OP) opsWithType.add(q.subject);
    if (q.predicate === DKG_PUBLISHED_AT) opsWithPublishedAt.add(q.subject);
  }
  const validOps = new Set<string>([...opsWithType].filter((subject) => opsWithPublishedAt.has(subject)));

  const allowedRoots = new Set<string>();
  for (const q of wsMetaQuads) {
    if (q.predicate === DKG_ROOT_ENTITY && validOps.has(q.subject)) {
      const entity = q.object.startsWith('"') ? stripLiteral(q.object) : q.object;
      allowedRoots.add(entity);
    }
  }

  const validQuads = wsDataQuads.filter((q) => {
    if (allowedRoots.has(q.subject)) return true;
    for (const root of allowedRoots) {
      if (q.subject.startsWith(root + SKOLEM_PREFIX)) return true;
    }
    return false;
  });

  const opCreators = new Map<string, string>();
  for (const q of wsMetaQuads) {
    if (q.predicate === PROV_ATTRIBUTED_TO && validOps.has(q.subject)) {
      opCreators.set(q.subject, q.object.startsWith('"') ? stripLiteral(q.object) : q.object);
    }
  }

  const entityCreators = new Map<string, string>();
  for (const q of wsMetaQuads) {
    if (q.predicate === DKG_ROOT_ENTITY && validOps.has(q.subject)) {
      const entity = q.object.startsWith('"') ? stripLiteral(q.object) : q.object;
      const creator = opCreators.get(q.subject);
      if (creator && !entityCreators.has(entity)) {
        entityCreators.set(entity, creator);
      }
    }
  }

  return {
    validQuads,
    dropped: wsDataQuads.length - validQuads.length,
    entityCreators: [...entityCreators.entries()],
  };
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

  const processed = processSharedMemory(wsDataQuads, wsMetaQuads);
  return {
    verifiedData: processed.validQuads,
    verifiedMeta: wsMetaQuads,
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

function stripLiteral(value: string): string {
  return value.replace(/^"|"$/g, '').replace(/"?\^\^.*$/, '');
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
