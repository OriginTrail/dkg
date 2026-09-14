import type { SchedulerPressureCapacitySnapshot } from '@origintrail-official/dkg-core';

const shared: SchedulerPressureCapacitySnapshot = {
  kind: 'uniform', model: 'shared', queueLimit: 8, inflightLimit: 4,
};
const partitioned: SchedulerPressureCapacitySnapshot = {
  kind: 'uniform', model: 'partitioned', queueLimit: null, inflightLimit: null,
};
const mixed: SchedulerPressureCapacitySnapshot = {
  kind: 'mixed', model: 'mixed', queueLimit: null, inflightLimit: null,
};

// @ts-expect-error Mixed owners never form a shared pool.
const disguisedMixed: SchedulerPressureCapacitySnapshot = {
  kind: 'mixed', model: 'shared', queueLimit: null, inflightLimit: null,
};
// @ts-expect-error Mixed owners have no common queue ceiling.
const boundedMixed: SchedulerPressureCapacitySnapshot = {
  kind: 'mixed', model: 'mixed', queueLimit: 8, inflightLimit: null,
};

void [shared, partitioned, mixed, disguisedMixed, boundedMixed];
