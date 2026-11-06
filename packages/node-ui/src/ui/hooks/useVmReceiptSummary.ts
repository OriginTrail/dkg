/**
 * useVmReceiptSummary — graph-level summary of REAL on-chain publish
 * receipts for a context graph (C11, Verifiable Memory header facts).
 *
 * A pure projection of the receipts `useVmReceipts` loads and normalises
 * (the same records the VM graph's anchors are drawn from).
 */
import { useMemo } from 'react';
import { useVmReceipts, type VmReceipt } from './useVmReceipts.js';

export interface VmReceiptSummary {
  /** Assertion URIs that have a real publish tx. Member entities are also
   *  namespaced under their assertion URI (see `hasReceipt`). */
  assertions: string[];
  /** Entity IRIs listed as members of a receipted assertion. */
  members: Set<string>;
  /** Distinct agents that published (attribution, else the assertion author). */
  signers: Set<string>;
  /** Latest assertion finalize (off-chain seal) time, ms, or null when
   *  unknown. Not the publish time: a receipt carries no publish timestamp,
   *  and publishing can come days after finalizing. */
  lastFinalizedAt: number | null;
  /** false when not every receipt could be read: an entity without a listed
   *  receipt may still be anchored. */
  complete: boolean;
}

export interface VmReceiptSummaryState {
  summary: VmReceiptSummary | null;
  loading: boolean;
  error: string | null;
}

/** Summarise receipts for the header facts. Exported for tests. */
export function summariseVmReceipts(receipts: readonly VmReceipt[], complete = true): VmReceiptSummary {
  const members = new Set<string>();
  const signers = new Set<string>();
  let last: number | null = null;
  for (const r of receipts) {
    for (const m of r.members) members.add(m);
    for (const s of r.signers) signers.add(s);
    const t = r.finalizedAt ? Date.parse(r.finalizedAt) : NaN;
    if (Number.isFinite(t) && (last === null || t > last)) last = t;
  }
  return { assertions: receipts.map(r => r.assertion), members, signers, lastFinalizedAt: last, complete };
}

/** Is this entity covered by a receipted assertion? Either a member row
 *  names it, or it is the assertion itself or lives under it (the assertion
 *  URI followed by "/" or "#"). A bare prefix is not enough: a receipt for
 *  …/assertion/0xabc/note must not cover …/assertion/0xabc/notebook/…. */
export function hasReceipt(entityUri: string, s: VmReceiptSummary): boolean {
  if (s.members.has(entityUri)) return true;
  for (const a of s.assertions) if (isAtOrUnder(entityUri, a)) return true;
  return false;
}

/** `uri` is `base` itself or lives under it ("/" or "#" boundary). */
export function isAtOrUnder(uri: string, base: string): boolean {
  if (uri === base) return true;
  if (!uri.startsWith(base)) return false;
  // A base that already ends in a separator is its own boundary.
  if (base.endsWith('/') || base.endsWith('#')) return true;
  const next = uri[base.length];
  return next === '/' || next === '#';
}

export function useVmReceiptSummary(contextGraphId: string | undefined): VmReceiptSummaryState {
  const { receipts, complete, loading, error } = useVmReceipts(contextGraphId);
  const summary = useMemo(() => (receipts ? summariseVmReceipts(receipts, complete) : null), [receipts, complete]);
  return { summary, loading, error };
}
