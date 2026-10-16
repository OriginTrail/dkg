// The context graphs of the one-graph promotion suite
// (scripts/devnet-test-one-graph-promotion.mjs): created and registered on
// chain by the curator, with the named sub-graph the reports go to, and
// subscribed to by the other Edges; and the large graph of the busy-slot case,
// whose assets the curator publishes to Verified Memory.

import { brief } from '../member-sharing/devnet.mjs';
import { promotionOutcome } from '../qa/one-graph-promotion.mjs';

/** `say` prints a line of the run. */
export function createGraphs(devnet, { stamp, say }) {
  const { api } = devnet;

  /**
   * A public graph of the curator's, registered on chain with `publishPolicy`
   * (0 is curated: only the curator publishes to its Verified Memory; anyone
   * may write its shared memory, which follows the access policy alone), and
   * its sub-graph `sub` when one is named. Returns { key, id, resolved (the id
   * the node resolved, which its partitions' graph names are built from),
   * registered, onChainId }.
   */
  async function createGraph(curator, key, { publishPolicy, sub }) {
    const id = `${curator.agentAddress}/one-graph-${key}-${stamp}`;
    const created = await api(curator, 'POST', '/api/context-graph/create',
      { id, name: `one graph ${key}`, accessPolicy: 0, publishPolicy, register: true }, { timeoutMs: 180_000 });
    if (created.json?.created !== id) throw new Error(`graph ${key} was not created: ${brief(created)}`);
    if (created.json?.registered !== true) throw new Error(`graph ${key} was not registered on chain: ${brief(created)}`);
    let resolved = id;
    if (sub) {
      const made = await api(curator, 'POST', '/api/sub-graph/create', { contextGraphId: id, subGraphName: sub }, { timeoutMs: 120_000 });
      if (made.json?.created !== sub) throw new Error(`the sub-graph ${sub} of ${key} was not created: ${brief(made)}`);
      if (typeof made.json?.contextGraphId === 'string' && made.json.contextGraphId) resolved = made.json.contextGraphId;
    }
    say(`graph ${key}: ${id} (registered, on-chain id ${created.json.onChainId ?? 'not named'}, publish policy ${publishPolicy === 0 ? 'curated' : 'open'}${sub ? `, sub-graph ${sub}` : ''})`);
    return { key, id, resolved, registered: true, onChainId: created.json.onChainId ?? null };
  }

  /** An Edge subscribes to a public graph with its shared memory, as a client does; resolves to when. */
  async function subscribe(node, graph) {
    const answer = await api(node, 'POST', '/api/context-graph/subscribe', { contextGraphId: graph.id, includeSharedMemory: true });
    if (answer.status !== 200) throw new Error(`${node.label} could not subscribe to ${graph.key}: ${brief(answer)}`);
    return Date.now();
  }

  /**
   * The large graph's Verified Memory: `assets` assets of `triples` triples,
   * each over 50 subjects with an equal share of them and about 100 bytes a
   * value, written and shared by the curator and published by it, one by one.
   * `io` is createReports' (for its client-like write). Resolves to the
   * seconds it took.
   */
  async function fillLargeGraph(io, curator, graph, { assets, triples }) {
    const started = Date.now();
    const perSubject = Math.max(1, Math.ceil(triples / 50));
    for (let i = 0; i < assets; i++) {
      const name = `og-large-${stamp.toLowerCase()}-${i}`;
      const quads = Array.from({ length: triples }, (_, t) => ({
        subject: `urn:one-graph:large:${stamp}:${i}:${Math.floor(t / perSubject)}`, predicate: `urn:one-graph:payload:${t % perSubject}`,
        object: `"row ${t} of asset ${i} ${'x'.repeat(80)}"`, graph: '',
      }));
      const shared = await io.createAndShare(curator, { contextGraphId: graph.id, name, quads }, { createTimeoutMs: 300_000, jobTimeoutMs: 300_000, pollMs: 2000 });
      if (shared.error) throw new Error(`asset ${i} of the large graph was not shared: ${shared.error}`);
      const answer = await api(curator, 'POST', `/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`, { contextGraphId: graph.id }, { timeoutMs: 300_000 });
      const published = promotionOutcome(answer, { authorAddress: curator.agentAddress });
      if (!published.ok) throw new Error(`asset ${i} of the large graph was not published: ${published.why}`);
    }
    return Math.round((Date.now() - started) / 1000);
  }

  return { createGraph, subscribe, fillLargeGraph };
}
