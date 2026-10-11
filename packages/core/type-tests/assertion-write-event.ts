import { MemoryLayer, type AssertionEvent, type AssertionState } from '@origintrail-official/dkg-core';

const written: AssertionEvent = {
  type: 'written', timestamp: '2026-10-11T00:00:00Z',
  fromLayer: MemoryLayer.WorkingMemory, toLayer: MemoryLayer.WorkingMemory,
};
void written;
// A write is an activity within WM, rather than a lifecycle transition.
// @ts-expect-error Writing does not create a new assertion lifecycle state.
const state: AssertionState = 'written';
void state;
