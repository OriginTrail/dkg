/**
 * Regression: a PUBLIC-on-chain context graph that also carries an agent gate
 * (the public/curated cell) must ACCEPT plaintext SWM writes.
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
 * The conditions disagree on exactly one set — accessPolicy=0 AND agent-gated —
 * which is precisely the public/curated cell. The receiver dropped those writes
 * with `retryable: false` while the sender reported success, so every
 * member->curator SWM share on a public/curated CG failed permanently and
 * silently. Found on devnet; invisible to author-side tests because the author
 * (curator) writes locally and never gossips.
 *
 * The receiver now consults the SAME live on-chain predicate, and fails closed
 * when it cannot prove public.
 */
import { describe, it, expect } from 'vitest';
import { SharedMemoryHandler } from '../src/workspace-handler.js';

type Handler = InstanceType<typeof SharedMemoryHandler>;

// Invoke the REAL private probe off the prototype, bound to a minimal stub, so
// this exercises shipped code rather than a reimplementation of it.
const provenPublic = (
  SharedMemoryHandler.prototype as unknown as {
    isContextGraphProvenPublicOnChain: (
      this: unknown, cg: string, ctx: unknown,
    ) => Promise<boolean>;
  }
).isContextGraphProvenPublicOnChain;

/**
 * Mirrors the receiver's decision at the call site:
 *   gateRequiresEncryption = agentGateAddresses !== null && !provenPublic
 */
async function decide(
  handler: Handler,
  opts: { agentGated: boolean },
): Promise<boolean> {
  if (!opts.agentGated) return false; // no gate → the gate never forces encryption
  const ctx = { operationId: 'test', kind: 'share' };
  return !(await provenPublic.call(handler, 'cg', ctx));
}

function makeHandler(oracle?: (cg: string) => Promise<boolean>): Handler {
  // Only the oracle seam and the logger are exercised here.
  const stub = {
    publicAccessPolicyOnChainOracle: oracle,
    log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  };
  return stub as unknown as Handler;
}

describe('SWM encryption requirement — public + agent-gated CGs', () => {
  it('does NOT require encryption when the CG is PROVEN public on-chain, even though it is agent-gated', async () => {
    const handler = makeHandler(async () => true);
    const gateRequiresEncryption = await decide(handler, { agentGated: true });
    // This is the assertion the bug violated: the receiver demanded encryption
    // for a public/curated CG and permanently dropped the sender's plaintext.
    expect(gateRequiresEncryption).toBe(false);
  });

  it('DOES require encryption for an agent-gated CG that is not proven public', async () => {
    const handler = makeHandler(async () => false);
    const gateRequiresEncryption = await decide(handler, { agentGated: true });
    expect(gateRequiresEncryption).toBe(true);
  });

  it('fails CLOSED when the on-chain probe throws (RPC flake must never open a plaintext hole)', async () => {
    const handler = makeHandler(async () => { throw new Error('rpc flake'); });
    const gateRequiresEncryption = await decide(handler, { agentGated: true });
    expect(gateRequiresEncryption).toBe(true);
  });

  it('fails CLOSED when no oracle is wired at all (older deployments keep prior behaviour)', async () => {
    const handler = makeHandler(undefined);
    const gateRequiresEncryption = await decide(handler, { agentGated: true });
    expect(gateRequiresEncryption).toBe(true);
  });

  it('an ungated CG is unaffected regardless of the probe', async () => {
    const handler = makeHandler(async () => true);
    const gateRequiresEncryption = await decide(handler, { agentGated: false });
    expect(gateRequiresEncryption).toBe(false);
  });
});
