// SPDX-License-Identifier: Apache-2.0
// Projection tests deliberately omit VM payloads; runtime confirmed completion uses the materialization owner.
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { mutatePublishedNamedKaVmLifecycle, type PublishedNamedKaVmLifecycleInput, type NamedKaVmLifecycleApplyOptions } from '../../src/named-ka-vm-lifecycle.js';
export async function applyPublishedNamedKaVmLifecycle(store: TripleStore, input: PublishedNamedKaVmLifecycleInput,
  options: NamedKaVmLifecycleApplyOptions = { persistence: 'restart-durable' },
): Promise<void> {
  if ('tentative' in input) return mutatePublishedNamedKaVmLifecycle(store, input);
  const capability = store.commitment;
  const barrier = capability && (capability.durability === 'restart-durable' || options.persistence === 'process-local') ? capability.capture() : undefined;
  if (!barrier) throw Object.assign(new Error('Confirmed lifecycle test requires certified persistence'), { code: 'KA_VM_LIFECYCLE_DURABILITY_UNAVAILABLE' });
  await mutatePublishedNamedKaVmLifecycle(store, input, options.preserveVerifiedVmProof);
  await barrier({ source: 'agent.publish.confirmedLifecycleFlush' });
}
