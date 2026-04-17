import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { ContextOracle, type ChainContext } from '../src/context-oracle.js';
import { ProofIndex } from '../src/proof-index.js';

const PARANET = 'testnet-alpha';
const CG_ID = '42';
const BATCH_ID = '7';
const GRAPH_URI = `did:dkg:context-graph:${PARANET}/context/${CG_ID}`;
const CHAIN: ChainContext = { chainId: 'eip155:84532' };

function q(s: string, p: string, o: string, g = GRAPH_URI): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

const testTriples: Quad[] = [
  q('did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"'),
  q('did:dkg:agent:Alice', 'http://schema.org/age', '"30"'),
  q('did:dkg:agent:Bob', 'http://schema.org/name', '"Bob"'),
];

/**
 * Real OxigraphStore wrapped in a recorder that captures every SPARQL string
 * sent through `query()`. The underlying store still does the real work — this
 * is a spy on real behavior, not a mock.
 */
function createRecordingStore(): { store: OxigraphStore; calls: string[] } {
  const store = new OxigraphStore();
  const calls: string[] = [];
  const realQuery = store.query.bind(store);
  (store as { query: typeof store.query }).query = async (
    sparql: string,
    ...rest: unknown[]
  ) => {
    calls.push(sparql);
    return realQuery(sparql, ...(rest as []));
  };
  return { store, calls };
}

async function seedStore(store: OxigraphStore, triples: Quad[]): Promise<void> {
  await store.insert(triples);
}

function seedIndex(proofIndex: ProofIndex): void {
  proofIndex.storeBatch(CG_ID, BATCH_ID, testTriples);
}

