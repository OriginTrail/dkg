// SPDX-License-Identifier: Apache-2.0

/**
 * The retirement of `Hub_rotation_poll_getBlockNumber` /
 * `Hub_rotation_poll_getLogs`.
 *
 * The listener itself stays — its interval, its dedupe and its
 * `onContractName` contract are what the whole Hub-binding invalidation rests
 * on — but every chain request it used to make is now served by the one log.
 * The live scan below it is the FALLBACK for a log that cannot prove it holds
 * the window, and the two never run for the same window.
 */

import { describe, expect, it, vi } from 'vitest';
import { Contract, ethers } from 'ethers';

import { HubRotationPoller } from '../src/hub-rotation-poller.js';
import type { ChainEventLogHubRotationWindow } from '../src/chain-event-log-binding.js';

const HUB_ADDRESS = '0x0000000000000000000000000000000000000001';

function hubContract(): Contract {
  return {
    interface: new ethers.Interface([
      'event NewContract(string contractName, address newContractAddress)',
      'event ContractChanged(string contractName, address newContractAddress)',
      'event NewAssetStorage(string contractName, address newContractAddress)',
      'event AssetStorageChanged(string contractName, address newContractAddress)',
    ]),
  } as unknown as Contract;
}

function window(
  fromBlockNumber: number,
  throughBlockNumber: number,
  rotations: ReadonlyArray<{ blockNumber: number; logIndex: number; contractName: string }>,
): ChainEventLogHubRotationWindow {
  return Object.freeze({ fromBlockNumber, throughBlockNumber, rotations: Object.freeze(rotations) });
}

interface Harness {
  readonly poller: HubRotationPoller;
  readonly names: string[];
  readonly readProvider: ReturnType<typeof vi.fn>;
  readonly logSource: ReturnType<typeof vi.fn>;
}

function harness(
  answers: ReadonlyArray<ChainEventLogHubRotationWindow | undefined>,
  liveProvider?: Record<string, unknown>,
): Harness {
  const names: string[] = [];
  let call = 0;
  const logSource = vi.fn(async () => answers[Math.min(call++, answers.length - 1)]);
  const readProvider = vi.fn(async (
    _label: string,
    fn: (provider: unknown) => Promise<unknown>,
  ) => fn(liveProvider ?? {}));
  const poller = new HubRotationPoller({
    readProvider: readProvider as never,
    intervalMs: 30_000,
    reorgBufferBlocks: 50,
    onContractName: (name) => { names.push(name); },
    logSource: logSource as never,
  });
  return { poller, names, readProvider, logSource };
}

describe('HubRotationPoller over the one log', () => {
  it('issues ZERO chain requests once the log can answer the window', async () => {
    const h = harness([
      window(1_001, 1_000, []),
      window(951, 1_050, [
        { blockNumber: 1_010, logIndex: 0, contractName: 'ContextGraphStorage' },
      ]),
    ]);
    h.poller.start(hubContract(), HUB_ADDRESS);
    // `start` schedules the baseline through `runExclusive`; await it before
    // the poll so the two do not collapse into one.
    await h.poller.pollOnce();

    expect(h.names).toEqual(['ContextGraphStorage']);
    // THE assertion this whole change exists for.
    expect(h.readProvider).not.toHaveBeenCalled();
    h.poller.stop();
  });

  it('takes its BASELINE from the log and dispatches nothing for it', async () => {
    const h = harness([
      window(1_001, 1_000, [
        { blockNumber: 500, logIndex: 0, contractName: 'ShouldNeverBeReplayed' },
      ]),
      window(951, 1_000, []),
    ]);
    h.poller.start(hubContract(), HUB_ADDRESS);
    await h.poller.pollOnce();

    // The baseline window carries no rotations by construction; asserting it
    // here pins that the LISTENER also refuses to replay whatever it is handed
    // before it has a cursor.
    expect(h.names).toEqual([]);
    expect(h.readProvider).not.toHaveBeenCalled();
    h.poller.stop();
  });

  it('dispatches a contract name only once across overlapping windows', async () => {
    const rotation = { blockNumber: 1_010, logIndex: 0, contractName: 'ContextGraphStorage' };
    const h = harness([
      window(1_001, 1_000, []),
      window(951, 1_050, [rotation]),
      // The next pass re-reads the reorg buffer, so the same row comes back.
      window(1_001, 1_060, [rotation]),
    ]);
    h.poller.start(hubContract(), HUB_ADDRESS);
    await h.poller.pollOnce();
    await h.poller.pollOnce();

    expect(h.names).toEqual(['ContextGraphStorage']);
    h.poller.stop();
  });

  it('dispatches a DIFFERENT rotation that replaced the same position', async () => {
    const h = harness([
      window(1_001, 1_000, []),
      window(951, 1_050, [
        { blockNumber: 1_010, logIndex: 0, contractName: 'ContextGraphStorage' },
      ]),
      // A reorg put another rotation at the same (block, index).
      window(1_001, 1_060, [
        { blockNumber: 1_010, logIndex: 0, contractName: 'ParametersStorage' },
      ]),
    ]);
    h.poller.start(hubContract(), HUB_ADDRESS);
    await h.poller.pollOnce();
    await h.poller.pollOnce();

    expect(h.names).toEqual(['ContextGraphStorage', 'ParametersStorage']);
    h.poller.stop();
  });

  it('falls back to the live scan when the log cannot prove the window', async () => {
    const encoded = hubContract().interface.encodeEventLog(
      hubContract().interface.getEvent('ContractChanged')!,
      ['ParametersStorage', '0x00000000000000000000000000000000000000c1'],
    );
    const provider = {
      getBlockNumber: vi.fn(async () => 2_000),
      getLogs: vi.fn(async () => [{
        blockNumber: 1_990,
        blockHash: `0x${'aa'.repeat(32)}`,
        transactionHash: `0x${'bb'.repeat(32)}`,
        index: 0,
        topics: encoded.topics,
        data: encoded.data,
      }]),
    };
    const h = harness([undefined], provider);
    h.poller.start(hubContract(), HUB_ADDRESS);
    await h.poller.pollOnce();

    // A cold or lagging log degrades to exactly the pre-log cost, never to a
    // missed rotation.
    expect(h.names).toEqual(['ParametersStorage']);
    expect(provider.getBlockNumber).toHaveBeenCalled();
    expect(provider.getLogs).toHaveBeenCalled();
    h.poller.stop();
  });

  it('never scans the chain for a window the log already answered', async () => {
    const provider = {
      getBlockNumber: vi.fn(async () => 2_000),
      getLogs: vi.fn(async () => []),
    };
    const h = harness([window(1_001, 1_000, []), window(951, 1_050, [])], provider);
    h.poller.start(hubContract(), HUB_ADDRESS);
    await h.poller.pollOnce();
    await h.poller.pollOnce();

    expect(provider.getBlockNumber).not.toHaveBeenCalled();
    expect(provider.getLogs).not.toHaveBeenCalled();
    h.poller.stop();
  });
});
