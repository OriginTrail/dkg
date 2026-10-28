import type { Quad } from '@origintrail-official/dkg-storage';
import type { PublicSnapshotMetadata } from './shared-memory-sync.js';
import { stripMetadataLiteral as stripLiteral } from '../metadata-literal.js';
const DKG = 'http://dkg.io/ontology/';

/** Keep source provenance internal without changing the exported metadata shape. */
export function collectPublicSnapshotManifest(metaQuads: readonly Quad[]): {
  snapshots: PublicSnapshotMetadata[];
  sourceSubjectsByRef: Map<string, Set<string>>;
} {
  const bySubject = new Map<string, {
    ref?: string;
    digest?: string;
    count?: number;
    hasSnapshotGraph?: boolean;
    publishedAtMs?: number;
    ualOrdinal?: bigint;
  }>();
  for (const quad of metaQuads) {
    if (
      quad.predicate !== `${DKG}publicSnapshotRef` &&
      quad.predicate !== `${DKG}publicSnapshotGraph` &&
      quad.predicate !== `${DKG}publicQuadsDigest` &&
      quad.predicate !== `${DKG}publicQuadsCount` &&
      quad.predicate !== `${DKG}publishedAt` &&
      quad.predicate !== `${DKG}kaUal`
    ) {
      continue;
    }
    const entry = bySubject.get(quad.subject) ?? {};
    const value = stripLiteral(quad.object)?.trim();
    if (quad.predicate === `${DKG}publicSnapshotRef`) entry.ref = value;
    if (quad.predicate === `${DKG}publicSnapshotGraph`) entry.hasSnapshotGraph = true;
    if (quad.predicate === `${DKG}publicQuadsDigest`) entry.digest = value;
    if (quad.predicate === `${DKG}publicQuadsCount`) entry.count = parseIntegerLiteral(quad.object);
    if (quad.predicate === `${DKG}publishedAt` && value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) entry.publishedAtMs = parsed;
    }
    if (quad.predicate === `${DKG}kaUal` && value) {
      const match = value.match(/\/(\d+)$/);
      if (match) {
        try { entry.ualOrdinal = BigInt(match[1]!); } catch { /* scheduling hint only */ }
      }
    }
    bySubject.set(quad.subject, entry);
  }

  const byRef = new Map<string, PublicSnapshotMetadata>();
  const sourceSubjectsByRef = new Map<string, Set<string>>();
  for (const [subject, entry] of bySubject) {
    // Read-both (RFC ka-metadata-trim Phase 2): old-store rows carry an
    // explicit `dkg:publicSnapshotRef` (byte-identical to the digest); new
    // store-backed rows carry only the digest — their ref IS the digest
    // (`putSnapshot` returns `ref === digest`). Rows with a
    // `dkg:publicSnapshotGraph` are graph-backed, not snapshot-store-backed:
    // their quads travel through ordinary graph sync, so they are NOT
    // snapshot-fetch targets.
    let ref = entry.ref;
    if (!ref) {
      // Derived (new-shape) rows must be complete to qualify — an incomplete
      // digest-only row is ignored exactly as ref-less rows always were,
      // rather than promoted into the hard integrity throw below (which
      // stays reserved for explicit-ref rows written by older nodes).
      if (entry.hasSnapshotGraph || !entry.digest || !Number.isInteger(entry.count)) continue;
      ref = entry.digest;
    }
    if (!entry.digest || !Number.isInteger(entry.count)) {
      throw new Error(`Shared-memory public snapshot metadata for ${subject} is missing digest/count`);
    }
    const sources = sourceSubjectsByRef.get(ref) ?? new Set<string>();
    sources.add(subject);
    sourceSubjectsByRef.set(ref, sources);
    const existing = byRef.get(ref);
    const metadata: PublicSnapshotMetadata = {
      ref,
      digest: entry.digest,
      count: entry.count!,
      ...(entry.publishedAtMs !== undefined ? { publishedAtMs: entry.publishedAtMs } : {}),
      ...(entry.ualOrdinal !== undefined ? { ualOrdinal: entry.ualOrdinal } : {}),
    };
    if (existing && (existing.digest !== metadata.digest || existing.count !== metadata.count)) {
      throw new Error(`Conflicting shared-memory public snapshot metadata for ${ref}`);
    }
    if (!existing) {
      byRef.set(ref, metadata);
      continue;
    }
    const newerHints = newerPublicSnapshotRecency(existing, metadata);
    byRef.set(ref, {
      ...existing,
      ...(newerHints.publishedAtMs !== undefined ? { publishedAtMs: newerHints.publishedAtMs } : {}),
      ...(newerHints.ualOrdinal !== undefined ? { ualOrdinal: newerHints.ualOrdinal } : {}),
    });
  }
  return { snapshots: [...byRef.values()], sourceSubjectsByRef };
}

function newerPublicSnapshotRecency(
  left: Pick<PublicSnapshotMetadata, 'publishedAtMs' | 'ualOrdinal'>,
  right: Pick<PublicSnapshotMetadata, 'publishedAtMs' | 'ualOrdinal'>,
): Pick<PublicSnapshotMetadata, 'publishedAtMs' | 'ualOrdinal'> {
  if ((right.publishedAtMs ?? -1) !== (left.publishedAtMs ?? -1)) {
    return (right.publishedAtMs ?? -1) > (left.publishedAtMs ?? -1) ? right : left;
  }
  return (right.ualOrdinal ?? -1n) > (left.ualOrdinal ?? -1n) ? right : left;
}

function parseIntegerLiteral(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(stripLiteral(value) ?? '', 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
