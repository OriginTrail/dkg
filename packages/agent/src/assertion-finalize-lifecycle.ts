// SPDX-License-Identifier: Apache-2.0
import { ASSERTION_SEAL_PREDICATES, GRAPH_KA_CONTENT_SCOPE_VERSION, LegacyKnowledgeAssetReadOnlyError } from '@origintrail-official/dkg-core';
import { KA_ID_PRED, RESERVED_UAL_PRED, VM_CURRENT_ASSERTION_PRED } from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';

const stripLifecycleLiteral = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  return String(value).replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, '').trim();
};

export async function readFinalizeKaNumber(
  store: TripleStore, metaGraph: string, lifecycleUri: string, source: string,
): Promise<bigint | undefined> {
  const result = await store.query(
    `SELECT ?n WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${KA_ID_PRED}> ?n } } LIMIT 1`, { source },
  );
  const value = result.type === 'bindings' ? result.bindings[0]?.['n'] : undefined;
  return value === undefined ? undefined : BigInt(stripLifecycleLiteral(value)!);
}

/** Keep ordinary finalize's legacy literal handling; guarded callers already have a strict snapshot. */
export async function readFinalizeLifecycle(store: TripleStore, metaGraph: string, lifecycleUri: string, readReservedUal: boolean) {
  const lifecycleScopeResult = await store.query(
    `SELECT ?scope ?version ?vm WHERE { GRAPH <${metaGraph}> {
      OPTIONAL { <${lifecycleUri}> <${ASSERTION_SEAL_PREDICATES.CONTENT_SCOPE_VERSION}> ?scope }
      OPTIONAL { <${lifecycleUri}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION}> ?version }
      OPTIONAL { <${lifecycleUri}> <${VM_CURRENT_ASSERTION_PRED}> ?vm }
    } } LIMIT 1`,
    { source: 'agent.assertionFinalize.lifecycleScope' },
  );
  const lifecycleScopeRow = lifecycleScopeResult.type === 'bindings'
    ? lifecycleScopeResult.bindings[0]
    : undefined;
  const persistedScopeVersion = stripLifecycleLiteral(lifecycleScopeRow?.['scope']);
  const persistedAssertionVersion = stripLifecycleLiteral(lifecycleScopeRow?.['version']);
  const hasConfirmedVm = lifecycleScopeRow?.['vm'] !== undefined;
  if (persistedScopeVersion !== String(GRAPH_KA_CONTENT_SCOPE_VERSION)) {
    throw new LegacyKnowledgeAssetReadOnlyError();
  }
  const number = await readFinalizeKaNumber(store, metaGraph, lifecycleUri, 'agent.assertionFinalize.existingKaId');
  let reservedUal: string | undefined;
  if (number !== undefined && readReservedUal) {
    const result = await store.query(
      `SELECT ?u WHERE { GRAPH <${metaGraph}> { <${lifecycleUri}> <${RESERVED_UAL_PRED}> ?u } } LIMIT 1`,
      { source: 'agent.assertionFinalize.reservedUal' },
    );
    if (result.type === 'bindings') reservedUal = stripLifecycleLiteral(result.bindings[0]?.['u']);
  }
  return { number, reservedUal, hasConfirmedVm, persistedAssertionVersion };
}
