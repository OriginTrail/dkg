// SPDX-License-Identifier: Apache-2.0

import {
  contextGraphAuthorityIndexStateRevision,
  type ContextGraphAuthorityIndexCheckpoint,
  type ContextGraphAuthorityIndexState,
} from './context-graph-authority-index-checkpoint.js';
import type { ContextGraphAuthorityIndexId } from
  './context-graph-authority-index-id.js';
import { normalizeContextGraphAuthorityHash as normalizeHash } from
  './context-graph-authority-generation.js';

const ZERO_HASH = `0x${'00'.repeat(32)}`;

/**
 * Read-only view of ONE complete contract-wide checkpoint.
 *
 * The checkpoint (durable prefix plus the in-memory tail reduced above the
 * reorg holdback) stays private, exactly as it does behind the index's own
 * purpose-specific reads: a caller can project states out of it but can never
 * hand it to `exportSnapshot`, which serves the durable cursor only.
 *
 * These are the SAME projections `ContextGraphAuthorityIndex` runs on a fresh
 * scan, so a state, revision or policy digest read through a cached view is
 * byte-identical to the one a fresh scan at that head produces.
 */
export class ContextGraphAuthorityIndexView {
  readonly #checkpoint: ContextGraphAuthorityIndexCheckpoint;

  constructor(checkpoint: ContextGraphAuthorityIndexCheckpoint) {
    this.#checkpoint = checkpoint;
    Object.freeze(this);
  }

  has(contextGraphId: ContextGraphAuthorityIndexId): boolean {
    return this.#checkpoint.states.some((state) => state.contextGraphId === contextGraphId);
  }

  /** ABSENT is explicit: it throws, and is never a public/inactive/zero default. */
  resolve(contextGraphId: ContextGraphAuthorityIndexId): ContextGraphAuthorityIndexState {
    const state = this.#checkpoint.states.find((candidate) => (
      candidate.contextGraphId === contextGraphId
    ));
    if (state === undefined) {
      throw new Error(`Context Graph ${contextGraphId} has no finalized creation event`);
    }
    return state;
  }

  revisions(
    contextGraphIds: readonly ContextGraphAuthorityIndexId[],
  ): ReadonlyMap<ContextGraphAuthorityIndexId, string> {
    const revisions = new Map<ContextGraphAuthorityIndexId, string>();
    for (const [contextGraphId, state] of this.states(contextGraphIds)) {
      revisions.set(contextGraphId, contextGraphAuthorityIndexStateRevision(state));
    }
    return revisions;
  }

  states(
    contextGraphIds: readonly ContextGraphAuthorityIndexId[],
  ): ReadonlyMap<ContextGraphAuthorityIndexId, ContextGraphAuthorityIndexState> {
    const targetIds = new Set<ContextGraphAuthorityIndexId>(contextGraphIds);
    const states = new Map<ContextGraphAuthorityIndexId, ContextGraphAuthorityIndexState>();
    for (const state of this.#checkpoint.states) {
      if (targetIds.has(state.contextGraphId)) states.set(state.contextGraphId, state);
    }
    return states;
  }

  /** Missing and zero-hash targets are omitted; duplicates fail closed. */
  statesByNameHashes(
    nameHashes: readonly string[],
  ): ReadonlyMap<string, ContextGraphAuthorityIndexState> {
    const targets = new Set<string>();
    for (const rawNameHash of nameHashes) {
      const nameHash = normalizeHash(rawNameHash);
      if (nameHash === undefined) {
        throw new Error('Context Graph authority index name hash is invalid');
      }
      if (nameHash !== ZERO_HASH) targets.add(nameHash);
    }
    if (targets.size === 0) return new Map();
    const states = new Map<string, ContextGraphAuthorityIndexState>();
    const counts = new Map<string, number>();
    for (const state of this.#checkpoint.states) {
      if (!targets.has(state.nameHash)) continue;
      counts.set(state.nameHash, (counts.get(state.nameHash) ?? 0) + 1);
      states.set(state.nameHash, state);
    }
    for (const [nameHash, count] of counts) {
      if (count <= 1) continue;
      throw new Error(
        `Context Graph name hash ${nameHash} is ambiguous across ` +
        `${count} finalized Context Graphs`,
      );
    }
    return states;
  }
}
