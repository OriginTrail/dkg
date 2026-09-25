import { StorageACKRegistrationRuntime } from '../../src/p2p/storage-ack-registration-runtime.js';
import type { StorageACKEndpoint } from '../../src/p2p/storage-ack-endpoint.js';

function registrationRuntime(agent: unknown): StorageACKRegistrationRuntime {
  return (agent as { storageACKRegistrationRuntime: StorageACKRegistrationRuntime }).storageACKRegistrationRuntime;
}

/** Install through the runtime so fixtures obey endpoint ownership. */
export function installStorageACKFixtureEndpoint(
  agent: unknown,
  endpoint: StorageACKEndpoint | Pick<StorageACKEndpoint, 'dispatch'>,
): void {
  const ownedEndpoint: StorageACKEndpoint = 'dispose' in endpoint
    ? endpoint as StorageACKEndpoint
    : { dispatch: endpoint.dispatch, dispose() {} };
  if (!registrationRuntime(agent).installFixtureEndpoint(ownedEndpoint)) {
    throw new Error('Fixture StorageACK endpoint could not be installed');
  }
}

export async function clearStorageACKFixtureEndpoint(agent: unknown): Promise<void> {
  await registrationRuntime(agent).closeAndDrain();
}
