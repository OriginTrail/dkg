import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AGENT_CONNECTION_STATUSES,
  AGENT_LIST_WIRE_KEYS,
} from '@origintrail-official/dkg-core';

// GH#310 — Python cannot participate in the TypeScript compile-time contract,
// so this is the cross-language conformance check: it reads the plugin source
// (source-scanning tests are an established pattern in this repo) and holds
// its advertised schema and wire mapping against dkg-core's canonical
// declarations. A status added to AGENT_CONNECTION_STATUSES, or a changed
// wire spelling, fails HERE instead of drifting silently in the one adapter
// the compiler cannot see.
const source = readFileSync(new URL('../hermes-plugin/__init__.py', import.meta.url), 'utf8');

describe('hermes dkg_find_agents conformance with the dkg-core contract', () => {
  const schemaBlock = source.slice(
    source.indexOf('DKG_FIND_AGENTS_SCHEMA'),
    source.indexOf('DKG_SEND_MESSAGE_SCHEMA'),
  );

  it('advertises exactly the canonical connection-status domain', () => {
    const enumMatch = schemaBlock.match(/"enum":\s*\[([^\]]+)\]/);
    expect(enumMatch, 'connection_status enum not found in DKG_FIND_AGENTS_SCHEMA').toBeTruthy();
    const advertised = enumMatch![1]!
      .split(',')
      .map((entry) => entry.trim().replace(/^"|"$/g, ''));
    expect(advertised).toEqual([...AGENT_CONNECTION_STATUSES]);
  });

  it('advertises every tool argument the other adapters advertise', () => {
    for (const arg of ['framework', 'skill_type', 'connection_status', 'local', 'limit', 'cursor']) {
      expect(schemaBlock, `schema is missing "${arg}"`).toMatch(new RegExp(`"${arg}":\\s*\\{`));
    }
  });

  it('maps tool arguments to the canonical wire spellings', () => {
    const mapBlock = source.slice(
      source.indexOf('_FIND_AGENTS_ARG_TO_WIRE'),
      source.indexOf('def _handle_find_agents'),
    );
    const entries = Object.fromEntries(
      [...mapBlock.matchAll(/"([a-z_]+)":\s*"([a-zA-Z_]+)"/g)].map((m) => [m[1], m[2]]),
    );
    expect(entries).toEqual({
      framework: AGENT_LIST_WIRE_KEYS.framework,
      skill_type: AGENT_LIST_WIRE_KEYS.skillType,
      connection_status: AGENT_LIST_WIRE_KEYS.connectionStatus,
      local: AGENT_LIST_WIRE_KEYS.local,
      limit: AGENT_LIST_WIRE_KEYS.limit,
      cursor: AGENT_LIST_WIRE_KEYS.cursor,
    });
  });
});
