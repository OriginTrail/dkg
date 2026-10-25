// The temporary Edges of the issue-3251 member-sharing suite
// (scripts/devnet-test-issue-3251-member-sharing.mjs): which node numbers they
// take, how each starts, restarts and stops, who each is on the network, what
// the topology between them is, and the cleanup after them.
//
// Each node is an explicit record: { number, role ('owner' | 'member1' |
// 'member2' | 'feeder'), member (a member of the graphs), subject (how a
// sentence names it), label (`node<N> (<role>)`), relay (the relay a member
// dials the owner through, and the feeder's), overrides (its config from the
// first start), env (its daemon's environment), peerId, agentAddress };
// member 2's also `trace`, the file its node writes its sync admission trace
// to (DKG_SYNC_ADMISSION_TRACE). The feeder, when a fourth node number is
// free, holds the large graph of a later attempt of case 6 and serves it to
// member 2; it runs only while case 6 needs it, fresh for each attempt.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brief, lastLines, waitFor } from './devnet.mjs';
import { connectionsObservation, topologyProblems } from '../qa/member-sharing.mjs';

// devnet.sh addnode takes node numbers up to 10 (one Hardhat key each).
export const NODE_CANDIDATES = [7, 8, 9, 10];
// Nobody listens on the discard port: a dial of it is refused at once.
const DEAD_DIRECT_ADDRESS = '/ip4/127.0.0.1/tcp/9';
// Every node folder this suite creates carries this file, so that a later run
// can tell a node of its own (left by a run that was killed) from another
// suite's, and remove it. addnode writes it right after it created the folder,
// before the daemon starts, as `<run> <role> starting`; once the node is up it
// reads `<run> <role> started`.
const OWN_MARK = '.issue-3251-member-sharing';

export class TemporaryEdges {
  /** `log` is { say, note } of the report. */
  constructor(devnet, { stamp, log }) {
    this.devnet = devnet;
    this.stamp = stamp;
    this.log = log;
    this.owner = null;
    this.member1 = null;
    this.member2 = null;
    this.feeder = null;
    // Whether the feeder's process runs (from its start until a stop that
    // succeeded), and whether it is the author of the next large graph (from
    // member 2's dial until it is stopped).
    this.feederRunning = false;
    this.feederUp = false;
    // Every node this run added: the cleanup stops and removes these only.
    this.started = [];
    // The starts still running, each with what cancels it.
    this.pending = new Map();
  }

  get nodes() { return [this.owner, this.member1, this.member2]; }
  get members() { return [this.member1, this.member2]; }
  /** The node that writes case 6's next large graph: the feeder while it runs, else the owner. */
  get largeAuthor() { return this.feederUp ? this.feeder : this.owner; }
  /** Whether a node number is one of the temporary nodes. */
  isTemporary(number) { return [...this.nodes, this.feeder].some(node => node?.number === number); }

  /** The name of the file that marks a node folder as this suite's: a suite built on this class names its own, so that no suite takes another's nodes for its own. */
  get markName() { return OWN_MARK; }

  ownMark(number) { return join(this.devnet.nodeDir(number), this.markName); }

  /** Whether a node's folder carries this run's claim: addnode wrote it there, so this run created the folder. */
  claims(node) {
    try { return readFileSync(this.ownMark(node.number), 'utf8').startsWith(`${this.stamp} `); } catch { return false; }
  }

  /**
   * Stops a node of this suite and removes its folder, but only once nothing
   * listens on its ports any more: a worker that outlives its stop would write
   * the folder again and stay beside every later suite. Returns the problem, or
   * null.
   */
  removeOwnNode(number) {
    const { devnet } = this;
    devnet.devnetShSync(['stop-node', String(number)]);
    const end = Date.now() + 30_000;
    while (devnet.nodePorts(number).some(devnet.listening) && Date.now() < end) spawnSync('sleep', ['1']);
    const busy = devnet.nodePorts(number).filter(devnet.listening);
    if (busy.length) return `node${number} still listens on port(s) ${busy.join(', ')} after it was stopped; its folder is kept`;
    rmSync(devnet.nodeDir(number), { recursive: true, force: true });
    return null;
  }

  /** Nodes an earlier run of this suite left behind (it was killed, say): stopped and removed, so they cost no node number. */
  reclaimLeftovers() {
    for (const number of NODE_CANDIDATES) {
      if (!existsSync(this.ownMark(number))) continue;
      this.log.note(this.removeOwnNode(number) ?? `removed node${number}, left by an earlier run of this suite`);
    }
  }

