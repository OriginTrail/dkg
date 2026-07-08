import { afterEach, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  Logger,
  TypedEventBus,
  encodeWorkspacePublishRequest,
  type LogRecord,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { SharedMemoryHandler } from '@origintrail-official/dkg-publisher';
import { DKGAgent } from '../src/index.js';

const LOCAL_PEER_ID = '12D3KooWKaLifecycleReceiver';
const PUBLISHER_PEER_ID = '12D3KooWPublisherPeer';
const AUTHOR_AGENT_ADDRESS = '0x000000000000000000000000000000000000c10A';
const CONTEXT_GRAPH_ID = 'ka-lifecycle-cg';
const ROOT_ENTITY = 'http://example.org/ka-lifecycle/root';
const ASSET_UAL = 'did:dkg:evm:31337/0x000000000000000000000000000000000000c10a/7';

async function createReceiverAgent(): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: `ka-lifecycle-receiver-${Math.random().toString(36).slice(2)}`,
    chainAdapter: new MockChainAdapter(),
  });
  Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
    value: LOCAL_PEER_ID,
    configurable: true,
  });
  agent.publisher.setIdentityId(42n);
  return agent;
}

function captureLogs(): LogRecord[] {
  const entries: LogRecord[] = [];
  Logger.setSink((entry) => entries.push(entry));
  return entries;
}

function swmLifecycleLogs(entries: readonly LogRecord[]): LogRecord[] {
  return entries.filter((entry) => (
    entry.message.includes('ka_lifecycle') &&
    entry.message.includes('stage=swm_share')
  ));
}

describe('KA receiver lifecycle logs', () => {
  afterEach(() => {
    Logger.setSink(null);
  });

  it('logs a substrate-applied SWM receive by assetUal', async () => {
    const agent = await createReceiverAgent();
    const entries = captureLogs();

    (agent as unknown as {
      getOrCreateSharedMemoryHandler(): {
        handle(data: Uint8Array, fromPeerId: string): Promise<unknown>;
      };
    }).getOrCreateSharedMemoryHandler = () => ({
      handle: async () => ({
        applied: true,
        assetUal: ASSET_UAL,
        cgId: CONTEXT_GRAPH_ID,
        shareOperationId: 'share-op-asset-7',
        publisherPeerId: LOCAL_PEER_ID,
        insertedTriples: 3,
      }),
    });

    await (agent as unknown as {
      handleSwmUpdate(data: Uint8Array, fromPeerId: string): Promise<Uint8Array>;
    }).handleSwmUpdate(new Uint8Array([1, 2, 3]), PUBLISHER_PEER_ID);

    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`assetUal=${ASSET_UAL}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('event=swm_update_applied'),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining(`localPeerId=${LOCAL_PEER_ID}`),
    );
    expect(swmLifecycleLogs(entries).map((entry) => entry.message)).toContainEqual(
      expect.stringContaining('localNodeIdentityId=42'),
    );
  });

  it('threads SWM assetUal from workspace request identity fields', async () => {
    const store = new OxigraphStore();
    let resolverInput: { agentAddress: string; kaNumber: string } | undefined;
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      assetUalForKaIdentity: async (input: { agentAddress: string; kaNumber: string }) => {
        resolverInput = input;
        return ASSET_UAL;
      },
    } as unknown as ConstructorParameters<typeof SharedMemoryHandler>[2]);

    const msg = encodeWorkspacePublishRequest({
      shareOperationId: 'share-op-asset-7',
      contextGraphId: CONTEXT_GRAPH_ID,
      publisherPeerId: PUBLISHER_PEER_ID,
      nquads: new TextEncoder().encode(
        `<${ROOT_ENTITY}> <http://schema.org/name> "Receiver lifecycle" .`,
      ),
      manifest: [{ rootEntity: ROOT_ENTITY }],
      timestampMs: Date.now(),
      agentAddress: AUTHOR_AGENT_ADDRESS,
      kaNumber: '7',
    });

    const outcome = await handler.handle(msg, PUBLISHER_PEER_ID);

    expect(resolverInput).toEqual({ agentAddress: AUTHOR_AGENT_ADDRESS, kaNumber: '7' });
    expect(outcome).toMatchObject({ applied: true, assetUal: ASSET_UAL });
  });
});