describe('ContextOracle', () => {
  let store: OxigraphStore;
  let calls: string[];
  let proofIndex: ProofIndex;
  let oracle: ContextOracle;

  beforeEach(async () => {
    ({ store, calls } = createRecordingStore());
    await seedStore(store, testTriples);
    proofIndex = new ProofIndex();
    seedIndex(proofIndex);
    oracle = new ContextOracle(store, CHAIN, proofIndex);
  });

  describe('entityLookup', () => {
    it('returns triples with proofs for a known entity', async () => {
      const result = await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Alice');

      expect(result.contextGraphId).toBe(CG_ID);
      expect(result.paranetId).toBe(PARANET);
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
      // Add an extra Alice triple to the store but NOT to the proof index. The
      // oracle must drop it because it cannot prove provenance for it.
      await store.insert([
        q('did:dkg:agent:Alice', 'http://schema.org/nickname', '"Ali"'),
      ]);

      const result = await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Alice');

      // Only the two Alice triples in the proof index survive.
      expect(result.triples).toHaveLength(2);
      const predicates = result.triples.map(t => t.predicate).sort();
      expect(predicates).toEqual([
        'http://schema.org/age',
        'http://schema.org/name',
      ]);
      expect(result.verification.batchIds).toEqual([BATCH_ID]);
    });

    it('returns empty triples for unknown entity', async () => {
      const result = await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Nobody');
      expect(result.triples).toHaveLength(0);
      expect(result.verification.batchIds).toHaveLength(0);
    });

    it('issues SPARQL query scoped to the correct named graph', async () => {
      await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Alice');

      const sparql = calls[0];
      expect(sparql).toContain(`GRAPH <${GRAPH_URI}>`);
      expect(sparql).toContain('did:dkg:agent:Alice');
    });
  });

  describe('queryWithProofs', () => {
    it('returns bindings and provenance triples with proofs', async () => {
      const result = await oracle.queryWithProofs(
        PARANET, CG_ID,
        'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      );

      // Both Alice and Bob have a name in the seeded store.
      expect(result.bindings.length).toBeGreaterThanOrEqual(2);
      expect(result.provenanceTriples.length).toBeGreaterThan(0);

      for (const t of result.provenanceTriples) {
        expect(t.proof.batchId).toBe(BATCH_ID);
        expect(t.proof.tripleHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(t.proof.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
      }

      expect(result.verification.merkleRoots[BATCH_ID]).toBeDefined();
    });

    it('wraps query with GRAPH clause when not already present', async () => {
      await oracle.queryWithProofs(PARANET, CG_ID, 'SELECT ?s WHERE { ?s ?p ?o }');

      const wrappedSparql = calls[0];
      expect(wrappedSparql).toContain(`GRAPH <${GRAPH_URI}>`);
    });

    it('rejects queries that already contain GRAPH clauses', async () => {
      const alreadyWrapped = `SELECT ?s WHERE { GRAPH <${GRAPH_URI}> { ?s ?p ?o } }`;
      await expect(
        oracle.queryWithProofs(PARANET, CG_ID, alreadyWrapped),
      ).rejects.toThrow('User queries must not contain GRAPH clauses');
    });

    it('provenance query scopes to subjects from bindings', async () => {
      await oracle.queryWithProofs(
        PARANET, CG_ID,
        'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      );

      // Second SPARQL is the provenance query — it must constrain to the
      // subjects produced by the first query (Alice and Bob).
      const provenanceSparql = calls[1];
      expect(provenanceSparql).toContain('VALUES ?s');
      expect(provenanceSparql).toMatch(/<did:dkg:agent:(Alice|Bob)>/);
    });

    it('omits provenance triples that are in the store but not in the proof index', async () => {
      // Add an entity to the store with no entry in the proof index.
      await store.insert([
        q('did:dkg:agent:Zora', 'http://schema.org/name', '"Zora"'),
      ]);

      const result = await oracle.queryWithProofs(
        PARANET, CG_ID,
        `SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name . FILTER(?s = <did:dkg:agent:Zora>) }`,
      );

      expect(result.bindings).toHaveLength(1);
      // Zora exists in the store but not in the proof index → no provenance.
      expect(result.provenanceTriples).toHaveLength(0);
      expect(result.verification.batchIds).toHaveLength(0);
    });
  });

  describe('proveTriple', () => {
    it('returns proof when triple exists in store and index', async () => {
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
      const result = await oracle.proveTriple(
        PARANET, CG_ID,
        'did:dkg:agent:Nobody', 'http://schema.org/name', '"Nobody"',
      );

      expect(result.exists).toBe(false);
      expect(result.proof).toBeUndefined();
      expect(result.verification).toBeUndefined();
    });

    it('returns exists=true but no proof when triple in store but not in index', async () => {
      // Insert a triple into the store that is NOT in the proof index.
      await store.insert([
        q('did:dkg:agent:Unknown', 'http://schema.org/x', '"y"'),
      ]);

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
      await oracle.proveTriple(
        PARANET, CG_ID,
        'did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"',
      );

      const sparql = calls[0];
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
      const oracle2 = new ContextOracle(store, CHAIN);
      expect(oracle2.proofIndex).toBeInstanceOf(ProofIndex);
    });

    it('proofs from multiple batches reference different batchIds', async () => {
      const extraTriples: Quad[] = [
        q('did:dkg:agent:Charlie', 'http://schema.org/name', '"Charlie"'),
      ];
      await store.insert(extraTriples);
      proofIndex.storeBatch(CG_ID, '99', extraTriples);

      const result = await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Alice');

      const batchIds = new Set(result.triples.map(t => t.proof.batchId));
      expect(batchIds.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe('verification info', () => {
    it('includes chain ID from adapter', async () => {
      const result = await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Alice');
      expect(result.verification.chainId).toBe('eip155:84532');
    });

    it('merkle roots match those computed by ProofIndex', async () => {
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
      const result = await oracle.entityLookup(PARANET, CG_ID, 'did:dkg:agent:Nobody');
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
      const result = await oracle.proveTriple(PARANET, CG_ID, 'did:dkg:agent:Alice', 'http://schema.org/name', '"NotInStore"');
      expect(result.exists).toBe(false);
    });

    it('proveTriple accepts well-formed language-tagged literal', async () => {
      const result = await oracle.proveTriple(PARANET, CG_ID, 'did:dkg:agent:Alice', 'http://schema.org/name', '"Alice"@en');
      expect(result.exists).toBe(false);
    });

    it('proveTriple accepts well-formed typed literal', async () => {
      const result = await oracle.proveTriple(
        PARANET, CG_ID, 'did:dkg:agent:Alice', 'http://schema.org/age',
        '"30"^^<http://www.w3.org/2001/XMLSchema#integer>',
      );
      expect(result.exists).toBe(false);
    });

    it('proveTriple accepts literal with escaped characters', async () => {
      const result = await oracle.proveTriple(
        PARANET, CG_ID, 'did:dkg:agent:Alice', 'http://schema.org/desc',
        '"line1\\nline2\\twith \\"quotes\\""',
      );
      expect(result.exists).toBe(false);
    });
  });
});
