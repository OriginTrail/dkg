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
import { resolveWorkspaceEncryptionRequirement } from '../src/workspace-handler.js';

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
