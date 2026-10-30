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

import type { FinalizedAssertionSelectionHost, FinalizedAssertionMintHost } from '../src/internal/finalized-assertion-publication.js';
declare const selection: FinalizedAssertionSelectionHost;
declare const mint: FinalizedAssertionMintHost;
// @ts-expect-error Selection cannot execute an update.
void selection.update;
// @ts-expect-error Mint completion cannot construct update attestations.
void mint._buildPrecomputedUpdateAttestationForSeal;
// @ts-expect-error Mint completion does not load or canonicalize SWM content.
void mint._loadSelectedSWMQuads;

import {
  completeFinalizedAssertionMint, createFinalizedAssertionMintCheckpoint,
  finalizedMintOptions, type FinalizedAssertionMintPlan, prepareFinalizedAssertionUpdateContent, publishFinalizedAssertionUpdate,
  type FinalizedAssertionUpdateHost,
} from '../src/internal/finalized-assertion-publication.js';
import type { PublishResult } from '@origintrail-official/dkg-publisher';
declare const updatePlan: Awaited<ReturnType<typeof prepareFinalizedAssertionUpdateContent>>;
declare const mintPlan: FinalizedAssertionMintPlan;
declare const updateHost: FinalizedAssertionUpdateHost;
declare const result: PublishResult;
void completeFinalizedAssertionMint(mint, mintPlan, result);
void publishFinalizedAssertionUpdate(updateHost, updatePlan);
// @ts-expect-error Update preparation cannot enter mint-only lifecycle completion.
void completeFinalizedAssertionMint(mint, updatePlan, result);
// @ts-expect-error Updates cannot create mint-recovery checkpoints.
void createFinalizedAssertionMintCheckpoint(mint, updatePlan);
// @ts-expect-error Mint selection cannot enter the update execution boundary.
void publishFinalizedAssertionUpdate(updateHost, mintPlan);
// @ts-expect-error Update selection cannot configure a mint publication.
void finalizedMintOptions(updatePlan);
