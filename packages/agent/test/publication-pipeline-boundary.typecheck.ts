import type { DKGAgent } from '../src/index.js';
type InternalStage = 'runFinalizedAssertionPublication' | 'recordFinalizedAssertionMint'
  | 'runSharedMemoryPublication' | 'recordMintFromSharedMemory' | 'publishPreparedSharedMemory';
type Assert<T extends true> = T;
export type PublicationStagesAreInternal = Assert<Extract<InternalStage, keyof DKGAgent> extends never ? true : false>;
