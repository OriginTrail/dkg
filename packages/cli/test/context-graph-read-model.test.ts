import type { SettledContextGraphReadAuthorityDecision } from '../../agent/src/context-graph-read-authority.js';
import { markCoreTrustedGraph } from '../../agent/src/public-snapshot-evidence.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { describe, expect, it, vi } from 'vitest';
import { DKGQueryEngine } from '../../query/src/dkg-query-engine.js';
import { ContextGraphPartitionQueryMethods } from '../../agent/src/internal/context-graph-partition-query.js';
const authorityDecision = (allowed: boolean): SettledContextGraphReadAuthorityDecision => ({
  source: 'registered-chain', reason: 'test-authority', metadataBootstrap: 'forbidden',
  ...(allowed ? { outcome: 'allowed', grantScope: 'caller' } : { outcome: 'denied', grantScope: 'none' }),
});
const CG = 'large-cg';
const ROOT = `did:dkg:context-graph:${CG}`;
describe('context-graph exact stats read model', () => {
  it.each([false, true])('gates catalog SWM graph counts through canonical shared-memory authority (%s)', async allowed => {
    const store = new OxigraphStore();
    const catalogGraph = `${ROOT}/meta/_shared_memory/0xabc/1`;
    try {
      await store.insert([
        { subject: `${ROOT}/meta`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: `${ROOT}/_meta` },
        { subject: `${ROOT}/meta`, predicate: 'http://schema.org/name', object: '"meta"', graph: `${ROOT}/_meta` },
        { subject: 'urn:catalog', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/profile/QueryCatalog', graph: catalogGraph },
        { subject: 'urn:ordinary', predicate: 'urn:p', object: 'urn:o', graph: ROOT },
      ]);
      const queryEngine = new DKGQueryEngine(store);
      const sharedGate = vi.fn(async () => ({ outcome: allowed ? 'allowed' : 'denied' }));
      const agent = { store, log: { info() {} }, queryEngine,
        resolveContextGraphReadAuthority: async () => authorityDecision(true),
        resolveSharedMemoryReadAdmission: sharedGate };
      const stats = await ContextGraphPartitionQueryMethods.prototype.readContextGraphNamedGraphStats.call(agent as never, CG,
        { source: 'changed-diagnostic-label', callerAgentAddress: '0xpublic-reader' });
      expect(stats.find(row => row.graph === ROOT)).toMatchObject({ tripleCount: 1 });
      expect(sharedGate).toHaveBeenCalled();
      expect(stats.find(row => row.graph === catalogGraph)?.tripleCount ?? 0).toBe(allowed ? 1 : 0);
    } finally { await store.close(); }
  });


});


it.each(['revoked', 'marked-before', 'marked-during', 'aborted'] as const)('retains typed statistics admission and trust on %s', async mode => {
  const store = new OxigraphStore();
  const controller = new AbortController();
  try {
    await store.insert([{ graph: ROOT, subject: 'urn:s', predicate: 'urn:p', object: '"v"' }]);
    if (mode === 'marked-before') await markCoreTrustedGraph(store, CG);
    const authority = vi.fn(async () => authorityDecision(true));
    if (mode === 'revoked') authority.mockResolvedValueOnce(authorityDecision(true)).mockResolvedValue(authorityDecision(false));
    const query = store.query.bind(store);
    const spy = vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
      const result = await query(sparql, options);
      if (sparql.startsWith('SELECT ?g (COUNT')) {
        if (mode === 'marked-during') await markCoreTrustedGraph(store, CG);
        if (mode === 'aborted') controller.abort(new Error('cancel statistics'));
      }
      return result;
    });
    const agent = { store, queryEngine: new DKGQueryEngine(store), resolveContextGraphReadAuthority: authority };
    const read = ContextGraphPartitionQueryMethods.prototype.readContextGraphNamedGraphStats.call(agent as never, CG,
      { callerAgentAddress: 'alice', signal: controller.signal });
    if (mode === 'revoked') {
      await expect(read).resolves.toEqual([]);
      expect(authority).toHaveBeenCalledTimes(2);
      expect(await authority.mock.results[0]!.value).toMatchObject({ outcome: 'allowed', grantScope: 'caller' });
      expect(spy.mock.calls.some(([sparql]) => sparql.startsWith('SELECT ?g (COUNT'))).toBe(false);
    } else if (mode === 'aborted') await expect(read).rejects.toThrow('cancel statistics');
    else await expect(read).rejects.toMatchObject({ code: 'CORE_CACHE_QUERY_TRUST_REQUIRED' });
    expect(authority).toHaveBeenCalledWith(CG, expect.objectContaining({ callerAgentAddress: 'alice', signal: controller.signal }));
  } finally { await store.close(); }
});
