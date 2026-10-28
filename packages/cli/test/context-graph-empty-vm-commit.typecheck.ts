import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { withProvenEmptyPrivateVmReadiness } from '../src/context-graph-empty-vm-readiness-owner.js';

declare const agent: DKGAgent;
declare const signal: AbortSignal;

const input = { agent, contextGraphId: 'graph', callerAgentAddress: 'caller', signal };
withProvenEmptyPrivateVmReadiness({ ...input, commit: () => 'written' });

// @ts-expect-error asynchronous readiness commits are forbidden
withProvenEmptyPrivateVmReadiness({ ...input, commit: async () => 'late' });
