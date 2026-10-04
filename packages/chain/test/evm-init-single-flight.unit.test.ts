import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
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
 * a public method shares on its own account stands in for it.
 */
describe('adapter initialization is shared by the callers that need it', () => {
  const adapters: EVMChainAdapter[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.destroy();
    vi.restoreAllMocks();
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
    const resolve = async (name: string) => {
      resolved.push({ name, context: activeRpcRequestContext() });
      const hold = holds.get(name)?.shift();
      if (hold) {
        hold.entered();
        await hold.released;
      }
      const failure = failures.get(name);
      if (failure?.length) throw failure.shift();
      return { target: ADDRESS, getAddress: async () => ADDRESS };
    };
    vi.spyOn(adapter, 'resolveContract').mockImplementation(resolve);
    vi.spyOn(adapter, 'resolveAssetStorage').mockImplementation(resolve);
    vi.spyOn(adapter, 'resolveAndAssignRandomSamplingPair')
      .mockImplementation(() => resolve('RandomSampling'));
    vi.spyOn(adapter, 'readContract').mockResolvedValue(7n);
    vi.spyOn(adapter, 'startChainIndexRuntime').mockImplementation(() => {});
    vi.spyOn(adapter, 'startHubRotationListener').mockResolvedValue(undefined);
    adapter.tokenAddress = ADDRESS;
    return {
      adapter,
      resolved,
      runs: () => resolved.filter(({ name }) => name === 'Identity').length,
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

  it('runs as the adapter\'s own foreground work at authority priority, whoever starts it', async () => {
    const { adapter, resolved } = fixture();
    const controller = new AbortController();
    await withRpcRequestContext(
      { requestClass: 'background', signal: controller.signal, onProgress: vi.fn() },
      () => adapter.init(),
    );

    expect(resolved.length).toBeGreaterThan(10);
    for (const { context } of resolved) {
      expect(context.requestClass).toBe('foreground');
      expect(context.admissionPriority).toBe('authority');
      expect(context.signal).toBeUndefined();
      expect(context.onProgress).toBeUndefined();
    }
  });

  it('starts the adapter-owned work in the class of the caller that started the run, and with nothing else of it', async () => {
    const { adapter } = fixture();
    vi.mocked(adapter.startChainIndexRuntime).mockRestore();
    vi.mocked(adapter.startHubRotationListener).mockRestore();
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
      // run's foreground work nor an authority read.
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
    // The run is not the caller's to stop.
    expect(adapter.initialized).toBe(false);

    held.release();
    await expect(patient).resolves.toBeUndefined();
    expect(runs()).toBe(1);
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

  it('ends quietly when a run fails that nobody waits for', async () => {
    const { adapter, runs, failNext } = fixture();
    failNext('Staking', { code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' });
    const controller = new AbortController();
    const reason = new Error('cancelled before the call');
    controller.abort(reason);

    // The caller leaves at once, so the run it started has no waiter when it
    // fails. An unhandled rejection would fail this test run.
    await expect(withRpcRequestContext({ signal: controller.signal }, () => adapter.init()))
      .rejects.toBe(reason);
    await new Promise((done) => setTimeout(done, 20));
    expect(runs()).toBe(1);
    expect(adapter.initialized).toBe(false);
  });

  it('does not mark the adapter initialized by a run that a reset made stale', async () => {
    const { adapter, runs, holdNext } = fixture();
    const held = holdNext('ContextGraphs');
    const waiting = adapter.init();
    await held.reached;

    // A Hub rotation observed while the run is out: bindings it has already
    // resolved may be the retired ones.
    adapter.finalizeKnownHubRotation();
    held.release();
    // The caller that waited goes on, as a caller always did after its own
    // initialization. The next one initializes again.
    await expect(waiting).resolves.toBeUndefined();
    expect(adapter.initialized).toBe(false);

    await adapter.init();
    expect(runs()).toBe(2);
    expect(adapter.initialized).toBe(true);
  });

  it('starts a new run for a caller that arrives after a reset, instead of joining the stale one', async () => {
    const { adapter, runs, holdNext } = fixture();
    const stale = holdNext('ContextGraphs');
    const before = adapter.init();
    await stale.reached;

    adapter.invalidateAllBoundContracts();
    const fresh = holdNext('ContextGraphs');
    const after = adapter.init();
    await fresh.reached;
    expect(runs()).toBe(2);

    // The stale run ends first. It neither marks the adapter initialized nor
    // takes the place of the run that is still out.
    stale.release();
    await expect(before).resolves.toBeUndefined();
    expect(adapter.initialized).toBe(false);
    const joined = adapter.init();
    await Promise.resolve();
    expect(runs()).toBe(2);

    fresh.release();
    await Promise.all([after, joined]);
    expect(runs()).toBe(2);
    expect(adapter.initialized).toBe(true);
  });
});
