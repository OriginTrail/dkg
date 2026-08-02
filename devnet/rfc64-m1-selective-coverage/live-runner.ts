/**
 * Publish only after both collection and controller shutdown succeed. This
 * keeps a fresh PASS artifact from surviving a failed process cleanup.
 */
export async function runSelectiveCoverageLiveV1<T>(input: {
  readonly collect: () => Promise<T>;
  readonly close: () => Promise<void>;
  readonly publish: (value: T) => Promise<void> | void;
}): Promise<void> {
  let value: T | undefined;
  let collectionFailure: unknown;
  try {
    value = await input.collect();
  } catch (error) {
    collectionFailure = error;
  }

  let closeFailure: unknown;
  try {
    await input.close();
  } catch (error) {
    closeFailure = error;
  }

  if (collectionFailure !== undefined && closeFailure !== undefined) {
    throw new AggregateError(
      [collectionFailure, closeFailure],
      'M1 collection and runtime shutdown both failed',
    );
  }
  if (collectionFailure !== undefined) throw collectionFailure;
  if (closeFailure !== undefined) throw closeFailure;
  if (value === undefined) throw new Error('M1 collection returned no evidence');
  await input.publish(value);
}
