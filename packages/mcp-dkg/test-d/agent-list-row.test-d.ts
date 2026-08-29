import { expectTypeOf, test } from 'vitest';
import type { AgentListRow } from '../src/client.js';

// GH#310 — the row type states the route's invariants; these run under tsc
// via the vitest typecheck lane.
test('AgentListRow requires the route guarantees and closes the status union', () => {
  // @ts-expect-error identity + enrichment fields are required
  const missingIdentity: AgentListRow = { connectionStatus: 'connected' };
  // @ts-expect-error the endpoint cannot emit this status
  const badStatus: AgentListRow['connectionStatus'] = 'connecting';
  void missingIdentity;
  void badStatus;
  expectTypeOf<AgentListRow['peerId']>().toEqualTypeOf<string>();
  expectTypeOf<AgentListRow['latencyMs']>().toEqualTypeOf<number | null>();
});
