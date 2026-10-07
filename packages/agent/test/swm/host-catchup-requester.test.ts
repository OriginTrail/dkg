import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { PROTOCOL_SWM_HOST_CATCHUP } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../../src/dkg-agent.js';
import {
  decodeSwmHostCatchupRequest,
  encodeSwmHostCatchupResponse,
  DEFAULT_MAX_ENTRIES,
  MAX_MAX_ENTRIES,
  SWM_HOST_CATCHUP_WIRE_VERSION,
} from '../../src/swm/host-catchup-wire.js';
import { verifySignedCatchupRequest } from '../../src/swm/host-catchup-sign.js';

/**
 * `catchupSwmFromHost` as the requester runs it: the real method, a real
 * signer, and a stand-in messenger that keeps what was sent and answers as a
 * host with nothing to serve. What the host receives is decoded and verified
 * the way the host does it.
 */

const CG = 'curator/cg-1';
const HOST_PEER = '12D3KooWHostPeerForCatchupRequesterTest';

function requester() {
  const wallet = ethers.Wallet.createRandom();
  const sent: Array<{ peerId: string; protocol: string; bytes: Uint8Array }> = [];
  const agent = Object.create(DKGAgent.prototype) as any;
  agent.log = { warn() {}, info() {}, debug() {} };
  agent.chain = {};
  agent.getWorkspaceCatchupSigner = async () => ({ privateKey: wallet.privateKey });
  agent.messenger = {
    sendReliable: async (peerId: string, protocol: string, bytes: Uint8Array) => {
      sent.push({ peerId, protocol, bytes });
      return {
        delivered: true,
        response: encodeSwmHostCatchupResponse({
          version: SWM_HOST_CATCHUP_WIRE_VERSION,
          contextGraphId: CG,
          nextSeqno: 0,
          truncated: false,
          entries: [],
        }),
      };
    },
  };
  return { agent: agent as DKGAgent, wallet, sent };
}

/** The one request the requester sent, as the host decodes and verifies it. */
function received(sent: Array<{ peerId: string; protocol: string; bytes: Uint8Array }>) {
  expect(sent).toHaveLength(1);
  expect(sent[0]!.peerId).toBe(HOST_PEER);
  expect(sent[0]!.protocol).toBe(PROTOCOL_SWM_HOST_CATCHUP);
  const request = decodeSwmHostCatchupRequest(sent[0]!.bytes);
  const verdict = verifySignedCatchupRequest(
    request as Parameters<typeof verifySignedCatchupRequest>[0],
    request.issuedAtMs,
  );
  return { request, verdict };
}

describe('catchupSwmFromHost: the page size it signs is the page size it sends', () => {
  it.each([
    ['above the wire limit', MAX_MAX_ENTRIES * 2, MAX_MAX_ENTRIES],
    ['at the wire limit', MAX_MAX_ENTRIES, MAX_MAX_ENTRIES],
    ['a small page', 7, 7],
    ['a fractional page', 2.9, 2],
  ])('%s: the host verifies the request', async (_label, asked, onTheWire) => {
    const { agent, wallet, sent } = requester();

    const result = await agent.catchupSwmFromHost(HOST_PEER, CG, { maxEntriesPerRound: asked });

    const { request, verdict } = received(sent);
    expect(request.maxEntries).toBe(onTheWire);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    expect(request.requesterEoa).toBe(wallet.address.toLowerCase());
    expect(result).toMatchObject({ rounds: 1, fetched: 0, nextSeqno: 0 });
    expect(result.denied).toBeUndefined();
  });

  it('without a page size it asks for the default page, signed', async () => {
    const { agent, sent } = requester();

    await agent.catchupSwmFromHost(HOST_PEER, CG);

    const { request, verdict } = received(sent);
    expect(request.maxEntries).toBe(DEFAULT_MAX_ENTRIES);
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
  });
});
