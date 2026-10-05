// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { createStrictCurrentFinalizedEvmSnapshotScopeV1, resolveRpcUrls } from '@origintrail-official/dkg-chain';
import type { ContextGraphIdV1, DecimalU256V1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import type { DKGAgent } from './dkg-agent.js';
import { proveRegisteredPrivateEmptyVmV1 } from './rfc64/registered-private-empty-vm-proof-v1.js';

export class RegisteredPrivateEmptyVmMethods {
  /** A zero-VM proof grants durable readiness only; SWM still needs its own proof. */
  async proveRegisteredPrivateEmptyVmV1(
    this: DKGAgent,
    contextGraphId: string,
    callerAgentAddress: string,
  ): Promise<boolean> {
    try {
      const caller = callerAgentAddress.toLowerCase();
      if (!ethers.isAddress(caller) ||
        this.subscribedContextGraphs.get(contextGraphId)?.subscribed !== true) return false;
      const authority = () => this.resolveContextGraphSubscriptionBootstrapAuthority(
        contextGraphId,
        { callerAgentAddress: caller, allowSubscriptionFallback: false },
      );
      const before = await authority();
      if (before.outcome !== 'allowed' || before.source !== 'registered-chain'
        || before.onChainId === undefined || before.registration === 'unregistered') return false;
      const accepted = this.readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId);
      const chainConfig = this.config.chainConfig;
      if (accepted?.policy.accessPolicy !== 1 || chainConfig === undefined) return false;
      const endpoints = resolveRpcUrls(chainConfig.rpcUrl, chainConfig.rpcUrls);
      if (endpoints.length === 0) return false;
      const chainId = accepted.policy.governanceChainId;
      if (chainId === null) return false;
      const depth = this.chain.getFinalityConfirmations?.()
        ?? chainConfig.finalityConfirmations;
      const proven = await proveRegisteredPrivateEmptyVmV1({
        contextGraphId: contextGraphId as ContextGraphIdV1,
        onChainContextGraphId: before.onChainId.toString(10) as DecimalU256V1,
        callerAgentAddress: caller as EvmAddressV1,
        accepted,
        snapshot: createStrictCurrentFinalizedEvmSnapshotScopeV1({
          chainId, endpoints,
          ...(depth === undefined ? {} : { finalityConfirmations: depth }),
          owner: 'rfc64',
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!proven) return false;
      const after = await authority();
      const current = this.readAcceptedRfc64CatalogAccessSnapshotV1(contextGraphId);
      return after.outcome === 'allowed' && after.source === 'registered-chain'
        && after.onChainId === before.onChainId
        && current?.policy === accepted.policy && current.roster === accepted.roster
        && this.subscribedContextGraphs.get(contextGraphId)?.subscribed === true;
    } catch {
      return false;
    }
  }
}
