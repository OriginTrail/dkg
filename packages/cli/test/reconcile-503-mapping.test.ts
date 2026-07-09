/**
 * KA-number-floor reconcile resilience (follow-up to the "KA create 500-on-429"
 * fix) — the HTTP mapping half. `respondIfReconcileUnavailable` is the shared
 * helper every reconcile-triggering route uses (named create, one-shot publish,
 * shared-memory publish, and the WM-verb routes via respondAssertionError) so a
 * transient KA-number-floor reconcile failure surfaces as a retryable 503 rather
 * than a blanket 500. The retry half is pinned in packages/agent allocator.test;
 * this pins the status-code mapping. Verified end-to-end on a real Gnosis
 * mainnet node behind a 429-injecting RPC proxy (POST /api/knowledge-assets ->
 * 503, code KA_FLOOR_RECONCILE_UNAVAILABLE, retryable:true).
 *
 * PR #1319 review hardening: the 503 mapping is gated on the transient verdict.
 * Only a genuinely retryable failure becomes a 503 — a DETERMINISTIC reconcile
 * failure (retryable:false, e.g. a revert) falls through to the caller's normal
 * mapping, and a bare legacy message with NO retryable marker is never force-mapped
 * to a retryable 503.
 */
import { describe, it, expect } from 'vitest';
import { respondIfReconcileUnavailable } from '../src/daemon/http-utils.js';

function fakeRes() {
  const rec: { status: number; body: string; ended: boolean } = { status: 0, body: '', ended: false };
  const res = {
    writeHead(status: number) {
      rec.status = status;
      return res;
    },
    end(body?: string) {
      if (typeof body === 'string') rec.body = body;
      rec.ended = true;
    },
  } as any;
  return { rec, res };
}

describe('respondIfReconcileUnavailable — reconcile failure -> retryable 503', () => {
  it('maps a typed KaFloorReconcileError (by code, retryable) to a retryable 503', () => {
    const { rec, res } = fakeRes();
    const handled = respondIfReconcileUnavailable(res, {
      code: 'KA_FLOOR_RECONCILE_UNAVAILABLE',
      message: 'OT-RFC-43 A2: failed to reconcile KA-number floor for author 0xabc: 429',
      retryable: true,
    });
    expect(handled).toBe(true);
    expect(rec.status).toBe(503);
    const body = JSON.parse(rec.body);
    expect(body.code).toBe('KA_FLOOR_RECONCILE_UNAVAILABLE');
    expect(body.retryable).toBe(true);
  });

  // PR #1319 review — the core fix: a typed reconcile error that is DETERMINISTIC
  // (retryable:false, e.g. the floor read reverted rather than rate-limited) must
  // NOT be advertised as a retryable 503. It falls through so the caller maps it.
  it('does NOT map a typed but NON-retryable reconcile error (deterministic revert) — falls through', () => {
    const { rec, res } = fakeRes();
    const handled = respondIfReconcileUnavailable(res, {
      code: 'KA_FLOOR_RECONCILE_UNAVAILABLE',
      message: 'OT-RFC-43 A2: failed to reconcile KA-number floor for author 0xabc: execution reverted',
      retryable: false,
    });
    expect(handled).toBe(false);
    expect(rec.ended).toBe(false);
    expect(rec.status).toBe(0);
  });

  // The finalize/selection re-wrap sites tag `retryable` (from isTransientChainError)
  // but carry a SEAL_CAPABILITY_GAP / no code — matched via the legacy message ONLY
  // because they explicitly mark themselves retryable.
  it('maps a legacy-message re-wrap to 503 when it carries retryable:true', () => {
    const { rec, res } = fakeRes();
    const handled = respondIfReconcileUnavailable(
      res,
      Object.assign(
        new Error('OT-RFC-43 A2: failed to reconcile KA-number floor for author 0xabc at finalize: server response 429'),
        { code: 'SEAL_CAPABILITY_GAP', retryable: true },
      ),
    );
    expect(handled).toBe(true);
    expect(rec.status).toBe(503);
    const body = JSON.parse(rec.body);
    expect(body.code).toBe('KA_FLOOR_RECONCILE_UNAVAILABLE');
    expect(body.retryable).toBe(true);
  });

  // PR #1319 review — the mirror of the typed case for the legacy re-wrap path: a
  // deterministic finalize/selection re-wrap (retryable:false) must fall through.
  it('does NOT map a legacy-message re-wrap that is retryable:false — falls through', () => {
    const { rec, res } = fakeRes();
    const handled = respondIfReconcileUnavailable(
      res,
      Object.assign(
        new Error('OT-RFC-43 §F2: failed to reconcile KA-number floor for author 0xabc (selection publish): execution reverted'),
        { retryable: false },
      ),
    );
    expect(handled).toBe(false);
    expect(rec.ended).toBe(false);
    expect(rec.status).toBe(0);
  });

  // PR #1319 review — a BARE legacy message with no retryable marker is no longer
  // force-mapped to a retryable 503 (it could be hiding a deterministic revert).
  it('does NOT map a bare legacy message with no retryable marker — falls through', () => {
    const { rec, res } = fakeRes();
    const handled = respondIfReconcileUnavailable(
      res,
      new Error('failed to reconcile KA-number floor for author 0xabc: something'),
    );
    expect(handled).toBe(false);
    expect(rec.ended).toBe(false);
    expect(rec.status).toBe(0);
  });

  it('does NOT respond (returns false) for unrelated errors — caller keeps its own mapping', () => {
    const { rec, res } = fakeRes();
    const handled = respondIfReconcileUnavailable(res, new Error('execution reverted: TooLowBalance'));
    expect(handled).toBe(false);
    expect(rec.ended).toBe(false);
    expect(rec.status).toBe(0);
  });
});
