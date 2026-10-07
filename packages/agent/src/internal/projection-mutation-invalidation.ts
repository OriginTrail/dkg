// SPDX-License-Identifier: Apache-2.0

import { isSafeIri } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { RecipientKeyRouteFence } from './recipient-key-route-fence.js';
import type { StoreMutation } from './store-mutation.js';

interface ProjectionInvalidationEffects {
  readonly fence: () => RecipientKeyRouteFence;
  readonly everything: () => void;
  readonly graph: (graph: string, subject?: string, predicate?: string) => void;
  readonly quads: (quads: readonly Quad[]) => string[];
}

/** Projection-only observer entry point, with the historical callbacks as fence-aware adapters. */
export class ProjectionMutationInvalidation {
  constructor(private readonly effects: ProjectionInvalidationEffects) {}

  readonly markDirtyForGraph = (graph: string, subject?: string, predicate?: string): void => {
    try { this.effects.graph(graph, subject, predicate); }
    finally { this.effects.fence().noteRemoval({ graph, subject, predicate }); }
  };
  readonly markAllDirty = (): void => {
    try { this.effects.everything(); }
    finally { this.effects.fence().noteUnscopedWrite(); }
  };
  readonly markDirtyFromQuads = (quads: readonly Quad[]): string[] => {
    try { return this.effects.quads(quads); }
    finally { this.effects.fence().noteQuads(quads); }
  };

  readonly invalidateStoreMutation = (mutation: StoreMutation): void => {
    // Unsafe predicates and unscoped destructive writes cannot be classified narrowly.
    if (mutation.everything || mutation.quads?.some((quad) => !isSafeIri(quad.predicate))) {
      this.effects.everything();
      return;
    }
    for (const { graph, subject, predicate } of mutation.removals ?? []) {
      if (graph === undefined || !isSafeIri(graph)) this.effects.everything();
      else this.effects.graph(graph, subject, predicate);
    }
    if (mutation.quads) this.effects.quads(mutation.quads);
  };
}
