import { expectTypeOf, test } from 'vitest';
import type { AgentListRow } from '../src/client.js';

// GH#310 — the row type states the route's invariants; these run under tsc
// via the vitest typecheck lane.
//
// The projection below asserts EVERY promised field independently — one
// aggregate invalid object stays invalid while any single field is still
// required, so it cannot catch one guarantee regressing at a time.
test('the full required projection matches the route contract exactly', () => {
  expectTypeOf<Pick<AgentListRow,
    | 'agentUri'
    | 'name'
    | 'peerId'
    | 'connectionStatus'
    | 'connectionTransport'
    | 'connectionDirection'
    | 'connectedSinceMs'
    | 'lastSeen'
    | 'latencyMs'
  >>().toEqualTypeOf<{
    agentUri: string;
    name: string;
    peerId: string;
    connectionStatus: 'self' | 'connected' | 'disconnected';
    connectionTransport: string | null;
    connectionDirection: string | null;
    connectedSinceMs: number | null;
    lastSeen: number | null;
    latencyMs: number | null;
  }>();
  // Optionalizing any one of these, widening the status union, or changing a
  // nullable's base type breaks the equality above; these keep the negative
  // direction explicit as well.
  // @ts-expect-error the endpoint cannot emit this status
  const badStatus: AgentListRow['connectionStatus'] = 'connecting';
  void badStatus;
  expectTypeOf<AgentListRow['framework']>().toEqualTypeOf<string | undefined>();
  expectTypeOf<AgentListRow['nodeRole']>().toEqualTypeOf<string | undefined>();
});
