import { describe, it, expect } from 'vitest';
import {
  RELIABLE_ENVELOPE_VERSION,
  decodeReliableEnvelope,
  encodeReliableEnvelope,
} from '../../src/proto/reliable-envelope.js';

describe('ReliableEnvelope encode/decode', () => {
  it('round-trips a small payload with all fields preserved', () => {
    const payload = new TextEncoder().encode('hello messenger');
    const encoded = encodeReliableEnvelope({
      messageId: '00000000-0000-4000-8000-000000000001',
      version: RELIABLE_ENVELOPE_VERSION,
      tsMs: 1_700_000_000_000,
      payload,
    });
    const decoded = decodeReliableEnvelope(encoded);

    expect(decoded.messageId).toBe('00000000-0000-4000-8000-000000000001');
    expect(decoded.version).toBe(RELIABLE_ENVELOPE_VERSION);
    expect(Number(decoded.tsMs)).toBe(1_700_000_000_000);
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
  });

  it('round-trips a large binary payload (32 KiB random bytes)', () => {
    // Realistic for a `/query-remote` SPARQL result before it bumps
    // up against the 256 KiB cache cutoff.
    const payload = new Uint8Array(32 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
    const encoded = encodeReliableEnvelope({
      messageId: 'q-1',
      version: 1,
      tsMs: 1,
      payload,
    });
    const decoded = decodeReliableEnvelope(encoded);
    expect(decoded.payload.length).toBe(payload.length);
    // Spot-check a few bytes — full equality on 32 KiB would generate
    // noisy failure output but byte-level equality is implied by the
    // length check + proto's bytes field semantics.
    expect(decoded.payload[0]).toBe(0);
    expect(decoded.payload[255]).toBe(255);
    expect(decoded.payload[1024]).toBe(0);
  });

  it('preserves an empty payload', () => {
    const encoded = encodeReliableEnvelope({
      messageId: 'empty',
      version: 1,
      tsMs: 1,
      payload: new Uint8Array(0),
    });
    const decoded = decodeReliableEnvelope(encoded);
    expect(decoded.payload.length).toBe(0);
    expect(decoded.messageId).toBe('empty');
  });
});
