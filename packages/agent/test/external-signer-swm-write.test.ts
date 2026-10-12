/**
 * Shared-memory writes of a node whose gossip signer is an author key held by
 * an external signer. share() and conditionalShare() sign the write's gossip
 * envelope before the write commits: a signer that refuses aborts the write
 * with nothing stored, so a conditional write stays retryable as it was. The
 * signed envelope travels with the payload through the write result, so the
 * fan-out after the commit sends exactly the bytes that were signed (the
 * curator-ack gate is asked with the same bytes). A fan-out that still has to
 * sign after its write committed reports a refusal as a failed fan-out, never
 * as a failed write.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, connectRemoteSigners, type OperationalSigning } from '@origintrail-official/dkg-chain';
import {
  Logger,
  computeGossipSigningPayload,
  createOperationContext,
  decodeGossipEnvelope,
  decodeWorkspacePublishRequest,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { HARDHAT_KEYS } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';

const PAYER_TOKEN = 'swm-write-payer-credential-3c4d5e6f7a8b';
const AUTHOR_TOKEN = 'swm-write-author-credential-8b7a6f5e4d3c';
const payer = new ethers.Wallet(HARDHAT_KEYS.PUBLISHER);
const author = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);
const CG = 'external-signer-swm-write';
const ITEM = 'urn:external-signer-swm-write:item';
const VALUE = 'http://schema.org/value';
const REFUSAL = 'message signing refused by policy';

/** A mock chain whose operational wallets sign through an external signer, as it reports. */
class ExternallySignedMockChain extends MockChainAdapter {
  operationalSigning(): OperationalSigning {
    return { external: true, payerAddresses: [this.signerAddress] };
  }
}

/** The agent internals these tests drive or observe. */
interface WriterInternals {
  gossip: { publish(topic: string, data: Uint8Array): Promise<void> };
  swmGossipPublishFailures: Map<string, number>;
  resolveCuratorAckTarget(
    contextGraphId: string,
    opts: { awaitCuratorAck?: boolean; curatorAckTimeoutMs?: number } | undefined,
  ): Promise<{ peerIds: string[]; timeoutMs: number } | undefined>;
  confirmCuratorApplied(
    contextGraphId: string,
    peerIds: string[],
    message: Uint8Array,
    timeoutMs: number,
  ): Promise<{ applied: boolean; rejected?: boolean }>;
  isPrivateContextGraph(contextGraphId: string): Promise<boolean>;
  resolveCuratorPeerIdsForCg(contextGraphId: string): Promise<{ peerIds: string[]; curatorIsLocal: boolean }>;
}

let refuseMessages = false;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  refuseMessages = false;
  vi.restoreAllMocks();
  Logger.setSink(null);
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A node holding no key: its default agent is the signer's author key, which signs its gossip. */
async function keylessWriter(): Promise<{ agent: DKGAgent; internals: WriterInternals; fake: FakeSigner; sent: Uint8Array[] }> {
  const fake = await startFakeRemoteSigner({
    credentials: [
      { token: PAYER_TOKEN, keys: [payer.privateKey] },
      { token: AUTHOR_TOKEN, keys: [author.privateKey] },
    ],
    // A policy refusal, not an unsupported method: the client has no fallback for it.
    reject: (method) => (refuseMessages && method === 'eth_sign' ? { code: -32000, message: REFUSAL } : undefined),
  });
  const remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
  const agent = await DKGAgent.create({
    name: 'KeylessWriter',
    store: new OxigraphStore(),
    chainAdapter: new ExternallySignedMockChain('mock:31337', payer.address),
    chainConfig: { rpcUrl: 'http://127.0.0.1:1', hubAddress: ethers.ZeroAddress, authors: remote.authors },
    nodeRole: 'edge',
  });
  cleanups.push(async () => {
    await agent.stop().catch(() => {});
    remote.destroy();
    await fake.close();
  });
  await agent.start();
  expect(agent.getDefaultAgentAddress()).toBe(author.address);
  await agent.createContextGraph({ id: CG, name: 'External signer writes' });
  const internals = agent as unknown as WriterInternals;
  const sent: Uint8Array[] = [];
  vi.spyOn(internals.gossip, 'publish').mockImplementation(async (_topic, data) => {
    sent.push(data);
  });
  return { agent, internals, fake, sent };
}

