// SPDX-License-Identifier: Apache-2.0
import { assertionLifecycleWriteLockKey, tryWithKeyedLocks, withKeyedLocks } from '@origintrail-official/dkg-publisher';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { ConfirmedNamedKaVmLifecycleInput } from './named-ka-vm-lifecycle-repair.js';
import { isConfirmedNamedKaVmLifecycleCurrent } from './named-ka-vm-lifecycle-current.js';
import { applyPublishedNamedKaVmLifecycle, confirmedNamedKaVmLifecycleApplyOptions } from './named-ka-vm-lifecycle.js';

type Coordinates = Pick<ConfirmedNamedKaVmLifecycleInput, 'contextGraphId' | 'name' | 'agentAddress' | 'subGraphName'>;
export interface ConfirmedNamedKaVmLifecycleAdmission {
  readonly lifecycleAuthor: string;
  readonly preserveVerifiedVmProof: boolean;
}
interface ExecutionCapabilities {
  readonly writeLocks: Map<string, Promise<void>>;
  readonly isCurrent: (input: ConfirmedNamedKaVmLifecycleInput) => Promise<boolean>;
  readonly apply: (input: ConfirmedNamedKaVmLifecycleInput, preserveVerifiedVmProof: boolean) => Promise<void>;
}

/** One host policy for both journal replay and transaction-owned queue recovery. */
export function confirmedLifecycleExecutionCapabilities(host: {
  store: TripleStore;
  chain: Parameters<typeof isConfirmedNamedKaVmLifecycleCurrent>[0];
  writeLocks: Map<string, Promise<void>>;
  dataDir?: string;
  readTimeoutMs: number;
}): ExecutionCapabilities {
  return {
    writeLocks: host.writeLocks,
    isCurrent: input => isConfirmedNamedKaVmLifecycleCurrent(host.chain, input, host.readTimeoutMs, Boolean(host.dataDir)),
    apply: (input, preserveVerifiedVmProof = false) => applyPublishedNamedKaVmLifecycle(host.store, input, {
      ...confirmedNamedKaVmLifecycleApplyOptions(host.dataDir), preserveVerifiedVmProof,
    }),
  };
}

/** Callers retain their admission/settlement rules inside the shared write fence. */
export class ConfirmedNamedKaVmLifecycleExecutor {
  constructor(readonly capabilities: ExecutionCapabilities) {}
  private key(input: Coordinates): string {
    return assertionLifecycleWriteLockKey(input.contextGraphId, input.name, input.agentAddress, input.subGraphName);
  }
  withLock<T>(input: Coordinates, work: () => Promise<T>): Promise<T> {
    return withKeyedLocks(this.capabilities.writeLocks, [this.key(input)], work);
  }
  /** Queue recovery holds its claim lock, so it must defer instead of waiting here. */
  tryWithLock<T>(input: Coordinates, work: () => Promise<T>) {
    return tryWithKeyedLocks(this.capabilities.writeLocks, [this.key(input)], work);
  }
  /** The caller holds our lock; recheck caller-specific admission after the external proof. */
  async commitIfCurrent(input: ConfirmedNamedKaVmLifecycleInput,
    admit: () => Promise<ConfirmedNamedKaVmLifecycleAdmission | undefined>,
  ): Promise<boolean> {
    if (!await this.capabilities.isCurrent(input)) return false;
    const admission = await admit();
    if (!admission) return false;
    await this.capabilities.apply({ ...input, agentAddress: admission.lifecycleAuthor }, admission.preserveVerifiedVmProof);
    return true;
  }
}