  /** Why a node number cannot be used: its folder exists, or its API or libp2p port is in use. */
  slotTaken(number) {
    if (existsSync(this.devnet.nodeDir(number))) return 'its folder exists';
    for (const port of this.devnet.nodePorts(number)) {
      if (this.devnet.listening(port)) return `port ${port} is in use`;
    }
    return null;
  }

  /**
   * The temporary nodes: the first three free numbers of 7, 8, 9, 10 for the
   * owner and the members, and a fourth free one for the feeder; or the three
   * or four of `explicit` (MEMBER_SHARING_NODES), which must all be free.
   * Without a fourth number the owner holds the large graphs itself. An
   * earlier suite can leave a node folder or a running node behind; such a
   * number is left alone. Member 1 reserves on node 1 (`relay1`), member 2
   * and the feeder on node 2 (`relay2`), the owner on both. Returns { taken }
   * or { problem }.
   */
  allocate({ explicit, relay1, relay2 }) {
    const candidates = explicit ? explicit.split(',').map(Number) : NODE_CANDIDATES;
    const free = [];
    const taken = [];
    for (const number of candidates) {
      const why = this.slotTaken(number);
      if (why) taken.push(`node${number}: ${why}`);
      else free.push(number);
    }
    if (explicit ? taken.length > 0 || ![3, 4].includes(free.length) : free.length < 3) {
      return { problem: `no three free node numbers among ${candidates.join(', ')} (${taken.join('; ') || 'MEMBER_SHARING_NODES must name three or four'})` };
    }
    const [owner, member1, member2, feeder] = free;
    const record = (number, role, subject, relay, overrides, env = {}) => ({
      number, role, member: role.startsWith('member'), subject, label: `node${number} (${role})`, relay, overrides, env, peerId: null, agentAddress: null,
    });
    // Reachable through relays only: the owner through node 1 and node 2, member 1
    // through node 1 (the devnet's relay for an Edge), member 2 through node 2.
    this.owner = record(owner, 'owner', 'the owner', null,
      { preferredRelays: [relay2], announceAddresses: [DEAD_DIRECT_ADDRESS, `${relay1}/p2p-circuit`, `${relay2}/p2p-circuit`] });
    this.member1 = record(member1, 'member1', 'member1', relay1,
      { relay: relay1, announceAddresses: [DEAD_DIRECT_ADDRESS, `${relay1}/p2p-circuit`] });
    // Member 2's sync policy comes from its config (one slot, no queue), but the
    // sync environment variables override a node's config; one inherited from
    // the caller (DKG_SYNC_GLOBAL_MAX_INFLIGHT=8, say) would give it spare
    // slots. So they are pinned to its policy.
    // Case 6 needs to know which admission holds its slot, and when: the node
    // writes its admission trace into its folder. Its catch-up asks one peer at
    // a time, so that the large graph's transfer from the node that holds it
    // is the pull that takes its general slot (busy-member.mjs).
    const trace = join(this.devnet.nodeDir(member2), 'sync-admissions.jsonl');
    this.member2 = {
      ...record(member2, 'member2', 'member2', relay2,
        { relay: relay2, announceAddresses: [DEAD_DIRECT_ADDRESS, `${relay2}/p2p-circuit`], syncGlobalMaxInflight: 1, syncGlobalQueueLimit: 0 },
        {
          DKG_SYNC_GLOBAL_MAX_INFLIGHT: '1', DKG_SYNC_GLOBAL_LIMIT: '1', DKG_SYNC_GLOBAL_QUEUE_LIMIT: '0', DKG_SYNC_ADMISSION_TRACE: trace,
          DKG_CATCHUP_MAX_CONCURRENT_PEERS: '1',
        }),
      trace,
    };
    // The large graphs of case 6's later attempts come from the feeder, which
    // member 2 reaches the way it reaches the owner: through node 2. A node
    // writes more slowly the more it holds, and the owner's writes are among
    // those case 6 waits for, so another large graph does not go to the owner
    // when a feeder can take it.
    this.feeder = feeder === undefined ? null
      : record(feeder, 'feeder', 'the feeder', relay2, { relay: relay2, announceAddresses: [DEAD_DIRECT_ADDRESS, `${relay2}/p2p-circuit`] });
    return { taken };
  }

