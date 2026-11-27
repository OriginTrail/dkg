import { describe, expect, it } from 'vitest';

import {
  AGENT_LIST_WIRE_KEY_VALUES,
  serializeAgentListOptions,
} from '../src/agents-list-wire.js';

describe('agents-list wire contract', () => {
  it('keeps the accepted query-key vocabulary complete and stable', () => {
    expect(AGENT_LIST_WIRE_KEY_VALUES).toEqual([
      'framework',
      'skill_type',
      'connectionStatus',
      'local',
      'limit',
      'cursor',
    ]);
  });

  it('omits absent options', () => {
    expect(serializeAgentListOptions({})).toBe('');
  });

  it('serializes every option through its wire key and URL-encodes values', () => {
    expect(
      serializeAgentListOptions({
        framework: 'open claw',
        skillType: 'search&query',
        connectionStatus: 'disconnected',
        local: false,
        limit: 25,
        cursor: 'next=value',
      }),
    ).toBe(
      'framework=open+claw&skill_type=search%26query&connectionStatus=disconnected&local=false&limit=25&cursor=next%3Dvalue',
    );
  });
});
