import type { DKGAgent, PublicSnapshotSyncOptions } from '../dist/index.js';

declare const agent: DKGAgent;
declare const options: PublicSnapshotSyncOptions;

// The supported snapshot operations remain available from the package root.
void agent.syncPublicGraphSnapshot(options);
void agent.preparePublicGraphCheckpoint(options);
// @ts-expect-error Session admission, ownership and reader phases are internal orchestration.
void agent.withPublicSnapshotSession(options, async () => undefined);
// @ts-expect-error Internal orchestration is not a consumer-visible agent key.
const internalKey: keyof DKGAgent = 'withPublicSnapshotSession';
void internalKey;
