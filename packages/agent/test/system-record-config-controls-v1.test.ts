/**
 * Contract tests for the Stack D system-record config controls (plan `:1436`).
 *
 * Two properties carry this slice, and each has a fixture shape that would hide
 * a real defect if chosen carelessly:
 *
 *  - DEFAULT-OFF. Asserting the declared field is optional proves nothing; the
 *    claim is about the RESOLVED value with nothing set. The neighbouring
 *    switches resolve with `true`, so a copied default is a live hazard rather
 *    than a hypothetical one.
 *  - INDEPENDENCE / no cross-wiring. Four booleans share only two values, so a
 *    fixture setting all four `true` and asserting all four `true` passes even
 *    if two slots are wired from each other's source. Every forwarding case
 *    below rotates a single `true` instead.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  pickSystemRecordConfigControlsV1,
  systemRecordLegacyCapablePeerSelectionEnabledV1,
  systemRecordProducerTrackingEnabledV1,
  systemRecordProviderAdvertisementEnabledV1,
  systemRecordRequesterLaneEnabledV1,
  type SystemRecordConfigControlsV1,
} from '../src/system-records/config-controls-v1.js';

/** The four controls, each paired with its resolver and env override. */
const CONTROLS = [
  {
    field: 'systemRecordProducerTrackingEnabled',
    env: 'DKG_SYSTEM_RECORD_PRODUCER_TRACKING_ENABLED',
    resolve: systemRecordProducerTrackingEnabledV1,
  },
  {
    field: 'systemRecordProviderAdvertisementEnabled',
    env: 'DKG_SYSTEM_RECORD_PROVIDER_ADVERTISEMENT_ENABLED',
    resolve: systemRecordProviderAdvertisementEnabledV1,
  },
  {
    field: 'systemRecordRequesterLaneEnabled',
    env: 'DKG_SYSTEM_RECORD_REQUESTER_LANE_ENABLED',
    resolve: systemRecordRequesterLaneEnabledV1,
  },
  {
    field: 'systemRecordLegacyCapablePeerSelectionEnabled',
    env: 'DKG_SYSTEM_RECORD_LEGACY_CAPABLE_PEER_SELECTION_ENABLED',
    resolve: systemRecordLegacyCapablePeerSelectionEnabledV1,
  },
] as const satisfies readonly {
  field: keyof SystemRecordConfigControlsV1;
  env: string;
  resolve: (config: Partial<SystemRecordConfigControlsV1>) => boolean;
}[];

const ENV_NAMES = CONTROLS.map((control) => control.env);

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const previous = savedEnv[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

describe('system-record config controls — default OFF (:1436)', () => {
  it('resolves false for every control when nothing is configured', () => {
    for (const control of CONTROLS) {
      expect(control.resolve({}), `${control.field} must default OFF`).toBe(false);
    }
  });

  it('resolves false when the field is explicitly undefined', () => {
    for (const control of CONTROLS) {
      expect(control.resolve({ [control.field]: undefined })).toBe(false);
    }
  });

  it('resolves true only when explicitly enabled', () => {
    for (const control of CONTROLS) {
      expect(control.resolve({ [control.field]: true })).toBe(true);
      expect(control.resolve({ [control.field]: false })).toBe(false);
    }
  });
});

describe('system-record config controls — independence (:1436)', () => {
  // One-hot: enabling exactly one control must leave the other three OFF. A
  // fixture enabling all four could not distinguish independence from four
  // slots reading one shared source.
  it('enabling one control leaves the other three resolving false', () => {
    for (const enabled of CONTROLS) {
      const config: Partial<SystemRecordConfigControlsV1> = { [enabled.field]: true };
      for (const other of CONTROLS) {
        const expected = other.field === enabled.field;
        expect(
          other.resolve(config),
          `enabling ${enabled.field} must not change ${other.field}`,
        ).toBe(expected);
      }
    }
  });

  it('no control is gated by any other being enabled first', () => {
    // The inverse direction: with the other three explicitly OFF, each control
    // must still be able to turn on by itself. This is what "independent"
    // forbids a nested/parent-gated shape from doing.
    for (const enabled of CONTROLS) {
      const config = Object.fromEntries(
        CONTROLS.map((control) => [control.field, control.field === enabled.field]),
      ) as Partial<SystemRecordConfigControlsV1>;
      expect(enabled.resolve(config)).toBe(true);
    }
  });
});

describe('system-record config controls — env override', () => {
  it('lets the env variable win over the configured value, per control', () => {
    for (const control of CONTROLS) {
      process.env[control.env] = 'false';
      expect(control.resolve({ [control.field]: true })).toBe(false);
      process.env[control.env] = 'true';
      expect(control.resolve({ [control.field]: false })).toBe(true);
      delete process.env[control.env];
    }
  });

  it('scopes each env variable to its own control', () => {
    // Setting one env must not enable a different control — the env-name
    // equivalent of the cross-wiring check below.
    for (const enabled of CONTROLS) {
      process.env[enabled.env] = 'true';
      for (const other of CONTROLS) {
        expect(other.resolve({}), `${enabled.env} must only affect ${enabled.field}`)
          .toBe(other.field === enabled.field);
      }
      delete process.env[enabled.env];
    }
  });
});

describe('pickSystemRecordConfigControlsV1 — the CLI forwarding chokepoint', () => {
  it('returns all four keys when the source is empty', () => {
    // Every key present (even undefined) so the spread at the call site keeps
    // the property names greppable in the resulting agent config.
    expect(pickSystemRecordConfigControlsV1({})).toEqual({
      systemRecordProducerTrackingEnabled: undefined,
      systemRecordProviderAdvertisementEnabled: undefined,
      systemRecordRequesterLaneEnabled: undefined,
      systemRecordLegacyCapablePeerSelectionEnabled: undefined,
    });
  });

  // This is the test that would have caught the failure the whole chokepoint
  // exists to prevent: a control declared and documented but dropped on the
  // hop typechecks, is operator-settable, and does nothing.
  it('forwards each control to the SAME-named slot (no copy-paste-cross)', () => {
    for (const enabled of CONTROLS) {
      const picked = pickSystemRecordConfigControlsV1({ [enabled.field]: true });
      for (const other of CONTROLS) {
        expect(
          picked[other.field],
          `${enabled.field} must not land in ${other.field}`,
        ).toBe(other.field === enabled.field ? true : undefined);
      }
    }
  });

  it('preserves an explicit false rather than dropping it to undefined', () => {
    // `false` and `undefined` resolve the same today, but they are different
    // operator intents; dropping one would silently rewrite the config.
    for (const control of CONTROLS) {
      expect(pickSystemRecordConfigControlsV1({ [control.field]: false })[control.field])
        .toBe(false);
    }
  });
});
