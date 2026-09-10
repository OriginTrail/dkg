import type { OperationContext } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../src/dkg-agent.js';

declare const agent: DKGAgent;
declare const operation: OperationContext;
declare const signal: AbortSignal;

void agent.handleKARegisteredNudge('1', 1n, operation, signal);
// @ts-expect-error Event nudges cannot bypass their owning generation's signal.
void agent.handleKARegisteredNudge('1', 1n, operation);
