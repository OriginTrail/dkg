// SPDX-License-Identifier: Apache-2.0

/**
 * The agent's recovery finalizer and its `remains pending` warning.
 *
 * A confirmed publish that no chain endpoint can serve a version view for used to log one line
 * per tick, none of them saying which endpoint failed. These rows drive the finalizer the
 * publisher calls, tick after tick, and pin what reaches the log: the cause once, summaries
 * instead of repeats, one line for the operator, and the same deferral to the publisher every
 * time.
 */

import { describe, expect, it } from 'vitest';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import type { DKGAgent } from '../src/dkg-agent.js';
import { PublishMethods } from '../src/dkg-agent-publish.js';
import { NamedKaRecoveryPendingLog } from '../src/named-ka-recovery-pending-log.js';
import {
  ASSET_NAME,
  AUTHOR,
  CHAIN_ID,
  DEFERRED,
  NO_ENDPOINT_SERVES,
  NO_ENDPOINT_SERVES_WORDS,
  NO_VIEW_DEFERRAL,
  PUBLISHER,
  SEAL_MERKLE_ROOT,
  TX_HASH,
  baseRequest,
  chainWithSnapshotRead,
  currentView,
  positionedEvidence,
  unavailableRead,
} from './_helpers/named-ka-recovery-fixture.js';

type RecoveryInput = Parameters<DKGAgent['finalizeRecoveredQueuedKnowledgeAssetVmPublish']>[0];

/** The agent's recovery finalizer over `chain`, with its log captured and its clock in hand. */
function recoveryFinalizer(chain: unknown) {
  const clock = { now: 1_000_000 };
  const warned: string[] = [];
  const host = {
    chain,
    log: { warn: (_ctx: unknown, line: string) => { warned.push(line); }, info: () => {} },
    namedKaRecoveryPendingLog: new NamedKaRecoveryPendingLog({ now: () => clock.now }),
    // The step after the version read. An agent without the graph's on-chain id defers there.
    getContextGraphOnChainId: async () => undefined,
    _finalizeRecoveredQueuedKnowledgeAssetVmPublish:
      PublishMethods.prototype._finalizeRecoveredQueuedKnowledgeAssetVmPublish,
  };
  const input = {
    walletId: 'wallet-1',
    request: baseRequest(),
    job: { jobId: 'job-1', status: 'included', broadcast: { merkleRoot: SEAL_MERKLE_ROOT } },
    lookup: { txHash: TX_HASH, walletId: 'wallet-1' },
    recovery: positionedEvidence(),
  } as unknown as RecoveryInput;
  /** One recovery tick, ten seconds after the last. Resolves to what the tick rejected with. */
  const tick = async (): Promise<unknown> => {
    clock.now += 10_000;
    return PublishMethods.prototype.finalizeRecoveredQueuedKnowledgeAssetVmPublish
      .call(host as unknown as DKGAgent, input)
      .then(() => undefined, (error: unknown) => error);
  };
  const ticks = async (count: number): Promise<unknown[]> => {
    const errors: unknown[] = [];
    for (let done = 0; done < count; done += 1) errors.push(await tick());
    return errors;
  };
  return { host, warned, tick, ticks };
}

const FIRST_LINE = `Named KA recovery for "${ASSET_NAME}" remains pending: ${NO_VIEW_DEFERRAL}: ${NO_ENDPOINT_SERVES_WORDS}`;

