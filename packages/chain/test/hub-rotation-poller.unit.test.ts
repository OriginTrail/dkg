import { describe, expect, it, vi } from 'vitest';
import { Contract, ethers } from 'ethers';
import { HubRotationPoller } from '../src/hub-rotation-poller.js';
import { RPC_LOG_SCAN_TIMEOUT_MS, RPC_READ_STALL_TIMEOUT_MS } from '../src/evm-adapter-constants.js';
import { RpcFailoverClient } from '../src/rpc-failover-client.js';

const HUB_ADDRESS = '0x0000000000000000000000000000000000000001';

const ROTATION_EVENTS = [
  'event NewContract(string contractName, address newContractAddress)',
  'event ContractChanged(string contractName, address newContractAddress)',
  'event NewAssetStorage(string contractName, address newContractAddress)',
  'event AssetStorageChanged(string contractName, address newContractAddress)',
];

function hubInterface(events = ROTATION_EVENTS): ethers.Interface {
  return new ethers.Interface(events);
}

function hubContract(iface = hubInterface()): Contract {
  return { interface: iface } as unknown as Contract;
}

function rotationLog(
  iface: ethers.Interface,
  eventName: string,
  contractName: string,
  blockNumber: number,
  marker: string,
  index = 0,
): ethers.Log {
  const encoded = iface.encodeEventLog(iface.getEvent(eventName)!, [
    contractName,
    '0x00000000000000000000000000000000000000c1',
  ]);
  return {
    blockNumber,
    blockHash: `0x${marker.repeat(32)}`,
    transactionHash: `0x${(Number.parseInt(marker, 16) + 1).toString(16).padStart(2, '0').repeat(32)}`,
    index,
    topics: encoded.topics,
    data: encoded.data,
  } as ethers.Log;
}

function logsInRange(logs: ethers.Log[], filter: { fromBlock: number; toBlock: number }): ethers.Log[] {
  return logs.filter((log) => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock);
}

