// SPDX-License-Identifier: Apache-2.0

import type { Quad } from '@origintrail-official/dkg-storage';

/** What a removal names. An absent field means "any". */
export interface StoreRemoval {
  readonly graph?: string;
  readonly subject?: string;
  readonly predicate?: string;
}

/** What a store write does, described once and reused before it is dispatched and after it settles. */
export interface StoreMutation {
  /** Quads it inserts, or removes by value. */
  readonly quads?: readonly Quad[];
  /** What it removes by scope. */
  readonly removals?: readonly StoreRemoval[];
  /** It also inserts quads the decorator cannot see (an RFC-64 commit). */
  readonly unseenPayload?: boolean;
  /** It may change anything (an UPDATE, a prefix delete). */
  readonly everything?: boolean;
}

export interface StoreMutationObserver {
  /**
   * Called before a write is dispatched. The returned function is called exactly
   * once, when the write settles: `changed` is false only when it provably
   * changed nothing (it succeeded without effect, or was refused before dispatch).
   */
  begin(mutation: StoreMutation): (changed: boolean) => void;
}
