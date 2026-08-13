import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_READ_BYTES,
  JAVA_WRITE_UTF_MAX_BYTES,
} from '@origintrail-official/dkg-core';
import {
  SYNC_BYTE_BUDGET_MAX_ROWS,
  SYNC_BYTE_BUDGET_RESPONSE_BYTES,
  SYNC_PAGE_GROWTH_SUCCESS_THRESHOLD,
  SYNC_PAGE_SIZE,
  SYNC_REQUEST_INITIAL_PAGE_SIZE,
  SYNC_REQUEST_PAGE_SIZE,
  SYNC_REQUEST_SAFE_PAGE_SIZE,
  SYNC_RESPONSE_FRAME_HEADROOM_BYTES,
} from '../src/dkg-agent-constants.js';

function encodedPageBytes(rows: number, literalBytes: number): number {
  const literal = 'x'.repeat(literalBytes);
  const nquad = `<urn:dkg:sync-frame:${'s'.repeat(256)}> ` +
    `<urn:dkg:sync-frame:${'p'.repeat(128)}> ` +
    `"${literal}" ` +
    `<urn:dkg:sync-frame:${'g'.repeat(256)}> .\n`;
  return new TextEncoder().encode(nquad.repeat(rows)).byteLength;
}

describe('sync requester transport frame budget', () => {
  it('keeps the adaptive retry floor below the protocol read cap', () => {
    expect(SYNC_REQUEST_PAGE_SIZE).toBe(8_192);
    expect(SYNC_REQUEST_PAGE_SIZE).toBe(SYNC_BYTE_BUDGET_MAX_ROWS);
    expect(SYNC_REQUEST_INITIAL_PAGE_SIZE).toBe(512);
    expect(SYNC_PAGE_GROWTH_SUCCESS_THRESHOLD).toBe(8);
    expect(SYNC_REQUEST_SAFE_PAGE_SIZE).toBe(64);
    expect(SYNC_RESPONSE_FRAME_HEADROOM_BYTES).toBe(6 * 1024 * 1024);
    expect(SYNC_BYTE_BUDGET_RESPONSE_BYTES).toBe(4 * 1024 * 1024);
    expect(SYNC_BYTE_BUDGET_RESPONSE_BYTES).toBeLessThan(DEFAULT_MAX_READ_BYTES);
    expect(encodedPageBytes(SYNC_REQUEST_SAFE_PAGE_SIZE, JAVA_WRITE_UTF_MAX_BYTES))
      .toBeLessThan(DEFAULT_MAX_READ_BYTES);
  });

  it('reproduces why the legacy 500-row request cannot carry large literals', () => {
    expect(encodedPageBytes(SYNC_PAGE_SIZE, 32 * 1024))
      .toBeGreaterThan(DEFAULT_MAX_READ_BYTES);
  });
});
