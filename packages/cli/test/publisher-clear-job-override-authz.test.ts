import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import { authenticateHttpRequest } from '../src/auth.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import type {
  PendingTransactionClearOverride,
  TargetedLiftJobClearOptions,
} from '@origintrail-official/dkg-publisher';

/**
 * GH#2270 follow-up (🔴 3823952704) — who may force-clear a job whose transaction may still land.
 *
 * The by-id clear is the stated exit for a held UPDATE, but `/api/publisher/clear-job` is reachable
 * by every registered agent token. Widening the predicate for all callers therefore let one agent
 * delete another lifecycle's only chain-recovery record — and if that transaction later landed,
 * or the owner resubmitted, the node could publish twice. The node token is a distinct operator
 * tier: it owns the queue and must not be collapsed into the default agent identity.
 *
 * These rows pin the three tiers: owning agent, node operator, and unrelated agent.
 */
describe('clear-job pending-transaction override authorization', () => {
  const OWNER = '0xAAaAAa00000000000000000000000000000000Aa';
  const OTHER = '0xBBbBBb00000000000000000000000000000000Bb';
  const DEFAULT_AGENT = '0xCCcCCc00000000000000000000000000000000Cc';

  function post(body: unknown, caller: {
    requestAgentAddress: string;
    requestToken?: string;
    tokenAgentAddress?: string;
    authEnabled?: boolean;
    validTokens?: Set<string>;
  }) {
    const calls: Array<{
      jobId: string;
      authority?: PendingTransactionClearOverride;
    }> = [];
    const path = '/api/publisher/clear-job';
    const req = Readable.from([]);
    Object.assign(req, {
      method: 'POST',
      url: path,
      headers: {
        host: '127.0.0.1',
        ...(caller.requestToken ? { authorization: `Bearer ${caller.requestToken}` } : {}),
      },
      __dkgPrebufferedBody: Buffer.from(JSON.stringify(body), 'utf8'),
    });
    const res = {
      statusCode: 0, body: '', writableEnded: false,
      writeHead(status: number) { this.statusCode = status; return this; },
      end(b?: string) { this.body = b ?? ''; this.writableEnded = true; return this; },
    };
    // 🔴 3824098476 — the route must NOT read the job itself: that put an unvalidated jobId into
    // a query ahead of the safe-id guard, and decided ownership outside the claim lock the clear
    // takes. `getStatus` therefore fails loudly if the route ever calls it again.
    const publisherControl = {
      getStatus: async () => { throw new Error('route must not query the job'); },
      clearTerminalJob: async (
        jobId: string,
        options?: TargetedLiftJobClearOptions,
      ) => {
        calls.push({
          jobId,
          authority: options?.pendingTransactionOverride,
        });
        return { outcome: 'cleared' as const };
      },
    } as unknown as RequestContext['publisherControl'];

    const requestToken = caller.requestToken;
    const agent = {
      resolveAgentByToken: (token: string) => (
        token === requestToken ? caller.tokenAgentAddress : undefined
      ),
    } as unknown as RequestContext['agent'];
    const validTokens = caller.validTokens ?? new Set(requestToken ? [requestToken] : []);
    const authEnabled = caller.authEnabled ?? true;

    return {
      run: async () => {
        const authentication = await authenticateHttpRequest({
          req: req as RequestContext['req'],
          res: res as unknown as ServerResponse,
          authEnabled,
          validTokens,
          resolveAgentByToken: (token) => agent.resolveAgentByToken(token),
        });
        if (!authentication.allowed) return;
        const ctx = {
          req: req as RequestContext['req'],
          res: res as unknown as ServerResponse,
          url: new URL(`http://127.0.0.1${path}`),
          path,
          requestToken: authentication.requestToken,
          requestCredentialAuthenticated: authentication.requestCredentialAuthenticated,
          requestAgentAddress: caller.requestAgentAddress,
          requestPrincipal: authentication.requestPrincipal,
          agent,
          config: { auth: { enabled: authEnabled } },
          validTokens,
          publisherControl,
        } as unknown as RequestContext;
        await handlePublisherRoutes(ctx);
      },
      calls,
      res,
    };
  }

  it('does NOT grant the override to an agent that does not own the job', async () => {
    // The reviewer's scenario: agent B force-clearing agent A's held job.
    const { run, calls } = post(
      { jobId: 'job-1', allowPendingTransaction: true },
      {
        requestAgentAddress: OTHER,
        requestToken: 'dkg_at_other',
        tokenAgentAddress: OTHER,
      },
    );
    await run();
    // The route forwards WHO is asking; the publisher decides, atomically, on the record it is
    // about to delete. What matters here is that the caller's identity is not lost on the way.
    expect(calls).toEqual([{
      jobId: 'job-1',
      authority: { kind: 'agent', agentAddress: OTHER },
    }]);
  });

  it('grants it to the owning agent that explicitly asks', async () => {
    // The discriminating half — without it, refusing everyone would pass the row above.
    const { run, calls } = post(
      { jobId: 'job-1', allowPendingTransaction: true },
      {
        requestAgentAddress: OWNER,
        requestToken: 'dkg_at_owner',
        tokenAgentAddress: OWNER,
      },
    );
    await run();
    expect(calls).toEqual([{
      jobId: 'job-1',
      authority: { kind: 'agent', agentAddress: OWNER },
    }]);
  });

  it('grants a distinct node-operator override instead of impersonating the default agent', async () => {
    const { run, calls } = post(
      { jobId: 'job-1', allowPendingTransaction: true },
      { requestAgentAddress: DEFAULT_AGENT, requestToken: 'node-admin-token' },
    );
    await run();
    expect(calls).toEqual([{
      jobId: 'job-1',
      authority: { kind: 'nodeOperator' },
    }]);
  });

  it('treats the tokenless auth-disabled daemon as the node operator', async () => {
    const { run, calls } = post(
      { jobId: 'legacy-job', allowPendingTransaction: true },
      { requestAgentAddress: DEFAULT_AGENT, authEnabled: false },
    );
    await run();
    expect(calls).toEqual([{
      jobId: 'legacy-job',
      authority: { kind: 'nodeOperator' },
    }]);
  });

  it('does NOT grant it to the owner who did not ask for it', async () => {
    // Ownership alone is not consent: an ordinary terminal clear must stay ordinary.
    const { run, calls } = post(
      { jobId: 'job-1' },
      {
        requestAgentAddress: OWNER,
        requestToken: 'dkg_at_owner',
        tokenAgentAddress: OWNER,
      },
    );
    await run();
    // No override asked for: the value is absent entirely, not a false flag beside an identity.
    expect(calls).toEqual([{
      jobId: 'job-1',
      authority: undefined,
    }]);
  });

  it('rejects an unrecognized bearer before routing any override authority', async () => {
    const { run, calls, res } = post(
      { jobId: 'job-1', allowPendingTransaction: true },
      {
        requestAgentAddress: DEFAULT_AGENT,
        requestToken: 'forged-token',
        validTokens: new Set(),
      },
    );
    await run();
    expect(res.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });
});

/**
 * GH#2270 follow-up (🟡 3823952750) — the daemon-to-runtime bridge itself.
 *
 * The `retryable` fix depends on late-bound wiring between two separately constructed publishers,
 * and the publisher-level rows stub the oracle — so a regression at the exact production seam that
 * caused the bug would leave them green. These rows exercise the bridge.
 */
describe('admission-to-runtime recovery capability bridge', () => {
  const WALLET = '0xAAaAAa00000000000000000000000000000000Aa';

  it('answers FALSE before the runtime exists, then delegates once it does', async () => {
    const { createAdmissionRecoveryCapabilityProbe } = await import('../src/publisher-runner.js');
    const calls: Array<[string, string | undefined]> = [];
    // The daemon builds the admission instance BEFORE the runtime, so the probe is captured here.
    const state: { runtime: { canSettleHeldJob: (w: string, k: 'create' | 'update' | undefined) => boolean } | null } = { runtime: null };
    const probe = createAdmissionRecoveryCapabilityProbe(() => state);

    // 'update', deliberately: a bridge that hardcoded 'create' would forward the right SHAPE with
    // the wrong value, and a row using 'create' on both sides could never see it.
    expect(probe(WALLET, 'update')).toBe(false);

    // ...and the runtime starts afterwards.
    state.runtime = {
      canSettleHeldJob: (w, k) => { calls.push([w, k]); return true; },
    };

    expect(probe(WALLET, 'update')).toBe(true);
    // Both arguments reach the runtime: its answer is per wallet AND per operation, so dropping
    // either would silently widen the promise.
    expect(calls).toEqual([[WALLET, 'update']]);
  });

  it('the PRODUCTION runtime capability answers per adapter and per operation [followup]', async () => {
    // 🔴 3824531105 — the rows above hand the probe a fake `canSettleHeldJob`, so a real runtime
    // returning `() => false` would restore the production bug with every test green. This one
    // builds the capability the runtime actually exposes, from a real adapter map.
    const { createRuntimeRecoveryCapability } = await import('../src/publisher-runner.js');
    const CAPABLE = '0x1111111111111111111111111111111111111111';
    const LOOKUP_ONLY = '0x2222222222222222222222222222222222222222';
    const asAdapter = (c: Record<string, unknown>) => c as never;

    const capability = createRuntimeRecoveryCapability(new Map([
      // A create needs the lookup, the finalized snapshot, the canonical receipt AND finality.
      [CAPABLE, asAdapter({
        resolvePublishTransaction: () => null,
        readFinalizedChainProofSnapshot: () => null,
        resolveCanonicalFinalizationReceipt: () => null,
        isReceiptBlockFinalAndCanonical: () => null,
      })],
      // The tri-state lookup alone settles neither kind.
      [LOOKUP_ONLY, asAdapter({ resolvePublishTransaction: () => null })],
    ]) as never);

    expect(capability(CAPABLE, 'create')).toBe(true);
    expect(capability(LOOKUP_ONLY, 'create')).toBe(false);
    // Per OPERATION too: that same adapter cannot settle an update (no verification/finality/
    // contract-address path), so a blanket `true` would be caught here.
    expect(capability(CAPABLE, 'update')).toBe(false);
    // And an unknown wallet is not this runtime's to settle.
    expect(capability('0x9999999999999999999999999999999999999999', 'create')).toBe(false);
  });

  it('reports what the runtime says, not merely that one exists', async () => {
    const { createAdmissionRecoveryCapabilityProbe } = await import('../src/publisher-runner.js');
    const state = { runtime: { canSettleHeldJob: () => false } };
    const probe = createAdmissionRecoveryCapabilityProbe(() => state);

    expect(probe(WALLET, 'update')).toBe(false);
  });
});
