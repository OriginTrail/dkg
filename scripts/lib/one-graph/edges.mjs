// The temporary Edges of the one-graph promotion suite
// (scripts/devnet-test-one-graph-promotion.mjs): four Edges on the profile of
// profile.mjs, each reachable through relays only. They are the member-sharing
// suite's TemporaryEdges (node numbers, start, stop, the mark of a node of its
// own, the reclaiming of a killed run's nodes, the cleanup) with other roles
// and another topology:
//
//   curator  creates and registers the graph, and promotes reports
//   edgeA    writes reports
//   edgeB    writes reports; its only sync slot is held by a large transfer
//   late     starts and subscribes late in the run
//
// Every Edge reserves a slot on both relays (node 1 and node 2) and announces
// only its circuit addresses through them, so Edges reach each other through
// a relay; they dial the Cores directly, as an Edge behind NAT reaches the
// public nodes. A node record has the fields TemporaryEdges documents.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_CANDIDATES, TemporaryEdges } from '../member-sharing/temporary-edges.mjs';
import { connectionsObservation } from '../qa/member-sharing.mjs';
import { edgeTopologyProblems } from '../qa/one-graph-promotion.mjs';
import { edgeEnv, edgeOverrides } from './profile.mjs';

export const ROLES = Object.freeze(['curator', 'edgeA', 'edgeB', 'late']);

export class OneGraphEdges extends TemporaryEdges {
  constructor(devnet, options) {
    super(devnet, options);
    this.curator = null;
    this.edgeA = null;
    this.edgeB = null;
    this.late = null;
  }

  /** Every Edge of the run, started or not. */
  get nodes() { return [this.curator, this.edgeA, this.edgeB, this.late].filter(Boolean); }
  /** The Edges that are not the curator. */
  get members() { return [this.edgeA, this.edgeB, this.late].filter(Boolean); }
  /** The Edges this run has started so far. */
  get running() { return this.nodes.filter(node => this.started.includes(node)); }

  /**
   * The four Edges: the first four free numbers of 7, 8, 9, 10, or the four of
   * `explicit` (all free). Each runs the profile, with `relays` (node 1's and
   * node 2's multiaddrs) as its relays. Returns { taken } or { problem }.
   */
  allocate({ explicit, relays }) {
    const candidates = explicit ? explicit.split(',').map(Number) : NODE_CANDIDATES;
    const free = [];
    const taken = [];
    for (const number of candidates) {
      const why = this.slotTaken(number);
      if (why) taken.push(`node${number}: ${why}`);
      else free.push(number);
    }
    if (explicit ? taken.length > 0 || free.length !== ROLES.length : free.length < ROLES.length) {
      return { problem: `no ${ROLES.length} free node numbers among ${candidates.join(', ')} (${taken.join('; ') || `the list must name ${ROLES.length}`})` };
    }
    const overrides = edgeOverrides(relays);
    const env = edgeEnv();
    [this.curator, this.edgeA, this.edgeB, this.late] = ROLES.map((role, i) => ({
      number: free[i], role, member: role !== 'curator', subject: role === 'curator' ? 'the curator' : role,
      label: `node${free[i]} (${role})`, relay: relays[0], overrides, env, peerId: null, agentAddress: null,
    }));
    // The member-sharing helpers (dialOwner) name the graph's owner so.
    this.owner = this.curator;
    return { taken };
  }

  /** The devnet's Cores, from its files: a Core that does not answer stays in the list. */
  coreNumbers() {
    return this.devnet.nodeNumbers()
      .filter(number => !this.isTemporary(number) && this.devnet.nodeConfig(number)?.nodeRole === 'core')
      .sort((a, b) => a - b);
  }

  /**
   * The topology every conclusion rests on, from one reading of each running
   * Edge's connections, all at once (edgeTopologyProblems). Returns {
   * problems, relayedPairs }.
   */
  async topologyProblems() {
    const edges = this.running;
    const answers = await Promise.all(edges.map(node => this.devnet.api(node, 'GET', '/api/connections')));
    const observations = new Map(edges.map((node, i) => [node.number, connectionsObservation(answers[i].status, answers[i].json)]));
    const corePeers = new Set(this.coreNumbers().map(number => this.devnet.multiaddrOf(number).split('/p2p/').at(-1)).filter(Boolean));
    return edgeTopologyProblems({ observations, edges, corePeers, known: await this.devnetPeers() });
  }

  /**
   * The logs of a failing run, kept before the cleanup removes the Edges:
   * each Edge's whole log, and the part of every other node's log written
   * since the run began (`offsets`: node number -> log size then), which the
   * next devnet start would wipe. Returns the folder, or null.
   */
  keepLogs(offsets) {
    const kept = join(this.devnet.dir, 'one-graph-promotion', this.stamp);
    const ensure = () => mkdirSync(kept, { recursive: true });
    for (const node of this.started) {
      if (!existsSync(this.devnet.logFile(node))) continue;
      ensure();
      copyFileSync(this.devnet.logFile(node), join(kept, `node${node.number}-${node.role}.daemon.log`));
    }
    for (const [number, offset] of offsets) {
      if (this.isTemporary(number)) continue;
      const text = this.devnet.logSince(number, offset);
      if (!text) continue;
      ensure();
      writeFileSync(join(kept, `node${number}.daemon-since-run.log`), text);
    }
    return existsSync(kept) ? kept : null;
  }

  /** The cleanup of TemporaryEdges, after the logs of a failing run are kept here. */
  cleanup({ keep, failed, offsets = new Map() }) {
    if (failed) {
      const kept = this.keepLogs(offsets);
      if (kept) this.log.say(`kept the logs of the failing run in ${kept}`);
    }
    super.cleanup({ keep, failed: false });
  }
}
