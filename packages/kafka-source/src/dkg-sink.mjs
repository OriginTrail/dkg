import { content } from './asset.mjs';

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
      const graphs = await request('GET', '/api/context-graph/list');
      const graph = graphs?.contextGraphs?.find(graph => graph.id === source.contextGraphId);
      if (!graph || !['private', 1].includes(graph.accessPolicy)) throw new Error('DKG_PRIVATE_GRAPH_REQUIRED');
      const path = `/api/knowledge-assets/${encodeURIComponent(asset.name)}/wm`;
      const params = new URLSearchParams({ contextGraphId: source.contextGraphId, agentAddress: source.agentAddress });
      async function read() {
        const status = await request('GET', `${path}?${params}`);
        if (!status) return null;
        if (status.contextGraphId !== source.contextGraphId ||
          status.agentAddress?.toLowerCase() !== source.agentAddress.toLowerCase() ||
          status.name !== asset.name || status.status !== 'wm-sealed' || !status.wmCurrentAssertion ||
          status.swmCurrentAssertion || status.vmCurrentAssertion) throw new Error('DKG_PRIVATE_SEAL_REQUIRED');
        const graphPrefix = `did:dkg:context-graph:${source.contextGraphId}/_working_memory/${source.agentAddress.toLowerCase()}/`;
        if (!status.assertionGraph?.startsWith(graphPrefix) || /[\s<>"{}|\\^`]/.test(status.assertionGraph))
          throw new Error('DKG_ASSERTION_GRAPH_MISMATCH');
        // /wm/quads reads the mutable draft, which is empty after sealing.
        // Verify the immutable graph named by the native sealed descriptor.
        const data = await request('POST', '/api/query', {
          contextGraphId: source.contextGraphId, agentAddress: source.agentAddress,
          view: 'working-memory', includeContextGraphPartitions: true,
          sparql: `CONSTRUCT { <${asset.subject}> ?p ?o } WHERE { GRAPH <${status.assertionGraph}> { <${asset.subject}> ?p ?o } } LIMIT ${asset.quads.length + 1}`,
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
      const rejection = journal.rejection(record.position);
      if (rejection?.retryAt > Date.now()) {
        const error = new Error('DKG_RETRY_LATER');
        error.retryAt = rejection.retryAt;
        throw error;
      }
      journal.intent(record.position);
      let failure;
      try {
        await request('POST', '/api/knowledge-assets', {
          contextGraphId: source.contextGraphId, name: asset.name, quads: asset.quads,
          finalize: true, alsoShareSwm: false, alsoPublishVm: false,
        });
      } catch (error) {
        journal.writeFailed(record.position, error);
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
