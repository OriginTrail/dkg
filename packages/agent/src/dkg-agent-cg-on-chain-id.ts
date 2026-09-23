// SPDX-License-Identifier: Apache-2.0

/**
 * Resolution of a Context Graph's on-chain numeric id (`32`, `#32`) to the row
 * this node keeps for that graph. See context-graph-on-chain-reference.ts for
 * why the number itself must never become a subscription key.
 *
 * The facts come from ContextGraphStorage: historical discovery's staged rows
 * (and its checkpoint), or, for a graph discovery has not reached yet, one
 * bounded on-demand read applied through the same observation path. The
 * result is the adopted cleartext row or the hash-keyed row, which the
 * name-hash subscription path then resolves and verifies.
 */

import type { ContextGraphStorageRange } from '@origintrail-official/dkg-chain';
import { createOperationContext } from '@origintrail-official/dkg-core';

import { runBoundedOperation } from './bounded-operation.js';
import { chainAuthorityReadBudgetsOf } from './chain-authority-read-budgets.js';
import {
  contextGraphNameCommitmentOf,
  normalizeContextGraphNameHash,
  verifyContextGraphNameCandidate,
} from './context-graph-name-candidate.js';
import {
  parseContextGraphOnChainIdReference,
  type ContextGraphOnChainIdResolution,
  type RetiredNumericContextGraphSubscription,
} from './context-graph-on-chain-reference.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { ContextGraphSub } from './dkg-agent-types.js';

type OnDemandStorageRead =
  | { readonly kind: 'entry' }
  | { readonly kind: 'absent'; readonly latestId: string }
  | { readonly kind: 'unavailable'; readonly detail: string }
  | { readonly kind: 'unsupported' };

/**
 * The chain proves the graph at on-chain id N is not named "N": slot N
 * commits a name hash, and it is not keccak256 of the digits.
 */
function slotCommitsAnotherName(onChainId: string, nameHash: string | null): nameHash is string {
  return nameHash !== null && contextGraphNameCommitmentOf(onChainId) !== nameHash;
}

export class ContextGraphOnChainIdMethods extends DKGAgentBase {
  /**
   * The row this node keeps for on-chain Context Graph `onChainId`, from local
   * state only: the row the reverse name-hash index holds for the id's
   * committed name hash, when that row is bound to the id and is either the
   * hash-keyed row or its verified cleartext. Null when there is none.
   */
  localContextGraphIdForOnChainId(
    this: DKGAgent,
    onChainId: string,
  ): { contextGraphId: string; nameHash: string } | null {
    const nameHash = normalizeContextGraphNameHash(this.onChainContextGraphFacts.get(onChainId)?.nameHash);
    if (nameHash === null) return null;
    const contextGraphId = this.wireIdToLocalCgId.get(nameHash);
    if (contextGraphId === undefined) return null;
    if (this.subscribedContextGraphs.get(contextGraphId)?.onChainId !== onChainId) return null;
    const verified = contextGraphId === nameHash
      || verifyContextGraphNameCandidate(contextGraphId, nameHash) === contextGraphId;
    return verified ? { contextGraphId, nameHash } : null;
  }

