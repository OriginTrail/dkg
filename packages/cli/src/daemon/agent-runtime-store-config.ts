import {
  withManagedOxigraphRuntimeStoreConfigV1,
  type ChangelogEraGuard,
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
}

/** Assemble the exact store config passed from the daemon into DKGAgent.create. */
export function buildAgentRuntimeStoreConfig(
  input: AgentRuntimeStoreConfigInput,
): TripleStoreConfig | undefined {
  if (!input.runtimeStore) return undefined;
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
  };
  return input.managedStore
    ? withManagedOxigraphRuntimeStoreConfigV1(input.managedStore, {
      graphSetIndex: complete.graphSetIndex,
      changelog: complete.changelog,
      readGraphs: complete.readGraphs,
    })
    : complete;
}
