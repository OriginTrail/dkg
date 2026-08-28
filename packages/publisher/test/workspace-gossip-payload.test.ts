import { describe, expect, it } from 'vitest';
import {
  createCapturedWorkspaceGossipPayload,
  createResolveCurrentWorkspaceGossipPayload,
  parseEncodedWorkspaceGossipPayload,
} from '../src/workspace-gossip-payload.js';

describe('workspace gossip payload', () => {
  it('constructs and parses resolve-current payloads without copying their bytes', () => {
    const message = new Uint8Array([1, 2, 3]);
    const payload = createResolveCurrentWorkspaceGossipPayload(message);
    const parsed = parseEncodedWorkspaceGossipPayload(payload);

    expect(payload).toEqual({ message, fanout: { kind: 'resolve-current' } });
    expect(payload.message).toBe(message);
    expect(parsed.message).toBe(message);
    expect(parsed).not.toBe(payload);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.fanout)).toBe(true);
  });

  it('owns and freezes captured metadata while retaining zero-copy message bytes', () => {
    const message = new Uint8Array([4, 5, 6]);
    const members = ['12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb'];
    const snapshot = {
      source: 'agent-roster' as const,
      members,
      complete: true,
    };
    const payload = createCapturedWorkspaceGossipPayload(message, snapshot);

    members.push('12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh');
    snapshot.complete = false;

    expect(payload.message).toBe(message);
    expect(payload.fanout).toEqual({
      kind: 'captured',
      snapshot: {
        source: 'agent-roster',
        members: ['12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb'],
        complete: true,
      },
    });
    expect(payload.fanout.kind === 'captured' && payload.fanout.snapshot).not.toBe(snapshot);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.fanout)).toBe(true);
    expect(payload.fanout.kind === 'captured' && Object.isFrozen(payload.fanout.snapshot)).toBe(true);
    expect(payload.fanout.kind === 'captured' && Object.isFrozen(payload.fanout.snapshot.members)).toBe(true);
  });

  it('normalizes parsed captured metadata through the owning factory', () => {
    const message = new Uint8Array([7, 8, 9]);
    const peerId = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
    const members = [peerId, `  ${peerId}  `];
    const input = {
      message,
      fanout: {
        kind: 'captured',
        snapshot: { source: 'agent-roster', members, complete: true },
      },
    };

    const parsed = parseEncodedWorkspaceGossipPayload(input);
    members.length = 0;

    expect(parsed.message).toBe(message);
    expect(parsed.fanout.kind === 'captured' && parsed.fanout.snapshot.members).toEqual([
      peerId,
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('rejects malformed captured peer IDs before a complete snapshot can disable gossip', () => {
    expect(() => parseEncodedWorkspaceGossipPayload({
      message: new Uint8Array([7, 8, 9]),
      fanout: {
        kind: 'captured',
        snapshot: { source: 'agent-roster', members: ['not-a-peer-id'], complete: true },
      },
    })).toThrow(/invalid peer ID/);
  });

  it.each([
    undefined,
    new Uint8Array([1]),
    { message: 'not-bytes', fanout: { kind: 'resolve-current' } },
    { message: new Uint8Array([1]) },
  ])('rejects a malformed encoded payload: %o', (value) => {
    expect(() => parseEncodedWorkspaceGossipPayload(value)).toThrow(
      /requires encoded bytes with fan-out provenance/,
    );
  });

  it.each([
    { message: new Uint8Array([1]), fanout: { kind: 'captured' } },
    {
      message: new Uint8Array([1]),
      fanout: { kind: 'captured', snapshot: { source: 'other', members: [], complete: true } },
    },
    {
      message: new Uint8Array([1]),
      fanout: { kind: 'captured', snapshot: { source: 'agent-roster', members: [1], complete: true } },
    },
    {
      message: new Uint8Array([1]),
      fanout: { kind: 'captured', snapshot: { source: 'agent-roster', members: [], complete: 'yes' } },
    },
  ])('rejects an incomplete captured snapshot: %o', (value) => {
    expect(() => parseEncodedWorkspaceGossipPayload(value)).toThrow(
      /requires a complete captured fan-out snapshot/,
    );
  });
});
