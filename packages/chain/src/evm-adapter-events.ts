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
import { eventContractKeysFor, evmEventDescriptorFor, type EvmEventScan } from './evm-event-contracts.js';

export class EventsMethods extends EVMChainAdapterBase {
  // =====================================================================
  // Events
  // =====================================================================

  /**
   * A WIDE `eth_getLogs` scan with read-failover, baking in the `wideLogScan`
   * policy so the wide-log multi-RPC timeout (`RPC_LOG_SCAN_TIMEOUT_MS`, vs the 4s
   * point-read cap; single-RPC stays uncapped, #894) is owned HERE once, not by
   * per-call-site discipline. Used by every event scan in the descriptor table.
   *
   * TIP-SENSITIVE → `skipPreferred: true` (endpoint stickiness carve-out). The
   * event-lane cursor is advanced against a head read canonical-fresh via
   * `getBlockNumber()` (also `skipPreferred`); if this `[fromBlock, head]` scan
   * were pinned to a lagging sticky backup whose tip is BELOW `head`, a provider
   * that silently clamps `toBlock` to its own tip would return fewer logs, the
   * runner would still persist `lastBlock = head`, and the events in
   * `(backendTip, head]` would be skipped forever. Scanning canonical-order keeps
   * the scan's tip coverage aligned with the head that advances the cursor
   * (mirrors the hub-rotation poller's `skipPreferred` wide-log carve-out).
   */
  private async queryFilterWithFailover(
    contract: ethers.Contract,
    label: string,
    eventFilter: ethers.ContractEventName,
    fromBlock: ethers.BlockTag,
    toBlock?: ethers.BlockTag,
    signal?: AbortSignal,
  ): Promise<(ethers.Log | ethers.EventLog)[]> {
    signal?.throwIfAborted();
    const logs = await this.readContractWith(
      contract,
      label,
      (c) => c.queryFilter(eventFilter, fromBlock, toBlock),
      { policy: 'wideLogScan', skipPreferred: true, signal },
    );
    signal?.throwIfAborted();
    return logs;
  }

  /** Every parsed log crosses this boundary, including supplemental mint logs. */
  private *cancellableLogs<T>(logs: Iterable<T>, signal?: AbortSignal): Iterable<T> {
    for (const log of logs) {
      signal?.throwIfAborted();
      yield log;
    }
    signal?.throwIfAborted();
  }

  async *listenForEvents(filter: EventFilter): AsyncIterable<ChainEvent> {
    const { signal } = filter;
    signal?.throwIfAborted();
    const keys = eventContractKeysFor(filter.eventTypes);
    const contracts = await this.resolveHubContractBindings(keys, { signal });
    signal?.throwIfAborted();
    if (keys.length > 0 && !this.initialized) void this.startHubRotationListener();

    const scan: EvmEventScan = {
      signal,
      query: (contract, label, eventFilter) =>
        this.queryFilterWithFailover(contract, label, eventFilter, filter.fromBlock ?? 0, filter.toBlock, signal),
      logs: (logs) => this.cancellableLogs(logs, signal),
    };
    for (const eventType of filter.eventTypes) {
      signal?.throwIfAborted();
      const descriptor = evmEventDescriptorFor(eventType);
      const contract = descriptor && contracts[descriptor.binding];
      // Unsupported names and absent optional deployments yield nothing.
      if (!descriptor || !contract) continue;
      yield* descriptor.scan(contract, scan);
    }
  }
}
