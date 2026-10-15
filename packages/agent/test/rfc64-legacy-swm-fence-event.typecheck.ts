// SPDX-License-Identifier: Apache-2.0

/**
 * The kind of a legacy SWM fence event says which fields it carries (#3250
 * review): an admission wait names the promote's asset and how the wait ended,
 * and a fence that gave up names what it waited on and the preparations in
 * flight. Compiled by `pnpm run test:types`; never executed.
 */
import type { Rfc64LegacySwmFenceEventV1 } from '../src/rfc64/legacy-swm-boundary-fence-v1.js';

const base = { source: 'receiver-lease', scope: 'graph', contextGraphId: 'cg', elapsedMs: 1 } as const;

export const admissionWait: Rfc64LegacySwmFenceEventV1 = {
  ...base, kind: 'admission-wait', kaUal: 'ual', waitEnd: 'unfenced',
};
// @ts-expect-error an admission wait must name the asset of the promote
export const admissionWaitWithoutAsset: Rfc64LegacySwmFenceEventV1 = { ...base, kind: 'admission-wait', waitEnd: 'closed' };
// @ts-expect-error an admission wait must say how it ended
export const admissionWaitWithoutEnd: Rfc64LegacySwmFenceEventV1 = { ...base, kind: 'admission-wait', kaUal: 'ual' };

export const waitExceeded: Rfc64LegacySwmFenceEventV1 = {
  ...base, kind: 'wait-exceeded', waitingOn: 'preparations', activePreparations: 1,
};
// @ts-expect-error a fence that gave up must say what it waited on
export const waitExceededWithoutWaitingOn: Rfc64LegacySwmFenceEventV1 = { ...base, kind: 'wait-exceeded', activePreparations: 1 };
// @ts-expect-error a fence that gave up must count the preparations in flight
export const waitExceededWithoutCount: Rfc64LegacySwmFenceEventV1 = { ...base, kind: 'wait-exceeded', waitingOn: 'preparations' };

export const longFence: Rfc64LegacySwmFenceEventV1 = { ...base, kind: 'long-fence', kaUal: 'ual' };
// @ts-expect-error a long fence carries no wait end
export const longFenceWithEnd: Rfc64LegacySwmFenceEventV1 = { ...base, kind: 'long-fence', waitEnd: 'unfenced' };

/** Narrowing on the kind gives each variant's own fields, and only those. */
export function detailOf(event: Rfc64LegacySwmFenceEventV1): string {
  switch (event.kind) {
    case 'admission-wait':
      return `${event.kaUal} ${event.waitEnd}`;
    case 'wait-exceeded':
      return `${event.waitingOn} ${event.activePreparations}`;
    case 'long-fence':
      // @ts-expect-error only an admission wait has an end
      return String(event.waitEnd);
  }
}
