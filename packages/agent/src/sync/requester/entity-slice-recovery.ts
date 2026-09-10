import { decodeEntityShareMetadata, type EntityShareSliceDescriptor } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { RecoveryExecutionAdmission } from './recovery-execution-guard.js';

export interface EntityRecoveryBatch {
  readonly rows: Quad[];
  /** Only refs whose canonical slice metadata is included in rows. */
  readonly refs: readonly string[];
}

/** Write the admitted batch before publishing its resolved refs and coverage. */
export async function commitEntityRecoveryBatch(
  batch: EntityRecoveryBatch,
  effects: {
    readonly admission: RecoveryExecutionAdmission;
    ensureContextGraph(): Promise<void>;
    insert(rows: Quad[]): Promise<void>;
    hydrateOwnership(): void;
    markResolved(ref: string): void;
    recordCoverage(): void;
  },
): Promise<void> {
  if (batch.rows.length > 0) {
    await effects.admission.admitAsyncMutation(async () => {
      await effects.ensureContextGraph();
      await effects.insert(batch.rows);
      // Once admitted, ownership drains with the durable write even if the
      // caller's selection is revoked while storage is awaited.
      effects.hydrateOwnership();
    });
    for (const ref of batch.refs) effects.markResolved(ref);
  }
  effects.recordCoverage();
}

/** Apply reference authority and whole-operation readiness to decoded metadata. */
export function createEntitySliceRecoveryPlan(
  contextGraphId: string,
  metaQuads: readonly Quad[],
  sourcesByRef: ReadonlyMap<string, ReadonlySet<string>>,
): { refs: ReadonlySet<string>; batchFor(readyRefs: ReadonlySet<string>): EntityRecoveryBatch } {
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
