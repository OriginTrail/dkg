import type { ApiClient } from '../src/api-client.js';

type SubscribeResponse = Awaited<ReturnType<ApiClient['subscribeToContextGraph']>>;
type LegacySubscribeResponse = Awaited<ReturnType<ApiClient['subscribe']>>;

function assertQueuedScopeAliases(
  response: SubscribeResponse | LegacySubscribeResponse,
): void {
  if (response.catchup && 'jobId' in response.catchup) {
    const includeSharedMemory: boolean = response.catchup.includeSharedMemory;
    const includeWorkspace: boolean = response.catchup.includeWorkspace;

    void includeSharedMemory;
    void includeWorkspace;
  }
}

declare const currentResponse: SubscribeResponse;
declare const legacyResponse: LegacySubscribeResponse;

assertQueuedScopeAliases(currentResponse);
assertQueuedScopeAliases(legacyResponse);
