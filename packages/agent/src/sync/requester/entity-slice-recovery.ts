import { decodeEntityShareMetadata, type EntityShareSliceDescriptor } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';

export interface EntityRecoveryBatch {
  readonly rows: Quad[];
  /** Only refs whose canonical slice metadata is included in rows. */
  readonly refs: readonly string[];
}

export interface EntitySliceRecoveryAuthority {
  readonly refs: ReadonlySet<string>;
  batchFor(readyRefs: ReadonlySet<string>): EntityRecoveryBatch;
}

export type EntityRecoveryPhaseOutcome =
  | { readonly kind: 'usable'; readonly metadataRows: readonly Quad[]; readonly newlyCountedMetadataRows: number }
  | { readonly kind: 'parse-failed' }
  | { readonly kind: 'evidence-rejected' }
  | { readonly kind: 'incomplete' };

export interface EntityRecoveryCounterEffects {
  readonly insertedTriples: number;
  readonly insertedMetaTriples: number;
  readonly insertedDataTriples: number;
}

export type EntityRecoveryPlan = {
  readonly rows: Quad[];
  /** Publish these refs only after rows and ownership are durable. */
  readonly postCommitRefs: readonly string[];
  readonly counters: EntityRecoveryCounterEffects;
  readonly recordDataPhase: boolean;
} & (
  | { readonly kind: 'usable'; readonly recordMetaPhase: true }
  | { readonly kind: Exclude<EntityRecoveryPhaseOutcome['kind'], 'usable'>; readonly recordMetaPhase: false }
);

/**
 * Reduce the correlated snapshot flags to one explicit recovery transaction.
 * This function is deliberately pure: the requester keeps the short, visible
 * durability sequence and applies these post-commit effects only afterwards.
 */
export function planEntityRecovery(input: {
  readonly phase: EntityRecoveryPhaseOutcome;
  readonly verifiedDataRows: readonly Quad[];
  readonly entityAuthority: EntitySliceRecoveryAuthority;
  readonly readyRefs: ReadonlySet<string>;
}): EntityRecoveryPlan {
  const readyBatch = input.entityAuthority.batchFor(input.readyRefs);
  const entityBatch = input.phase.kind === 'usable' || input.phase.kind === 'parse-failed'
    ? readyBatch
    : { rows: [], refs: [] };
  const metadataRows = input.phase.kind === 'usable'
    ? [...input.phase.metadataRows]
    : entityBatch.rows;
  const rows = [...input.verifiedDataRows, ...metadataRows];
  const insertedMetaTriples = input.phase.kind === 'usable'
    ? input.phase.newlyCountedMetadataRows
    : metadataRows.length;
  const common = {
    rows,
    postCommitRefs: metadataRows.length > 0 ? entityBatch.refs : [],
    counters: {
      insertedTriples: input.verifiedDataRows.length + insertedMetaTriples,
      insertedMetaTriples,
      insertedDataTriples: input.verifiedDataRows.length,
    },
    recordDataPhase: input.phase.kind === 'usable' || input.verifiedDataRows.length > 0,
  };
  return input.phase.kind === 'usable'
    ? { ...common, kind: 'usable', recordMetaPhase: true }
    : { ...common, kind: input.phase.kind, recordMetaPhase: false };
}

/** Apply reference authority and whole-operation readiness to decoded metadata. */
export function createEntitySliceRecoveryPlan(
  contextGraphId: string,
  metaQuads: readonly Quad[],
  sourcesByRef: ReadonlyMap<string, ReadonlySet<string>>,
): EntitySliceRecoveryAuthority {
  const records = decodeEntityShareMetadata(contextGraphId, metaQuads);
  const key = (graph: string, subject: string) => `${graph}\u0000${subject}`;
  const headClaims = new Set(records.filter(record => record.kind === 'head')
    .flatMap(record => record.operationSubjects.map(subject => key(record.graph, subject))));
  const refsBySubject = new Map<string, Set<string>>();
  for (const [ref, subjects] of sourcesByRef) {
    for (const subject of subjects) {
      const refs = refsBySubject.get(subject) ?? new Set<string>();
      refs.add(ref);
      refsBySubject.set(subject, refs);
    }
  }
  const slices: EntityShareSliceDescriptor[] = [];
  const validSources = new Map<string, boolean>();
  for (const record of records) {
    const sourceRefs = refsBySubject.get(record.subject);
    const valid = record.kind === 'slice' && sourceRefs?.size === 1 && sourceRefs.has(record.ref);
    validSources.set(record.subject, (validSources.get(record.subject) ?? true) && valid);
    if (valid) slices.push(record);
  }
  const refs = new Set<string>();
  for (const [ref, subjects] of sourcesByRef) {
    if (subjects.size > 0 && [...subjects].every(subject => validSources.get(subject) === true)) refs.add(ref);
  }
  return {
    refs,
    batchFor(readyRefs) {
      const readySlices = slices.filter(slice => refs.has(slice.ref) && readyRefs.has(slice.ref));
      const rows = readySlices.flatMap(slice => slice.metadataRows);
      for (const operation of records) {
        if (operation.kind !== 'operation' || headClaims.has(key(operation.graph, operation.subject))) continue;
        if (operation.rootEntities.every(root => readySlices.some(slice =>
          slice.graph === operation.graph && slice.operationSubject === operation.subject
          && slice.subGraphName === operation.subGraphName && slice.rootEntity === root))) rows.push(...operation.metadataRows);
      }
      return { rows, refs: [...new Set(readySlices.map(slice => slice.ref))] };
    },
  };
}
