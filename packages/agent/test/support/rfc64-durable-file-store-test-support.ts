import {
  Rfc64DurableFileErrorV1,
  createRfc64DurableFileStoreWithInstrumentationV1,
  type Rfc64DirectoryPreparationObservationV1,
  type Rfc64DurableFileBoundaryV1,
  type Rfc64DurableFileStoreV1,
} from '../../src/rfc64/durable-file-store-v1.js';

export interface Rfc64DurableFileTestLifecycleV1<TKind extends string = string> {
  readonly boundary: (
    boundary: Rfc64DurableFileBoundaryV1<TKind>,
  ) => void | Promise<void>;
  readonly directoryPreparation?: (
    observation: Rfc64DirectoryPreparationObservationV1,
  ) => void | Promise<void>;
}

export function createRfc64DurableFileStoreForTestV1<TKind extends string>(
  containmentRoot: string,
  lifecycle: Rfc64DurableFileTestLifecycleV1<TKind>,
): Rfc64DurableFileStoreV1<TKind> {
  assertRfc64DurableFileTestEnvironmentV1();
  const observeDirectoryPreparation = lifecycle.directoryPreparation;
  const instrumentation = Object.freeze({
    boundary: async (boundary: Rfc64DurableFileBoundaryV1<TKind>): Promise<void> => {
      assertRfc64DurableFileTestEnvironmentV1();
      await lifecycle.boundary(boundary);
    },
    directoryPreparation: async (
      observation: Rfc64DirectoryPreparationObservationV1,
    ): Promise<void> => {
      assertRfc64DurableFileTestEnvironmentV1();
      await observeDirectoryPreparation?.(observation);
    },
  });
  return createRfc64DurableFileStoreWithInstrumentationV1(
    containmentRoot,
    instrumentation,
  );
}

function assertRfc64DurableFileTestEnvironmentV1(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Rfc64DurableFileErrorV1(
      'input',
      'RFC-64 durable-file fault injection is unavailable outside NODE_ENV=test',
    );
  }
}
