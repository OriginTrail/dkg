/**
 * Storage-ACK transport pin: ACK collection MUST ride the libp2p direct
 * protocol `/dkg/10.0.0/storage-ack` — NOT GossipSub.
 *
 * Audit findings covered:
 *   A-9 (HIGH) — pins that the agent package uses
 *        `PROTOCOL_STORAGE_ACK = '/dkg/10.0.0/storage-ack'` for ACK wiring
 *        and NEVER publishes ACKs over GossipSub.
 *
 * This is a static-scan test (no real libp2p dial needed). Spying on the
 * real dial inside a hermetic vitest run adds environment flakiness with
 * no additional guarantee — if the constant, the router registration, or
 * the dial site diverges from `'/dkg/10.0.0/storage-ack'`, this test
 * flips RED. See also ack-eip191-agent-extra.test.ts for the constant
 * pin.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  PROTOCOL_STORAGE_ACK,
  PROTOCOL_VERIFY_PROPOSAL,
  RELIABLE_ENVELOPE_VERSION,
  TypedEventBus,
  decodeStorageACK,
  decodeVerifyApproval,
  encodePublishIntent,
  encodeReliableEnvelope,
  encodeVerifyProposal,
  type ProtocolRouter,
  type StreamHandler,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  StorageACKHandler,
  type StorageACKHandlerConfig,
} from '../../publisher/src/storage-ack-handler.js';
import { VerifyProposalHandler } from '../../publisher/src/verify-proposal-handler.js';
import {
  computeFlatKCRootV10 as computeFlatKCRoot,
  computeFlatKCMerkleLeafCountV10,
} from '../../publisher/src/merkle.js';
import { ethers } from 'ethers';
import { Messenger } from '../src/p2p/messenger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_SRC = resolve(__dirname, '..', 'src');
const DKG_AGENT_FILE = join(AGENT_SRC, 'dkg-agent.ts');
const CLI_LIFECYCLE_FILE = resolve(__dirname, '..', '..', 'cli', 'src', 'daemon', 'lifecycle.ts');

interface RouterDouble {
  send: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  inboundHandlers: Map<string, StreamHandler>;
}

function makeMessengerDouble() {
  const router: RouterDouble = {
    send: vi.fn(),
    inboundHandlers: new Map(),
    register: vi.fn((protocol: string, handler: StreamHandler) => {
      router.inboundHandlers.set(protocol, handler);
    }),
  };
  const messenger = new Messenger({
    router: router as unknown as ProtocolRouter,
    idempotencyStore: new InMemoryMessageIdempotencyStore(),
    outboxStore: new InMemoryProtocolOutboxStore(),
  });
  return { messenger, router };
}

function q(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

describe('A-9: storage-ack protocol id (libp2p) pin', () => {
  it('constant is the exact spec string', () => {
    // rc.9 PR-11: bumped to /dkg/10.0.1/* hard cutover (Universal
    // Messenger substrate; receiver dedup + envelope wrap mandatory).
    expect(PROTOCOL_STORAGE_ACK).toBe('/dkg/10.0.1/storage-ack');
  });

  it('`dkg-agent.ts` registers PROTOCOL_STORAGE_ACK on the messenger substrate', () => {
    const src = readFileSync(DKG_AGENT_FILE, 'utf8');
    expect(src).toMatch(/PROTOCOL_STORAGE_ACK/);
    // rc.9 PR-11: registration moved from `router.register` to
    // `messenger.register` (substrate auto-wraps with envelope
    // decode + receiver-side dedup). Pin against the new shape.
    const registerRE = /messenger\.register\s*\(\s*PROTOCOL_STORAGE_ACK\s*,/;
    expect(src).toMatch(registerRE);
  });

  it('messenger handler registrations pass the real peer id string, not a partial PeerId object', () => {
    const src = readFileSync(DKG_AGENT_FILE, 'utf8');
    expect(src).not.toMatch(/toBytes:\s*\(\)\s*=>\s*new Uint8Array/);
    expect(src).toMatch(/ackHandler\.handler\(data,\s*peerIdStr\)/);
    expect(src).toMatch(/verifyHandler\.handler\(data,\s*peerIdStr\)/);
  });

  it('ACK and VERIFY reliable requests use stable retry message ids', () => {
    const agentSrc = readFileSync(DKG_AGENT_FILE, 'utf8');
    const lifecycleSrc = readFileSync(CLI_LIFECYCLE_FILE, 'utf8');
    const agentMessageIds = agentSrc.match(
      /messageId:\s*stableReliableRequestMessageId\(peerId,\s*protocol,\s*data\)/g,
    ) ?? [];

    expect(agentMessageIds).toHaveLength(2);
    expect(lifecycleSrc).toMatch(
      /messageId:\s*stableReliableRequestMessageId\(peerId,\s*protocol,\s*data\)/,
    );
  });

  it('drives StorageACK and VerifyProposal handlers through Messenger reliable envelopes', async () => {
    const contextGraphId = '42';
    const swmGraph = `did:dkg:context-graph:${contextGraphId}/_shared_memory`;
    const quads = [
      q('urn:entity:1', 'urn:p:name', '"Entity One"', swmGraph),
      q('urn:entity:1', 'urn:p:type', 'urn:type:Thing', swmGraph),
    ];
    const merkleRoot = computeFlatKCRoot(quads, []);
    const merkleLeafCount = computeFlatKCMerkleLeafCountV10(quads, []);
    const store = new OxigraphStore();
    await store.insert(quads);

    const coreWallet = ethers.Wallet.createRandom();
    const ackConfig: StorageACKHandlerConfig = {
      nodeRole: 'core',
      nodeIdentityId: 7n,
      signerWallet: coreWallet,
      contextGraphSharedMemoryUri: (cgId: string) =>
        `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: 31337n,
      kav10Address: '0x000000000000000000000000000000000000c10a',
    };
    const ackHandler = new StorageACKHandler(
      store as any,
      ackConfig,
      new TypedEventBus() as any,
    );
    const verifyHandler = new VerifyProposalHandler({
      store: store as any,
      agentPrivateKey: coreWallet.privateKey,
      agentAddress: coreWallet.address,
      getBatchMerkleRoot: async () => merkleRoot,
      getContextGraphIdOnChain: async () => 42n,
    });
    const { messenger, router } = makeMessengerDouble();
    messenger.register(PROTOCOL_STORAGE_ACK, ackHandler.handler);
    messenger.register(PROTOCOL_VERIFY_PROPOSAL, verifyHandler.handler);

    const intentBytes = encodePublishIntent({
      merkleRoot,
      contextGraphId,
      publisherPeerId: 'publisher-peer',
      publicByteSize: 123,
      isPrivate: false,
      kaCount: 1,
      rootEntities: ['urn:entity:1'],
      epochs: 1,
      tokenAmountStr: '1000',
      merkleLeafCount,
    });
    const ackEnvelope = encodeReliableEnvelope({
      messageId: '00000000-0000-4000-8000-000000000555',
      version: RELIABLE_ENVELOPE_VERSION,
      tsMs: Date.now(),
      payload: intentBytes,
    });
    const ackBytes = await router.inboundHandlers.get(PROTOCOL_STORAGE_ACK)!(
      ackEnvelope,
      { toString: () => 'publisher-peer', toBytes: () => new Uint8Array() },
    );
    const ack = decodeStorageACK(ackBytes);
    expect(Number(ack.nodeIdentityId)).toBe(7);

    const proposalId = crypto.getRandomValues(new Uint8Array(16));
    const proposalEnvelope = encodeReliableEnvelope({
      messageId: '00000000-0000-4000-8000-000000000556',
      version: RELIABLE_ENVELOPE_VERSION,
      tsMs: Date.now(),
      payload: encodeVerifyProposal({
        proposalId,
        contextGraphId,
        batchId: 1,
        merkleRoot,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    const verifyBytes = await router.inboundHandlers.get(PROTOCOL_VERIFY_PROPOSAL)!(
      proposalEnvelope,
      { toString: () => 'publisher-peer', toBytes: () => new Uint8Array() },
    );
    const approval = decodeVerifyApproval(verifyBytes);
    expect(approval.approverAddress).toBe(coreWallet.address);
    expect(Array.from(approval.proposalId)).toEqual(Array.from(proposalId));
  });

  it('agent source never publishes ACKs on GossipSub', () => {
    // A false-positive here would be any call like
    // `publish('/dkg/10.0.0/storage-ack', ...)` or
    // `gossipsub.publish('...storage-ack...', ...)` through the gossipsub
    // manager. We scan all .ts files in src and make sure we never see
    // GossipSub coupling with the storage-ack string.
    const files = walk(AGENT_SRC);
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/storage-ack/.test(line)) return;
        if (/gossip/i.test(line)) {
          offenders.push({ file: f.replace(AGENT_SRC + '/', ''), line: i + 1, text: line.trim() });
        }
      });
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it('protocol id is NOT accidentally registered on a different protocol version', () => {
    // Pins that no code path silently forks to /dkg/9.x or /dkg/11.x
    // storage-ack — such a drift would be invisible to callers but would
    // break ACK handshakes. We look for any `/dkg/*/storage-ack` that is
    // not exactly the current PROTOCOL_STORAGE_ACK.
    const files = walk(AGENT_SRC);
    const offenders: string[] = [];
    const re = /['"`](\/dkg\/[^'"`]*?storage-ack)['"`]/g;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(re)) {
        if (m[1] !== PROTOCOL_STORAGE_ACK) {
          offenders.push(`${f}: ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
