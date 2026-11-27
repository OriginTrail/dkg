// SPDX-License-Identifier: Apache-2.0

import {
  AGENT_DID_PREFIX, canonicalAgentDidSubject, isEvmAgentDidSubject, isSafeIri,
} from '@origintrail-official/dkg-core';

/** null means the write cannot be restricted to a known set of agent subjects. */
export type RecipientKeyRouteScope = ReadonlySet<string> | null;
const HISTORY_LIMIT = 512;

/** Lookup reads agent DIDs and their derived key fragments, never another agent's subjects. */
export function recipientSubjectAgent(subject: string | undefined): string | undefined {
  if (!subject || !isSafeIri(subject) || !subject.startsWith(AGENT_DID_PREFIX)) return;
  const agent = subject.slice(AGENT_DID_PREFIX.length).split('#', 1)[0];
  return isEvmAgentDidSubject(agent) ? canonicalAgentDidSubject(agent) : undefined;
}

/** Bounded invalidation history. An expired history fails closed rather than guessing. */
export class RecipientKeyRouteChanges {
  private readonly changes: Array<{ revision: number; scope: RecipientKeyRouteScope }> = [];
  private readonly pending = new Map<object, RecipientKeyRouteScope>();
  private floor = 0;

  begin(scope: RecipientKeyRouteScope): () => void {
    const key = {};
    this.pending.set(key, scope);
    return () => { this.pending.delete(key); };
  }

  record(revision: number, scope: RecipientKeyRouteScope): void {
    this.changes.push({ revision, scope });
    if (this.changes.length > HISTORY_LIMIT) this.floor = this.changes.shift()!.revision;
  }

  hasPending(agents: readonly string[]): boolean {
    const roster = this.roster(agents);
    return [...this.pending.values()].some(scope => this.intersects(scope, roster));
  }

  current(revision: number, currentRevision: number, agents: readonly string[]): boolean {
    if (revision < this.floor || revision > currentRevision || this.hasPending(agents)) return false;
    const roster = this.roster(agents);
    return !this.changes.some(change => change.revision > revision && this.intersects(change.scope, roster));
  }

  private roster(agents: readonly string[]): RecipientKeyRouteScope {
    if (agents.length === 0 || agents.some(agent => !isEvmAgentDidSubject(agent))) return null;
    return new Set(agents.map(canonicalAgentDidSubject));
  }

  private intersects(scope: RecipientKeyRouteScope, roster: RecipientKeyRouteScope): boolean {
    return scope === null || roster === null || [...scope].some(agent => roster.has(agent));
  }
}
