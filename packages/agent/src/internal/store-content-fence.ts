// SPDX-License-Identifier: Apache-2.0
import { isSafeIri } from '@origintrail-official/dkg-core';
import type { StoreMutation, StoreMutationOutcome, StoreMutationObserver } from './store-mutation.js';

export interface StoreContentScope {
  readonly assertionGraphs: readonly string[];
  readonly metadataGraph: string;
  readonly subjects: readonly string[];
}

/** A proof watches only its assertion graphs and descriptor subjects, from before
 * the first read until synchronous settlement. Writes invalidate before dispatch;
 * unresolved writes block only scopes they might still change. Unknown writes
 * remain global; reading again cannot prove a timed-out backend write settled.
 */
export class StoreContentFence implements StoreMutationObserver {
  private readonly pending = new Map<StoreMutation, number>();
  private readonly watches = new Set<{ touches(mutation: StoreMutation): boolean; valid: boolean }>();
  private uncertainEverywhere = false;
  private readonly uncertainSubjects = new Map<string, Set<string> | undefined>();

  private rememberUncertain(mutation: StoreMutation): void {
    const remember = (graph?: string, subject?: string) => {
      if (!graph || !isSafeIri(graph)) { this.uncertainEverywhere = true; return; }
      if (!subject || subject.startsWith('_:')) { this.uncertainSubjects.set(graph, undefined); return; }
      if (this.uncertainSubjects.has(graph) && this.uncertainSubjects.get(graph) === undefined) return;
      const subjects = this.uncertainSubjects.get(graph) ?? new Set<string>();
      subjects.add(subject); this.uncertainSubjects.set(graph, subjects);
    };
    if (mutation.everything) this.uncertainEverywhere = true;
    for (const quad of mutation.quads ?? []) remember(quad.graph, quad.subject);
    for (const removal of mutation.removals ?? []) remember(removal.graph, removal.subject);
  }

  private isUncertain(scope: StoreContentScope): boolean {
    if (this.uncertainEverywhere || scope.assertionGraphs.some(graph => this.uncertainSubjects.has(graph))) return true;
    if (!this.uncertainSubjects.has(scope.metadataGraph)) return false;
    const subjects = this.uncertainSubjects.get(scope.metadataGraph);
    return subjects === undefined || scope.subjects.some(subject => subjects.has(subject));
  }

  begin(mutation: StoreMutation): (outcome: StoreMutationOutcome) => void {
    this.pending.set(mutation, (this.pending.get(mutation) ?? 0) + 1);
    for (const watch of this.watches) if (watch.touches(mutation)) watch.valid = false;
    return outcome => {
      const left = (this.pending.get(mutation) ?? 1) - 1;
      if (left) this.pending.set(mutation, left); else this.pending.delete(mutation);
      if (outcome === 'indeterminate') this.rememberUncertain(mutation);
    };
  }

  openScope(scope: StoreContentScope): { assertCurrent(): void; close(): void } | undefined {
    const graphs = new Set(scope.assertionGraphs), subjects = new Set(scope.subjects);
    const touches = (mutation: StoreMutation) => mutation.everything === true
      || mutation.quads?.some(quad => !isSafeIri(quad.graph) || graphs.has(quad.graph)
        || (quad.graph === scope.metadataGraph && (quad.subject.startsWith('_:') || subjects.has(quad.subject)))) === true
      || mutation.removals?.some(removal => !removal.graph || !isSafeIri(removal.graph) || graphs.has(removal.graph)
        || (removal.graph === scope.metadataGraph && (!removal.subject || removal.subject.startsWith('_:') || subjects.has(removal.subject)))) === true;
    if (this.isUncertain(scope) || [...this.pending.keys()].some(touches)) return undefined;
    const watch = { touches, valid: true };
    this.watches.add(watch);
    return {
      assertCurrent: () => {
        if (!watch.valid || this.isUncertain(scope)) throw Object.assign(
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
