import { describe, expect, it } from 'vitest';

import {
  SWM_MATERIALIZATION_WITNESS_GRAPH,
  invalidateSwmMaterializationWitness,
  readSwmMaterializationWitness,
  swmMaterializationWitnessSubject,
  writeSwmMaterializationWitness,
} from '@origintrail-official/dkg-storage';

describe('legacy SWM materialization witness package-root compatibility', () => {
  it('retains the shipped runtime exports until the next major release', () => {
    expect(SWM_MATERIALIZATION_WITNESS_GRAPH)
      .toBe('urn:dkg:local:swm-materialization-witness');
    expect(swmMaterializationWitnessSubject('urn:test:graph'))
      .toBe('urn:test:graph#dkg-swm-materialized');
    expect(typeof readSwmMaterializationWitness).toBe('function');
    expect(typeof writeSwmMaterializationWitness).toBe('function');
    expect(typeof invalidateSwmMaterializationWitness).toBe('function');
  });
});
