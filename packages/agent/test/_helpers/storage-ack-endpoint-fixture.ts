import { StorageACKRegistrationRuntime } from '../../src/p2p/storage-ack-registration-runtime.js';
import type { StorageACKEndpoint } from '../../src/p2p/storage-ack-endpoint.js';

function registrationRuntime(agent: unknown): StorageACKRegistrationRuntime {
  return (agent as { storageACKRegistrationRuntime: StorageACKRegistrationRuntime }).storageACKRegistrationRuntime;
}

/** Install through the runtime so fixtures obey endpoint ownership. */
export async function installStorageACKFixtureEndpoint(
  agent: unknown,
  endpoint: StorageACKEndpoint | Pick<StorageACKEndpoint, 'dispatch'>,
): Promise<void> {
  const ownedEndpoint: StorageACKEndpoint = 'dispose' in endpoint
    ? endpoint as StorageACKEndpoint
    : { dispatch: endpoint.dispatch, dispose() {} };
  await registrationRuntime(agent).startGeneration({
    attempt: async () => ({ kind: 'registered', endpoint: ownedEndpoint }),
    retryDelayMs: 1_000,
    isStarted: () => true,
    onRetryScheduled: () => { throw new Error('Fixture StorageACK registration unexpectedly retried'); },
    onError: (_phase, error) => { throw error; },
  });
}

export async function clearStorageACKFixtureEndpoint(agent: unknown): Promise<void> {
  await registrationRuntime(agent).closeAndDrain();
}
