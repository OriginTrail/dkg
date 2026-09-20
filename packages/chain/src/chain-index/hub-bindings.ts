// SPDX-License-Identifier: Apache-2.0

import type { HubRotationEvent } from './chain-event-decoders.js';

/**
 * Which address a Hub-registered contract name pointed at, over time.
 *
 * The Hub is the root of the scope: every other indexed address is only valid
 * for the block range the Hub says it was bound for. Keeping that as a range
 * rather than "the current address" is what makes a rotation replayable at all
 * — today the only thing that catches a rotation the node slept through is a
 * 30s address memo TTL, which is not a record of anything.
 *
 * NOT DURABLE YET. `ChainEventLogStore` has no binding method, so bindings live
 * only in the tick's process memory: after a restart the tick resumes above its
 * settled cursor and never re-sees the `NewContract` that established one. What
 * a fresh process DOES start from is {@link ChainIndexTickOptions.initialBindings} —
 * the (name → address) pairs the adapter resolved out of the Hub — so the
 * CURRENT binding of every indexed name is always known and a rotation of one
 * is always a move rather than a first sighting. It degrades
 * fail-closed — coverage is recorded only for addresses the registry knows, so
 * an un-queried historical address simply has none and nothing may be reported
 * absent for it — but "replayable after a restart" is not true until the store
 * persists these. Do not read the table as a working record before then.
 */
export interface HubBinding {
  readonly name: string;
  readonly kind: 'contract' | 'assetStorage';
  /** Lowercased. */
  readonly address: string;
  readonly fromBlock: number;
  /** `undefined` while this binding is the current one. */
  readonly toBlock?: number;
}

export interface HubBindingReduction {
  readonly bindings: readonly HubBinding[];
  /**
   * Addresses that became current at or above `fromBlock` during this page.
   *
   * The tick re-queries these in the SAME tick: a contract bound at block R has
   * been emitting since R, and the page that discovered the rotation was
   * fetched with the OLD address array, so those blocks were never looked at
   * for the new address. Without the re-query the log would hold a silent gap
   * and coverage would claim it did not.
   */
  readonly rebound: readonly Readonly<{ address: string; fromBlock: number }>[];
}

/** Unambiguous for any contract name, and greppable, unlike a raw separator. */
function bindingKeyOf(kind: HubBinding['kind'], name: string): string {
  return JSON.stringify([kind, name]);
}

function bindingKey(event: HubRotationEvent): string {
  return bindingKeyOf(event.assetStorage ? 'assetStorage' : 'contract', event.contractName);
}

/**
 * Fold one page of Hub events over the known bindings.
 *
 * Events MUST arrive in log order and MUST be the Hub rows of the same page the
 * caller is about to process, because the caller splits that page at the
 * rotation blocks this returns.
 */
export function reduceHubBindings(
  previous: readonly HubBinding[],
  events: readonly HubRotationEvent[],
): HubBindingReduction {
  const open = new Map<string, HubBinding>();
  const closed: HubBinding[] = [];
  for (const binding of previous) {
    if (binding.toBlock === undefined) open.set(bindingKeyOf(binding.kind, binding.name), binding);
    else closed.push(binding);
  }
  const rebound: { address: string; fromBlock: number }[] = [];

  for (const event of events) {
    const key = bindingKey(event);
    const kind = event.assetStorage ? 'assetStorage' as const : 'contract' as const;
    const current = open.get(key);
    const removal = event.name === 'ContractRemoved' || event.name === 'AssetStorageRemoved';

    if (removal) {
      // A removal only closes the binding it names. A Hub that emits
      // `ContractRemoved` for an address that is no longer the current one is
      // reporting history, not changing the present.
      if (current !== undefined && current.address === event.contractAddress) {
        open.delete(key);
        closed.push(Object.freeze({ ...current, toBlock: event.blockNumber }));
      }
      continue;
    }

    // IDEMPOTENT. `Hub.setContractAddress` emits `NewContract` and then
    // `ContractChanged` for the same address in the same transaction, so the
    // second event must be a no-op rather than a zero-length binding that
    // closes the one just opened.
    if (current !== undefined && current.address === event.contractAddress) continue;

    if (current !== undefined) {
      open.delete(key);
      closed.push(Object.freeze({ ...current, toBlock: event.blockNumber }));
    }
    const next: HubBinding = Object.freeze({
      name: event.contractName,
      kind,
      address: event.contractAddress,
      fromBlock: event.blockNumber,
    });
    open.set(key, next);
    rebound.push(Object.freeze({ address: next.address, fromBlock: next.fromBlock }));
  }

  return Object.freeze({
    bindings: Object.freeze([...closed, ...open.values()]
      .sort((left, right) => left.fromBlock - right.fromBlock
        || left.name.localeCompare(right.name))),
    rebound: Object.freeze(rebound),
  });
}

