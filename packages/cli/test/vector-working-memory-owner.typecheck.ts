// SPDX-License-Identifier: Apache-2.0
import type { EmbeddingRecord } from '../src/vector-store.js';

const common = { embedding: [1, 0], sourceUri: 'source', entityUri: 'entity', contextGraphId: 'cg', model: 'test' };
const ownedWorkingMemory: EmbeddingRecord = { ...common, memoryLayer: 'wm', agentAddress: 'agent-a' };
const unknownWorkingMemory: EmbeddingRecord = { ...common, memoryLayer: 'wm', agentAddress: { kind: 'unknown' } };
const sharedMemory: EmbeddingRecord = { ...common, memoryLayer: 'swm' };
const verifiableMemory: EmbeddingRecord = { ...common, memoryLayer: 'vm' };
// @ts-expect-error New working-memory inserts must explicitly declare ownership.
const missingWorkingMemoryOwner: EmbeddingRecord = { ...common, memoryLayer: 'wm' };
// @ts-expect-error A nullable migrated database owner is not a new-write ownership declaration.
const nullableDatabaseOwner: EmbeddingRecord = { ...common, memoryLayer: 'wm', agentAddress: null };
void [nullableDatabaseOwner, ownedWorkingMemory, unknownWorkingMemory, sharedMemory, verifiableMemory, missingWorkingMemoryOwner];
