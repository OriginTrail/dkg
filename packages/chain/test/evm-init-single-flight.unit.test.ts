import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { SingleFlightInvalidatedError } from '../src/keyed-ttl-single-flight-cache.js';
import {
  activeRpcRequestContext,
  withRpcRequestContext,
  type RpcRequestContext,
} from '../src/rpc-request-transport.js';

const ADDRESS = '0x0000000000000000000000000000000000000001';
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

/**
 * Initialization resolves the adapter's Hub bindings. Callers that find the
 * adapter uninitialized share one run of it: these tests script the Hub
 * boundary and keep `init`, the run and its resets production code. They call
 * `init` itself, the entry every public method goes through, so that nothing
 * a public method shares on its own account stands in for it. The scripted
 * boundary honours cancellation of the request it is called in, as the
 * transport does.
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
    const holds = new Map<string, Array<{ entered: () => void; released: Promise<void> }>>();
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
        await Promise.race([hold.released, cancelled(context.signal)]);
      }
      context.signal?.throwIfAborted();
      const failure = failures.get(name);
      if (failure?.length) throw failure.shift();
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
    return {
      adapter,
      resolved,
      starts,
      runs: () => runs,
      /** Hold the next resolution of `name` until released. */
      holdNext(name: string) {
        let entered!: () => void;
        let release!: () => void;
        const reached = new Promise<void>((done) => { entered = done; });
        const released = new Promise<void>((done) => { release = done; });
        holds.set(name, [...(holds.get(name) ?? []), { entered, released }]);
        return { reached, release };
      },
      failNext(name: string, error: unknown) {
        failures.set(name, [...(failures.get(name) ?? []), error]);
      },
    };
  }

  /** Let what a released or ended run still has to do happen. */
  const settled = () => new Promise<void>((done) => setTimeout(done, 20));

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
      expect(context.onProgress).toBeUndefined();
    }
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
      // run's foreground work nor an authority read, and no run's signal
      // ends it.
      expect(context.requestClass).toBe('background');
      expect(context.admissionPriority).toBeUndefined();
      expect(context.signal).toBeUndefined();
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

    // The ended run is released first: it binds nothing more, starts
    // nothing, and does not mark the adapter initialized.
    stale.release();
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

  it('keeps the new run\'s bindings when the ended run is released after it has finished', async () => {
    const { adapter, runs, holdNext } = fixture();
    const stale = holdNext('ContextGraphs');
    const waiting = adapter.init();
    await stale.reached;

    adapter.finalizeKnownHubRotation();
    await waiting;
    expect(runs()).toBe(2);
    expect(adapter.initialized).toBe(true);
    expect(adapter.contracts.contextGraphs.run).toBe(2);

    stale.release();
    await settled();
    expect(adapter.contracts.contextGraphs.run).toBe(2);
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
