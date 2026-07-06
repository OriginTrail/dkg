import { describe, expect, it, vi } from 'vitest';
import { Contract, ethers } from 'ethers';
import { HubRotationPoller } from '../src/hub-rotation-poller.js';

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

describe('HubRotationPoller', () => {
  it('does not block startup on bootstrap log IO and stop cancels the late bootstrap', async () => {
    vi.useFakeTimers({ now: 0 });
    let releaseSeed!: () => void;
    let seedEntered!: () => void;
    const seedGate = new Promise<void>((resolve) => { releaseSeed = resolve; });
    const seedEnteredPromise = new Promise<void>((resolve) => { seedEntered = resolve; });
    const provider = {
      getBlockNumber: vi.fn(async () => 1_000),
      getLogs: vi.fn(async () => {
        seedEntered();
        await seedGate;
        return [];
      }),
    };
    const poller = new HubRotationPoller({
      readProvider: async (_label, fn) => fn(provider as any),
      intervalMs: 30_000,
      reorgBufferBlocks: 50,
      onContractName: vi.fn(),
    });

    try {
      await expect(poller.start(hubContract(), HUB_ADDRESS)).resolves.toBeUndefined();
      expect(poller.isStarted).toBe(true);

      await seedEnteredPromise;
      poller.stop();
      releaseSeed();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
      expect(provider.getLogs).toHaveBeenCalledTimes(1);
      expect(poller.isStarted).toBe(false);
    } finally {
      poller.stop();
      vi.useRealTimers();
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
        if (getLogsCalls === 2) throw new Error('temporary getLogs failure');
        if (getLogsCalls === 3) {
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
      expect(provider.getLogs).toHaveBeenCalledTimes(3);
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent starts while bootstrap is still in flight', async () => {
    vi.useFakeTimers({ now: 0 });
    let releaseSeed!: () => void;
    let seedEntered!: () => void;
    const seedGate = new Promise<void>((resolve) => { releaseSeed = resolve; });
    const seedEnteredPromise = new Promise<void>((resolve) => { seedEntered = resolve; });
    let getLogsCalls = 0;
    const provider = {
      getBlockNumber: vi.fn(async () => 1_000),
      getLogs: vi.fn(async () => {
        getLogsCalls++;
        if (getLogsCalls === 1) {
          seedEntered();
          await seedGate;
        }
        return [];
      }),
    };
    const poller = new HubRotationPoller({
      readProvider: async (_label, fn) => fn(provider as any),
      intervalMs: 30_000,
      reorgBufferBlocks: 50,
      onContractName: vi.fn(),
    });

    try {
      const firstStart = poller.start(hubContract(), HUB_ADDRESS);
      await seedEnteredPromise;
      const secondStart = poller.start(hubContract(), HUB_ADDRESS);

      releaseSeed();
      await Promise.all([firstStart, secondStart]);
      await flushAsyncWork();

      expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
      expect(provider.getLogs).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(provider.getBlockNumber).toHaveBeenCalledTimes(2);
      expect(provider.getLogs).toHaveBeenCalledTimes(2);
    } finally {
      poller.stop();
      vi.useRealTimers();
    }
  });

  it('probes startup logs without dispatching and dispatches the first buffered poll', async () => {
    vi.useFakeTimers({ now: 0 });
    const iface = hubInterface();
    let head = 1_000;
    const logs = [
      rotationLog(iface, 'NewContract', 'RandomSampling', 1_000, '10'),
      rotationLog(iface, 'ContractChanged', 'ContextGraphs', 1_001, '12'),
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
      await flushAsyncWork();

      expect(onContractName).not.toHaveBeenCalled();
      expect(provider.getLogs.mock.calls[0][0]).toMatchObject({
        address: HUB_ADDRESS,
        fromBlock: 950,
        toBlock: 1_000,
      });
      expect(provider.getLogs.mock.calls[0][0].topics[0]).toEqual([
        iface.getEvent('ContractChanged')!.topicHash,
        iface.getEvent('NewContract')!.topicHash,
        iface.getEvent('AssetStorageChanged')!.topicHash,
        iface.getEvent('NewAssetStorage')!.topicHash,
      ]);

      head = 1_001;
      await vi.advanceTimersByTimeAsync(30_000);

      expect(provider.getLogs).toHaveBeenCalledTimes(2);
      expect(provider.getLogs.mock.calls[1][0]).toMatchObject({
        fromBlock: 951,
        toBlock: 1_001,
      });
      expect(onContractName.mock.calls.map((call) => call[0])).toEqual([
        'RandomSampling',
        'ContextGraphs',
      ]);
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
      await flushAsyncWork();
      expect(onContractName).not.toHaveBeenCalled();

      logs.splice(0, logs.length, rotationLog(iface, 'ContractChanged', 'ContextGraphs', 1_000, '22'));
      head = 1_001;
      await poller.pollOnce();

      expect(provider.getLogs).toHaveBeenCalledTimes(2);
      expect(provider.getLogs.mock.calls[1][0]).toMatchObject({
        fromBlock: 951,
        toBlock: 1_001,
      });
      expect(onContractName).toHaveBeenCalledTimes(1);
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
      await flushAsyncWork();

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
      await flushAsyncWork();

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
      await flushAsyncWork();

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

    await expect(poller.start(hubContract(iface), HUB_ADDRESS))
      .rejects.toThrow('Hub ABI is missing required rotation event AssetStorageChanged');

    expect(provider.getBlockNumber).not.toHaveBeenCalled();
    expect(provider.getLogs).not.toHaveBeenCalled();
    expect(poller.isStarted).toBe(false);
  });
});
