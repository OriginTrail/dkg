import type { OperationContext } from '@origintrail-official/dkg-core';
import type { DKGAgent } from '../src/index.js';

declare const agent: DKGAgent;
declare const context: OperationContext;

agent.startRfc64PublicCatalogServiceV1(context);
const closing: Promise<void> = agent.closeRfc64PublicCatalogServiceV1();
void closing;
