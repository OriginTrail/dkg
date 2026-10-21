// SPDX-License-Identifier: Apache-2.0

/** A proof can fail before its reads finish. Completion never rejects and owns
 * all work started by the operation, including siblings of a failed read. */
export interface ProofOperation<T> {
  readonly result: Promise<T>;
  readonly completion: Promise<void>;
}

export type AwaitProofOperation = <T>(operation: ProofOperation<T>) => Promise<T>;

/** Compose child operations without exposing their internal reads to the caller. */
export function proofOperation<T>(run: (own: AwaitProofOperation) => Promise<T>): ProofOperation<T> {
  const children: Promise<void>[] = [];
  const result = Promise.resolve().then(() => run(operation => {
    children.push(operation.completion);
    return operation.result;
  }));
  // The result has settled, so run cannot start any more child operations.
  const drain = () => Promise.allSettled(children).then(() => undefined);
  return { result, completion: result.then(drain, drain) };
}

/** Factories keep a synchronous read failure from stranding an earlier sibling. */
export function parallelProof<const T extends readonly (() => unknown)[]>(
  readers: T,
): ProofOperation<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const reads = readers.map(read => Promise.resolve().then(read));
  return {
    result: Promise.all(reads) as Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }>,
    completion: Promise.allSettled(reads).then(() => undefined),
  };
}
