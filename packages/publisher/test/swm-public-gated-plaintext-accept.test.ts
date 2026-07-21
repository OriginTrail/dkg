/**
 * SWM encryption policy for public + agent-gated context graphs.
 *
 * The bug this pins: sender and receiver decided the SWM encryption requirement
 * from different authorities.
 *
 *   SENDER   `resolveWorkspaceRecipientsGated` (agent) short-circuits on a live
 *            on-chain accessPolicy of 0 and gossips PLAINTEXT, deliberately
 *            ignoring the agent gate — on a public CG the allowlist governs
 *            PUBLISH AUTHORITY, not READ ACCESS, so there is nothing to keep
 *            confidential, and encrypting instead bootstraps a sender-key
 *            handshake that non-gated recipients reject (HTTP 500 on promote).
 *
 *   RECEIVER required encryption whenever `agentGateAddresses !== null`, read
 *            from local allowedAgent/participantAgent triples.
 *
 * The conditions disagreed on exactly one set — accessPolicy=0 AND agent-gated —
 * which is precisely the public/curated cell. The receiver dropped those writes
 * with `retryable: false` while the sender reported success, so every
 * member->curator SWM share on a public/curated CG failed permanently and
 * silently.
 *
 * These tests exercise `resolveWorkspaceEncryptionRequirement`, the exported
 * decision the handler itself calls. An earlier version of this file
 * reimplemented the expression against a stubbed private helper, which meant a
 * revert of the production decision would have kept the suite green — false
 * confidence for the exact regression it was meant to pin.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TypedEventBus,
  computeGossipSigningPayload,
  contextGraphDataUri,
  contextGraphMetaUri,
  DKG_ONTOLOGY,
  encodeGossipEnvelope,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
} from '@origintrail-official/dkg-core';
import { SharedMemoryHandler } from '../src/index.js';
import { resolveWorkspaceEncryptionRequirement } from '../src/workspace-encryption-policy.js';
import { encodeRootlessWorkspaceRequest } from './_helpers/rootless-workspace.js';

const GATE = ['0x1111111111111111111111111111111111111111'];

describe('SWM encryption requirement', () => {
  describe('public + agent-gated (the public/curated cell)', () => {
    const publicGated = {
      hasPrivateAccessPolicy: false,
      agentGateAddresses: GATE,
      provenPublicOnChain: true,
    };

    it('does NOT require encryption — this is the drop the fix removes', () => {
      // Pre-fix this was true, so the sender's deliberate plaintext was
      // rejected with retryable:false and the content never converged.
      expect(resolveWorkspaceEncryptionRequirement(publicGated).requiresEncryptedPayload).toBe(false);
    });

    it('STILL accepts encryption — otherwise the failure is merely inverted', () => {
      // A sender whose chain probe fails fails CLOSED and encrypts. If the
      // receiver stopped supporting encrypted payloads for this CG, that sender
      // would be permanently dropped instead — the mirror of the original bug.
      expect(resolveWorkspaceEncryptionRequirement(publicGated).supportsEncryptedPayload).toBe(true);
    });
  });

  describe('agent-gated but NOT proven public', () => {
    const gatedUnknown = {
      hasPrivateAccessPolicy: false,
      agentGateAddresses: GATE,
      provenPublicOnChain: false,
    };

    it('requires encryption (fail-closed on an unproven chain state)', () => {
      expect(resolveWorkspaceEncryptionRequirement(gatedUnknown).requiresEncryptedPayload).toBe(true);
    });

    it('accepts encryption', () => {
      expect(resolveWorkspaceEncryptionRequirement(gatedUnknown).supportsEncryptedPayload).toBe(true);
    });
  });

  describe('private access policy', () => {
    it('requires encryption regardless of any public proof', () => {
      // A public on-chain proof must never downgrade a private CG.
      const r = resolveWorkspaceEncryptionRequirement({
        hasPrivateAccessPolicy: true,
        agentGateAddresses: GATE,
        provenPublicOnChain: true,
      });
      expect(r.requiresEncryptedPayload).toBe(true);
      expect(r.supportsEncryptedPayload).toBe(true);
    });

    it('requires encryption even with no agent gate', () => {
      const r = resolveWorkspaceEncryptionRequirement({
        hasPrivateAccessPolicy: true,
        agentGateAddresses: null,
        provenPublicOnChain: false,
      });
      expect(r.requiresEncryptedPayload).toBe(true);
      expect(r.supportsEncryptedPayload).toBe(true);
    });
  });

  describe('ungated public CG', () => {
    const ungated = {
      hasPrivateAccessPolicy: false,
      agentGateAddresses: null,
      provenPublicOnChain: true,
    };

    it('neither requires nor supports encryption', () => {
      const r = resolveWorkspaceEncryptionRequirement(ungated);
      expect(r.requiresEncryptedPayload).toBe(false);
      // Unchanged behaviour: a Sender-Key payload on a CG with no gate at all
      // is still refused, which is what the pre-existing rejection covers.
      expect(r.supportsEncryptedPayload).toBe(false);
    });
  });

  describe('the invariant that makes skew survivable', () => {
    it('never REQUIRES encryption without also SUPPORTING it', () => {
      for (const hasPrivateAccessPolicy of [true, false]) {
        for (const agentGateAddresses of [GATE, null]) {
          for (const provenPublicOnChain of [true, false]) {
            const r = resolveWorkspaceEncryptionRequirement({
              hasPrivateAccessPolicy, agentGateAddresses, provenPublicOnChain,
            });
            if (r.requiresEncryptedPayload) expect(r.supportsEncryptedPayload).toBe(true);
          }
        }
      }
    });
  });
});

/**
 * Probe LAZINESS at the handler boundary.
 *
 * The helper only reads `provenPublicOnChain` behind `isAgentGated`, so for an
 * ungated CG the on-chain probe's answer is irrelevant — but an earlier
 * revision of the handler awaited `isContextGraphProvenPublicOnChain`
 * UNCONDITIONALLY before calling the helper. That put a live chain RPC on the
 * hot path of EVERY SWM gossip receive: measured on a 6-node devnet it took
 * receive-apply from ~3ms to ~33ms, which slipped the author's next poll by a
 * full cycle and made the public-CG sync gate's LIVE receiver miss the VM
 * publish window (devnet gate regression, both public cells).
 *
 * These tests drive the REAL handler with a counting oracle:
 *  - ungated CG  => the write applies and the probe is NEVER invoked
 *    (mutation check: re-introducing the unconditional await fails this)
 *  - gated CG    => the probe IS invoked (laziness must not become "never")
 */
