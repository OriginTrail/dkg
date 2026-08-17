import { describe, expect, it } from 'vitest';
import {
  CATCHUP_JOB_STATES,
  LEGACY_CATCHUP_JOB_STATES,
  toLegacyCatchupJobState,
} from '../src/catchup-status.js';
import {
  toCatchupStatusResponse,
  type CatchupJob,
} from '../src/daemon/types.js';

describe('catch-up status compatibility', () => {
  it('maps every precise state into the closed legacy wire vocabulary', () => {
    expect(CATCHUP_JOB_STATES.map(toLegacyCatchupJobState)).toEqual([
      'queued',
      'running',
      'done',
      'failed',
      'denied',
      'deferred',
      'unreachable',
      'unreachable',
    ]);
    expect(LEGACY_CATCHUP_JOB_STATES).not.toContain('partial');
  });

  it('projects internal jobs field-by-field without leaking future daemon state', () => {
    const job = {
      jobId: 'partial-job',
      contextGraphId: 'cg-selected',
      includeWorkspace: true,
      status: 'partial',
      queuedAt: 1,
      internalRetryLease: 'must-not-cross-wire-boundary',
    } satisfies CatchupJob & { internalRetryLease: string };

    expect(toCatchupStatusResponse(job)).toEqual({
      jobId: 'partial-job',
      contextGraphId: 'cg-selected',
      includeWorkspace: true,
      includeSharedMemory: true,
      status: 'unreachable',
      jobStatus: 'partial',
      queuedAt: 1,
    });
  });
});
