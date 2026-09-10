// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '@origintrail-official/dkg-agent';

declare const agent: DKGAgent;
type DiscoveryOptions = NonNullable<Parameters<DKGAgent['discoverContextGraphsFromChain']>[0]>;

// Canonical modes and legacy-only requests remain public API inputs.
void agent.discoverContextGraphsFromChain();
void agent.discoverContextGraphsFromChain({});
void agent.discoverContextGraphsFromChain({ mode: 'listAll' });
void agent.discoverContextGraphsFromChain({ mode: 'incremental', pageBudget: 2 });
void agent.discoverContextGraphsFromChain({ mode: 'seedFull', throwOnChainScanFailure: true });
void agent.discoverContextGraphsFromChain({ mode: 'seedFromCursor', pageBudget: 2 });
void agent.discoverContextGraphsFromChain({ incremental: true, pageBudget: 2 });
void agent.discoverContextGraphsFromChain({ seedIncrementalWatermark: true });
void agent.discoverContextGraphsFromChain({ seedIncrementalWatermark: true, resumeFromCursor: true });
void agent.discoverContextGraphsFromChain({ incremental: false, resumeFromCursor: false });

// @ts-expect-error Canonical mode excludes the legacy incremental flag.
void agent.discoverContextGraphsFromChain({ mode: 'seedFull', incremental: true });
// @ts-expect-error Canonical mode excludes legacy watermark seeding.
void agent.discoverContextGraphsFromChain({ mode: 'listAll', seedIncrementalWatermark: true });
// @ts-expect-error Canonical mode excludes legacy resume flags, including false.
void agent.discoverContextGraphsFromChain({ mode: 'incremental', resumeFromCursor: false });

// The same exclusivity applies to typed variables, not only excess properties.
// @ts-expect-error A canonical request cannot carry a legacy flag.
const mixed: DiscoveryOptions = { mode: 'seedFromCursor', incremental: false };
void mixed;
