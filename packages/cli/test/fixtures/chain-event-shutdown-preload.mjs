// Fault injection only in the real daemon worker, never its store/worker children.
// The selected fixture graph has explicit read authority. Poller, scheduling,
// binding resolver, retirement and daemon teardown remain production code.
if (process.argv.includes('daemon-worker')) {
  const { appendFileSync, existsSync, watch } = await import('node:fs');
  const { join } = await import('node:path');
  const { DKGAgent } = await import('@origintrail-official/dkg-agent');
  const { MockChainAdapter } = await import('@origintrail-official/dkg-chain');
  const { DashboardDB } = await import('@origintrail-official/dkg-node-ui');
  const home = process.env.DKG_HOME;
  const scenario = process.env.DKG_TEST_CHAIN_EVENT_BOUNDARY;
  const localId = 'shutdown-event-fixture';
  const record = (event, detail = {}) => appendFileSync(join(home, '2361.events.jsonl'), JSON.stringify({ event, ...detail }) + '\n');
  record('fixture-ready');
  let armed = false;
  let activeAgent;
  let pollSignal;
  let release;
  const released = new Promise(resolve => { release = resolve; });
  const watcher = watch(home, (_event, filename) => {
    if (String(filename) === '2361.release' && existsSync(join(home, '2361.release'))) release();
  });
  watcher.unref();
  async function pause(signal) {
    pollSignal = signal;
    record('entered', { hasSignal: !!signal });
    const aborted = new Promise(resolve => {
      const abort = () => {
        record('aborted', { apiPortStillPresent: existsSync(join(home, 'api.port')) });
        resolve();
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
    if (scenario === 'noncooperative') await released;
    else await Promise.race([aborted, released]);
    record('physical-read-settled');
  }
  MockChainAdapter.prototype.getBlockNumber = async () => armed ? 20 : 10;
  MockChainAdapter.prototype.listenForEvents = async function* (filter) {
    if (!armed || !filter.eventTypes.includes('KnowledgeAssetRegisteredToContextGraph')) return;
    if (scenario === 'scan') await pause(filter.signal);
    yield { type: 'KnowledgeAssetRegisteredToContextGraph', blockNumber: 11, data: { contextGraphId: '7', kaId: '11', txHash: 'fixture-11' } };
    yield { type: 'KnowledgeAssetRegisteredToContextGraph', blockNumber: 12, data: { contextGraphId: '7', kaId: '12', txHash: 'fixture-12' } };
  };
  const originalResolve = MockChainAdapter.prototype.resolveContextGraphIdByNameHash;
  MockChainAdapter.prototype.resolveContextGraphIdByNameHash = async function (nameHash, options) {
    if (!armed || !options?.signal || nameHash !== activeAgent.contextGraphNameCommitment(localId)) {
      return originalResolve?.call(this, nameHash, options) ?? null;
    }
    await pause(options?.signal);
    return 7n; // A late valid result must not restore the subscription binding.
  };
  const originalCanRead = DKGAgent.prototype.canReadContextGraph;
  DKGAgent.prototype.canReadContextGraph = async function (id, ...args) {
    if (id === localId) return true;
    return originalCanRead.call(this, id, ...args);
  };
  const originalStart = DKGAgent.prototype.start;
  DKGAgent.prototype.start = async function (...args) {
    await originalStart.apply(this, args);
    await this.awaitInitialChainPoll();
    activeAgent = this;
    // Keep this case focused on the event-triggered producer.
    clearTimeout(this.vmReconcileStartupTimer);
    this.vmReconcileStartupTimer = null;
    const subscription = { subscribed: true };
    this.subscribedContextGraphs.set(localId, subscription);
    this.bindSubscriptionReverseNameHashOnChainId(
      localId, subscription, '7', this.contextGraphNameCommitment(localId),
    );
    record('initial-binding', { binding: this.contextGraphBindingState.currentBindingFor(localId, subscription) });
    const closeStore = this.store.close.bind(this.store);
    this.store.close = async () => {
      record('store-close', {
        bound: this.subscribedContextGraphs.get(localId)?.onChainId ?? null,
        binding: this.contextGraphBindingState.currentBindingFor(localId, this.subscribedContextGraphs.get(localId)),
        physicalRuns: this.vmReconcilePhysicalRuns.size,
      });
      return closeStore();
    };
    await this.chainPoller.stop();
    armed = true;
    await this.chainPoller.start();
    void this.awaitInitialChainPoll().then(() => record('poll-retired'));
  };
  const originalFence = DKGAgent.prototype.closeChainEventAdmission;
  DKGAgent.prototype.closeChainEventAdmission = function () {
    record('daemon-fence');
    originalFence?.call(this);
    record('daemon-fence-return', { aborted: !!pollSignal?.aborted });
  };
  const originalStop = DKGAgent.prototype.stop;
  DKGAgent.prototype.stop = async function () {
    try { return await originalStop.call(this); }
    catch (error) { record('agent-stop-error', { code: error.code }); throw error; }
  };
  const closeDb = DashboardDB.prototype.close;
  DashboardDB.prototype.close = function () {
    const cursor = this.db.prepare("SELECT value FROM runtime_cursors WHERE namespace = 'chainEventPoller.cursor' AND key = 'vmReconcile'").get();
    record('dashboard-close', { cursor: cursor?.value ?? null });
    watcher.close();
    return closeDb.call(this);
  };
}
