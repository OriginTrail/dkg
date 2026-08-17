import { describe, expect, it } from 'vitest';
import {
  CATCHUP_JOB_STATES,
  LEGACY_CATCHUP_JOB_STATES,
  toLegacyCatchupJobState,
} from '../src/catchup-status.js';

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
});
