import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import type { RequestContext } from '../src/daemon/handle-request.js';

/**
 * GH#2270 follow-up (🔴 3823952704) — who may force-clear a job whose transaction may still land.
 *
 * The by-id clear is the stated exit for a held UPDATE, but `/api/publisher/clear-job` is reachable
 * by every registered agent token and does no ownership check of its own. Widening the predicate
 * for all callers therefore let one agent delete another lifecycle's only chain-recovery record —
 * and if that transaction later landed, or the owner resubmitted, the node could publish twice.
 *
 * Two conditions are required, and these rows pin each one independently.
 */
describe('clear-job pending-transaction override authorization', () => {
  const OWNER = '0xAAaAAa00000000000000000000000000000000Aa';
  const OTHER = '0xBBbBBb00000000000000000000000000000000Bb';

  function post(body: unknown, requestAgentAddress: string) {
    const calls: Array<{ jobId: string; requestedBy?: string }> = [];
    const path = '/api/publisher/clear-job';
    const req = Readable.from([]);
    Object.assign(req, {
      method: 'POST', url: path, headers: { host: '127.0.0.1' },
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
        options?: { pendingTransactionOverride?: { requestedBy: string } },
      ) => {
        calls.push({ jobId, requestedBy: options?.pendingTransactionOverride?.requestedBy });
        return { outcome: 'cleared' as const };
      },
    } as unknown as RequestContext['publisherControl'];

    const ctx = {
      req: req as RequestContext['req'],
      res: res as unknown as ServerResponse,
      url: new URL(`http://127.0.0.1${path}`),
      path,
      requestToken: 'dkg_at_test',
      requestAgentAddress,
      publisherControl,
    } as unknown as RequestContext;

    return { run: () => handlePublisherRoutes(ctx), calls, res };
  }

  it('does NOT grant the override to an agent that does not own the job', async () => {
    // The reviewer's scenario: agent B force-clearing agent A's held job.
    const { run, calls } = post({ jobId: 'job-1', allowPendingTransaction: true }, OTHER);
    await run();
    // The route forwards WHO is asking; the publisher decides, atomically, on the record it is
    // about to delete. What matters here is that the caller's identity is not lost on the way.
    expect(calls).toEqual([{ jobId: 'job-1', requestedBy: OTHER }]);
  });

  it('grants it to the owning agent that explicitly asks', async () => {
    // The discriminating half — without it, refusing everyone would pass the row above.
    const { run, calls } = post({ jobId: 'job-1', allowPendingTransaction: true }, OWNER);
    await run();
    expect(calls).toEqual([{ jobId: 'job-1', requestedBy: OWNER }]);
  });

  it('does NOT grant it to the owner who did not ask for it', async () => {
    // Ownership alone is not consent: an ordinary terminal clear must stay ordinary.
    const { run, calls } = post({ jobId: 'job-1' }, OWNER);
    await run();
    // No override asked for: the value is absent entirely, not a false flag beside an identity.
    expect(calls).toEqual([{ jobId: 'job-1', requestedBy: undefined }]);
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

  it('reports what the runtime says, not merely that one exists', async () => {
    const { createAdmissionRecoveryCapabilityProbe } = await import('../src/publisher-runner.js');
    const state = { runtime: { canSettleHeldJob: () => false } };
    const probe = createAdmissionRecoveryCapabilityProbe(() => state);

    expect(probe(WALLET, 'update')).toBe(false);
  });
});


/**
 * GH#2270 follow-up (🔴 3824098486, then 🔴 3824353564 and 🔴 3824353577) — the remediation
 * command the daemon hands back must be one that WORKS, for every held job it is handed to.
 *
 * The first version omitted the override entirely, so the documented escape hatch returned 409.
 * The second chose the body from `err.retryable`, but retryability and the `retry_recovery` clear
 * restriction are independent — a recoverable job can still need the override — so some held jobs
 * kept getting the unusable command. And the row asserting it only checked that both strings
 * existed SOMEWHERE, so reversing the branches left it green.
 *
 * There is now no branch: one command, always carrying the override. That removes the failure mode
 * and the untestable-ordering problem together.
 */
describe('pending-chain-proof remediation instruction', () => {
  it('always supplies the override, with no branch to get backwards', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      new URL('../src/daemon/routes/knowledge-assets.ts', import.meta.url), 'utf8',
    );
    const line = src.split(String.fromCharCode(10)).find((l) => l.includes('POST /api/publisher/clear-job'));
    expect(line).toBeDefined();

    // The command is emitted unconditionally: one template, no ternary choosing the body.
    expect(line).toContain('"allowPendingTransaction":true');
    expect(line).not.toContain('err.retryable');
    // And exactly one clear-job command exists, so there is no second branch to disagree with it.
    expect(src.split('POST /api/publisher/clear-job').length - 1).toBe(1);
  });
});
