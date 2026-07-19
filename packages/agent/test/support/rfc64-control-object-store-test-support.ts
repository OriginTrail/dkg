import {
  Rfc64ControlObjectStoreErrorV1,
  openRfc64ControlObjectStoreWithInstrumentationV1,
  type Rfc64ControlObjectStoreDurabilityBoundaryV1,
  type Rfc64ControlObjectStoreV1,
} from '../../src/rfc64/control-object-store-v1-internal.js';

export interface Rfc64ControlObjectStoreTestLifecycleV1 {
  readonly boundary?: (
    boundary: Rfc64ControlObjectStoreDurabilityBoundaryV1,
  ) => void | Promise<void>;
}

export type Rfc64ControlObjectStoreTestOpenerV1 = (
  dataDir: string,
) => Promise<Rfc64ControlObjectStoreV1>;

export function createRfc64ControlObjectStoreTestOpenerV1(
  testLifecycle: Rfc64ControlObjectStoreTestLifecycleV1 = {},
): Rfc64ControlObjectStoreTestOpenerV1 {
  assertRfc64ControlObjectStoreTestEnvironmentV1();
  const boundary = testLifecycle.boundary;
  const instrumentation = Object.freeze({
    boundary: (
      value: Rfc64ControlObjectStoreDurabilityBoundaryV1,
    ): void | Promise<void> => {
      assertRfc64ControlObjectStoreTestEnvironmentV1();
      return boundary?.(value);
    },
  });
  return async (dataDir: string): Promise<Rfc64ControlObjectStoreV1> => {
    assertRfc64ControlObjectStoreTestEnvironmentV1();
    return openRfc64ControlObjectStoreWithInstrumentationV1(
      dataDir,
      instrumentation,
    );
  };
}

export type { Rfc64ControlObjectStoreDurabilityBoundaryV1 };

function assertRfc64ControlObjectStoreTestEnvironmentV1(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Rfc64ControlObjectStoreErrorV1(
      'control-store-input',
      'control store test opener is available only under NODE_ENV=test',
    );
  }
}
