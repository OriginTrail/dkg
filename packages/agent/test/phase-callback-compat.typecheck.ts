import type { PhaseCallback } from '@origintrail-official/dkg-publisher';

// Compile-time compatibility fixtures for the original void-style callback
// contract. Consumers commonly use expression bodies whose incidental return
// values must remain assignable even though emitters ignore those values.
const phases: string[] = [];
const pushCallback: PhaseCallback = (phase) => phases.push(phase);
const objectReturningCallback: PhaseCallback = () => ({ observed: true });
const asyncCallback: PhaseCallback = async (phase) => {
  await Promise.resolve();
  phases.push(phase);
};

void pushCallback;
void objectReturningCallback;
void asyncCallback;
