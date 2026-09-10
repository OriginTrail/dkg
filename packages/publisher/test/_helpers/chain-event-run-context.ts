import type { OperationContext } from '@origintrail-official/dkg-core';
import type { ChainEventDispatchContext } from '../../src/chain-event-dispatch-context.js';
import type { ChainEventLaneRunner } from '../../src/chain-event-lane-runner.js';
import type { ChainEventPollerConfig } from '../../src/chain-event-poller.js';

declare const operation: OperationContext;
declare const signal: AbortSignal;
declare const runner: ChainEventLaneRunner;
const context: ChainEventDispatchContext = { operation, signal };
void runner.poll(context);
void runner.restoreCurrentlyActive(context);

// @ts-expect-error Every admitted run must have its generation's signal.
const missingSignal: ChainEventDispatchContext = { operation };
// @ts-expect-error A standalone runner must explicitly own its run context.
void runner.poll();
// @ts-expect-error Startup restoration has the same ownership boundary.
void runner.restoreCurrentlyActive();
// @ts-expect-error A signal alone does not identify the run operation.
void runner.poll({ signal });
void missingSignal;

// Existing callback implementations may ignore the second argument.
const legacyCallbacks: Pick<ChainEventPollerConfig,
  'onContextGraphCreated' | 'onCollectionUpdated' | 'onAllowListUpdated'
  | 'onProfileEvent' | 'onKARegisteredToContextGraph' | 'onKnowledgeAssetCreated'> = {
  onContextGraphCreated: async info => { void info; },
  onCollectionUpdated: async info => { void info; },
  onAllowListUpdated: async info => { void info; },
  onProfileEvent: async info => { void info; },
  onKARegisteredToContextGraph: async info => { void info; },
  onKnowledgeAssetCreated: async info => { void info; },
};
const awareCallback: NonNullable<ChainEventPollerConfig['onContextGraphCreated']> = async (_info, run) => {
  const owningSignal: AbortSignal = run.signal;
  void owningSignal;
};
void legacyCallbacks;
void awareCallback;
