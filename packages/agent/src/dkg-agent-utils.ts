// SPDX-License-Identifier: Apache-2.0

/**
 * Standalone helpers extracted from `dkg-agent.ts` as part of a mechanical
 * file-size reduction. These are pure functions with no dependency on the
 * `DKGAgent` instance (no `this`, no class state). Behavior is unchanged —
 * this module is a 1:1 move.
 *
 * Scope: N-Quads parsing/serialization helpers, JSON-LD conversion, and the
 * Merkle-root sync verifier used exclusively by `DKGAgent` internals.
 *
 * Note: `parseNQuads`, `splitNQuadLine`, `stripLiteral`, `verifySyncedData`
 * and related helpers are intentionally duplicated (not shared) with
 * `sync-verify-worker-impl.ts`. That duplication pre-dates this extraction
 * and is out of scope here; see the worker for the parallel implementation.
 */

import type { Quad } from '@origintrail-official/dkg-storage';
import type { Logger, OperationContext } from '@origintrail-official/dkg-core';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  autoPartition,
} from '@origintrail-official/dkg-publisher';

export type JsonLdDocument = Record<string, unknown> | Record<string, unknown>[];
export type JsonLdContent = JsonLdDocument | { public?: JsonLdDocument; private?: JsonLdDocument };

export const DKG_NS = 'http://dkg.io/ontology/';
export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export function splitNQuadLine(line: string): string[] {
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
            if (line[j] === '<') { const end = line.indexOf('>', j); if (end === -1) break; j = end + 1; }
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
    } else break;
  }
  return parts;
}

export function strip(s: string): string {
  if (s.startsWith('<') && s.endsWith('>')) return s.slice(1, -1);
  return s;
}

export function stripLiteral(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return unescapeLiteralContent(s.slice(1, -1));
  const match = s.match(/^"(.*)"(\^\^.*|@.*)?$/);
  if (match) return unescapeLiteralContent(match[1]);
  return s;
}