describe('on-chain probe evaluation at the handler boundary', () => {
  const CG = 'swm-plaintext-probe-laziness';
  const DATA = contextGraphDataUri(CG);
  const META = contextGraphMetaUri(CG);
  const PEER = '12D3KooWProbeLazinessPeer';
  const SUBJ = 'urn:test:swm-plaintext-probe';

  const msg = (name: string, op: string): Uint8Array => encodeRootlessWorkspaceRequest({
    contextGraphId: CG,
    nquads: new TextEncoder().encode(
      `<${SUBJ}> <http://schema.org/name> "${name}" <${DATA}> .`,
    ),
    publisherPeerId: PEER,
    shareOperationId: op,
    timestampMs: Date.now(),
  });

  it('ungated CG: plaintext applies WITHOUT consulting the on-chain probe', async () => {
    const store = new OxigraphStore();
    let probeCalls = 0;
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: new Map(),
      publicAccessPolicyOnChainOracle: async () => { probeCalls += 1; return true; },
    });

    const outcome = await handler.handle(msg('Ungated Fast Path', 'ws-probe-ungated'), PEER);

    expect(outcome.applied).toBe(true);
    expect(probeCalls).toBe(0);
  });

  it('agent-gated CG: the probe IS consulted, and a public proof admits the plaintext write', async () => {
    const store = new OxigraphStore();
    let probeCalls = 0;
    const writer = ethers.Wallet.createRandom();
    await store.insert([{
      subject: DATA,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${writer.address}"`,
      graph: META,
    }]);
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      sharedMemoryOwnedEntities: new Map(),
      localAgentAddresses: () => [writer.address],
      publicAccessPolicyOnChainOracle: async () => { probeCalls += 1; return true; },
    });

    const payload = msg('Gated Public Plaintext', 'ws-probe-gated');
    const timestamp = new Date().toISOString();
    const signature = await writer.signMessage(
      computeGossipSigningPayload(GOSSIP_TYPE_WORKSPACE_PUBLISH, CG, timestamp, payload),
    );
    const wire = encodeGossipEnvelope({
      version: GOSSIP_ENVELOPE_VERSION,
      type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
      contextGraphId: CG,
      agentAddress: writer.address,
      timestamp,
      signature: ethers.getBytes(signature),
      payload,
    });

    const outcome = await handler.handle(wire, PEER);

    expect(outcome.applied).toBe(true);
    expect(probeCalls).toBeGreaterThan(0);
  });
});
