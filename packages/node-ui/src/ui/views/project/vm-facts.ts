import { canonicalEntityUri } from '../../hooks/memory-graph-query.js';
import type { MemoryEntity } from '../../hooks/useMemoryEntities.js';
import { hasReceipt, type VmReceiptSummary } from '../../hooks/useVmReceiptSummary.js';
import { formatRelativeTime } from './helpers.js';
import { formatDateTime } from '../../lib/format.js';

/** The subjects of Verifiable Memory's own triples, canonicalised. Entity
 *  fields merge every memory layer, so they can't say whether an entity is a
 *  subject in VM; the VM triples can. */
export function vmSubjectsOf(vmTriples: ReadonlyArray<{ subject: string }>): Set<string> {
  return new Set(vmTriples.map(t => canonicalEntityUri(t.subject)));
}

export type VmFactTone = 'ok' | 'warn' | 'muted';
export interface VmFact { id: string; label: string; value: string; tone: VmFactTone; tooltip: string }

/**
 * Facts about THIS context graph's Verifiable Memory, from its real
 * on-chain publish receipts (C11). Replaces four fixed chips that described VM in general
 * and claimed consensus that can't be configured yet.
 */
export function buildVmFacts(
  entities: MemoryEntity[],
  summary: VmReceiptSummary | null,
  state: { loading: boolean; error: string | null },
  vmSubjects: ReadonlySet<string>,
): VmFact[] {
  const consensus: VmFact = {
    id: 'consensus', label: 'Consensus', value: 'not set up', tone: 'muted',
    tooltip: 'Consensus quorums for context graphs are coming soon.',
  };
  if (!summary) {
    if (state.error) return [{ id: 'onchain', label: 'On-chain', value: "couldn't load", tone: 'muted', tooltip: state.error }, consensus];
    return [{ id: 'onchain', label: 'On-chain', value: 'checking…', tone: 'muted', tooltip: 'Loading publish receipts' }, consensus];
  }
  // Count the same population receipts cover: entities that are the subject
  // of at least one Verifiable Memory triple. A node seen in VM only as a
  // relationship's object (<alice> schema:knows <bob>) belongs to its
  // subject's asset, even when it has draft facts in another layer.
  const assets = entities.filter(e => vmSubjects.has(e.uri) || vmSubjects.has(canonicalEntityUri(e.uri)));
  const total = assets.length;
  const anchored = assets.filter(e => hasReceipt(e.uri, summary) || hasReceipt(canonicalEntityUri(e.uri), summary)).length;
  const missing = total - anchored;
  // A capped read may have left receipts out: never call those entities unanchored.
  const facts: VmFact[] = [missing > 0 && !summary.complete ? {
    id: 'onchain', label: 'On-chain', value: `at least ${anchored} / ${total} anchored`, tone: 'muted',
    tooltip: 'This context graph has more publish receipts than could be read at once, so Knowledge Assets without a listed receipt may still be anchored.',
  } : {
    id: 'onchain', label: 'On-chain', value: `${anchored} / ${total} anchored`, tone: missing > 0 ? 'warn' : 'ok',
    tooltip: missing > 0
      ? `${missing} Knowledge Asset${missing === 1 ? ' has' : 's have'} no on-chain receipt yet: still settling, or read from a pre-cutover graph.`
      : 'Every Knowledge Asset here has an on-chain publish receipt.',
  }];
  const n = summary.signers.size;
  if (n > 0) {
    facts.push({ id: 'signers', label: 'Signed by', value: `${n} agent${n === 1 ? '' : 's'}`, tone: 'ok',
      tooltip: 'Distinct agents that published to Verifiable Memory in this context graph.' });
  }
  if (summary.lastFinalizedAt !== null) {
    facts.push({ id: 'last', label: 'Last finalized', value: formatRelativeTime(summary.lastFinalizedAt), tone: 'ok',
      tooltip: `${formatDateTime(summary.lastFinalizedAt)}: when the newest published assertion was finalized (sealed off-chain). It may have been published later.` });
  }
  facts.push(consensus);
  return facts;
}
