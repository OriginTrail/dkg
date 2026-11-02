import { describe, expect, it } from 'vitest';
import { buildVmFacts } from '../src/ui/views/project/vm-facts.js';
import { summariseVmReceipts, buildVmReceiptSummaryQuery, isSafeIriPart } from '../src/ui/hooks/useVmReceiptSummary.js';

const ent = (uri: string) => ({ uri, label: uri, types: [], trustLevel: 'verified', layers: new Set(), subGraphs: new Set(), properties: new Map(), connections: [] }) as any;
const A = 'did:dkg:context-graph:cg/assertion/0xabc/';
const ok = { loading: false, error: null };

describe('VM receipt summary', () => {
  it('reads real receipts from the context graph _meta, not share records', () => {
    const q = buildVmReceiptSummaryQuery('cg');
    expect(q).toContain('GRAPH <did:dkg:context-graph:cg/_meta>');
    expect(q).toContain('dkg:publishedAtTx');
    expect(q).not.toContain('WorkspaceOperation');
  });

  it('collects members, signers (attribution or author address) and the latest finalize time', () => {
    const s = summariseVmReceipts([
      { asrt: A + 'one', member: 'urn:x:a', agent: 'did:dkg:agent:0xabc', finalizedAt: '"2026-10-30T10:00:00Z"' },
      { asrt: A + 'one', member: 'urn:x:b', agent: 'did:dkg:agent:0xabc', finalizedAt: '"2026-10-30T10:00:00Z"' },
      { asrt: 'did:dkg:context-graph:cg/assertion/0xdef/two', finalizedAt: '"2026-10-31T10:00:00Z"' },
    ]);
    expect([...s.members]).toEqual(['urn:x:a', 'urn:x:b']);
    expect([...s.signers].sort()).toEqual(['did:dkg:agent:0xabc', 'did:dkg:agent:0xdef']);
    expect(s.lastPublishedAt).toBe(Date.parse('2026-10-31T10:00:00Z'));
  });

  it('refuses context graph ids that would break the IRI', () => {
    expect(isSafeIriPart('agent-context')).toBe(true);
    expect(isSafeIriPart('x> } DROP')).toBe(false);
  });
});

describe('Verifiable Memory hero facts (C11)', () => {
  it('reports anchored count, signers, last publish and consensus', () => {
    const s = summariseVmReceipts([
      { asrt: A + 'one', member: 'urn:x:a', agent: 'did:dkg:agent:0x1', finalizedAt: '2026-10-30T10:00:00Z' },
      { asrt: A + 'two', agent: 'did:dkg:agent:0x2', finalizedAt: '2026-10-31T10:00:00Z' },
    ]);
    // urn:x:a by member row; the second entity by assertion-URI prefix.
    const facts = buildVmFacts([ent('urn:x:a'), ent(A + 'two/entity/1')], s, ok);
    expect(facts.map(f => f.id)).toEqual(['onchain', 'signers', 'last', 'consensus']);
    expect(facts[0]).toMatchObject({ value: '2 / 2 anchored', tone: 'ok' });
    expect(facts[1]).toMatchObject({ value: '2 agents' });
    expect(facts[3]).toMatchObject({ value: 'not set up', tone: 'muted' });
  });

  it('flags assets without an on-chain receipt', () => {
    const s = summariseVmReceipts([{ asrt: A + 'one', member: 'urn:x:a', agent: 'x' }]);
    const facts = buildVmFacts([ent('urn:x:a'), ent('urn:x:b'), ent('urn:x:c')], s, ok);
    expect(facts[0]).toMatchObject({ value: '1 / 3 anchored', tone: 'warn' });
    expect(facts[0]!.tooltip).toContain('2 Knowledge Assets have no on-chain receipt');
  });

  it('never claims consensus, and stays neutral while loading or on error', () => {
    const loading = buildVmFacts([ent('urn:x:a')], null, { loading: true, error: null });
    expect(loading.map(f => f.tone)).toEqual(['muted', 'muted']);
    const failed = buildVmFacts([ent('urn:x:a')], null, { loading: false, error: 'boom' });
    expect(failed[0]).toMatchObject({ value: "couldn't load", tone: 'muted' });
    for (const f of [...loading, ...failed]) if (f.id === 'consensus') expect(f.value).toBe('not set up');
  });
});
