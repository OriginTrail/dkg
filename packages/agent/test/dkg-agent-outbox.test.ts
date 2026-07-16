import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_MESSAGE,
  PROTOCOL_SYNC,
  type ProtocolOutboxMetadata,
} from '@origintrail-official/dkg-core';
import { AgentRegistryMethods } from '../src/dkg-agent-registry.js';
import type { DKGAgent } from '../src/dkg-agent.js';

const CHAT_ENTRY: ProtocolOutboxMetadata = {
  peer: 'peer-chat',
  protocol: PROTOCOL_MESSAGE,
  messageId: 'chat-message',
  attempts: 2,
  firstFailureAt: 1_000,
  lastAttemptAt: 2_000,
  nextAttemptAt: 3_000,
  lastError: 'peer offline',
};

const SYNC_ENTRY: ProtocolOutboxMetadata = {
  peer: 'peer-sync',
  protocol: PROTOCOL_SYNC,
  messageId: 'sync-message',
  attempts: 1,
  firstFailureAt: 4_000,
  lastAttemptAt: 5_000,
  nextAttemptAt: 6_000,
  lastError: 'stream reset',
};

describe('AgentRegistryMethods message outbox', () => {
  it('returns only payload-free chat metadata without reading payload-bearing entries', () => {
    const agent = {
      messenger: {
        listOutboxMetadata: () => [CHAT_ENTRY, SYNC_ENTRY],
        listOutbox: () => {
          throw new Error('payload-bearing outbox should not be read');
        },
      },
    } as unknown as DKGAgent;

    const entries = AgentRegistryMethods.prototype.listMessageOutboxMetadata.call(agent);

    expect(entries).toEqual([CHAT_ENTRY]);
    expect(entries.every((entry) => !('payload' in entry))).toBe(true);
  });
});
