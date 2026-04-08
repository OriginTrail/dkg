import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MerkleTree, hashTriple } from '@origintrail-official/dkg-core';
import type { TripleStore, Quad, QueryResult, SelectResult, AskResult, ConstructResult } from '@origintrail-official/dkg-storage';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { ContextOracle } from '../src/context-oracle.js';
import { ProofIndex } from '../src/proof-index.js';

const PARANET = 'testnet-alpha';
const CG_ID = '42';
const BATCH_ID = '7';
const GRAPH_URI = `did:dkg:context-graph:${PARANET}/context/${CG_ID}`;

function q(s: string, p: string, o: string, g = GRAPH_URI): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

const testTriples: Quad[] = [
  q('did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"'),
  q('did:dkg:agent:Alice', 'http://schema.org/age', '"30"'),
  q('did:dkg:agent:Bob', 'http://schema.org/name', '"Bob"'),
];

function createMockStore(): TripleStore {
  return {
    insert: vi.fn(),
    delete: vi.fn(),
    deleteByPattern: vi.fn(),
    query: vi.fn(),
    hasGraph: vi.fn(),
    createGraph: vi.fn(),
    dropGraph: vi.fn(),
    listGraphs: vi.fn(),
    deleteBySubjectPrefix: vi.fn(),
    close: vi.fn(),
  } as unknown as TripleStore;
}

function createMockChain(): ChainAdapter {
  return {
    chainType: 'evm' as const,
    chainId: 'eip155:84532',
    init: vi.fn(),
  } as unknown as ChainAdapter;
}

function seedIndex(proofIndex: ProofIndex): void {
  proofIndex.storeBatch(CG_ID, BATCH_ID, testTriples);
}

