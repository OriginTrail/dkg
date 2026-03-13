import type { Quad } from '@origintrail-official/dkg-storage';
import type { CASCondition } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from './dkg-agent.js';

/**
 * Ordered list of domain stages. Each stage can only transition forward.
 * Example: `['recruiting', 'traveling', 'finished']`
 */
export type MonotonicStages = readonly string[];

const DKG = 'http://dkg.io/ontology/';
export const DKG_STATE_VERSION = `${DKG}stateVersion`;
export const DKG_STATE_UPDATED_AT = `${DKG}stateUpdatedAt`;

/**
 * Validates and builds a CAS condition for a forward-only stage transition.
 * Returns the condition and the quad that sets the new value.
 *
 * @throws if `from → to` is not a forward transition in the given stage list
 */
export function monotonicTransition(
  stages: MonotonicStages,
  subject: string,
  predicate: string,
  from: string | null,
  to: string,
): { condition: CASCondition; quad: Pick<Quad, 'subject' | 'predicate' | 'object'> } {
  const toIdx = stages.indexOf(to);
  if (toIdx < 0) {
    throw new Error(`Target stage "${to}" is not in the stage list: [${stages.join(', ')}]`);
  }

  if (from !== null) {
    const fromIdx = stages.indexOf(from);
    if (fromIdx < 0) {
      throw new Error(`Current stage "${from}" is not in the stage list: [${stages.join(', ')}]`);
    }
    if (toIdx <= fromIdx) {
      throw new Error(`Non-monotonic transition: "${from}" (index ${fromIdx}) → "${to}" (index ${toIdx})`);
    }
  }

  return {
    condition: {
      subject,
      predicate,
      expectedValue: from === null ? null : `"${from}"`,
    },
    quad: { subject, predicate, object: `"${to}"` },
  };
}

/**
 * Convenience wrapper: writes quads with a CAS condition on a version counter.
 * Uses the caller-provided `currentVersion` as the expected value, increments
 * it, and writes the new value alongside the provided quads.
 *
 * The caller is responsible for supplying the correct current version — this
 * helper does NOT read it from the store. The CAS condition ensures the write
 * fails with `StaleWriteError` if another write has changed the version since
 * the caller last observed it.
 *
 * @param agent         The DKG agent instance
 * @param paranetId     Target paranet
 * @param subject       The entity whose version is tracked
 * @param currentVersion Expected current version, or `null` if the version triple
 *                       must not yet exist (first write). Passing `0` expects a
 *                       stored `"0"^^xsd:integer` — it does NOT mean "first write".
 * @param quads         Application quads to write
 * @param opts          Optional: `{ localOnly?: boolean }`
 * @returns The new version number and workspace operation ID
 */
export async function versionedWrite(
  agent: DKGAgent,
  paranetId: string,
  subject: string,
  currentVersion: number | null,
  quads: Quad[],
  opts?: { localOnly?: boolean },
): Promise<{ newVersion: number; workspaceOperationId: string }> {
  const newVersion = currentVersion === null ? 1 : currentVersion + 1;

  const expectedValue = currentVersion === null
    ? null
    : `"${currentVersion}"^^<http://www.w3.org/2001/XMLSchema#integer>`;

  const conditions: CASCondition[] = [{
    subject,
    predicate: DKG_STATE_VERSION,
    expectedValue,
  }];

  const versionQuads: Quad[] = [
    { subject, predicate: DKG_STATE_VERSION, object: `"${newVersion}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: '' },
    { subject, predicate: DKG_STATE_UPDATED_AT, object: `"${new Date().toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`, graph: '' },
  ];

  const allQuads = [...quads, ...versionQuads];

  const { workspaceOperationId } = await agent.writeConditionalToWorkspace(
    paranetId,
    allQuads,
    conditions,
    opts,
  );

  return { newVersion, workspaceOperationId };
}