async function flushAsyncWork(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function failoverReadProvider(providers: unknown[]) {
  const client = new RpcFailoverClient(
    () => providers.map((provider, index) => ({
      provider: provider as any,
      rpcUrl: `https://rpc-${index}.example`,
    })),
    async () => { throw new Error('Hub rotation tests must not sign transactions'); },
    () => 'evm:31337',
  );
  return client.read.bind(client);
}

describe('HubRotationPoller', () => {
  it('records startup head without log reads and stop cancels the scheduled poll', async () => {
    vi.useFakeTimers({ now: 0 });
    const provider = {
      getBlockNumber: vi.fn(async () => 1_000),
      getLogs: vi.fn(async () => []),
    };
    const onContractName = vi.fn();
    const poller = new HubRotationPoller({
      readProvider: async (_label, fn) => fn(provider as any),
      intervalMs: 30_000,
      reorgBufferBlocks: 50,
      onContractName,
    });

    try {
      poller.start(hubContract(), HUB_ADDRESS);
      expect(poller.isStarted).toBe(true);
      expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
      expect(provider.getLogs).not.toHaveBeenCalled();

      poller.stop();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
      expect(provider.getLogs).not.toHaveBeenCalled();
      expect(onContractName).not.toHaveBeenCalled();
      expect(poller.isStarted).toBe(false);
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('ignores a delayed in-flight poll result after stop', async () => {
    const iface = hubInterface();
    const delayedLog = rotationLog(iface, 'ContractChanged', 'ContextGraphs', 1_000, '70');
    let releasePoll!: () => void;
    let pollEntered!: () => void;
    const pollGate = new Promise<void>((resolve) => { releasePoll = resolve; });
    const pollEnteredPromise = new Promise<void>((resolve) => { pollEntered = resolve; });
    const provider = {
      getBlockNumber: vi.fn(async () => 1_000),
      getLogs: vi.fn(async () => {
        pollEntered();
        await pollGate;
        return [delayedLog];
      }),
    };
    const onContractName = vi.fn();
    const poller = new HubRotationPoller({
      readProvider: async (_label, fn) => fn(provider as any),
      intervalMs: 30_000,
      reorgBufferBlocks: 50,
      onContractName,
    });

    try {
      await poller.start(hubContract(iface), HUB_ADDRESS);
      const pendingPoll = poller.pollOnce();
      await pollEnteredPromise;

      poller.stop();
      releasePoll();
      await pendingPoll;

      expect(provider.getBlockNumber.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(provider.getLogs).toHaveBeenCalledTimes(1);
      expect(onContractName).not.toHaveBeenCalled();
      expect(poller.isStarted).toBe(false);
    } finally {
      poller.stop();
    }
  });

  it('recovers after a failed periodic poll', async () => {
    vi.useFakeTimers({ now: 0 });
    const hub = hubContract();
    const rotation = hub.interface.encodeEventLog(hub.interface.getEvent('ContractChanged')!, [
      'ContextGraphs',
      '0x00000000000000000000000000000000000000c1',
    ]);
    let head = 1_000;
    let getLogsCalls = 0;
    const provider = {
      getBlockNumber: vi.fn(async () => head),
      getLogs: vi.fn(async () => {
        getLogsCalls++;
        if (getLogsCalls === 1) throw new Error('temporary getLogs failure');
        if (getLogsCalls === 2) {
          return [{
            blockNumber: 1_001,
            blockHash: '0x' + '51'.repeat(32),
            transactionHash: '0x' + '52'.repeat(32),
            index: 0,
            topics: rotation.topics,
            data: rotation.data,
          }];
        }
        return [];
      }),
    };
    const onContractName = vi.fn();
    const poller = new HubRotationPoller({
      readProvider: async (_label, fn) => fn(provider as any),
      intervalMs: 30_000,
      reorgBufferBlocks: 50,
      onContractName,
    });

    try {
      await poller.start(hub, HUB_ADDRESS);
      await Promise.resolve();

      head = 1_001;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onContractName).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(onContractName).toHaveBeenCalledWith('ContextGraphs');
      expect(provider.getLogs).toHaveBeenCalledTimes(2);
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('times out a stalled scheduled log scan and retries the same cursor range', async () => {
    vi.useFakeTimers({ now: 0 });
    const iface = hubInterface();
    const hub = hubContract(iface);
    const rotation = rotationLog(iface, 'ContractChanged', 'ContextGraphs', 1_001, '80');
    let head = 1_000;
    let getLogsCalls = 0;
    const provider = {
      getBlockNumber: vi.fn(async () => head),
      getLogs: vi.fn(async (filter: any) => {
        getLogsCalls++;
        if (getLogsCalls === 1) return new Promise<ethers.Log[]>(() => { /* hung RPC */ });
        return logsInRange([rotation], filter);
      }),
    };
    const onContractName = vi.fn();
    const poller = new HubRotationPoller({
      readProvider: failoverReadProvider([provider]),
      intervalMs: 1_000,
      reorgBufferBlocks: 50,
      onContractName,
    });

    try {
      await poller.start(hub, HUB_ADDRESS);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(provider.getLogs).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(RPC_LOG_SCAN_TIMEOUT_MS - 1);
      expect(provider.getLogs).toHaveBeenCalledTimes(1);
      expect(onContractName).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await flushAsyncWork();

      head = 1_001;
      await vi.advanceTimersByTimeAsync(1_000);
      await flushAsyncWork();

      expect(provider.getLogs).toHaveBeenCalledTimes(2);
      expect(provider.getLogs.mock.calls[1][0]).toMatchObject({
        fromBlock: 951,
        toBlock: 1_001,
      });
      expect(onContractName).toHaveBeenCalledWith('ContextGraphs');
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('times out a stalled scheduled head read and retries without scanning logs', async () => {
    vi.useFakeTimers({ now: 0 });
    const iface = hubInterface();
    const rotation = rotationLog(iface, 'ContractChanged', 'ContextGraphs', 1_001, '82');
    let headCalls = 0;
    const provider = {
      getBlockNumber: vi.fn(async () => {
        headCalls++;
        if (headCalls === 1) return new Promise<number>(() => { /* hung RPC */ });
        return 1_001;
      }),
      getLogs: vi.fn(async (filter: any) => logsInRange([rotation], filter)),
    };
    const onContractName = vi.fn();
    const poller = new HubRotationPoller({
      readProvider: failoverReadProvider([provider]),
      intervalMs: 1_000,
      reorgBufferBlocks: 50,
      onContractName,
    });

    try {
      await poller.start(hubContract(iface), HUB_ADDRESS);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
      expect(provider.getLogs).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RPC_READ_STALL_TIMEOUT_MS - 1);
      expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
      expect(provider.getLogs).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await flushAsyncWork();

      await vi.advanceTimersByTimeAsync(1_000);
      await flushAsyncWork();

      expect(provider.getBlockNumber.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(provider.getLogs.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(provider.getLogs.mock.calls[0][0]).toMatchObject({
        fromBlock: 951,
        toBlock: 1_001,
      });
      expect(onContractName).toHaveBeenCalledWith('ContextGraphs');
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('lets read-provider failover reach a healthy backup after a stalled primary log scan', async () => {
    vi.useFakeTimers({ now: 0 });
    const iface = hubInterface();
    const rotation = rotationLog(iface, 'ContractChanged', 'ContextGraphs', 1_001, '84');
    const primary = {
      getBlockNumber: vi.fn(async () => 1_001),
      getLogs: vi.fn(async () => new Promise<ethers.Log[]>(() => { /* hung primary */ })),
    };
    const backup = {
      getBlockNumber: vi.fn(async () => 1_001),
      getLogs: vi.fn(async (filter: any) => logsInRange([rotation], filter)),
    };
    const onContractName = vi.fn();
    const poller = new HubRotationPoller({
      readProvider: failoverReadProvider([primary, backup]),
      intervalMs: 1_000,
      reorgBufferBlocks: 50,
      onContractName,
    });

    try {
      await poller.start(hubContract(iface), HUB_ADDRESS);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(primary.getLogs).toHaveBeenCalledTimes(1);
      expect(backup.getLogs).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RPC_LOG_SCAN_TIMEOUT_MS + 1);
      await flushAsyncWork();

      expect(backup.getLogs).toHaveBeenCalledTimes(1);
      expect(onContractName).toHaveBeenCalledWith('ContextGraphs');
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent starts into a single scheduled poller', async () => {
    vi.useFakeTimers({ now: 0 });
    const provider = {
      getBlockNumber: vi.fn(async () => 1_000),
      getLogs: vi.fn(async () => []),
    };
    const poller = new HubRotationPoller({
      readProvider: async (_label, fn) => fn(provider as any),
      intervalMs: 30_000,
      reorgBufferBlocks: 50,
      onContractName: vi.fn(),
    });

    try {
      const firstStart = poller.start(hubContract(), HUB_ADDRESS);
      const secondStart = poller.start(hubContract(), HUB_ADDRESS);

      await Promise.all([firstStart, secondStart]);

      expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
      expect(provider.getLogs).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(provider.getBlockNumber.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(provider.getLogs).toHaveBeenCalledTimes(1);
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('defers startup log reads to the first buffered poll', async () => {
    vi.useFakeTimers({ now: 0 });
    const iface = hubInterface();
    let head = 1_000;
    const logs = [
      rotationLog(iface, 'NewContract', 'RandomSampling', 1_000, '10'),
      rotationLog(iface, 'ContractChanged', 'ContextGraphs', 1_001, '12'),
    ];
    const readCalls: Array<{ label: string; opts: unknown }> = [];
    const provider = {
      getBlockNumber: vi.fn(async () => head),
      getLogs: vi.fn(async (filter: any) => logsInRange(logs, filter)),
    };
    const onContractName = vi.fn();
    const poller = new HubRotationPoller({
      readProvider: async (label, fn, opts) => {
        readCalls.push({ label, opts });
        return fn(provider as any);
      },
      intervalMs: 30_000,
      reorgBufferBlocks: 50,
      onContractName,
    });

    try {
      await poller.start(hubContract(iface), HUB_ADDRESS);
      await flushAsyncWork();

      expect(onContractName).not.toHaveBeenCalled();
      expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
      expect(provider.getLogs).not.toHaveBeenCalled();

      head = 1_001;
      await vi.advanceTimersByTimeAsync(30_000);

      expect(provider.getBlockNumber.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(provider.getLogs).toHaveBeenCalledTimes(1);
      expect(provider.getLogs.mock.calls[0][0]).toMatchObject({
        address: HUB_ADDRESS,
        fromBlock: 951,
        toBlock: 1_001,
      });
      expect(provider.getLogs.mock.calls[0][0].topics[0]).toEqual([
        iface.getEvent('ContractChanged')!.topicHash,
        iface.getEvent('NewContract')!.topicHash,
        iface.getEvent('AssetStorageChanged')!.topicHash,
        iface.getEvent('NewAssetStorage')!.topicHash,
      ]);
      expect(readCalls.find((call) => call.label === 'Hub rotation poll getBlockNumber')?.opts)
        .toEqual({ policy: 'watchdogPointRead' });
      expect(readCalls.find((call) => call.label === 'Hub rotation poll getLogs')?.opts)
        .toEqual({ policy: 'watchdogWideLogScan' });
      expect(onContractName.mock.calls.map((call) => call[0])).toEqual([
        'RandomSampling',
        'ContextGraphs',
      ]);
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('keeps post-start rotations visible when the first interval fires after the reorg buffer', async () => {
    vi.useFakeTimers({ now: 0 });
    const iface = hubInterface();
    let head = 1_000;
    const rotation = rotationLog(iface, 'ContractChanged', 'KnowledgeAssetsLifecycle', 1_001, '18');
    const provider = {
      getBlockNumber: vi.fn(async () => head),
      getLogs: vi.fn(async (filter: any) => logsInRange([rotation], filter)),
    };
    const onContractName = vi.fn();
    const poller = new HubRotationPoller({
      readProvider: async (_label, fn) => fn(provider as any),
      intervalMs: 30_000,
      reorgBufferBlocks: 50,
      onContractName,
    });

    try {
      await poller.start(hubContract(iface), HUB_ADDRESS);
      await flushAsyncWork();
      expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
      expect(provider.getLogs).not.toHaveBeenCalled();

      head = 1_052;
      await vi.advanceTimersByTimeAsync(30_000);

      expect(provider.getLogs).toHaveBeenCalledTimes(1);
      expect(provider.getLogs.mock.calls[0][0]).toMatchObject({
        fromBlock: 951,
        toBlock: 1_052,
      });
      expect(onContractName).toHaveBeenCalledWith('KnowledgeAssetsLifecycle');
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('applies replacement logs inside the reorg buffer', async () => {
    const iface = hubInterface();
    let head = 1_000;
    const logs = [
      rotationLog(iface, 'ContractChanged', 'UntrackedAtStartup', 1_000, '20'),
    ];
    const provider = {
      getBlockNumber: vi.fn(async () => head),
      getLogs: vi.fn(async (filter: any) => logsInRange(logs, filter)),
    };
    const onContractName = vi.fn();
    const poller = new HubRotationPoller({
      readProvider: async (_label, fn) => fn(provider as any),
      intervalMs: 30_000,
      reorgBufferBlocks: 50,
      onContractName,
    });

    try {
      await poller.start(hubContract(iface), HUB_ADDRESS);
      await poller.pollOnce();
      expect(onContractName).toHaveBeenCalledWith('UntrackedAtStartup');

      logs.splice(0, logs.length, rotationLog(iface, 'ContractChanged', 'ContextGraphs', 1_000, '22'));
      head = 1_001;
      await poller.pollOnce();

      expect(provider.getLogs).toHaveBeenCalledTimes(2);
      expect(provider.getLogs.mock.calls[1][0]).toMatchObject({
        fromBlock: 951,
        toBlock: 1_001,
      });
      expect(onContractName).toHaveBeenCalledTimes(2);
      expect(onContractName).toHaveBeenCalledWith('ContextGraphs');
    } finally {
      poller.stop();
    }
  });

  it('processes a new rotation log at the previous cursor block', async () => {
    const iface = hubInterface();
    let head = 1_000;
    let exposeReorgLog = false;
    const log = rotationLog(iface, 'ContractChanged', 'ContextGraphs', 1_000, '40');
    const provider = {
      getBlockNumber: vi.fn(async () => head),
      getLogs: vi.fn(async (filter: any) => (
        exposeReorgLog ? logsInRange([log], filter) : []
      )),
    };
    const onContractName = vi.fn();
    const poller = new HubRotationPoller({
      readProvider: async (_label, fn) => fn(provider as any),
      intervalMs: 30_000,
      reorgBufferBlocks: 50,
      onContractName,
    });

    try {
      await poller.start(hubContract(iface), HUB_ADDRESS);
      await poller.pollOnce();

      exposeReorgLog = true;
      head = 1_001;
      await poller.pollOnce();

      expect(provider.getLogs).toHaveBeenCalledTimes(2);
      expect(provider.getLogs.mock.calls[1][0]).toMatchObject({
        fromBlock: 951,
        toBlock: 1_001,
      });
      expect(onContractName).toHaveBeenCalledWith('ContextGraphs');
    } finally {
      poller.stop();
    }
  });

  it('deduplicates logs across overlapping buffered polls', async () => {
    const iface = hubInterface();
    let head = 1_000;
    let logs: ethers.Log[] = [];
    const repeatedLog = rotationLog(iface, 'ContractChanged', 'ContextGraphs', 1_001, '60');
    const provider = {
      getBlockNumber: vi.fn(async () => head),
      getLogs: vi.fn(async (filter: any) => logsInRange(logs, filter)),
    };
    const onContractName = vi.fn();
    const poller = new HubRotationPoller({
      readProvider: async (_label, fn) => fn(provider as any),
      intervalMs: 30_000,
      reorgBufferBlocks: 50,
      onContractName,
    });

    try {
      await poller.start(hubContract(iface), HUB_ADDRESS);

      logs = [repeatedLog];
      head = 1_001;
      await poller.pollOnce();

      head = 1_002;
      await poller.pollOnce();

      expect(onContractName).toHaveBeenCalledTimes(1);
      expect(onContractName).toHaveBeenCalledWith('ContextGraphs');
    } finally {
      poller.stop();
    }
  });

  it('does not move the high-water mark backwards when the next head is lower', async () => {
    const iface = hubInterface();
    let head = 1_000;
    const provider = {
      getBlockNumber: vi.fn(async () => head),
      getLogs: vi.fn(async (_filter: any) => []),
    };
    const poller = new HubRotationPoller({
      readProvider: async (_label, fn) => fn(provider as any),
      intervalMs: 30_000,
      reorgBufferBlocks: 50,
      onContractName: vi.fn(),
    });

    try {
      await poller.start(hubContract(iface), HUB_ADDRESS);
      await poller.pollOnce();

      head = 900;
      await poller.pollOnce();

      head = 1_001;
      await poller.pollOnce();

      expect(provider.getLogs).toHaveBeenCalledTimes(3);
      expect(provider.getLogs.mock.calls[1][0]).toMatchObject({
        fromBlock: 850,
        toBlock: 900,
      });
      expect(provider.getLogs.mock.calls[2][0]).toMatchObject({
        fromBlock: 951,
        toBlock: 1_001,
      });
    } finally {
      poller.stop();
    }
  });

  it('refuses a partial Hub rotation event ABI before scheduling reads', async () => {
    const iface = hubInterface([
      'event NewContract(string contractName, address newContractAddress)',
      'event ContractChanged(string contractName, address newContractAddress)',
      'event NewAssetStorage(string contractName, address newContractAddress)',
    ]);
    const provider = {
      getBlockNumber: vi.fn(async () => 1_000),
      getLogs: vi.fn(async () => []),
    };
    const poller = new HubRotationPoller({
      readProvider: async (_label, fn) => fn(provider as any),
      intervalMs: 30_000,
      reorgBufferBlocks: 50,
      onContractName: vi.fn(),
    });

    expect(() => poller.start(hubContract(iface), HUB_ADDRESS))
      .toThrow('Hub ABI is missing required rotation event AssetStorageChanged');

    expect(provider.getBlockNumber).not.toHaveBeenCalled();
    expect(provider.getLogs).not.toHaveBeenCalled();
    expect(poller.isStarted).toBe(false);
  });
});