describe('ContextOracle', () => {
  let store: TripleStore;
  let chain: ChainAdapter;
  let proofIndex: ProofIndex;
  let oracle: ContextOracle;

  beforeEach(() => {
    store = createMockStore();
    chain = createMockChain();
    proofIndex = new ProofIndex();
    seedIndex(proofIndex);
    oracle = new ContextOracle(store, chain, proofIndex);
  });

  describe('entityLookup', () => {
    it('returns triples with proofs for a known entity', async () => {
      const selectResult: SelectResult = {
        type: 'bindings',
        bindings: [
          { s: 'did:dkg:agent:Alice', p: 'http://schema.org/name', o: '"Alice"' },
          { s: 'did:dkg:agent:Alice', p: 'http://schema.org/age', o: '"30"' },
        ],
      };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(selectResult);

      const result = await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Alice');

      expect(result.contextGraphId).toBe(CG_ID);
      expect(result.entity).toBe('did:dkg:agent:Alice');
      expect(result.triples).toHaveLength(2);

      for (const t of result.triples) {
        expect(t.proof).toBeDefined();
        expect(t.proof.tripleHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(t.proof.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
        expect(t.proof.batchId).toBe(BATCH_ID);
        expect(t.proof.siblings.length).toBeGreaterThan(0);
      }

      expect(result.verification.chainId).toBe('eip155:84532');
      expect(result.verification.contextGraphId).toBe(CG_ID);
      expect(result.verification.batchIds).toContain(BATCH_ID);
      expect(result.verification.merkleRoots[BATCH_ID]).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it('drops store triples that have no entry in the proof index (same entity)', async () => {
      const selectResult: SelectResult = {
        type: 'bindings',
        bindings: [
          { s: 'did:dkg:agent:Alice', p: 'http://schema.org/name', o: '"Alice"' },
          { s: 'did:dkg:agent:Alice', p: 'http://schema.org/nickname', o: '"Ali"' },
        ],
      };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(selectResult);

      const result = await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Alice');

      expect(result.triples).toHaveLength(1);
      expect(result.triples[0].predicate).toBe('http://schema.org/name');
      expect(result.verification.batchIds).toEqual([BATCH_ID]);
    });

    it('returns empty triples for unknown entity', async () => {
      const selectResult: SelectResult = { type: 'bindings', bindings: [] };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(selectResult);

      const result = await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Nobody');
      expect(result.triples).toHaveLength(0);
      expect(result.verification.batchIds).toHaveLength(0);
    });

    it('issues SPARQL query scoped to the correct named graph', async () => {
      const selectResult: SelectResult = { type: 'bindings', bindings: [] };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(selectResult);

      await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Alice');

      const sparql = (store.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sparql).toContain(`GRAPH <${GRAPH_URI}>`);
      expect(sparql).toContain('did:dkg:agent:Alice');
    });
  });

  describe('queryWithProofs', () => {
    it('returns bindings and provenance triples with proofs', async () => {
      const selectResult: SelectResult = {
        type: 'bindings',
        bindings: [
          { s: 'did:dkg:agent:Alice', name: '"Alice"' },
          { s: 'did:dkg:agent:Bob', name: '"Bob"' },
        ],
      };
      const provenanceResult: SelectResult = {
        type: 'bindings',
        bindings: [
          { s: 'did:dkg:agent:Alice', p: 'http://schema.org/name', o: '"Alice"' },
          { s: 'did:dkg:agent:Alice', p: 'http://schema.org/age', o: '"30"' },
        ],
      };
      (store.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(selectResult)
        .mockResolvedValueOnce(provenanceResult);

      const result = await oracle.queryWithProofs(
        PARANET, CG_ID,
        'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      );

      expect(result.bindings).toHaveLength(2);
      expect(result.provenanceTriples).toHaveLength(2);

      for (const t of result.provenanceTriples) {
        expect(t.proof.batchId).toBe(BATCH_ID);
        expect(t.proof.tripleHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(t.proof.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
      }

      expect(result.verification.merkleRoots[BATCH_ID]).toBeDefined();
    });

    it('wraps query with GRAPH clause when not already present', async () => {
      const empty: SelectResult = { type: 'bindings', bindings: [] };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(empty);

      await oracle.queryWithProofs(PARANET, CG_ID, 'SELECT ?s WHERE { ?s ?p ?o }');

      const wrappedSparql = (store.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(wrappedSparql).toContain(`GRAPH <${GRAPH_URI}>`);
    });

    it('rejects queries that already contain GRAPH clauses', async () => {
      const alreadyWrapped = `SELECT ?s WHERE { GRAPH <${GRAPH_URI}> { ?s ?p ?o } }`;
      await expect(
        oracle.queryWithProofs(PARANET, CG_ID, alreadyWrapped),
      ).rejects.toThrow('User queries must not contain GRAPH clauses');
    });

    it('provenance query scopes to subjects from bindings', async () => {
      const selectResult: SelectResult = {
        type: 'bindings',
        bindings: [
          { s: 'did:dkg:agent:Alice', name: '"Alice"' },
        ],
      };
      const provenanceResult: SelectResult = {
        type: 'bindings',
        bindings: [
          { s: 'did:dkg:agent:Alice', p: 'http://schema.org/name', o: '"Alice"' },
          { s: 'did:dkg:agent:Alice', p: 'http://schema.org/age', o: '"30"' },
        ],
      };
      (store.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(selectResult)
        .mockResolvedValueOnce(provenanceResult);

      await oracle.queryWithProofs(
        PARANET, CG_ID,
        'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      );

      const secondCallSparql = (store.query as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
      expect(secondCallSparql).toContain('VALUES ?s { <did:dkg:agent:Alice> }');
    });

    it('omits provenance triples that are in the store but not in the proof index', async () => {
      const selectResult: SelectResult = {
        type: 'bindings',
        bindings: [{ s: 'did:dkg:agent:Zora', name: '"Zora"' }],
      };
      const provenanceResult: SelectResult = {
        type: 'bindings',
        bindings: [
          { s: 'did:dkg:agent:Zora', p: 'http://schema.org/name', o: '"Zora"' },
        ],
      };
      (store.query as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(selectResult)
        .mockResolvedValueOnce(provenanceResult);

      const result = await oracle.queryWithProofs(
        PARANET, CG_ID,
        'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      );

      expect(result.bindings).toHaveLength(1);
      expect(result.provenanceTriples).toHaveLength(0);
      expect(result.verification.batchIds).toHaveLength(0);
    });
  });

  describe('proveTriple', () => {
    it('returns proof when triple exists in store and index', async () => {
      const askResult: AskResult = { type: 'boolean', value: true };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(askResult);

      const result = await oracle.proveTriple(
        PARANET, CG_ID,
        'did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"',
      );

      expect(result.exists).toBe(true);
      expect(result.triple).toEqual({
        subject: 'did:dkg:agent:Alice',
        predicate: 'http://schema.org/name',
        object: '"Alice"',
      });
      expect(result.proof).toBeDefined();
      expect(result.proof!.batchId).toBe(BATCH_ID);
      expect(result.verification).toBeDefined();
      expect(result.verification!.merkleRoots[BATCH_ID]).toBeDefined();
    });

    it('returns exists=false when triple not in store', async () => {
      const askResult: AskResult = { type: 'boolean', value: false };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(askResult);

      const result = await oracle.proveTriple(
        PARANET, CG_ID,
        'did:dkg:agent:Nobody', 'http://schema.org/name', '"Nobody"',
      );

      expect(result.exists).toBe(false);
      expect(result.proof).toBeUndefined();
      expect(result.verification).toBeUndefined();
    });

    it('returns exists=true but no proof when triple in store but not in index', async () => {
      const askResult: AskResult = { type: 'boolean', value: true };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(askResult);

      const result = await oracle.proveTriple(
        PARANET, CG_ID,
        'did:dkg:agent:Unknown', 'http://schema.org/x', '"y"',
      );

      expect(result.exists).toBe(true);
      expect(result.triple).toBeDefined();
      expect(result.proof).toBeUndefined();
    });

    it('rejects unsafe predicate IRI', async () => {
      await expect(
        oracle.proveTriple(
          PARANET, CG_ID,
          'did:dkg:agent:Alice',
          'http://evil"> } }',
          '"Alice"',
        ),
      ).rejects.toThrow('Unsafe or empty IRI value');
    });

    it('formats ASK query with correct SPARQL terms', async () => {
      const askResult: AskResult = { type: 'boolean', value: false };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(askResult);

      await oracle.proveTriple(
        PARANET, CG_ID,
        'did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"',
      );

      const sparql = (store.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(sparql).toContain(`GRAPH <${GRAPH_URI}>`);
      expect(sparql).toContain('<did:dkg:agent:Alice>');
      expect(sparql).toContain('<http://schema.org/name>');
      expect(sparql).toContain('"Alice"');
    });

    it('rejects malformed literals to avoid unsafe SPARQL injection', async () => {
      await expect(
        oracle.proveTriple(
          PARANET, CG_ID,
          'did:dkg:agent:Alice', 'http://schema.org/name', '"unclosed',
        ),
      ).rejects.toThrow(/Malformed or unsafe SPARQL literal/);
    });
  });

  describe('proof index integration', () => {
    it('oracle exposes proofIndex for external population', () => {
      expect(oracle.proofIndex).toBe(proofIndex);
    });

    it('creates its own ProofIndex when none provided', () => {
      const oracle2 = new ContextOracle(store, chain);
      expect(oracle2.proofIndex).toBeInstanceOf(ProofIndex);
    });

    it('proofs from multiple batches reference different batchIds', async () => {
      const extraTriples: Quad[] = [
        q('did:dkg:agent:Charlie', 'http://schema.org/name', '"Charlie"'),
      ];
      proofIndex.storeBatch(CG_ID, '99', extraTriples);

      const selectResult: SelectResult = {
        type: 'bindings',
        bindings: [
          { s: 'did:dkg:agent:Alice', p: 'http://schema.org/name', o: '"Alice"' },
          { s: 'did:dkg:agent:Charlie', p: 'http://schema.org/name', o: '"Charlie"' },
        ],
      };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(selectResult);

      const result = await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Alice');

      const batchIds = new Set(result.triples.map(t => t.proof.batchId));
      expect(batchIds.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe('verification info', () => {
    it('includes chain ID from adapter', async () => {
      const selectResult: SelectResult = {
        type: 'bindings',
        bindings: [{ s: 'did:dkg:agent:Alice', p: 'http://schema.org/name', o: '"Alice"' }],
      };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(selectResult);

      const result = await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Alice');
      expect(result.verification.chainId).toBe('eip155:84532');
    });

    it('merkle roots match those computed by ProofIndex', async () => {
      const selectResult: SelectResult = {
        type: 'bindings',
        bindings: [{ s: 'did:dkg:agent:Bob', p: 'http://schema.org/name', o: '"Bob"' }],
      };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(selectResult);

      const result = await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Bob');
      const expectedRoot = proofIndex.getBatchMerkleRoot(CG_ID, BATCH_ID);
      expect(result.verification.merkleRoots[BATCH_ID]).toBe(expectedRoot);
    });
  });

  describe('SPARQL injection prevention', () => {
    it('rejects entityUri with angle brackets', async () => {
      await expect(
        oracle.entityLookup(PARANET, CG_ID, 'http://evil.com> } } SELECT * WHERE { <x'),
      ).rejects.toThrow('Unsafe or empty IRI value');
    });

    it('rejects entityUri with double quotes', async () => {
      await expect(
        oracle.entityLookup(PARANET, CG_ID, 'http://evil.com"'),
      ).rejects.toThrow('Unsafe or empty IRI value');
    });

    it('rejects entityUri with curly braces', async () => {
      await expect(
        oracle.entityLookup(PARANET, CG_ID, 'http://evil.com/path{inject}'),
      ).rejects.toThrow('Unsafe or empty IRI value');
    });

    it('rejects entityUri with backslash', async () => {
      await expect(
        oracle.entityLookup(PARANET, CG_ID, 'http://evil.com\\path'),
      ).rejects.toThrow('Unsafe or empty IRI value');
    });

    it('rejects entityUri with control characters', async () => {
      await expect(
        oracle.entityLookup(PARANET, CG_ID, 'http://evil.com/\x00inject'),
      ).rejects.toThrow('Unsafe or empty IRI value');
    });

    it('rejects entityUri with space', async () => {
      await expect(
        oracle.entityLookup(PARANET, CG_ID, 'http://evil.com/some path'),
      ).rejects.toThrow('Unsafe or empty IRI value');
    });

    it('allows safe IRIs through', async () => {
      const selectResult: SelectResult = { type: 'bindings', bindings: [] };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(selectResult);

      const result = await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Alice');
      expect(result.triples).toHaveLength(0);
    });

    it('proveTriple rejects unsafe subject IRI', async () => {
      await expect(
        oracle.proveTriple(PARANET, CG_ID, 'http://x"> DROP ALL', 'http://schema.org/name', '"Alice"'),
      ).rejects.toThrow('Unsafe or empty IRI value');
    });

    it('proveTriple rejects literal with unbalanced quotes (SPARQL injection)', async () => {
      await expect(
        oracle.proveTriple(PARANET, CG_ID, 'did:dkg:agent:Alice', 'http://schema.org/name', '"hello" . } SELECT * WHERE { ?x ?y ?z'),
      ).rejects.toThrow('Malformed or unsafe SPARQL literal');
    });

    it('proveTriple rejects literal that closes early and injects patterns', async () => {
      await expect(
        oracle.proveTriple(PARANET, CG_ID, 'did:dkg:agent:Alice', 'http://schema.org/name', '"x" ; <http://evil.com/prop> "y"'),
      ).rejects.toThrow('Malformed or unsafe SPARQL literal');
    });

    it('proveTriple accepts well-formed simple literal', async () => {
      const askResult: AskResult = { type: 'boolean', value: false };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(askResult);

      const result = await oracle.proveTriple(PARANET, CG_ID, 'did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"');
      expect(result.exists).toBe(false);
    });

    it('proveTriple accepts well-formed language-tagged literal', async () => {
      const askResult: AskResult = { type: 'boolean', value: false };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(askResult);

      const result = await oracle.proveTriple(PARANET, CG_ID, 'did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"@en');
      expect(result.exists).toBe(false);
    });

    it('proveTriple accepts well-formed typed literal', async () => {
      const askResult: AskResult = { type: 'boolean', value: false };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(askResult);

      const result = await oracle.proveTriple(
        PARANET, CG_ID, 'did:dkg:agent:Alice', 'http://schema.org/age',
        '"30"^^<http://www.w3.org/2001/XMLSchema#integer>',
      );
      expect(result.exists).toBe(false);
    });

    it('proveTriple accepts literal with escaped characters', async () => {
      const askResult: AskResult = { type: 'boolean', value: false };
      (store.query as ReturnType<typeof vi.fn>).mockResolvedValue(askResult);

      const result = await oracle.proveTriple(
        PARANET, CG_ID, 'did:dkg:agent:Alice', 'http://schema.org/desc',
        '"line1\\nline2\\twith \\"quotes\\""',
      );
      expect(result.exists).toBe(false);
    });
  });
});

function hexToBytes(h: string): Uint8Array {
  const clean = h.startsWith('0x') ? h.slice(2) : h;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
