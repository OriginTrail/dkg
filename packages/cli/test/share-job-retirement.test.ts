import { describe, expect, it, vi } from 'vitest';
import { daemonState } from '../src/daemon/state.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { handleShareJobCollection } from '../src/daemon/routes/share-job-collection.js';

const prefix = '/api/knowledge-assets/swm/share-jobs';
const operator = { mode: 'enforced', principal: { kind: 'nodeOperator' } };
const command = { expectedJobSha256: 'f'.repeat(64), acceptUnknownEffects: true };
function call(path: string, method: string, authentication: unknown, body?: unknown, outcome = 'eligible') {
  const retireFailedJob = vi.fn().mockResolvedValue({ outcome });
  const getPromoteAsyncStatus = vi.fn().mockResolvedValue(null);
  let status = 0;
  const res = { writeHead(code: number) { status = code; }, end() {} };
  const ctx = { path, url: new URL(path, 'http://localhost'), res, authentication,
    req: { method, __dkgPrebufferedBody: Buffer.from(JSON.stringify(body ?? {})) },
    agent: { promoteQueue: { retireFailedJob }, assertion: { getPromoteAsyncStatus } } } as unknown as RequestContext;
  return handleShareJobCollection(ctx).then(handled => ({ handled, status, retireFailedJob, getPromoteAsyncStatus }));
}

describe('operator-only exact share retirement', () => {
  for (const method of ['GET', 'POST']) it('checks the operator before looking up a job for ' + method, async () => {
    for (const authentication of [{ mode: 'disabled', principal: { kind: 'anonymous' } },
      { mode: 'enforced', principal: { kind: 'agent', agentAddress: '0xface' } }]) {
      const r = await call(prefix + '/one/retire', method, authentication, command);
      expect(r.status).toBe(403);
      expect(r.retireFailedJob).not.toHaveBeenCalled();
    }
  });
  it('keeps preview read-only and requires an exact digest and acknowledgment before apply', async () => {
    const path = prefix + '/one/retire';
    const preview = await call(path, 'GET', operator);
    expect(preview.status).toBe(200); expect(preview.retireFailedJob).toHaveBeenCalledWith('one', undefined);
    for (const invalid of [{}, { ...command, acceptUnknownEffects: false }, { ...command, extra: 'x' }, { ...command, expectedJobSha256: 'x' }]) {
      const r = await call(path, 'POST', operator, invalid);
      expect(r.status).toBe(400); expect(r.retireFailedJob).not.toHaveBeenCalled();
    }
    for (const [outcome, status] of [['retired', 200], ['not_found', 404], ['stale', 409], ['ineligible', 409], ['unsupported', 501]] as const) {
      const result = await call(path, 'POST', operator, command, outcome);
      expect(result.status).toBe(status); expect(result.retireFailedJob).toHaveBeenCalledWith('one', command);
    }
  });
  it('still reads an ordinary job whose own ID is retire', async () => {
    const originalGate = daemonState.promoteWorkerAvailable;
    try {
      daemonState.promoteWorkerAvailable = true;
      const r = await call(prefix + '/retire', 'GET', operator);
      expect(r.getPromoteAsyncStatus).toHaveBeenCalledWith('retire');
      expect(r.retireFailedJob).not.toHaveBeenCalled();
    } finally {
      daemonState.promoteWorkerAvailable = originalGate;
    }
  });
});
