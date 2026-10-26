// SPDX-License-Identifier: Apache-2.0
import { isSafeIri } from '@origintrail-official/dkg-core';
import type { StoreRecoveryGenerationReader } from '@origintrail-official/dkg-storage';
import type { StoreMutation, StoreMutationOutcome, StoreMutationObserver } from './store-mutation.js';

export interface StoreContentScope {
  readonly assertionGraphs: readonly string[];
  readonly metadataGraph: string;
  readonly subjects: readonly string[];
}

/** A proof watches only its assertion graphs and descriptor subjects, from before
 * the first read until synchronous settlement. Writes invalidate before dispatch;
 * unresolved writes block only scopes they might still change. Unknown writes
 * remain global until a supervised backend replacement proves termination.
 * Reading or rewriting alone cannot prove a timed-out backend write settled.
 */
export class StoreContentFence implements StoreMutationObserver {
  private readonly pending = new Set<{ mutation: StoreMutation; generation: number | undefined }>();
  private readonly watches = new Set<{ touches(mutation: StoreMutation): boolean; valid: boolean }>();
  private readonly uncertain = new Map<number | undefined, { everywhere: boolean; subjects: Map<string, Set<string> | undefined> }>();

  constructor(private readonly recoveryGeneration?: StoreRecoveryGenerationReader) {}


  private rememberUncertain(mutation: StoreMutation, generation: number | undefined): void {
    const uncertainty = this.uncertain.get(generation) ?? { everywhere: false, subjects: new Map<string, Set<string> | undefined>() };
    this.uncertain.set(generation, uncertainty);
    const remember = (graph?: string, subject?: string) => {
      if (!graph || !isSafeIri(graph)) { uncertainty.everywhere = true; return; }
      if (!subject || subject.startsWith('_:')) { uncertainty.subjects.set(graph, undefined); return; }
      if (uncertainty.subjects.has(graph) && uncertainty.subjects.get(graph) === undefined) return;
      const subjects = uncertainty.subjects.get(graph) ?? new Set<string>();
      subjects.add(subject); uncertainty.subjects.set(graph, subjects);
    };
    if (mutation.everything) uncertainty.everywhere = true;
    for (const quad of mutation.quads ?? []) remember(quad.graph, quad.subject);
    for (const removal of mutation.removals ?? []) remember(removal.graph, removal.subject);
  }

  private isUncertain(scope: StoreContentScope, generation: number | undefined): boolean {
    for (const [epoch, uncertainty] of this.uncertain) {
      // Only a confirmed newer backend can retire an indeterminate old write.
      // An unbound epoch (unsupported/unknown backend) stays fail-closed.
      if (epoch !== undefined && generation !== undefined && epoch < generation) { this.uncertain.delete(epoch); continue; }
      if (uncertainty.everywhere || scope.assertionGraphs.some(graph => uncertainty.subjects.has(graph))) return true;
      if (!uncertainty.subjects.has(scope.metadataGraph)) continue;
      const subjects = uncertainty.subjects.get(scope.metadataGraph);
      if (subjects === undefined || scope.subjects.some(subject => subjects.has(subject))) return true;
    }
    return false;
  }

  begin(mutation: StoreMutation): (outcome: StoreMutationOutcome) => void {
    const pending = { mutation, generation: this.recoveryGeneration?.() };
    this.pending.add(pending);
    for (const watch of this.watches) if (watch.touches(mutation)) watch.valid = false;
    return outcome => {
      this.pending.delete(pending);
      if (outcome === 'indeterminate') this.rememberUncertain(mutation, pending.generation);
    };
  }

  openScope(scope: StoreContentScope): { assertCurrent(): void; close(): void } | undefined {
    const generation = this.recoveryGeneration?.();
    if (this.recoveryGeneration && generation === undefined) return undefined;
    const graphs = new Set(scope.assertionGraphs), subjects = new Set(scope.subjects);
    const touches = (mutation: StoreMutation) => mutation.everything === true
      || mutation.quads?.some(quad => !isSafeIri(quad.graph) || graphs.has(quad.graph)
        || (quad.graph === scope.metadataGraph && (quad.subject.startsWith('_:') || subjects.has(quad.subject)))) === true
      || mutation.removals?.some(removal => !removal.graph || !isSafeIri(removal.graph) || graphs.has(removal.graph)
        || (removal.graph === scope.metadataGraph && (!removal.subject || removal.subject.startsWith('_:') || subjects.has(removal.subject)))) === true;
    // A client-side operation can span a backend restart and dispatch more work.
    // Only settled indeterminate outcomes can be retired by a newer generation.
    if (this.isUncertain(scope, generation) || [...this.pending].some(pending => touches(pending.mutation))) return undefined;
    const watch = { touches, valid: true };
    this.watches.add(watch);
    return {
      // begin() invalidates before dispatch; no need to rescan the full prefix
      // for each suffix write after the initial uncertainty/pending check.
      assertCurrent: () => {
        if (!watch.valid || this.recoveryGeneration?.() !== generation) throw Object.assign(
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
