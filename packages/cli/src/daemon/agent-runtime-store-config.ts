import { join } from 'node:path';
import {
  withManagedOxigraphRuntimeStoreConfigV1,
  type ChangelogEraGuard,
  type GraphCatalogStoreConfig,
  type ManagedOxigraphRuntimeStoreConfigV1,
  type ReadGraphStoreConfig,
  type TripleStoreConfig,
} from '@origintrail-official/dkg-storage';

export interface AgentRuntimeStoreConfigInput {
  readonly runtimeStore: TripleStoreConfig | undefined;
  readonly managedStore: ManagedOxigraphRuntimeStoreConfigV1 | undefined;
  readonly changelogEnabled: boolean;
  readonly changelogEraGuard: ChangelogEraGuard | undefined;
  /** The read-graph settings of `query` in config.json, for every store object over the backend. */
  readonly readGraphs?: ReadGraphStoreConfig;
  /** The data directory, where the agent keeps its default store when no store is configured. */
  readonly dataDir?: string;
  /** `store.graphCatalog`, checked and applied at boot; carried on the store config the agent builds. */
  readonly graphCatalog?: GraphCatalogStoreConfig;
}

/** Assemble the exact store config passed from the daemon into DKGAgent.create. */
export function buildAgentRuntimeStoreConfig(
  input: AgentRuntimeStoreConfigInput,
): TripleStoreConfig | undefined {
  if (!input.runtimeStore) {
    // Without a store section the agent builds its default embedded store. A written query section's settings reach
    // it as the same store, configured explicitly; the agent adds its default large-literal storage as it does by
    // default. The daemon passes none on a node that starts from a public checkpoint, whose store the checkpoint builds.
    return input.readGraphs === undefined || input.dataDir === undefined
      ? undefined
      : { backend: 'oxigraph-worker', options: { path: join(input.dataDir, 'store.nq') }, readGraphs: input.readGraphs, graphCatalog: input.graphCatalog };
  }
  if (input.changelogEnabled && !input.changelogEraGuard) {
    throw new Error('enabled changelog requires its durable era guard');
  }
  const changelog = input.changelogEnabled
    ? { enabled: true, eraGuard: input.changelogEraGuard! }
    : undefined;
  const complete: TripleStoreConfig = {
    backend: input.runtimeStore.backend,
    options: input.runtimeStore.options,
    graphSetIndex: input.runtimeStore.graphSetIndex,
    changelog,
    readGraphs: input.readGraphs,
    graphCatalog: input.graphCatalog,
  };
  return input.managedStore
    ? withManagedOxigraphRuntimeStoreConfigV1(input.managedStore, {
      graphSetIndex: complete.graphSetIndex,
      changelog: complete.changelog,
      readGraphs: complete.readGraphs,
      graphCatalog: complete.graphCatalog,
    })
    : complete;
}
