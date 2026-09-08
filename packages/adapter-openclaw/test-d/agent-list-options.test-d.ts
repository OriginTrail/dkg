import { expectTypeOf, test } from 'vitest';
import type { AgentListOptions, FindAgentsToolArg } from '../src/agent-list.js';
import type { RAW_ARG_TO_OPTION } from '../src/agent-list.js';
import type { DkgDaemonClient } from '../src/dkg-client.js';

declare const client: DkgDaemonClient;

// GH#310 — raw model spellings belong to the tool boundary
// (getAgentsUnvalidated), never to the strict SDK surface. These run under
// tsc via the vitest typecheck lane; in an ordinary runtime test the types
// are stripped and @ts-expect-error proves nothing.
test('strict getAgents rejects raw model values at compile time', () => {
  // @ts-expect-error limit must be a number
  void client.getAgents({ limit: '10junk' });
  // @ts-expect-error local must be a boolean
  void client.getAgents({ local: 'ture' });
  // @ts-expect-error connection_status is a wire/tool spelling, not an option
  void client.getAgents({ connection_status: 'connected' });
  // @ts-expect-error statuses are a closed union
  void client.getAgents({ connectionStatus: 'connecting' });
  // The deprecated alias stays accepted for pre-GH#310 callers.
  void client.getAgents({ skill_type: 'ImageAnalysis' });
  expectTypeOf<AgentListOptions['limit']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<AgentListOptions['local']>().toEqualTypeOf<boolean | undefined>();
});

test('the raw map is exhaustive over the tool vocabulary', () => {
  // The vocabulary IS keyof the schema object now, so only the mapping can
  // drift: an argument advertised without a mapping (or a mapping for an
  // unadvertised argument) must fail compilation, not silently drop.
  expectTypeOf<keyof typeof RAW_ARG_TO_OPTION>().toEqualTypeOf<FindAgentsToolArg>();
});
