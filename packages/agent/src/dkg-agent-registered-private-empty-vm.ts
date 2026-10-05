// SPDX-License-Identifier: Apache-2.0

import { ethers } from 'ethers';
import { createStrictCurrentFinalizedEvmSnapshotScopeV1, resolveRpcUrls } from '@origintrail-official/dkg-chain';
import type { ChainIdV1, ContextGraphIdV1, DecimalU256V1, EvmAddressV1 } from '@origintrail-official/dkg-core';
import type { DKGAgent } from './dkg-agent.js';
import { proveRegisteredPrivateEmptyVmV1 } from './rfc64/registered-private-empty-vm-proof-v1.js';

export class RegisteredPrivateEmptyVmMethods {
  /** A zero-VM proof grants durable readiness only; SWM still needs its own proof. */
  async proveRegisteredPrivateEmptyVmV1(
    this: DKGAgent,
    contextGraphId: string,
    callerAgentAddress: string,
  ): Promise<boolean> {
    const trace = (stage: string) => {
      if (process.env.DKG_DEBUG_PRIVATE_EMPTY_VM === '1') {
        console.info(`[private-empty-vm] ${stage}`);
      }
    };
    try {
      const caller = callerAgentAddress.toLowerCase();
      if (!ethers.isAddress(caller) ||
        this.subscribedContextGraphs.get(contextGraphId)?.subscribed !== true) {
        trace('not-subscribed'); return false;
      }
      const authority = () => this.resolveContextGraphSubscriptionBootstrapAuthority(
        contextGraphId,
        { callerAgentAddress: caller, allowSubscriptionFallback: false },
      );
      const before = await authority();
      if (before.outcome !== 'allowed' || before.source !== 'registered-chain'
        || before.onChainId === undefined || before.registration === 'unregistered') {
        trace('authority-not-registered-allowed'); return false;
      }
      const chainConfig = this.config.chainConfig;
      if (chainConfig === undefined || this.chain.getContextGraphAuthoritySnapshot === undefined) {
        trace('chain-capability-absent'); return false;
      }
      const endpoints = resolveRpcUrls(chainConfig.rpcUrl, chainConfig.rpcUrls);
      if (endpoints.length === 0) { trace('rpc-endpoints-absent'); return false; }
      const chainId = chainConfig.chainId?.match(/^evm:(0|[1-9][0-9]*)$/u)?.[1];
      if (chainId === undefined || !ethers.isAddress(chainConfig.hubAddress)) {
        trace('chain-binding-absent'); return false;
      }
      const indexed = await this.chain.getContextGraphAuthoritySnapshot(before.onChainId, {
        signal: AbortSignal.timeout(20_000),
      });
      if (indexed.chainId !== chainConfig.chainId
        || indexed.contextGraphId !== before.onChainId.toString(10)
        || indexed.active !== true || indexed.accessPolicy !== 1
        || !ethers.isAddress(indexed.governanceContract)) {
        trace('indexed-private-authority-absent'); return false;
      }
      const depth = this.chain.getFinalityConfirmations?.()
        ?? chainConfig.finalityConfirmations;
      const proven = await proveRegisteredPrivateEmptyVmV1({
        contextGraphId: contextGraphId as ContextGraphIdV1,
        onChainContextGraphId: before.onChainId.toString(10) as DecimalU256V1,
        callerAgentAddress: caller as EvmAddressV1,
        chainId: chainId as ChainIdV1,
        hubAddress: chainConfig.hubAddress.toLowerCase() as EvmAddressV1,
        governanceContractAddress: indexed.governanceContract.toLowerCase() as EvmAddressV1,
        snapshot: createStrictCurrentFinalizedEvmSnapshotScopeV1({
          chainId: chainId as ChainIdV1, endpoints,
          ...(depth === undefined ? {} : { finalityConfirmations: depth }),
          owner: 'rfc64',
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!proven) { trace('finalized-zero-proof-false'); return false; }
      const after = await authority();
      const stillCurrent = after.outcome === 'allowed' && after.source === 'registered-chain'
        && after.onChainId === before.onChainId
        && this.subscribedContextGraphs.get(contextGraphId)?.subscribed === true;
      trace(stillCurrent ? 'proven' : 'post-proof-authority-changed');
      return stillCurrent;
    } catch (error) {
      trace(`proof-error:${error instanceof Error ? error.name : 'unknown'}`);
      return false;
    }
  }
}
