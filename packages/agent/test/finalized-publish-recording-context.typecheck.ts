import type { DKGAgent } from '../src/dkg-agent.js';
import type { FinalizedAssertionRecordingContext } from '../src/internal/agent-publish-options.js';

declare const agent: DKGAgent;
declare const recording: FinalizedAssertionRecordingContext;
// @ts-expect-error Public publish options do not expose lifecycle coordination.
void agent.publishFromFinalizedAssertion('cg', 'name', { heldLifecycle: recording.heldLifecycle });
// @ts-expect-error A prepared reservation cannot travel without its exact lifecycle lease.
const missingLease: FinalizedAssertionRecordingContext = { reservation: recording.reservation };
// @ts-expect-error A held lease cannot travel without the reservation it protects.
const missingReservation: FinalizedAssertionRecordingContext = { heldLifecycle: recording.heldLifecycle };
void missingLease; void missingReservation;
