// SPDX-License-Identifier: Apache-2.0
import { isSafeIri } from '@origintrail-official/dkg-core';
import type { StoreRecoveryGenerationReader } from '@origintrail-official/dkg-storage';
import type { StoreMutation, StoreMutationOutcome, StoreMutationObserver } from './store-mutation.js';

export interface StoreContentScope {
  readonly assertionGraphs: readonly string[];
  readonly metadataGraph: string;
  readonly subjects: readonly string[];
}

/** Explicit content effects shared by active writes, watches and uncertain outcomes. */
type GraphEffect = { kind: 'graph' } | { kind: 'subjects'; subjects: Set<string> };
type ContentEffect = { kind: 'global' } | { kind: 'graphs'; graphs: Map<string, GraphEffect> };

function mutationEffect(mutation: StoreMutation): ContentEffect {
  if (mutation.everything) return { kind: 'global' };
  const graphs = new Map<string, GraphEffect>();
  for (const { graph, subject } of [...mutation.quads ?? [], ...mutation.removals ?? []]) {
    if (!graph || !isSafeIri(graph)) return { kind: 'global' };
    if (!subject || subject.startsWith('_:')) { graphs.set(graph, { kind: 'graph' }); continue; }
    const effect = graphs.get(graph);
    if (effect?.kind === 'graph') continue;
    const subjects = effect?.subjects ?? new Set<string>();
    subjects.add(subject); graphs.set(graph, { kind: 'subjects', subjects });
  }
  return { kind: 'graphs', graphs };
}

function scopeEffect(scope: StoreContentScope): ContentEffect {
  const graphs = new Map<string, GraphEffect>(scope.assertionGraphs.map(graph => [graph, { kind: 'graph' }]));
  if (!graphs.has(scope.metadataGraph)) graphs.set(scope.metadataGraph, { kind: 'subjects', subjects: new Set(scope.subjects) });
  return { kind: 'graphs', graphs };
}

function overlaps(left: ContentEffect, right: ContentEffect): boolean {
  if (left.kind === 'global' || right.kind === 'global') return true;
  for (const [graph, effect] of left.graphs) {
    const other = right.graphs.get(graph);
    if (!other) continue;
    if (effect.kind === 'graph' || other.kind === 'graph') return true;
    for (const subject of effect.subjects) if (other.subjects.has(subject)) return true;
  }
  return false;
}

function combine(left: ContentEffect, right: ContentEffect): ContentEffect {
  if (left.kind === 'global' || right.kind === 'global') return { kind: 'global' };
  for (const [graph, effect] of right.graphs) {
    const old = left.graphs.get(graph);
    if (!old || effect.kind === 'graph') left.graphs.set(graph, effect);
    else if (old.kind === 'subjects') for (const subject of effect.subjects) old.subjects.add(subject);
  }
  return left;
}

/** Invalidates before dispatch and retains uncertain outcomes until a supervised
 * backend replacement confirms termination. Reading or rewriting is not proof.
 */
export class StoreContentFence implements StoreMutationObserver {
  private readonly pending = new Set<ContentEffect>();
  private readonly watches = new Set<{ effect: ContentEffect; valid: boolean }>();
  private readonly uncertain = new Map<number | undefined, ContentEffect>();

  constructor(private readonly recoveryGeneration?: StoreRecoveryGenerationReader) {}

  begin(mutation: StoreMutation): (outcome: StoreMutationOutcome) => void {
    const pending = mutationEffect(mutation);
    this.pending.add(pending);
    for (const watch of this.watches) if (overlaps(watch.effect, pending)) watch.valid = false;
    return outcome => {
      this.pending.delete(pending);
      if (outcome === 'indeterminate') {
        // Queue admission precedes backend dispatch. A queued write may execute
        // on a replacement, so only a replacement AFTER its settled outcome can
        // retire uncertainty. A supervised epoch remains available while recovery is in progress.
        const generation = this.recoveryGeneration?.()?.generation;
        this.uncertain.set(generation,
          combine(this.uncertain.get(generation) ?? { kind: 'graphs', graphs: new Map() }, pending));
      }
    };
  }

  openScope(scope: StoreContentScope): { assertCurrent(): void; close(): void } | undefined {
    const state = this.recoveryGeneration?.();
    if (this.recoveryGeneration && !state?.ready) return undefined;
    const generation = state?.generation;
    const effect = scopeEffect(scope);
    for (const [epoch, uncertain] of this.uncertain) {
      // Unbound epochs stay fail-closed. Active client operations can span a
      // restart, so only settled indeterminate outcomes may be retired.
      if (epoch !== undefined && generation !== undefined && epoch < generation) this.uncertain.delete(epoch);
      else if (overlaps(effect, uncertain)) return undefined;
    }
    for (const pending of this.pending) if (overlaps(effect, pending)) return undefined;
    const watch = { effect, valid: true };
    this.watches.add(watch);
    return {
      assertCurrent: () => {
        const current = this.recoveryGeneration?.();
        if (!watch.valid || (this.recoveryGeneration && (!current?.ready || current.generation !== generation))) throw Object.assign(
          new Error('Held assertion content changed during recovery'), { name: 'AbortError' });
      },
      close: () => { this.watches.delete(watch); },
    };
  }

  async withScope<T>(scope: StoreContentScope, operation: (assertCurrent: () => void) => Promise<T>): Promise<T | undefined> {
    const proof = this.openScope(scope);
    if (!proof) return undefined;
    try { return await operation(proof.assertCurrent); } finally { proof.close(); }
  }
}
