// One graph's part of the issue-3251 member-sharing suite
// (scripts/devnet-test-issue-3251-member-sharing.mjs).
//
// A scenario owns everything about its graph: the cases its checks count
// under, the members that write into it in case 2, its history writes, and
// what is pending on it (the watches of its pairs and the observers of its
// members' subscriptions). The I/O is passed in (`io`: write, writeAndWatch,
// watch, subscribe, observeSubscription), so a scenario does none of its own.
//
// A scenario that cannot be set up is dropped as a whole: its watches and
// observers stop and report nothing, and no later case runs on it. A required
// scenario (the public graph, which carries cases 1 to 6) is never dropped:
// its failure stops the run.

const SUBS = sub => [null, sub];
const scopeName = sub => (sub ? 'sub-graph' : 'root');

export class GraphScenario {
  /**
   * `cases`: the case each kind of check counts under ({ history, owner,
   * member, definition }); `authors`: the members that write in case 2;
   * `sub`: the name of the graph's sub-graph.
   */
  constructor(graph, { cases, authors = [], required = false, sub }) {
    this.graph = graph;
    this.cases = cases;
    this.authors = authors;
    this.required = required;
    this.sub = sub;
    this.history = [];
    this.subscribedAt = new Map();
    this.watches = [];
    this.observers = [];
    // Whether each member was seen holding the graph's definition while its
    // subscription was observed: the state that preceded its own writes.
    this.definitionSeen = new Map();
    this.dropped = false;
  }

  get active() { return !this.dropped; }

  /** Stops what is pending on the graph; nothing more runs on it. */
  drop() {
    this.dropped = true;
    for (const handle of [...this.watches, ...this.observers]) handle.cancel();
  }

  /** Case 3 (7): the owner's writes before any member subscribes, to the root and to the sub-graph. */
  async writeHistory(io, owner) {
    for (const sub of SUBS(this.sub)) this.history.push(await io.write(owner, this.graph, sub, `history ${scopeName(sub)}`));
  }

  /**
   * Each member subscribes, and at once the watch of the history for it and
   * the observer of its subscription start: each member's bound and deadlines
   * start at its own subscribe. A subscription that fails drops an optional
   * scenario and returns the problem; on a required one it stops the run.
   * Returns null when every member subscribed.
   */
  async subscribeMembers(io, members) {
    for (const member of members) {
      let at;
      try {
        at = await io.subscribe(member, this.graph);
      } catch (error) {
        if (this.required) throw error;
        this.drop();
        return error?.message ?? String(error);
      }
      this.subscribedAt.set(member, at);
      this.watches.push(io.watch(this.history.map(record => ({
        caseId: this.cases.history, record, node: member, from: at, fromWhat: 'member subscribed',
      }))));
      this.observers.push(io.observeSubscription(member, this.graph, at));
    }
    return null;
  }

  /** The observed subscriptions, in the order the members subscribed, once each has settled. */
  async observedSubscriptions() {
    const observations = await Promise.all(this.observers.map(handle => handle.done));
    if (this.dropped) return [];
    this.observers.forEach((handle, i) => this.definitionSeen.set(handle.node, observations[i] ? observations[i].definedAt !== null : undefined));
    return this.observers.map((handle, i) => ({ node: handle.node, graph: this.graph, observation: observations[i] }));
  }

  /** The watches of the history, once each has ended (none once dropped). */
  async historyWatches() {
    await Promise.all(this.watches.map(handle => handle.done));
    return this.dropped ? [] : this.watches;
  }

  /** Case 1 (7): the owner writes, live, to the root and the sub-graph; every member must hold each write. */
  async ownerWrites(io, owner, members) {
    const handles = [];
    for (const sub of SUBS(this.sub)) handles.push(await io.writeAndWatch(this.cases.owner, owner, this.graph, sub, `owner live ${scopeName(sub)}`, members));
    return handles;
  }

  /**
   * Case 2 (7): each author writes, live; the owner and every other member
   * must hold each write. Each write carries whether its author was seen
   * holding the definition before (unknown until the subscriptions settled).
   */
  async memberWrites(io, owner, members) {
    const handles = [];
    for (const sub of SUBS(this.sub)) {
      for (const author of this.authors) {
        handles.push(await io.writeAndWatch(this.cases.member, author, this.graph, sub, `${author.role} live ${scopeName(sub)}`,
          [owner, ...members.filter(member => member !== author)], { definitionSeen: this.definitionSeen.get(author) }));
      }
    }
    return handles;
  }
}
