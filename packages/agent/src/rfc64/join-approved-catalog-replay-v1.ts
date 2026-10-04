// SPDX-License-Identifier: Apache-2.0

import type { Rfc64BackgroundWorkDispatcherV1 } from './background-work-dispatcher-v1.js';

interface JoinApprovedCatalogReplayPortsV1 {
  readonly dispatcher: Rfc64BackgroundWorkDispatcherV1;
  readonly contextGraphId: string;
  readonly approvedAgentAddress: string;
  readonly peerId: string;
  readonly wait: (signal: AbortSignal, delayMs: number) => Promise<void>;
  readonly refresh: (signal: AbortSignal) => Promise<unknown>;
  readonly replay: (signal: AbortSignal) => Promise<boolean>;
  readonly warn: () => void;
}

const FOREGROUND_DELAYS_MS = Object.freeze([0, 250, 1_000]);
const BACKGROUND_DELAYS_MS = Object.freeze([5_000, 15_000, 30_000, 60_000]);

/** Every phase rechecks current authority and exact approved peer membership. */
async function attempt(ports: JoinApprovedCatalogReplayPortsV1, signal: AbortSignal, delayMs: number): Promise<boolean> {
  signal.throwIfAborted();
  await ports.wait(signal, delayMs);
  try {
    await ports.refresh(signal);
    signal.throwIfAborted();
    const delivered = await ports.replay(signal);
    signal.throwIfAborted();
    return delivered;
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return false;
  }
}

/** Awaited work keeps its caller's context and completion, independently of retries. */
export async function runJoinApprovedCatalogReplayV1(ports: JoinApprovedCatalogReplayPortsV1): Promise<void> {
  const delivered = await ports.dispatcher.runAwaited(async (signal) => {
    for (const delayMs of FOREGROUND_DELAYS_MS) {
      if (await attempt(ports, signal, delayMs)) return true;
    }
    return false;
  });
  if (!delivered) scheduleJoinApprovedCatalogReplayRetryV1(ports);
}

/** Notification coalescing owns only the detached bounded continuation. */
export function scheduleJoinApprovedCatalogReplayRetryV1(ports: JoinApprovedCatalogReplayPortsV1): boolean {
  const key = `join-approved-catalog-replay\0${ports.contextGraphId}\0${ports.approvedAgentAddress.toLowerCase()}\0${ports.peerId}`;
  return ports.dispatcher.scheduleKeyed(key, async (signal) => {
    for (const delayMs of BACKGROUND_DELAYS_MS) {
      if (await attempt(ports, signal, delayMs)) return;
    }
    ports.warn();
  });
}
