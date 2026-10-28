// SPDX-License-Identifier: Apache-2.0
import { isSafeIri } from '@origintrail-official/dkg-core';
import type { StoreRecoveryGenerationReader } from '@origintrail-official/dkg-storage';
import type { StoreMutation, StoreMutationExecution, StoreMutationOutcome, StoreMutationObserver } from './store-mutation.js';

export interface StoreContentScope {
  readonly graphs: readonly string[];
  readonly metadataGraph: string;
  readonly subjects: readonly string[];
}

/** Explicit content effects shared by active writes, watches and uncertain outcomes. */
type GraphEffect = { kind: 'graph' } | { kind: 'subjects'; subjects: Set<string> };
type ContentEffect = { kind: 'global' } | { kind: 'graphs'; graphs: Map<string, GraphEffect> };

// As with RecipientKeyRouteFence, overflowing retained detail disables the shortcut.
export const STORE_CONTENT_EFFECT_MAX_GRAPHS = 256;
export const STORE_CONTENT_EFFECT_MAX_SUBJECTS_PER_GRAPH = 256;

/** False means even graph-level detail overflowed: the caller must use a global effect. */
function addEffect(graphs: Map<string, GraphEffect>, graph: string, subject?: string): boolean {
  if (!graphs.has(graph) && graphs.size >= STORE_CONTENT_EFFECT_MAX_GRAPHS) return false;
  const old = graphs.get(graph);
  if (old?.kind === 'graph') return true;
  if (!subject || subject.startsWith('_:')) { graphs.set(graph, { kind: 'graph' }); return true; }
  const subjects = old?.subjects ?? new Set<string>();
  if (!subjects.has(subject) && subjects.size >= STORE_CONTENT_EFFECT_MAX_SUBJECTS_PER_GRAPH) {
    graphs.set(graph, { kind: 'graph' });
  } else {
    subjects.add(subject); graphs.set(graph, { kind: 'subjects', subjects });
  }
  return true;
}

function mutationEffect(mutation: StoreMutation): ContentEffect {
  if (mutation.everything) return { kind: 'global' };
  const graphs = new Map<string, GraphEffect>();
  // Walk the caller's batches directly; a large write must not allocate a second row array.
  for (const entries of [mutation.quads ?? [], mutation.removals ?? []]) {
    for (const { graph, subject } of entries) {
      if (!graph || !isSafeIri(graph) || !addEffect(graphs, graph, subject)) return { kind: 'global' };
    }
  }
  return { kind: 'graphs', graphs };
}

function scopeEffect(scope: StoreContentScope): ContentEffect {
  const graphs = new Map<string, GraphEffect>(scope.graphs.map(graph => [graph, { kind: 'graph' }]));
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
    if (effect.kind === 'graph') {
      if (!addEffect(left.graphs, graph)) return { kind: 'global' };
    } else for (const subject of effect.subjects) {
      if (!addEffect(left.graphs, graph, subject)) return { kind: 'global' };
    }
  }
  return left;
}

/** Invalidates before dispatch and retains uncertain outcomes until a supervised
 * backend replacement confirms termination. Reading or rewriting is not proof.
 */
export class StoreContentFence implements StoreMutationObserver {
  private readonly pending = new Set<ContentEffect>();
  private readonly watches = new Set<{ effect: ContentEffect; valid: boolean }>();
  private unboundUncertainty?: ContentEffect;
  // Coalescing numeric epochs under the newest one may delay reuse, never permit it early.
  private supervisedUncertainty?: { generation: number; effect: ContentEffect };

  constructor(private readonly recoveryGeneration?: StoreRecoveryGenerationReader) {}

  begin(mutation: StoreMutation): (outcome: StoreMutationOutcome, execution?: StoreMutationExecution) => void {
    const pending = mutationEffect(mutation);
    this.pending.add(pending);
    for (const watch of this.watches) if (overlaps(watch.effect, pending)) watch.valid = false;
    return (outcome, execution) => {
      this.pending.delete(pending);
      if (outcome === 'indeterminate') {
        // A posted worker operation carries its actual backend generation. A
        // queued/opaque failure has no such evidence and may have executed on
        // the replacement, so conservatively label it at settlement instead.
        const state = this.recoveryGeneration?.();
        this.retireUncertainty(state);
        const generation = execution?.generation ?? state?.generation;
        if (generation === undefined) this.unboundUncertainty = combine(
          this.unboundUncertainty ?? { kind: 'graphs', graphs: new Map() }, pending);
        else if (!state?.ready || generation >= state.generation) {
          const previous = this.supervisedUncertainty;
          this.supervisedUncertainty = {
            generation: Math.max(generation, previous?.generation ?? generation),
            effect: combine(previous?.effect ?? { kind: 'graphs', graphs: new Map() }, pending),
          };
        }
      }
    };
  }

  private retireUncertainty(state: ReturnType<StoreRecoveryGenerationReader>): void {
    // Unbound outcomes never retire. Only a ready replacement beyond every
    // coalesced execution epoch proves those supervised operations terminated.
    if (state?.ready && this.supervisedUncertainty && this.supervisedUncertainty.generation < state.generation) {
      this.supervisedUncertainty = undefined;
    }
  }

  openScope(scope: StoreContentScope): { assertCurrent(): void; close(): void } | undefined {
    const state = this.recoveryGeneration?.();
    if (this.recoveryGeneration && !state?.ready) return undefined;
    const generation = state?.generation;
    const effect = scopeEffect(scope);
    this.retireUncertainty(state);
    if ((this.unboundUncertainty && overlaps(effect, this.unboundUncertainty))
      || (this.supervisedUncertainty && overlaps(effect, this.supervisedUncertainty.effect))) return undefined;
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
