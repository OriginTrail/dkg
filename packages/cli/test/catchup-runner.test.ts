import { describe, expect, it } from 'vitest';
import { catchupPeerResponded, catchupPeerSucceeded } from '../src/catchup-runner.js';

describe('catchup runner progress accounting', () => {
  it('does not count timed-out peers as success, including after partial progress', () => {
    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 1,
      completedPhases: 0,
      checkpointAdvances: 0,
    }, null, false)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 1,
      completedPhases: 1,
      checkpointAdvances: 0,
      insertedTriples: 0,
    }, null, false)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 1,
      completedPhases: 1,
      resumedPhases: 1,
      checkpointAdvances: 0,
      insertedTriples: 0,
    }, null, false)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 1,
      completedPhases: 0,
      checkpointAdvances: 1,
    }, null, false)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 1,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 1,
      insertedDataTriples: 1,
    }, null, false)).toBe(false);
  });

  it('does not count metadata-only delivery as peer success', () => {
    const metadataOnly = {
      failedPeers: 0,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 1,
      insertedDataTriples: 0,
      insertedMetaTriples: 1,
      metaOnlyResponses: 1,
    };
    expect(catchupPeerResponded(metadataOnly, null)).toBe(true);
    expect(catchupPeerSucceeded(metadataOnly, null, false)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 0,
    }, null, false)).toBe(true);
  });

  it('tracks timeout responses separately from successful peers', () => {
    const timeoutOnly = {
      failedPeers: 0,
      timedOutPhases: 1,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 0,
    };
    expect(catchupPeerResponded(timeoutOnly, null)).toBe(true);
    expect(catchupPeerSucceeded(timeoutOnly, null, false)).toBe(false);

    const transportFailure = {
      failedPeers: 1,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 0,
    };
    expect(catchupPeerResponded(transportFailure, null)).toBe(false);
    expect(catchupPeerSucceeded(transportFailure, null, false)).toBe(false);
  });

  it('counts either durable or shared-memory transport response as peer responded', () => {
    const durableAnswered = {
      failedPeers: 0,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
      insertedTriples: 0,
    };
    const sharedTransportFailure = {
      failedPeers: 1,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 0,
    };
    expect(catchupPeerResponded(durableAnswered, sharedTransportFailure)).toBe(true);
    expect(catchupPeerSucceeded(durableAnswered, sharedTransportFailure, false)).toBe(false);

    const durableTransportFailure = {
      failedPeers: 1,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 0,
    };
    const sharedAnswered = {
      failedPeers: 0,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
      insertedTriples: 0,
    };
    expect(catchupPeerResponded(durableTransportFailure, sharedAnswered)).toBe(true);
    expect(catchupPeerSucceeded(durableTransportFailure, sharedAnswered, false)).toBe(false);
  });

  it('does not count denied or failed peers as success', () => {
    expect(catchupPeerSucceeded({
      failedPeers: 0,
      failedPhases: 1,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
    }, null, false)).toBe(false);
    expect(catchupPeerResponded({
      failedPeers: 0,
      failedPhases: 1,
    }, null)).toBe(true);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
    }, null, true)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 1,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
    }, null, false)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
    }, {
      failedPeers: 1,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
    }, false)).toBe(false);
  });
});
