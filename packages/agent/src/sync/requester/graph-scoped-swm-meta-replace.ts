import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';

/**
 * Remove the prior active head and every linked operation before inserting the
 * verified graph-scoped recovery metadata. Keeping this beside the recovery
 * model makes data and metadata replacement one explicit store invariant.
 */
export async function deletePriorGraphScopedSwmRecoveryMetadata(
  store: TripleStore,
  assets: readonly GraphScopedSwmRecoveryDescriptor[],
): Promise<void> {
  for (const asset of assets) {
    const linkedOperations = await store.query(
      `SELECT DISTINCT ?op WHERE { GRAPH <${assertSafeIri(asset.metaGraph)}> { ` +
        `<${assertSafeIri(asset.headSubject)}> <http://dkg.io/ontology/shareOperationId> ?shareId . ` +
        `?op <http://dkg.io/ontology/shareOperationId> ?shareId ; ` +
        `<http://dkg.io/ontology/kaUal> <${assertSafeIri(asset.kaUal)}> . } }`,
      {
        priority: 'background',
        source: 'agent.swmRecovery.replaceGraphMeta.findOperations',
      },
    );
    const operationSubjects = new Set<string>([asset.operationSubject]);
    if (linkedOperations.type === 'bindings') {
      for (const row of linkedOperations.bindings) {
        const operation = row['op'];
        if (operation) operationSubjects.add(operation);
      }
    }
    await store.deleteByPattern(
      { graph: asset.metaGraph, subject: asset.headSubject },
      {
        priority: 'background',
        source: 'agent.swmRecovery.replaceGraphMeta.deleteHead',
      },
    );
    for (const operationSubject of operationSubjects) {
      await store.deleteByPattern(
        { graph: asset.metaGraph, subject: operationSubject },
        {
          priority: 'background',
          source: 'agent.swmRecovery.replaceGraphMeta.deleteOperation',
        },
      );
    }
  }
}