  /**
   * Resolve operator input that names an on-chain Context Graph (`32`, `#32`)
   * to the row this node keeps for it. Returns null for input that is not an
   * on-chain id; callers then use the input as given.
   *
   * A bare number that keys an existing subscription is used as given
   * (direct keys win), unless the chain proves that subscription is a numeric
   * alias: bound to slot N while slot N commits a name hash other than
   * keccak256("N"). Such a row, left by the subscribe path before this fix,
   * can only ever sync nothing; it is retired here and reported, so callers
   * can carry its member intent over to the resolved row.
   *
   * Beyond staging the graph's row the way discovery does and retiring a
   * proven numeric alias, this creates no subscription.
   */
  async resolveContextGraphOnChainIdReference(
    this: DKGAgent,
    reference: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<ContextGraphOnChainIdResolution | null> {
    const parsed = parseContextGraphOnChainIdReference(reference);
    if (parsed === null) return null;
    const { onChainId } = parsed;
    // Without a chain there are no on-chain ids: a bare number is just a name.
    if (this.chain.chainId === 'none') return parsed.explicit ? { kind: 'unsupported', onChainId } : null;
    // `#` is not a Context Graph id character: only a bare number can key a row.
    const literalRow = () => (parsed.explicit ? undefined : this.subscribedContextGraphs.get(onChainId));

    // Discovery's facts answer offline. The live `ContextGraphCreated` event
    // alone does not say whether the graph is still active, so read then too.
    const known = this.onChainContextGraphFacts.get(onChainId);
    if (known === undefined || known.active === null) {
      const read = await this.readContextGraphStorageIdOnDemand(onChainId, options.signal);
      if (read.kind !== 'entry' && known === undefined) {
        // What the chain could not say, it cannot overrule.
        if (literalRow() !== undefined) return { kind: 'direct', onChainId };
        if (read.kind === 'absent') return { kind: 'not-found', onChainId, latestId: read.latestId };
        if (read.kind === 'unsupported') return { kind: 'unsupported', onChainId };
        return { kind: 'unavailable', onChainId, detail: read.detail };
      }
    }
    const facts = this.onChainContextGraphFacts.get(onChainId);
    const nameHash = normalizeContextGraphNameHash(facts?.nameHash);
    const literal = literalRow();
    if (literal !== undefined && !this.isNumericContextGraphAlias(onChainId, literal, nameHash)) {
      return { kind: 'direct', onChainId };
    }
    const retired = this.retireNumericContextGraphAlias(onChainId, nameHash);

    if (nameHash === null) return { kind: 'no-name-hash', onChainId };
    if (facts?.active === false) return { kind: 'inactive', onChainId };
    let local = this.localContextGraphIdForOnChainId(onChainId);
    if (local === null && !this.wireIdToLocalCgId.has(nameHash)) {
      // The staged row is gone (retired or pruned since): stage it again, the
      // same way discovery does.
      this.stageOnChainContextGraphBindingFromNameHash(nameHash, onChainId);
      local = this.localContextGraphIdForOnChainId(onChainId);
    }
    if (local === null) {
      // Another on-chain id commits the same name hash and holds the row.
      return {
        kind: 'unavailable',
        onChainId,
        detail: `its name hash ${nameHash.slice(0, 18)}… is bound to another on-chain id on this node`,
      };
    }
    // Peers never reveal a private graph's id, so without the cleartext a
    // non-member has nothing to subscribe. A member (or the creator) already
    // holds the cleartext row; the caller's read-authority check decides then.
    if (facts?.accessPolicy === 1 && local.contextGraphId === nameHash) return { kind: 'private', onChainId };
    return {
      kind: 'resolved',
      onChainId,
      nameHash,
      contextGraphId: local.contextGraphId,
      private: facts?.accessPolicy === 1,
      ...(retired === null ? {} : { retiredNumericSubscription: retired }),
    };
  }

  /**
   * A subscription keyed by the bare number `onChainId` and bound to that
   * same on-chain id, whose slot commits a name hash that is not keccak256 of
   * the number. The chain proves the graph it is bound to is not called "N",
   * so every read under "N" misses. A Core-hosted row is left alone.
   */
  isNumericContextGraphAlias(
    this: DKGAgent,
    onChainId: string,
    subscription: ContextGraphSub,
    nameHash: string | null,
  ): boolean {
    return slotCommitsAnotherName(onChainId, nameHash)
      && subscription.onChainId === onChainId
      && subscription.coreHosted !== true
      && normalizeContextGraphNameHash(subscription.onChainHash) !== nameHash;
  }

  /**
   * Drop a proven numeric alias: its gossip topics, sync scope, durable row
   * and reverse-index entry. Also drops the bare number from the sync scope,
   * where `--save` (config.contextGraphs) may have put it without a row.
   * Returns the member intent the alias carried, or null when no row was
   * retired.
   */
  retireNumericContextGraphAlias(
    this: DKGAgent,
    onChainId: string,
    nameHash: string | null,
  ): RetiredNumericContextGraphSubscription | null {
    if (!slotCommitsAnotherName(onChainId, nameHash)) return null;
    const subscription = this.subscribedContextGraphs.get(onChainId);
    if (subscription !== undefined && !this.isNumericContextGraphAlias(onChainId, subscription, nameHash)) {
      return null;
    }
    const scope = this.config.syncContextGraphs ?? [];
    if (scope.includes(onChainId)) {
      this.config.syncContextGraphs = scope.filter((contextGraphId) => contextGraphId !== onChainId);
    }
    if (subscription === undefined) return null;
    this.unsubscribeFromContextGraph(onChainId, { persist: true });
    this.deleteContextGraphSubscription(onChainId);
    const wireId = this.contextGraphNameCommitment(onChainId);
    if (this.wireIdToLocalCgId.get(wireId) === onChainId) this.wireIdToLocalCgId.delete(wireId);
    this.log.info(
      createOperationContext('system'),
      `Retired subscription "${onChainId}": on-chain Context Graph #${onChainId} commits name hash `
      + `${nameHash.slice(0, 18)}…, not the name "${onChainId}", so that subscription could never sync`,
    );
    return {
      contextGraphId: onChainId,
      subscribed: subscription.subscribed === true,
      syncMode: subscription.syncMode ?? 'always-on',
    };
  }

  /**
   * Read one ContextGraphStorage id with historical discovery's primitive and
   * apply it through the same observation path, so the graph gets exactly the
   * row and facts a discovery pass would give it.
   */
  async readContextGraphStorageIdOnDemand(
    this: DKGAgent,
    onChainId: string,
    signal?: AbortSignal,
  ): Promise<OnDemandStorageRead> {
    const read = this.chain.readContextGraphStorageRange;
    if (typeof read !== 'function') return { kind: 'unsupported' };
    let range: ContextGraphStorageRange;
    try {
      range = await runBoundedOperation(
        (readSignal) => read.call(this.chain, { fromId: BigInt(onChainId), maxIds: 1, signal: readSignal }),
        {
          label: `readContextGraphStorageRange(#${onChainId})`,
          timeoutMs: chainAuthorityReadBudgetsOf(this).coldResolutionTimeoutMs,
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      return { kind: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
    }
    const entry = range.entries.find((candidate) => candidate.contextGraphId === onChainId);
    if (entry === undefined) {
      // Ids are sequential and never burned: above the latest id the graph
      // does not exist; at or below it the serving backend is behind.
      return range.latestId < BigInt(onChainId)
        ? { kind: 'absent', latestId: range.latestId.toString(10) }
        : { kind: 'unavailable', detail: `id ${onChainId} is not readable yet at block ${range.anchorBlockNumber}` };
    }
    this.applyOnChainContextGraphObservation({
      contextGraphId: entry.contextGraphId,
      owner: entry.owner,
      accessPolicy: entry.accessPolicy,
      publishPolicy: entry.publishPolicy,
      publishAuthority: entry.publishAuthority,
      nameHash: entry.nameHash,
      blockNumber: range.anchorBlockNumber,
      createdAt: entry.createdAt,
      active: entry.active,
    }, { source: 'storage' });
    return { kind: 'entry' };
  }
}