/** One name's move off an address the tick indexes, and onto another. */
export interface HubBindingSuccession {
  /** The address the name points at NOW. Lowercased. */
  readonly address: string;
  /** An address the same name used to point at, and no longer does. */
  readonly retiredAddress: string;
  /** The block the Hub rebound the name. The whole point of this record. */
  readonly fromBlock: number;
}

/**
 * Every address a still-bound name has MOVED OFF, and the block it moved.
 *
 * This is what stops the one log answering out of a retired proxy. A rebind
 * does not stop the old contract from existing or from emitting: it stops it
 * being the contract the node means. So from the rebind block on, the old
 * address's coverage must not grow — otherwise the log goes on reporting
 * "covered, and nothing happened" for blocks whose events were emitted
 * somewhere else entirely, and a lane that trusts coverage advances straight
 * past them, permanently and silently.
 *
 * Keyed by (kind, name) like {@link reduceHubBindings}, because the Hub keeps
 * contracts and asset storages in two registries that emit two event sets
 * (`Hub.sol:189-222`) and a name may exist in both.
 *
 * An address that some name still points at is NOT retired, however many other
 * names moved off it: one proxy bound under two names is still live. Where a
 * name moved more than once, the EARLIEST move wins, because under-claiming
 * coverage costs a live scan and over-claiming costs a skipped event.
 */
export function hubBindingSuccessions(
  bindings: readonly HubBinding[],
): readonly HubBindingSuccession[] {
  const current = new Map<string, HubBinding>();
  const currentAddresses = new Set<string>();
  for (const binding of bindings) {
    if (binding.toBlock !== undefined) continue;
    currentAddresses.add(binding.address);
    const held = current.get(bindingKeyOf(binding.kind, binding.name));
    if (held === undefined || binding.fromBlock > held.fromBlock) {
      current.set(bindingKeyOf(binding.kind, binding.name), binding);
    }
  }
  const successions = new Map<string, HubBindingSuccession>();
  for (const binding of bindings) {
    if (currentAddresses.has(binding.address)) continue;
    const open = current.get(bindingKeyOf(binding.kind, binding.name));
    if (open === undefined || open.address === binding.address) continue;
    const held = successions.get(binding.address);
    if (held !== undefined && held.fromBlock <= open.fromBlock) continue;
    successions.set(binding.address, Object.freeze({
      address: open.address,
      retiredAddress: binding.address,
      fromBlock: open.fromBlock,
    }));
  }
  return Object.freeze([...successions.values()]);
}

/**
 * Split `[fromBlock, throughBlock]` at every rotation boundary in `bindings`.
 *
 * A catch-up page that spans a rotation covers two different address sets, and
 * a single `eth_getLogs` cannot express "this address only above block R". The
 * tick therefore fetches the sub-ranges separately. Returned ranges are
 * contiguous, ascending, and together cover exactly the input.
 */
export function splitRangeAtHubRotations(
  bindings: readonly HubBinding[],
  fromBlock: number,
  throughBlock: number,
): readonly Readonly<{ fromBlock: number; throughBlock: number }>[] {
  if (throughBlock < fromBlock) return Object.freeze([]);
  const boundaries = new Set<number>();
  for (const binding of bindings) {
    for (const boundary of [binding.fromBlock, binding.toBlock]) {
      if (boundary === undefined) continue;
      if (boundary > fromBlock && boundary <= throughBlock) boundaries.add(boundary);
    }
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const ranges: { fromBlock: number; throughBlock: number }[] = [];
  let start = fromBlock;
  for (const boundary of ordered) {
    ranges.push(Object.freeze({ fromBlock: start, throughBlock: boundary - 1 }));
    start = boundary;
  }
  ranges.push(Object.freeze({ fromBlock: start, throughBlock }));
  return Object.freeze(ranges);
}

/**
 * Addresses to send with one `eth_getLogs` for `[fromBlock, throughBlock]`.
 *
 * Only bindings whose validity range INTERSECTS the request are included, so a
 * range below a rotation never pulls the new address's logs into blocks it was
 * not yet bound for, and a range above it never pulls the old one's.
 */
export function hubBoundAddressesForRange(
  bindings: readonly HubBinding[],
  fromBlock: number,
  throughBlock: number,
): readonly string[] {
  const addresses = new Set<string>();
  for (const binding of bindings) {
    if (binding.fromBlock > throughBlock) continue;
    if (binding.toBlock !== undefined && binding.toBlock <= fromBlock) continue;
    addresses.add(binding.address);
  }
  return Object.freeze([...addresses].sort());
}