  /**
   * Starts the feeder and has member 2 dial it; throws when either fails. A
   * feeder member 2 cannot dial is stopped again (feederRunning says whether
   * that worked); the cleanup removes it either way.
   */
  async startFeeder() {
    await this.start(this.feeder);
    this.feederRunning = true;
    try {
      await this.dial(this.member2, this.feeder);
    } catch (error) {
      await this.stopFeeder().catch(() => {});
      throw error;
    }
    this.feederUp = true;
  }

  /**
   * Replaces the feeder with a fresh one on the same number: the one that ran
   * is stopped and its folder removed, with all it held, and a new one starts
   * (startFeeder). A node writes more slowly the more it holds, and its store
   * stalls under the large graphs of several attempts, so each later attempt
   * gets a feeder that holds nothing yet. Throws when it cannot be removed or
   * started.
   */
  async renewFeeder() {
    const { feeder } = this;
    await this.stopFeeder();
    if (existsSync(this.devnet.nodeDir(feeder.number))) {
      const problem = this.removeOwnNode(feeder.number);
      if (problem) throw new Error(problem);
    }
    // Without its folder the number is free again: another suite may take it
    // before the new feeder's addnode does, and the cleanup must not remove
    // that suite's node. start() records the new feeder once its addnode has
    // claimed the folder.
    this.started = this.started.filter(node => node !== feeder);
    feeder.peerId = null;
    feeder.agentAddress = null;
    await this.startFeeder();
  }

  /**
   * Stops a running feeder, so that the cases after case 6 run with the owner
   * and the members alone. A stop that fails leaves it marked running, and
   * stopFeeder may be called again.
   */
  async stopFeeder() {
    if (!this.feederRunning) return;
    await this.stop(this.feeder);
    this.feederRunning = false;
    this.feederUp = false;
  }

  /**
   * Adds a node with its overrides in place from the first start, and learns
   * who it is. The node is this run's only when this run's addnode created its
   * folder: addnode claims the folder with one mkdir and writes this run's
   * mark into it before the daemon starts, and it never touches a folder that
   * exists. A node whose folder carries the mark is kept for the cleanup, also
   * when its start failed or is interrupted; any other folder (a number
   * another suite took after it was picked) is left as it is.
   */
  async start(node) {
    if (existsSync(this.devnet.nodeDir(node))) {
      throw new Error(`node${node.number} was taken after it was picked: its folder exists, and it is left as it is`);
    }
    const pending = new AbortController();
    this.pending.set(node, pending);
    let added;
    try {
      added = await this.devnet.devnetSh(['addnode', String(node.number), 'edge'], {
        ...node.env,
        DEVNET_ADDNODE_CONFIG_OVERRIDES: JSON.stringify(node.overrides),
        DEVNET_ADDNODE_MARK_NAME: this.markName,
        DEVNET_ADDNODE_MARK_TEXT: `${this.stamp} ${node.role} starting`,
      }, undefined, { signal: pending.signal });
    } finally {
      this.pending.delete(node);
    }
    if (this.claims(node) && !this.started.includes(node)) this.started.push(node);
    if (added.status !== 0) {
      throw new Error(`temporary node ${node.number} could not be added (${this.started.includes(node) ? 'it is removed at the cleanup' : 'its folder, if any, is left as it is'}): ${lastLines(added.output)}`);
    }
    writeFileSync(this.ownMark(node.number), `${this.stamp} ${node.role} started\n`);
    await this.identify(node);
  }

  async identify(node) {
    const up = await waitFor(async () => {
      const status = await this.devnet.api(node, 'GET', '/api/agent/identity', undefined, { timeoutMs: 10_000 });
      return { ok: status.status === 200 && Boolean(status.json?.peerId) && Boolean(status.json?.agentAddress), status };
    }, 120_000, 2000);
    if (!up.ok) throw new Error(`node${node.number} did not report its identity: ${up.status ? brief(up.status) : 'no answer'}`);
    node.peerId = up.status.json.peerId;
    node.agentAddress = up.status.json.agentAddress;
  }

  /** A member dials the owner through its relay; the owner's reservation there may need a moment. */
  dialOwner(member) { return this.dial(member, this.owner); }

  /** A member dials another node through the member's relay, on which that node holds a reservation. */
  async dial(member, to) {
    const multiaddr = `${member.relay}/p2p-circuit/p2p/${to.peerId}`;
    const dialed = await waitFor(async () => {
      const answer = await this.devnet.api(member, 'POST', '/api/connect', { multiaddr }, { timeoutMs: 30_000 });
      return { ok: answer.status === 200 && answer.json?.connected !== false, why: brief(answer) };
    }, 120_000, 3000);
    if (!dialed.ok) throw new Error(`${member.label} could not dial ${to.subject} through the relay: ${dialed.why}`);
  }

