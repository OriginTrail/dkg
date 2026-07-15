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
 * Durable Merkle verification is shared with the worker implementation so
 * main-thread fallbacks and production sync cannot drift.
 */

import type { Quad } from '@origintrail-official/dkg-storage';
import type { Logger, OperationContext } from '@origintrail-official/dkg-core';
import { selectVerifiedDurableSyncQuads } from './sync/durable-integrity.js';

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
 * which skolemizeByEntity cannot use as root entities. This function assigns a stable
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
export interface JsonLdToQuadsOptions {
  defaultVisibility?: 'public' | 'private';
  syntheticPrivateAnchor?: boolean;
}

export async function jsonLdToQuads(
  content: JsonLdContent,
  options: JsonLdToQuadsOptions = {},
): Promise<{ publicQuads: Quad[]; privateQuads: Quad[] }> {
  const jsonld = await getJsonld();
  const defaultVisibility = options.defaultVisibility ?? 'private';
  const syntheticPrivateAnchor = options.syntheticPrivateAnchor ?? true;

  const obj = content as Record<string, unknown>;
  const isEnvelope = !Array.isArray(content) && ('public' in obj || 'private' in obj);
  const publicDoc = isEnvelope
    ? (obj.public as object | undefined)
    : defaultVisibility === 'public'
      ? content
      : undefined;
  const privateDoc = isEnvelope
    ? (obj.private as object | undefined)
    : defaultVisibility === 'private'
      ? content
      : undefined;

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
  if (syntheticPrivateAnchor && publicQuads.length === 0 && privateQuads.length > 0) {
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
 * Returns only verified data and metadata. Normal context graphs fail closed
 * when data has no Merkle-bound KA descriptor; system/genesis callers must
 * opt into the explicit `acceptUnverified` override.
 */
export function verifySyncedData(
  dataQuads: Quad[],
  metaQuads: Quad[],
  ctx: OperationContext,
  log: Logger,
  acceptUnverified = false,
): { data: Quad[]; meta: Quad[]; rejected: number } {
  const result = selectVerifiedDurableSyncQuads(dataQuads, metaQuads, acceptUnverified);
  for (const entry of result.logs) {
    if (entry.level === 'warn') log.warn(ctx, entry.message);
    else log.debug(ctx, entry.message);
  }
  return {
    data: result.dataIndexes.map((index) => dataQuads[index]!),
    meta: result.metaIndexes.map((index) => metaQuads[index]!),
    rejected: result.rejected,
  };
}
