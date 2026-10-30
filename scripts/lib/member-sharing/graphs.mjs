// The context graphs of the issue-3251 member-sharing suite
// (scripts/devnet-test-issue-3251-member-sharing.mjs): created by the owner
// with a named sub-graph, kept away from the Cores where the topology needs
// it, and joined by the members (a public graph by subscribing, a private one
// through the signed request flow first).

import { brief, waitFor } from './devnet.mjs';
import { subscriptionState } from '../qa/context-graph-listing.mjs';

/** `edges` is the TemporaryEdges fixture; `say` prints a line of the run. */
export function createGraphs(devnet, edges, { stamp, sub, say }) {
  const { api } = devnet;

  // The Cores come from the devnet's files, not from API answers: a Core that
  // does not answer must not drop out of the list.
  const coreNodes = () => devnet.nodeNumbers()
    .filter(number => !edges.isTemporary(number))
    .filter(number => devnet.nodeConfig(number)?.nodeRole === 'core')
    .sort((a, b) => a - b);

  /**
   * A graph of the owner's (or of `by`), with its sub-graph: { key, id,
   * resolved, private (its access policy), registered (on chain, as the node
   * answered) }.
   */
  async function createGraph(key, body, { by = edges.owner } = {}) {
    const id = `${by.agentAddress}/issue-3251-${key}-${stamp}`;
    const created = await api(by, 'POST', '/api/context-graph/create', { id, name: `issue 3251 ${key}`, ...body }, { timeoutMs: 180_000 });
    if (created.json?.created !== id) throw new Error(`graph ${key} was not created: ${brief(created)}`);
    if (body.register && created.json?.registered !== true) throw new Error(`graph ${key} was not registered: ${brief(created)}`);
    const made = await api(by, 'POST', '/api/sub-graph/create', { contextGraphId: id, subGraphName: sub }, { timeoutMs: 120_000 });
    if (made.json?.created !== sub) throw new Error(`the sub-graph of ${key} was not created: ${brief(made)}`);
    // The graph names of its partitions are built from the id the node resolved.
    const resolved = typeof made.json?.contextGraphId === 'string' && made.json.contextGraphId ? made.json.contextGraphId : id;
    say(`graph ${key}: ${id}${created.json?.onChainId ? ` (registered, id ${created.json.onChainId})` : ''}${resolved !== id ? ` resolved as ${resolved}` : ''}`);
    return { key, id, resolved, private: body.accessPolicy === 1, registered: created.json?.registered === true };
  }

  /** A Core subscribes and unsubscribes at once; discovery does not re-activate an ended subscription. */
  async function keepCoresOut(graph) {
    for (const core of coreNodes()) {
      const subscribed = await waitFor(async () => {
        const answer = await api(core, 'POST', '/api/context-graph/subscribe', { contextGraphId: graph.id });
        return { ok: answer.status === 200, why: brief(answer) };
      }, 90_000, 2000);
      if (!subscribed.ok) throw new Error(`Core node${core} could not be kept out of ${graph.key} (subscribe): ${subscribed.why}`);
      const ended = await api(core, 'POST', '/api/context-graph/unsubscribe', { contextGraphId: graph.id });
      if (ended.status !== 200) throw new Error(`Core node${core} could not be kept out of ${graph.key} (unsubscribe): ${brief(ended)}`);
    }
  }

  /** Every Core must say it does not follow the graph; one that cannot be asked has said nothing. */
  async function coresFollowing(graph) {
    const following = [];
    const unknown = [];
    for (const core of coreNodes()) {
      const answer = await api(core, 'GET', '/api/context-graph/list');
      const state = subscriptionState(answer.status, answer.text, graph.id);
      if (state.state === 'following') following.push(`node${core}`);
      else if (state.state !== 'not-following') unknown.push(`node${core} (${state.reason ?? state.state})`);
    }
    return { following, unknown };
  }

  /**
   * A public graph: subscribe. A private one: the signed request flow first,
   * with the member's own agent token. Resolves to when it subscribed.
   */
  async function subscribe(node, graph) {
    if (graph.private) {
      const token = edges.agentToken(node);
      if (!token) throw new Error(`${node.label} has no agent token for the private graph`);
      const encoded = encodeURIComponent(graph.id);
      const signed = await api(node, 'POST', `/api/context-graph/${encoded}/sign-join`, {}, { token });
      if (signed.json?.ok !== true || !signed.json?.delegation) throw new Error(`${node.label} could not sign its join: ${brief(signed)}`);
      const body = { delegation: signed.json.delegation, curatorPeerId: edges.owner.peerId, agentName: node.role };
      const joined = await waitFor(async () => {
        const answer = await api(node, 'POST', `/api/context-graph/${encoded}/request-join`, body, { token });
        const ok = ['approved', 'already-member'].includes(answer.json?.status) && ['1', 'local'].includes(String(answer.json?.delivered));
        return { ok, why: brief(answer) };
      }, 90_000, 15_000);
      if (!joined.ok) throw new Error(`${node.label} did not join the private graph: ${joined.why}`);
      const ready = await waitFor(async () => {
        const answer = await api(node, 'GET', `/api/context-graph/${encoded}/participants`, undefined, { token });
        const agents = Array.isArray(answer.json?.allowedAgents) ? answer.json.allowedAgents : [];
        return { ok: agents.some(a => typeof a === 'string' && a.toLowerCase() === node.agentAddress.toLowerCase()), why: brief(answer) };
      }, 120_000, 2000);
      if (!ready.ok) throw new Error(`${node.label} never saw itself among the participants: ${ready.why}`);
      const answer = await api(node, 'POST', '/api/subscribe', { contextGraphId: graph.id, includeSharedMemory: true }, { token });
      if (answer.status !== 200) throw new Error(`${node.label} could not subscribe to ${graph.key}: ${brief(answer)}`);
    } else {
      const answer = await api(node, 'POST', '/api/context-graph/subscribe', { contextGraphId: graph.id, includeSharedMemory: true });
      if (answer.status !== 200) throw new Error(`${node.label} could not subscribe to ${graph.key}: ${brief(answer)}`);
    }
    return Date.now();
  }

  /** Whether a node follows a graph, by its own listing: { state: 'following' | 'not-following' | …, reason }. */
  async function following(node, graph) {
    const answer = await api(node, 'GET', '/api/context-graph/list');
    const seen = subscriptionState(answer.status, answer.text, graph.id);
    return seen.state === 'unknown' && answer.status !== 200 && answer.status !== 0 ? { ...seen, reason: brief(answer) } : seen;
  }

  /** A node stops following a graph; what it holds of it stays. */
  async function unsubscribe(node, graph) {
    const answer = await api(node, 'POST', '/api/context-graph/unsubscribe', { contextGraphId: graph.id });
    if (answer.status !== 200) throw new Error(`${node.label} could not unsubscribe from ${graph.key}: ${brief(answer)}`);
  }

  return { coreNodes, createGraph, keepCoresOut, coresFollowing, following, subscribe, unsubscribe };
}
