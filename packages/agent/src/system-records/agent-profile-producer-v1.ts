// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';

import type { PreparedAgentProfileV1 } from '../profile.js';
import { commitAgentProfileProductionV1 } from './agent-profile-producer-commit-v1.js';
import type {
  AgentProfileProducerCommitDependenciesV1,
  AgentProfileProducerInventoryDependenciesV1,
  AgentProfileProducerLeaseV1,
  AgentProfileProducerPreparationDependenciesV1,
  AgentProfileProducerPublicationV1,
  AgentProfileProducerSigningDependenciesV1,
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
  const preparationDependencies: AgentProfileProducerPreparationDependenciesV1 = Object.freeze({
    networkId: options.networkId,
    publicationDeployment: options.publicationDeployment,
    peerId: options.peerSigner.peerId,
    peerPublicKey: options.peerSigner.publicKey,
    evmIssuer: options.evmSigner.address,
    ...(options.nowMs === undefined ? {} : { nowMs: () => options.nowMs?.() ?? Date.now() }),
    snapshot: () => options.store.snapshot(),
  });
  const signingDependencies: AgentProfileProducerSigningDependenciesV1 = Object.freeze({
    peerSigner: options.peerSigner,
    evmSigner: options.evmSigner,
  });
  const resolveArtifact: AgentProfileProducerInventoryDependenciesV1['resolveArtifact'] =
    (reference) => options.store.resolveArtifact(reference);
  const inventoryDependencies: AgentProfileProducerInventoryDependenciesV1 = Object.freeze({
    networkId: options.networkId,
    peerSigner: options.peerSigner,
    resolveArtifact,
  });
  const prepareCommit: AgentProfileProducerCommitDependenciesV1['prepareCommit'] =
    (input) => options.store.prepareCommit(input);
  const install: AgentProfileProducerCommitDependenciesV1['install'] =
    (input) => options.install(input);
  const commitDependencies: AgentProfileProducerCommitDependenciesV1 = Object.freeze({
    prepareCommit,
    install,
  });
  let active = false;
  const completePrepared = async (
    prepared: PreparedAgentProfileV1,
    projectionQuads: readonly Readonly<Quad>[],
    publication: AgentProfilePublicationBindingV1,
    signal: AbortSignal,
  ): Promise<AgentProfileProducerPublicationV1> => {
    signal.throwIfAborted();
    const preparation = await prepareAgentProfileProductionV1(
      preparationDependencies,
      prepared,
      projectionQuads,
      publication,
    );
    const signed = await signAgentProfileProductionV1(
      signingDependencies,
      preparation,
      signal,
    );
    const inventoryPlan = await prepareAgentProfileProductionInventoryV1(
      inventoryDependencies,
      preparation,
      signed,
      signal,
    );
    return commitAgentProfileProductionV1(
      commitDependencies,
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