export function unescapeLiteralContent(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/**
 * Minimal N-Quads parser for sync responses.
 * Reuses the existing `splitNQuadLine` helper above.
 */
export function parseNQuads(text: string): Quad[] {
  const quads: Quad[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.endsWith(' .') ? trimmed.slice(0, -2).trim() : trimmed;
    const parts = splitNQuadLine(body);
    if (parts.length >= 3) {
      quads.push({
        subject: strip(parts[0]),
        predicate: strip(parts[1]),
        object: parts[2].startsWith('"') ? parts[2] : strip(parts[2]),
        graph: parts[3] ? strip(parts[3]) : '',
      });
    }
  }
  return quads;
}

let _jsonld: typeof import('jsonld') | undefined;
export async function getJsonld() {
  if (!_jsonld) _jsonld = await import('jsonld');
  return _jsonld;
}

/**
 * Replace blank node identifiers with deterministic uuid: URIs.
 *
 * JSON-LD documents without explicit @id produce blank nodes (_:b0, _:b1, etc.)
 * which autoPartition cannot use as root entities. This function assigns a stable
 * uuid: URI to each unique blank node, matching dkg.js v8's generateMissingIdsForBlankNodes.
 *
 * Mutates the array in place.
 */
export function assignUrisToBlankNodes(quads: Quad[]): void {
  const idMap = new Map<string, string>();

  function resolve(value: string): string {
    if (!value.startsWith('_:')) return value;
    let uri = idMap.get(value);
    if (!uri) {
      uri = `uuid:${crypto.randomUUID()}`;
      idMap.set(value, uri);
    }
    return uri;
  }

  for (let i = 0; i < quads.length; i++) {
    const q = quads[i];
    const subject = resolve(q.subject);
    const object = q.object.startsWith('_:') ? resolve(q.object) : q.object;
    if (subject !== q.subject || object !== q.object) {
      quads[i] = { ...q, subject, object };
    }
  }
}

/**
 * Convert a JSON-LD content object into public and private Quad arrays.
 *
 * Accepts either:
 * - A bare JSON-LD document (defaults to private)
 * - An envelope: { public?: JsonLdDoc, private?: JsonLdDoc }
 */
export async function jsonLdToQuads(
  content: JsonLdContent,
): Promise<{ publicQuads: Quad[]; privateQuads: Quad[] }> {
  const jsonld = await getJsonld();

  const obj = content as Record<string, unknown>;
  const isEnvelope = !Array.isArray(content) && ('public' in obj || 'private' in obj);
  const publicDoc = isEnvelope ? (obj.public as object | undefined) : undefined;
  const privateDoc = isEnvelope ? (obj.private as object | undefined) : content;

  let publicQuads: Quad[] = [];
  let privateQuads: Quad[] = [];

  if (publicDoc) {
    const nquads = await jsonld.default.toRDF(publicDoc, { format: 'application/n-quads' }) as string;
    publicQuads = parseNQuads(nquads);
  }

  if (privateDoc) {
    const nquads = await jsonld.default.toRDF(privateDoc, { format: 'application/n-quads' }) as string;
    privateQuads = parseNQuads(nquads);
  }

  assignUrisToBlankNodes(publicQuads);
  assignUrisToBlankNodes(privateQuads);

  if (publicQuads.length === 0 && privateQuads.length === 0) {
    throw new Error('JSON-LD document produced no RDF quads');
  }

  // When there are private quads but no public quads, generate a synthetic
  // anchor so the publisher has something to merkle-root and partition.
  if (publicQuads.length === 0 && privateQuads.length > 0) {
    const anchorId = `urn:dkg:private:${crypto.randomUUID()}`;
    publicQuads = [{
      subject: anchorId,
      predicate: `${DKG_NS}privateDataAnchor`,
      object: '"true"',
      graph: '',
    }];
  }

  return { publicQuads, privateQuads };
}

/**
 * Verify synced data by recomputing merkle roots from the received
 * triples and comparing them to the claimed roots in the meta graph.
 *
 * Returns only the verified data and meta triples; unverifiable KCs
 * (those without a merkle root in the meta) are passed through
 * since they may be system/genesis data.
 */
export function verifySyncedData(
  dataQuads: Quad[],
  metaQuads: Quad[],
  ctx: OperationContext,
  log: Logger,
  acceptUnverified = false,
): { data: Quad[]; meta: Quad[]; rejected: number } {
  if (metaQuads.length === 0) {
    // No meta graph → no verification possible. Accept data as-is
    // (covers system paranets that don't have KC metadata).
    return { data: dataQuads, meta: metaQuads, rejected: 0 };
  }

  // Extract KC UALs and their claimed merkle roots from meta triples
  const kcMerkleRoots = new Map<string, string>();
  const kcRootEntities = new Map<string, string[]>();

  for (const q of metaQuads) {
    if (q.predicate === `${DKG_NS}merkleRoot`) {
      kcMerkleRoots.set(q.subject, stripLiteral(q.object));
    }
  }

  // Find KA → KC relationships and root entities
  const kaToKc = new Map<string, string>();
  const kaRootEntity = new Map<string, string>();

  for (const q of metaQuads) {
    if (q.predicate === `${DKG_NS}partOf`) {
      kaToKc.set(q.subject, stripLiteral(q.object));
    }
    if (q.predicate === `${DKG_NS}rootEntity`) {
      kaRootEntity.set(q.subject, stripLiteral(q.object));
    }
  }

  // Build KC → rootEntities[] map
  for (const [kaUri, kcUri] of kaToKc) {
    const rootEntity = kaRootEntity.get(kaUri);
    if (rootEntity && kcMerkleRoots.has(kcUri)) {
      if (!kcRootEntities.has(kcUri)) kcRootEntities.set(kcUri, []);
      kcRootEntities.get(kcUri)!.push(rootEntity);
    }
  }

  if (kcMerkleRoots.size === 0) {
    return { data: dataQuads, meta: metaQuads, rejected: 0 };
  }

  // Detect root entities shared across multiple KCs. When an entity has been
  // published more than once (e.g. profile updates), the data graph contains
  // the union of all versions' triples under the same root entity, making
  // per-KC Merkle verification impossible without KC-level graph isolation.
  const rootEntityToKCs = new Map<string, string[]>();
  for (const [kcUal, entities] of kcRootEntities) {
    for (const re of entities) {
      if (!rootEntityToKCs.has(re)) rootEntityToKCs.set(re, []);
      rootEntityToKCs.get(re)!.push(kcUal);
    }
  }
  const overlappingKCs = new Set<string>();
  for (const [, kcUals] of rootEntityToKCs) {
    if (kcUals.length > 1) {
      for (const u of kcUals) overlappingKCs.add(u);
    }
  }

  // Partition data triples by root entity
  const partitioned = autoPartition(dataQuads);

  // Verify each KC
  const verifiedKcUals = new Set<string>();
  let rejected = 0;

  for (const [kcUal, claimedHex] of kcMerkleRoots) {
    const rootEntities = kcRootEntities.get(kcUal) ?? [];
    if (rootEntities.length === 0) {
      // No KA info — can't verify, accept on trust
      verifiedKcUals.add(kcUal);
      continue;
    }

    if (overlappingKCs.has(kcUal)) {
      // Root entity is shared with other KCs (multi-version entity). Local
      // partition contains mixed triples so Merkle re-computation would fail.
      // Accept and defer to chain-level verification (Tier 2).
      log.debug(ctx, `Skipping Merkle check for ${kcUal}: root entity shared across ${rootEntityToKCs.get(rootEntities[0])!.length} KCs`);
      verifiedKcUals.add(kcUal);
      continue;
    }

    try {
      const allQuadsForKC: Quad[] = [];
      for (const re of rootEntities) {
        const quads = partitioned.get(re) ?? [];
        allQuadsForKC.push(...quads);
      }

      // Collect private merkle roots from KA metadata for this KC
      const kcPrivateRoots: Uint8Array[] = [];
      for (const [kaUri, kcUri] of kaToKc) {
        if (kcUri !== kcUal) continue;
        for (const mq of metaQuads) {
          if (mq.subject === kaUri && mq.predicate === `${DKG_NS}privateMerkleRoot`) {
            const hex = stripLiteral(mq.object).replace(/^0x/, '');
            if (hex.length === 64) {
              const bytes = new Uint8Array(32);
              for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
              kcPrivateRoots.push(bytes);
            }
          }
        }
      }

      const flatRoot = computeFlatKCRoot(allQuadsForKC, kcPrivateRoots);
      const flatHex = Array.from(flatRoot).map(b => b.toString(16).padStart(2, '0')).join('');

      if (flatHex === claimedHex) {
        verifiedKcUals.add(kcUal);
      } else if (kcPrivateRoots.length > 0) {
        const legacyRoot = computeFlatKCRoot(allQuadsForKC, []);
        const legacyHex = Array.from(legacyRoot).map(b => b.toString(16).padStart(2, '0')).join('');
        if (legacyHex === claimedHex) {
          log.debug(ctx, `KC ${kcUal} verified via legacy flat root (without private root anchoring)`);
          verifiedKcUals.add(kcUal);
        } else if (acceptUnverified) {
          log.debug(ctx, `Merkle mismatch for ${kcUal} (system context graph, accepted): claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…`);
          rejected++;
        } else {
          log.warn(ctx, `Merkle mismatch for ${kcUal}: claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…`);
          rejected++;
        }
      } else if (acceptUnverified) {
        log.debug(ctx, `Merkle mismatch for ${kcUal} (system context graph, accepted): claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…`);
        rejected++;
      } else {
        log.warn(ctx, `Merkle mismatch for ${kcUal}: claimed ${claimedHex.slice(0, 16)}…, flat ${flatHex.slice(0, 16)}…`);
        rejected++;
      }
    } catch {
      log.warn(ctx, `Merkle verification error for ${kcUal}, rejecting`);
      rejected++;
    }
  }

  // Collect triples belonging to verified KCs only
  const verifiedRootEntities = new Set<string>();
  for (const kcUal of verifiedKcUals) {
    for (const re of (kcRootEntities.get(kcUal) ?? [])) {
      verifiedRootEntities.add(re);
    }
  }

  // When acceptUnverified is set (system context graphs), accept all data
  // rather than dropping profiles that fail merkle verification.
  if (acceptUnverified && rejected > 0 && verifiedKcUals.size < kcMerkleRoots.size) {
    log.debug(ctx, `Accepting ${rejected} unverified KC(s) (system context graph)`);
    return { data: dataQuads, meta: metaQuads, rejected: 0 };
  }

  // Keep data triples whose root entity belongs to a verified KC,
  // plus any triples not associated with any KC (genesis/system data)
  const allKnownRootEntities = new Set<string>();
  for (const entities of kcRootEntities.values()) {
    for (const re of entities) allKnownRootEntities.add(re);
  }

  const verifiedData = dataQuads.filter(q => {
    if (allKnownRootEntities.has(q.subject)) {
      return verifiedRootEntities.has(q.subject);
    }
    for (const re of verifiedRootEntities) {
      if (q.subject.startsWith(re)) return true;
    }
    return true;
  });

  // Keep meta triples for verified KCs + unrelated meta triples
  const verifiedMeta = metaQuads.filter(q => {
    if (kcMerkleRoots.has(q.subject)) return verifiedKcUals.has(q.subject);
    const kcUri = kaToKc.get(q.subject);
    if (kcUri) return verifiedKcUals.has(kcUri);
    return true;
  });

  return { data: verifiedData, meta: verifiedMeta, rejected };
}
