import { describe, expect, it } from 'vitest';
import type { AdmissionJournalEntry } from '../src/lift-job.js';
import {
  DEFAULT_JOURNAL_GRAPH_URI,
  JOURNAL_SEQ,
  JOURNAL_KIND,
  JOURNAL_TX_HASH,
  JOURNAL_INTENT_KEY,
  XSD_INTEGER,
  journalEntrySubject,
  journalLineageKeyHash,
  serializeJournalEntry,
  parseJournalEntry,
} from '../src/async-lift-control-plane.js';

// #1829 — journal entry serialize/parse round-trip + xsd:integer seq + stable subject.
describe('#1829 admission journal serialize/parse', () => {
  const sep = String.fromCharCode(0x1f);
  const lineageKey = ['music-social', 'albums', '', '0xabc'].join(sep);

  function entry(overrides: Partial<AdmissionJournalEntry> = {}): AdmissionJournalEntry {
    return {
      seq: 3,
      at: 1_784_000_000_000,
      kind: 'broadcast',
      jobId: 'job-1',
      lineageKey,
      intentKey: `sha256:${'ab'.repeat(32)}`,
      txHash: `0x${'ef'.repeat(32)}`,
      blockNumber: 321,
      merkleRoot: `0x${'12'.repeat(32)}`,
      ...overrides,
    };
  }

  function bindingsFromQuads(quads: ReturnType<typeof serializeJournalEntry>): Record<string, string | undefined> {
    // Mirror how a SELECT ?p ?o over the entry subject would be reduced to a
    // predicate->object map (object is the raw RDF term string).
    const row: Record<string, string | undefined> = {};
    for (const q of quads) row[q.predicate] = q.object;
    return row;
  }

  it('round-trips every field through serialize -> parse', () => {
    const e = entry();
    const quads = serializeJournalEntry(e, DEFAULT_JOURNAL_GRAPH_URI);
    const parsed = parseJournalEntry(bindingsFromQuads(quads));
    expect(parsed).toEqual(e);
  });

  it('round-trips a minimal entry (no optional fields)', () => {
    const e = entry({ intentKey: undefined, txHash: undefined, blockNumber: undefined, merkleRoot: undefined });
    const parsed = parseJournalEntry(bindingsFromQuads(serializeJournalEntry(e, DEFAULT_JOURNAL_GRAPH_URI)));
    expect(parsed).toEqual(e);
    // Absent optionals must not surface as keys.
    expect(parsed && 'txHash' in parsed).toBe(false);
  });

  it('serializes seq and blockNumber as xsd:integer (numeric MAX sorts correctly)', () => {
    const quads = serializeJournalEntry(entry({ seq: 10 }), DEFAULT_JOURNAL_GRAPH_URI);
    const seqQuad = quads.find((q) => q.predicate === JOURNAL_SEQ);
    expect(seqQuad?.object).toBe(`"10"^^<${XSD_INTEGER}>`);
  });

  it('all quads land in the node-local journal graph', () => {
    const quads = serializeJournalEntry(entry(), DEFAULT_JOURNAL_GRAPH_URI);
    expect(quads.every((q) => q.graph === DEFAULT_JOURNAL_GRAPH_URI)).toBe(true);
    expect(DEFAULT_JOURNAL_GRAPH_URI).toBe('urn:dkg:publisher:journal');
  });

  it('subject is a hash of the lineageKey + zero-padded seq (lexical order == numeric order)', () => {
    const s3 = journalEntrySubject(lineageKey, 3);
    const s10 = journalEntrySubject(lineageKey, 10);
    const hash = journalLineageKeyHash(lineageKey);
    expect(s3).toBe(`urn:dkg:publisher:journal-entry:${hash}:000000000003`);
    expect(s3 < s10).toBe(true); // zero-pad keeps lexical order aligned with seq
    // The raw U+001F delimiter never leaks into the subject IRI.
    expect(s3.includes(sep)).toBe(false);
  });

  it('parse returns null when a required field is missing (corrupt row skipped, not thrown)', () => {
    const quads = serializeJournalEntry(entry(), DEFAULT_JOURNAL_GRAPH_URI).filter((q) => q.predicate !== JOURNAL_KIND);
    const row: Record<string, string | undefined> = {};
    for (const q of quads) row[q.predicate] = q.object;
    expect(parseJournalEntry(row)).toBeNull();
  });
});