describe('finalizeRecoveredQueuedKnowledgeAssetVmPublish — the pending warning', () => {
  it('names the endpoints once, then stays quiet while every tick still defers', async () => {
    const { warned, ticks } = recoveryFinalizer(chainWithSnapshotRead(unavailableRead(NO_ENDPOINT_SERVES)));

    const errors = await ticks(12);

    // Twelve ticks used to be twelve lines.
    expect(warned).toEqual([FIRST_LINE]);
    // Every one of them is still the same deferral to the publisher.
    expect(errors).toHaveLength(12);
    for (const error of errors) expect(error).toMatchObject(DEFERRED);
  });

  it('tells the operator what to do once no endpoint has served a view for five minutes', async () => {
    const { warned, ticks } = recoveryFinalizer(chainWithSnapshotRead(unavailableRead(NO_ENDPOINT_SERVES)));

    await ticks(31);

    expect(warned).toEqual([
      FIRST_LINE,
      'Operator action needed: publishes confirmed on chain are not finalizing on this node '
      + '(1 pending, 5 min). No configured chain endpoint supplies the current version at one pinned '
      + `block: ${NO_ENDPOINT_SERVES_WORDS}. Fix an endpoint named here, or replace it in the chain RPC `
      + 'configuration (rpcUrl / rpcUrls) and restart the node; the pending publishes then finalize '
      + 'without being sent again.',
    ]);
  });

  it('a version view that is read ends the run, even though recovery then defers for another reason', async () => {
    let serving = false;
    const failing = unavailableRead(NO_ENDPOINT_SERVES);
    const { warned, tick, ticks } = recoveryFinalizer(chainWithSnapshotRead(
      (kaId, options) => (serving ? Promise.resolve(currentView()) : failing(kaId, options)),
    ));

    await ticks(24);
    serving = true;
    // An endpoint answers now. Recovery gets past the version read and stops at the next step.
    expect(await tick()).toMatchObject({
      ...DEFERRED,
      message: `Named KA recovery rejected for "${ASSET_NAME}": context graph 1 has no local on-chain id binding`,
    });
    serving = false;
    // Without that read this stretch would have completed five minutes of one reason.
    await ticks(29);

    expect(warned).toEqual([
      FIRST_LINE,
      `Named KA recovery for "${ASSET_NAME}" remains pending: Named KA recovery rejected for "${ASSET_NAME}": `
      + 'context graph 1 has no local on-chain id binding',
      // The first reason again, as a change, and no operator line: its run is 290 s old.
      FIRST_LINE,
    ]);
  });

  it('a finalized recovery clears the asset, so a later deferral is reported again', async () => {
    const { host, warned, tick } = recoveryFinalizer(chainWithSnapshotRead(unavailableRead(NO_ENDPOINT_SERVES)));
    const deferring = host._finalizeRecoveredQueuedKnowledgeAssetVmPublish;

    await tick();
    await tick();
    expect(warned).toEqual([FIRST_LINE]);

    host._finalizeRecoveredQueuedKnowledgeAssetVmPublish = async () => {};
    expect(await tick()).toBeUndefined();
    host._finalizeRecoveredQueuedKnowledgeAssetVmPublish = deferring;
    await tick();

    expect(warned).toEqual([FIRST_LINE, FIRST_LINE]);
  });

  it('from the chain adapter to the log line: a refused pinned read is named, and its URL is not', async () => {
    // The real adapter over one scripted endpoint that serves `latest` reads and refuses the
    // read pinned to a block number, the way an endpoint without historical state does.
    const url = 'https://only.example/v3/SECRET-PATH-KEY?apikey=SECRET-QUERY-KEY';
    const adapter = new EVMChainAdapter({
      rpcUrl: url,
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      hubAddress: '0x0000000000000000000000000000000000000001',
      chainId: CHAIN_ID,
      staticNetwork: false,
      finalityConfirmations: 1,
    } as never) as unknown as Record<string, unknown>;
    adapter.initialized = true;
    adapter.init = async () => {};
    adapter.ensureConfiguredStaticChainIdValidated = async () => 31337n;
    adapter.contracts = { knowledgeAssetStorage: { target: `0x${'33'.repeat(20)}` } };
    adapter.providers = [{
      async getNetwork() { return { chainId: 31337n }; },
      async getBlock() { return { number: 500, hash: `0x${'50'.repeat(32)}` }; },
    }];
    adapter.rebindContract = () => ({
      async getLatestMerkleRoot() {
        // The shape ethers gives an HTTP 400: the request URL, key and all, is in the message.
        throw Object.assign(new Error(`server response 400 Bad Request (request={ url: "${url}" })`), {
          code: 'SERVER_ERROR',
          response: { statusCode: 400 },
          info: { requestUrl: url, responseStatus: '400 Bad Request' },
        });
      },
      async getKnowledgeAssetUpdateContext() { return { 0: 1n, length: 7 }; },
      async getLatestMerkleRootAuthor() { return AUTHOR; },
      async getLatestMerkleRootPublisher() { return PUBLISHER; },
    });
    const { warned, ticks } = recoveryFinalizer(adapter);

    // Each tick spends the adapter's one in-place retry on the refusing endpoint, so few of them.
    const errors = await ticks(3);

    expect(warned).toEqual([
      `Named KA recovery for "${ASSET_NAME}" remains pending: ${NO_VIEW_DEFERRAL}: `
      + 'endpoint 1 of 1 (only.example) refused a block-pinned read (http 400)',
    ]);
    for (const error of errors) expect(error).toMatchObject(DEFERRED);
    const produced = [...warned, ...errors.map((error) => (error as Error).message)].join('\n');
    expect(produced).not.toContain('SECRET');
    expect(produced).not.toContain('apikey');
    expect(produced).not.toContain('://');
  });
});
