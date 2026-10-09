import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import {
  AbortableKeyedSingleFlight,
  SingleFlightInvalidatedError,
} from '../src/keyed-ttl-single-flight-cache.js';
import {
  activeRpcRequestContext,
  withRpcRequestContext,
  type RpcRequestContext,
} from '../src/rpc-request-transport.js';

const ADDRESS = '0x0000000000000000000000000000000000000001';
const RETIRED = '0x0000000000000000000000000000000000000002';
const CURRENT = '0x0000000000000000000000000000000000000003';
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/**
 * Initialization resolves the adapter's Hub bindings. Callers that find the
 * adapter uninitialized share one run of it: these tests script the Hub
 * boundary and keep `init`, the run and its resets production code. They call
 * `init` itself, the entry every public method goes through, so that nothing
 * a public method shares on its own account stands in for it. The scripted
 * boundary honours cancellation of the request it is called in, as the
 * transport does, unless a read is scripted to answer although its run was
 * ended: an answer that was already on its way, or a read that was not the
 * run's to cancel.
 */
describe('adapter initialization is shared by the callers that need it', () => {
  const adapters: EVMChainAdapter[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.destroy();
    vi.restoreAllMocks();
  });

  const cancelled = (signal: AbortSignal | undefined) => new Promise<void>((done) => {
    if (signal === undefined) return;
    if (signal.aborted) done();
    else signal.addEventListener('abort', () => done(), { once: true });
  });

  function fixture() {
    const adapter: any = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1', privateKey: PRIVATE_KEY,
      hubAddress: ADDRESS, chainId: 'evm:31337', allowNoAdminSigner: true,
    });
    adapters.push(adapter);
    /** Every Hub name resolved, in order, with the request context it was resolved in. */
    const resolved: Array<{ name: string; context: RpcRequestContext }> = [];
    const holds = new Map<string, Array<{
      entered: () => void; released: Promise<void>; answersWhenEnded: boolean;
    }>>();
    const failures = new Map<string, unknown[]>();
    /** The run a resolution belongs to: the first is 1, the one after a reset 2, ... */
    let runs = 0;
    const resolve = async (name: string) => {
      const context = activeRpcRequestContext();
      if (name === 'Identity') runs += 1;
      const run = runs;
      resolved.push({ name, context });
      const hold = holds.get(name)?.shift();
      if (hold) {
        hold.entered();
        // A read that is cancelled ends at once, whatever the chain is doing.
        await (hold.answersWhenEnded
          ? hold.released
          : Promise.race([hold.released, cancelled(context.signal)]));
      }
      if (hold?.answersWhenEnded !== true) context.signal?.throwIfAborted();
      const failure = failures.get(name);
      if (failure?.length) throw failure.shift();
      // What the transport does when a request has succeeded and was not
      // cancelled meanwhile: an observer cannot change the outcome of the
      // request it observes.
      if (context.signal?.aborted !== true) {
        try { context.onProgress?.(); } catch { /* as the transport */ }
      }
      return { target: ADDRESS, run, getAddress: async () => ADDRESS };
    };
    vi.spyOn(adapter, 'resolveContract').mockImplementation(resolve);
    vi.spyOn(adapter, 'resolveAssetStorage').mockImplementation(resolve);
    vi.spyOn(adapter, 'resolveAndAssignRandomSamplingPair')
      .mockImplementation(() => resolve('RandomSampling'));
    vi.spyOn(adapter, 'readContract').mockResolvedValue(7n);
    const starts = {
      chainIndex: vi.spyOn(adapter, 'startChainIndexRuntime').mockImplementation(() => {}),
      hubRotation: vi.spyOn(adapter, 'startHubRotationListener').mockResolvedValue(undefined),
    };
    adapter.tokenAddress = ADDRESS;
    const initContracts = vi.spyOn(adapter, 'initContracts');
    return {
      adapter,
      resolved,
      starts,
      runs: () => runs,
      /** What each run made of its bindings, in the order the runs started. */
      initRuns: () => initContracts.mock.results.map((result) => result.value as Promise<void>),
      /** Hold the next resolution of `name` until released. */
      holdNext(name: string, { answersWhenEnded = false } = {}) {
        let entered!: () => void;
        let release!: () => void;
        const reached = new Promise<void>((done) => { entered = done; });
        const released = new Promise<void>((done) => { release = done; });
        holds.set(name, [...(holds.get(name) ?? []), { entered, released, answersWhenEnded }]);
        return { reached, release };
      },
      failNext(name: string, error: unknown) {
        failures.set(name, [...(failures.get(name) ?? []), error]);
      },
    };
  }

  /**
   * The same adapter with the Hub itself scripted: the resolver, its address
   * memo and the handling of a rotation are production code.
   */
  function hubFixture() {
    const adapter: any = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1', privateKey: PRIVATE_KEY,
      hubAddress: ADDRESS, chainId: 'evm:31337', allowNoAdminSigner: true,
    });
    adapters.push(adapter);
    const registered = new Map<string, string>();
    const reads = new Map<string, number>();
    const lateAnswers = new Map<string, {
      entered: () => void; released: Promise<void>; address: string;
    }>();
    const slowReads = new Map<string, { entered: () => void; released: Promise<void> }>();
    vi.spyOn(adapter, 'readContract').mockImplementation(async (...args: unknown[]) => {
      const name = args[3] as string;
      reads.set(name, (reads.get(name) ?? 0) + 1);
      const late = lateAnswers.get(name);
      if (late) {
        lateAnswers.delete(name);
        late.entered();
        // An answer that arrives whether or not its request was cancelled.
        await late.released;
        return late.address;
      }
      const slow = slowReads.get(name);
      if (slow) {
        slowReads.delete(name);
        slow.entered();
        // A read that takes until its release to settle, a cancelled one
        // included: it ends as its request has it by then.
        await slow.released;
      }
      activeRpcRequestContext().signal?.throwIfAborted();
      return registered.get(name) ?? ADDRESS;
    });
    vi.spyOn(adapter, 'startChainIndexRuntime').mockImplementation(() => {});
    vi.spyOn(adapter, 'startHubRotationListener').mockResolvedValue(undefined);
    adapter.tokenAddress = ADDRESS;
    const initContracts = vi.spyOn(adapter, 'initContracts');
    return {
      adapter,
      initRuns: () => initContracts.mock.results.map((result) => result.value as Promise<void>),
      /** How often the Hub was asked for `name`. */
      reads: (name: string) => reads.get(name) ?? 0,
      /** The address the Hub has for `name` from now on. */
      register(name: string, address: string) { registered.set(name, address); },
      /** The next read of `name` answers `address` when released, even to a run that was ended. */
      answerLate(name: string, address: string) {
        let entered!: () => void;
        let release!: () => void;
        const reached = new Promise<void>((done) => { entered = done; });
        const released = new Promise<void>((done) => { release = done; });
        lateAnswers.set(name, { entered, released, address });
        return { reached, release };
      },
      /** The next read of `name` settles only when released: cancelled, if its request was by then. */
      settleLate(name: string) {
        let entered!: () => void;
        let release!: () => void;
        const reached = new Promise<void>((done) => { entered = done; });
        const released = new Promise<void>((done) => { release = done; });
        slowReads.set(name, { entered, released });
        return { reached, release };
      },
    };
  }

  /** Let what a released or ended run still has to do happen. */
  const settled = () => new Promise<void>((done) => setTimeout(done, 20));

  /**
   * How often a caller asked to share a run, by the signal it waits under. A
   * caller that keeps asking lets nothing else run, a test's timeout
   * included, so one that asks a sixth time fails instead.
   */
  function attemptsByCaller() {
    const run = AbortableKeyedSingleFlight.prototype.run;
    const attempts = new Map<AbortSignal | undefined, number>();
    vi.spyOn(AbortableKeyedSingleFlight.prototype, 'run').mockImplementation(function (
      this: AbortableKeyedSingleFlight<unknown, unknown>,
      ...args: Parameters<typeof run>
    ) {
      const [key, , signal] = args;
      if (key === 'init') {
        const asked = (attempts.get(signal) ?? 0) + 1;
        attempts.set(signal, asked);
        if (asked > 5) throw new Error(`a caller asked ${asked} times to share initialization`);
      }
      return run.apply(this, args);
    });
    return (signal: AbortSignal) => attempts.get(signal) ?? 0;
  }

  it('runs once for callers that arrive together', async () => {
    const { adapter, runs, holdNext } = fixture();
    const held = holdNext('Profile');
    const callers = [adapter.init(), adapter.init(), adapter.init()];
    await held.reached;
    // A caller that arrives while it runs joins it too.
    callers.push(adapter.init());
    held.release();

    await Promise.all(callers);
    expect(runs()).toBe(1);
    expect(adapter.initialized).toBe(true);

    // Initialized: nothing runs again.
    await adapter.init();
    expect(runs()).toBe(1);
  });

  it('runs as the adapter\'s own foreground work, whichever class starts it', async () => {
    const { adapter, resolved } = fixture();
    const controller = new AbortController();
    await withRpcRequestContext(
      { requestClass: 'background', signal: controller.signal, onProgress: vi.fn() },
      () => adapter.init(),
    );

    expect(resolved.length).toBeGreaterThan(10);
    for (const { context } of resolved) {
      expect(context.requestClass).toBe('foreground');
      expect(context.admissionPriority).toBeUndefined();
      // Its own signal, not the caller's.
      expect(context.signal).toBeDefined();
      expect(context.signal).not.toBe(controller.signal);
    }
  });

  it('tells each caller of the run\'s progress for as long as that caller waits', async () => {
    const { adapter, resolved, holdNext } = fixture();
    const first = holdNext('Profile');
    const second = holdNext('ContextGraphs');
    const starterProgress = vi.fn();
    const starter = withRpcRequestContext({ onProgress: starterProgress }, () => adapter.init());
    await first.reached;
    // One binding has answered so far.
    expect(starterProgress).toHaveBeenCalledTimes(1);

    const joinerProgress = vi.fn(() => { throw new Error('an observer that fails'); });
    const leaving = new AbortController();
    const leaverProgress = vi.fn();
    const joiner = withRpcRequestContext({ onProgress: joinerProgress }, () => adapter.init());
    const leaver = withRpcRequestContext(
      { onProgress: leaverProgress, signal: leaving.signal },
      () => adapter.init(),
    );
    first.release();
    await second.reached;
    const heardByStarter = starterProgress.mock.calls.length;
    expect(heardByStarter).toBeGreaterThan(1);
    // Those who joined hear of what answered since, a failing observer included.
    expect(joinerProgress).toHaveBeenCalledTimes(heardByStarter - 1);
    expect(leaverProgress).toHaveBeenCalledTimes(heardByStarter - 1);

    leaving.abort(new Error('caller cancelled'));
    await expect(leaver).rejects.toThrow('caller cancelled');
    second.release();
    await Promise.all([starter, joiner]);

    // Every binding of the run was reported to the caller that waited throughout.
    expect(starterProgress).toHaveBeenCalledTimes(resolved.length);
    expect(joinerProgress).toHaveBeenCalledTimes(resolved.length - 1);
    // The caller that left heard nothing after it left.
    expect(leaverProgress).toHaveBeenCalledTimes(heardByStarter - 1);
  });

  it('reports the initialization a read waits for to the observer of that read', async () => {
    const { adapter, resolved } = fixture();
    const onProgress = vi.fn();
    await expect(
      withRpcRequestContext({ onProgress }, () => adapter.getIdentityId()),
    ).resolves.toBe(7n);

    // Every request the read needed was reported, those of the initialization
    // it waited for included: a caller that bounds inactivity sees them all.
    const ofTheRun = resolved.filter(({ context }) => context.signal !== undefined);
    expect(ofTheRun.length).toBeGreaterThan(10);
    expect(onProgress).toHaveBeenCalledTimes(resolved.length);
  });

  it('reports nothing to a caller that was cancelled, even before its wait has ended', async () => {
    const { adapter, holdNext } = fixture();
    const held = holdNext('Profile');
    const leaving = new AbortController();
    const onProgress = vi.fn();
    const leaver = withRpcRequestContext(
      { onProgress, signal: leaving.signal },
      () => adapter.init(),
    );
    const staying = adapter.init();
    await held.reached;
    expect(onProgress).toHaveBeenCalledTimes(1);

    leaving.abort(new Error('caller cancelled'));
    // What the run does when one of its requests has succeeded.
    adapter.sharedInit.reportProgress();
    expect(onProgress).toHaveBeenCalledTimes(1);

    await expect(leaver).rejects.toThrow('caller cancelled');
    held.release();
    await staying;
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('reports nothing to a caller that has no observer, and to nobody once it is over', async () => {
    const { adapter, holdNext } = fixture();
    const held = holdNext('Profile');
    const silent = adapter.init();
    await held.reached;
    expect(adapter.sharedInit.observerCount).toBe(0);

    const onProgress = vi.fn();
    const observed = withRpcRequestContext({ onProgress }, () => adapter.init());
    await Promise.resolve();
    expect(adapter.sharedInit.observerCount).toBe(1);
    held.release();
    await Promise.all([silent, observed]);

    // Nothing is kept of a caller once its wait is over.
    expect(adapter.sharedInit.observerCount).toBe(0);
  });

  it('keeps the admission priority of the caller that starts it', async () => {
    const { adapter, resolved } = fixture();
    await withRpcRequestContext(
      { requestClass: 'background', admissionPriority: 'authority' },
      () => adapter.init(),
    );

    expect(resolved.length).toBeGreaterThan(10);
    for (const { context } of resolved) {
      expect(context.requestClass).toBe('foreground');
      expect(context.admissionPriority).toBe('authority');
    }
  });

  it('starts the adapter-owned work in the class of the caller that started the run, and with nothing else of it', async () => {
    const { adapter, starts } = fixture();
    starts.chainIndex.mockRestore();
    starts.hubRotation.mockRestore();
    const contexts: RpcRequestContext[] = [];
    const capture = () => { contexts.push(activeRpcRequestContext()); };
    vi.spyOn(adapter.chainIndexOwner, 'start').mockImplementation(capture);
    vi.spyOn(adapter.hubRotationPoller, 'start').mockImplementation(capture);

    await withRpcRequestContext(
      { requestClass: 'background', admissionPriority: 'authority', signal: new AbortController().signal },
      () => adapter.init(),
    );

    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      // What these starts run for the life of the process is neither the
      // run's foreground work nor an authority read, no run's signal ends
      // it, and it reports to no caller.
      expect(context.requestClass).toBe('background');
      expect(context.admissionPriority).toBeUndefined();
      expect(context.signal).toBeUndefined();
      expect(context.onProgress).toBeUndefined();
    }
  });

  it('ends a caller that gives up with its own reason and lets the others finish', async () => {
    const { adapter, runs, holdNext } = fixture();
    const held = holdNext('ContextGraphs');
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const cancelled = withRpcRequestContext({ signal: controller.signal }, () => adapter.init());
    const patient = adapter.init();
    await held.reached;

    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    // The run is not that caller's to stop while another waits for it.
    expect(adapter.initialized).toBe(false);

    held.release();
    await expect(patient).resolves.toBeUndefined();
    expect(runs()).toBe(1);
    expect(adapter.initialized).toBe(true);
  });

  it('ends the run when its last waiter gives up, and starts a new one for the next caller', async () => {
    const { adapter, runs, starts, holdNext } = fixture();
    const held = holdNext('ContextGraphs');
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const cancelled = withRpcRequestContext({ signal: controller.signal }, () => adapter.init());
    await held.reached;

    controller.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    held.release();
    await settled();
    // Nobody waited for it: it bound nothing more and started nothing.
    expect(adapter.initialized).toBe(false);
    expect(starts.chainIndex).not.toHaveBeenCalled();

    await adapter.init();
    expect(runs()).toBe(2);
    expect(adapter.initialized).toBe(true);
    expect(starts.chainIndex).toHaveBeenCalledTimes(1);
  });

  it('starts nothing for a caller that was already cancelled', async () => {
    const { adapter, runs } = fixture();
    const controller = new AbortController();
    const reason = new Error('cancelled before the call');
    controller.abort(reason);

    await expect(withRpcRequestContext({ signal: controller.signal }, () => adapter.init()))
      .rejects.toBe(reason);
    await settled();
    expect(runs()).toBe(0);
  });

  it.each([
    ['while it waits', false],
    ['before it asks', true],
  ])('ends a caller cancelled %s by a retryable invalidation of its own, instead of asking again', async (_when, early) => {
    const { adapter, runs, holdNext } = fixture();
    const attempts = attemptsByCaller();
    const held = holdNext('ContextGraphs');
    // What a shared read cancels its wait for initialization with when the
    // read is invalidated, as a name-hash lookup is when the publish-preflight
    // cache is reset: retryable, for the read to start again, not this wait.
    const reason = new SingleFlightInvalidatedError('the caller\'s own read was invalidated', { retryable: true });
    const leaving = new AbortController();
    const staying = new AbortController();
    if (early) leaving.abort(reason);
    const cancelled = withRpcRequestContext({ signal: leaving.signal }, () => adapter.init())
      .catch((error: unknown) => error);
    const live = withRpcRequestContext({ signal: staying.signal }, () => adapter.init());
    await held.reached;

    if (!early) leaving.abort(reason);
    const outcome = await cancelled;
    expect(attempts(leaving.signal)).toBe(1);
    expect(outcome).toBe(reason);

    // A caller that waits on, under a signal of its own, still follows a
    // reset to the run that starts after it.
    adapter.invalidateAllBoundContracts();
    await expect(live).resolves.toBeUndefined();
    expect(attempts(staying.signal)).toBe(2);
    expect(runs()).toBe(2);
    expect(adapter.initialized).toBe(true);
  });

  it('gives every waiter the failure of the run they shared, and the next caller a new run', async () => {
    const { adapter, runs, holdNext, failNext } = fixture();
    const error = { code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' };
    failNext('Staking', error);
    const held = holdNext('Profile');
    const first = adapter.init();
    const second = adapter.init();
    await held.reached;
    held.release();

    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
    expect(runs()).toBe(1);
    expect(adapter.initialized).toBe(false);

    await adapter.init();
    expect(runs()).toBe(2);
    expect(adapter.initialized).toBe(true);
  });

  it.each([
    ['an observed Hub rotation', (adapter: any) => adapter.finalizeKnownHubRotation()],
    ['the reset of every binding', (adapter: any) => adapter.invalidateAllBoundContracts()],
  ])('initializes again for the next caller after %s', async (_name, reset) => {
    const { adapter, runs } = fixture();
    await adapter.init();
    expect(adapter.initialized).toBe(true);

    reset(adapter);
    expect(adapter.initialized).toBe(false);
    await adapter.init();
    expect(runs()).toBe(2);
    expect(adapter.initialized).toBe(true);
  });

  it.each([
    ['an observed Hub rotation', (adapter: any) => adapter.finalizeKnownHubRotation()],
    ['the reset of every binding', (adapter: any) => adapter.invalidateAllBoundContracts()],
  ])('moves the callers waiting through %s to a run that started after it', async (_name, reset) => {
    const { adapter, runs, starts, holdNext } = fixture();
    const stale = holdNext('ContextGraphs');
    const waiting = adapter.init();
    await stale.reached;

    // Bindings the run has already resolved may be the retired ones.
    reset(adapter);
    const fresh = holdNext('ContextGraphs');
    await fresh.reached;
    expect(runs()).toBe(2);
    // A caller that arrives now joins the new run.
    const arriving = adapter.init();

    // The read the ended run had out was cancelled with it: that run binds
    // nothing more, starts nothing, and does not mark the adapter initialized.
    await settled();
    expect(adapter.initialized).toBe(false);
    expect(starts.chainIndex).not.toHaveBeenCalled();

    fresh.release();
    await Promise.all([waiting, arriving]);
    expect(runs()).toBe(2);
    expect(adapter.initialized).toBe(true);
    expect(starts.chainIndex).toHaveBeenCalledTimes(1);
    // Every binding is the new run's.
    expect(adapter.contracts.identity.run).toBe(2);
    expect(adapter.contracts.contextGraphs.run).toBe(2);
  });

  it.each([
    ['an observed Hub rotation', (adapter: any) => adapter.finalizeKnownHubRotation()],
    ['the reset of every binding', (adapter: any) => adapter.invalidateAllBoundContracts()],
  ])('binds nothing from a run ended by %s, whatever its read still answers', async (_name, reset) => {
    const { adapter, runs, initRuns, holdNext } = fixture();
    const stale = holdNext('ContextGraphs', { answersWhenEnded: true });
    const waiting = adapter.init();
    await stale.reached;

    reset(adapter);
    const fresh = holdNext('ContextGraphs');
    // A caller that arrives after the reset gets the run that follows it.
    const arriving = adapter.init();
    await fresh.reached;
    expect(runs()).toBe(2);

    // The ended run gets its answer while the new run is still reading.
    stale.release();
    await expect(initRuns()[0]).rejects.toBeInstanceOf(SingleFlightInvalidatedError);
    expect(adapter.contracts.contextGraphs).toBeUndefined();
    expect(adapter.initialized).toBe(false);

    fresh.release();
    await Promise.all([waiting, arriving]);
    expect(runs()).toBe(2);
    expect(adapter.initialized).toBe(true);
    expect(adapter.contracts.contextGraphs.run).toBe(2);
  });

  it('keeps the new run\'s bindings when the read of the ended run answers after it has finished', async () => {
    const { adapter, runs, initRuns, holdNext } = fixture();
    const stale = holdNext('ContextGraphs', { answersWhenEnded: true });
    const waiting = adapter.init();
    await stale.reached;

    adapter.finalizeKnownHubRotation();
    await adapter.init();
    expect(runs()).toBe(2);
    expect(adapter.initialized).toBe(true);
    expect(adapter.contracts.contextGraphs.run).toBe(2);

    stale.release();
    await expect(initRuns()[0]).rejects.toBeInstanceOf(SingleFlightInvalidatedError);
    // The caller that waited through the reset finds the adapter as the new
    // run left it.
    await waiting;
    expect(runs()).toBe(2);
    expect(adapter.initialized).toBe(true);
    expect(adapter.contracts.contextGraphs.run).toBe(2);
  });

  it('binds the address the Hub has after a rotation, whatever it still answers the ended run', async () => {
    const { adapter, initRuns, reads, register, answerLate } = hubFixture();
    const retired = answerLate('ContextGraphs', RETIRED);
    const waiting = adapter.init();
    await retired.reached;

    register('ContextGraphs', CURRENT);
    adapter.applyHubRotationEventName('ContextGraphs');
    await adapter.init();
    expect(adapter.initialized).toBe(true);
    await expect(adapter.contracts.contextGraphs.getAddress()).resolves.toBe(CURRENT);

    // The Hub answers the read of the ended run with the address it had.
    retired.release();
    await expect(initRuns()[0]).rejects.toBeInstanceOf(SingleFlightInvalidatedError);
    await waiting;
    expect(reads('ContextGraphs')).toBe(2);

    // Neither the binding nor the resolver's memo took it.
    await expect(adapter.contracts.contextGraphs.getAddress()).resolves.toBe(CURRENT);
    const resolvedNow = await adapter.resolveContract('ContextGraphs');
    await expect(resolvedNow.getAddress()).resolves.toBe(CURRENT);
    expect(reads('ContextGraphs')).toBe(2);
    expect(adapter.initialized).toBe(true);
  });

  it.each([
    ['Identity', 'identity'],
    ['Chronos', 'chronos'],
    ['RandomSampling', 'randomSampling'],
  ])('reads %s afresh for the run after an abandoned one, while that run\'s read of it is still settling', async (name, binding) => {
    const { adapter, reads, settleLate } = hubFixture();
    const settling = settleLate(name);
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const abandoned = withRpcRequestContext({ signal: controller.signal }, () => adapter.init());
    await settling.reached;

    // The run's last waiter leaves, and the next caller arrives before the
    // read the ended run had out has finished cancelling.
    controller.abort(reason);
    await expect(abandoned).rejects.toBe(reason);
    const arriving = adapter.init();
    await settled();
    settling.release();

    // The new run read it for itself: the ended run's read ends with that
    // run's cancellation, which is not the new run's.
    await expect(arriving).resolves.toBeUndefined();
    expect(adapter.contracts[binding]).toBeDefined();
    expect(reads(name)).toBe(2);
    expect(adapter.initialized).toBe(true);
  });

  it('ends the run and starts nothing when the adapter is destroyed while a binding is read', async () => {
    const { adapter, runs, starts, holdNext } = fixture();
    // The last binding read before the adapter-owned work is started.
    const held = holdNext('RandomSampling');
    const waiting = adapter.init();
    await held.reached;

    adapter.destroy();
    await expect(waiting).rejects.toBeInstanceOf(SingleFlightInvalidatedError);
    held.release();
    await settled();
    expect(runs()).toBe(1);
    expect(adapter.initialized).toBe(false);
    expect(starts.chainIndex).not.toHaveBeenCalled();
    expect(starts.hubRotation).not.toHaveBeenCalled();
  });

  it('does not initialize an adapter that was destroyed', async () => {
    const { adapter, runs, starts } = fixture();
    adapter.destroy();

    await expect(adapter.init()).rejects.toThrow('chain adapter was destroyed');
    expect(runs()).toBe(0);
    expect(adapter.initialized).toBe(false);
    expect(starts.chainIndex).not.toHaveBeenCalled();
    expect(starts.hubRotation).not.toHaveBeenCalled();
  });

  it('starts nothing when a run is ended after its last binding was read', async () => {
    const { adapter, starts } = fixture();
    // The last binding answers, and the adapter is destroyed in the same turn:
    // the run has nothing left to be cancelled in before its starts.
    vi.mocked(adapter.resolveAndAssignRandomSamplingPair).mockImplementation(async () => {
      adapter.destroy();
    });

    await expect(adapter.init()).rejects.toBeInstanceOf(SingleFlightInvalidatedError);
    expect(adapter.initialized).toBe(false);
    expect(starts.chainIndex).not.toHaveBeenCalled();
    expect(starts.hubRotation).not.toHaveBeenCalled();
  });
});
