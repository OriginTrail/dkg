// SPDX-License-Identifier: Apache-2.0

/**
 * Chain event subscription (listenForEvents).
 *
 * Mixin holder extracted from evm-adapter.ts. `extends EVMChainAdapterBase`
 * for shared state (providers, signers, caches) reached via `this`. Mixed into
 * the concrete EVMChainAdapter via applyMixins(); see evm-adapter.ts for the
 * assembly. Which events exist, which Hub binding each reads and how its logs
 * are parsed live in one table in `evm-event-contracts.ts`; this class owns
 * the physical read boundary and the cancellation checkpoints.
 */

import { EVMChainAdapterBase } from './evm-adapter-base.js';
import type { ethers } from 'ethers';
import type { EventFilter, ChainEvent } from './chain-adapter.js';
import { selectEvmEventPlan, type EvmEventScan } from './evm-event-contracts.js';

export class EventsMethods extends EVMChainAdapterBase {
  // =====================================================================
  // Events
  // =====================================================================

  /**
   * Querying and cancellable iteration are one wide `eth_getLogs` operation.
   * `skipPreferred` keeps the scan's tip coverage aligned with the fresh head
   * that advances the event cursor.
   */
  private async *queryEventLogs(
    contract: ethers.Contract,
    label: string,
    eventFilter: ethers.ContractEventName,
    filter: EventFilter,
  ): AsyncIterable<ethers.Log | ethers.EventLog> {
    const { signal } = filter;
    signal?.throwIfAborted();
    const logs = await this.readContractWith(
      contract,
      label,
      (candidate) => candidate.queryFilter(eventFilter, filter.fromBlock ?? 0, filter.toBlock),
      { policy: 'wideLogScan', skipPreferred: true, signal },
    );
    signal?.throwIfAborted();
    for (const log of logs) {
      signal?.throwIfAborted();
      yield log;
    }
    signal?.throwIfAborted();
  }

  async *listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent> {
    const { signal } = filter;
    signal?.throwIfAborted();
    const plan = selectEvmEventPlan(filter.eventTypes);
    const contracts = await this.resolveHubContractBindings(plan.bindings, { signal });
    signal?.throwIfAborted();
    if (plan.bindings.length > 0) await this.ensureHubRotationListenerStarted();
    signal?.throwIfAborted();

    const scan: EvmEventScan = {
      signal,
      query: (contract, label, eventFilter) =>
        this.queryEventLogs(contract, label, eventFilter, filter),
    };
    for (const descriptor of plan.descriptors) {
      signal?.throwIfAborted();
      const contract = contracts[descriptor.binding];
      // Unsupported names and absent optional deployments yield nothing.
      if (!contract) continue;
      yield* descriptor.scan(contract, scan);
    }
  }
}