function item(value: string): Quad[] {
  return [{ subject: ITEM, predicate: VALUE, object: `"${value}"`, graph: '' }];
}

async function storedValues(agent: DKGAgent): Promise<string[]> {
  const result = await agent.query(`SELECT ?value WHERE { <${ITEM}> <${VALUE}> ?value }`, {
    contextGraphId: CG,
    graphSuffix: '_shared_memory',
  });
  return result.bindings.map((row) => String(row['value']));
}

/** The envelope bytes the author key signed, decoded, with the request it carries. */
function signedEnvelope(wire: Uint8Array) {
  const envelope = decodeGossipEnvelope(wire);
  const signed = computeGossipSigningPayload(envelope.type, envelope.contextGraphId, envelope.timestamp, envelope.payload);
  return { envelope, signed, request: decodeWorkspacePublishRequest(envelope.payload) };
}

describe('shared-memory writes signed by an external author key', () => {
  it('stores nothing when the signer refuses a conditional write, which can then be retried as it was', async () => {
    const { agent, fake, sent } = await keylessWriter();
    await agent.share(CG, item('0'));
    expect(await storedValues(agent)).toEqual(['"0"']);

    refuseMessages = true;
    const before = fake.calls('eth_sign').length;
    await expect(agent.conditionalShare(CG, item('1'), [{ subject: ITEM, predicate: VALUE, expectedValue: '"0"' }]))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_REJECTED' });
    expect(fake.calls('eth_sign')).toHaveLength(before + 1);
    expect(await storedValues(agent)).toEqual(['"0"']);
    await expect(agent.share(CG, item('2'))).rejects.toMatchObject({ code: 'REMOTE_SIGNER_REJECTED' });
    expect(await storedValues(agent)).toEqual(['"0"']);
    expect(sent).toHaveLength(1);

    refuseMessages = false;
    const { shareOperationId } = await agent.conditionalShare(
      CG,
      item('1'),
      [{ subject: ITEM, predicate: VALUE, expectedValue: '"0"' }],
    );
    expect(await storedValues(agent)).toEqual(['"1"']);
    expect(sent).toHaveLength(2);
    expect(signedEnvelope(sent[1]!).request.shareOperationId).toBe(shareOperationId);
  });

  it('fans out exactly the envelope it signed before the write committed', async () => {
    const { agent, fake, sent } = await keylessWriter();
    const fanOut = vi.spyOn(agent, 'publishWorkspaceGossip');
    const before = fake.calls('eth_sign').length;
    const { shareOperationId } = await agent.share(CG, item('0'));
    // The fan-out is handed the payload together with its prepared envelope.
    expect(fanOut).toHaveBeenCalledTimes(1);
    const payload = fanOut.mock.calls[0]![1] as { envelope?: Uint8Array };
    expect(ethers.hexlify(payload.envelope!)).toBe(ethers.hexlify(sent[0]!));

    const requests = fake.calls('eth_sign').slice(before);
    expect(requests).toHaveLength(1);
    expect(sent).toHaveLength(1);
    const { envelope, signed, request } = signedEnvelope(sent[0]!);
    expect(envelope.agentAddress).toBe(author.address);
    expect(requests[0]!.authorization).toBe(`Bearer ${AUTHOR_TOKEN}`);
    expect(requests[0]!.params).toEqual([author.address.toLowerCase(), ethers.hexlify(signed)]);
    expect(ethers.verifyMessage(signed, ethers.hexlify(envelope.signature))).toBe(author.address);
    expect(request.shareOperationId).toBe(shareOperationId);
  });

  it('asks the curator-ack gate with the envelope it signed, and only once it is signed', async () => {
    const { agent, internals, fake, sent } = await keylessWriter();
    vi.spyOn(internals, 'resolveCuratorAckTarget').mockResolvedValue({ peerIds: ['curator-peer'], timeoutMs: 1_000 });
    const confirmed: Uint8Array[] = [];
    vi.spyOn(internals, 'confirmCuratorApplied').mockImplementation(async (_cg, peerIds, message, timeoutMs) => {
      expect(peerIds).toEqual(['curator-peer']);
      expect(timeoutMs).toBe(1_000);
      confirmed.push(message);
      return { applied: true };
    });
    const before = fake.calls('eth_sign').length;
    await agent.share(CG, item('0'), { awaitCuratorAck: true });
    expect(fake.calls('eth_sign')).toHaveLength(before + 1);
    expect(confirmed).toHaveLength(1);
    expect(ethers.hexlify(sent[0]!)).toBe(ethers.hexlify(confirmed[0]!));

    // A refused signature never reaches the curator.
    refuseMessages = true;
    await expect(agent.conditionalShare(CG, item('1'), [{ subject: ITEM, predicate: VALUE, expectedValue: '"0"' }], {
      awaitCuratorAck: true,
    })).rejects.toMatchObject({ code: 'REMOTE_SIGNER_REJECTED' });
    expect(confirmed).toHaveLength(1);
    expect(await storedValues(agent)).toEqual(['"0"']);

    // The promote path's confirmer signs the envelope itself.
    refuseMessages = false;
    const confirm = await agent.buildCuratorAckConfirmer(CG, await agent.resolveWorkspaceGossipSigningAgent(CG), {
      awaitCuratorAck: true,
    }, createOperationContext('share'));
    await expect(confirm!(new Uint8Array([1, 2, 3]))).resolves.toEqual({ applied: true });
    expect(decodeGossipEnvelope(confirmed[1]!).agentAddress).toBe(author.address);
  });

  it('applies the curator-ack gate only to a private graph whose curator is another node', async () => {
    const { internals } = await keylessWriter();
    expect(await internals.resolveCuratorAckTarget(CG, undefined)).toBeUndefined();
    const isPrivate = vi.spyOn(internals, 'isPrivateContextGraph').mockResolvedValue(false);
    expect(await internals.resolveCuratorAckTarget(CG, { awaitCuratorAck: true })).toBeUndefined();
    isPrivate.mockResolvedValue(true);
    const curator = vi.spyOn(internals, 'resolveCuratorPeerIdsForCg')
      .mockResolvedValue({ peerIds: [], curatorIsLocal: true });
    expect(await internals.resolveCuratorAckTarget(CG, { awaitCuratorAck: true })).toBeUndefined();
    curator.mockResolvedValue({ peerIds: ['curator-peer'], curatorIsLocal: false });
    expect(await internals.resolveCuratorAckTarget(CG, { awaitCuratorAck: true, curatorAckTimeoutMs: 2_500 }))
      .toEqual({ peerIds: ['curator-peer'], timeoutMs: 2_500 });
  });

  it('reports a fan-out it cannot sign after its write committed as a failed fan-out, not a failed write', async () => {
    const { agent, internals, sent } = await keylessWriter();
    const signer = await agent.resolveWorkspaceGossipSigningAgent(CG);
    expect(signer?.agentAddress).toBe(author.address);
    const warnings: string[] = [];
    Logger.setSink((record) => {
      if (record.level === 'warn') warnings.push(record.message);
    });

    refuseMessages = true;
    await expect(agent.publishWorkspaceGossip(CG, new Uint8Array([1, 2, 3]), createOperationContext('share'), signer))
      .resolves.toBeUndefined();
    expect(sent).toEqual([]);
    expect(internals.swmGossipPublishFailures.get(CG)).toBe(1);
    expect(warnings.some((message) => message.includes('Gossip publish FAILED') && message.includes(REFUSAL))).toBe(true);
  });
});
