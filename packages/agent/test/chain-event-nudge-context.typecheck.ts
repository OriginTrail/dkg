import type { OperationContext } from '@origintrail-official/dkg-core';
import type { ChainEventDispatchContext } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from '../src/dkg-agent.js';

declare const agent: DKGAgent;
declare const context: ChainEventDispatchContext;
declare const operation: OperationContext;
declare const signal: AbortSignal;

void agent.handleKARegisteredNudge('1', 1n, context);
// @ts-expect-error An event nudge is always dispatched from an admitted run.
void agent.handleKARegisteredNudge('1', 1n);
// @ts-expect-error A bare operation context is not an admitted-run context.
void agent.handleKARegisteredNudge('1', 1n, operation);
// @ts-expect-error The generation signal cannot be paired with a foreign operation by hand.
void agent.handleKARegisteredNudge('1', 1n, operation, signal);
// @ts-expect-error A complete operation/signal object still lacks admission provenance.
void agent.handleKARegisteredNudge('1', 1n, { operation, signal });
// @ts-expect-error The dispatch context carries its own cancellation.
void agent.handleKARegisteredNudge('1', 1n, { operation });
// @ts-expect-error The dispatch context carries its own operation.
void agent.handleKARegisteredNudge('1', 1n, { signal });
