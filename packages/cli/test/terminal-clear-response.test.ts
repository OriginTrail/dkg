import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { TerminalJobClearOutcome } from '@origintrail-official/dkg-publisher';
import { respondTerminalClearOutcome } from '../src/daemon/routes/terminal-clear-response.js';

// #1837 — locks the shared TerminalJobClearOutcome → HTTP contract that BOTH the publisher
// (/api/publisher/clear-job) and SWM (/api/knowledge-assets/swm/share-jobs/:id/clear) clear
// routes project through, so a future mapping change (wrong status, dropped jobId, or the
// `unknown` branch diverging) cannot silently alter the clear-route contract.
describe('respondTerminalClearOutcome mapping', () => {
  function fakeRes() {
    return {
      statusCode: 0,
      body: '',
      headers: undefined as Record<string, string> | undefined,
      writableEnded: false,
      writeHead(status: number, headers: Record<string, string>) {
        this.statusCode = status;
        this.headers = headers;
        return this;
      },
      end(body?: string) {
        this.body = body ?? '';
        this.writableEnded = true;
        return this;
      },
    };
  }

  function run(outcome: TerminalJobClearOutcome, jobId: string) {
    const res = fakeRes();
    respondTerminalClearOutcome(res as unknown as ServerResponse, outcome, jobId);
    return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown> };
  }

  it('cleared → 200 with echoed jobId', () => {
    expect(run({ outcome: 'cleared' }, 'job-1')).toEqual({ status: 200, body: { outcome: 'cleared', jobId: 'job-1' } });
  });

  it('already_absent → 200 (idempotent success, NOT 404)', () => {
    expect(run({ outcome: 'already_absent' }, 'job-2')).toEqual({ status: 200, body: { outcome: 'already_absent', jobId: 'job-2' } });
  });

  it('rejected malformed → 400 (client input error)', () => {
    expect(run({ outcome: 'rejected', reason: 'malformed' }, 'bad id')).toEqual({ status: 400, body: { outcome: 'rejected', reason: 'malformed', jobId: 'bad id' } });
  });

  it('rejected nonterminal → 409 (server-side state condition)', () => {
    expect(run({ outcome: 'rejected', reason: 'nonterminal' }, 'job-3')).toEqual({ status: 409, body: { outcome: 'rejected', reason: 'nonterminal', jobId: 'job-3' } });
  });

  it('rejected pending_transaction → 409, saying what to check and which flag clears it (#3573)', () => {
    const { status, body } = run({ outcome: 'rejected', reason: 'pending_transaction' }, 'job-4');
    expect(status).toBe(409);
    expect(body).toMatchObject({ outcome: 'rejected', reason: 'pending_transaction', jobId: 'job-4' });
    expect(String(body.error)).toContain('"allowPendingTransaction": true');
    expect(String(body.error)).toContain('may have sent a transaction');
    // The other reasons carry no such text: only this one has an exit that needs the flag.
    expect(run({ outcome: 'rejected', reason: 'nonterminal' }, 'job-4').body).not.toHaveProperty('error');
  });

  it('rejected unknown → 409 with echoed jobId', () => {
    expect(run({ outcome: 'rejected', reason: 'unknown' }, 'bogus-1')).toEqual({ status: 409, body: { outcome: 'rejected', reason: 'unknown', jobId: 'bogus-1' } });
  });
});
