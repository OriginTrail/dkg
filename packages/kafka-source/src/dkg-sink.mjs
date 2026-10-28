import { contextGraphLayerPrefixCandidates, MemoryLayer, isSafeIri, sparqlIri } from '@origintrail-official/dkg-core';
import { content } from './asset.mjs';

function retryLater(retryAt) {
  const error = new Error('DKG_RETRY_LATER');
  error.retryAt = retryAt;
  return error;
}

export function createDkgSink(config, requestFetch = fetch) {
  const base = new URL(config.daemonUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
    throw new Error('DKG_HTTP_ENDPOINT_REQUIRED');
  const headers = { Authorization: `Bearer ${config.daemonToken}`, 'Content-Type': 'application/json' };
  async function request(method, path, body) {
    const response = await requestFetch(new URL(path, base), { method, headers,
      signal: AbortSignal.timeout(config.requestTimeoutMs ?? 20000), redirect: 'error',
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 404) return null;
    if (!response.ok) {
      const error = new Error(`DKG_HTTP_${response.status}`);
      error.status = response.status;
      // Only this exact daemon ingress rejection is known to precede mutation.
      // A generic 4xx/5xx or transport exception is still an uncertain write.
      const data = await response.json().catch(() => null);
      error.preMutation = response.status === 429 && data?.error === 'Too many requests';
      const after = response.headers.get('Retry-After');
      const delay = after === null ? 1000 : (/^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now());
      error.retryAt = Date.now() + Math.max(0, Number.isFinite(delay) ? delay : 1000);
      throw error;
    }
    return response.json();
  }
  return {
    async ensure(source, asset, record, journal) {
      const waitForCooldown = () => {
        // Retain deadlines from older journals as well as read-request waits.
        const rejection = !record.intent && journal.rejection(record.position);
        const retryAt = Math.max(journal.httpRetryAt() ?? 0, rejection?.retryAt ?? 0);
        if (retryAt > Date.now()) throw retryLater(retryAt);
      };
      async function readRequest(method, path, body) {
        waitForCooldown();
        try { return await request(method, path, body); }
        catch (error) {
          if (error.status !== 429) throw error;
          journal.deferHttp(error.retryAt);
          throw retryLater(error.retryAt);
        }
      }
      const graphs = await readRequest('GET', '/api/context-graph/list');
      const graph = graphs?.contextGraphs?.find(graph => graph.id === source.contextGraphId);
      if (!graph || !['private', 1].includes(graph.accessPolicy)) throw new Error('DKG_PRIVATE_GRAPH_REQUIRED');
      const path = `/api/knowledge-assets/${encodeURIComponent(asset.name)}/wm`;
      const params = new URLSearchParams({ contextGraphId: source.contextGraphId, agentAddress: source.agentAddress });
      async function read() {
        const status = await readRequest('GET', `${path}?${params}`);
        if (!status) return null;
        if (status.contextGraphId !== source.contextGraphId ||
          status.agentAddress?.toLowerCase() !== source.agentAddress.toLowerCase() ||
          status.name !== asset.name || status.status !== 'wm-sealed' || !status.wmCurrentAssertion ||
          status.swmCurrentAssertion || status.vmCurrentAssertion) throw new Error('DKG_PRIVATE_SEAL_REQUIRED');
        const [graphPrefix] = contextGraphLayerPrefixCandidates(source.contextGraphId, MemoryLayer.WorkingMemory, source.agentAddress);
        if (!isSafeIri(status.assertionGraph) || !status.assertionGraph.startsWith(graphPrefix))
          throw new Error('DKG_ASSERTION_GRAPH_MISMATCH');
        // /wm/quads reads the mutable draft, which is empty after sealing.
        // Verify the immutable graph named by the native sealed descriptor.
        const data = await readRequest('POST', '/api/query', {
          contextGraphId: source.contextGraphId, agentAddress: source.agentAddress,
          view: 'working-memory', includeContextGraphPartitions: true,
          sparql: `CONSTRUCT { ${sparqlIri(asset.subject)} ?p ?o } WHERE { GRAPH ${sparqlIri(status.assertionGraph)} { ${sparqlIri(asset.subject)} ?p ?o } } LIMIT ${asset.quads.length + 1}`,
        });
        // Current nodes return typed results; older V10 APIs return {quads,bindings}.
        if (!Array.isArray(data?.result?.quads) || (data.result.type && data.result.type !== 'quads') ||
          JSON.stringify(content(data.result.quads)) !== JSON.stringify(content(asset.quads)))
          throw new Error('DKG_READBACK_MISMATCH');
        return { name: asset.name, assertion: status.wmCurrentAssertion, assertionGraph: status.assertionGraph };
      }
      let receipt = await read();
      if (receipt) return { ...receipt, reused: true };
      // A previous request may still be executing. Never retry an ambiguous
      // create merely because the asset is not visible yet.
      if (record.intent) throw new Error('DKG_WRITE_OUTCOME_UNKNOWN');
      journal.intent(record.position);
      let failure;
      try {
        await request('POST', '/api/knowledge-assets', {
          contextGraphId: source.contextGraphId, name: asset.name, quads: asset.quads,
          finalize: true, alsoShareSwm: false, alsoPublishVm: false,
        });
      } catch (error) {
        journal.writeFailed(record.position, error);
        if (error.status === 429) journal.deferHttp(error.retryAt);
        if (error.preMutation) {
          journal.rejected(record.position, error.message, error.retryAt);
          throw error;
        }
        failure = error;
      }
      receipt = await read();
      if (!receipt) throw new Error(failure ? 'DKG_WRITE_OUTCOME_UNKNOWN' : 'DKG_SEALED_READBACK_MISSING', { cause: failure });
      return { ...receipt, reused: false };
    },
  };
}