  async stop(node) {
    const stopped = await this.devnet.devnetSh(['stop-node', String(node.number)]);
    if (stopped.status !== 0) throw new Error(`${node.subject} could not be stopped: ${lastLines(stopped.output)}`);
  }

  /** Restarts a node (also one that was stopped) with its own environment. */
  async restart(node) {
    const restarted = await this.devnet.devnetSh(['restart-node', String(node.number)], node.env);
    if (restarted.status !== 0) throw new Error(`${node.subject} did not restart: ${lastLines(restarted.output)}`);
    await this.identify(node);
  }

  /** A node's own agent token, for the routes of a private graph. */
  agentToken(node) {
    try {
      const records = Object.values(JSON.parse(readFileSync(join(this.devnet.nodeDir(node), 'agent-keystore.json'), 'utf8')));
      return records.find(record => typeof record?.authToken === 'string')?.authToken ?? '';
    } catch { return ''; }
  }

  /**
   * The peers of this devnet: every node folder's address (`multiaddr`), or
   * its status when that file is missing. A peer outside it (a node an earlier
   * suite left running, say) is nothing the topology accounts for.
   */
  async devnetPeers() {
    const peers = new Set(this.nodes.map(node => node.peerId).filter(Boolean));
    for (const number of this.devnet.nodeNumbers()) {
      const address = this.devnet.multiaddrOf(number);
      const id = address.split('/p2p/').at(-1) || (await this.devnet.api(number, 'GET', '/api/status', undefined, { timeoutMs: 5000 })).json?.peerId;
      if (id) peers.add(id);
    }
    return peers;
  }

  /**
   * The topology every conclusion rests on: each member reaches the owner
   * through a relay only, the members reach each other not at all, and no
   * member is connected to a peer outside the devnet. One reading of each
   * node's connections, all at once. Returns the problems, or none.
   */
  async topologyProblems() {
    const { owner, member1, member2 } = this;
    const answers = await Promise.all(this.nodes.map(node => this.devnet.api(node, 'GET', '/api/connections')));
    const observations = new Map(this.nodes.map((node, i) => [node.number, connectionsObservation(answers[i].status, answers[i].json)]));
    return topologyProblems({
      observations,
      links: [[member1, owner, 'relayed'], [owner, member1, 'relayed'], [member2, owner, 'relayed'], [owner, member2, 'relayed'], [member1, member2, 'none'], [member2, member1, 'none']],
      members: this.members,
      known: await this.devnetPeers(),
    });
  }

  /**
   * Stops every node this run added and removes it; the logs of a failed run
   * are kept first. With `keep`, the nodes are left running.
   */
  cleanup({ keep, failed }) {
    // A start still running (the run is being interrupted): it is cancelled,
    // and its node is this run's when addnode got as far as marking its folder.
    for (const [node, pending] of this.pending) {
      pending.abort();
      if (this.claims(node) && !this.started.includes(node)) this.started.push(node);
    }
    this.pending.clear();
    if (keep) {
      if (this.started.length) this.log.say(`MEMBER_SHARING_KEEP_NODES=1: node(s) ${this.started.map(node => node.number).join(', ')} left running`);
      return;
    }
    const kept = join(this.devnet.dir, 'issue-3251-member-sharing', this.stamp);
    for (const node of this.started) {
      // Only a folder that still carries this run's claim is stopped and
      // removed: a number whose folder this run gave up (a feeder it replaced)
      // may be another suite's by now, and one without a folder has nothing to
      // stop.
      if (!this.claims(node)) {
        if (existsSync(this.devnet.nodeDir(node))) this.log.say(`node${node.number} is not this run's any more; it is left as it is`);
        continue;
      }
      this.devnet.devnetShSync(['stop-node', String(node.number)]);
      if (failed && existsSync(this.devnet.logFile(node))) {
        mkdirSync(kept, { recursive: true });
        copyFileSync(this.devnet.logFile(node), join(kept, `node${node.number}-${node.role}.daemon.log`));
        if (node.trace && existsSync(node.trace)) copyFileSync(node.trace, join(kept, `node${node.number}-${node.role}.sync-admissions.jsonl`));
      }
      const problem = this.removeOwnNode(node.number);
      if (problem) this.log.say(problem);
    }
    if (failed && existsSync(kept)) this.log.say(`kept the logs of the temporary nodes in ${kept}`);
  }
}
