// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';

import type { PreparedAgentProfileV1 } from '../profile.js';
import { commitAgentProfileProductionV1 } from './agent-profile-producer-commit-v1.js';
import type {
  AgentProfileProducerLeaseV1,
  AgentProfileProducerPublicationV1,
  AgentProfileProducerV1,
  AgentProfilePublicationBindingV1,
  CreateAgentProfileProducerOptionsV1,
} from './agent-profile-producer-contract-v1.js';
import { prepareAgentProfileProductionInventoryV1 } from './agent-profile-producer-inventory-v1.js';
import {
  assertAdvertisedAgentProfileIdentityV1,
  prepareAgentProfileProductionV1,
  snapshotPreparedProfileV1,
  validateAgentProfileProjectionV1,
} from './agent-profile-producer-preparation-v1.js';
import { signAgentProfileProductionV1 } from './agent-profile-producer-signing-v1.js';

export * from './agent-profile-producer-contract-v1.js';

/**
 * Author one local profile record. No protocol, timer, queue, or independent
 * runtime is created here; lifecycle supplies the B4 fence/install closures.
 */
export function createAgentProfileProducerV1(
  options: CreateAgentProfileProducerOptionsV1,
): AgentProfileProducerV1 {
  let active = false;
  const completePrepared = async (
    prepared: PreparedAgentProfileV1,
    projectionQuads: readonly Readonly<Quad>[],
    publication: AgentProfilePublicationBindingV1,
    signal: AbortSignal,
  ): Promise<AgentProfileProducerPublicationV1> => {
    signal.throwIfAborted();
    const preparation = await prepareAgentProfileProductionV1(
      options,
      prepared,
      projectionQuads,
      publication,
    );
    const signed = await signAgentProfileProductionV1(options, preparation, signal);
    const inventoryPlan = await prepareAgentProfileProductionInventoryV1(
      options,
      preparation,
      signed,
      signal,
    );
    return commitAgentProfileProductionV1(
      options,
      preparation,
      signed,
      inventoryPlan,
      signal,
    );
  };

  return Object.freeze({
    async prepare(prepared: PreparedAgentProfileV1): Promise<AgentProfileProducerLeaseV1> {
      if (active) throw new Error('agent-profile producer is busy');
      const preparedSnapshot = snapshotPreparedProfileV1(prepared);
      const projectionQuads = validateAgentProfileProjectionV1(preparedSnapshot);
      assertAdvertisedAgentProfileIdentityV1(
        preparedSnapshot.rootEntity,
        projectionQuads,
        options.peerSigner,
        options.evmSigner.address,
      );
      active = true;
      const controller = new AbortController();
      try {
        await options.fence(preparedSnapshot, controller.signal);
      } catch (error) {
        active = false;
        throw error;
      }
      let state: 'prepared' | 'completing' | 'settled' = 'prepared';
      return Object.freeze({
        async complete(
          publication: AgentProfilePublicationBindingV1,
        ): Promise<AgentProfileProducerPublicationV1> {
          if (state !== 'prepared') throw new Error('agent-profile producer lease is not live');
          state = 'completing';
          try {
            return await completePrepared(
              preparedSnapshot,
              projectionQuads,
              publication,
              controller.signal,
            );
          } finally {
            state = 'settled';
            active = false;
          }
        },
        abort(reason?: unknown): void {
          if (state === 'settled') return;
          controller.abort(reason ?? new Error('agent-profile production aborted'));
          if (state === 'prepared') {
            state = 'settled';
            active = false;
          }
        },
      });
    },
  });
}
